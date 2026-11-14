/**
 * Glide timing: the right edge of the window at wall-clock time w is `w - offset(w)`, where the
 * offset (end margin plus display lag) slews linearly toward a target. Pure arithmetic, no clocks.
 */

/** Ring buffer of the most recent samples with a quantile query. No allocations after creation. */
export class SampleRing {
  private readonly buf: Float64Array;
  private readonly scratch: Float64Array;
  private n = 0;
  private head = 0;

  constructor(capacity: number) {
    this.buf = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  get size(): number {
    return this.n;
  }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.buf.length;
    if (this.n < this.buf.length) {
      this.n++;
    }
  }

  clear(): void {
    this.n = 0;
    this.head = 0;
  }

  /** Quantile q in [0, 1] (nearest rank), NaN when empty. */
  quantile(q: number): number {
    const n = this.n;
    if (n === 0) {
      return NaN;
    }
    const s = this.scratch.subarray(0, n);
    for (let i = 0; i < n; i++) {
      s[i] = this.buf[i];
    }
    s.sort();
    const rank = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
    return s[rank];
  }
}

export interface ViewUpdate {
  /** Wall-clock time now (epoch ms); anchors any change of the slew so the window stays continuous. */
  now: number;
  /** Wall-clock time the data arrived (epoch ms); used to measure how old the data head is. */
  arrival: number;
  /** Length of the dashboard range, ms. */
  lenMs: number;
  /** evaluatedAt minus to: how far the requested range ends before "now". */
  marginMs: number;
  /** Newest timestamp in the data, NaN when there is none. */
  headT: number;
  /** Known refresh interval, or null to infer it from arrival times. */
  refreshMs: number | null;
  /** Query step, the fallback refresh guess before two arrivals were seen. */
  stepMs: number;
  /** Place the window directly instead of slewing (first data, range change, mode change). */
  jump: boolean;
}

const VIEW_TUNING = {
  /** Head-age quantile used as "normal" delivery delay; isolated spikes do not move it. */
  ageQuantile: 0.75,
  /** Number of head-age samples remembered. */
  ageSamples: 12,
  /** Number of refresh intervals remembered for inference. */
  intervalSamples: 9,
  /** Arrivals closer together than this are duplicates and not an interval. */
  minIntervalMs: 150,
  /** Safety margin added to the lag: fixed part plus a fraction of the refresh interval. */
  safetyMs: 150,
  safetyFraction: 0.1,
  /** The lag never exceeds this fraction of the range. */
  maxLagFraction: 0.25,
  /** Maximum change of the view speed while adapting (fraction of real time). */
  maxRateUp: 0.05,
  maxRateDown: 0.02,
  minRate: 0.005,
  /** Error (ms) that produces the maximum rate; smaller errors adapt proportionally slower. */
  rateErrorScaleMs: 10000,
  /** Target changes smaller than this (ms, or fraction of refresh) are ignored: speed stays exactly 1. */
  deadbandMs: 100,
  deadbandFraction: 0.05,
  /** Reveal duration bounds, ms; nominally one refresh interval. */
  minRevealMs: 250,
  maxRevealMs: 4000,
  /** The reveal edge never advances slower than this times real time. */
  minRevealSpeed: 1.05,
};

/** A gap between the end of the data and the right edge smaller than this needs no reveal. */
const REVEAL_MIN_GAP_MS = 50;

export class GlideView {
  private lenMs = 0;
  private marginMs = 0;

  private anchorW = 0;
  private anchorOffset = 0;
  private targetOffset = 0;
  private rate = 0;

  private readonly ages = new SampleRing(VIEW_TUNING.ageSamples);
  private readonly intervals = new SampleRing(VIEW_TUNING.intervalSamples);
  private lastArrival = NaN;
  private refreshHint: number | null = null;
  private stepMs = 1000;
  private headT = NaN;

  private revealing = false;
  private revealStartW = 0;
  private revealStartT = 0;
  private revealTargetT = 0;
  private revealDur = 1;

  private initialized = false;

  get ready(): boolean {
    return this.initialized;
  }

  get rangeMs(): number {
    return this.lenMs;
  }

  /** Feeds a data arrival. */
  update(u: ViewUpdate): void {
    this.lenMs = u.lenMs;
    this.marginMs = u.marginMs;
    this.refreshHint = u.refreshMs !== null && u.refreshMs > 0 ? u.refreshMs : null;
    this.stepMs = u.stepMs > 0 ? u.stepMs : 1000;

    if (this.lastArrival === this.lastArrival) {
      const dt = u.arrival - this.lastArrival;
      if (dt >= VIEW_TUNING.minIntervalMs) {
        this.intervals.push(dt);
        this.lastArrival = u.arrival;
      } else if (dt < 0) {
        this.lastArrival = u.arrival;
      }
    } else {
      this.lastArrival = u.arrival;
    }

    const jump = u.jump || !this.initialized;
    if (jump) {
      this.ages.clear();
    }
    if (u.headT === u.headT) {
      this.ages.push(u.arrival - u.headT);
    }

    // Visible end of the old data, computed before the window changes.
    const prevVisibleEnd = this.initialized ? Math.min(this.rightEdge(u.now), this.revealAt(u.now), this.headT) : NaN;

    const target = this.computeTarget();
    if (jump) {
      this.anchorW = u.now;
      this.anchorOffset = target;
      this.targetOffset = target;
      this.rate = 0;
      this.revealing = false;
    } else {
      const current = this.offsetAt(u.now);
      const deadband = Math.max(VIEW_TUNING.deadbandMs, VIEW_TUNING.deadbandFraction * this.refreshMs());
      this.anchorW = u.now;
      this.anchorOffset = current;
      if (Math.abs(target - this.targetOffset) >= deadband) {
        this.targetOffset = target;
      }
      const err = this.targetOffset - current;
      const max = err > 0 ? VIEW_TUNING.maxRateUp : VIEW_TUNING.maxRateDown;
      this.rate = Math.min(max, Math.max(VIEW_TUNING.minRate, Math.abs(err) / VIEW_TUNING.rateErrorScaleMs));

      // Reveal late data progressively, but only when the old data ended visibly before the
      // right edge: beyond it the glide itself reveals new data.
      const edge = this.rightEdge(u.now);
      if (
        u.headT === u.headT &&
        prevVisibleEnd === prevVisibleEnd &&
        u.headT > prevVisibleEnd &&
        prevVisibleEnd < edge - REVEAL_MIN_GAP_MS
      ) {
        this.revealing = true;
        this.revealStartW = u.now;
        this.revealStartT = prevVisibleEnd;
        this.revealTargetT = u.headT;
        this.revealDur = Math.min(VIEW_TUNING.maxRevealMs, Math.max(VIEW_TUNING.minRevealMs, this.refreshMs()));
      } else {
        this.revealing = false;
      }
    }
    this.headT = u.headT;
    this.initialized = true;
  }

  /** Refresh interval in use: the known one, else the median of observed intervals, else the step. */
  refreshMs(): number {
    if (this.refreshHint !== null) {
      return this.refreshHint;
    }
    const median = this.intervals.quantile(0.5);
    const r = median === median ? median : this.stepMs;
    return Math.max(VIEW_TUNING.minIntervalMs, r);
  }

  /** Total offset of the right edge behind wall-clock time at w. */
  offsetAt(w: number): number {
    const d = this.targetOffset - this.anchorOffset;
    if (d === 0) {
      return this.anchorOffset;
    }
    const moved = this.rate * Math.max(0, w - this.anchorW);
    if (moved >= Math.abs(d)) {
      return this.targetOffset;
    }
    return d > 0 ? this.anchorOffset + moved : this.anchorOffset - moved;
  }

  /** Display lag at w: the offset beyond the dashboard's own end margin. */
  lagAt(w: number): number {
    return this.offsetAt(w) - this.marginMs;
  }

  rightEdge(w: number): number {
    return w - this.offsetAt(w);
  }

  /** True while the view speed differs from real time. */
  slewing(w: number): boolean {
    return this.offsetAt(w) !== this.targetOffset;
  }

  /**
   * Time up to which data is drawn while a late segment is being revealed; +Infinity when no
   * reveal is in progress. The reveal eases out toward the data head and never advances slower
   * than real time.
   */
  revealAt(w: number): number {
    if (!this.revealing) {
      return Infinity;
    }
    const el = w - this.revealStartW;
    if (el <= 0) {
      return this.revealStartT;
    }
    const u = el / this.revealDur;
    if (u >= 1) {
      return this.revealTargetT;
    }
    const span = this.revealTargetT - this.revealStartT;
    const eased = this.revealStartT + span * (1 - (1 - u) * (1 - u));
    const linear = this.revealStartT + el * VIEW_TUNING.minRevealSpeed;
    const t = eased > linear ? eased : linear;
    return t < this.revealTargetT ? t : this.revealTargetT;
  }

  /** True while the reveal edge still moves inside the visible window. */
  revealActive(w: number): boolean {
    return this.revealing && w - this.revealStartW < this.revealDur && this.revealAt(w) < this.rightEdge(w);
  }

  private computeTarget(): number {
    const refresh = this.refreshMs();
    const age = this.ages.quantile(VIEW_TUNING.ageQuantile);
    const margin = this.marginMs;
    const maxLag = VIEW_TUNING.maxLagFraction * this.lenMs;
    if (age !== age) {
      // No data yet: keep the requested end plus one refresh interval of lag.
      return margin + Math.min(maxLag, refresh);
    }
    const safety = VIEW_TUNING.safetyMs + VIEW_TUNING.safetyFraction * refresh;
    let lag = age - margin + refresh + safety;
    if (lag < 0) {
      lag = 0;
    } else if (lag > maxLag) {
      lag = maxLag;
    }
    return margin + lag;
  }
}
