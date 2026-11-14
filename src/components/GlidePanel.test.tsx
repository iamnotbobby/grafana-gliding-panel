import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import {
  createDataFrame,
  dateTime,
  EventBusSrv,
  FieldType,
  getDefaultTimeRange,
  LoadingState,
  PanelData,
  PanelProps,
  TimeRange,
} from '@grafana/data';
import { LegendDisplayMode, SortOrder, TooltipDisplayMode } from '@grafana/schema';

import { EngineData, GlideEngine } from '../engine/api';
import { defaultGlideSettings, GlideOptions } from '../types';
import { GlidePanel } from './GlidePanel';

interface FakeEngine extends GlideEngine {
  setData: jest.Mock;
  setHidden: jest.Mock;
  setStyle: jest.Mock;
  resize: jest.Mock;
  setPointer: jest.Mock;
  destroy: jest.Mock;
}

const engines: FakeEngine[] = [];

jest.mock('../engine/engine', () => ({
  createEngine: () => {
    const engine: FakeEngine = {
      resize: jest.fn(),
      setStyle: jest.fn(),
      setData: jest.fn(),
      setHidden: jest.fn(),
      setPointer: jest.fn(),
      setExternalCursor: jest.fn(),
      onHover: null,
      onCursorMove: null,
      timeAtX: (x: number) => x * 1000,
      plotRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      animating: false,
      destroy: jest.fn(),
    };
    engines.push(engine);
    return engine;
  },
}));

// jsdom has no layout, so VizLayout would measure the legend as 0 px and never render the chart.
jest.mock('react-use', () => ({
  ...jest.requireActual('react-use'),
  useMeasure: () => [jest.fn(), { width: 200, height: 60, x: 0, y: 0, top: 0, left: 0, bottom: 60, right: 200 }],
}));

const NOW = 1_700_000_000_000;

function relativeRange(): TimeRange {
  return { from: dateTime(NOW - 300_000), to: dateTime(NOW - 6000), raw: { from: 'now-5m', to: 'now-6s' } };
}

function panelData(
  state: LoadingState,
  values: number[][] = [
    [1, 2, 3],
    [4, 5, 6],
  ]
): PanelData {
  const fields = [{ name: 'time', type: FieldType.time, values: [NOW - 8000, NOW - 7000, NOW - 6000] }];
  values.forEach((v, i) => fields.push({ name: `s${i}`, type: FieldType.number, values: v }));
  return { state, series: values.length ? [createDataFrame({ fields })] : [], timeRange: relativeRange() };
}

const options: GlideOptions = {
  legend: {
    showLegend: true,
    displayMode: LegendDisplayMode.Table,
    placement: 'bottom',
    calcs: ['mean', 'max', 'lastNotNull'],
  },
  tooltip: { mode: TooltipDisplayMode.Multi, sort: SortOrder.Descending, hideZeros: true, maxHeight: 300 },
  glide: defaultGlideSettings,
};

function props(data: PanelData, overrides: Partial<PanelProps<GlideOptions>> = {}): PanelProps<GlideOptions> {
  return {
    id: 1,
    title: 'Hosts',
    data,
    timeRange: getDefaultTimeRange(),
    timeZone: 'utc',
    options,
    fieldConfig: { defaults: {}, overrides: [] },
    transparent: false,
    width: 800,
    height: 400,
    renderCounter: 0,
    eventBus: new EventBusSrv(),
    replaceVariables: (s: string) => s,
    onOptionsChange: jest.fn(),
    onFieldConfigChange: jest.fn(),
    onChangeTimeRange: jest.fn(),
    ...overrides,
  };
}

describe('GlidePanel', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    engines.length = 0;
    errorSpy = jest.spyOn(console, 'error');
    warnSpy = jest.spyOn(console, 'warn');
  });

  afterEach(() => {
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('creates one engine and hands it the model, the time window and the style', () => {
    const { unmount } = render(<GlidePanel {...props(panelData(LoadingState.Done))} />);
    expect(engines).toHaveLength(1);
    const engine = engines[0];
    expect(engine.resize).toHaveBeenCalled();
    expect(engine.setStyle).toHaveBeenCalledWith(expect.objectContaining({ timeZone: 'utc' }));
    expect(engine.setData).toHaveBeenCalledTimes(1);
    const data: EngineData = engine.setData.mock.calls[0][0];
    expect(data.model.series.map((s) => s.key)).toEqual(['s0', 's1']);
    expect(data.window).toEqual(
      expect.objectContaining({ from: NOW - 300_000, to: NOW - 6000, relative: true, rawKey: 'now-5m|now-6s' })
    );
    unmount();
    expect(engine.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps the last result while a refresh is loading and takes the next settled one', () => {
    const first = panelData(LoadingState.Done);
    const { rerender } = render(<GlidePanel {...props(first)} />);
    const engine = engines[0];
    rerender(<GlidePanel {...props({ ...first, state: LoadingState.Loading })} />);
    expect(engine.setData).toHaveBeenCalledTimes(1);
    rerender(
      <GlidePanel
        {...props(
          panelData(LoadingState.Done, [
            [7, 8, 9],
            [1, 1, 1],
          ])
        )}
      />
    );
    expect(engine.setData).toHaveBeenCalledTimes(2);
    expect(engines).toHaveLength(1);
  });

  it('shows the legend table with values computed from the data', () => {
    render(<GlidePanel {...props(panelData(LoadingState.Done))} />);
    expect(screen.getByText('s0')).toBeInTheDocument();
    expect(screen.getByText('s1')).toBeInTheDocument();
    // Mean of s1 is 5, last is 6 (no display processor here, so Grafana's one-decimal fallback).
    expect(screen.getAllByText('5.0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('6.0').length).toBeGreaterThan(0);
  });

  it('isolates a series on legend click when the host does not persist visibility', () => {
    render(<GlidePanel {...props(panelData(LoadingState.Done))} />);
    const engine = engines[0];
    act(() => {
      fireEvent.click(screen.getByText('s0'));
    });
    const hidden: ReadonlySet<string> = engine.setHidden.mock.calls[engine.setHidden.mock.calls.length - 1][0];
    expect([...hidden]).toEqual(['s1']);
  });

  it('updates the legend sort through the panel options', () => {
    const onOptionsChange = jest.fn();
    render(<GlidePanel {...props(panelData(LoadingState.Done), { onOptionsChange })} />);
    act(() => {
      fireEvent.click(screen.getByText('Max'));
    });
    expect(onOptionsChange).toHaveBeenCalledWith(
      expect.objectContaining({ legend: expect.objectContaining({ sortBy: 'Max', sortDesc: true }) })
    );
  });

  it('forwards the pointer to the engine', () => {
    const { container } = render(<GlidePanel {...props(panelData(LoadingState.Done))} />);
    const canvas = container.querySelector('canvas')!;
    fireEvent.mouseMove(canvas, { clientX: 20, clientY: 30 });
    expect(engines[0].setPointer).toHaveBeenLastCalledWith(20, 30);
    fireEvent.mouseLeave(canvas.parentElement!);
    expect(engines[0].setPointer).toHaveBeenLastCalledWith(null, null);
  });

  it('zooms to the dragged span', () => {
    const onChangeTimeRange = jest.fn();
    const { container } = render(<GlidePanel {...props(panelData(LoadingState.Done), { onChangeTimeRange })} />);
    const canvas = container.querySelector('canvas')!;
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 10 });
    fireEvent.mouseUp(window, { clientX: 40, clientY: 10 });
    expect(onChangeTimeRange).toHaveBeenCalledWith({ from: 10_000, to: 40_000 });
  });

  it('creates no engine before the first result arrives', () => {
    const { container } = render(<GlidePanel {...props(panelData(LoadingState.Loading, []))} />);
    expect(engines).toHaveLength(0);
    expect(container.querySelector('canvas')).toBeNull();
  });
});
