import { GraphFieldConfig, OptionsWithLegend, OptionsWithTooltip } from '@grafana/schema';

/** Plugin-specific animation settings. Everything else mirrors the built-in time series panel. */
export interface GlideSettings {
  /** Master switch for the gliding animation. */
  enabled: boolean;
  /** Relative ranges longer than this (seconds) render statically. */
  maxRangeSec: number;
  /** Frame rate cap: 60, 30 or 0 (display refresh rate). */
  fps: number;
}

export interface GlideOptions extends OptionsWithLegend, OptionsWithTooltip {
  glide: GlideSettings;
}

/**
 * Same shape (and same property names) as the time series panel's field config, so a panel
 * can be switched between `timeseries` and this plugin without losing its settings.
 */
export type GlideFieldConfig = GraphFieldConfig;

export const defaultGlideSettings: GlideSettings = {
  enabled: true,
  maxRangeSec: 3600,
  fps: 60,
};
