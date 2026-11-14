import { GlideView, SampleRing, ViewUpdate } from './view';

const LEN = 5 * 60_000;

/** Feeds a new view with a regular refresh cadence; returns it and the updates it received. */
function simulate(opts: {
  refreshMs: number;
  /** Delivery delay of each response (arrival minus newest data timestamp), per refresh index. */
  delay: (i: number) => number;
  count: number;
  marginMs?: number;
}): { view: GlideView; updates: ViewUpdate[] } {
  const view = new GlideView();
  const updates: ViewUpdate[] = [];
  for (let i = 0; i < opts.count; i++) {
    const arrival = 1_000_000 + i * opts.refreshMs;
    const u: ViewUpdate = {
      now: arrival,
      arrival,
      lenMs: LEN,
      marginMs: opts.marginMs ?? 6000,
      headT: arrival - opts.delay(i),
      refreshMs: opts.refreshMs,
      stepMs: opts.refreshMs,
      jump: false,
    };
    view.update(u);
    updates.push(u);
  }
  return { view, updates };
}

describe('SampleRing', () => {
  it('keeps the most recent samples and answers quantiles', () => {
    const r = new SampleRing(3);
    expect(r.quantile(0.5)).toBeNaN();
    [5, 1, 9, 7].forEach((v) => r.push(v));
    expect(r.size).toBe(3);
    // 1, 9, 7 remain (5 was overwritten).
    expect(r.quantile(0)).toBe(1);
    expect(r.quantile(0.5)).toBe(7);
    expect(r.quantile(1)).toBe(9);
  });
});

describe('GlideView', () => {
  it('moves at exactly real time once the lag has settled, and the data reaches the right edge', () => {
    const { view, updates } = simulate({ refreshMs: 1000, delay: () => 1500, count: 120 });
    const last = updates[updates.length - 1];
    expect(view.rightEdge(last.now + 500) - view.rightEdge(last.now)).toBeCloseTo(500, 6);
    expect(view.slewing(last.now + 500)).toBe(false);
    expect(last.headT).toBeGreaterThanOrEqual(view.rightEdge(last.now + 999));
  });

  it('adds just enough lag when the range ends at "now", so the line still reaches the edge', () => {
    const { view, updates } = simulate({ refreshMs: 1000, delay: () => 1500, count: 120, marginMs: 0 });
    const last = updates[updates.length - 1];
    // Delay 1.5 s + one refresh 1 s + safety 0.25 s.
    expect(view.lagAt(last.now)).toBeCloseTo(2750, 0);
    expect(last.headT).toBeGreaterThanOrEqual(view.rightEdge(last.now + 999));
    expect(view.slewing(last.now)).toBe(false);
  });

  it('never jumps when data arrives, at 1 s and 5 s refresh', () => {
    for (const refreshMs of [1000, 5000]) {
      const view = new GlideView();
      let prevEdge = NaN;
      for (let i = 0; i < 60; i++) {
        const arrival = 2_000_000 + i * refreshMs;
        const before = view.ready ? view.rightEdge(arrival) : NaN;
        view.update({
          now: arrival,
          arrival,
          lenMs: LEN,
          marginMs: 10_000,
          headT: arrival - (i % 7 === 3 ? 4000 : 1200),
          refreshMs,
          stepMs: refreshMs,
          jump: false,
        });
        if (before === before) {
          expect(view.rightEdge(arrival)).toBeCloseTo(before, 6);
        }
        if (prevEdge === prevEdge) {
          const advanced = view.rightEdge(arrival) - prevEdge;
          expect(advanced).toBeGreaterThan(refreshMs * 0.94);
          expect(advanced).toBeLessThan(refreshMs * 1.06);
        }
        prevEdge = view.rightEdge(arrival);
      }
    }
  });

  it('reveals genuinely late data progressively instead of popping it in', () => {
    // Calibrate on 1.5 s delays, then one response is 6 s late (a delivery spike).
    const { view, updates } = simulate({ refreshMs: 1000, delay: () => 1500, count: 60 });
    const last = updates[updates.length - 1];
    // Nothing arrives for 6 s; the data ends before the edge by now.
    const gapAt = last.now + 6000;
    expect(view.rightEdge(gapAt)).toBeGreaterThan(last.headT);
    const prevEnd = last.headT;
    view.update({ ...last, now: gapAt, arrival: gapAt, headT: gapAt - 1500, jump: false });
    expect(view.revealAt(gapAt)).toBeCloseTo(prevEnd, 6);
    expect(view.revealActive(gapAt + 100)).toBe(true);
    const mid = view.revealAt(gapAt + 500);
    expect(mid).toBeGreaterThan(prevEnd);
    expect(mid).toBeLessThan(gapAt - 1500);
    expect(view.revealAt(gapAt + 1000)).toBe(gapAt - 1500);
    expect(view.revealActive(gapAt + 1001)).toBe(false);
  });

  it('starts no reveal when the data already reached the right edge (nothing to reveal)', () => {
    const { view, updates } = simulate({ refreshMs: 5000, delay: () => 1500, count: 40 });
    const last = updates[updates.length - 1];
    expect(view.revealActive(last.now + 10)).toBe(false);
    expect(view.revealAt(last.now + 10)).toBe(Infinity);
  });

  it('infers the refresh interval when it is not known, ignoring duplicated arrivals', () => {
    const view = new GlideView();
    for (let i = 0; i < 20; i++) {
      const arrival = 3_000_000 + i * 5000;
      const u: ViewUpdate = {
        now: arrival,
        arrival,
        lenMs: LEN,
        marginMs: 10_000,
        headT: arrival - 1000,
        refreshMs: null,
        stepMs: 5000,
        jump: false,
      };
      view.update(u);
      // A duplicate delivery 20 ms later must not count as an interval.
      view.update({ ...u, now: arrival + 20, arrival: arrival + 20 });
    }
    expect(view.refreshMs()).toBe(5000);
  });

  it('places the window directly on a jump (range change)', () => {
    const { view, updates } = simulate({ refreshMs: 1000, delay: () => 1500, count: 30 });
    const last = updates[updates.length - 1];
    const now = last.now + 1000;
    view.update({ ...last, now, arrival: now, headT: now - 1500, lenMs: 15 * 60_000, marginMs: 10_000, jump: true });
    expect(view.rangeMs).toBe(15 * 60_000);
    expect(view.slewing(now + 1)).toBe(false);
    // The 10 s end margin already covers a 1.5 s delivery delay: no extra lag is needed.
    expect(view.lagAt(now)).toBe(0);
    expect(view.offsetAt(now)).toBe(10_000);
  });

  it('depends only on wall-clock time, so pausing and resuming is exact', () => {
    const { view, updates } = simulate({ refreshMs: 1000, delay: () => 1500, count: 30 });
    const last = updates[updates.length - 1];
    const a = view.rightEdge(last.now + 250);
    // Evaluating other times in between (as frames would) changes nothing.
    view.rightEdge(last.now + 100_000);
    view.revealAt(last.now + 100_000);
    expect(view.rightEdge(last.now + 250)).toBe(a);
  });
});
