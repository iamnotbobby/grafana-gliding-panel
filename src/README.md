# Glide time series

A Grafana panel for live time series that glide. Between data refreshes the time axis keeps
scrolling at up to 60 frames per second and new points come in at the right edge, the way Netdata
charts move, instead of the whole chart jumping once per refresh.

It is meant for dashboards with a short relative time range and a fast refresh, for example
`now-5m` to `now-6s` with a 1 s refresh.

## Requirements

- Grafana 13.0 or newer.
- A relative time range. Absolute ranges, and ranges longer than the configured limit, are drawn
  statically.

## What it supports

The field options use the same names as the built-in **Time series** panel. Changing a panel's
`"type"` in the dashboard JSON between `timeseries` and `bobby-glide-panel` keeps every setting
in both directions. In the panel editor's visualization picker, switching to Glide keeps
everything too. Switching back to Time series keeps the field config, but Grafana resets the
legend and tooltip options to the Time series defaults.

- Lines with linear or step interpolation, line width, fill opacity and opacity gradient.
- Stacking (normal and percent), negative Y transform, connect null values.
- Thresholds as lines, dashed lines or regions.
- Min, max, soft min, soft max, linear or logarithmic scale, units and decimals.
- Legend as a list or table with calculations, at the bottom or on the right.
- Tooltip for one or all series, with sorting, hide zeros and max height.
- Shared crosshair and shared tooltip with other panels on the dashboard.
- Drag to zoom into a time range.
- Stable series colours when series appear and disappear.

Not drawn: points, bars, per-series line styles and multiple Y axes. Those settings are kept, so
they are still there when you switch back to the built-in panel.

## Panel options

| Option                           | Default | Meaning                                              |
| -------------------------------- | ------- | ---------------------------------------------------- |
| Glide                            | on      | Scroll the time axis continuously between refreshes. |
| Longest animated range (seconds) | 3600    | Longer or absolute time ranges are drawn statically. |
| Frame rate cap                   | 60      | 60, 30, or Off (follow the display refresh rate).    |

## Notes

- The plugin is frontend only. It makes no network requests and bundles everything it needs.
- All colours come from the Grafana theme.
- It works best when the end of the time range is a little in the past (for example `now-6s`),
  so that samples still in flight are never on screen.
