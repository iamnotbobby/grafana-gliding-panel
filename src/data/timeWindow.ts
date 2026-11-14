import { LoadingState, rangeUtil, TimeRange } from '@grafana/data';
import { locationService } from '@grafana/runtime';

import { TimeWindow } from '../engine/api';

/** Only settled results replace the chart. */
export function isSettled(state: LoadingState | undefined): boolean {
  return state === LoadingState.Done || state === LoadingState.Streaming;
}

const NOW_OFFSET = /^\s*now\s*(?:([+-])\s*(\d+)\s*(ms|s|m|h))?\s*$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };

/**
 * Offset in ms of a plain relative expression ("now", "now-6s", "now+1m") from now. Returns
 * null for anything else (absolute times, rounding such as "now/d", calendar units).
 */
export function nowOffsetMs(raw: unknown): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const m = NOW_OFFSET.exec(raw);
  if (!m) {
    return null;
  }
  if (m[1] === undefined) {
    return 0;
  }
  const amount = Number(m[2]) * UNIT_MS[m[3]];
  return m[1] === '-' ? -amount : amount;
}

function rawToString(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw != null) {
    return String(raw.valueOf());
  }
  return '';
}

function isRelative(raw: unknown): boolean {
  return typeof raw === 'string' && raw.indexOf('now') !== -1;
}

/** A range evaluated at most this long before its request was built counts as the same moment. */
const EVALUATION_SLACK_MS = 250;

/**
 * Wall-clock time at which the range was evaluated: the range end minus a plain relative offset,
 * unless that is clearly earlier than the request start time, which then wins. Never in the future.
 */
export function estimateEvaluatedAt(
  toMs: number,
  rawTo: unknown,
  requestStartTime: number | undefined,
  nowMs: number
): number {
  const offset = nowOffsetMs(rawTo);
  const derived = offset === null ? NaN : toMs - offset;
  const started = typeof requestStartTime === 'number' && requestStartTime > 0 ? requestStartTime : NaN;

  let at: number;
  if (derived === derived && started === started) {
    at = derived >= started - EVALUATION_SLACK_MS ? derived : started;
  } else if (derived === derived) {
    at = derived;
  } else if (started === started) {
    at = started;
  } else {
    at = nowMs;
  }
  return at > nowMs ? nowMs : at;
}

export function buildTimeWindow(range: TimeRange, requestStartTime: number | undefined, nowMs: number): TimeWindow {
  const from = range.from.valueOf();
  const to = range.to.valueOf();
  const rawFrom: unknown = range.raw?.from;
  const rawTo: unknown = range.raw?.to;
  return {
    from,
    to,
    relative: isRelative(rawFrom) && isRelative(rawTo),
    evaluatedAt: estimateEvaluatedAt(to, rawTo, requestStartTime, nowMs),
    rawKey: rawToString(rawFrom) + '|' + rawToString(rawTo),
  };
}

/** Parses a dashboard refresh setting ("5s", "1m"); null for off, "auto" or anything invalid. */
export function parseRefreshMs(value: unknown): number | null {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  if (typeof first !== 'string') {
    return null;
  }
  const text = first.trim();
  if (!/^\d/.test(text)) {
    return null;
  }
  try {
    const ms = rangeUtil.intervalToMs(text);
    return isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/** The dashboard refresh interval from the "refresh" URL parameter, which follows the refresh picker. */
export function detectRefreshMs(): number | null {
  try {
    return parseRefreshMs(locationService.getSearchObject().refresh);
  } catch {
    return null;
  }
}
