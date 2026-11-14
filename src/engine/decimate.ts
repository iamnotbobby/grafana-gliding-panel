/**
 * Point selection for path building. The result is a list of point indices; an index stored
 * as its bitwise complement (~i, always negative) starts a new run, meaning the path must not
 * be connected to the previous point (a gap, or the very first point).
 */

/**
 * Selects the drawable points of ts/ys in [i0, i1).
 *
 * Points with a NaN value are skipped and break the line. Two consecutive points further apart
 * than gapMs break the line as well.
 *
 * With colsPerMs > 0 the points are decimated per pixel column: every column keeps its first
 * point, its minimum, its maximum and its last point (in time order), which preserves the
 * visual envelope of the line. Columns are anchored to absolute time, so the selection does
 * not shimmer while the chart glides.
 *
 * `out` must hold at least i1 - i0 entries. Returns the number of entries written.
 */
export function selectIndices(
  ts: Float64Array,
  ys: Float64Array,
  i0: number,
  i1: number,
  gapMs: number,
  colsPerMs: number,
  out: Int32Array
): number {
  let n = 0;
  let prevT = NaN;

  if (!(colsPerMs > 0)) {
    for (let i = i0; i < i1; i++) {
      const y = ys[i];
      if (y !== y) {
        prevT = NaN;
        continue;
      }
      const t = ts[i];
      // prevT is NaN at the start and after a hole: the comparison is then false.
      out[n++] = t - prevT <= gapMs ? i : ~i;
      prevT = t;
    }
    return n;
  }

  let col = NaN;
  let first = -1;
  let last = -1;
  let minI = -1;
  let maxI = -1;
  let minV = 0;
  let maxV = 0;
  let firstBreaks = true;

  for (let i = i0; i < i1; i++) {
    const y = ys[i];
    const valid = y === y;
    const t = ts[i];
    const connected = valid && t - prevT <= gapMs;
    const c = Math.floor(t * colsPerMs);

    if (first >= 0 && (!connected || c !== col)) {
      n = flushColumn(out, n, first, minI, maxI, last, firstBreaks);
      first = -1;
    }
    if (!valid) {
      prevT = NaN;
      continue;
    }
    if (first < 0) {
      first = last = minI = maxI = i;
      minV = maxV = y;
      col = c;
      firstBreaks = !connected;
    } else {
      last = i;
      if (y < minV) {
        minV = y;
        minI = i;
      }
      if (y > maxV) {
        maxV = y;
        maxI = i;
      }
    }
    prevT = t;
  }
  if (first >= 0) {
    n = flushColumn(out, n, first, minI, maxI, last, firstBreaks);
  }
  return n;
}

function flushColumn(
  out: Int32Array,
  n: number,
  first: number,
  minI: number,
  maxI: number,
  last: number,
  firstBreaks: boolean
): number {
  out[n++] = firstBreaks ? ~first : first;
  const a = minI < maxI ? minI : maxI;
  const b = minI < maxI ? maxI : minI;
  if (a > first && a < last) {
    out[n++] = a;
  }
  if (b > a && b > first && b < last) {
    out[n++] = b;
  }
  if (last > first) {
    out[n++] = last;
  }
  return n;
}
