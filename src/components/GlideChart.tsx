import { css } from '@emotion/css';
import React, { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';

import { DashboardCursorSync, EventBus, GrafanaTheme2, PanelData, TimeRange } from '@grafana/data';
import { SortOrder, TooltipDisplayMode, VizTooltipOptions } from '@grafana/schema';
import { useStyles2 } from '@grafana/ui';

import { GlideModel } from '../data/model';
import { buildTimeWindow, detectRefreshMs } from '../data/timeWindow';
import { EngineData, GlideEngine, HoverInfo } from '../engine/api';
import { createEngine } from '../engine/engine';
import { GlideSettings } from '../types';
import { CursorSync } from './cursorSync';
import { DragZoom } from './dragZoom';
import { GlideTooltip } from './GlideTooltip';
import { SyncBridgeHandle, UPlotSyncBridge } from './UPlotSyncBridge';
import { TooltipStore } from './tooltipStore';

export interface GlideChartProps {
  width: number;
  height: number;
  model: GlideModel;
  /** The settled query result the model was built from. */
  panelData: PanelData;
  /** Dashboard time range, used when the result carries no usable range of its own. */
  fallbackRange: TimeRange;
  theme: GrafanaTheme2;
  timeZone: string;
  glide: GlideSettings;
  hidden: ReadonlySet<string>;
  tooltip: VizTooltipOptions | undefined;
  eventBus: EventBus;
  sync: (() => DashboardCursorSync) | undefined;
  /** uPlot cursor sync key of the built-in panels (the panel context's eventsScope). */
  syncKey: string | undefined;
  onZoom: (from: number, to: number) => void;
  title: string;
}

function usableRange(range: TimeRange | undefined, fallback: TimeRange): TimeRange {
  if (range != null && range.from != null && range.to != null) {
    const from = range.from.valueOf();
    const to = range.to.valueOf();
    if (isFinite(from) && isFinite(to) && to > from) {
      return range;
    }
  }
  return fallback;
}

function currentSync(source: (() => DashboardCursorSync) | undefined): DashboardCursorSync {
  return source !== undefined ? source() : DashboardCursorSync.Off;
}

/** The canvas and everything that talks to the engine. Never renders on hover. */
export const GlideChart = memo(function GlideChart(props: GlideChartProps) {
  const { width, height, model, panelData, fallbackRange, theme, timeZone, glide, hidden, tooltip, eventBus } = props;
  const styles = useStyles2(getStyles);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<GlideEngine | null>(null);
  const [store] = useState(() => new TooltipStore());
  const [cursor] = useState(() => new CursorSync());
  const [drag] = useState(() => new DragZoom());

  const publishingRef = useRef(false);
  const bridgeRef = useRef<SyncBridgeHandle | null>(null);
  const lastDataRef = useRef<{ source: PanelData; data: EngineData } | null>(null);
  // Latest props, for engine callbacks.
  const syncRef = useRef(props.sync);
  const fallbackRangeRef = useRef(fallbackRange);

  useLayoutEffect(() => {
    syncRef.current = props.sync;
    fallbackRangeRef.current = fallbackRange;
    drag.setHandler(props.onZoom);
  });

  const stopPublishing = useCallback(() => {
    bridgeRef.current?.publish(null, 0.5);
    if (publishingRef.current) {
      publishingRef.current = false;
      cursor.clear();
    }
  }, [cursor]);

  const showExternal = useCallback((time: number | null, relY?: number) => {
    engineRef.current?.setExternalCursor(time, relY);
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const engine = createEngine(canvas);
    engineRef.current = engine;
    store.setAnchorElement(canvas);
    drag.attach(engine, canvas);
    cursor.setModeSource(() => currentSync(syncRef.current));
    cursor.setExternalHandler(showExternal);

    engine.onCursorMove = (time: number | null, relY: number) => {
      if (time === null) {
        stopPublishing();
        return;
      }
      bridgeRef.current?.publish(time, relY);
      cursor.hover(time, relY);
      publishingRef.current = true;
    };

    engine.onHover = (info: HoverInfo | null) => {
      if (info !== null && info.local) {
        store.update(info, false);
        return;
      }
      // Like the built-in panel: a shared cursor lists all series, and only with a shared tooltip.
      const shareTooltip = info !== null && currentSync(syncRef.current) === DashboardCursorSync.Tooltip;
      store.update(shareTooltip ? info : null, true);
    };

    return () => {
      engine.onHover = null;
      engine.onCursorMove = null;
      cursor.setExternalHandler(null);
      cursor.clear();
      drag.attach(null, null);
      store.update(null, false);
      store.setAnchorElement(null);
      engineRef.current = null;
      lastDataRef.current = null;
      engine.destroy();
    };
  }, [store, cursor, drag, stopPublishing, showExternal]);

  useLayoutEffect(() => {
    cursor.connect(eventBus);
    return () => cursor.disconnect();
  }, [cursor, eventBus]);

  useLayoutEffect(() => {
    engineRef.current?.resize(Math.max(0, width), Math.max(0, height));
  }, [width, height]);

  useLayoutEffect(() => {
    engineRef.current?.setStyle({ theme, timeZone, glide });
  }, [theme, timeZone, glide]);

  useLayoutEffect(() => {
    engineRef.current?.setHidden(hidden);
  }, [hidden]);

  useLayoutEffect(() => {
    const engine = engineRef.current;
    if (engine === null) {
      return;
    }
    const last = lastDataRef.current;
    let data: EngineData;
    if (last !== null && last.source === panelData) {
      // Same query result with a rebuilt model (theme or field config change): keep its timing.
      data = { ...last.data, model };
    } else {
      const range = usableRange(panelData.timeRange, fallbackRangeRef.current);
      data = {
        model,
        window: buildTimeWindow(range, panelData.request?.startTime, Date.now()),
        receivedAt: performance.now(),
        refreshMs: detectRefreshMs(),
      };
    }
    lastDataRef.current = { source: panelData, data };
    engine.setData(data);
    // No fallbackRange dependency: a new dashboard range object alone is not new data.
  }, [model, panelData]);

  const mode = tooltip?.mode ?? TooltipDisplayMode.Single;
  const sort = tooltip?.sort ?? SortOrder.None;
  const hideZeros = !!tooltip?.hideZeros;
  useLayoutEffect(() => {
    store.configure({ mode, sort, hideZeros });
  }, [store, mode, sort, hideZeros]);

  const onMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const canvas = canvasRef.current;
      const engine = engineRef.current;
      if (canvas === null || engine === null) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      engine.setPointer(event.clientX - rect.left, event.clientY - rect.top);
      store.setPointer(event.clientX, event.clientY);
    },
    [store]
  );

  const onMouseLeave = useCallback(() => {
    engineRef.current?.setPointer(null, null);
    store.clearPointer();
    stopPublishing();
  }, [store, stopPublishing]);

  const onMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (drag.begin(event.clientX, event.clientY, event.button)) {
        event.preventDefault();
      }
    },
    [drag]
  );

  const onBridgeReady = useCallback(
    (handle: SyncBridgeHandle | null) => {
      bridgeRef.current = handle;
      cursor.setBridged(handle !== null);
    },
    [cursor]
  );
  const bridgeKey = currentSync(props.sync) !== DashboardCursorSync.Off ? props.syncKey : undefined;

  const setOverlay = useCallback((el: HTMLDivElement | null) => drag.setOverlay(el), [drag]);

  return (
    <div
      className={styles.wrapper}
      style={{ width, height }}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onMouseDown={onMouseDown}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        style={{ width, height }}
        role="img"
        aria-label={props.title ? `${props.title} chart` : 'Time series chart'}
      />
      <div ref={setOverlay} className={styles.selection} aria-hidden="true" />
      {bridgeKey !== undefined && (
        <UPlotSyncBridge syncKey={bridgeKey} onExternal={showExternal} onReady={onBridgeReady} />
      )}
      <GlideTooltip
        store={store}
        timeZone={timeZone}
        showMs={model.stepMs < 1000}
        maxHeight={tooltip?.maxHeight}
        maxWidth={tooltip?.maxWidth}
      />
    </div>
  );
});

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css({
    position: 'relative',
    overflow: 'hidden',
    userSelect: 'none',
  }),
  canvas: css({
    display: 'block',
    position: 'absolute',
    top: 0,
    left: 0,
  }),
  selection: css({
    display: 'none',
    position: 'absolute',
    pointerEvents: 'none',
    background: theme.colors.action.selected,
    borderLeft: `1px solid ${theme.colors.border.medium}`,
    borderRight: `1px solid ${theme.colors.border.medium}`,
  }),
});
