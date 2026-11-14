import { clampToPlot, insidePlot, selectionSpan, Span } from './zoom';

describe('drag to zoom helpers', () => {
  const out: Span = { left: 0, right: 0 };

  it('clamps x into the plot area', () => {
    expect(clampToPlot(5, 40, 100)).toBe(40);
    expect(clampToPlot(90, 40, 100)).toBe(90);
    expect(clampToPlot(500, 40, 100)).toBe(140);
  });

  it('orders and clamps the selected span', () => {
    expect(selectionSpan(120, 60, 40, 100, out)).toEqual({ left: 60, right: 120 });
    expect(selectionSpan(60, 900, 40, 100, out)).toEqual({ left: 60, right: 140 });
  });

  it('treats short drags as clicks', () => {
    expect(selectionSpan(60, 62, 40, 100, out)).toBeNull();
    expect(selectionSpan(0, 10, 40, 100, out)).toBeNull();
  });

  it('tests points against the plot rectangle', () => {
    const rect = { left: 40, top: 10, width: 100, height: 50 };
    expect(insidePlot(40, 10, rect)).toBe(true);
    expect(insidePlot(141, 30, rect)).toBe(false);
    expect(insidePlot(80, 61, rect)).toBe(false);
  });
});
