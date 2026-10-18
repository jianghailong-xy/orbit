import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Probe (dev-only): the Codex pool page with 1000px of filler appended so it keeps a scroll range, then one
// change, the page scrolled to 500, and the first step of Base UI's inset-scrollbar lock applied directly.
const OUT = process.env.PROBE_OUT;
const mods = {
  'filler only': () => {},
  'no detail card': () => document.querySelector('.pool-detail').remove(),
  'no who card': () => document.querySelector('.who-card').remove(),
  'no cards': () => { for (const el of document.querySelectorAll('.re-card')) el.remove(); },
  'cards unnamed': () => { for (const el of document.querySelectorAll('.re-card')) el.style.containerName = 'none'; },
  'who card: head only': () => { for (const el of [...document.querySelector('.who-card').children].slice(1)) el.remove(); },
  'who card: empty': () => document.querySelector('.who-card').replaceChildren(),
  'detail card: empty': () => document.querySelector('.pool-detail').replaceChildren(),
  'both cards: empty': () => { for (const el of document.querySelectorAll('.re-card')) el.replaceChildren(); },
  'both cards: one text node': () => { for (const el of document.querySelectorAll('.re-card')) el.replaceChildren('Card'); },
  'both cards empty, fixed height': () => { for (const el of document.querySelectorAll('.re-card')) { el.replaceChildren(); el.style.height = '100px'; } },
};
for (const [label, mod] of Object.entries(mods)) test(`reduce2: ${label}`, async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(P42_PATHS.codexPool);
  await expect(page.locator('.who-card')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => { const filler = document.createElement('div'); filler.style.height = '1000px'; document.querySelector('.app-view').firstElementChild.append(filler); });
  await page.evaluate(`(${mod.toString()})()`);
  const result = await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const view = document.querySelector('.app-view');
    await frame();
    view.scrollTop = 500;
    await frame();
    const before = { top: view.scrollTop, scrollHeight: view.scrollHeight };
    document.documentElement.style.scrollbarGutter = 'stable';
    document.body.style.overflowY = 'scroll';
    void document.body.offsetWidth;
    return { before, after: { top: view.scrollTop, scrollHeight: view.scrollHeight }, cards: [...document.querySelectorAll('.re-card')].map((el) => [el.className, el.getBoundingClientRect().height, el.childNodes.length]) };
  });
  appendFileSync(OUT, JSON.stringify({ project: testInfo.project.name, label, ...result }) + '\n');
});
