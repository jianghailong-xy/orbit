import { test, expect } from '@playwright/test';
import { appendFileSync } from 'node:fs';
// Probe (dev-only): the app-frame fixture after a notice, with its spacers' fixed heights replaced by
// content of different kinds, then the Orbit dialog: does .app-view keep its position while it is open?
const OUT = process.env.PROBE_OUT;
const kinds = {
  'fixed spacers (as committed)': null,
  'paragraphs of text': (el) => { el.style.height = 'auto'; el.style.paddingTop = '0px'; el.replaceChildren(...Array.from({ length: 70 }, (_, i) => Object.assign(document.createElement('p'), { textContent: `Paragraph ${i + 1}: page content above the overlays.` }))); },
  'blocks of 20px': (el) => { el.style.height = 'auto'; el.style.paddingTop = '0px'; el.replaceChildren(...Array.from({ length: 75 }, () => Object.assign(document.createElement('div'), { style: 'height:20px' }))); },
  'one block of 1500px': (el) => { el.style.height = 'auto'; el.style.paddingTop = '0px'; el.replaceChildren(Object.assign(document.createElement('div'), { style: 'height:1500px' })); },
};
for (const [label, fill] of Object.entries(kinds)) test(`app frame: ${label}`, async ({ page }, info) => {
  await page.goto('/ui-migration/overlays.html?app-frame');
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  if (fill) await page.evaluate(`(${({ fill }) => 0})`);
  if (fill) await page.evaluate((source) => { const f = eval(source); for (const el of document.querySelectorAll('.overlays-fixture-spacer')) f(el); }, fill.toString());
  await page.getByRole('button', { name: 'Show notice', exact: true }).click();
  await expect(page.locator('body > [aria-live="polite"]')).toHaveText('Workspace saved');
  await page.getByRole('button', { name: 'Clear notifications', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications', exact: true })).toHaveCount(0);
  const trigger = page.getByRole('button', { name: 'Orbit dialog', exact: true });
  const before = await trigger.evaluate((el) => {
    const view = el.closest('.app-view');
    view.scrollTop += el.getBoundingClientRect().top - view.getBoundingClientRect().top - 80;
    return { top: view.scrollTop, scrollHeight: view.scrollHeight, scrollbar: innerWidth - document.documentElement.clientWidth };
  });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => document.querySelector('.app-view').scrollTop);
  appendFileSync(OUT, JSON.stringify({ project: info.project.name, label, before, open }) + '\n');
});
