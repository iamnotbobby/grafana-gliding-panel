import {
  DisplayProcessor,
  DisplayValue,
  Field,
  fieldReducers,
  getDisplayProcessor,
  GrafanaTheme2,
  ReducerID,
  reduceField,
} from '@grafana/data';
import { VizLegendOptions } from '@grafana/schema';
import { VizLegendItem } from '@grafana/ui';

import { SeriesModel } from './model';

const NO_VALUES: DisplayValue[] = [];

const fallbackFormatter: DisplayProcessor = (value) => {
  const numeric = typeof value === 'number' ? value : NaN;
  return { text: numeric === numeric ? numeric.toFixed(1) : '-', numeric };
};

/**
 * Legend statistics like the built-in time series panel: Grafana's reducers on the original
 * values, formatted with the field's display processor; percent difference and counts get their
 * own units, as upstream.
 */
export function getLegendDisplayValues(
  calcs: readonly string[] | undefined,
  field: Field,
  theme: GrafanaTheme2
): DisplayValue[] {
  if (!calcs || calcs.length === 0) {
    return NO_VALUES;
  }
  const known = calcs.filter((id) => fieldReducers.getIfExists(id) !== undefined);
  if (known.length === 0) {
    return NO_VALUES;
  }

  const fmt = field.display ?? fallbackFormatter;
  const fieldCalcs = reduceField({ field, reducers: known });
  let countFormatter: DisplayProcessor | null = null;

  return known.map((id) => {
    const reducer = fieldReducers.get(id);
    let formatter = fmt;

    if (reducer.id === ReducerID.diffperc) {
      formatter = getDisplayProcessor({
        field: { ...field, config: { ...field.config, unit: 'percent' } },
        theme,
      });
    } else if (
      reducer.id === ReducerID.count ||
      reducer.id === ReducerID.changeCount ||
      reducer.id === ReducerID.distinctCount
    ) {
      countFormatter =
        countFormatter ??
        getDisplayProcessor({
          field: { ...field, config: { ...field.config, unit: 'none' } },
          theme,
        });
      formatter = countFormatter;
    }

    return {
      ...formatter(fieldCalcs[id]),
      title: reducer.name,
      description: reducer.description,
    };
  });
}

/** One entry per series not hidden from the legend, with its statistics computed once. */
export function buildLegendItems(
  series: readonly SeriesModel[],
  calcs: readonly string[] | undefined,
  theme: GrafanaTheme2,
  locallyHidden: ReadonlySet<string>
): VizLegendItem[] {
  const items: VizLegendItem[] = [];
  for (const s of series) {
    if (s.hideFromLegend) {
      continue;
    }
    const values = getLegendDisplayValues(calcs, s.field, theme);
    const key = s.key;
    items.push({
      label: s.name,
      color: s.color,
      yAxis: 1,
      disabled: s.hidden || locallyHidden.has(key),
      fieldIndex: s.field.state?.origin,
      getItemKey: () => key,
      getDisplayValues: () => values,
    });
  }
  return items;
}

export function shouldShowLegend(legend: Pick<VizLegendOptions, 'showLegend' | 'displayMode'>): boolean {
  // "hidden" is the deprecated LegendDisplayMode.Hidden, still found in older dashboards.
  return legend.showLegend !== false && String(legend.displayMode) !== 'hidden';
}

export function hasLegendSeries(series: readonly SeriesModel[]): boolean {
  for (const s of series) {
    if (!s.hideFromLegend) {
      return true;
    }
  }
  return false;
}

/** Legend table header click: descending, ascending, unsorted, like Grafana. */
export function nextLegendSort(
  legend: Pick<VizLegendOptions, 'sortBy' | 'sortDesc'>,
  sortKey: string
): Pick<VizLegendOptions, 'sortBy' | 'sortDesc'> {
  let sortDesc = legend.sortDesc;
  let sortBy = legend.sortBy;
  if (sortKey !== sortBy) {
    sortDesc = undefined;
  }
  if (sortDesc === false) {
    sortBy = undefined;
    sortDesc = undefined;
  } else {
    sortDesc = !sortDesc;
    sortBy = sortKey;
  }
  return { sortBy, sortDesc };
}

/**
 * Grafana's legend click, for hosts that do not persist series visibility: a plain click isolates
 * the series (or shows all again when it already is), Ctrl, Cmd or Shift toggles just that one.
 */
export function nextHiddenKeys(
  allKeys: readonly string[],
  hidden: ReadonlySet<string>,
  key: string,
  append: boolean
): Set<string> {
  const next = new Set<string>();

  if (append) {
    for (const k of allKeys) {
      if (hidden.has(k) !== (k === key)) {
        next.add(k);
      }
    }
    // Hiding the last visible series would leave an empty chart; show everything instead.
    if (next.size >= allKeys.length) {
      next.clear();
    }
    return next;
  }

  let visibleCount = 0;
  for (const k of allKeys) {
    if (!hidden.has(k)) {
      visibleCount++;
    }
  }
  const alreadyIsolated = visibleCount === 1 && !hidden.has(key);
  if (!alreadyIsolated) {
    for (const k of allKeys) {
      if (k !== key) {
        next.add(k);
      }
    }
  }
  return next;
}
