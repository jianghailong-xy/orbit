import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { installFixtures, installFixedDate, FIXED_NOW, PATHS } from './fixtures.mjs';

const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const host = () => ({ loadAverage: os.loadavg(), freeMemoryBytes: os.freemem(), cpuCount: os.cpus().length });
function statistics(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return { count: ordered.length, min: ordered[0], max: ordered.at(-1),
    median: ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2,
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1] };
}

test('record browser performance baseline', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-light-desktop', 'Performance samples use one fixed browser/theme/viewport.');
  const report = {
    project: testInfo.project.name, browser: browser.version(), node: process.version,
    fixedDate: FIXED_NOW, observedAt: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`, hostStart: host(),
    methodology: {
      loads: 'Five fresh browser contexts per route; routing disables HTTP cache. Browser process, OS file cache and local preview server are shared. Ready means visible route content, fonts ready and two animation frames.',
      operations: 'Ten sequential samples per operation after session ready. Browser and host intervals include Playwright command transport, actionability checks, menu ancestors reaching opacity 1, and two animation frames; these are observed end-to-end intervals, not isolated React render times.',
      clock: 'A Date-only proxy fixes no-argument Date construction, Date() and Date.now. Native timers, requestAnimationFrame, performance.now and the Performance Timeline are not replaced.',
      percentile: 'p95 is nearest rank; median averages the middle pair for even sample counts.',
      scope: 'Local production preview with deterministic REST/SSE fixtures; no backend/network latency, CPU throttling or pass/fail performance threshold.',
    },
    loads: {}, operations: {},
  };
  const { baseURL, viewport, deviceScaleFactor, locale, timezoneId, reducedMotion, serviceWorkers } = testInfo.project.use;
  async function freshPage() {
    const context = await browser.newContext({ baseURL, viewport, deviceScaleFactor, locale, timezoneId, reducedMotion, serviceWorkers, colorScheme: 'light' });
    const page = await context.newPage();
    await installFixedDate(page);
    const api = await installFixtures(page, { theme: 'light' });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    return { context, page, verify: () => { api.assertHandled(); expect(pageErrors).toEqual([]); } };
  }
  const ready = {
    task: async (page) => {
      await expect(page.getByText('Review the visual baseline', { exact: true }).last()).toBeVisible();
      await expect(page.getByRole('button', { name: 'More actions', exact: true })).toBeVisible();
    },
    project: async (page) => {
      await expect(page.getByRole('heading', { name: 'Orbit UI migration', exact: true })).toBeVisible();
      await expect(page.getByTestId('project-dependency-graph')).toBeVisible();
      await expect(page.locator('.pdg-task-title')).toHaveCount(3);
    },
    session: async (page) => {
      await expect(page.locator('.composer-field textarea')).toBeVisible();
      await expect(page.locator('.composer-field textarea')).toBeEnabled();
      await expect(page.getByText('existing interface', { exact: true })).toBeVisible();
    },
  };
  try {
    for (const route of ['task', 'project', 'session']) {
      const samples = [];
      for (let iteration = 1; iteration <= 5; iteration++) {
        const { context, page, verify } = await freshPage();
        try {
          const hostBefore = host();
          const start = performance.now();
          await page.goto(PATHS[route]);
          await ready[route](page);
          await page.evaluate(() => document.fonts.ready);
          await frames(page);
          const hostReadyMs = performance.now() - start;
          const timing = await page.evaluate(() => ({
            browserReadyMs: performance.now(),
            navigation: performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
            paint: performance.getEntriesByType('paint').map((entry) => entry.toJSON()),
            dateNow: Date.now(), dateISO: new Date().toISOString(), dateCall: Date(),
            viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale },
          }));
          expect(timing.navigation, 'Native Navigation Timing must remain available').toHaveLength(1);
          expect(timing.paint.map((entry) => entry.name), 'Native Paint Timing must include rendered content').toContain('first-contentful-paint');
          expect(timing.dateNow).toBe(Date.parse(FIXED_NOW));
          expect(timing.dateISO).toBe(FIXED_NOW);
          expect(Date.parse(timing.dateCall)).toBe(Date.parse(FIXED_NOW));
          verify();
          samples.push({ iteration, hostBefore, hostReadyMs, ...timing });
        } finally { await context.close(); }
      }
      report.loads[route] = { path: PATHS[route], samples,
        hostReadyMs: statistics(samples.map((sample) => sample.hostReadyMs)),
        browserReadyMs: statistics(samples.map((sample) => sample.browserReadyMs)) };
    }
    const { context, page, verify } = await freshPage();
    try {
      await page.goto(PATHS.session);
      await ready.session(page);
      await page.evaluate(() => document.fonts.ready);
      await frames(page);
      const composer = page.locator('.composer-field textarea');
      const attach = page.getByRole('button', { name: 'Add attachment', exact: true });
      const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: /File$/ }) });
      async function measure(name, operation) {
        const samples = report.operations[name] ??= { samples: [] };
        const hostBefore = host();
        const browserStart = await page.evaluate(() => performance.now());
        const start = performance.now();
        await operation();
        await frames(page);
        const browserMs = await page.evaluate((before) => performance.now() - before, browserStart);
        samples.samples.push({ iteration: samples.samples.length + 1, browserMs, hostMs: performance.now() - start, hostBefore });
      }
      for (let iteration = 1; iteration <= 10; iteration++) {
        await measure('composer-fill', async () => {
          const value = `Review the migration baseline ${iteration}`;
          await composer.fill(value);
          await expect(composer).toHaveValue(value);
          await expect(composer).toBeFocused();
        });
        await measure('attachment-menu-open', async () => {
          await attach.click();
          await expect(menu).toBeVisible();
          await expect.poll(() => menu.evaluate((element) => {
            for (let current = element; current; current = current.parentElement) {
              const style = getComputedStyle(current);
              if (style.opacity !== '1' || style.visibility !== 'visible') return false;
            }
            return true;
          })).toBe(true);
        });
        await measure('attachment-menu-close', async () => {
          await composer.click();
          await expect(menu).toBeHidden();
          await expect(composer).toBeFocused();
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
    await testInfo.attach('browser-performance-samples', { path, contentType: 'application/json' });
  }
});
