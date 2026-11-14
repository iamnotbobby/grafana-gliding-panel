import React, { memo, useLayoutEffect, useRef } from 'react';

import { LegendDisplayMode, VizLegendOptions } from '@grafana/schema';
import { VizLegend, VizLegendItem } from '@grafana/ui';

export interface GlideLegendProps {
  items: VizLegendItem[];
  options: VizLegendOptions;
  onToggleSort: (sortBy: string) => void;
  /** Only set when the host does not handle series visibility itself. */
  onLabelClick?: (item: VizLegendItem, event: React.MouseEvent<HTMLButtonElement>) => void;
}

/** What the legend shows, apart from its values. While it stays the same, a right legend only grows. */
function legendShape(items: VizLegendItem[], options: VizLegendOptions): string {
  let key = `${options.placement}|${options.displayMode}|${(options.calcs ?? []).join(',')}|${options.width ?? ''}`;
  for (const item of items) {
    key += '\u0000' + item.label;
  }
  return key;
}

export const GlideLegend = memo(function GlideLegend({ items, options, onToggleSort, onLabelClick }: GlideLegendProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const maxWidth = useRef(0);
  const right = options.placement === 'right';
  const shape = legendShape(items, options);

  // Other series or settings may need less room.
  useLayoutEffect(() => {
    maxWidth.current = 0;
    if (ref.current !== null) {
      ref.current.style.minWidth = '';
    }
  }, [shape]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || !right || typeof ResizeObserver === 'undefined') {
      return;
    }
    const grow = () => {
      const w = el.getBoundingClientRect().width;
      if (w > maxWidth.current + 0.5) {
        maxWidth.current = w;
        el.style.minWidth = `${Math.ceil(w)}px`;
      }
    };
    grow();
    const observer = new ResizeObserver(grow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [right]);

  return (
    <div ref={ref}>
      <VizLegend
        // The table sorts the array it is given in place, so hand it a copy.
        items={items.slice()}
        placement={options.placement}
        displayMode={options.displayMode ?? LegendDisplayMode.List}
        sortBy={options.sortBy}
        sortDesc={options.sortDesc}
        isSortable={true}
        limit={options.limit}
        overflow={options.overflow}
        onToggleSort={onToggleSort}
        onLabelClick={onLabelClick}
      />
    </div>
  );
});
