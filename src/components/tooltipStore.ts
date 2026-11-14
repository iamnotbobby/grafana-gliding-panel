import { SortOrder, TooltipDisplayMode } from '@grafana/schema';

import { buildTooltipRows, Placement, placeTooltip, TooltipRow } from '../data/tooltip';
import { HoverInfo, HoverItem, TooltipSettings } from '../engine/api';

export interface TooltipSnapshot {
  /** Hovered time, epoch ms. */
  time: number;
  rows: TooltipRow[];
  /** All series are listed (multi mode, or a cursor shared by another panel). */
  multi: boolean;
  /** False when the tooltip follows another panel's cursor. */
  local: boolean;
}

/** Distance between the pointer and the tooltip, as in Grafana's own tooltips. */
const TOOLTIP_OFFSET = 10;
/** Room kept free for a page scrollbar on the right and bottom edge. */
const SCROLLBAR_ALLOWANCE = 16;

function sameNumber(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b);
}

/**
 * Tooltip state outside React: only a change of content notifies subscribers, position changes
 * are written straight to the DOM. Keeps its own copy of the items because the engine reuses its
 * HoverInfo.
 */
export class TooltipStore {
  private listeners = new Set<() => void>();
  private snapshot: TooltipSnapshot | null = null;

  private mode: TooltipDisplayMode = TooltipDisplayMode.Single;
  private sort: SortOrder = SortOrder.None;
  private hideZeros = false;

  private has = false;
  private time = NaN;
  private local = false;
  private forceMulti = false;
  private items: HoverItem[] = [];
  private count = 0;

  private anchorEl: HTMLElement | null = null;
  private tipEl: HTMLElement | null = null;
  /** Last local pointer position in viewport coordinates; NaN when unknown. */
  private pointerX = NaN;
  private pointerY = NaN;
  /** Crosshair position reported by the engine, relative to the anchor element. */
  private hoverX = 0;
  private hoverY = 0;
  private tipWidth = 0;
  private tipHeight = 0;
  private placedX = NaN;
  private placedY = NaN;
  private placement: Placement = { x: 0, y: 0 };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): TooltipSnapshot | null => this.snapshot;

  configure(settings: TooltipSettings): void {
    const { mode, sort, hideZeros } = settings;
    if (this.mode === mode && this.sort === sort && this.hideZeros === hideZeros) {
      return;
    }
    this.mode = mode;
    this.sort = sort;
    this.hideZeros = hideZeros;
    if (this.has) {
      this.rebuild();
    }
  }

  /** The element (the canvas) that engine hover coordinates are relative to. */
  setAnchorElement(el: HTMLElement | null): void {
    this.anchorEl = el;
  }

  setTooltipElement(el: HTMLElement | null): void {
    this.tipEl = el;
    this.placedX = NaN;
    this.placedY = NaN;
  }

  /** Viewport coordinates. */
  setPointer(clientX: number, clientY: number): void {
    this.pointerX = clientX;
    this.pointerY = clientY;
    const snap = this.snapshot;
    if (snap !== null && snap.local) {
      this.reposition();
    }
  }

  /** The local pointer left the chart. */
  clearPointer(): void {
    this.pointerX = NaN;
    this.pointerY = NaN;
    if (this.has && this.local) {
      this.update(null, false);
    }
  }

  /** `forceMulti` lists all series regardless of the configured mode. */
  update(info: HoverInfo | null, forceMulti: boolean): void {
    if (info === null) {
      if (this.has) {
        this.has = false;
        this.count = 0;
        this.publish(null);
      }
      return;
    }

    const src = info.items;
    const n = src.length;
    let changed =
      !this.has ||
      this.time !== info.time ||
      this.local !== info.local ||
      this.forceMulti !== forceMulti ||
      this.count !== n;

    const own = this.items;
    for (let i = 0; i < n; i++) {
      const s = src[i];
      let o = own[i];
      if (o === undefined) {
        o = { key: '', name: '', color: '', value: NaN, text: '', nearest: false };
        own[i] = o;
        changed = true;
      }
      if (
        changed ||
        o.text !== s.text ||
        o.nearest !== s.nearest ||
        o.key !== s.key ||
        o.color !== s.color ||
        o.name !== s.name ||
        !sameNumber(o.value, s.value)
      ) {
        changed = true;
        o.key = s.key;
        o.name = s.name;
        o.color = s.color;
        o.value = s.value;
        o.text = s.text;
        o.nearest = s.nearest;
      }
    }

    this.has = true;
    this.time = info.time;
    this.local = info.local;
    this.forceMulti = forceMulti;
    this.count = n;
    this.hoverX = info.x;
    this.hoverY = info.y;

    if (changed) {
      this.rebuild();
    } else {
      this.reposition();
    }
  }

  /** Called after the tooltip rendered new content. */
  measure(): void {
    const tip = this.tipEl;
    if (tip === null) {
      return;
    }
    this.tipWidth = tip.offsetWidth;
    this.tipHeight = tip.offsetHeight;
    this.reposition();
  }

  private reposition(): void {
    const tip = this.tipEl;
    const snap = this.snapshot;
    if (tip === null || snap === null) {
      return;
    }

    let anchorX: number;
    let anchorY: number;
    if (snap.local && this.pointerX === this.pointerX) {
      anchorX = this.pointerX;
      anchorY = this.pointerY;
    } else {
      const anchor = this.anchorEl;
      if (anchor === null) {
        return;
      }
      const rect = anchor.getBoundingClientRect();
      anchorX = rect.left + this.hoverX;
      anchorY = rect.top + this.hoverY;
    }

    const p = placeTooltip(
      anchorX,
      anchorY,
      this.tipWidth,
      this.tipHeight,
      window.innerWidth - SCROLLBAR_ALLOWANCE,
      window.innerHeight - SCROLLBAR_ALLOWANCE,
      TOOLTIP_OFFSET,
      this.placement
    );
    if (p.x !== this.placedX || p.y !== this.placedY) {
      this.placedX = p.x;
      this.placedY = p.y;
      tip.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
  }

  private rebuild(): void {
    let mode = this.mode;
    if (mode !== TooltipDisplayMode.None && this.forceMulti) {
      mode = TooltipDisplayMode.Multi;
    }
    if (mode === TooltipDisplayMode.None) {
      this.publish(null);
      return;
    }
    const rows = buildTooltipRows(this.items, this.count, mode, this.sort, this.hideZeros);
    const multi = mode === TooltipDisplayMode.Multi;
    if (!multi && rows.length === 0) {
      this.publish(null);
      return;
    }
    this.publish({ time: this.time, rows, multi, local: this.local });
  }

  private publish(snapshot: TooltipSnapshot | null): void {
    if (snapshot === null && this.snapshot === null) {
      return;
    }
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
