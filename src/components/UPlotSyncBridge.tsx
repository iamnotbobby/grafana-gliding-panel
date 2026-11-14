import { css } from '@emotion/css';
import React, { memo, useMemo, useRef } from 'react';
import type uPlot from 'uplot';

import { ScaleDirection, ScaleOrientation } from '@grafana/schema';
import { UPlotChart, UPlotConfigBuilder } from '@grafana/ui';

export interface SyncBridgeHandle {
  /** Shares the time under the local pointer (relY: pointer height in the plot, 0..1); null clears. */
  publish(timeMs: number | null, relY: number): void;
}

export interface UPlotSyncBridgeProps {
  /** The panel context's eventsScope. */
  syncKey: string;
  /** Crosshair of another panel (time and relative height), or null when it left. */
  onExternal: (timeMs: number | null, relY: number) => void;
  /** Receives the handle once connected, and null when it is gone. */
  onReady: (handle: SyncBridgeHandle | null) => void;
}

/** Year 2100: the time scale covers every epoch ms a panel can show. */
const MAX_TIME = 4_102_444_800_000;
// Leaves a positive plot area after Grafana's default chart padding.
const WIDTH = 400;
const HEIGHT = 100;

type SetCursorWithPublish = (opts: { left: number; top: number }, fireHook?: boolean, publish?: boolean) => void;
const DATA: uPlot.AlignedData = [[0, MAX_TIME]];

/** An invisible uPlot chart that joins the uPlot cursor sync of Grafana's built-in panels. */
export const UPlotSyncBridge = memo(function UPlotSyncBridge({ syncKey, onExternal, onReady }: UPlotSyncBridgeProps) {
  const externalRef = useRef(onExternal);
  const readyRef = useRef(onReady);
  externalRef.current = onExternal;
  readyRef.current = onReady;

  const config = useMemo(() => {
    let plot: uPlot | null = null;
    let publishing = false;
    let shown = false;

    const builder = new UPlotConfigBuilder();
    builder.addScale({
      scaleKey: 'x',
      isTime: true,
      orientation: ScaleOrientation.Horizontal,
      direction: ScaleDirection.Right,
      range: () => [0, MAX_TIME],
    });
    builder.setCursor({
      sync: { key: syncKey, scales: ['x', null] },
      points: { show: false },
      drag: { x: false, y: false, setScale: false },
    });
    builder.addHook('init', (u: uPlot) => {
      plot = u;
      readyRef.current({
        publish(timeMs, relY) {
          const p = plot;
          if (p === null) {
            return;
          }
          if (timeMs === null) {
            if (!shown) {
              return;
            }
            shown = false;
          } else {
            shown = true;
          }
          const h = p.over.clientHeight || HEIGHT;
          publishing = true;
          try {
            // The third argument (publish to the sync group) exists at runtime but is missing
            // from uPlot's type declarations.
            (p.setCursor as SetCursorWithPublish)(
              timeMs === null
                ? { left: -10, top: -10 }
                : { left: p.valToPos(timeMs, 'x'), top: Math.min(1, Math.max(0, relY)) * h },
              false,
              true
            );
          } finally {
            publishing = false;
          }
        },
      });
    });
    // Positions published by other panels arrive as cursor updates without a mouse event.
    builder.addHook('setCursor', (u: uPlot) => {
      if (publishing || u.cursor.event != null) {
        return;
      }
      const left = u.cursor.left;
      const top = u.cursor.top;
      if (left == null || top == null || left < 0 || top < 0) {
        externalRef.current(null, 0.5);
        return;
      }
      const h = u.over.clientHeight || HEIGHT;
      externalRef.current(u.posToVal(left, 'x'), top / h);
    });
    builder.addHook('destroy', () => {
      plot = null;
      readyRef.current(null);
    });
    return builder;
  }, [syncKey]);

  return (
    <div className={hidden} aria-hidden="true">
      <UPlotChart config={config} data={DATA} width={WIDTH} height={HEIGHT} />
    </div>
  );
});

const hidden = css({
  position: 'absolute',
  left: 0,
  top: 0,
  width: 0,
  height: 0,
  overflow: 'hidden',
  visibility: 'hidden',
  pointerEvents: 'none',
});
