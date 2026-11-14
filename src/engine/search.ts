/** Binary searches over ascending numeric arrays. No allocations. */

/** First index in [lo, hi) whose value is >= x; hi when there is none. */
export function lowerBound(a: ArrayLike<number>, x: number, lo = 0, hi: number = a.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** First index in [lo, hi) whose value is > x; hi when there is none. */
export function upperBound(a: ArrayLike<number>, x: number, lo = 0, hi: number = a.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Start of the index range needed to draw [from, ..): the first point at or after `from`,
 * plus one point before it so the segment crossing the left edge is drawn.
 */
export function rangeStart(ts: ArrayLike<number>, from: number): number {
  const i = lowerBound(ts, from);
  return i > 0 ? i - 1 : 0;
}

/**
 * Exclusive end of the index range needed to draw (.., to]: the last point at or before `to`,
 * plus one point after it so the segment crossing the right edge is drawn.
 */
export function rangeEnd(ts: ArrayLike<number>, to: number): number {
  const i = upperBound(ts, to);
  return i < ts.length ? i + 1 : i;
}

/** Index in [lo, hi) of the value nearest to x, or -1 when the range is empty. */
export function nearestIndex(a: ArrayLike<number>, x: number, lo = 0, hi: number = a.length): number {
  if (hi <= lo) {
    return -1;
  }
  const i = lowerBound(a, x, lo, hi);
  if (i <= lo) {
    return lo;
  }
  if (i >= hi) {
    return hi - 1;
  }
  return x - a[i - 1] <= a[i] - x ? i - 1 : i;
}

/** Index of the exact value x, or -1. */
export function exactIndex(a: ArrayLike<number>, x: number): number {
  const i = lowerBound(a, x);
  return i < a.length && a[i] === x ? i : -1;
}
