import { FieldColorModeId, FieldConfigProperty, FieldType, PanelModel, PanelPlugin } from '@grafana/data';
import {
  GraphDrawStyle,
  GraphGradientMode,
  GraphThresholdsStyleMode,
  GraphTransform,
  LineInterpolation,
  ScaleDistribution,
  SortOrder,
  StackingMode,
  TooltipDisplayMode,
} from '@grafana/schema';
import { commonOptionsBuilder } from '@grafana/ui';

import { GlidePanel } from './components/GlidePanel';
import { defaultGlideSettings, GlideFieldConfig, GlideOptions } from './types';

const STYLE = ['Graph styles'];
const AXIS = ['Axis'];
const GLIDE = ['Glide animation'];

/**
 * Time series settings this panel does not draw. They are registered (hidden) so Grafana keeps
 * their values when the panel type is switched to Glide and back again.
 */
const PASS_THROUGH = [
  'pointSize',
  'showPoints',
  'showValues',
  'barAlignment',
  'barWidthFactor',
  'barMaxWidth',
  'lineStyle',
  'lineColor',
  'fillColor',
  'fillBelowTo',
  'insertNulls',
  'axisPlacement',
  'axisLabel',
  'axisWidth',
  'axisColorMode',
  'axisBorderShow',
  'axisCenteredZero',
  'axisGridShow',
];

const HiddenEditor = () => null;

export const plugin = new PanelPlugin<GlideOptions, GlideFieldConfig>(GlidePanel)
  .useFieldConfig({
    standardOptions: {
      [FieldConfigProperty.Color]: {
        settings: { byValueSupport: false, bySeriesSupport: true, preferThresholdsMode: false },
        defaultValue: { mode: FieldColorModeId.PaletteClassic },
      },
    },
    useCustomConfig: (builder) => {
      builder
        .addRadio({
          path: 'drawStyle',
          name: 'Style',
          category: STYLE,
          defaultValue: GraphDrawStyle.Line,
          settings: {
            options: [{ label: 'Lines', value: GraphDrawStyle.Line }],
          },
          hideFromDefaults: true,
          hideFromOverrides: true,
        })
        .addRadio({
          path: 'lineInterpolation',
          name: 'Line interpolation',
          category: STYLE,
          defaultValue: LineInterpolation.Linear,
          settings: {
            options: [
              { label: 'Linear', value: LineInterpolation.Linear },
              { label: 'Step before', value: LineInterpolation.StepBefore },
              { label: 'Step after', value: LineInterpolation.StepAfter },
            ],
          },
        })
        .addSliderInput({
          path: 'lineWidth',
          name: 'Line width',
          category: STYLE,
          defaultValue: 1,
          settings: { min: 0, max: 10, step: 1 },
        })
        .addSliderInput({
          path: 'fillOpacity',
          name: 'Fill opacity',
          category: STYLE,
          defaultValue: 0,
          settings: { min: 0, max: 100, step: 1 },
        })
        .addRadio({
          path: 'gradientMode',
          name: 'Gradient mode',
          category: STYLE,
          defaultValue: GraphGradientMode.None,
          settings: {
            options: [
              { label: 'None', value: GraphGradientMode.None },
              { label: 'Opacity', value: GraphGradientMode.Opacity },
            ],
          },
        })
        .addRadio({
          path: 'spanNulls',
          name: 'Connect null values',
          category: STYLE,
          defaultValue: false,
          settings: {
            options: [
              { label: 'Never', value: false },
              { label: 'Always', value: true },
            ],
          },
        })
        .addSelect({
          path: 'transform',
          name: 'Transform',
          category: STYLE,
          settings: {
            isClearable: true,
            options: [
              { label: 'Negative Y', value: GraphTransform.NegativeY },
              { label: 'Constant', value: GraphTransform.Constant },
            ],
          },
          hideFromDefaults: true,
        })
        .addRadio({
          path: 'thresholdsStyle.mode',
          name: 'Show thresholds',
          category: ['Thresholds'],
          defaultValue: GraphThresholdsStyleMode.Off,
          settings: {
            options: [
              { label: 'Off', value: GraphThresholdsStyleMode.Off },
              { label: 'Lines', value: GraphThresholdsStyleMode.Line },
              { label: 'Dashed lines', value: GraphThresholdsStyleMode.Dashed },
              { label: 'Filled regions', value: GraphThresholdsStyleMode.Area },
              { label: 'Regions and lines', value: GraphThresholdsStyleMode.LineAndArea },
              { label: 'Regions and dashed lines', value: GraphThresholdsStyleMode.DashedAndArea },
            ],
          },
          hideFromOverrides: true,
        })
        .addNumberInput({
          path: 'axisSoftMin',
          name: 'Soft min',
          category: AXIS,
          settings: { placeholder: 'auto' },
        })
        .addNumberInput({
          path: 'axisSoftMax',
          name: 'Soft max',
          category: AXIS,
          settings: { placeholder: 'auto' },
        })
        .addRadio({
          path: 'scaleDistribution.type',
          name: 'Scale',
          category: AXIS,
          defaultValue: ScaleDistribution.Linear,
          settings: {
            options: [
              { label: 'Linear', value: ScaleDistribution.Linear },
              { label: 'Logarithmic', value: ScaleDistribution.Log },
            ],
          },
          hideFromOverrides: true,
        })
        .addRadio({
          path: 'scaleDistribution.log',
          name: 'Log base',
          category: AXIS,
          // No default, like the time series panel, so switching types adds no change. Unset is base 10.
          settings: {
            options: [
              { label: '2', value: 2 },
              { label: '10', value: 10 },
            ],
          },
          showIf: (c) => c.scaleDistribution?.type === ScaleDistribution.Log,
          hideFromOverrides: true,
        });

      commonOptionsBuilder.addStackingConfig(builder, { mode: StackingMode.None, group: 'A' }, STYLE);
      commonOptionsBuilder.addHideFrom(builder);

      for (const path of PASS_THROUGH) {
        builder.addCustomEditor({
          id: path,
          path,
          name: path,
          editor: HiddenEditor,
          override: HiddenEditor,
          process: (v) => v,
          shouldApply: (f) => f.type === FieldType.number,
          hideFromDefaults: true,
          hideFromOverrides: true,
        });
      }
    },
  })
  .setPanelOptions((builder) => {
    commonOptionsBuilder.addTooltipOptions(builder, false, false, {
      tooltip: { mode: TooltipDisplayMode.Single, sort: SortOrder.None, hideZeros: false },
    });
    commonOptionsBuilder.addLegendOptions(builder);

    builder
      .addBooleanSwitch({
        path: 'glide.enabled',
        name: 'Glide',
        description: 'Scroll the time axis continuously between refreshes.',
        category: GLIDE,
        defaultValue: defaultGlideSettings.enabled,
      })
      .addNumberInput({
        path: 'glide.maxRangeSec',
        name: 'Longest animated range (seconds)',
        description: 'Longer or absolute time ranges are drawn statically.',
        category: GLIDE,
        defaultValue: defaultGlideSettings.maxRangeSec,
        settings: { min: 10, integer: true },
        showIf: (o) => o.glide?.enabled !== false,
      })
      .addRadio({
        path: 'glide.fps',
        name: 'Frame rate cap',
        category: GLIDE,
        defaultValue: defaultGlideSettings.fps,
        settings: {
          options: [
            { label: '60', value: 60 },
            { label: '30', value: 30 },
            { label: 'Off', value: 0 },
          ],
        },
        showIf: (o) => o.glide?.enabled !== false,
      });
  })
  .setPanelChangeHandler(
    (panel: PanelModel<Partial<GlideOptions>>, prevPluginId: string, prevOptions: Record<string, any>) => {
      // Carry legend and tooltip settings over from the built-in time series panel.
      const next: Partial<GlideOptions> = { ...panel.options };
      if (prevPluginId === 'timeseries' && prevOptions) {
        const prev = prevOptions.options ?? prevOptions;
        if (prev.legend) {
          next.legend = prev.legend;
        }
        if (prev.tooltip) {
          next.tooltip = prev.tooltip;
        }
      }
      return next;
    }
  );
