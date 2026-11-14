import {
  createDataFrame,
  createTheme,
  Field,
  FieldType,
  formattedValueToString,
  getDisplayProcessor,
  ReducerID,
} from '@grafana/data';
import { LegendDisplayMode } from '@grafana/schema';

import {
  buildLegendItems,
  getLegendDisplayValues,
  hasLegendSeries,
  nextHiddenKeys,
  nextLegendSort,
  shouldShowLegend,
} from './legend';
import { buildModel, ColorRegistry } from './model';

const theme = createTheme();

function numberField(values: Array<number | null>, unit?: string, decimals?: number): Field {
  const frame = createDataFrame({
    fields: [
      { name: 'time', type: FieldType.time, values: values.map((_, i) => 1000 * (i + 1)) },
      { name: 'value', type: FieldType.number, values, config: { unit, decimals } },
    ],
  });
  const field = frame.fields[1];
  field.display = getDisplayProcessor({ field, theme });
  return field;
}

function texts(field: Field, calcs: string[]): string[] {
  return getLegendDisplayValues(calcs, field, theme).map((v) => formattedValueToString(v));
}

describe('getLegendDisplayValues', () => {
  it('computes the reducers on the original values and formats them with the field unit', () => {
    const field = numberField([1, null, 5, 3], 'percent', 1);
    expect(texts(field, [ReducerID.mean, ReducerID.max, ReducerID.lastNotNull, ReducerID.min])).toEqual([
      '3.0%',
      '5.0%',
      '3.0%',
      '1.0%',
    ]);
  });

  it('titles each value with the reducer name', () => {
    const field = numberField([1, 2]);
    const values = getLegendDisplayValues([ReducerID.mean, ReducerID.sum], field, theme);
    expect(values.map((v) => v.title)).toEqual(['Mean', 'Total']);
  });

  it('formats counts without the field unit and percent difference as percent', () => {
    const field = numberField([2, 4, 4], 'bytes');
    const [count, diffperc] = texts(field, [ReducerID.count, ReducerID.diffperc]);
    expect(count).toBe('3');
    expect(diffperc).toContain('%');
  });

  it('skips unknown reducer ids and returns nothing without calcs', () => {
    const field = numberField([1, 2]);
    expect(texts(field, ['nope', ReducerID.max])).toEqual(['2']);
    expect(getLegendDisplayValues([], field, theme)).toEqual([]);
    expect(getLegendDisplayValues(undefined, field, theme)).toEqual([]);
  });

  it('falls back to one decimal when the field has no display processor', () => {
    const field = numberField([1, 2]);
    delete field.display;
    expect(texts(field, [ReducerID.mean])).toEqual(['1.5']);
  });
});

describe('buildLegendItems', () => {
  const frames = [
    createDataFrame({
      fields: [
        { name: 'time', type: FieldType.time, values: [1000, 2000] },
        { name: 'a', type: FieldType.number, values: [1, 3] },
        { name: 'b', type: FieldType.number, values: [2, 4], config: { custom: { hideFrom: { legend: true } } } },
        { name: 'c', type: FieldType.number, values: [5, 6], config: { custom: { hideFrom: { viz: true } } } },
      ],
    }),
  ];
  const model = buildModel(frames, theme, new ColorRegistry(), undefined);

  // Raw frames have no display processor, so the values use Grafana's one decimal fallback.
  it('lists series not hidden from the legend, with stable keys and precomputed values', () => {
    const items = buildLegendItems(model.series, [ReducerID.max], theme, new Set(['a']));
    expect(items.map((i) => i.label)).toEqual(['a', 'c']);
    expect(items.map((i) => i.getItemKey?.())).toEqual(['a', 'c']);
    expect(items.map((i) => i.disabled)).toEqual([true, true]);
    expect(items[0].getDisplayValues?.()).toBe(items[0].getDisplayValues?.());
    expect(items[0].getDisplayValues?.().map((v) => formattedValueToString(v))).toEqual(['3.0']);
    expect(items[0].color).toBe(model.series[0].color);
  });

  it('knows whether any series is left for the legend', () => {
    expect(hasLegendSeries(model.series)).toBe(true);
    expect(hasLegendSeries(model.series.filter((s) => s.hideFromLegend))).toBe(false);
  });
});

describe('shouldShowLegend', () => {
  it('follows showLegend and the hidden display mode', () => {
    expect(shouldShowLegend({ showLegend: true, displayMode: LegendDisplayMode.Table })).toBe(true);
    expect(shouldShowLegend({ showLegend: false, displayMode: LegendDisplayMode.List })).toBe(false);
    expect(shouldShowLegend({ showLegend: true, displayMode: 'hidden' as LegendDisplayMode })).toBe(false);
  });
});

describe('nextLegendSort', () => {
  it('cycles descending, ascending, unsorted like Grafana', () => {
    let state = nextLegendSort({}, 'Max');
    expect(state).toEqual({ sortBy: 'Max', sortDesc: true });
    state = nextLegendSort(state, 'Max');
    expect(state).toEqual({ sortBy: 'Max', sortDesc: false });
    state = nextLegendSort(state, 'Max');
    expect(state).toEqual({ sortBy: undefined, sortDesc: undefined });
  });

  it('starts descending when another column is clicked', () => {
    expect(nextLegendSort({ sortBy: 'Max', sortDesc: false }, 'Mean')).toEqual({ sortBy: 'Mean', sortDesc: true });
  });
});

describe('nextHiddenKeys', () => {
  const keys = ['a', 'b', 'c'];

  it('isolates a series on a plain click and shows all again on a second click', () => {
    const isolated = nextHiddenKeys(keys, new Set(), 'b', false);
    expect([...isolated].sort()).toEqual(['a', 'c']);
    expect(nextHiddenKeys(keys, isolated, 'b', false).size).toBe(0);
  });

  it('isolates another series when one is already isolated', () => {
    expect([...nextHiddenKeys(keys, new Set(['a', 'c']), 'a', false)].sort()).toEqual(['b', 'c']);
  });

  it('toggles a single series with a modifier key', () => {
    expect([...nextHiddenKeys(keys, new Set(), 'a', true)]).toEqual(['a']);
    expect(nextHiddenKeys(keys, new Set(['a']), 'a', true).size).toBe(0);
  });

  it('shows everything instead of hiding the last visible series', () => {
    expect(nextHiddenKeys(keys, new Set(['a', 'b']), 'c', true).size).toBe(0);
  });
});
