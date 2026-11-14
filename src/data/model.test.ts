import {
  applyFieldOverrides,
  createDataFrame,
  createTheme,
  DataFrame,
  Field,
  FieldColorModeId,
  FieldConfigSource,
  FieldType,
  PanelPlugin,
  standardFieldConfigEditorRegistry,
  ThresholdsMode,
  toDataFrame,
} from '@grafana/data';
import {
  GraphGradientMode,
  GraphThresholdsStyleMode,
  GraphTransform,
  LineInterpolation,
  ScaleDistribution,
  StackingMode,
} from '@grafana/schema';

import { GlideFieldConfig } from '../types';
import { alignToGrid, buildModel, ColorRegistry, GlideModel, Interp, unionGrid } from './model';

const theme = createTheme();
const palette = theme.visualization.palette;
const paletteColor = (slot: number) => theme.visualization.getColorByName(palette[slot % palette.length]);

const NoEditor = () => null;
const passThrough = (v: unknown) => v;

function option(id: string) {
  return {
    id,
    path: id,
    name: id,
    editor: NoEditor,
    override: NoEditor,
    process: passThrough,
    shouldApply: (f: Field) => f.type === FieldType.number,
  };
}

// Only a running Grafana fills the standard option registry. Register the options used here
// (with pass-through processing) so applyFieldOverrides copies defaults and applies overrides
// the way it does inside a real panel.
standardFieldConfigEditorRegistry.setInit(() =>
  ['displayName', 'unit', 'min', 'max', 'thresholds', 'color'].map((id) => ({ ...option(id), shouldApply: () => true }))
);

/** The custom properties the tests set, registered as the plugin's field config would be. */
const CUSTOM_PATHS = [
  'lineInterpolation',
  'lineWidth',
  'fillOpacity',
  'gradientMode',
  'spanNulls',
  'transform',
  'stacking',
  'hideFrom',
  'thresholdsStyle',
  'scaleDistribution',
  'axisSoftMin',
  'axisSoftMax',
];

const registry = new PanelPlugin<{}, GlideFieldConfig>(() => null).useFieldConfig({
  useCustomConfig: (builder) => {
    for (const path of CUSTOM_PATHS) {
      builder.addCustomEditor(option(path));
    }
  },
}).fieldConfigRegistry;

/** Production-like defaults: 1 px lines, 10 % fill with opacity gradient, no points. */
const productionCustom: GlideFieldConfig = {
  lineInterpolation: LineInterpolation.Linear,
  lineWidth: 1,
  fillOpacity: 10,
  gradientMode: GraphGradientMode.Opacity,
  spanNulls: false,
  stacking: { mode: StackingMode.None, group: 'A' },
};

function config(custom: GlideFieldConfig = {}, rest: Partial<FieldConfigSource['defaults']> = {}): FieldConfigSource {
  return {
    defaults: { color: { mode: FieldColorModeId.PaletteClassic }, ...rest, custom: { ...productionCustom, ...custom } },
    overrides: [],
  };
}

const stackedConfig = () => config({ stacking: { mode: StackingMode.Normal, group: 'A' } });

/** One frame per series, the shape the Prometheus data source returns for a range query. */
function promFrame(
  name: string,
  ts: number[],
  vs: Array<number | null>,
  opts: { refId?: string; interval?: number } = {}
): DataFrame {
  return createDataFrame({
    refId: opts.refId ?? 'A',
    name,
    fields: [
      { name: 'Time', type: FieldType.time, values: ts, config: { interval: opts.interval } },
      {
        name: 'Value',
        type: FieldType.number,
        values: vs,
        labels: { instance: name },
        config: { displayNameFromDS: name },
      },
    ],
  });
}

/** Runs frames through the same override pipeline a panel's data goes through. */
function prepare(frames: DataFrame[], fieldConfig: FieldConfigSource = config()): DataFrame[] {
  return applyFieldOverrides({
    data: frames,
    fieldConfig,
    fieldConfigRegistry: registry,
    replaceVariables: (v) => v,
    theme,
  });
}

function build(
  frames: DataFrame[],
  fieldConfig: FieldConfigSource = config(),
  colors = new ColorRegistry(),
  requestIntervalMs?: number
): GlideModel {
  return buildModel(prepare(frames, fieldConfig), theme, colors, requestIntervalMs);
}

/** Changes one field's custom config after the override pipeline, like a per-field override. */
function patchCustom(frame: DataFrame, patch: GlideFieldConfig) {
  const field = frame.fields[1];
  field.config = { ...field.config, custom: { ...field.config.custom, ...patch } };
}

const arr = (a: Float64Array | null) => (a ? Array.from(a) : null);

function byName(m: GlideModel, name: string) {
  const s = m.series.find((x) => x.key === name);
  if (!s) {
    throw new Error(`series ${name} not found, have: ${m.series.map((x) => x.key).join(', ')}`);
  }
  return s;
}

const T = [1000, 2000, 3000, 4000];
const flat = (n: string) => promFrame(n, T, [1, 2, 3, 4]);

describe('buildModel', () => {
  describe('empty and malformed input', () => {
    it('returns an empty model for no frames', () => {
      const m = buildModel([], theme, new ColorRegistry(), undefined);
      expect(m.series).toEqual([]);
      expect(m.lastT).toBeNaN();
      expect(m.firstT).toBeNaN();
      expect(m.stepMs).toBe(1000);
      expect(m.axis.field).toBeNull();
      expect(m.axis.thresholdsMode).toBe(GraphThresholdsStyleMode.Off);
    });

    it('skips frames without a time field and ignores string fields', () => {
      const noTime = toDataFrame({ fields: [{ name: 'v', type: FieldType.number, values: [1, 2] }] });
      const withString = toDataFrame({
        fields: [
          { name: 'time', type: FieldType.time, values: [1000, 2000] },
          { name: 'host', type: FieldType.string, values: ['a', 'b'] },
          { name: 'cpu', type: FieldType.number, values: [1, 2] },
        ],
      });
      const m = build([noTime, withString]);
      expect(m.series.map((s) => s.name)).toEqual(['cpu']);
    });

    it('keeps a series that has no points at all', () => {
      const m = build([promFrame('a', [], []), flat('b')]);
      expect(m.series.map((s) => s.key)).toEqual(['a', 'b']);
      expect(byName(m, 'a').ts.length).toBe(0);
      expect(m.firstT).toBe(1000);
      expect(m.lastT).toBe(4000);
    });
  });

  describe('names', () => {
    it('uses the data source display name (legend format)', () => {
      const m = build([flat('host-1'), flat('host-2')]);
      expect(m.series.map((s) => s.name)).toEqual(['host-1', 'host-2']);
      expect(m.series.map((s) => s.key)).toEqual(['host-1', 'host-2']);
    });

    it('prefers an explicit display name from the field config', () => {
      const m = build([flat('host-1')], config({}, { displayName: 'Renamed' }));
      expect(m.series[0].name).toBe('Renamed');
    });

    it('uses field names for a wide frame', () => {
      const wide = toDataFrame({
        fields: [
          { name: 'time', type: FieldType.time, values: T },
          { name: 'cpu', type: FieldType.number, values: [1, 2, 3, 4] },
          { name: 'mem', type: FieldType.number, values: [5, 6, 7, 8] },
        ],
      });
      const m = build([wide]);
      expect(m.series.map((s) => s.name)).toEqual(['cpu', 'mem']);
    });

    it('agrees with the name Grafana caches on the field state', () => {
      const m = build([flat('x'), flat('y')]);
      for (const s of m.series) {
        expect(s.field.state?.displayName).toBe(s.name);
      }
    });

    it('makes keys unique when series share a display name', () => {
      const m = build([flat('dup'), flat('dup'), flat('dup')]);
      expect(m.series.map((s) => s.name)).toEqual(['dup', 'dup', 'dup']);
      expect(m.series.map((s) => s.key)).toEqual(['dup', 'dup (2)', 'dup (3)']);
      expect(new Set(m.series.map((s) => s.color)).size).toBe(3);
    });
  });

  describe('style', () => {
    it('maps the production defaults', () => {
      const s = build([flat('a')]).series[0];
      expect(s.lineWidth).toBe(1);
      expect(s.fillOpacity).toBeCloseTo(0.1);
      expect(s.gradient).toBe(true);
      expect(s.interp).toBe(Interp.Linear);
      expect(s.stacked).toBe(false);
      expect(s.negative).toBe(false);
      expect(s.hidden).toBe(false);
      expect(s.hideFromLegend).toBe(false);
      expect(s.hideFromTooltip).toBe(false);
      expect(s.base).toBeNull();
    });

    it('falls back to sane values without any custom config', () => {
      const frame = toDataFrame({
        fields: [
          { name: 'time', type: FieldType.time, values: T },
          { name: 'v', type: FieldType.number, values: [1, 2, 3, 4] },
        ],
      });
      const s = buildModel([frame], theme, new ColorRegistry(), undefined).series[0];
      expect(s.lineWidth).toBe(1);
      expect(s.fillOpacity).toBe(0);
      expect(s.gradient).toBe(false);
      expect(s.color).toBe(paletteColor(0));
    });

    it('clamps fill opacity to 0..1 and maps the interpolation modes', () => {
      const before = build([flat('a')], config({ fillOpacity: 250, lineInterpolation: LineInterpolation.StepBefore }))
        .series[0];
      expect(before.fillOpacity).toBe(1);
      expect(before.interp).toBe(Interp.StepBefore);
      const after = build([flat('a')], config({ fillOpacity: -5, lineInterpolation: LineInterpolation.StepAfter }))
        .series[0];
      expect(after.fillOpacity).toBe(0);
      expect(after.interp).toBe(Interp.StepAfter);
      const smooth = build([flat('a')], config({ lineInterpolation: LineInterpolation.Smooth })).series[0];
      expect(smooth.interp).toBe(Interp.Linear);
    });

    it('reads the hide flags', () => {
      const s = build([flat('a')], config({ hideFrom: { viz: true, legend: true, tooltip: true } })).series[0];
      expect(s.hidden).toBe(true);
      expect(s.hideFromLegend).toBe(true);
      expect(s.hideFromTooltip).toBe(true);
    });
  });

  describe('colours', () => {
    it('gives a fresh panel the classic palette in series order, like the time series panel', () => {
      const m = build([flat('a'), flat('b'), flat('c')]);
      expect(m.series.map((s) => s.color)).toEqual([paletteColor(0), paletteColor(1), paletteColor(2)]);
    });

    it('keeps colours when a series disappears and gives them back when it reappears', () => {
      const colors = new ColorRegistry();
      const first = build([flat('a'), flat('b'), flat('c')], config(), colors);
      const colorOf: Record<string, string> = {};
      for (const s of first.series) {
        colorOf[s.key] = s.color;
      }

      // b stops: Grafana now hands c the series index 1, but c must keep its colour.
      const second = build([flat('a'), flat('c')], config(), colors);
      expect(byName(second, 'a').color).toBe(colorOf.a);
      expect(byName(second, 'c').color).toBe(colorOf.c);

      // A new container starts while b is away: it must not take the colour of a, b or c.
      const third = build([flat('a'), flat('c'), flat('d')], config(), colors);
      const d = byName(third, 'd').color;
      expect([colorOf.a, colorOf.b, colorOf.c]).not.toContain(d);
      expect(d).toBe(paletteColor(3));

      // b comes back, in a different position.
      const fourth = build([flat('b'), flat('a'), flat('c'), flat('d')], config(), colors);
      expect(byName(fourth, 'a').color).toBe(colorOf.a);
      expect(byName(fourth, 'b').color).toBe(colorOf.b);
      expect(byName(fourth, 'c').color).toBe(colorOf.c);
      expect(byName(fourth, 'd').color).toBe(d);
    });

    it('keeps colours when the order of the series changes', () => {
      const colors = new ColorRegistry();
      const first = build([flat('a'), flat('b'), flat('c'), flat('d')], config(), colors);
      const second = build([flat('d'), flat('b'), flat('a'), flat('c')], config(), colors);
      for (const s of first.series) {
        expect(byName(second, s.key).color).toBe(s.color);
      }
      expect(second.series.map((s) => s.key)).toEqual(['d', 'b', 'a', 'c']);
    });

    it('does not hand a remembered slot to a newcomer', () => {
      const colors = new ColorRegistry();
      build([flat('a'), flat('b')], config(), colors);
      build([flat('b')], config(), colors);
      // x arrives at index 0, the slot a used to have.
      const m = build([flat('x'), flat('b'), flat('a')], config(), colors);
      expect(byName(m, 'a').color).toBe(paletteColor(0));
      expect(byName(m, 'b').color).toBe(paletteColor(1));
      expect(byName(m, 'x').color).toBe(paletteColor(2));
    });

    it('wraps around the palette for many series', () => {
      const frames = Array.from({ length: palette.length + 2 }, (_, i) => flat(`s${i}`));
      const m = build(frames);
      expect(m.series[palette.length].color).toBe(paletteColor(0));
      expect(m.series[palette.length + 1].color).toBe(paletteColor(1));
    });

    it('honours a fixed colour', () => {
      const m = build([flat('a')], config({}, { color: { mode: FieldColorModeId.Fixed, fixedColor: 'red' } }));
      expect(m.series[0].color).toBe(theme.visualization.getColorByName('red'));
    });

    it('ColorRegistry returns a known slot regardless of the preferred one', () => {
      const r = new ColorRegistry();
      expect(r.slotFor('a', 4)).toBe(4);
      expect(r.slotFor('a', 0)).toBe(4);
      expect(r.slotFor('b', 4)).toBe(0);
      expect(r.slotFor('c', -1)).toBe(1);
    });
  });

  describe('negative Y', () => {
    const outOverride = [
      {
        matcher: { id: 'byRegexp', options: '/ out$/' },
        properties: [{ id: 'custom.transform', value: GraphTransform.NegativeY }],
      },
    ];

    it('flips only the plotted values of the series matched by the override', () => {
      const m = build(
        [
          promFrame('host-1 in', T, [10, 20, 30, 40], { refId: 'A' }),
          promFrame('host-1 out', T, [1, 2, 3, 4], { refId: 'B' }),
        ],
        { ...config({}, { unit: 'Bps' }), overrides: outOverride }
      );
      const rx = byName(m, 'host-1 in');
      const tx = byName(m, 'host-1 out');
      expect(rx.negative).toBe(false);
      expect(arr(rx.y)).toEqual([10, 20, 30, 40]);
      expect(tx.negative).toBe(true);
      expect(arr(tx.raw)).toEqual([1, 2, 3, 4]);
      expect(arr(tx.y)).toEqual([-1, -2, -3, -4]);
      expect(tx.base).toBeNull();
      // The tooltip reads raw, so the flipped array must be a separate one.
      expect(tx.y).not.toBe(tx.raw);
    });

    it('stacks negative series downwards in their own group', () => {
      const m = build(
        [
          promFrame('h1 in', T, [1, 1, 1, 1]),
          promFrame('h2 in', T, [2, 2, 2, 2]),
          promFrame('h1 out', T, [3, 3, 3, 3]),
          promFrame('h2 out', T, [4, 4, 4, 4]),
        ],
        { ...stackedConfig(), overrides: outOverride }
      );
      expect(arr(byName(m, 'h1 in').y)).toEqual([1, 1, 1, 1]);
      expect(arr(byName(m, 'h2 in').y)).toEqual([3, 3, 3, 3]);
      expect(arr(byName(m, 'h1 out').y)).toEqual([-3, -3, -3, -3]);
      expect(arr(byName(m, 'h2 out').y)).toEqual([-7, -7, -7, -7]);
      expect(byName(m, 'h1 out').base).toBeNull();
      expect(byName(m, 'h2 out').base).toBe(byName(m, 'h1 out').y);
      expect(arr(byName(m, 'h2 out').raw)).toEqual([4, 4, 4, 4]);
    });
  });

  describe('stacking', () => {
    it('accumulates in series order on an identical grid', () => {
      const m = build(
        [flat('a'), promFrame('b', T, [10, 10, 10, 10]), promFrame('c', T, [5, 0, 5, 0])],
        stackedConfig()
      );
      const [a, b, c] = m.series;
      expect(a.stacked && b.stacked && c.stacked).toBe(true);
      expect(arr(a.y)).toEqual([1, 2, 3, 4]);
      expect(arr(b.y)).toEqual([11, 12, 13, 14]);
      expect(arr(c.y)).toEqual([16, 12, 18, 14]);
      expect(a.base).toBeNull();
      expect(b.base).toBe(a.y);
      expect(c.base).toBe(b.y);
      expect(arr(b.raw)).toEqual([10, 10, 10, 10]);
      expect(a.ts).toBe(b.ts);
      expect(b.ts).toBe(c.ts);
    });

    it('normalises percent stacks to the group total and labels the axis in percent', () => {
      const m = build(
        [promFrame('a', T, [1, 1, 0, 3]), promFrame('b', T, [3, 1, 0, 1])],
        config({ stacking: { mode: StackingMode.Percent, group: 'A' } })
      );
      const [a, b] = m.series;
      expect(arr(a.y)).toEqual([0.25, 0.5, 0, 0.75]);
      expect(arr(b.y)).toEqual([1, 1, 0, 1]);
      expect(b.base).toBe(a.y);
      expect(arr(a.raw)).toEqual([1, 1, 0, 3]);
      expect(m.axis.percent).toBe(true);
      expect(m.axis.field?.config.unit).toBe('percentunit');
      expect(m.axis.field?.display?.(0.5).suffix).toBe('%');
    });

    it('keeps percent and normal stacks of the same group apart', () => {
      const frames = prepare([flat('a'), flat('b')], stackedConfig());
      patchCustom(frames[1], { stacking: { mode: StackingMode.Percent, group: 'A' } });
      const mixed = buildModel(frames, theme, new ColorRegistry(), undefined);
      expect(arr(mixed.series[0].y)).toEqual([1, 2, 3, 4]);
      expect(arr(mixed.series[1].y)).toEqual([1, 1, 1, 1]);
      expect(mixed.series[1].base).toBeNull();
      expect(mixed.axis.percent).toBe(false);
    });

    it('puts series with mismatched grids on the union grid, missing points count as zero', () => {
      const m = build(
        [promFrame('a', [1000, 2000, 3000], [1, 2, 3]), promFrame('b', [2000, 3000, 4000], [10, 20, 30])],
        stackedConfig()
      );
      const a = byName(m, 'a');
      const b = byName(m, 'b');
      expect(arr(a.ts)).toEqual([1000, 2000, 3000, 4000]);
      expect(a.ts).toBe(b.ts);
      expect(arr(a.raw)).toEqual([1, 2, 3, NaN]);
      expect(arr(b.raw)).toEqual([NaN, 10, 20, 30]);
      expect(arr(a.y)).toEqual([1, 2, 3, 0]);
      expect(arr(b.y)).toEqual([1, 12, 23, 30]);
      expect(b.base).toBe(a.y);
      expect(m.firstT).toBe(1000);
      expect(m.lastT).toBe(4000);
    });

    it('handles grids that interleave without sharing any timestamp', () => {
      const m = build(
        [promFrame('a', [1000, 3000, 5000], [1, 1, 1]), promFrame('b', [2000, 4000], [5, 5])],
        stackedConfig()
      );
      const a = byName(m, 'a');
      const b = byName(m, 'b');
      expect(arr(a.ts)).toEqual([1000, 2000, 3000, 4000, 5000]);
      expect(arr(a.y)).toEqual([1, 0, 1, 0, 1]);
      expect(arr(b.y)).toEqual([1, 5, 1, 5, 1]);
      for (const s of m.series) {
        expect(s.y.length).toBe(s.ts.length);
        expect(s.raw.length).toBe(s.ts.length);
      }
    });

    it('treats nulls inside a stacked series as zero contribution', () => {
      const m = build([promFrame('a', T, [1, null, 3, 4]), promFrame('b', T, [10, 10, 10, 10])], stackedConfig());
      expect(arr(byName(m, 'a').raw)).toEqual([1, NaN, 3, 4]);
      expect(arr(byName(m, 'b').y)).toEqual([11, 10, 13, 14]);
    });

    it('keeps stack groups apart', () => {
      const frames = prepare(
        [promFrame('a', T, [1, 1, 1, 1]), promFrame('b', T, [2, 2, 2, 2]), promFrame('c', T, [4, 4, 4, 4])],
        stackedConfig()
      );
      patchCustom(frames[2], { stacking: { mode: StackingMode.Normal, group: 'B' } });
      const m = buildModel(frames, theme, new ColorRegistry(), undefined);
      expect(arr(byName(m, 'b').y)).toEqual([3, 3, 3, 3]);
      expect(arr(byName(m, 'c').y)).toEqual([4, 4, 4, 4]);
      expect(byName(m, 'c').base).toBeNull();
    });

    it('leaves hidden series out of the stack', () => {
      const frames = prepare(
        [promFrame('a', T, [1, 1, 1, 1]), promFrame('b', T, [2, 2, 2, 2]), promFrame('c', T, [4, 4, 4, 4])],
        stackedConfig()
      );
      patchCustom(frames[1], { hideFrom: { viz: true, legend: false, tooltip: false } });
      const m = buildModel(frames, theme, new ColorRegistry(), undefined);
      expect(byName(m, 'b').hidden).toBe(true);
      expect(arr(byName(m, 'c').y)).toEqual([5, 5, 5, 5]);
      expect(byName(m, 'c').base).toBe(byName(m, 'a').y);
    });

    it('does not stack when the mode is none', () => {
      const m = build([flat('a'), promFrame('b', T, [10, 10, 10, 10])]);
      expect(arr(byName(m, 'b').y)).toEqual([10, 10, 10, 10]);
      expect(byName(m, 'b').base).toBeNull();
    });
  });

  describe('nulls, gaps and step', () => {
    it('drops null, NaN and infinite values together with their timestamps', () => {
      const frame = promFrame('a', [1000, 2000, 3000, 4000, 5000], [1, null, NaN, Infinity, 5]);
      const s = build([frame]).series[0];
      expect(arr(s.ts)).toEqual([1000, 5000]);
      expect(arr(s.y)).toEqual([1, 5]);
    });

    it('takes the step from the frame interval, smallest wins', () => {
      const m = build([
        promFrame('a', T, [1, 2, 3, 4], { interval: 5000 }),
        promFrame('b', T, [1, 2, 3, 4], { interval: 1000 }),
      ]);
      expect(m.stepMs).toBe(1000);
    });

    it('falls back to the request interval, then to the smallest spacing, then to 1 s', () => {
      expect(build([flat('a')], config(), new ColorRegistry(), 5000).stepMs).toBe(5000);
      expect(build([promFrame('a', [0, 15000, 20000, 40000], [1, 2, 3, 4])]).stepMs).toBe(5000);
      expect(build([promFrame('a', [1000], [1])]).stepMs).toBe(1000);
    });

    it('breaks the line at gaps longer than one and a half steps by default', () => {
      const m = build([promFrame('a', T, [1, 2, 3, 4], { interval: 1000 })]);
      expect(m.series[0].gapMs).toBe(1500);
      const slow = build([promFrame('a', T, [1, 2, 3, 4], { interval: 5000 })]);
      expect(slow.series[0].gapMs).toBe(7500);
    });

    it('never breaks the line when nulls are always connected', () => {
      const m = build([promFrame('a', T, [1, 2, 3, 4], { interval: 1000 })], config({ spanNulls: true }));
      expect(m.series[0].gapMs).toBe(Infinity);
    });

    it('uses a numeric span threshold, but never less than the default gap', () => {
      const wide = build([promFrame('a', T, [1, 2, 3, 4], { interval: 1000 })], config({ spanNulls: 10000 }));
      expect(wide.series[0].gapMs).toBe(10000);
      const narrow = build([promFrame('a', T, [1, 2, 3, 4], { interval: 1000 })], config({ spanNulls: 200 }));
      expect(narrow.series[0].gapMs).toBe(1500);
    });
  });

  describe('time handling', () => {
    it('sorts unsorted time and keeps values attached to their timestamps', () => {
      const s = build([promFrame('a', [3000, 1000, 4000, 2000], [30, 10, 40, 20])]).series[0];
      expect(arr(s.ts)).toEqual([1000, 2000, 3000, 4000]);
      expect(arr(s.y)).toEqual([10, 20, 30, 40]);
    });

    it('sorts unsorted time that also contains nulls', () => {
      const s = build([promFrame('a', [3000, 1000, 4000, 2000], [30, null, 40, 20])]).series[0];
      expect(arr(s.ts)).toEqual([2000, 3000, 4000]);
      expect(arr(s.y)).toEqual([20, 30, 40]);
    });

    it('stacks unsorted series correctly', () => {
      const m = build([promFrame('a', [2000, 1000], [2, 1]), promFrame('b', [1000, 2000], [10, 20])], stackedConfig());
      expect(arr(byName(m, 'a').y)).toEqual([1, 2]);
      expect(arr(byName(m, 'b').y)).toEqual([11, 22]);
    });

    it('reports first and last timestamps across all series', () => {
      const m = build([promFrame('a', [2000, 3000], [1, 2]), promFrame('b', [1000, 2000, 5000], [1, 2, 3])]);
      expect(m.firstT).toBe(1000);
      expect(m.lastT).toBe(5000);
    });
  });

  describe('axis', () => {
    it('reads min, max, soft limits, thresholds style and log scale', () => {
      const m = build(
        [flat('a')],
        config(
          {
            axisSoftMin: 5,
            axisSoftMax: 50,
            thresholdsStyle: { mode: GraphThresholdsStyleMode.Dashed },
            scaleDistribution: { type: ScaleDistribution.Log, log: 2 },
          },
          {
            unit: 'percent',
            min: 0,
            max: 100,
            thresholds: {
              mode: ThresholdsMode.Absolute,
              steps: [
                { color: 'green', value: -Infinity },
                { color: 'orange', value: 80 },
                { color: 'red', value: 90 },
              ],
            },
          }
        )
      );
      expect(m.axis.hardMin).toBe(0);
      expect(m.axis.hardMax).toBe(100);
      expect(m.axis.softMin).toBe(5);
      expect(m.axis.softMax).toBe(50);
      expect(m.axis.thresholdsMode).toBe(GraphThresholdsStyleMode.Dashed);
      expect(m.axis.logBase).toBe(2);
      expect(m.axis.field).toBe(m.series[0].field);
      expect(m.axis.field?.config.thresholds?.steps.map((s) => s.value)).toEqual([-Infinity, 80, 90]);
      expect(m.axis.field?.display?.(42).suffix).toBe('%');
    });

    it('defaults to an automatic linear axis', () => {
      const m = build([flat('a')]);
      expect(m.axis.hardMin).toBeNull();
      expect(m.axis.hardMax).toBeNull();
      expect(m.axis.softMin).toBeNull();
      expect(m.axis.softMax).toBeNull();
      expect(m.axis.logBase).toBe(0);
    });

    it('takes the axis from the first visible series', () => {
      const frames = prepare([flat('a'), flat('b')]);
      patchCustom(frames[0], { hideFrom: { viz: true, legend: false, tooltip: false } });
      const m = buildModel(frames, theme, new ColorRegistry(), undefined);
      expect(m.axis.field).toBe(frames[1].fields[1]);
    });
  });

  describe('grid helpers', () => {
    it('unionGrid returns the same array when all grids are equal', () => {
      const a = Float64Array.of(1, 2, 3);
      const b = Float64Array.of(1, 2, 3);
      expect(unionGrid([a, b])).toBe(a);
      expect(unionGrid([]).length).toBe(0);
    });

    it('unionGrid merges, sorts and removes duplicates', () => {
      const u = unionGrid([Float64Array.of(1, 3, 5), Float64Array.of(2, 3, 6), Float64Array.of()]);
      expect(arr(u)).toEqual([1, 2, 3, 5, 6]);
    });

    it('alignToGrid places points and fills the rest with NaN', () => {
      const grid = Float64Array.of(1, 2, 3, 4);
      const ts = Float64Array.of(2, 4);
      const vs = Float64Array.of(20, 40);
      expect(arr(alignToGrid(grid, ts, vs))).toEqual([NaN, 20, NaN, 40]);
      expect(alignToGrid(ts, ts, vs)).toBe(vs);
    });
  });

  describe('scale', () => {
    it('builds the container dashboard shape (76 series x 300 points) with consistent arrays', () => {
      const n = 300;
      const ts = Array.from({ length: n }, (_, i) => 1700000000000 + i * 5000);
      const late = ts.slice(100);
      const frames = Array.from({ length: 76 }, (_, k) => {
        // Every fourth container started late, so the grids differ.
        const own = k % 4 === 0 ? late : ts;
        return promFrame(
          `host / c${k}`,
          own,
          own.map((_, i) => k + (i % 7)),
          { interval: 5000 }
        );
      });
      const m = build(frames, stackedConfig());
      expect(m.series.length).toBe(76);
      expect(m.stepMs).toBe(5000);
      expect(new Set(m.series.map((s) => s.key)).size).toBe(76);
      for (const s of m.series) {
        expect(s.ts.length).toBe(n);
        expect(s.y.length).toBe(n);
        expect(s.raw.length).toBe(n);
      }
      for (let k = 1; k < 76; k++) {
        const lo = m.series[k - 1].y;
        const hi = m.series[k].y;
        expect(m.series[k].base).toBe(lo);
        expect(hi[0]).toBeGreaterThanOrEqual(lo[0]);
        expect(hi[n - 1]).toBeGreaterThanOrEqual(lo[n - 1]);
      }
      // Series 0 started late: nothing at the first timestamp, its own value at the last one.
      expect(m.series[0].raw[0]).toBeNaN();
      expect(m.series[0].y[0]).toBe(0);
      expect(m.series[0].y[n - 1]).toBe((n - 101) % 7);
    });
  });
});
