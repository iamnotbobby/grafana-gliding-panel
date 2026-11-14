import { DashboardCursorSync, DataHoverClearEvent, DataHoverEvent, DataHoverPayload, EventBus } from '@grafana/data';

/** At most one publish per 60 Hz frame. */
export const HOVER_THROTTLE_MS = 16;

interface Subscription {
  unsubscribe(): void;
}

/** Shared crosshair over the dashboard event bus (DataHoverEvent with `point.time`). */
export class CursorSync {
  private modeSource: (() => DashboardCursorSync) | null = null;
  private onExternal: ((timeMs: number | null, relY?: number) => void) | null = null;

  // Reused event objects with one mutated payload, as recommended for this high-frequency event.
  private payload: DataHoverPayload = { point: { time: null, panelRelY: null } };
  private plainHover = new DataHoverEvent(this.payload);
  private plainClear = new DataHoverClearEvent();
  private taggedHover = new DataHoverEvent(this.payload).setTags(['uplot']);
  private taggedClear = new DataHoverClearEvent().setTags(['uplot']);
  private hoverEvent = this.plainHover;
  private clearEvent = this.plainClear;
  private bridged = false;

  private bus: EventBus | null = null;
  private subscriptions: Subscription[] = [];

  /** Other panels show a cursor that this panel published. */
  private active = false;
  private publishedTime = NaN;
  private pendingTime = NaN;
  private pendingRelY = 0;
  private lastPublishAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** The dashboard sync mode can change at any time, so it is read on every event. */
  setModeSource(source: () => DashboardCursorSync): void {
    this.modeSource = source;
  }

  /** Receives the time another panel hovers, or null when that hover ended. */
  setExternalHandler(handler: ((timeMs: number | null, relY?: number) => void) | null): void {
    this.onExternal = handler;
  }

  /**
   * While the uPlot sync bridge is connected, outgoing events are tagged "uplot" so the built-in
   * panels skip them, and incoming "uplot" events are ignored because the bridge delivers them.
   */
  setBridged(bridged: boolean): void {
    this.bridged = bridged;
    this.hoverEvent = bridged ? this.taggedHover : this.plainHover;
    this.clearEvent = bridged ? this.taggedClear : this.plainClear;
  }

  private mode(): DashboardCursorSync {
    return this.modeSource !== null ? this.modeSource() : DashboardCursorSync.Off;
  }

  connect(bus: EventBus): void {
    this.disconnect();
    this.bus = bus;
    this.subscriptions.push(
      bus.subscribe(DataHoverEvent, (event) => {
        if (this.isOwn(event) || this.mode() === DashboardCursorSync.Off || this.fromBridge(event)) {
          return;
        }
        // Legend hovers publish this event too, without a point: not a cursor.
        const time: unknown = event.payload?.point?.time;
        if (typeof time === 'number' && isFinite(time)) {
          const relY: unknown = event.payload?.point?.panelRelY;
          this.onExternal?.(time, typeof relY === 'number' && isFinite(relY) ? relY : undefined);
        }
      }),
      bus.subscribe(DataHoverClearEvent, (event) => {
        if (this.isOwn(event) || this.fromBridge(event)) {
          return;
        }
        this.onExternal?.(null);
      })
    );
  }

  disconnect(): void {
    this.clear();
    for (const s of this.subscriptions) {
      s.unsubscribe();
    }
    this.subscriptions.length = 0;
    this.bus = null;
  }

  /** Publishes changes only, throttled; the latest value is sent when the window ends. */
  hover(timeMs: number, panelRelY: number): void {
    if (this.bus === null || this.mode() === DashboardCursorSync.Off) {
      return;
    }
    this.pendingRelY = panelRelY;
    if (timeMs === this.publishedTime && this.active) {
      this.pendingTime = NaN;
      return;
    }
    this.pendingTime = timeMs;
    if (this.timer !== null) {
      return;
    }
    const wait = this.lastPublishAt + HOVER_THROTTLE_MS - performance.now();
    if (wait <= 0) {
      this.flush();
    } else {
      this.timer = setTimeout(this.onTimer, wait);
    }
  }

  /** The local hover ended. */
  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingTime = NaN;
    if (this.active) {
      this.active = false;
      this.publishedTime = NaN;
      this.bus?.publish(this.clearEvent);
    }
  }

  private onTimer = (): void => {
    this.timer = null;
    this.flush();
  };

  private flush(): void {
    const time = this.pendingTime;
    if (time !== time || this.bus === null) {
      return;
    }
    this.pendingTime = NaN;
    this.publishedTime = time;
    this.active = true;
    this.lastPublishAt = performance.now();
    this.payload.point.time = time;
    this.payload.point.panelRelY = this.pendingRelY;
    this.bus.publish(this.hoverEvent);
  }

  private isOwn(event: DataHoverEvent | DataHoverClearEvent): boolean {
    return (
      event === this.plainHover ||
      event === this.plainClear ||
      event === this.taggedHover ||
      event === this.taggedClear ||
      (event.origin != null && event.origin === this.bus)
    );
  }

  private fromBridge(event: DataHoverEvent | DataHoverClearEvent): boolean {
    return this.bridged && event.tags !== undefined && event.tags.has('uplot');
  }
}
