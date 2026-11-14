import { dateTimeForTimeZone, dateTimeFormat, Field, formattedValueToString, systemDateFormats } from '@grafana/data';

import { stepDecimals } from './scale';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Minimum gap between two time labels, CSS px. */
const TIME_LABEL_GAP = 28;

/** Candidate time tick steps, ms. */
const TIME_STEPS = [
  1,
  2,
  5,
  10,
  20,
  50,
  100,
  200,
  500,
  SEC,
  2 * SEC,
  5 * SEC,
  10 * SEC,
  15 * SEC,
  30 * SEC,
  MIN,
  2 * MIN,
  5 * MIN,
  10 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
  90 * DAY,
  180 * DAY,
  365 * DAY,
];

/** Moment format for labels of a given tick step over a given range (Grafana's interval formats). */
export function timeFormatFor(stepMs: number, rangeMs: number): string {
  const f = systemDateFormats.interval;
  if (stepMs < SEC) {
    return f.millisecond;
  }
  if (stepMs < MIN) {
    return f.second;
  }
  if (stepMs < DAY) {
    return rangeMs <= DAY ? f.minute : f.hour;
  }
  if (stepMs < 30 * DAY) {
    return f.day;
  }
  if (stepMs < 365 * DAY) {
    return f.month;
  }
  return f.year;
}

/** Smallest time step whose labels fit next to each other; ctx must have the label font set. */
export function chooseTimeStep(
  pxPerMs: number,
  rangeMs: number,
  ctx: CanvasRenderingContext2D,
  labels: LabelCache
): number {
  for (let i = 0; i < TIME_STEPS.length; i++) {
    const s = TIME_STEPS[i];
    if (s * pxPerMs >= labels.formatWidth(ctx, timeFormatFor(s, rangeMs)) + TIME_LABEL_GAP) {
      return s;
    }
  }
  return TIME_STEPS[TIME_STEPS.length - 1];
}

/**
 * Writes tick times in [from, to] to out (aligned so that local time is a multiple of the step,
 * given the time zone offset in ms). Returns the count.
 */
export function timeTicks(from: number, to: number, stepMs: number, tzOffsetMs: number, out: Float64Array): number {
  let n = 0;
  const k0 = Math.ceil((from + tzOffsetMs) / stepMs);
  const k1 = Math.floor((to + tzOffsetMs) / stepMs);
  for (let k = k0; k <= k1 && n < out.length; k++) {
    out[n++] = k * stepMs - tzOffsetMs;
  }
  return n;
}

/** Offset of a time zone from UTC at time t, ms (positive east of Greenwich). */
function timeZoneOffsetMs(timeZone: string, t: number): number {
  if (timeZone === 'utc') {
    return 0;
  }
  if (!timeZone || timeZone === 'browser') {
    return -new Date(t).getTimezoneOffset() * MIN;
  }
  try {
    return dateTimeForTimeZone(timeZone, t).utcOffset() * MIN;
  } catch {
    return -new Date(t).getTimezoneOffset() * MIN;
  }
}

const MAX_CACHE = 2000;

/** Formats and measures axis labels with caching, so a gliding chart formats and measures each label once. */
export class LabelCache {
  private timeLabels = new Map<number, string>();
  private timeFormat = '';
  private timeZone = '';
  private valueLabels = new Map<number, string>();
  private valueField: Field | null = null;
  private valueDecimals = -1;
  private widths = new Map<string, number>();
  private tzOffset = 0;
  private tzOffsetAt = NaN;
  private tz = '';
  private formatWidths = new Map<string, number>();

  /** Clears everything (theme or font change). */
  reset(): void {
    this.timeLabels.clear();
    this.valueLabels.clear();
    this.widths.clear();
    this.formatWidths.clear();
    this.timeFormat = '';
    this.valueField = null;
    this.tzOffsetAt = NaN;
  }

  /** Cached time zone offset near time t (recomputed every 15 minutes of data time). */
  offset(timeZone: string, t: number): number {
    if (timeZone !== this.tz || !(Math.abs(t - this.tzOffsetAt) < 15 * MIN)) {
      this.tz = timeZone;
      this.tzOffsetAt = t;
      this.tzOffset = timeZoneOffsetMs(timeZone, t);
    }
    return this.tzOffset;
  }

  timeLabel(t: number, format: string, timeZone: string): string {
    if (format !== this.timeFormat || timeZone !== this.timeZone) {
      this.timeFormat = format;
      this.timeZone = timeZone;
      this.timeLabels.clear();
    }
    let s = this.timeLabels.get(t);
    if (s === undefined) {
      if (this.timeLabels.size > MAX_CACHE) {
        this.timeLabels.clear();
      }
      s = dateTimeFormat(t, { format, timeZone });
      this.timeLabels.set(t, s);
    }
    return s;
  }

  /**
   * Label of a y tick, formatted with the axis field's display processor. Decimals follow the
   * tick step; for whole steps the unit formatter picks them (1200 with a "K" unit prints 1.20K).
   */
  valueLabel(v: number, field: Field | null, step: number, log = false): string {
    // Log ticks each pass their own value as step, so key the cache on the mode, not the decimals.
    const fromStep = stepDecimals(step);
    const decimals = field?.config.decimals ?? (fromStep > 0 ? fromStep : undefined);
    const cacheKey = log ? -1 : decimals === undefined ? -2 : decimals;
    if (field !== this.valueField || cacheKey !== this.valueDecimals) {
      this.valueField = field;
      this.valueDecimals = cacheKey;
      this.valueLabels.clear();
    }
    let s = this.valueLabels.get(v);
    if (s === undefined) {
      if (this.valueLabels.size > MAX_CACHE) {
        this.valueLabels.clear();
      }
      s = formatValue(v, field, decimals);
      this.valueLabels.set(v, s);
    }
    return s;
  }

  /** Width of a text in the current font; ctx must have that font set. */
  width(ctx: CanvasRenderingContext2D, text: string): number {
    let w = this.widths.get(text);
    if (w === undefined) {
      if (this.widths.size > MAX_CACHE) {
        this.widths.clear();
      }
      w = ctx.measureText(text).width;
      this.widths.set(text, w);
    }
    return w;
  }

  /** Width of a typical label in a date format (sample: a wide date, 2000-12-28 22:58:58.888). */
  formatWidth(ctx: CanvasRenderingContext2D, format: string): number {
    let w = this.formatWidths.get(format);
    if (w === undefined) {
      w = ctx.measureText(dateTimeFormat(Date.UTC(2000, 11, 28, 22, 58, 58, 888), { format, timeZone: 'utc' })).width;
      this.formatWidths.set(format, w);
    }
    return w;
  }
}

function formatValue(v: number, field: Field | null, decimals: number | undefined): string {
  if (field?.display) {
    return formattedValueToString(field.display(v, decimals));
  }
  return decimals === undefined ? String(v) : v.toFixed(decimals);
}
