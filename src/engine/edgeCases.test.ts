import { createDataFrame, createTheme, FieldType, applyFieldOverrides, DataFrame, ThresholdsMode } from '@grafana/data';
import { GraphTransform, StackingMode, ScaleDistribution } from '@grafana/schema';

import { buildModel, ColorRegistry } from '../data/model';
import { defaultGlideSettings } from '../types';
import { EngineData, GlideEngine, HoverInfo } from './api';
import { createEngineWith } from './engine';
import { EngineEnv } from './loop';

const NOW = 1_700_000_000_000;
const theme = createTheme();

function rig(dpr = 1) {
  const frames: Array<(t: number) => void> = [];
  const clock = { t: 1000, wall: NOW };
  let ratio = dpr;
  const env: Partial<EngineEnv> = {
    now: () => clock.t,
    dateNow: () => clock.wall,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => {},
    devicePixelRatio: () => ratio,
    doc: null,
    IntersectionObserver: null,
  };
  const canvas = document.createElement('canvas');
  const engine = createEngineWith(canvas, env);
  const run = (n = 1, stepMs = 16) => {
    for (let i = 0; i < n; i++) {
      clock.t += stepMs;
      clock.wall += stepMs;
      frames.splice(0).forEach((cb) => cb(clock.t));
    }
  };
  return { engine, canvas, clock, run, setDpr: (r: number) => (ratio = r) };
}

function frame(
  values: unknown[],
  times?: number[],
  custom: Record<string, unknown> = {},
  config: Record<string, unknown> = {}
) {
  const t = times ?? values.map((_, i) => NOW - 60_000 + i * 1000);
  return createDataFrame({
    fields: [
      { name: 'time', type: FieldType.time, values: t },
      { name: 'v', type: FieldType.number, values: values as number[], config: { custom, ...config } },
    ],
  });
}

function processed(frames: DataFrame[]): DataFrame[] {
  return applyFieldOverrides({
    data: frames,
    fieldConfig: { defaults: {}, overrides: [] },
    replaceVariables: (s) => s,
    theme,
  });
}

function engineData(frames: DataFrame[], opts: Partial<EngineData['window']> = {}, receivedAt = 1000): EngineData {
  return {
    model: buildModel(processed(frames), theme, new ColorRegistry(), 1000),
    window: { from: NOW - 300_000, to: NOW - 6000, relative: true, evaluatedAt: NOW, rawKey: 'now-5m|now-6s', ...opts },
    receivedAt,
    refreshMs: 1000,
  };
}

function start(e: GlideEngine) {
  e.setStyle({ theme, timeZone: 'utc', glide: defaultGlideSettings });
  e.resize(400, 200);
}

const CASES: Array<[string, () => DataFrame[]]> = [
  ['no frames', () => []],
  [
    'frame without number field',
    () => [createDataFrame({ fields: [{ name: 'time', type: FieldType.time, values: [NOW] }] })],
  ],
  [
    'frame without time field',
    () => [createDataFrame({ fields: [{ name: 'v', type: FieldType.number, values: [1, 2] }] })],
  ],
  ['empty arrays', () => [frame([], [])]],
  ['single point', () => [frame([5])]],
  ['all nulls', () => [frame([null, null, null])]],
  ['NaN Infinity strings', () => [frame([NaN, Infinity, -Infinity, '7', 'x', true, 3])]],
  ['duplicate timestamps', () => [frame([1, 2, 3, 4], [NOW - 3000, NOW - 2000, NOW - 2000, NOW - 1000])]],
  ['unsorted time', () => [frame([1, 2, 3], [NOW - 1000, NOW - 3000, NOW - 2000])]],
  ['tiny values', () => [frame([1e-12, 2e-12, 3e-12])]],
  ['huge values', () => [frame([1e15, 3e15, 2e15])]],
  ['all equal', () => [frame([7, 7, 7, 7])]],
  ['all zero', () => [frame([0, 0, 0])]],
  ['negative only', () => [frame([-5, -3, -9])]],
  [
    'negative-Y stacked',
    () => [
      frame([1, 2, 3], undefined, {
        transform: GraphTransform.NegativeY,
        stacking: { mode: StackingMode.Normal, group: 'A' },
      }),
      frame([4, 5, 6], undefined, {
        transform: GraphTransform.NegativeY,
        stacking: { mode: StackingMode.Normal, group: 'A' },
      }),
    ],
  ],
  [
    'stacked mismatched grids with gaps',
    () => [
      frame([1, null, 3], [NOW - 3000, NOW - 2000, NOW - 1000], {
        stacking: { mode: StackingMode.Normal, group: 'A' },
      }),
      frame([4, 5], [NOW - 2500, NOW - 1500], { stacking: { mode: StackingMode.Normal, group: 'A' } }),
    ],
  ],
  [
    'percent stacking',
    () => [
      frame([1, 2], undefined, { stacking: { mode: StackingMode.Percent, group: 'A' } }),
      frame([3, 4], undefined, { stacking: { mode: StackingMode.Percent, group: 'A' } }),
    ],
  ],
  [
    'log scale with zero and negative',
    () => [frame([0, -1, 10, 1000], undefined, { scaleDistribution: { type: ScaleDistribution.Log, log: 10 } })],
  ],
  [
    'log scale all zero',
    () => [frame([0, 0], undefined, { scaleDistribution: { type: ScaleDistribution.Log, log: 2 } })],
  ],
  ['hard min above data', () => [frame([1, 2, 3], undefined, {}, { min: 50, max: 100 })]],
  ['hard min equals max', () => [frame([1, 2, 3], undefined, {}, { min: 5, max: 5 })]],
  ['soft limits', () => [frame([1, 2, 3], undefined, { axisSoftMin: -10, axisSoftMax: 1000 })]],
  [
    'percentage thresholds without min/max',
    () => [
      frame(
        [10, 20, 30],
        undefined,
        { thresholdsStyle: { mode: 'dashed' } },
        {
          thresholds: {
            mode: ThresholdsMode.Percentage,
            steps: [
              { value: -Infinity, color: 'green' },
              { value: 80, color: 'red' },
            ],
          },
        }
      ),
    ],
  ],
  ['decimals 0 with fractional data', () => [frame([0.1, 0.2, 0.3], undefined, {}, { decimals: 0 })]],
  [
    'step interpolation',
    () => [
      frame([1, 5, 2], undefined, { lineInterpolation: 'stepBefore' }),
      frame([3, 1, 4], undefined, { lineInterpolation: 'stepAfter' }),
    ],
  ],
  ['spanNulls number', () => [frame([1, null, null, 4], undefined, { spanNulls: 1500 })]],
  ['hidden viz', () => [frame([1, 2], undefined, { hideFrom: { viz: true, legend: false, tooltip: false } })]],
  ['fill gradient with negatives', () => [frame([-5, 5, -2], undefined, { fillOpacity: 50, gradientMode: 'opacity' })]],
  [
    '24 hours at 15 s',
    () => [
      frame(
        Array.from({ length: 5760 }, (_, i) => Math.sin(i / 50) * 100),
        Array.from({ length: 5760 }, (_, i) => NOW - 86_400_000 + i * 15_000)
      ),
    ],
  ],
];

describe('engine edge cases', () => {
  let errors: unknown[];
  beforeEach(() => {
    errors = [];
    jest.spyOn(console, 'error').mockImplementation((...a) => errors.push(a));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    expect(errors).toEqual([]);
  });

  it.each(CASES)('%s: draws, hovers, glides and resizes without throwing', (_name, make) => {
    const r = rig();
    start(r.engine);
    const hovers: Array<HoverInfo | null> = [];
    r.engine.onHover = (h) => hovers.push(h);
    for (const window of [{}, { relative: false, rawKey: 'abs' }, { from: NOW - 86_400_000, rawKey: 'now-24h|now' }]) {
      r.engine.setData(engineData(make(), window));
      r.run(3);
      for (const x of [-5, 0, 50, 200, 399, 400, 1000]) {
        r.engine.setPointer(x, 100);
        r.run(1);
        const t = r.engine.timeAtX(x);
        expect(Number.isNaN(t) || Number.isFinite(t)).toBe(true);
      }
      r.engine.setPointer(null, null);
      r.engine.setExternalCursor(NOW - 30_000, 0.3);
      r.run(2);
      r.engine.setExternalCursor(null);
      r.engine.resize(0, 0);
      r.run(1);
      r.engine.resize(300, 150);
      r.run(1);
    }
    const ctx = r.canvas.getContext('2d') as unknown as {
      __getEvents(): Array<{ type: string; props: Record<string, unknown> }>;
    };
    const bad = ctx
      .__getEvents()
      .filter((e) => Object.values(e.props).some((v) => typeof v === 'number' && !Number.isFinite(v)))
      .map((e) => e.type + ' ' + JSON.stringify(e.props));
    expect(bad.slice(0, 5)).toEqual([]);
    expect(ctx.__getEvents().length).toBeGreaterThan(50);
    for (const h of hovers) {
      if (h) {
        expect(Number.isFinite(h.x)).toBe(true);
        for (const it of h.items) {
          expect(typeof it.text).toBe('string');
        }
      }
    }
    r.engine.destroy();
  });

  it('survives clock jumps and rapid data', () => {
    const r = rig();
    start(r.engine);
    const f = [frame([1, 2, 3, 4, 5])];
    for (let i = 0; i < 50; i++) {
      r.engine.setData(engineData(f, {}, 1000 + i));
    }
    r.run(5);
    r.clock.wall -= 3_600_000;
    r.engine.setData(engineData(f, {}, r.clock.t));
    r.run(5);
    r.clock.wall += 7_200_000;
    r.engine.setData(engineData(f, {}, r.clock.t));
    r.run(5);
    expect(Number.isFinite(r.engine.timeAtX(200))).toBe(true);
    r.engine.destroy();
  });

  it('handles data before style, devicePixelRatio changes and calls after destroy', () => {
    const r = rig(1);
    r.engine.setData(engineData([frame([1, 2, 3])]));
    r.engine.resize(200, 100);
    r.run(2);
    r.engine.setStyle({ theme, timeZone: 'utc', glide: defaultGlideSettings });
    r.run(2);
    r.setDpr(2);
    r.engine.resize(200, 100);
    expect(r.canvas.width).toBe(400);
    r.run(2);
    r.engine.destroy();
    expect(() => {
      r.engine.setData(engineData([frame([1, 2, 3])]));
      r.engine.resize(10, 10);
      r.engine.setPointer(1, 1);
      r.engine.setExternalCursor(NOW);
      r.engine.setHidden(new Set(['v']));
      r.engine.setStyle({ theme, timeZone: 'utc', glide: { ...defaultGlideSettings, fps: 30 } });
      r.run(3);
    }).not.toThrow();
  });

  it('shows original (unsigned, unstacked) values in hover for negative-Y stacked series', () => {
    const r = rig();
    start(r.engine);
    const times = [NOW - 3000, NOW - 2000, NOW - 1000];
    const c = { transform: GraphTransform.NegativeY, stacking: { mode: StackingMode.Normal, group: 'A' } };
    r.engine.setData(
      engineData([frame([1, 2, 3], times, c), frame([10, 20, 30], times, c)], {
        relative: false,
        from: NOW - 4000,
        to: NOW,
        rawKey: 'abs',
      })
    );
    r.run(2);
    let last: HoverInfo | null = null;
    r.engine.onHover = (h) => (last = h);
    const plot = r.engine.plotRect();
    r.engine.setPointer(plot.left + plot.width * 0.5, plot.top + 10);
    r.run(2);
    expect(last).not.toBeNull();
    const vals = last!.items.map((i) => i.value).sort((a, b) => a - b);
    expect(vals).toEqual([2, 20]);
  });
});
