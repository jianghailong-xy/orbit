import { test, expect } from '@playwright/test';
import { appendFileSync } from 'node:fs';
// Probe (dev-only): the app-frame fixture with its spacers turned into the app's .re-card holding rows of
// text (content-driven height), page scrolled, then (a) the lock's first step applied directly, (b) after
// a notice, the Orbit dialog opened.
const OUT = process.env.PROBE_OUT;
const fill = () => {
  for (const el of document.querySelectorAll('.overlays-fixture-spacer')) {
    el.classList.add('re-card');
    el.style.height = 'auto'; el.style.paddingTop = '0px';
    el.replaceChildren(...Array.from({ length: 40 }, (_, i) => Object.assign(document.createElement('p'), { textContent: `Row ${i + 1} of a card on the page` })));
  }
};
for (const how of ['direct', 'notice + Orbit dialog']) test(`filled re-cards: ${how}`, async ({ page }, info) => {
  await page.goto('/ui-migration/overlays.html?app-frame');
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(`(${fill.toString()})()`);
  if (how === 'direct') {
    const result = await page.evaluate(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const view = document.querySelector('.app-view');
      await frame(); view.scrollTop = 900; await frame();
      const before = { top: view.scrollTop, scrollHeight: view.scrollHeight };
      document.documentElement.style.scrollbarGutter = 'stable';
      document.body.style.overflowY = 'scroll';
      void document.body.offsetWidth;
      return { before, after: { top: view.scrollTop } };
    });
    appendFileSync(OUT, JSON.stringify({ project: info.project.name, how, ...result }) + '\n');
    return;
  }
  await page.getByRole('button', { name: 'Show notice', exact: true }).click();
  await expect(page.locator('body > [aria-live="polite"]')).toHaveText('Workspace saved');
  await page.getByRole('button', { name: 'Clear notifications', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications', exact: true })).toHaveCount(0);
  const trigger = page.getByRole('button', { name: 'Orbit dialog', exact: true });
  const before = await trigger.evaluate((el) => {
    const view = el.closest('.app-view');
    view.scrollTop += el.getBoundingClientRect().top - view.getBoundingClientRect().top - 80;
    return { top: view.scrollTop, scrollHeight: view.scrollHeight };
  });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => document.querySelector('.app-view').scrollTop);
  appendFileSync(OUT, JSON.stringify({ project: info.project.name, how, before, after: { top: open } }) + '\n');
});
