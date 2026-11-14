import { SortOrder, TooltipDisplayMode } from '@grafana/schema';

import { HoverItem } from '../engine/api';

export interface TooltipRow {
  key: string;
  label: string;
  value: string;
  color: string;
  /** The series closest to the pointer, in multi mode. */
  active: boolean;
  numeric: number;
}

/**
 * Tooltip rows with the rules of Grafana's tooltip: series without a point are skipped, hideZeros
 * drops exact zeros, single mode keeps the nearest series, sorting is by value.
 */
export function buildTooltipRows(
  items: readonly HoverItem[],
  count: number,
  mode: TooltipDisplayMode,
  sort: SortOrder,
  hideZeros: boolean
): TooltipRow[] {
  const rows: TooltipRow[] = [];
  if (mode === TooltipDisplayMode.None) {
    return rows;
  }
  const single = mode === TooltipDisplayMode.Single;
  const n = Math.min(count, items.length);

  for (let i = 0; i < n; i++) {
    const item = items[i];
    const v = item.value;
    if (v !== v) {
      continue;
    }
    if (single && !item.nearest) {
      continue;
    }
    if (hideZeros && v === 0) {
      continue;
    }
    rows.push({
      key: item.key,
      label: item.name,
      value: item.text,
      color: item.color,
      active: !single && item.nearest,
      numeric: v,
    });
  }

  if (sort === SortOrder.Ascending) {
    rows.sort(ascending);
  } else if (sort === SortOrder.Descending) {
    rows.sort(descending);
  }
  return rows;
}

function ascending(a: TooltipRow, b: TooltipRow): number {
  return a.numeric - b.numeric;
}

function descending(a: TooltipRow, b: TooltipRow): number {
  return b.numeric - a.numeric;
}

export interface Placement {
  x: number;
  y: number;
}

/**
 * Top-left corner of a tooltip anchored at a viewport point: right of and below the anchor,
 * flipped when it does not fit, then clamped into the viewport. Writes into `out`.
 */
export function placeTooltip(
  anchorX: number,
  anchorY: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  offset: number,
  out: Placement
): Placement {
  let x = anchorX + offset;
  if (x + width > viewportWidth && anchorX - offset - width >= 0) {
    x = anchorX - offset - width;
  }
  let y = anchorY + offset;
  if (y + height > viewportHeight && anchorY - offset - height >= 0) {
    y = anchorY - offset - height;
  }
  out.x = Math.round(Math.max(0, Math.min(x, viewportWidth - width)));
  out.y = Math.round(Math.max(0, Math.min(y, viewportHeight - height)));
  return out;
}
