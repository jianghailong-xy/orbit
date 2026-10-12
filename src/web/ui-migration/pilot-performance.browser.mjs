import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { installFixtures, installFixedDate, FIXED_NOW } from './fixtures.mjs';
import { installPilotFixtures, PILOT_PATHS } from './pilot-fixtures.mjs';

// P3.2 same-scenario timings, by P0.2's performance method (performance.browser.mjs): the pilot task
// loaded in fresh contexts, then its pilot interactions sampled in one session, on the reference and
// the delivery build alike. Also lists the JS/CSS the task route actually loaded (Resource Timing),
// for the same-scenario size comparison. One fixed browser/theme/viewport; no pass/fail threshold.
const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const host = () => ({ loadAverage: os.loadavg(), freeMemoryBytes: os.freemem(), cpuCount: os.cpus().length });
function statistics(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return { count: ordered.length, min: ordered[0], max: ordered.at(-1),
    median: ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2,
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1] };
}
const opaque = (locator) => expect.poll(() => locator.evaluate((element) => {
  for (let current = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.opacity !== '1' || style.visibility !== 'visible') return false;
  }
  return true;
})).toBe(true);

test('record pilot performance', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-light-desktop', 'Performance samples use one fixed browser/theme/viewport.');
  const report = {
    project: testInfo.project.name, browser: browser.version(), node: process.version, fixedDate: FIXED_NOW,
    observedAt: new Date().toISOString(), platform: `${os.platform()} ${os.release()} ${os.arch()}`, hostStart: host(),
    methodology: 'As p0.2 performance.browser.mjs: fresh contexts for loads (ready = pilot task title, its thumbnail and Suggested value visible, fonts ready, two frames); ten sequential samples per operation; intervals include Playwright transport, actionability, popups reaching opacity 1 and two frames.',
    loads: {}, operations: {}, resources: [],
  };
  const { baseURL, viewport, deviceScaleFactor, locale, timezoneId, reducedMotion, serviceWorkers } = testInfo.project.use;
  async function freshPage() {
    const context = await browser.newContext({ baseURL, viewport, deviceScaleFactor, locale, timezoneId, reducedMotion, serviceWorkers, colorScheme: 'light' });
    const page = await context.newPage();
    await installFixedDate(page);
    const api = await installFixtures(page, { theme: 'light' });
    await installPilotFixtures(page, { theme: 'light' });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    return { context, page, verify: () => { api.assertHandled(); expect(pageErrors).toEqual([]); } };
  }
  const ready = async (page) => {
    await expect(page.getByText('Migrate the task detail pilot', { exact: true }).last()).toBeVisible();
    await expect(page.locator('.task-detail-panel .tdp-input-thumb[src]')).toHaveCount(1);
    await expect(page.locator('.tdp-field').filter({ hasText: 'Suggested' })).toContainText('M · Sonnet 5.5 · medium');
  };
  try {
    const samples = [];
    for (let iteration = 1; iteration <= 5; iteration++) {
      const { context, page, verify } = await freshPage();
      try {
        const hostBefore = host();
        const start = performance.now();
        await page.goto(PILOT_PATHS.task);
        await ready(page);
        await page.evaluate(() => document.fonts.ready);
        await frames(page);
        const hostReadyMs = performance.now() - start;
        const timing = await page.evaluate(() => ({
          browserReadyMs: performance.now(),
          paint: performance.getEntriesByType('paint').map((entry) => entry.toJSON()),
          resources: performance.getEntriesByType('resource').filter((entry) => /\.(js|css)(\?|$)/.test(entry.name))
            .map((entry) => ({ name: new URL(entry.name).pathname, decodedBodySize: entry.decodedBodySize })),
        }));
        verify();
        if (iteration === 1) report.resources = timing.resources;
        samples.push({ iteration, hostBefore, hostReadyMs, browserReadyMs: timing.browserReadyMs, paint: timing.paint });
      } finally { await context.close(); }
    }
    report.loads.task = { path: PILOT_PATHS.task, samples,
      hostReadyMs: statistics(samples.map((sample) => sample.hostReadyMs)),
      browserReadyMs: statistics(samples.map((sample) => sample.browserReadyMs)) };

    const { context, page, verify } = await freshPage();
    try {
      await page.goto(PILOT_PATHS.task);
      await ready(page);
      await page.evaluate(() => document.fonts.ready);
      await frames(page);
      async function measure(name, operation) {
        const entry = report.operations[name] ??= { samples: [] };
        const hostBefore = host();
        const browserStart = await page.evaluate(() => performance.now());
        const start = performance.now();
        await operation();
        await frames(page);
        const browserMs = await page.evaluate((before) => performance.now() - before, browserStart);
        entry.samples.push({ iteration: entry.samples.length + 1, browserMs, hostMs: performance.now() - start, hostBefore });
      }
      const more = page.getByRole('button', { name: 'More actions', exact: true });
      const assignee = page.locator('.tdp-field').filter({ hasText: 'Assignee' }).getByRole('combobox');
      const view = page.locator('.tdp-dependency-view');
      const comment = page.locator('.tdp-compose').getByRole('textbox');
      for (let iteration = 1; iteration <= 10; iteration++) {
        await measure('more-menu-open', async () => {
          await more.click();
          await expect(page.getByRole('menuitem', { name: /Share/ })).toBeVisible();
          await opaque(page.getByRole('menuitem', { name: /Share/ }));
        });
        await measure('share-dialog-open', async () => {
          await page.getByRole('menuitem', { name: /Share/ }).click();
          await expect(page.getByRole('dialog', { name: 'Share task' }).getByRole('button', { name: 'Access' })).toBeVisible();
          await opaque(page.getByRole('dialog', { name: 'Share task' }));
        });
        // The dialog's own Close: on the reference build Escape also closed the task panel (P0.2-FOCUS-1).
        await measure('share-dialog-close', async () => {
          await page.getByRole('dialog', { name: 'Share task' }).getByRole('button', { name: 'Close', exact: true }).click();
          await expect(page.getByRole('dialog', { name: 'Share task' })).toBeHidden();
        });
        await measure('assignee-picker-open', async () => {
          await assignee.click();
          await expect(page.getByRole('option', { name: 'Orbit baseline', exact: true }).filter({ visible: true })).toBeVisible();
          await opaque(page.getByRole('option', { name: 'Orbit baseline', exact: true }).filter({ visible: true }));
        });
        await measure('assignee-picker-close', async () => {
          await page.keyboard.press('Escape');
          await expect(page.getByRole('option').filter({ visible: true })).toHaveCount(0);
        });
        await measure('dependency-view-toggle', async () => {
          const target = iteration % 2 ? 'List' : 'Graph';
          await view.getByText(target, { exact: true }).click();
          await expect(view.getByRole('radio', { name: target })).toBeChecked();
        });
        await measure('comment-fill', async () => {
          const value = `Pilot comment ${iteration}`;
          await comment.fill(value);
          await expect(comment).toHaveValue(value);
        });
      }
      verify();
      for (const operation of Object.values(report.operations)) {
        operation.browserMs = statistics(operation.samples.map((sample) => sample.browserMs));
        operation.hostMs = statistics(operation.samples.map((sample) => sample.hostMs));
      }
    } finally { await context.close(); }
  } finally {
    report.hostEnd = host();
    const path = testInfo.outputPath('performance.json');
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    await testInfo.attach('pilot-performance-samples', { path, contentType: 'application/json' });
  }
});
