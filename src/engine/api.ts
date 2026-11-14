import { GrafanaTheme2 } from '@grafana/data';
import { SortOrder, TooltipDisplayMode } from '@grafana/schema';

import { GlideModel } from '../data/model';
import { GlideSettings } from '../types';

/**
 * Contract between the React shell (components/) and the canvas engine (engine/).
 * The engine owns the canvas, the requestAnimationFrame loop, scales, axes, grid, series,
 * thresholds and the crosshair line. The shell owns the legend, the tooltip DOM, pointer
 * listeners, Grafana events and option plumbing.
 */

export interface TimeWindow {
  /** Absolute range the data was requested for, epoch ms. */
  from: number;
  to: number;
  /** True when both ends of the dashboard range are relative to now (e.g. now-5m .. now-6s). */
  relative: boolean;
  /** Date.now() at the moment `from`/`to` were evaluated. Anchors the range to wall-clock time. */
  evaluatedAt: number;
  /** Identity of the raw range, e.g. "now-5m|now-6s". A change means: jump, do not animate. */
  rawKey: string;
}

export interface EngineData {
  model: GlideModel;
  window: TimeWindow;
  /** performance.now() when this data reached the panel. */
  receivedAt: number;
  /** Dashboard refresh interval in ms when known, else null (the engine then infers it). */
  refreshMs: number | null;
}

export interface EngineStyle {
  theme: GrafanaTheme2;
  timeZone: string;
  glide: GlideSettings;
}

export interface HoverItem {
  key: string;
  name: string;
  color: string;
  /** Original (unsigned, unstacked) value at the hovered time; NaN when the series has no point there. */
  value: number;
  /** Value formatted with the field's display processor (unit, decimals). */
  text: string;
  /** True for the series closest to the pointer vertically. */
  nearest: boolean;
}

export interface HoverInfo {
  /** Hovered time (snapped to the nearest data point), epoch ms. */
  time: number;
  /** Position of the crosshair in CSS px, relative to the canvas' top-left corner. */
  x: number;
  y: number;
  /** One entry per visible, tooltip-enabled series, in model order (the shell sorts/filters). */
  items: HoverItem[];
  /** True when the hover comes from the local pointer, false when from another panel. */
  local: boolean;
}

export interface PlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GlideEngine {
  /** Size in CSS px. The engine handles devicePixelRatio itself. */
  resize(cssWidth: number, cssHeight: number): void;
  setStyle(style: EngineStyle): void;
  setData(data: EngineData): void;
  /** Series keys hidden through the legend. */
  setHidden(keys: ReadonlySet<string>): void;
  /** Local pointer in CSS px relative to the canvas; null when it left the plot. */
  setPointer(x: number | null, y: number | null): void;
  /**
   * Crosshair published by another panel; null to clear. relY is the pointer height in that
   * panel as a fraction of its plot (0 top, 1 bottom), when it published one.
   */
  setExternalCursor(timeMs: number | null, relY?: number): void;
  /**
   * Called at most once per animation frame, and only when the hover content changed. Fires
   * while the chart glides under a resting pointer too. `null` means: hide tooltip.
   */
  onHover: ((info: HoverInfo | null) => void) | null;
  /**
   * Called at most once per animation frame while the local pointer is over the plot, whenever
   * the time under it changes (also while the chart glides under a resting pointer), and with
   * null when the pointer leaves. The time is the exact time under the pointer, not snapped to a
   * data point, so crosshairs shared with other panels move smoothly.
   */
  onCursorMove: ((timeMs: number | null, relY: number) => void) | null;
  /** Time currently drawn at CSS x (relative to the canvas). */
  timeAtX(x: number): number;
  /** The plot area (inside the axes) in CSS px relative to the canvas. */
  plotRect(): PlotRect;
  /** True while the rAF loop is running (live, visible, on screen). */
  readonly animating: boolean;
  destroy(): void;
}

export interface TooltipSettings {
  mode: TooltipDisplayMode;
  sort: SortOrder;
  hideZeros: boolean;
  maxHeight?: number;
}

export type CreateEngine = (canvas: HTMLCanvasElement) => GlideEngine;
