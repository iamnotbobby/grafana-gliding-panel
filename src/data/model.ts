import {
  DataFrame,
  Field,
  FieldColorModeId,
  FieldType,
  getFieldDisplayName,
  getDisplayProcessor,
  getFieldSeriesColor,
  GrafanaTheme2,
} from '@grafana/data';
import {
  GraphGradientMode,
  GraphThresholdsStyleMode,
  GraphTransform,
  LineInterpolation,
  ScaleDistribution,
  StackingMode,
} from '@grafana/schema';

import { GlideFieldConfig } from '../types';

export const enum Interp {
  Linear = 0,
  StepBefore = 1,
  StepAfter = 2,
}

export interface SeriesModel {
  /** Unique within the panel; the display name (with a suffix when names collide). */
  key: string;
  name: string;
  color: string;
  field: Field;
  /** Timestamps in ms, ascending. For stacked series this is the stack group's shared grid. */
  ts: Float64Array;
  /** Original values at `ts`, NaN where the series has no point. */
  raw: Float64Array;
  /** Plotted values: sign applied (negative-Y) and stacked on top of earlier series. */
  y: Float64Array;
  /** Lower edge of the fill for stacked series; null means "fill to zero". */
  base: Float64Array | null;
  /** Two consecutive points further apart than this are not connected. */
  gapMs: number;
  hidden: boolean;
  hideFromLegend: boolean;
  hideFromTooltip: boolean;
  lineWidth: number;
  /** 0..1 */
  fillOpacity: number;
  gradient: boolean;
  interp: Interp;
  stacked: boolean;
  negative: boolean;
}

export interface AxisModel {
  /** Field whose display processor formats the tick labels and supplies thresholds. */
  field: Field | null;
  hardMin: number | null;
  hardMax: number | null;
  softMin: number | null;
  softMax: number | null;
  /** 0 for linear, otherwise the log base. */
  logBase: number;
  /** Percent stacking: the axis spans 0..1 (or -1..0) and is labelled in percent. */
  percent: boolean;
  thresholdsMode: GraphThresholdsStyleMode;
}

export interface GlideModel {
  series: SeriesModel[];
  axis: AxisModel;
  /** Largest timestamp across all series, or NaN when there is no data. */
  lastT: number;
  firstT: number;
  /** Query step in ms (best guess). */
  stepMs: number;
}

/**
 * Palette slot per series name, so colours do not reshuffle when series come and go. A new name
 * takes Grafana's slot when it is free, otherwise the first free one.
 */
export class ColorRegistry {
  private slots = new Map<string, number>();
  private used = new Set<number>();

  slotFor(name: string, preferred: number): number {
    const known = this.slots.get(name);
    if (known !== undefined) {
      return known;
    }
    // Bounds memory under endless series churn.
    if (this.slots.size > 5000) {
      this.slots.clear();
      this.used.clear();
    }
    let slot = preferred;
    if (slot < 0 || this.used.has(slot)) {
      slot = 0;
      while (this.used.has(slot)) {
        slot++;
      }
    }
    this.slots.set(name, slot);
    this.used.add(slot);
    return slot;
  }
}

const EMPTY = new Float64Array(0);

function isSorted(a: Float64Array): boolean {
  for (let i = 1; i < a.length; i++) {
    if (a[i] < a[i - 1]) {
      return false;
    }
  }
  return true;
}

/** Extracts the non-null points of a number field as typed arrays. */
function extractPoints(time: Field, value: Field): { ts: Float64Array; vs: Float64Array } {
  const tv = time.values;
  const vv = value.values;
  const len = Math.min(tv.length, vv.length);
  let ts = new Float64Array(len);
  let vs = new Float64Array(len);
  let n = 0;
  for (let i = 0; i < len; i++) {
    const v = vv[i];
    const t = tv[i];
    if (v == null || t == null) {
      continue;
    }
    const num = +v;
    if (num !== num || !isFinite(num)) {
      continue;
    }
    ts[n] = +t;
    vs[n] = num;
    n++;
  }
  if (n < len) {
    ts = ts.slice(0, n);
    vs = vs.slice(0, n);
  }
  if (!isSorted(ts)) {
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => ts[a] - ts[b]);
    const ts2 = new Float64Array(n);
    const vs2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ts2[i] = ts[order[i]];
      vs2[i] = vs[order[i]];
    }
    ts = ts2;
    vs = vs2;
  }
  return { ts, vs };
}

function sameGrid(a: Float64Array, b: Float64Array): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Sorted union of several ascending timestamp arrays. */
export function unionGrid(grids: Float64Array[]): Float64Array {
  if (grids.length === 0) {
    return EMPTY;
  }
  let allSame = true;
  for (let i = 1; i < grids.length; i++) {
    if (!sameGrid(grids[0], grids[i])) {
      allSame = false;
      break;
    }
  }
  if (allSame) {
    return grids[0];
  }
  let total = 0;
  for (const g of grids) {
    total += g.length;
  }
  const all = new Float64Array(total);
  let o = 0;
  for (const g of grids) {
    all.set(g, o);
    o += g.length;
  }
  all.sort();
  let n = 0;
  for (let i = 0; i < total; i++) {
    if (n === 0 || all[i] !== all[n - 1]) {
      all[n++] = all[i];
    }
  }
  return all.slice(0, n);
}

/** Places a series' own points on a (superset) grid; NaN where it has none. */
export function alignToGrid(grid: Float64Array, ts: Float64Array, vs: Float64Array): Float64Array {
  if (grid === ts) {
    return vs;
  }
  const out = new Float64Array(grid.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < grid.length && j < ts.length; i++) {
    if (grid[i] === ts[j]) {
      out[i] = vs[j];
      j++;
    }
  }
  return out;
}

interface Pending {
  model: SeriesModel;
  ownTs: Float64Array;
  ownVs: Float64Array;
  stackKey: string | null;
}

export function buildModel(
  frames: DataFrame[],
  theme: GrafanaTheme2,
  colors: ColorRegistry,
  requestIntervalMs: number | undefined
): GlideModel {
  const pending: Pending[] = [];
  const usedKeys = new Set<string>();
  const palette = theme.visualization.palette;
  let stepMs = Infinity;
  let runningIndex = 0;

  let axisField: Field | null = null;

  for (const frame of frames) {
    const time = frame.fields.find((f) => f.type === FieldType.time);
    if (!time) {
      continue;
    }
    const frameStep = time.config.interval;
    if (frameStep && frameStep > 0) {
      stepMs = Math.min(stepMs, frameStep);
    }

    for (const field of frame.fields) {
      if (field.type !== FieldType.number) {
        continue;
      }
      const custom: GlideFieldConfig = field.config.custom ?? {};
      const name = getFieldDisplayName(field, frame, frames);
      let key = name;
      for (let n = 2; usedKeys.has(key); n++) {
        key = `${name} (${n})`;
      }
      usedKeys.add(key);

      const seriesIndex = field.state?.seriesIndex ?? runningIndex;
      runningIndex++;

      const colorMode = field.config.color?.mode;
      let color: string;
      if (!colorMode || colorMode === FieldColorModeId.PaletteClassic) {
        const slot = colors.slotFor(key, seriesIndex);
        color = theme.visualization.getColorByName(palette[slot % palette.length]);
      } else {
        color = getFieldSeriesColor(field, theme).color;
      }

      const { ts, vs } = extractPoints(time, field);
      const hide = custom.hideFrom ?? { viz: false, legend: false, tooltip: false };
      const negative = custom.transform === GraphTransform.NegativeY;
      const stackMode = custom.stacking?.mode;
      const stacked = !!stackMode && stackMode !== StackingMode.None;
      const interp =
        custom.lineInterpolation === LineInterpolation.StepAfter
          ? Interp.StepAfter
          : custom.lineInterpolation === LineInterpolation.StepBefore
            ? Interp.StepBefore
            : Interp.Linear;

      const span = custom.spanNulls;
      const model: SeriesModel = {
        key,
        name,
        color,
        field,
        ts,
        raw: vs,
        y: vs,
        base: null,
        // Raised to the default gap once the step is known.
        gapMs: span === true ? Infinity : typeof span === 'number' ? span : 0,
        hidden: !!hide.viz,
        hideFromLegend: !!hide.legend,
        hideFromTooltip: !!hide.tooltip,
        lineWidth: custom.lineWidth ?? 1,
        fillOpacity: Math.max(0, Math.min(1, (custom.fillOpacity ?? 0) / 100)),
        gradient: custom.gradientMode === GraphGradientMode.Opacity,
        interp,
        stacked,
        negative,
      };

      if (!model.hidden) {
        axisField = axisField ?? field;
      }

      pending.push({
        model,
        ownTs: ts,
        ownVs: vs,
        stackKey: stacked ? `${custom.stacking?.group ?? 'A'}|${negative ? '-' : '+'}|${stackMode}` : null,
      });
    }
  }

  // Step: frame interval, else the request interval, else the smallest spacing seen.
  if (!isFinite(stepMs)) {
    stepMs = requestIntervalMs && requestIntervalMs > 0 ? requestIntervalMs : Infinity;
  }
  if (!isFinite(stepMs)) {
    for (const p of pending) {
      for (let i = 1; i < p.ownTs.length; i++) {
        const d = p.ownTs[i] - p.ownTs[i - 1];
        if (d > 0 && d < stepMs) {
          stepMs = d;
        }
      }
    }
  }
  if (!isFinite(stepMs)) {
    stepMs = 1000;
  }

  const defaultGap = stepMs * 1.5;
  for (const p of pending) {
    const m = p.model;
    if (m.gapMs !== Infinity) {
      m.gapMs = Math.max(m.gapMs, defaultGap);
    }
  }

  // Stacking: every group shares one time grid; a missing point counts as zero.
  const groups = new Map<string, Pending[]>();
  for (const p of pending) {
    if (p.stackKey && !p.model.hidden) {
      const g = groups.get(p.stackKey);
      if (g) {
        g.push(p);
      } else {
        groups.set(p.stackKey, [p]);
      }
    }
  }
  for (const members of groups.values()) {
    const grid = unionGrid(members.map((m) => m.ownTs));
    const acc = new Float64Array(grid.length);
    let prevTop: Float64Array | null = null;
    for (const p of members) {
      const m = p.model;
      const raw = alignToGrid(grid, p.ownTs, p.ownVs);
      const sign = m.negative ? -1 : 1;
      const top = new Float64Array(grid.length);
      for (let i = 0; i < grid.length; i++) {
        const v = raw[i];
        if (v === v) {
          acc[i] += v;
        }
        top[i] = sign * acc[i];
      }
      m.ts = grid;
      m.raw = raw;
      m.y = top;
      m.base = prevTop;
      prevTop = top;
    }
    // Percent stacking, as Grafana: every level divided by the group's total at that time. The
    // bases are the previous members' tops, so they are scaled with them.
    if (members[0].stackKey!.endsWith(`|${StackingMode.Percent}`)) {
      for (const p of members) {
        const y = p.model.y;
        for (let i = 0; i < y.length; i++) {
          y[i] = acc[i] === 0 ? 0 : y[i] / acc[i];
        }
      }
    }
  }

  // Non-stacked negative-Y series: flip the sign of the plotted values.
  for (const p of pending) {
    const m = p.model;
    if (m.negative && m.y === m.raw) {
      const y = new Float64Array(m.raw.length);
      for (let i = 0; i < y.length; i++) {
        y[i] = -m.raw[i];
      }
      m.y = y;
    }
  }

  let lastT = NaN;
  let firstT = NaN;
  for (const p of pending) {
    const ts = p.model.ts;
    if (ts.length > 0) {
      const l = ts[ts.length - 1];
      const f = ts[0];
      if (!(lastT >= l)) {
        lastT = l;
      }
      if (!(firstT <= f)) {
        firstT = f;
      }
    }
  }

  const axisCfg = axisField?.config;
  const axisCustom: GlideFieldConfig = axisCfg?.custom ?? {};
  const dist = axisCustom.scaleDistribution;
  const percent = axisCustom.stacking?.mode === StackingMode.Percent;
  if (percent && axisField !== null) {
    const config = { ...axisField.config, unit: 'percentunit' };
    axisField = { ...axisField, config, display: getDisplayProcessor({ field: { ...axisField, config }, theme }) };
  }

  return {
    series: pending.map((p) => p.model),
    axis: {
      field: axisField,
      percent,
      hardMin: axisCfg?.min ?? null,
      hardMax: axisCfg?.max ?? null,
      softMin: axisCustom.axisSoftMin ?? null,
      softMax: axisCustom.axisSoftMax ?? null,
      logBase: dist?.type === ScaleDistribution.Log ? (dist.log ?? 10) : 0,
      thresholdsMode: axisCustom.thresholdsStyle?.mode ?? GraphThresholdsStyleMode.Off,
    },
    lastT,
    firstT,
    stepMs,
  };
}
