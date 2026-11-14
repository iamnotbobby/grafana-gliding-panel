import { colorManipulator, GrafanaTheme2, ThresholdsMode } from '@grafana/data';
import { GraphThresholdsStyleMode } from '@grafana/schema';

import { AxisModel, Interp } from '../data/model';
import { selectIndices } from './decimate';
import { YScale } from './scale';
import { rangeEnd, rangeStart } from './search';
import { blendedValue, blendFactor, EngineSeries } from './series';

/** Plot area and time domain of the frame being drawn. */
export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
  from: number;
  to: number;
  pxPerMs: number;
  dpr: number;
}

export interface Palette {
  grid: string;
  text: string;
  font: string;
}

/** Axis label size, as in Grafana's own graph axes. */
const AXIS_FONT_PX = 12;

/** Grafana's uPlot crosshair style (`1px dashed rgba(120, 120, 130, 0.5)`), the same in both themes. */
const CROSSHAIR_COLOR = 'rgba(120, 120, 130, 0.5)';
const CROSSHAIR_DASH = [3, 3];
const THRESHOLD_DASH = [10, 10];
const SOLID: number[] = [];

export function paletteFor(theme: GrafanaTheme2): Palette {
  return {
    grid: theme.colors.border.weak,
    text: theme.colors.text.primary,
    font: `${AXIS_FONT_PX}px ${theme.typography.fontFamily}`,
  };
}

/** Decimate when a series has more visible points than this many per CSS px of plot width. */
const DECIMATE_FACTOR = 1.5;
const THRESHOLD_AREA_ALPHA = 0.15;

/** Snaps a horizontal line position to the device pixel grid for a 1 px crisp line. */
function crisp(p: number, dpr: number): number {
  const d = Math.round(p * dpr);
  return (Math.round(dpr) % 2 === 1 ? d + 0.5 : d) / dpr;
}

/** Index stored in a selectIndices result (run starts are stored as ~i). */
function pointIndex(i: number): number {
  return i < 0 ? ~i : i;
}

/** Path segment from (px, py) to (x, y) for the given interpolation. */
function segmentTo(ctx: CanvasRenderingContext2D, interp: Interp, px: number, py: number, x: number, y: number): void {
  if (interp === Interp.StepAfter) {
    ctx.lineTo(x, py);
  } else if (interp === Interp.StepBefore) {
    ctx.lineTo(px, y);
  }
  ctx.lineTo(x, y);
}

/** The same steps walked backwards: a step after the point becomes a step before it. */
function reversed(interp: Interp): Interp {
  return interp === Interp.StepAfter ? Interp.StepBefore : interp === Interp.StepBefore ? Interp.StepAfter : interp;
}

function thresholdValue(v: number, percent: boolean, lo: number, hi: number): number {
  return percent ? lo + ((hi - lo) * v) / 100 : v;
}

export class Renderer {
  private idx = new Int32Array(1024);
  private gradients = new Map<string, CanvasGradient>();
  private theme: GrafanaTheme2 | null = null;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  /** Makes sure the index scratch buffer holds n entries. Call on data changes, not per frame. */
  ensureCapacity(n: number): void {
    if (this.idx.length < n) {
      let len = this.idx.length;
      while (len < n) {
        len *= 2;
      }
      this.idx = new Int32Array(len);
    }
  }

  clear(cssW: number, cssH: number, dpr: number): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, Math.ceil(cssW * dpr), Math.ceil(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  drawGridY(vp: Viewport, scale: YScale, ticks: Float64Array, n: number, pal: Palette): void {
    const ctx = this.ctx;
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1 / vp.dpr;
    ctx.beginPath();
    const right = vp.left + vp.width;
    for (let i = 0; i < n; i++) {
      const p = scale.px(ticks[i]);
      if (p < vp.top - 0.5 || p > vp.top + vp.height + 0.5) {
        continue;
      }
      const y = crisp(p, vp.dpr);
      ctx.moveTo(vp.left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
  }

  drawGridX(vp: Viewport, ticks: Float64Array, n: number, pal: Palette, snap: boolean): void {
    const ctx = this.ctx;
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1 / vp.dpr;
    ctx.beginPath();
    const bottom = vp.top + vp.height;
    for (let i = 0; i < n; i++) {
      const p = vp.left + (ticks[i] - vp.from) * vp.pxPerMs;
      if (p < vp.left - 0.5 || p > vp.left + vp.width + 0.5) {
        continue;
      }
      // Gliding grid lines are not snapped: snapping would make them jitter against the data.
      const x = snap ? crisp(p, vp.dpr) : p;
      ctx.moveTo(x, vp.top);
      ctx.lineTo(x, bottom);
    }
    ctx.stroke();
  }

  /** Draws threshold lines and areas behind the series. */
  drawThresholds(vp: Viewport, scale: YScale, axis: AxisModel): void {
    const mode = axis.thresholdsMode;
    const field = axis.field;
    const th = field?.config.thresholds;
    if (
      !th ||
      !th.steps ||
      th.steps.length === 0 ||
      mode === GraphThresholdsStyleMode.Off ||
      mode === GraphThresholdsStyleMode.Series
    ) {
      return;
    }
    const theme = this.theme;
    if (theme === null) {
      return;
    }
    const ctx = this.ctx;
    const pct = th.mode === ThresholdsMode.Percentage;
    const lo = scale.logBase > 0 ? Math.pow(scale.logBase, scale.min) : scale.min;
    const hi = scale.logBase > 0 ? Math.pow(scale.logBase, scale.max) : scale.max;
    const top = vp.top;
    const bottom = vp.top + vp.height;
    const right = vp.left + vp.width;
    const area =
      mode === GraphThresholdsStyleMode.Area ||
      mode === GraphThresholdsStyleMode.LineAndArea ||
      mode === GraphThresholdsStyleMode.DashedAndArea;
    const line = mode !== GraphThresholdsStyleMode.Area;
    const dashed = mode === GraphThresholdsStyleMode.Dashed || mode === GraphThresholdsStyleMode.DashedAndArea;
    const steps = th.steps;

    if (area) {
      ctx.globalAlpha = THRESHOLD_AREA_ALPHA;
      for (let i = 0; i < steps.length; i++) {
        const v0 = i === 0 ? -Infinity : thresholdValue(steps[i].value, pct, lo, hi);
        const v1 = i + 1 < steps.length ? thresholdValue(steps[i + 1].value, pct, lo, hi) : Infinity;
        const y0 = v0 === -Infinity ? bottom : Math.min(bottom, Math.max(top, scale.px(v0)));
        const y1 = v1 === Infinity ? top : Math.min(bottom, Math.max(top, scale.px(v1)));
        if (y0 - y1 > 0) {
          ctx.fillStyle = theme.visualization.getColorByName(steps[i].color);
          ctx.fillRect(vp.left, y1, vp.width, y0 - y1);
        }
      }
      ctx.globalAlpha = 1;
    }
    if (line) {
      ctx.lineWidth = 1;
      ctx.setLineDash(dashed ? THRESHOLD_DASH : SOLID);
      for (let i = 1; i < steps.length; i++) {
        const p = scale.px(thresholdValue(steps[i].value, pct, lo, hi));
        if (!(p >= top - 0.5 && p <= bottom + 0.5)) {
          continue;
        }
        const y = crisp(p, vp.dpr);
        ctx.strokeStyle = theme.visualization.getColorByName(steps[i].color);
        ctx.beginPath();
        ctx.moveTo(vp.left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
      }
      ctx.setLineDash(SOLID);
    }
  }

  setTheme(theme: GrafanaTheme2): void {
    if (theme !== this.theme) {
      this.theme = theme;
      this.gradients.clear();
    }
  }

  /**
   * Draws one series (fill, then line) in [vp.from, min(vp.to, clipEnd)]. The caller has set
   * a clip rectangle; points just outside the window are included so edges are continuous.
   */
  drawSeries(s: EngineSeries, vp: Viewport, scale: YScale, clipEnd: number, now: number): void {
    const ts = s.ts;
    if (ts.length === 0) {
      return;
    }
    const end = clipEnd < vp.to ? clipEnd : vp.to;
    const i0 = rangeStart(ts, vp.from);
    const i1 = rangeEnd(ts, end);
    if (i1 <= i0) {
      return;
    }
    const colsPerMs = i1 - i0 > vp.width * DECIMATE_FACTOR ? vp.pxPerMs : 0;
    const idx = this.idx;
    const count = selectIndices(ts, s.y, i0, i1, s.gapMs, colsPerMs, idx);
    if (count === 0) {
      return;
    }
    const k = blendFactor(s, now);
    const ctx = this.ctx;
    const interp = s.interp;

    if (s.fillOpacity > 0) {
      const zero = scale.zeroPx();
      // The vertical extent decides which gradient passes are needed.
      let minPx = zero;
      let maxPx = zero;
      ctx.beginPath();
      let j = 0;
      while (j < count) {
        // One run: from a break marker up to the next one.
        let jb = j + 1;
        while (jb < count && idx[jb] >= 0) {
          jb++;
        }
        let px = 0;
        let py = 0;
        for (let q = j; q < jb; q++) {
          const i = pointIndex(idx[q]);
          const x = vp.left + (ts[i] - vp.from) * vp.pxPerMs;
          const y = scale.px(blendedValue(s.y, s.blendY, s.blendFrom, k, i));
          minPx = Math.min(minPx, y);
          maxPx = Math.max(maxPx, y);
          if (q === j) {
            ctx.moveTo(x, y);
          } else {
            segmentTo(ctx, interp, px, py, x, y);
          }
          px = x;
          py = y;
        }
        if (s.base === null) {
          ctx.lineTo(px, zero);
          ctx.lineTo(vp.left + (ts[pointIndex(idx[j])] - vp.from) * vp.pxPerMs, zero);
        } else {
          const back = reversed(interp);
          for (let q = jb - 1; q >= j; q--) {
            const i = pointIndex(idx[q]);
            const x = vp.left + (ts[i] - vp.from) * vp.pxPerMs;
            const y = scale.px(blendedValue(s.base, s.blendBase, s.blendFrom, k, i));
            if (q === jb - 1) {
              ctx.lineTo(x, y);
            } else {
              segmentTo(ctx, back, px, py, x, y);
            }
            px = x;
            py = y;
          }
        }
        ctx.closePath();
        j = jb;
      }
      this.fill(s, vp, zero, minPx, maxPx);
    }

    if (s.lineWidth > 0) {
      ctx.beginPath();
      let px = 0;
      let py = 0;
      for (let q = 0; q < count; q++) {
        const i = pointIndex(idx[q]);
        const x = vp.left + (ts[i] - vp.from) * vp.pxPerMs;
        const y = scale.px(blendedValue(s.y, s.blendY, s.blendFrom, k, i));
        if (idx[q] < 0) {
          ctx.moveTo(x, y);
        } else {
          segmentTo(ctx, interp, px, py, x, y);
        }
        px = x;
        py = y;
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.lineWidth;
      ctx.stroke();
    }
  }

  /** Fills the current path: flat with globalAlpha, or with an opacity gradient toward the zero line. */
  private fill(s: EngineSeries, vp: Viewport, zero: number, minPx: number, maxPx: number): void {
    const ctx = this.ctx;
    if (!s.gradient) {
      ctx.fillStyle = s.color;
      ctx.globalAlpha = s.fillOpacity;
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    if (s.fillGradient === null) {
      s.fillGradient = this.gradientFor(s.color, s.fillOpacity);
    }
    ctx.fillStyle = s.fillGradient;
    const dpr = vp.dpr;
    const top = vp.top;
    const bottom = vp.top + vp.height;
    // The gradient is defined from unit y 0 (opaque, far edge) to 1 (transparent, zero line);
    // the transform maps it onto the plot. Paths keep the coordinates they were built with, so
    // changing the transform here only moves the gradient. Beyond its ends the gradient pads
    // with the transparent stop, so each pass only paints its own side of the zero line.
    if (minPx < zero && zero - top > 0.5) {
      ctx.setTransform(dpr, 0, 0, dpr * (zero - top), 0, dpr * top);
      ctx.fill();
    }
    if (maxPx > zero && bottom - zero > 0.5) {
      ctx.setTransform(dpr, 0, 0, dpr * (zero - bottom), 0, dpr * bottom);
      ctx.fill();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private gradientFor(color: string, opacity: number): CanvasGradient {
    const key = color + '|' + opacity;
    let g = this.gradients.get(key);
    if (g === undefined) {
      g = this.ctx.createLinearGradient(0, 0, 0, 1);
      g.addColorStop(0, colorManipulator.alpha(color, opacity));
      g.addColorStop(1, colorManipulator.alpha(color, 0));
      if (this.gradients.size > 500) {
        this.gradients.clear();
      }
      this.gradients.set(key, g);
    }
    return g;
  }

  /** Dashed vertical line at x and, when y is inside the plot, a dashed horizontal line at y. */
  drawCrosshair(vp: Viewport, x: number, y: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = CROSSHAIR_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash(CROSSHAIR_DASH);
    ctx.beginPath();
    const cx = crisp(x, vp.dpr);
    ctx.moveTo(cx, vp.top);
    ctx.lineTo(cx, vp.top + vp.height);
    if (y === y && y >= vp.top && y <= vp.top + vp.height) {
      const cy = crisp(y, vp.dpr);
      ctx.moveTo(vp.left, cy);
      ctx.lineTo(vp.left + vp.width, cy);
    }
    ctx.stroke();
    ctx.setLineDash(SOLID);
  }

  drawDot(x: number, y: number, color: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}
