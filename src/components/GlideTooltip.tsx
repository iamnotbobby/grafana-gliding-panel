import { css } from '@emotion/css';
import React, { memo, useCallback, useLayoutEffect, useSyncExternalStore } from 'react';

import { dateTimeFormat, GrafanaTheme2 } from '@grafana/data';
import {
  Portal,
  useStyles2,
  VizTooltipContent,
  VizTooltipHeader,
  VizTooltipItem,
  VizTooltipRow,
  VizTooltipWrapper,
} from '@grafana/ui';

import { TooltipStore } from './tooltipStore';

const NO_ITEMS: VizTooltipItem[] = [];

interface RowProps {
  label: string;
  value: string;
  color: string;
  active: boolean;
  scrollable: boolean;
}

/** Memoized so only the rows whose value changed render again while the chart glides. */
const Row = memo(function Row({ label, value, color, active, scrollable }: RowProps) {
  return <VizTooltipRow label={label} value={value} color={color} isActive={active} showValueScroll={!scrollable} />;
});

export interface GlideTooltipProps {
  store: TooltipStore;
  timeZone: string;
  /** Show milliseconds in the header (sub-second data). */
  showMs: boolean;
  maxHeight?: number;
  maxWidth?: number;
}

/** The only component that renders on hover changes. The store positions it. */
export const GlideTooltip = memo(function GlideTooltip({
  store,
  timeZone,
  showMs,
  maxHeight,
  maxWidth,
}: GlideTooltipProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const styles = useStyles2(getStyles);

  const setElement = useCallback(
    (el: HTMLDivElement | null) => {
      store.setTooltipElement(el);
    },
    [store]
  );

  // The size may have changed with the content: measure and place before the browser paints.
  useLayoutEffect(() => {
    store.measure();
  });

  if (snapshot === null) {
    return null;
  }

  const scrollable = snapshot.multi && maxHeight != null;
  const header: VizTooltipItem = {
    label: '',
    value: dateTimeFormat(snapshot.time, { timeZone, defaultWithMS: showMs }),
  };

  return (
    <Portal>
      <div ref={setElement} className={styles.tooltip} style={{ maxWidth }} role="tooltip">
        <VizTooltipWrapper>
          <VizTooltipHeader item={header} />
          {snapshot.rows.length > 0 && (
            <VizTooltipContent items={NO_ITEMS} scrollable={scrollable} maxHeight={maxHeight}>
              {snapshot.rows.map((row) => (
                <Row
                  key={row.key}
                  label={row.label}
                  value={row.value}
                  color={row.color}
                  active={row.active}
                  scrollable={scrollable}
                />
              ))}
            </VizTooltipContent>
          )}
        </VizTooltipWrapper>
      </div>
    </Portal>
  );
});

const getStyles = (theme: GrafanaTheme2) => ({
  // Same look as the tooltip container of the built-in panels.
  tooltip: css({
    position: 'fixed',
    top: 0,
    left: 0,
    zIndex: theme.zIndex.tooltip,
    whiteSpace: 'pre',
    borderRadius: theme.shape.radius.lg,
    background: theme.colors.background.elevated,
    border: `1px solid ${theme.colors.border.weak}`,
    boxShadow: theme.shadows.z2,
    pointerEvents: 'none',
    willChange: 'transform',
  }),
});
