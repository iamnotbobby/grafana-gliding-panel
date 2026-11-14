import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConsoleMessage, Locator, Page } from '@playwright/test';
import { expect, test } from '@grafana/plugin-e2e';

const DASHBOARD_FILE = 'glide-test-local.json';
const PLUGIN_ID = 'bobby-glide-panel';

interface ProvisionedPanel {
  id: number;
  type: string;
  title: string;
}

// Read from the provisioning file, so the spec follows the dashboard.
const provisioned: { panels: ProvisionedPanel[] } = JSON.parse(
  readFileSync(join(process.cwd(), 'provisioning', 'dashboards', DASHBOARD_FILE), 'utf8')
);
const glidePanels = provisioned.panels.filter((p) => p.type === PLUGIN_ID);

// Grafana only mounts visible panels, so the viewport must fit the whole dashboard.
test.use({ viewport: { width: 1600, height: 2000 } });

/**
 * Console errors raised by this plugin. Grafana and its bundled apps log their own errors (for
 * example the Enterprise images' assistant app when it cannot reach its feature flag service), so
 * only messages whose text, source or stack points at this plugin count. Crashes inside a panel
 * also show as an error icon on the panel, which the tests check separately.
 */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  const ours = (...parts: Array<string | undefined>) => parts.some((part) => part?.includes(PLUGIN_ID));
  page.on('console', (msg: ConsoleMessage) => {
    const url = msg.location().url;
    if (msg.type() === 'error' && ours(msg.text(), url)) {
      errors.push(`${msg.text()} (${url})`);
    }
  });
  page.on('pageerror', (err) => {
    if (ours(err.message, err.stack)) {
      errors.push(`uncaught: ${err.message}`);
    }
  });
  return errors;
}

/**
 * Number of distinct colours in a screenshot of the element. An empty canvas shows only the flat
 * panel background, a single colour.
 */
async function distinctColours(page: Page, target: Locator): Promise<number> {
  const png = await target.screenshot();
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return 0;
    }
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (seen.size > 64) {
        break;
      }
    }
    return seen.size;
  }, png.toString('base64'));
}

/** The largest colour count over the visible canvases of a panel. */
async function richestCanvas(page: Page, panel: Locator): Promise<number> {
  const canvases = panel.locator('canvas');
  const count = await canvases.count();
  let best = 0;
  for (let i = 0; i < count; i++) {
    const canvas = canvases.nth(i);
    if (await canvas.isVisible()) {
      best = Math.max(best, await distinctColours(page, canvas));
    }
  }
  return best;
}

test('the provisioned dashboard contains Glide panels', () => {
  expect(glidePanels.length).toBeGreaterThan(0);
});

test('Glide panels draw their data on a canvas without console errors', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
  page,
}) => {
  const errors = collectErrors(page);
  const dashboard = await readProvisionedDashboard({ fileName: DASHBOARD_FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });

  for (const def of glidePanels) {
    await test.step(def.title, async () => {
      const panel = dashboardPage.getPanelByTitle(def.title);
      await panel.scrollIntoView();
      await expect(panel.locator).toBeVisible();
      await expect(panel.getErrorIcon()).toHaveCount(0);

      const canvas = panel.locator.locator('canvas').first();
      await expect(canvas).toBeVisible();
      const box = await canvas.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(100);
      expect(box?.height ?? 0).toBeGreaterThan(50);

      // Drawn data gives far more than a handful of colours. The first result arrives a moment
      // after the panel mounts.
      await expect
        .poll(() => richestCanvas(page, panel.locator), {
          message: `canvas of "${def.title}" stays empty`,
          timeout: 20_000,
        })
        .toBeGreaterThan(8);
    });
  }

  // Let a few 1 s refresh cycles pass before judging the console.
  await page.waitForTimeout(3000);
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a Glide panel keeps moving between data refreshes', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
  page,
}) => {
  const dashboard = await readProvisionedDashboard({ fileName: DASHBOARD_FILE });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = dashboardPage.getPanelByTitle(glidePanels[0].title);
  const canvas = panel.locator.locator('canvas').first();
  await expect(canvas).toBeVisible();
  await expect.poll(() => richestCanvas(page, panel.locator), { timeout: 20_000 }).toBeGreaterThan(8);

  // Screenshots 150 ms apart mostly fall between two 1 s refreshes, so a panel that only redraws
  // on new data would produce identical pairs.
  let changed = 0;
  const pairs = 6;
  for (let i = 0; i < pairs; i++) {
    const a = await canvas.screenshot();
    await page.waitForTimeout(150);
    const b = await canvas.screenshot();
    if (!a.equals(b)) {
      changed++;
    }
  }
  expect(changed).toBeGreaterThanOrEqual(pairs - 1);
});
