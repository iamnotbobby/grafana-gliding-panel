import { Field, formattedValueToString } from '@grafana/data';

import { HoverInfo, HoverItem } from './api';
import { Viewport } from './draw';
import { YScale } from './scale';
import { exactIndex, lowerBound, nearestIndex, upperBound } from './search';
import { blendedValue, blendFactor, EngineSeries } from './series';

function formatHoverValue(s: EngineSeries, v: number): string {
  if (v !== v) {
    return '';
  }
  const display = s.field.display;
  return display ? formattedValueToString(display(v)) : String(v);
}

/**
 * Nearest data timestamp to t among the visible series, restricted to [from, to]. NaN when no
 * visible series has a point there.
 */
function snapTime(series: readonly EngineSeries[], t: number, from: number, to: number): number {
  let best = NaN;
  let bestD = Infinity;
  for (let k = 0; k < series.length; k++) {
    const s = series[k];
    if (!s.visible) {
      continue;
    }
    const ts = s.ts;
    const lo = lowerBound(ts, from);
    const hi = upperBound(ts, to, lo);
    const i = nearestIndex(ts, t, lo, hi);
    if (i < 0) {
      continue;
    }
    const d = Math.abs(ts[i] - t);
    if (d < bestD) {
      bestD = d;
      best = ts[i];
    }
  }
  return best;
}

/**
 * Builds hover information into reused objects and tells whether it changed since the last
 * call. Value texts are only formatted again when a value changes.
 */
export class HoverBuilder {
  readonly info: HoverInfo = { time: NaN, x: NaN, y: NaN, items: [], local: false };
  private pool: HoverItem[] = [];
  private fields: Field[] = [];
  private has = false;

  /** Forgets the last result: the next build reports a change. */
  reset(): void {
    this.has = false;
  }

  get active(): boolean {
    return this.has;
  }

  /**
   * Builds the hover at time t into `info`; pointerY is NaN for an external cursor. Returns
   * whether anything changed since the previous call; `active` tells whether there is a hover.
   */
  build(
    series: readonly EngineSeries[],
    t: number,
    pointerY: number,
    local: boolean,
    vp: Viewport,
    scale: YScale,
    visibleEnd: number,
    now: number
  ): boolean {
    const end = visibleEnd < vp.to ? visibleEnd : vp.to;
    const time = snapTime(series, t, vp.from, end);
    if (time !== time) {
      const changed = this.has;
      this.has = false;
      return changed;
    }
    const info = this.info;
    const x = vp.left + (time - vp.from) * vp.pxPerMs;
    const y = local ? pointerY : vp.top + vp.height / 2;
    let changed = !this.has || info.time !== time || info.x !== x || info.y !== y || info.local !== local;

    const items = info.items;
    let n = 0;
    let nearest = -1;
    let nearestD = Infinity;
    for (let k = 0; k < series.length; k++) {
      const s = series[k];
      if (!s.visible || s.hideFromTooltip) {
        continue;
      }
      let item = this.pool[n];
      if (item === undefined) {
        item = { key: '', name: '', color: '', value: NaN, text: '', nearest: false };
        this.pool[n] = item;
      }
      const j = exactIndex(s.ts, time);
      const v = j >= 0 ? s.raw[j] : NaN;
      if (item.key !== s.key || item.color !== s.color || item.name !== s.name) {
        item.key = s.key;
        item.name = s.name;
        item.color = s.color;
        changed = true;
      }
      const sameValue = item.value === v || (item.value !== item.value && v !== v);
      if (!sameValue || this.fields[n] !== s.field) {
        item.value = v;
        item.text = formatHoverValue(s, v);
        this.fields[n] = s.field;
        changed = true;
      }
      if (local && j >= 0 && v === v) {
        const yv = blendedValue(s.y, s.blendY, s.blendFrom, blendFactor(s, now), j);
        const d = Math.abs(scale.px(yv) - pointerY);
        if (d < nearestD) {
          nearestD = d;
          nearest = n;
        }
      }
      if (items[n] !== item) {
        items[n] = item;
        changed = true;
      }
      n++;
    }
    if (items.length !== n) {
      items.length = n;
      changed = true;
    }
    for (let i = 0; i < n; i++) {
      const isNearest = i === nearest;
      if (items[i].nearest !== isNearest) {
        items[i].nearest = isNearest;
        changed = true;
      }
    }
    info.time = time;
    info.x = x;
    info.y = y;
    info.local = local;
    this.has = true;
    return changed;
  }
}
