import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Probe (dev-only): the Codex pool page after a notice, with its content height and scroll position varied,
// then Replace key: does .app-view keep its position while the dialog is open?
const OUT = process.env.PROBE_OUT;
const variants = [
  ['max (as P4.2)', null, 'max'],
  ['middle', null, 'mid'],
  ['integer content, max', '924px', 'max'],
  ['integer content, middle', '924px', 'mid'],
  ['tall integer content, at 72', '1500px', 72],
  ['tall fractional content, at 72', '1500.55px', 72],
  ['tall fractional content, max', '1500.55px', 'max'],
];
for (const [label, height, at] of variants) test(`pool page: ${label}`, async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  const named = (name) => new RegExp(`^(?:[a-z]+(?:-[a-z]+)* )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const button = (scope, name) => scope.getByRole('button', { name: named(name) });
  const box = (title) => page.locator('[role="tooltip"], [role="dialog"], [role="alertdialog"]').filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
  await page.goto(P42_PATHS.codexPool);
  const who = page.locator('.who-card');
  await expect(who).toBeVisible();
  await button(who, 'Add people').click();
  const share = box('Share My Codex');
  await expect(share).toBeVisible();
  await share.getByRole('combobox', { name: 'People to add' }).click();
  await share.getByRole('combobox', { name: 'People to add' }).pressSequentially('zhang@example.test,');
  await button(share, 'Share').click();
  const added = page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Added to My Codex', { exact: true });
  await expect(added).toBeVisible();
  await expect(added).toHaveCount(0);
  const before = await page.evaluate(({ height, at }) => {
    const view = document.querySelector('.app-view');
    if (height) view.firstElementChild.style.height = height;
    const max = view.scrollHeight - view.clientHeight;
    view.scrollTop = at === 'max' ? 100000 : at === 'mid' ? Math.round(max / 2) : at;
    return { top: view.scrollTop, scrollHeight: view.scrollHeight, exactContent: view.firstElementChild.getBoundingClientRect().height,
      scrollbar: innerWidth - document.documentElement.clientWidth };
  }, { height, at });
  const replaceKey = button(page, 'Replace key');
  const visibleTrigger = await replaceKey.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  await replaceKey.dispatchEvent('click');
  const replace = box('Replace lin-proj');
  await expect(replace).toBeVisible();
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => ({ top: document.querySelector('.app-view').scrollTop, body: document.body.style.cssText.slice(0, 30) }));
  appendFileSync(OUT, JSON.stringify({ project: testInfo.project.name, label, before, visibleTrigger, open }) + '\n');
});
