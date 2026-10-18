import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Probe (dev-only): the Codex pool page with a 1px sr-only box appended to <body> (what lib/toast's live
// region does), the page scrolled to 72, then the first step of Base UI's inset-scrollbar lock (html
// scrollbar-gutter: stable, body overflow-y: scroll, a forced layout). One page feature changed per run.
const OUT = process.env.PROBE_OUT;
const mods = {
  'none': () => {},
  'no live region': 'skip-live-region',
  'no nav column': () => { const shell = document.querySelector('.app-shell'); for (const el of [...shell.children]) if (!el.matches('main')) el.remove(); },
  'cards not containers': () => { for (const el of document.querySelectorAll('.re-card')) el.style.containerType = 'normal'; },
  'cards overflow visible': () => { for (const el of document.querySelectorAll('.re-card')) el.style.overflow = 'visible'; },
  'no who card': () => document.querySelector('.who-card').remove(),
  'no detail card': () => document.querySelector('.pool-detail').remove(),
  'no page head': () => document.querySelector('.pool-page-head').remove(),
  'no back link': () => document.querySelector('.provider-back').remove(),
  'no danger row': () => document.querySelector('.pool-danger').remove(),
  'no rows in detail card': () => { for (const el of document.querySelectorAll('.pool-detail .re-row')) el.remove(); },
  'no grid rows (people)': () => { for (const el of document.querySelectorAll('.pool-person')) el.remove(); },
  'no rules': () => { for (const el of document.querySelectorAll('.pool-rule')) el.remove(); },
};
for (const [label, mod] of Object.entries(mods)) test(`reduce: ${label}`, async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(P42_PATHS.codexPool);
  await expect(page.locator('.who-card')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  if (typeof mod === 'function') await page.evaluate(`(${mod.toString()})()`);
  const result = await page.evaluate(async (live) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const view = document.querySelector('.app-view');
    if (live) { const region = document.createElement('div'); region.className = 'sr-only'; document.body.appendChild(region); }
    await frame();
    view.scrollTop = 72;
    await frame();
    const before = { top: view.scrollTop, scrollHeight: view.scrollHeight, scrollbar: innerWidth - document.documentElement.clientWidth };
    document.documentElement.style.scrollbarGutter = 'stable';
    document.body.style.overflowY = 'scroll';
    void document.body.offsetWidth;
    const after = { top: view.scrollTop, scrollHeight: view.scrollHeight };
    return { before, after };
  }, mod !== 'skip-live-region');
  appendFileSync(OUT, JSON.stringify({ project: testInfo.project.name, label, ...result }) + '\n');
});
