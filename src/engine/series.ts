import { Field } from '@grafana/data';

import { GlideModel, Interp, SeriesModel } from '../data/model';
import { exactIndex, lowerBound } from './search';

/** Duration of the blend applied when recent values were revised by a refresh, ms. */
export const BLEND_MS = 300;

/** A series as the engine draws it. Built on every data or visibility change, never per frame. */
export interface EngineSeries {
  key: string;
  name: string;
  color: string;
  field: Field;
  ts: Float64Array;
  raw: Float64Array;
  y: Float64Array;
  base: Float64Array | null;
  gapMs: number;
  lineWidth: number;
  fillOpacity: number;
  gradient: boolean;
  interp: Interp;
  stacked: boolean;
  negative: boolean;
  hideFromTooltip: boolean;
  /** Drawn and part of the auto scale. */
  visible: boolean;
  /** Blend of revised values: drawn y[i] + blendY[i - blendFrom] * k (same for base). */
  blendFrom: number;
  blendY: Float64Array | null;
  blendBase: Float64Array | null;
  blendStart: number;
  /** Fill gradient in unit space, created lazily by the renderer. */
  fillGradient: CanvasGradient | null;
}

export interface PrepareOptions {
  /** Series drawn before this change, or null. */
  prev: EngineSeries[] | null;
  /**
   * Keep points of the previous series that are older than the new data's first point and not
   * older than this time (ms), so the left edge does not jump while gliding. NaN disables.
   */
  retainFrom: number;
  /** Also retain for stacked series (false when the stacking itself changed). */
  retainStacked: boolean;
  /** Blend revised values at or after this time (ms); NaN disables, -Infinity blends all. */
  blendFrom: number;
  /** Current time for the blend start (performance clock, ms). */
  now: number;
}

/** Blend factor at time now: 1 right after the change, easing to 0 over BLEND_MS. */
export function blendFactor(s: EngineSeries, now: number): number {
  if (s.blendY === null) {
    return 0;
  }
  const u = (now - s.blendStart) / BLEND_MS;
  if (u >= 1) {
    return 0;
  }
  if (u <= 0) {
    return 1;
  }
  const v = 1 - u;
  return v * v * v;
}

/** Value of y (or base) at index i as drawn at blend factor k. */
export function blendedValue(
  arr: Float64Array,
  blend: Float64Array | null,
  blendFrom: number,
  k: number,
  i: number
): number {
  return k > 0 && blend !== null && i >= blendFrom ? arr[i] + blend[i - blendFrom] * k : arr[i];
}

function fromModel(m: SeriesModel, hidden: ReadonlySet<string>): EngineSeries {
  return {
    key: m.key,
    name: m.name,
    color: m.color,
    field: m.field,
    ts: m.ts,
    raw: m.raw,
    y: m.y,
    base: m.base,
    gapMs: m.gapMs,
    lineWidth: m.lineWidth,
    fillOpacity: m.fillOpacity,
    gradient: m.gradient,
    interp: m.interp,
    stacked: m.stacked,
    negative: m.negative,
    hideFromTooltip: m.hideFromTooltip,
    visible: !m.hidden && !hidden.has(m.key),
    blendFrom: 0,
    blendY: null,
    blendBase: null,
    blendStart: 0,
    fillGradient: null,
  };
}

/**
 * Recomputes stacks without the series hidden through the legend, as the time series panel
 * does. Members of a stack group share their time grid array (see buildModel).
 */
function restack(list: EngineSeries[], models: SeriesModel[]): void {
  let needed = false;
  for (let i = 0; i < list.length; i++) {
    if (list[i].stacked && !list[i].visible && !models[i].hidden) {
      needed = true;
      break;
    }
  }
  if (!needed) {
    return;
  }
  const done = new Set<number>();
  for (let i = 0; i < list.length; i++) {
    const first = list[i];
    if (!first.stacked || models[i].hidden || done.has(i)) {
      continue;
    }
    const grid = first.ts;
    const acc = new Float64Array(grid.length);
    let prevTop: Float64Array | null = null;
    for (let j = i; j < list.length; j++) {
      const s = list[j];
      if (!s.stacked || models[j].hidden || s.ts !== grid || s.negative !== first.negative) {
        continue;
      }
      done.add(j);
      if (!s.visible) {
        continue;
      }
      const sign = s.negative ? -1 : 1;
      const top = new Float64Array(grid.length);
      for (let k = 0; k < grid.length; k++) {
        const v = s.raw[k];
        if (v === v) {
          acc[k] += v;
        }
        top[k] = sign * acc[k];
      }
      s.y = top;
      s.base = prevTop;
      prevTop = top;
    }
  }
}

function concat(a: Float64Array, a0: number, a1: number, b: Float64Array | null, bLen: number): Float64Array {
  const out = new Float64Array(a1 - a0 + bLen);
  out.set(a.subarray(a0, a1), 0);
  if (b !== null) {
    out.set(b, a1 - a0);
  }
  return out;
}

/** Prepends the previous series' points in [retainFrom, s.ts[0]). */
function retain(s: EngineSeries, p: EngineSeries, retainFrom: number): void {
  const n = s.ts.length;
  const firstT = n > 0 ? s.ts[0] : Infinity;
  const a = lowerBound(p.ts, retainFrom);
  const b = lowerBound(p.ts, firstT);
  if (b <= a) {
    return;
  }
  const baseNeeded = s.base !== null || p.base !== null;
  const pBase = p.base ?? new Float64Array(p.ts.length);
  const sBase = s.base ?? (baseNeeded ? new Float64Array(n) : null);
  s.ts = concat(p.ts, a, b, s.ts, n);
  s.raw = concat(p.raw, a, b, s.raw, n);
  s.y = concat(p.y, a, b, s.y, n);
  s.base = baseNeeded ? concat(pBase, a, b, sBase, n) : null;
}

/** Records the difference between what was drawn and the new values for points at or after `from`. */
function blend(s: EngineSeries, p: EngineSeries, from: number, now: number): void {
  const n = s.ts.length;
  const i0 = from === -Infinity ? 0 : lowerBound(s.ts, from);
  if (i0 >= n) {
    return;
  }
  const k = blendFactor(p, now);
  const dy = new Float64Array(n - i0);
  const db = s.base !== null ? new Float64Array(n - i0) : null;
  let any = false;
  for (let i = i0; i < n; i++) {
    const j = exactIndex(p.ts, s.ts[i]);
    if (j < 0) {
      continue;
    }
    const d = blendedValue(p.y, p.blendY, p.blendFrom, k, j) - s.y[i];
    if (d === d && d !== 0 && isFinite(d)) {
      dy[i - i0] = d;
      any = true;
    }
    if (db !== null && s.base !== null) {
      const pb = p.base !== null ? blendedValue(p.base, p.blendBase, p.blendFrom, k, j) : 0;
      const e = pb - s.base[i];
      if (e === e && e !== 0 && isFinite(e)) {
        db[i - i0] = e;
        any = true;
      }
    }
  }
  if (any) {
    s.blendFrom = i0;
    s.blendY = dy;
    s.blendBase = db;
    s.blendStart = now;
  }
}

/** Builds the drawn series from a model. Allocates; call on changes only. */
export function prepareSeries(model: GlideModel, hidden: ReadonlySet<string>, opts: PrepareOptions): EngineSeries[] {
  const models = model.series;
  const list = models.map((m) => fromModel(m, hidden));
  restack(list, models);

  const prev = opts.prev;
  if (prev === null || prev.length === 0) {
    return list;
  }
  const byKey = new Map<string, EngineSeries>();
  for (const p of prev) {
    byKey.set(p.key, p);
  }
  for (const s of list) {
    const p = byKey.get(s.key);
    if (p === undefined || p.stacked !== s.stacked || p.negative !== s.negative) {
      continue;
    }
    if (opts.retainFrom === opts.retainFrom && (!s.stacked || opts.retainStacked)) {
      retain(s, p, opts.retainFrom);
    }
    if (opts.blendFrom === opts.blendFrom && p.visible && s.visible) {
      blend(s, p, opts.blendFrom, opts.now);
    }
  }
  return list;
}
