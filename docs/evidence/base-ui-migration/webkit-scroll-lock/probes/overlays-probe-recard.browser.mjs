import { test, expect } from '@playwright/test';
import { appendFileSync } from 'node:fs';
// Probe (dev-only): the app-frame fixture with the app's .re-card container class on its spacers, after a
// notice or not, then the Orbit dialog: does .app-view keep its position while open and after close?
const OUT = process.env.PROBE_OUT;
for (const which of ['none', 'above', 'below', 'both']) for (const notice of [true, false]) test(`re-card ${which}, notice ${notice}`, async ({ page }, info) => {
  await page.goto('/ui-migration/overlays.html?app-frame');
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((which) => {
    const [above, below] = document.querySelectorAll('.overlays-fixture-spacer');
    for (const el of which === 'both' ? [above, below] : which === 'above' ? [above] : which === 'below' ? [below] : []) el.classList.add('re-card');
  }, which);
  if (notice) {
    await page.getByRole('button', { name: 'Show notice', exact: true }).click();
    await expect(page.locator('body > [aria-live="polite"]')).toHaveText('Workspace saved');
    await page.getByRole('button', { name: 'Clear notifications', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Notifications', exact: true })).toHaveCount(0);
  }
  const trigger = page.getByRole('button', { name: 'Orbit dialog', exact: true });
  const before = await trigger.evaluate((el) => {
    const view = el.closest('.app-view');
    view.scrollTop += el.getBoundingClientRect().top - view.getBoundingClientRect().top - 80;
    return { top: view.scrollTop, scrollbar: innerWidth - document.documentElement.clientWidth };
  });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => document.querySelector('.app-view').scrollTop);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => document.querySelector('.app-view').scrollTop);
  appendFileSync(OUT, JSON.stringify({ project: info.project.name, which, notice, before, open, closed }) + '\n');
});
