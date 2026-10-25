import { test, expect } from '@playwright/test';
import { appendFileSync } from 'node:fs';
// Probe (dev-only): the app-frame fixture, page scrolled, then the first step of Base UI's inset-scrollbar
// lock applied directly (html scrollbar-gutter: stable, body overflow-y: scroll, a forced layout).
const OUT = process.env.PROBE_OUT;
const setups = {
  'as committed': () => {},
  'spacers are re-cards': () => { for (const el of document.querySelectorAll('.overlays-fixture-spacer')) el.classList.add('re-card'); },
  're-card with a re-row grid inside': () => {
    for (const el of document.querySelectorAll('.overlays-fixture-spacer')) {
      el.classList.add('re-card');
      const row = document.createElement('div'); row.className = 're-row'; row.textContent = 'Row'; el.prepend(row);
    }
  },
};
for (const [label, setup] of Object.entries(setups)) test(`direct trigger: ${label}`, async ({ page }, info) => {
  await page.goto('/ui-migration/overlays.html?app-frame');
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(`(${setup.toString()})()`);
  const result = await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const view = document.querySelector('.app-view');
    await frame();
    view.scrollTop = 1594;
    await frame();
    const before = { top: view.scrollTop, scrollHeight: view.scrollHeight };
    document.documentElement.style.scrollbarGutter = 'stable';
    document.body.style.overflowY = 'scroll';
    void document.body.offsetWidth;
    return { before, after: { top: view.scrollTop, scrollHeight: view.scrollHeight } };
  });
  appendFileSync(OUT, JSON.stringify({ project: info.project.name, label, ...result }) + '\n');
});
