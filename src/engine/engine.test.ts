import { createDataFrame, createTheme, FieldType } from '@grafana/data';

import { buildModel, ColorRegistry } from '../data/model';
import { defaultGlideSettings } from '../types';
import { EngineData, GlideEngine } from './api';
import { createEngineWith } from './engine';
import { EngineEnv } from './loop';

const NOW = 1_700_000_000_000;
const theme = createTheme();

/** An environment whose animation frames never fire unless the test runs them. */
function env(): { env: Partial<EngineEnv>; frames: Array<(t: number) => void>; clock: { t: number } } {
  const frames: Array<(t: number) => void> = [];
  const clock = { t: 1000 };
  return {
    frames,
    clock,
    env: {
      now: () => clock.t,
      dateNow: () => NOW + clock.t,
      requestFrame: (cb) => frames.push(cb),
      cancelFrame: () => {},
      devicePixelRatio: () => 1,
      doc: null,
      IntersectionObserver: null,
    },
  };
}

function data(): EngineData {
  const times = Array.from({ length: 60 }, (_, i) => NOW - 66_000 + i * 1000);
  const frame = createDataFrame({
    fields: [
      { name: 'time', type: FieldType.time, values: times },
      { name: 'a', type: FieldType.number, values: times.map((_, i) => i % 10) },
    ],
  });
  return {
    model: buildModel([frame], theme, new ColorRegistry(), 1000),
    window: { from: NOW - 300_000, to: NOW - 6000, relative: true, evaluatedAt: NOW, rawKey: 'now-5m|now-6s' },
    receivedAt: 1000,
    refreshMs: 1000,
  };
}

function setup(): {
  engine: GlideEngine;
  canvas: HTMLCanvasElement;
  clears: jest.SpyInstance;
  frames: Array<(t: number) => void>;
} {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const e = env();
  const engine = createEngineWith(canvas, e.env);
  engine.setStyle({ theme, timeZone: 'utc', glide: defaultGlideSettings });
  engine.resize(400, 200);
  engine.setData(data());
  // Let the pending frame draw once.
  e.frames.splice(0).forEach((cb) => cb(e.clock.t));
  const clears = jest.spyOn(ctx, 'clearRect');
  return { engine, canvas, clears, frames: e.frames };
}

describe('engine resize', () => {
  it('redraws synchronously when the canvas size changes, without waiting for an animation frame', () => {
    const { engine, canvas, clears } = setup();
    engine.resize(380, 200);
    expect(canvas.width).toBe(380);
    expect(clears).toHaveBeenCalled();
    engine.destroy();
  });

  it('does not touch the canvas buffer when only the CSS size changes within the same pixel size', () => {
    const { engine, canvas } = setup();
    const widthSetter = jest.fn();
    const proto = Object.getPrototypeOf(canvas);
    const desc = Object.getOwnPropertyDescriptor(proto, 'width')!;
    Object.defineProperty(canvas, 'width', {
      configurable: true,
      get: () => desc.get!.call(canvas),
      set: (v: number) => {
        widthSetter(v);
        desc.set!.call(canvas, v);
      },
    });
    engine.resize(400.3, 200);
    expect(widthSetter).not.toHaveBeenCalled();
    engine.destroy();
  });
});
