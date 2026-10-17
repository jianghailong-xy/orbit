import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Probe (dev-only): along the P4.2 "Claude pool" steps, whether the document shows an inset scrollbar,
// the scroll lock written on <body>, and where the page's content starts, before and while the Add
// account dialog is open. Writes one JSON line to PROBE_OUT.
const OUT = process.env.PROBE_OUT;
test('dialog scrollbar gutter along the Claude pool steps', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  const states = [];
  const state = async (step) => states.push({ step, ...(await page.evaluate(() => {
    const html = document.documentElement;
    return { docHeight: html.scrollHeight, docScrollbar: innerWidth - html.clientWidth, bodyStyle: document.body.getAttribute('style') || '',
      contentLeft: +(document.querySelector('.pool-page-title, h1')?.getBoundingClientRect().left ?? -1).toFixed(2) };
  })) });
  await page.goto(P42_PATHS.claudePool);
  const remove = page.getByRole('button', { name: /Remove Claude Max \(work\) from this pool/ });
  await expect(remove).toBeVisible();
  await state('open');
  await remove.click();
  const left = page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Claude Max (work) left the pool', { exact: true });
  await expect(left).toBeVisible();
  await expect(left).toHaveCount(0);
  await state('after a notice');
  await page.getByRole('button', { name: /Add account$/ }).click();
  const dialog = page.locator('[role="dialog"]').filter({ has: page.getByText('Add account to Claude accounts', { exact: true }) });
  await expect(dialog).toBeVisible();
  await state('dialog open');
  appendFileSync(OUT, JSON.stringify({ tree: process.env.TREE, project: testInfo.project.name, states }) + '\n');
});
