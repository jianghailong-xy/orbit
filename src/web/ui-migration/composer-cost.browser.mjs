import { test, expect } from '@playwright/test';
import { IMPLS, FIELD, attachJson, open, settle } from './composer-checks.mjs';

// Recorded cost of one keystroke in the session composer (React update, auto-size measurement and
// the next two frames) for the AntD field and the Orbit Textarea. Sampled like the P0 performance
// baseline: one reference project, native timers, raw samples kept, and no pass/fail threshold.

const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(fraction * values.length) - 1)];

test('records per-keystroke cost of the session field with short and long drafts', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium-light-desktop', 'Cost is sampled on the P0 reference project only.');
  const results = {};
  for (const impl of IMPLS) {
    results[impl] = {};
    for (const [label, lines] of [['short', 1], ['capped-200-lines', 200]]) {
      const field = await open(page, info, impl);
      await field.fill(Array.from({ length: lines }, (_, index) => `line ${index + 1} of the draft`).join('\n'));
      await settle(page);
      await field.press('End');
      // Work done for one input event: from the native event (window, capture) to a microtask queued
      // after React's own flush (window, bubble) — the render, commit, layout effects and auto-size
      // measurement, without frame waits or Playwright's round trip.
      await page.evaluate(() => {
        window.__inputWork = [];
        window.addEventListener('input', () => { window.__inputStart = performance.now(); }, true);
        window.addEventListener('input', () => queueMicrotask(() => window.__inputWork.push(performance.now() - window.__inputStart)));
      });
      const frames = [];
      for (let index = 0; index < 30; index++) {
        // Trusted keystroke; time from just before it until two frames later.
        await page.evaluate(() => { window.__keyStart = performance.now(); });
        await page.keyboard.press('x');
        frames.push(await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - window.__keyStart))))));
      }
      expect(await field.evaluate((element) => element.value.endsWith('x'.repeat(30)))).toBe(true);
      const work = await page.evaluate(() => window.__inputWork);
      expect(work).toHaveLength(30);
      const summary = (samples) => {
        const sorted = [...samples].sort((a, b) => a - b);
        return { samples, median: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), min: sorted[0], max: sorted.at(-1) };
      };
      results[impl][label] = { inputWork: summary(work), twoFrames: summary(frames),
        height: await page.locator(FIELD).evaluate((element) => element.getBoundingClientRect().height) };
    }
  }
  await attachJson(info, 'keystroke-cost', { method: {
    inputWork: 'native input event to a microtask after React flushes (render, commit, layout effects, auto-size measurement); 30 trusted keystrokes per draft',
    twoFrames: 'just before the trusted keypress to the second animation frame after it; Playwright round trip included',
  }, results });
});
