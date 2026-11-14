import { DashboardCursorSync, DataHoverClearEvent, DataHoverEvent, EventBusSrv } from '@grafana/data';

import { CursorSync, HOVER_THROTTLE_MS } from './cursorSync';

function setup(mode = DashboardCursorSync.Crosshair) {
  const root = new EventBusSrv();
  const ownBus = root.newScopedBus('own', { onlyLocal: false });
  const otherBus = root.newScopedBus('other', { onlyLocal: false });
  const sync = new CursorSync();
  let current = mode;
  sync.setModeSource(() => current);
  const external: Array<number | null> = [];
  sync.setExternalHandler((t) => external.push(t));
  sync.connect(ownBus);

  const published: Array<number | null> = [];
  root.subscribe(DataHoverEvent, (e) => published.push(e.payload.point?.time ?? null));
  root.subscribe(DataHoverClearEvent, () => published.push(null));

  return {
    sync,
    otherBus,
    external,
    published,
    setMode: (m: DashboardCursorSync) => (current = m),
  };
}

describe('CursorSync', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('publishes the hovered time with the payload shape of the built-in panels', () => {
    const { sync, published } = setup();
    sync.hover(1000, 0.5);
    expect(published).toEqual([1000]);
  });

  it('publishes only changes, at most once per throttle window, and the latest value last', () => {
    const { sync, published } = setup();
    sync.hover(1000, 0.5);
    sync.hover(1000, 0.5);
    sync.hover(2000, 0.5);
    sync.hover(3000, 0.5);
    expect(published).toEqual([1000]);
    jest.advanceTimersByTime(HOVER_THROTTLE_MS);
    expect(published).toEqual([1000, 3000]);
  });

  it('clears other panels when the local hover ends, once', () => {
    const { sync, published } = setup();
    sync.hover(1000, 0.5);
    sync.clear();
    sync.clear();
    expect(published).toEqual([1000, null]);
  });

  it('ignores its own events and reports those of other panels', () => {
    const { sync, otherBus, external } = setup();
    sync.hover(1000, 0.5);
    otherBus.publish(new DataHoverEvent({ point: { time: 5000 } }));
    otherBus.publish(new DataHoverClearEvent());
    expect(external).toEqual([5000, null]);
  });

  it('ignores legend hovers, which carry no time', () => {
    const { otherBus, external } = setup();
    otherBus.publish(new DataHoverEvent({ point: {}, dataId: 'series' }));
    expect(external).toEqual([]);
  });

  it('neither publishes nor follows when the dashboard does not share the cursor', () => {
    const { sync, otherBus, external, published, setMode } = setup(DashboardCursorSync.Off);
    sync.hover(1000, 0.5);
    otherBus.publish(new DataHoverEvent({ point: { time: 5000 } }));
    expect(published).toEqual([5000]);
    expect(external).toEqual([]);
    setMode(DashboardCursorSync.Tooltip);
    otherBus.publish(new DataHoverEvent({ point: { time: 6000 } }));
    expect(external).toEqual([6000]);
  });

  it('while bridged to uPlot sync, tags its events "uplot" so the built-in panels ignore them', () => {
    const { sync } = setup();
    const tags: boolean[] = [];
    const root = new EventBusSrv();
    const bus = root.newScopedBus('own2', { onlyLocal: false });
    root.subscribe(DataHoverEvent, (e) => tags.push(!!e.tags?.has('uplot')));
    sync.connect(bus);
    sync.setBridged(true);
    sync.hover(1000, 0.5);
    sync.setBridged(false);
    jest.advanceTimersByTime(HOVER_THROTTLE_MS);
    sync.hover(2000, 0.5);
    expect(tags).toEqual([true, false]);
  });

  it('while bridged, ignores "uplot" events (the bridge delivers them) but follows other panels', () => {
    const { sync, otherBus, external } = setup();
    sync.setBridged(true);
    otherBus.publish(new DataHoverEvent({ point: { time: 5000 } }).setTags(['uplot']));
    otherBus.publish(new DataHoverEvent({ point: { time: 6000 } }));
    otherBus.publish(new DataHoverClearEvent().setTags(['uplot']));
    expect(external).toEqual([6000]);
  });

  it('stops listening after disconnect', () => {
    const { sync, otherBus, external } = setup();
    sync.disconnect();
    otherBus.publish(new DataHoverEvent({ point: { time: 5000 } }));
    expect(external).toEqual([]);
  });
});
