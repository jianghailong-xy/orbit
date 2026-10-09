import { test, expect } from '@playwright/test';
import { appendFileSync } from 'node:fs';
// Probe (dev-only): in the app-frame fixture, with the Orbit dialog's button 80px below the top of the
// view, shrink the page below it so the scroll position sits `delta` px above the bottom of the range;
// then open the Orbit dialog (with or without a notice first) and read .app-view's position.
const OUT = process.env.PROBE_OUT;
test('distance from the bottom of the scroll range vs the WebKit reset', async ({ page }, info) => {
  const rows = [];
  for (const notice of [true, false]) for (const delta of [0, 1, 8, 72, 100, 1000]) {
    await page.goto('/ui-migration/overlays.html?app-frame');
    await page.evaluate(() => document.fonts.ready);
    if (notice) {
      await page.getByRole('button', { name: 'Show notice', exact: true }).click();
      await expect(page.locator('body > [aria-live="polite"]')).toHaveText('Workspace saved');
      await page.getByRole('button', { name: 'Clear notifications', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Notifications', exact: true })).toHaveCount(0);
    }
    const trigger = page.getByRole('button', { name: 'Orbit dialog', exact: true });
    const setup = await trigger.evaluate((el, delta) => {
      const view = el.closest('.app-view');
      view.scrollTop += el.getBoundingClientRect().top - view.getBoundingClientRect().top - 80;
      const scrolled = view.scrollTop;
      const below = [...document.querySelectorAll('.overlays-fixture-spacer')].at(-1);
      const max = view.scrollHeight - view.clientHeight;
      below.style.height = `${below.getBoundingClientRect().height - (max - (scrolled + delta))}px`;
      below.style.boxSizing = 'border-box';
      return { scrolled, max: view.scrollHeight - view.clientHeight, top: view.scrollTop, scrollbar: innerWidth - document.documentElement.clientWidth };
    }, delta);
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(400);
    const open = await page.evaluate(() => document.querySelector('.app-view').scrollTop);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(300);
    const closed = await page.evaluate(() => document.querySelector('.app-view').scrollTop);
    rows.push({ notice, delta, ...setup, open, closed });
  }
  appendFileSync(OUT, JSON.stringify({ project: info.project.name, rows }) + '\n');
});
