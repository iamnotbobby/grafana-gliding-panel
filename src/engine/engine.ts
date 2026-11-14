import { CreateEngine, EngineData, EngineStyle, GlideEngine, HoverInfo, PlotRect } from './api';
import { paletteFor, Palette, Renderer, Viewport } from './draw';
import { HoverBuilder } from './hover';
import { defaultEnv, EngineEnv, FrameLoop } from './loop';
import { FrameInput, Layout } from './layout';
import { IEC_UNITS, RangeConfig, YScale } from './scale';
import { exactIndex } from './search';
import { BLEND_MS, blendedValue, blendFactor, EngineSeries, prepareSeries } from './series';
import { LabelCache } from './ticks';
import { GlideView } from './view';

/** An idle gliding frame is skipped when the window moved less than this many device pixels. */
const MIN_MOVE_DEVICE_PX = 0.2;
/** Wall-clock and monotonic clocks may drift; re-anchor only on a real jump of the system clock. */
const CLOCK_JUMP_MS = 1000;

const EMPTY_HIDDEN: ReadonlySet<string> = new Set<string>();

/** Bounds for the measured interval between shared cursor updates, ms. */
const EXTERNAL_MIN_INTERVAL_MS = 16;
const EXTERNAL_MAX_INTERVAL_MS = 150;
/** Longest time step of one easing frame, ms. */
const MAX_EASE_FRAME_MS = 20;
/** The shared crosshair is placed exactly once it is this close (CSS px). */
const EXTERNAL_SNAP_PX = 0.25;

/** Equality that treats NaN as equal to NaN. */
function sameNumber(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) {
    return true;
  }
  if (a.size !== b.size) {
    return false;
  }
  for (const k of a) {
    if (!b.has(k)) {
      return false;
    }
  }
  return true;
}

class Engine implements GlideEngine {
  onHover: ((info: HoverInfo | null) => void) | null = null;
  onCursorMove: ((timeMs: number | null, relY: number) => void) | null = null;

  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly renderer: Renderer | null;
  private readonly loop: FrameLoop;
  private readonly scale = new YScale();
  private readonly view = new GlideView();
  private readonly labels = new LabelCache();
  private readonly hover = new HoverBuilder();
  private readonly layout = new Layout();

  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private style: EngineStyle | null = null;
  private pal: Palette | null = null;
  private data: EngineData | null = null;
  private series: EngineSeries[] = [];
  private hidden: ReadonlySet<string> = EMPTY_HIDDEN;
  private readonly range: RangeConfig = {
    hardMin: null,
    hardMax: null,
    softMin: null,
    softMax: null,
    includeZero: false,
    logBase: 0,
    binary: false,
    percent: false,
  };

  private gliding = false;
  private lastRawKey = '';
  private epochOffset = NaN;
  private pointerX = NaN;
  private pointerY = NaN;
  /** Time published by another panel (target) and the time the shared crosshair is drawn at. */
  private external = NaN;
  private externalShown = NaN;
  private externalRelY = 0.5;
  private lastOverlayAt = NaN;
  /** Speed (time per ms) at which the shared crosshair catches up with the published time. */
  private externalSpeed = 0;
  private lastExternalAt = NaN;
  private lastCursorTime = NaN;

  private baseDirty = true;
  private overlayDirty = true;
  private snapScale = true;
  private blendUntil = -Infinity;
  private lastFrameAt = NaN;
  private lastTo = NaN;
  private destroyed = false;

  /** Static mode keeps the drawn base image so pointer moves only redraw the overlay. */
  private cache: HTMLCanvasElement | null = null;
  private cacheValid = false;

  private readonly input: FrameInput = {
    cssW: 0,
    cssH: 0,
    dpr: 1,
    from: 0,
    to: 1,
    visibleEnd: Infinity,
    now: 0,
    gliding: false,
    dtMs: -1,
    timeZone: '',
  };
  private readonly vp: Viewport = { left: 0, top: 0, width: 0, height: 0, from: 0, to: 1, pxPerMs: 0, dpr: 1 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly env: EngineEnv
  ) {
    this.ctx = canvas.getContext('2d');
    this.renderer = this.ctx !== null ? new Renderer(this.ctx) : null;
    this.loop = new FrameLoop(env, canvas, this.frame);
  }

  get animating(): boolean {
    return this.loop.animating;
  }

  resize(cssWidth: number, cssHeight: number): void {
    const dpr = this.env.devicePixelRatio();
    const w = Math.max(0, cssWidth);
    const h = Math.max(0, cssHeight);
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) {
      return;
    }
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    // Assigning width or height clears the canvas, even to the same value: only do it when the
    // backing store really changes size.
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    const cleared = bw !== this.canvas.width || bh !== this.canvas.height;
    if (cleared) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.layout.allowShrink();
    this.syncMode(false);
    if (cleared) {
      // Redraw before the browser paints: the next animation frame may be late or skipped by
      // the fps cap, which would show the cleared canvas.
      this.frame(this.env.now());
    }
  }

  setStyle(style: EngineStyle): void {
    const prev = this.style;
    this.style = style;
    if (prev === null || prev.theme !== style.theme) {
      this.pal = paletteFor(style.theme);
      this.labels.reset();
      this.renderer?.setTheme(style.theme);
      this.layout.allowShrink();
    }
    this.loop.setFps(style.glide.fps);
    this.syncMode(false);
  }

  setData(data: EngineData): void {
    const prev = this.data;
    const sameArrival = prev !== null && prev.receivedAt === data.receivedAt && prev.window === data.window;
    const rangeChanged =
      prev === null ||
      prev.window.rawKey !== data.window.rawKey ||
      prev.window.to - prev.window.from !== data.window.to - data.window.from;

    // Epoch time = monotonic time + offset.
    const nowPerf = this.env.now();
    const offset = this.env.dateNow() - nowPerf;
    if (this.epochOffset !== this.epochOffset || Math.abs(offset - this.epochOffset) > CLOCK_JUMP_MS) {
      this.epochOffset = offset;
    }
    const nowEpoch = nowPerf + this.epochOffset;
    const keepContinuity = this.gliding && !rangeChanged && this.wantsGlide(data);
    // Left edge of the window right now, before the view is updated.
    const currentFrom = keepContinuity ? this.view.rightEdge(nowEpoch) - this.view.rangeMs : NaN;

    this.data = data;
    if (!sameArrival || !keepContinuity) {
      this.layout.allowShrink();
    }
    this.series = prepareSeries(data.model, this.hidden, {
      prev: keepContinuity ? this.series : null,
      retainFrom: keepContinuity ? currentFrom - 2 * data.model.stepMs : NaN,
      retainStacked: true,
      blendFrom: keepContinuity && !sameArrival ? currentFrom : NaN,
      now: nowPerf,
    });
    this.afterSeriesChange();
    if (rangeChanged || !keepContinuity) {
      this.snapScale = true;
    }
    this.syncMode(!sameArrival || rangeChanged);
  }

  setHidden(keys: ReadonlySet<string>): void {
    if (sameSet(keys, this.hidden)) {
      return;
    }
    this.hidden = keys;
    if (this.data === null) {
      return;
    }
    const now = this.env.now();
    const smooth = this.gliding;
    this.series = prepareSeries(this.data.model, keys, {
      prev: this.series,
      retainFrom: smooth ? this.vp.from - 2 * this.data.model.stepMs : NaN,
      retainStacked: false,
      blendFrom: smooth ? -Infinity : NaN,
      now,
    });
    this.afterSeriesChange();
    this.layout.allowShrink();
  }

  setPointer(x: number | null, y: number | null): void {
    const px = x === null || y === null ? NaN : x;
    const py = x === null || y === null ? NaN : y;
    if (px === this.pointerX && py === this.pointerY) {
      return;
    }
    this.pointerX = px;
    this.pointerY = py;
    this.invalidate(false);
  }

  setExternalCursor(timeMs: number | null, relY?: number): void {
    const t = timeMs === null ? NaN : timeMs;
    // Like the built-in panels: without a publisher height the horizontal line sits halfway down.
    const ry = typeof relY === 'number' && relY >= 0 && relY <= 1 ? relY : 0.5;
    if (sameNumber(t, this.external) && ry === this.externalRelY) {
      return;
    }
    const now = this.env.now();
    if (t !== t || this.external !== this.external) {
      // A shared cursor that appears or disappears is placed directly; moves are eased.
      this.externalShown = t;
      this.externalSpeed = 0;
    } else if (t !== this.external) {
      // Cover the distance by the time the next update is due.
      const since = now - this.lastExternalAt;
      const interval = Math.min(
        EXTERNAL_MAX_INTERVAL_MS,
        Math.max(EXTERNAL_MIN_INTERVAL_MS, since === since ? since : EXTERNAL_MAX_INTERVAL_MS)
      );
      this.externalSpeed = Math.abs(t - this.externalShown) / interval;
    }
    this.lastExternalAt = now;
    this.external = t;
    this.externalRelY = ry;
    this.invalidate(false);
  }

  timeAtX(x: number): number {
    const vp = this.vp;
    if (!(vp.pxPerMs > 0)) {
      return this.data !== null ? this.data.window.from : NaN;
    }
    return vp.from + (x - vp.left) / vp.pxPerMs;
  }

  plotRect(): PlotRect {
    const vp = this.vp;
    return { left: vp.left, top: vp.top, width: vp.width, height: vp.height };
  }

  destroy(): void {
    this.destroyed = true;
    this.onHover = null;
    this.onCursorMove = null;
    this.loop.destroy();
    this.cache = null;
  }

  /** True while the shared crosshair is still moving toward the last published time. */
  private externalEasing(): boolean {
    const t = this.external;
    const s = this.externalShown;
    return t === t && s === s && Math.abs(t - s) * this.vp.pxPerMs > EXTERNAL_SNAP_PX;
  }

  /** Moves the shared crosshair toward the published time at the speed set when it was published. */
  private easeExternal(now: number): void {
    // At most one frame: a chart that sat still would otherwise cover the whole distance at once.
    const dt = Math.min(now - this.lastOverlayAt, MAX_EASE_FRAME_MS);
    this.lastOverlayAt = now;
    const t = this.external;
    if (t !== t) {
      this.externalShown = NaN;
      return;
    }
    const s = this.externalShown;
    if (s !== s || !(dt > 0)) {
      this.externalShown = t;
      return;
    }
    const step = this.externalSpeed * dt;
    const rest = t - s;
    const next = Math.abs(rest) <= step ? t : s + (rest > 0 ? step : -step);
    this.externalShown = Math.abs(t - next) * this.vp.pxPerMs <= EXTERNAL_SNAP_PX ? t : next;
    if (this.externalShown !== t) {
      // Static charts have no running loop: ask for the next frame while the line moves.
      this.loop.request();
    }
  }

  private wantsGlide(data: EngineData | null): boolean {
    const style = this.style;
    if (data === null || style === null || !style.glide.enabled || !data.window.relative) {
      return false;
    }
    const len = data.window.to - data.window.from;
    return len > 0 && len <= style.glide.maxRangeSec * 1000;
  }

  /** Switches between gliding and static mode; feeds the view on new data. */
  private syncMode(newArrival: boolean): void {
    const data = this.data;
    const glide = this.wantsGlide(data) && this.cssW > 0 && this.cssH > 0;
    if (glide && data !== null && (newArrival || !this.gliding)) {
      const w = data.window;
      const rangeChanged = !this.gliding || !this.view.ready || this.view.rangeMs !== w.to - w.from;
      this.view.update({
        now: this.env.now() + this.epochOffset,
        arrival: data.receivedAt + this.epochOffset,
        lenMs: w.to - w.from,
        marginMs: w.evaluatedAt - w.to,
        headT: data.model.lastT,
        refreshMs: data.refreshMs,
        stepMs: data.model.stepMs,
        jump: rangeChanged || (newArrival && this.lastRawKey !== w.rawKey),
      });
      this.lastRawKey = w.rawKey;
    }
    if (glide !== this.gliding) {
      this.gliding = glide;
      this.snapScale = true;
    }
    this.loop.setWanted(glide);
    this.invalidate(true);
  }

  private afterSeriesChange(): void {
    let maxLen = 0;
    let includeZero = false;
    let blendUntil = -Infinity;
    for (const s of this.series) {
      maxLen = Math.max(maxLen, s.ts.length);
      // Like the built-in panel: only stacking pulls zero into the range (a fill alone does
      // not; it then reaches the bottom edge of the plot).
      if (s.visible && s.stacked) {
        includeZero = true;
      }
      if (s.blendY !== null) {
        blendUntil = Math.max(blendUntil, s.blendStart + BLEND_MS);
      }
    }
    this.renderer?.ensureCapacity(maxLen);
    this.blendUntil = blendUntil;
    const axis = this.data?.model.axis;
    const r = this.range;
    r.hardMin = axis?.hardMin ?? null;
    r.hardMax = axis?.hardMax ?? null;
    r.softMin = axis?.softMin ?? null;
    r.softMax = axis?.softMax ?? null;
    r.logBase = axis?.logBase ?? 0;
    const unit = axis?.field?.config.unit;
    r.binary = unit !== undefined && IEC_UNITS.has(unit);
    r.includeZero = includeZero;
    r.percent = axis?.percent ?? false;
    this.invalidate(true);
  }

  private invalidate(base: boolean): void {
    if (this.destroyed) {
      return;
    }
    if (base) {
      this.baseDirty = true;
      this.cacheValid = false;
    }
    this.overlayDirty = true;
    this.loop.request();
  }

  private frame = (time: number): void => {
    const ctx = this.ctx;
    const renderer = this.renderer;
    const style = this.style;
    const pal = this.pal;
    const data = this.data;
    if (this.destroyed || ctx === null || renderer === null || style === null || pal === null) {
      return;
    }
    if (this.cssW <= 0 || this.cssH <= 0) {
      return;
    }
    if (data === null) {
      renderer.clear(this.cssW, this.cssH, this.dpr);
      return;
    }

    let from: number;
    let to: number;
    let visibleEnd = Infinity;
    if (this.gliding) {
      const w = time + this.epochOffset;
      to = this.view.rightEdge(w);
      from = to - this.view.rangeMs;
      visibleEnd = this.view.revealAt(w);
      const moved = Math.abs(to - this.lastTo) * this.vp.pxPerMs * this.dpr;
      const busy =
        this.baseDirty ||
        this.overlayDirty ||
        !this.scale.settled ||
        time < this.blendUntil ||
        this.view.revealActive(w) ||
        this.hover.active ||
        this.externalEasing();
      if (!busy && moved < MIN_MOVE_DEVICE_PX) {
        return;
      }
    } else {
      from = data.window.from;
      to = data.window.to;
    }

    const dt = time - this.lastFrameAt;
    this.lastFrameAt = time;

    if (!this.gliding && !this.baseDirty && this.cacheValid && this.cache !== null) {
      // Static picture unchanged: restore it and redraw the overlay only.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.cache, 0, 0);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    } else {
      const input = this.input;
      input.cssW = this.cssW;
      input.cssH = this.cssH;
      input.dpr = this.dpr;
      input.from = from;
      input.to = to;
      input.visibleEnd = visibleEnd;
      input.now = time;
      input.gliding = this.gliding;
      input.dtMs = this.snapScale || !this.gliding ? -1 : dt;
      input.timeZone = style.timeZone;
      this.layout.drawBase(
        ctx,
        renderer,
        input,
        this.vp,
        this.scale,
        this.labels,
        this.series,
        data.model.axis,
        this.range,
        pal
      );
      this.snapScale = false;
      if (!this.gliding) {
        this.storeCache();
      }
    }
    this.baseDirty = false;
    this.lastTo = to;
    this.overlayDirty = false;
    this.drawOverlay(renderer, visibleEnd, time);
  };

  private storeCache(): void {
    const doc = this.env.doc;
    if (doc === null) {
      return;
    }
    if (this.cache === null) {
      this.cache = doc.createElement('canvas');
    }
    const c = this.cache;
    if (c.width !== this.canvas.width || c.height !== this.canvas.height) {
      c.width = this.canvas.width;
      c.height = this.canvas.height;
    }
    const cctx = c.getContext('2d');
    if (cctx === null) {
      return;
    }
    cctx.clearRect(0, 0, c.width, c.height);
    cctx.drawImage(this.canvas, 0, 0);
    this.cacheValid = true;
  }

  private drawOverlay(renderer: Renderer, visibleEnd: number, now: number): void {
    const vp = this.vp;
    const px = this.pointerX;
    const local =
      px === px &&
      px >= vp.left &&
      px <= vp.left + vp.width &&
      this.pointerY >= vp.top &&
      this.pointerY <= vp.top + vp.height;
    const ext = this.external;
    this.easeExternal(now);
    const cursorTime = local ? this.timeAtX(px) : NaN;
    if (!sameNumber(cursorTime, this.lastCursorTime)) {
      this.lastCursorTime = cursorTime;
      if (this.onCursorMove !== null) {
        this.onCursorMove(
          cursorTime === cursorTime ? cursorTime : null,
          vp.height > 0 ? (this.pointerY - vp.top) / vp.height : 0.5
        );
      }
    }
    let changed: boolean;
    if (local) {
      changed = this.hover.build(this.series, cursorTime, this.pointerY, true, vp, this.scale, visibleEnd, now);
    } else if (ext === ext && ext >= vp.from && ext <= vp.to) {
      changed = this.hover.build(this.series, ext, NaN, false, vp, this.scale, visibleEnd, now);
    } else {
      changed = this.hover.active;
      this.hover.reset();
    }

    const shown = this.hover.active;
    if (shown) {
      // The line follows the pointer exactly; hover points and tooltip values snap to data.
      const lineY = local ? this.pointerY : vp.top + this.externalRelY * vp.height;
      const lineX = local ? px : vp.left + (this.externalShown - vp.from) * vp.pxPerMs;
      renderer.drawCrosshair(vp, lineX, lineY);
    }
    // Hover points only on the panel under the pointer, as the built-in panels do.
    if (shown && local) {
      const info = this.hover.info;
      for (const s of this.series) {
        if (!s.visible || s.hideFromTooltip) {
          continue;
        }
        const j = exactIndex(s.ts, info.time);
        if (j < 0 || s.raw[j] !== s.raw[j]) {
          continue;
        }
        const y = this.scale.px(blendedValue(s.y, s.blendY, s.blendFrom, blendFactor(s, now), j));
        if (y >= vp.top && y <= vp.top + vp.height) {
          renderer.drawDot(info.x, y, s.color);
        }
      }
    }
    if (changed && this.onHover !== null) {
      this.onHover(shown ? this.hover.info : null);
    }
  }
}

/** Creates an engine with an injectable environment (clocks, frames, document) for tests. */
export function createEngineWith(canvas: HTMLCanvasElement, env?: Partial<EngineEnv>): GlideEngine {
  return new Engine(canvas, { ...defaultEnv(), ...env });
}

export const createEngine: CreateEngine = (canvas) => createEngineWith(canvas);
