/**
 * Y scale: the auto range of Grafana's time series panel (hard and soft limits, optional log
 * distribution), tick step hysteresis and eased transitions between ranges.
 */

export interface RangeConfig {
  hardMin: number | null;
  hardMax: number | null;
  softMin: number | null;
  softMax: number | null;
  /** Include zero in the auto range (stacking). */
  includeZero: boolean;
  /** 0 for linear, else the log base. */
  logBase: number;
  /** Binary (IEC) unit such as bytes: ticks at powers of two, like the built-in panel. */
  binary: boolean;
  /** Percent stacking: 0..1, or -1..0 / -1..1 when values go below zero, ignoring the limits. */
  percent: boolean;
}

/** Units Grafana's time series panel ticks at powers of two (IEC_UNITS in @grafana/ui). */
export const IEC_UNITS: ReadonlySet<string> = new Set([
  'bytes',
  'bits',
  'kbytes',
  'mbytes',
  'gbytes',
  'tbytes',
  'pbytes',
  'binBps',
  'binbps',
  'KiBs',
  'Kibits',
  'MiBs',
  'Mibits',
  'GiBs',
  'Gibits',
  'TiBs',
  'Tibits',
  'PiBs',
  'Pibits',
]);

/** Minimum spacing between y ticks in CSS px. */
const Y_TICK_MIN_PX = 30;
const Y_TICK_MIN_PX_SMALL = 15;
const SMALL_PLOT_PX = 150;
/** Time constant of the eased transitions, ms (about 95% done after three of them). */
const EASE_TAU_MS = 90;
/** Frame gaps longer than this snap the scale (resume after a pause). */
const EASE_SNAP_MS = 500;

const MANTISSAS = [1, 2, 2.5, 5];

function isNum(v: number | null): v is number {
  return v !== null && v === v && isFinite(v);
}

/**
 * The smallest nice step that is >= x: 1, 2, 2.5 or 5 times a power of ten, or for binary units
 * a power of two (steps below 1 fall back to decimal ones, as there is no binary meaning there).
 */
export function niceStepAtLeast(x: number, binary = false): number {
  if (!(x > 0) || !isFinite(x)) {
    return 1;
  }
  if (binary && x > 1) {
    return Math.pow(2, Math.ceil(Math.log2(x) - 1e-9));
  }
  const exp = Math.floor(Math.log10(x));
  for (let e = exp - 1; e <= exp + 1; e++) {
    const p = Math.pow(10, e);
    for (let i = 0; i < MANTISSAS.length; i++) {
      const s = MANTISSAS[i] * p;
      if (s >= x * (1 - 1e-9)) {
        return s;
      }
    }
  }
  return Math.pow(10, exp + 1);
}

/** Decimals needed to print multiples of a nice step exactly. */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !isFinite(step)) {
    return 0;
  }
  let d = 0;
  let s = step;
  while (d < 15 && Math.abs(Math.round(s) - s) > 1e-9 * Math.max(1, s)) {
    s *= 10;
    d++;
  }
  return d;
}

/**
 * Tick step for a linear span shown over heightPx: the smallest nice step that leaves at least
 * 30 px between ticks, or 15 px on plots up to 150 px tall (Grafana's UPlotAxisBuilder).
 */
export function chooseStep(span: number, heightPx: number, binary = false): number {
  if (!(span > 0) || !(heightPx > 0)) {
    return 1;
  }
  const space = heightPx <= SMALL_PLOT_PX ? Y_TICK_MIN_PX_SMALL : Y_TICK_MIN_PX;
  return niceStepAtLeast((space * span) / heightPx, binary);
}

/** Removes float noise such as 17999.204999999998 (uPlot's fixFloat, without string work). */
function fixFloat(v: number): number {
  if (Number.isInteger(v) || v === 0 || !isFinite(v)) {
    return v;
  }
  const p = Math.pow(10, 12 - Math.ceil(Math.log10(Math.abs(v))));
  return Math.round(v * p) / p;
}

function incrRoundUp(num: number, incr: number): number {
  return fixFloat(Math.ceil(fixFloat(num / incr)) * incr);
}

function incrRoundDn(num: number, incr: number): number {
  return fixFloat(Math.floor(fixFloat(num / incr)) * incr);
}

/** Rounds half away from zero to dec decimals (uPlot's roundDec). */
function roundDec(val: number, dec: number): number {
  if (Number.isInteger(val)) {
    return val;
  }
  const p = Math.pow(10, dec);
  return Math.round(val * p * (1 + Number.EPSILON)) / p;
}

/**
 * The linear auto range of Grafana's time series panel: uPlot's rangeNum with the configuration
 * Grafana's UPlotScaleBuilder passes. Variable names follow uPlot's source.
 */
export function linearRange(dataMin: number, dataMax: number, cfg: RangeConfig, out: Float64Array): void {
  if (cfg.percent) {
    out[0] = dataMin < 0 ? -1 : 0;
    out[1] = dataMax > 0 || !(dataMin < 0) ? 1 : 0;
    return;
  }
  const hardMin = isNum(cfg.hardMin) ? cfg.hardMin : null;
  const hardMax = isNum(cfg.hardMax) ? cfg.hardMax : null;
  const softMin = isNum(cfg.softMin) ? cfg.softMin : null;
  const softMax = isNum(cfg.softMax) ? cfg.softMax : null;
  let lo = dataMin;
  let hi = dataMax;
  if (!(lo <= hi)) {
    // No data: the configured limits, else 0..1.
    lo = hardMin ?? softMin ?? 0;
    hi = hardMax ?? softMax ?? lo + 1;
    out[0] = lo;
    out[1] = hi > lo ? hi : lo + 1;
    return;
  }
  if (cfg.includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const hardMinOnly = softMin === null && hardMin !== null;
  const hardMaxOnly = softMax === null && hardMax !== null;
  const _min = hardMinOnly ? (hardMin as number) : lo;
  const _max = hardMaxOnly ? (hardMax as number) : hi;

  const padMin = 0.1;
  const padMax = 0.1;
  const hMin = hardMin ?? -Infinity;
  const hMax = hardMax ?? Infinity;
  const sMin = softMin || 0;
  const sMax = softMax || 0;
  const sMinMode = softMin === null ? 3 : 1;
  const sMaxMode = softMax === null ? 3 : 1;

  let delta = _max - _min;
  const scalarMax = Math.max(Math.abs(_min), Math.abs(_max));
  const scalarMagDelta = Math.abs(Math.log10(scalarMax) - Math.log10(delta));
  if (delta < 1e-24 || scalarMagDelta > 10) {
    delta = 0;
    if (_min === 0 || _max === 0) {
      delta = 1e-24;
    }
  }
  const nonZeroDelta = delta || scalarMax || 1e3;
  const base = Math.pow(10, Math.floor(Math.log10(nonZeroDelta)));

  const _padMin = nonZeroDelta * (delta === 0 ? (_min === 0 ? 0.1 : 1) : padMin);
  const _newMin = roundDec(incrRoundDn(_min - _padMin, base / 10), 24);
  const _softMin = _min >= sMin && (sMinMode === 1 || (sMinMode === 3 && _newMin <= sMin)) ? sMin : Infinity;
  const minLim = Math.max(hMin, _newMin < _softMin && _min >= _softMin ? _softMin : Math.min(_softMin, _newMin));

  const _padMax = nonZeroDelta * (delta === 0 ? (_max === 0 ? 0.1 : 1) : padMax);
  const _newMax = roundDec(incrRoundUp(_max + _padMax, base / 10), 24);
  const _softMax = _max <= sMax && (sMaxMode === 1 || (sMaxMode === 3 && _newMax >= sMax)) ? sMax : -Infinity;
  let maxLim = Math.min(hMax, _newMax > _softMax && _max <= _softMax ? _softMax : Math.max(_softMax, _newMax));

  if (minLim === maxLim && minLim === 0) {
    maxLim = 100;
  }
  out[0] = minLim;
  out[1] = maxLim > minLim ? maxLim : minLim + 1;
}

/** Log auto range in domain (exponent) units, rounded outward to powers of the base. */
function logRange(dataMin: number, dataMax: number, cfg: RangeConfig, out: Float64Array): void {
  const base = cfg.logBase;
  let lo = dataMin <= dataMax ? dataMin : NaN;
  let hi = dataMin <= dataMax ? dataMax : NaN;
  if (isNum(cfg.softMin)) {
    lo = lo === lo ? Math.min(lo, cfg.softMin) : cfg.softMin;
  }
  if (isNum(cfg.softMax)) {
    hi = hi === hi ? Math.max(hi, cfg.softMax) : cfg.softMax;
  }
  if (isNum(cfg.hardMin)) {
    lo = cfg.hardMin;
  }
  if (isNum(cfg.hardMax)) {
    hi = cfg.hardMax;
  }
  if (lo !== lo && hi !== hi) {
    lo = 1;
    hi = base;
  } else if (lo !== lo) {
    lo = hi / base;
  } else if (hi !== hi) {
    hi = lo * base;
  }
  const ln = Math.log(base);
  const l = lo > 0 ? lo : hi > 0 ? hi / base : 1;
  const h = hi > 0 ? hi : base;
  const a = isNum(cfg.hardMin) && cfg.hardMin > 0 ? Math.log(cfg.hardMin) / ln : Math.floor(Math.log(l) / ln + 1e-9);
  const b = isNum(cfg.hardMax) && cfg.hardMax > 0 ? Math.log(cfg.hardMax) / ln : Math.ceil(Math.log(h) / ln - 1e-9);
  out[0] = a;
  out[1] = b > a ? b : a + 1;
}

export class YScale {
  /** Displayed domain (eased). */
  min = 0;
  max = 1;
  /** Target domain. */
  targetMin = 0;
  targetMax = 1;
  /** Linear tick step in value units (linear scales only). */
  step = 0;
  logBase = 0;
  binary = false;
  /** Top and height of the plot in CSS px. */
  top = 0;
  height = 1;

  private initialized = false;
  private readonly tmp = new Float64Array(2);

  get settled(): boolean {
    return this.min === this.targetMin && this.max === this.targetMax;
  }

  /**
   * Sets a new target from the data extents (value units) and eases the displayed domain toward
   * it. dtMs is the time since the previous update; snap places it directly.
   */
  update(dataMin: number, dataMax: number, cfg: RangeConfig, heightPx: number, dtMs: number, snap: boolean): void {
    const tmp = this.tmp;
    if (cfg.logBase !== this.logBase || cfg.binary !== this.binary) {
      this.logBase = cfg.logBase;
      this.binary = cfg.binary;
      this.step = 0;
      snap = true;
    }
    if (cfg.logBase > 0) {
      logRange(dataMin, dataMax, cfg, tmp);
      this.step = 1;
    } else {
      linearRange(dataMin, dataMax, cfg, tmp);
      this.step = chooseStep(tmp[1] - tmp[0], heightPx, cfg.binary);
    }
    this.targetMin = tmp[0];
    this.targetMax = tmp[1];
    this.ease(dtMs, snap || !this.initialized);
    this.initialized = true;
  }

  private ease(dtMs: number, snap: boolean): void {
    if (snap || !(dtMs >= 0) || dtMs > EASE_SNAP_MS) {
      this.min = this.targetMin;
      this.max = this.targetMax;
      return;
    }
    const k = 1 - Math.exp(-dtMs / EASE_TAU_MS);
    const eps = (this.targetMax - this.targetMin) * 1e-4;
    this.min += (this.targetMin - this.min) * k;
    this.max += (this.targetMax - this.max) * k;
    if (Math.abs(this.min - this.targetMin) <= eps) {
      this.min = this.targetMin;
    }
    if (Math.abs(this.max - this.targetMax) <= eps) {
      this.max = this.targetMax;
    }
  }

  setPlot(top: number, height: number): void {
    this.top = top;
    this.height = height > 1 ? height : 1;
  }

  /** CSS px of a data value. Values outside the plot are clamped a little beyond it. */
  px(v: number): number {
    const d = this.logBase > 0 ? (v > 0 ? Math.log(v) / Math.log(this.logBase) : this.min - 1) : v;
    const p = this.top + ((this.max - d) / (this.max - this.min)) * this.height;
    const lim = this.height * 4;
    return p < this.top - lim ? this.top - lim : p > this.top + this.height + lim ? this.top + this.height + lim : p;
  }

  /** CSS px of the fill baseline (zero, or the bottom for log scales). */
  zeroPx(): number {
    if (this.logBase > 0) {
      return this.top + this.height;
    }
    return this.px(0);
  }

  /**
   * Writes tick values (data units) inside the displayed domain to out; returns the count.
   * Linear ticks are multiples of `step`; log ticks are powers of the base.
   */
  ticks(out: Float64Array): number {
    let n = 0;
    if (this.logBase > 0) {
      const a = Math.ceil(this.min - 1e-9);
      const b = Math.floor(this.max + 1e-9);
      const every = Math.max(1, Math.ceil((b - a + 1) / Math.max(1, Math.floor(this.height / Y_TICK_MIN_PX))));
      for (let e = a; e <= b && n < out.length; e += every) {
        out[n++] = Math.pow(this.logBase, e);
      }
      return n;
    }
    const step = this.step > 0 ? this.step : 1;
    const f = Math.pow(10, stepDecimals(step));
    const k0 = Math.ceil(this.min / step - 1e-9);
    const k1 = Math.floor(this.max / step + 1e-9);
    for (let k = k0; k <= k1 && n < out.length; k++) {
      // Rounded to the step's decimals so labels and cache keys are free of float noise.
      const v = Math.round(k * step * f) / f;
      out[n++] = v === 0 ? 0 : v;
    }
    return n;
  }
}
