import type { PluginOptions } from '@grafana/plugin-e2e';
import { defineConfig } from '@playwright/test';
import baseConfig from './.config/playwright.config';

// Extend the base config here; see
// https://grafana.com/developers/plugin-tools/how-to-guides/extend-configurations#extend-the-playwright-config
export default defineConfig<PluginOptions>(baseConfig, {});
