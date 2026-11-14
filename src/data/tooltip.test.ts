import { SortOrder, TooltipDisplayMode } from '@grafana/schema';

import { HoverItem } from '../engine/api';
import { buildTooltipRows, Placement, placeTooltip } from './tooltip';

function item(key: string, value: number, nearest = false): HoverItem {
  return { key, name: key.toUpperCase(), color: `c-${key}`, value, text: `${value}`, nearest };
}

const items = [item('a', 2), item('b', 0), item('c', NaN), item('d', 7, true), item('e', -1)];

function keys(mode: TooltipDisplayMode, sort: SortOrder, hideZeros: boolean, count = items.length): string[] {
  return buildTooltipRows(items, count, mode, sort, hideZeros).map((r) => r.key);
}

describe('buildTooltipRows', () => {
  it('lists every series with a point in multi mode, in model order', () => {
    expect(keys(TooltipDisplayMode.Multi, SortOrder.None, false)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('sorts by value', () => {
    expect(keys(TooltipDisplayMode.Multi, SortOrder.Descending, false)).toEqual(['d', 'a', 'b', 'e']);
    expect(keys(TooltipDisplayMode.Multi, SortOrder.Ascending, false)).toEqual(['e', 'b', 'a', 'd']);
  });

  it('hides exact zeros when asked', () => {
    expect(keys(TooltipDisplayMode.Multi, SortOrder.Descending, true)).toEqual(['d', 'a', 'e']);
  });

  it('keeps only the nearest series in single mode', () => {
    const rows = buildTooltipRows(items, items.length, TooltipDisplayMode.Single, SortOrder.None, false);
    expect(rows.map((r) => r.key)).toEqual(['d']);
    expect(rows[0].active).toBe(false);
  });

  it('marks the nearest series as active in multi mode', () => {
    const rows = buildTooltipRows(items, items.length, TooltipDisplayMode.Multi, SortOrder.None, false);
    expect(rows.filter((r) => r.active).map((r) => r.key)).toEqual(['d']);
    expect(rows[0]).toEqual({ key: 'a', label: 'A', value: '2', color: 'c-a', active: false, numeric: 2 });
  });

  it('shows nothing in mode none and honours the item count', () => {
    expect(keys(TooltipDisplayMode.None, SortOrder.None, false)).toEqual([]);
    expect(keys(TooltipDisplayMode.Multi, SortOrder.None, false, 2)).toEqual(['a', 'b']);
  });
});

describe('placeTooltip', () => {
  const out: Placement = { x: 0, y: 0 };

  it('sits below and to the right of the anchor when there is room', () => {
    expect(placeTooltip(100, 100, 50, 40, 1000, 800, 10, out)).toEqual({ x: 110, y: 110 });
  });

  it('flips to the left and above near the right and bottom edges', () => {
    expect(placeTooltip(980, 790, 50, 40, 1000, 800, 10, out)).toEqual({ x: 920, y: 740 });
  });

  it('is clamped into the viewport when it fits on neither side', () => {
    expect(placeTooltip(30, 30, 200, 900, 100, 800, 10, out)).toEqual({ x: 0, y: 0 });
  });

  it('writes into the given object', () => {
    expect(placeTooltip(1, 1, 1, 1, 100, 100, 0, out)).toBe(out);
  });
});
