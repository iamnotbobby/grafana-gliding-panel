import { dateTime, LoadingState, TimeRange } from '@grafana/data';
import { locationService } from '@grafana/runtime';

import {
  buildTimeWindow,
  detectRefreshMs,
  estimateEvaluatedAt,
  isSettled,
  nowOffsetMs,
  parseRefreshMs,
} from './timeWindow';

function range(from: number, to: number, rawFrom: string, rawTo: string): TimeRange {
  return { from: dateTime(from), to: dateTime(to), raw: { from: rawFrom, to: rawTo } };
}

describe('isSettled', () => {
  it('accepts only done and streaming results', () => {
    expect(isSettled(LoadingState.Done)).toBe(true);
    expect(isSettled(LoadingState.Streaming)).toBe(true);
    expect(isSettled(LoadingState.Loading)).toBe(false);
    expect(isSettled(LoadingState.Error)).toBe(false);
    expect(isSettled(LoadingState.NotStarted)).toBe(false);
    expect(isSettled(undefined)).toBe(false);
  });
});

describe('nowOffsetMs', () => {
  it('parses plain relative expressions', () => {
    expect(nowOffsetMs('now')).toBe(0);
    expect(nowOffsetMs('now-6s')).toBe(-6000);
    expect(nowOffsetMs('now-10s')).toBe(-10000);
    expect(nowOffsetMs('now+1m')).toBe(60000);
  });

  it('rejects rounding, calendar units and absolute values', () => {
    expect(nowOffsetMs('now/d')).toBeNull();
    expect(nowOffsetMs('now-1d')).toBeNull();
    expect(nowOffsetMs('2026-01-01')).toBeNull();
    expect(nowOffsetMs(12345)).toBeNull();
  });
});

describe('estimateEvaluatedAt', () => {
  const now = 1_000_000;

  it('derives the moment from a relative end', () => {
    expect(estimateEvaluatedAt(now - 6000 - 300, 'now-6s', undefined, now)).toBe(now - 300);
  });

  it('prefers the request start time when the derived moment is clearly earlier', () => {
    expect(estimateEvaluatedAt(now - 6000 - 5000, 'now-6s', now - 200, now)).toBe(now - 200);
  });

  it('keeps the derived moment when it agrees with the request start time', () => {
    expect(estimateEvaluatedAt(now - 6000 - 100, 'now-6s', now - 200, now)).toBe(now - 100);
  });

  it('falls back to the request start time, then to now, and never returns the future', () => {
    expect(estimateEvaluatedAt(500, 'now/d', now - 50, now)).toBe(now - 50);
    expect(estimateEvaluatedAt(500, 'now/d', undefined, now)).toBe(now);
    expect(estimateEvaluatedAt(now + 5000, 'now', undefined, now)).toBe(now);
  });
});

describe('buildTimeWindow', () => {
  it('describes a relative range', () => {
    const now = 2_000_000;
    const w = buildTimeWindow(range(now - 300_000, now - 6000, 'now-5m', 'now-6s'), now - 20, now);
    expect(w).toEqual({
      from: now - 300_000,
      to: now - 6000,
      relative: true,
      evaluatedAt: now,
      rawKey: 'now-5m|now-6s',
    });
  });

  it('marks ranges with an absolute end as not relative', () => {
    const w = buildTimeWindow(range(1000, 5000, 'now-5m', '2026-01-01 00:00:00'), undefined, 9000);
    expect(w.relative).toBe(false);
    expect(w.rawKey).toBe('now-5m|2026-01-01 00:00:00');
  });

  it('stringifies non-string raw values', () => {
    const r: TimeRange = {
      from: dateTime(1000),
      to: dateTime(5000),
      raw: { from: dateTime(1000), to: dateTime(5000) },
    };
    const w = buildTimeWindow(r, undefined, 9000);
    expect(w.relative).toBe(false);
    expect(w.rawKey).toBe('1000|5000');
  });
});

describe('refresh detection', () => {
  it('parses dashboard refresh settings', () => {
    expect(parseRefreshMs('1s')).toBe(1000);
    expect(parseRefreshMs('5s')).toBe(5000);
    expect(parseRefreshMs('1m')).toBe(60000);
    expect(parseRefreshMs(['10s', '1m'])).toBe(10000);
  });

  it('returns null for off, auto and garbage', () => {
    expect(parseRefreshMs(undefined)).toBeNull();
    expect(parseRefreshMs('')).toBeNull();
    expect(parseRefreshMs('auto')).toBeNull();
    expect(parseRefreshMs('soon')).toBeNull();
    expect(parseRefreshMs('5x')).toBeNull();
    expect(parseRefreshMs(5)).toBeNull();
  });

  it('reads the refresh URL parameter', () => {
    locationService.push('/d/abc/glide?from=now-5m&to=now-6s&refresh=5s');
    expect(detectRefreshMs()).toBe(5000);
    locationService.push('/d/abc/glide?from=now-5m&to=now-6s');
    expect(detectRefreshMs()).toBeNull();
  });
});
