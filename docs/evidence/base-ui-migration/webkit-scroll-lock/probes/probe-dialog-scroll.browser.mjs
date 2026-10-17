import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Probe (dev-only, not in the app's suites): along the P4.2 "Codex pool of one's own" steps, the page's
// scroll position (.app-view), whether the document shows an inset scrollbar, the scroll lock written on
// <body>, and where focus is. Writes one JSON line per run to PROBE_OUT.
const OUT = process.env.PROBE_OUT;
test('dialog scroll lock along the Codex pool steps', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  const states = [];
  const state = async (step) => states.push({ step, ...(await page.evaluate(() => {
    const view = document.querySelector('.app-view');
    const html = document.documentElement;
    const active = document.activeElement;
    return { scrollTop: view.scrollTop, docHeight: html.scrollHeight, docScrollbar: innerWidth - html.clientWidth,
      bodyStyle: document.body.getAttribute('style') || '',
      focus: active && active !== document.body ? (active.getAttribute('aria-label') || active.textContent?.trim().slice(0, 30)) : 'body' };
  })) });
  const named = (name) => new RegExp(`^(?:[a-z]+(?:-[a-z]+)* )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const button = (scope, name) => scope.getByRole('button', { name: named(name) });
  const box = (title) => page.locator('[role="tooltip"], [role="dialog"], [role="alertdialog"]').filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
  await page.goto(P42_PATHS.codexPool);
  const who = page.locator('.who-card');
  await expect(who).toBeVisible();
  await state('open');
  await who.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await state('who at top');
  await button(who, 'Add people').click();
  const share = box('Share My Codex');
  await expect(share).toBeVisible();
  await state('share open (no notice yet)');
  await share.getByRole('combobox', { name: 'People to add' }).click();
  await share.getByRole('combobox', { name: 'People to add' }).pressSequentially('zhang@example.test,');
  await button(share, 'Share').click();
  const added = page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Added to My Codex', { exact: true });
  await expect(added).toBeVisible();
  await state('shared, notice shown');
  await expect(added).toHaveCount(0);
  await state('notice gone');
  await button(page, 'Replace key').click();
  const replace = box('Replace lin-proj');
  await expect(replace).toBeVisible();
  await state('replace open');
  await button(replace, 'Cancel').click();
  await expect(replace).toHaveCount(0);
  await state('replace closed');
  expect(fixtures.requests.length).toBeGreaterThan(0);
  appendFileSync(OUT, JSON.stringify({ tree: process.env.TREE, project: testInfo.project.name, states }) + '\n');
});
