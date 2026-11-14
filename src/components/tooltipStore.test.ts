import { SortOrder, TooltipDisplayMode } from '@grafana/schema';

import { HoverInfo, HoverItem } from '../engine/api';
import { TooltipStore } from './tooltipStore';

function item(key: string, value: number, nearest = false): HoverItem {
  return { key, name: key, color: 'c', value, text: `${value}`, nearest };
}

function info(time: number, items: HoverItem[], local = true): HoverInfo {
  return { time, x: 10, y: 10, items, local };
}

function setup(mode = TooltipDisplayMode.Multi) {
  const store = new TooltipStore();
  store.configure({ mode, sort: SortOrder.None, hideZeros: false });
  let renders = 0;
  store.subscribe(() => renders++);
  return { store, renders: () => renders };
}

describe('TooltipStore', () => {
  it('notifies only when the content changes', () => {
    const { store, renders } = setup();
    const hover = info(1000, [item('a', 1), item('b', 2)]);
    store.update(hover, false);
    expect(renders()).toBe(1);
    store.update(info(1000, [item('a', 1), item('b', 2)]), false);
    expect(renders()).toBe(1);
    store.update(info(2000, [item('a', 1), item('b', 2)]), false);
    expect(renders()).toBe(2);
    expect(store.getSnapshot()?.rows.map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('copies the items, so the engine may reuse its hover object', () => {
    const { store } = setup();
    const hover = info(1000, [item('a', 1)]);
    store.update(hover, false);
    hover.items[0].value = 99;
    hover.items[0].text = '99';
    expect(store.getSnapshot()?.rows[0].value).toBe('1');
    store.update(hover, false);
    expect(store.getSnapshot()?.rows[0].value).toBe('99');
  });

  it('lists all series for a shared cursor even in single mode', () => {
    const { store } = setup(TooltipDisplayMode.Single);
    store.update(info(1000, [item('a', 1, true), item('b', 2)]), false);
    expect(store.getSnapshot()?.rows.map((r) => r.key)).toEqual(['a']);
    store.update(info(1000, [item('a', 1, true), item('b', 2)], false), true);
    expect(store.getSnapshot()?.rows.map((r) => r.key)).toEqual(['a', 'b']);
    expect(store.getSnapshot()?.multi).toBe(true);
  });

  it('shows nothing in mode none, and hides on null or when the pointer leaves', () => {
    const { store } = setup();
    store.update(info(1000, [item('a', 1)]), false);
    store.clearPointer();
    expect(store.getSnapshot()).toBeNull();
    store.update(info(1000, [item('a', 1)]), false);
    store.update(null, false);
    expect(store.getSnapshot()).toBeNull();
    store.configure({ mode: TooltipDisplayMode.None, sort: SortOrder.None, hideZeros: false });
    store.update(info(1000, [item('a', 1)]), false);
    expect(store.getSnapshot()).toBeNull();
  });

  it('applies new settings to the visible tooltip', () => {
    const { store } = setup();
    store.update(info(1000, [item('a', 1), item('b', 2)]), false);
    store.configure({ mode: TooltipDisplayMode.Multi, sort: SortOrder.Descending, hideZeros: false });
    expect(store.getSnapshot()?.rows.map((r) => r.key)).toEqual(['b', 'a']);
  });
});
