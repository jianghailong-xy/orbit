import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Probe (dev-only): the Codex pool page scrolled to 72 (as P4.2), then the first step of Base UI's
// inset-scrollbar lock applied directly; with and without overflow-anchor: none on .app-view.
const OUT = process.env.PROBE_OUT;
for (const anchor of ['auto', 'none']) test(`anchor ${anchor}`, async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(P42_PATHS.codexPool);
  await expect(page.locator('.who-card')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate(async (anchor) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const view = document.querySelector('.app-view');
    view.style.overflowAnchor = anchor;
    await frame();
    view.scrollTop = 72;
    await frame();
    const before = { top: view.scrollTop, anchor: getComputedStyle(view).overflowAnchor };
    document.documentElement.style.scrollbarGutter = 'stable';
    document.body.style.overflowY = 'scroll';
    void document.body.offsetWidth;
    return { before, after: { top: view.scrollTop } };
  }, anchor);
  appendFileSync(OUT, JSON.stringify({ project: testInfo.project.name, anchor, ...result }) + '\n');
});
