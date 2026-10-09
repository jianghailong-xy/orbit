import { test, expect } from '@playwright/test';
import { appendFileSync } from 'node:fs';
// Probe (dev-only): the app-frame fixture after a notice, with or without size containers in the page, then
// the Orbit dialog: does .app-view keep its position while it is open, and after it closes?
const OUT = process.env.PROBE_OUT;
const kinds = {
  'no containers (as committed)': null,
  'spacers are inline-size containers': 'spacers',
  'one inline-size container above': 'above',
  'one inline-size container below': 'below',
};
for (const [label, which] of Object.entries(kinds)) for (const notice of [true, false]) test(`app frame: ${label}, notice ${notice}`, async ({ page }, info) => {
  await page.goto('/ui-migration/overlays.html?app-frame');
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  if (which) await page.evaluate((which) => {
    const [above, below] = document.querySelectorAll('.overlays-fixture-spacer');
    for (const el of which === 'spacers' ? [above, below] : which === 'above' ? [above] : [below]) el.style.containerType = 'inline-size';
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
  appendFileSync(OUT, JSON.stringify({ project: info.project.name, label, notice, before, open, closed }) + '\n');
});
