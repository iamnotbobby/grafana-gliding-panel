/** A horizontal drag shorter than this (CSS px) is a click, not a zoom. */
const MIN_ZOOM_DRAG_PX = 4;

export interface Span {
  left: number;
  right: number;
}

export function clampToPlot(x: number, plotLeft: number, plotWidth: number): number {
  const right = plotLeft + plotWidth;
  return x < plotLeft ? plotLeft : x > right ? right : x;
}

/**
 * The horizontal span selected by a drag from `startX` to `endX` (CSS px relative to the canvas),
 * clamped to the plot area and ordered left to right. Writes into `out` and returns it, or null
 * when the drag is too short to count as a selection.
 */
export function selectionSpan(
  startX: number,
  endX: number,
  plotLeft: number,
  plotWidth: number,
  out: Span
): Span | null {
  const a = clampToPlot(startX, plotLeft, plotWidth);
  const b = clampToPlot(endX, plotLeft, plotWidth);
  const left = a < b ? a : b;
  const right = a < b ? b : a;
  if (!(right - left >= MIN_ZOOM_DRAG_PX)) {
    return null;
  }
  out.left = left;
  out.right = right;
  return out;
}

export function insidePlot(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number }
): boolean {
  return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
}
