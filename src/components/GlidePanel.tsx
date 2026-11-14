import React, { useCallback, useMemo, useState } from 'react';

import { LoadingState, PanelData, PanelProps } from '@grafana/data';
import { PanelDataErrorView } from '@grafana/runtime';
import { VizLegendOptions } from '@grafana/schema';
import { usePanelContext, useTheme2, VizLayout, VizLegendItem } from '@grafana/ui';

import { buildLegendItems, hasLegendSeries, nextHiddenKeys, nextLegendSort, shouldShowLegend } from '../data/legend';
import { buildModel, ColorRegistry } from '../data/model';
import { isSettled } from '../data/timeWindow';
import { defaultGlideSettings, GlideOptions, GlideSettings } from '../types';
import { GlideChart } from './GlideChart';
import { GlideLegend } from './GlideLegend';

const NONE_HIDDEN: ReadonlySet<string> = new Set<string>();

export const GlidePanel: React.FC<PanelProps<GlideOptions>> = ({
  id,
  title,
  data,
  timeRange,
  timeZone,
  width,
  height,
  options,
  fieldConfig,
  eventBus,
  onOptionsChange,
  onChangeTimeRange,
}) => {
  const theme = useTheme2();
  const { sync, eventsScope, onToggleSeriesVisibility, onSelectRange } = usePanelContext();

  const [colors] = useState(() => new ColorRegistry());

  // Loading states keep showing the last settled result (state derived during render).
  const [settled, setSettled] = useState<PanelData | null>(() => (isSettled(data.state) ? data : null));
  if (data !== settled && isSettled(data.state)) {
    setSettled(data);
  }

  const model = useMemo(
    () => (settled === null ? null : buildModel(settled.series, theme, colors, settled.request?.intervalMs)),
    // No fieldConfig dependency: Grafana hands over new data when the field config changes.
    [settled, theme, colors]
  );

  // Hosts that support it persist series visibility as a field override; otherwise it is local.
  const persistVisibility = onToggleSeriesVisibility !== undefined;
  const [localHidden, setLocalHidden] = useState<ReadonlySet<string>>(NONE_HIDDEN);
  const hidden = persistVisibility ? NONE_HIDDEN : localHidden;

  const legend: VizLegendOptions | undefined = options.legend;
  const calcs = legend?.calcs;
  const legendItems = useMemo(
    () => (model === null ? [] : buildLegendItems(model.series, calcs, theme, hidden)),
    [model, calcs, theme, hidden]
  );

  const allKeys = useMemo(
    () => (model === null ? [] : model.series.filter((s) => !s.hidden).map((s) => s.key)),
    [model]
  );

  const onLabelClick = useCallback(
    (item: VizLegendItem, event: React.MouseEvent<HTMLButtonElement>) => {
      const key = item.getItemKey?.() ?? item.label;
      const append = event.ctrlKey || event.metaKey || event.shiftKey;
      setLocalHidden((prev) => nextHiddenKeys(allKeys, prev, key, append));
    },
    [allKeys]
  );

  const onToggleSort = useCallback(
    (sortKey: string) => {
      if (legend === undefined) {
        return;
      }
      onOptionsChange({ ...options, legend: { ...legend, ...nextLegendSort(legend, sortKey) } });
    },
    [legend, options, onOptionsChange]
  );

  const glide = useMemo<GlideSettings>(() => ({ ...defaultGlideSettings, ...options.glide }), [options.glide]);

  const onZoom = useCallback(
    (from: number, to: number) => {
      if (onSelectRange) {
        onSelectRange([{ x: { from, to } }]);
      } else {
        onChangeTimeRange({ from, to });
      }
    },
    [onSelectRange, onChangeTimeRange]
  );

  if (model === null || settled === null) {
    if (data.state === LoadingState.Error) {
      return <PanelDataErrorView panelId={id} fieldConfig={fieldConfig} data={data} />;
    }
    return null;
  }

  if (model.series.length === 0) {
    return (
      <PanelDataErrorView
        panelId={id}
        fieldConfig={fieldConfig}
        data={settled}
        needsTimeField={true}
        needsNumberField={true}
      />
    );
  }

  const legendElement =
    legend !== undefined && shouldShowLegend(legend) && hasLegendSeries(model.series) ? (
      <VizLayout.Legend placement={legend.placement} width={legend.width}>
        <GlideLegend
          items={legendItems}
          options={legend}
          onToggleSort={onToggleSort}
          onLabelClick={persistVisibility ? undefined : onLabelClick}
        />
      </VizLayout.Legend>
    ) : null;

  return (
    <VizLayout width={width} height={height} legend={legendElement}>
      {(vizWidth: number, vizHeight: number) => (
        <GlideChart
          width={vizWidth}
          height={vizHeight}
          model={model}
          panelData={settled}
          fallbackRange={timeRange}
          theme={theme}
          timeZone={timeZone}
          glide={glide}
          hidden={hidden}
          tooltip={options.tooltip}
          eventBus={eventBus}
          sync={sync}
          syncKey={eventsScope}
          onZoom={onZoom}
          title={title}
        />
      )}
    </VizLayout>
  );
};
