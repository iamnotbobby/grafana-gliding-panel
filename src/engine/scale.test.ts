import uPlot from 'uplot';

import { chooseStep, linearRange, niceStepAtLeast, RangeConfig, stepDecimals, YScale } from './scale';

function cfg(partial: Partial<RangeConfig> = {}): RangeConfig {
  return {
    hardMin: null,
    hardMax: null,
    softMin: null,
    softMax: null,
    includeZero: false,
    logBase: 0,
    binary: false,
    percent: false,
    ...partial,
  };
}

/** The range Grafana's time series panel computes (UPlotScaleBuilder with uPlot.rangeNum). */
function grafanaRange(dataMin: number, dataMax: number, c: RangeConfig): [number, number] {
  const hardMinOnly = c.softMin == null && c.hardMin != null;
  const hardMaxOnly = c.softMax == null && c.hardMax != null;
  const r = uPlot.rangeNum(hardMinOnly ? c.hardMin! : dataMin, hardMaxOnly ? c.hardMax! : dataMax, {
    min: { pad: 0.1, hard: c.hardMin ?? -Infinity, soft: c.softMin || 0, mode: c.softMin == null ? 3 : 1 },
    max: { pad: 0.1, hard: c.hardMax ?? Infinity, soft: c.softMax || 0, mode: c.softMax == null ? 3 : 1 },
  });
  return [r[0]!, r[1]!];
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

describe('linearRange', () => {
  const out = new Float64Array(2);

  it('matches the built-in panel on the cases seen in the test dashboard', () => {
    // TCP in/out with negative-Y: about -210 kB/s .. +45 kB/s.
    linearRange(-209_800, 44_600, cfg(), out);
    expect([out[0], out[1]]).toEqual(grafanaRange(-209_800, 44_600, cfg()));
    // Percent with hard 0..100.
    linearRange(0.4, 7.75, cfg({ hardMin: 0, hardMax: 100 }), out);
    expect([out[0], out[1]]).toEqual([0, 100]);
  });

  it('equals uPlot.rangeNum as Grafana configures it, for random data and limits', () => {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let mismatches = 0;
    const examples: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const mag = Math.pow(10, Math.floor(rnd() * 12) - 3);
      const a = (rnd() * 2 - (rnd() < 0.3 ? 1 : 0)) * mag;
      const b = a + rnd() * mag * (rnd() < 0.1 ? 0 : 1);
      const c = cfg({
        hardMin: rnd() < 0.15 ? Math.floor(a - mag * rnd()) : null,
        hardMax: rnd() < 0.15 ? Math.ceil(b + mag * rnd()) : null,
        softMin: rnd() < 0.1 ? a - mag * rnd() : null,
        softMax: rnd() < 0.1 ? b + mag * rnd() : null,
      });
      linearRange(a, b, c, out);
      const [gMin, gMax] = grafanaRange(a, b, c);
      const want = gMax > gMin ? [gMin, gMax] : [gMin, gMin + 1];
      if (!close(out[0], want[0]) || !close(out[1], want[1])) {
        mismatches++;
        if (examples.length < 5) {
          examples.push(`data ${a}..${b} ${JSON.stringify(c)} -> ${out[0]}..${out[1]}, grafana ${gMin}..${gMax}`);
        }
      }
    }
    expect(examples).toEqual([]);
    expect(mismatches).toBe(0);
  });

  it('spans 0..1 for percent stacking, -1..0 below zero, ignoring the limits like Grafana', () => {
    linearRange(0.1, 0.9, cfg({ percent: true, hardMax: 50 }), out);
    expect([out[0], out[1]]).toEqual([0, 1]);
    linearRange(-0.9, -0.1, cfg({ percent: true }), out);
    expect([out[0], out[1]]).toEqual([-1, 0]);
    linearRange(-0.5, 0.5, cfg({ percent: true }), out);
    expect([out[0], out[1]]).toEqual([-1, 1]);
  });

  it('includes zero for stacked series', () => {
    linearRange(130e6, 260e6, cfg({ includeZero: true }), out);
    expect(out[0]).toBe(0);
  });
});

describe('ticks', () => {
  it('uses powers of two for binary units', () => {
    expect(niceStepAtLeast(30e6, true)).toBe(2 ** 25);
    expect(niceStepAtLeast(30e6, false)).toBe(50e6);
  });

  it('picks the step the built-in panel picks: at least 30 px apart, 15 px on small plots', () => {
    // TCP panel of the test dashboard: 190 kB/s over 256 px.
    expect(chooseStep(190_000, 256)).toBe(25_000);
    expect(chooseStep(100, 300)).toBe(10);
    expect(chooseStep(100, 120)).toBe(20);
  });

  it('knows the decimals of a step', () => {
    expect(stepDecimals(0.25)).toBe(2);
    expect(stepDecimals(200)).toBe(0);
  });

  it('eases toward a new range instead of snapping, and settles exactly', () => {
    const s = new YScale();
    s.update(0, 100, cfg(), 300, 0, true);
    const firstMax = s.max;
    s.update(0, 200, cfg(), 300, 16, false);
    expect(s.max).toBeGreaterThan(firstMax);
    expect(s.max).toBeLessThan(s.targetMax);
    for (let i = 0; i < 200; i++) {
      s.update(0, 200, cfg(), 300, 16, false);
    }
    expect(s.settled).toBe(true);
  });
});
