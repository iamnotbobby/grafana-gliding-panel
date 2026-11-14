import { AxisModel } from '../data/model';
import { Palette, Renderer, Viewport } from './draw';
import { RangeConfig, YScale } from './scale';
import { rangeEnd, rangeStart } from './search';
import { EngineSeries } from './series';
import { chooseTimeStep, LabelCache, timeFormatFor, timeTicks } from './ticks';

/** Per-frame input, reused by the engine to avoid allocating per frame. */
export interface FrameInput {
  cssW: number;
  cssH: number;
  dpr: number;
  /** Time window to draw, ms. */
  from: number;
  to: number;
  /** Data after this time is not drawn yet (reveal of late data); Infinity for none. */
  visibleEnd: number;
  /** Frame time on the monotonic clock, ms. */
  now: number;
  gliding: boolean;
  /** Time since the previous frame for scale easing; negative snaps. */
  dtMs: number;
  timeZone: string;
}

const TOP_PAD = 8;
const X_AXIS_H = 22;
const RIGHT_PAD = 12;
const LEFT_PAD = 4;
const Y_LABEL_GAP = 8;
const Y_AXIS_MIN = 24;
const TIME_LABEL_TOP = 5;
/** While gliding, time labels fade over this distance (CSS px) before reaching a panel edge. */
const TIME_LABEL_FADE_PX = 24;

/**
 * Min and max of the plotted values of visible series in [from, to], including the points just
 * outside it. With positiveOnly (log scales) values <= 0 are ignored. Writes [min, max] to out,
 * NaN when there are none.
 */
function visibleExtent(
  series: readonly EngineSeries[],
  from: number,
  to: number,
  positiveOnly: boolean,
  out: Float64Array
): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < series.length; k++) {
    const s = series[k];
    if (!s.visible) {
      continue;
    }
    const ys = s.y;
    const i1 = rangeEnd(s.ts, to);
    for (let i = rangeStart(s.ts, from); i < i1; i++) {
      const v = ys[i];
      if (v !== v || (positiveOnly && v <= 0)) {
        continue;
      }
      if (v < lo) {
        lo = v;
      }
      if (v > hi) {
        hi = v;
      }
    }
  }
  out[0] = lo <= hi ? lo : NaN;
  out[1] = lo <= hi ? hi : NaN;
}

/** Lays out and draws the base picture: grid, thresholds, series and axis labels. */
export class Layout {
  private yAxisW = 0;
  private shrink = true;
  private readonly yTicks = new Float64Array(64);
  private readonly tTicks = new Float64Array(256);
  private readonly ext = new Float64Array(2);

  private timeStep = 0;
  private timeStepPx = NaN;
  private timeRangeMs = NaN;
  private timeFormat = '';
  private timeLabelW = 0;

  /** Lets the y axis get narrower on the next frame (otherwise it only grows, to avoid jitter). */
  allowShrink(): void {
    this.shrink = true;
  }

  drawBase(
    ctx: CanvasRenderingContext2D,
    r: Renderer,
    inp: FrameInput,
    vp: Viewport,
    scale: YScale,
    labels: LabelCache,
    series: readonly EngineSeries[],
    axis: AxisModel,
    range: RangeConfig,
    pal: Palette
  ): void {
    const plotH = Math.max(1, inp.cssH - TOP_PAD - X_AXIS_H);
    visibleExtent(series, inp.from, inp.to, range.logBase > 0, this.ext);
    scale.update(this.ext[0], this.ext[1], range, plotH, inp.dtMs, inp.dtMs < 0);
    scale.setPlot(TOP_PAD, plotH);

    // Y labels decide the axis width.
    ctx.font = pal.font;
    const yTicks = this.yTicks;
    const yn = scale.ticks(yTicks);
    const log = scale.logBase > 0;
    let maxW = 0;
    for (let i = 0; i < yn; i++) {
      const w = labels.width(ctx, labels.valueLabel(yTicks[i], axis.field, log ? yTicks[i] : scale.step, log));
      if (w > maxW) {
        maxW = w;
      }
    }
    const needed = Math.max(Y_AXIS_MIN, Math.ceil((maxW + Y_LABEL_GAP + LEFT_PAD) / 4) * 4);
    if (needed > this.yAxisW || this.shrink) {
      this.yAxisW = needed;
      this.shrink = false;
    }

    vp.left = this.yAxisW;
    vp.top = TOP_PAD;
    vp.width = Math.max(1, inp.cssW - this.yAxisW - RIGHT_PAD);
    vp.height = plotH;
    vp.from = inp.from;
    vp.to = inp.to;
    vp.pxPerMs = inp.to > inp.from ? vp.width / (inp.to - inp.from) : 0;
    vp.dpr = inp.dpr;

    // The time step only changes with the scale of the time axis.
    const rangeMs = inp.to - inp.from;
    if (vp.pxPerMs !== this.timeStepPx || rangeMs !== this.timeRangeMs) {
      this.timeStepPx = vp.pxPerMs;
      this.timeRangeMs = rangeMs;
      this.timeStep = chooseTimeStep(vp.pxPerMs, rangeMs, ctx, labels);
      this.timeFormat = timeFormatFor(this.timeStep, rangeMs);
      this.timeLabelW = labels.formatWidth(ctx, this.timeFormat);
    }
    const halfMs = vp.pxPerMs > 0 ? (this.timeLabelW / 2 + 2) / vp.pxPerMs : 0;
    const tz = labels.offset(inp.timeZone, inp.from);
    const tn = timeTicks(inp.from - halfMs, inp.to + halfMs, this.timeStep, tz, this.tTicks);

    r.clear(inp.cssW, inp.cssH, inp.dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    r.drawGridY(vp, scale, yTicks, yn, pal);
    r.drawGridX(vp, this.tTicks, tn, pal, !inp.gliding);

    // Thresholds and series, clipped to the plot; series also to the revealed part.
    ctx.save();
    ctx.beginPath();
    ctx.rect(vp.left, vp.top, vp.width, vp.height);
    ctx.clip();
    r.drawThresholds(vp, scale, axis);
    if (inp.visibleEnd < inp.to) {
      const w = Math.max(0, (inp.visibleEnd - inp.from) * vp.pxPerMs);
      ctx.beginPath();
      ctx.rect(vp.left, vp.top, w, vp.height);
      ctx.clip();
    }
    for (let k = 0; k < series.length; k++) {
      const s = series[k];
      if (s.visible) {
        r.drawSeries(s, vp, scale, inp.visibleEnd, inp.now);
      }
    }
    ctx.restore();

    ctx.fillStyle = pal.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const bottom = vp.top + vp.height;
    for (let i = 0; i < yn; i++) {
      const p = scale.px(yTicks[i]);
      if (p < vp.top - 1 || p > bottom + 1) {
        continue;
      }
      ctx.fillText(
        labels.valueLabel(yTicks[i], axis.field, log ? yTicks[i] : scale.step, log),
        vp.left - Y_LABEL_GAP,
        p
      );
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const ty = bottom + TIME_LABEL_TOP;
    if (inp.gliding) {
      // Labels slide in from the right and out under the y axis.
      ctx.save();
      ctx.beginPath();
      ctx.rect(vp.left, bottom, inp.cssW - vp.left, inp.cssH - bottom);
      ctx.clip();
    }
    for (let i = 0; i < tn; i++) {
      const t = this.tTicks[i];
      const x = vp.left + (t - inp.from) * vp.pxPerMs;
      const text = labels.timeLabel(t, this.timeFormat, inp.timeZone);
      const half = labels.width(ctx, text) / 2;
      if (!inp.gliding) {
        if (x - half < 0 || x + half > inp.cssW || t < inp.from || t > inp.to) {
          continue;
        }
        ctx.fillText(text, x, ty);
        continue;
      }
      // Fade out before the label would be cut by an edge, so it never shows clipped or pops.
      const room = Math.min(x - half - vp.left, inp.cssW - (x + half));
      if (room <= 0) {
        continue;
      }
      ctx.globalAlpha = room >= TIME_LABEL_FADE_PX ? 1 : room / TIME_LABEL_FADE_PX;
      ctx.fillText(text, x, ty);
    }
    if (inp.gliding) {
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }
}
