/**
 * Frame scheduling: a continuous requestAnimationFrame loop while animating, single frames
 * otherwise, paused while the page is hidden or the canvas is off screen. All clocks and
 * browser hooks come from an injectable environment so tests are deterministic.
 */

export interface EngineEnv {
  /** Monotonic clock in ms, same time base as requestAnimationFrame timestamps. */
  now(): number;
  /** Wall-clock time, epoch ms. */
  dateNow(): number;
  requestFrame(cb: (time: number) => void): number;
  cancelFrame(id: number): void;
  devicePixelRatio(): number;
  /** Document for visibility tracking and helper canvases; null when there is none. */
  doc: Document | null;
  /** IntersectionObserver constructor; null disables off-screen detection. */
  IntersectionObserver: typeof IntersectionObserver | null;
}

export function defaultEnv(): EngineEnv {
  const hasWindow = typeof window !== 'undefined';
  return {
    now: () => performance.now(),
    dateNow: () => Date.now(),
    requestFrame: (cb) =>
      hasWindow ? window.requestAnimationFrame(cb) : (setTimeout(() => cb(performance.now()), 16) as unknown as number),
    cancelFrame: (id) => (hasWindow ? window.cancelAnimationFrame(id) : clearTimeout(id)),
    devicePixelRatio: () => (hasWindow && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1),
    doc: typeof document !== 'undefined' ? document : null,
    IntersectionObserver: typeof IntersectionObserver !== 'undefined' ? IntersectionObserver : null,
  };
}

/** Tolerance (ms) for frame rate capping, so frames that come slightly early are not skipped. */
const FPS_TOLERANCE_MS = 2;

export class FrameLoop {
  private running = false;
  private loopId = 0;
  private singleId = 0;
  private wanted = false;
  private docHidden = false;
  private onScreen = true;
  private destroyed = false;
  private intervalMs = 0;
  private nextDue = 0;
  private observer: IntersectionObserver | null = null;

  constructor(
    private readonly env: EngineEnv,
    target: Element,
    private readonly draw: (time: number) => void
  ) {
    const doc = env.doc;
    if (doc !== null) {
      this.docHidden = doc.hidden;
      doc.addEventListener('visibilitychange', this.onVisibility);
    }
    const IO = env.IntersectionObserver;
    if (IO !== null) {
      this.observer = new IO(this.onIntersect);
      this.observer.observe(target);
    }
  }

  /** True while the continuous loop runs. */
  get animating(): boolean {
    return this.running;
  }

  /** Whether the chart wants continuous animation (gliding mode). */
  setWanted(wanted: boolean): void {
    this.wanted = wanted;
    this.sync();
  }

  /** Frame rate cap: 0 for the display rate. */
  setFps(fps: number): void {
    this.intervalMs = fps > 0 ? 1000 / fps : 0;
  }

  /**
   * Requests one frame. While the loop runs the next loop frame serves it; otherwise a single
   * frame is scheduled (it fires when the page is visible).
   */
  request(): void {
    if (this.destroyed || this.running || this.singleId !== 0) {
      return;
    }
    this.singleId = this.env.requestFrame(this.single);
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    if (this.singleId !== 0) {
      this.env.cancelFrame(this.singleId);
      this.singleId = 0;
    }
    this.env.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.observer?.disconnect();
    this.observer = null;
  }

  private sync(): void {
    const run = this.wanted && !this.docHidden && this.onScreen && !this.destroyed;
    if (run && !this.running) {
      this.running = true;
      this.nextDue = 0;
      if (this.singleId !== 0) {
        this.env.cancelFrame(this.singleId);
        this.singleId = 0;
      }
      this.loopId = this.env.requestFrame(this.tick);
    } else if (!run && this.running) {
      this.stop();
      if (!this.wanted) {
        // Leaving animation: draw the static picture once.
        this.request();
      }
    }
  }

  private stop(): void {
    if (this.running) {
      this.running = false;
      this.env.cancelFrame(this.loopId);
      this.loopId = 0;
    }
  }

  private tick = (time: number): void => {
    if (!this.running) {
      return;
    }
    this.loopId = this.env.requestFrame(this.tick);
    const interval = this.intervalMs;
    if (interval > 0) {
      if (time + FPS_TOLERANCE_MS < this.nextDue) {
        return;
      }
      this.nextDue += interval;
      if (this.nextDue < time) {
        this.nextDue = time + interval;
      }
    }
    this.draw(time);
  };

  private single = (time: number): void => {
    this.singleId = 0;
    if (!this.running && !this.destroyed) {
      this.draw(time);
    }
  };

  private onVisibility = (): void => {
    const doc = this.env.doc;
    this.docHidden = doc !== null && doc.hidden;
    this.sync();
  };

  private onIntersect = (entries: IntersectionObserverEntry[]): void => {
    const last = entries[entries.length - 1];
    if (last !== undefined) {
      this.onScreen = last.isIntersecting;
      this.sync();
    }
  };
}
