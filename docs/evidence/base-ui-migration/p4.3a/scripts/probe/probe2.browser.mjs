import { appendFileSync } from 'node:fs';
import { test, expect } from 'HARNESS';
import { P43A_PATHS, installP43aFixtures } from 'FIXTURES';

const OUT = process.env.PROBE_OUT;
const TREE = process.env.TREE;
const box = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
  return { x: r.x, y: r.y, w: r.width, h: r.height, textAlign: s.textAlign, padding: s.padding, display: s.display };
});
const record = (testInfo, name, value) => appendFileSync(OUT, JSON.stringify({ tree: TREE, env: testInfo.project.name, name, value }) + '\n');

test('probe2', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP43aFixtures(page);
  await page.goto(P43A_PATHS.project);
  const card = page.getByRole('region', { name: 'Coordinator' });
  await card.getByRole('button', { name: /More coordinator actions/ }).click();
  await page.getByRole('menuitem', { name: /^Start a new coordinator/ }).click();
  const confirm = page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: 'Complete this conversation' }).last();
  await expect(confirm).toBeVisible();
  await page.waitForTimeout(600);
  record(testInfo, 'confirm', await box(confirm));
  record(testInfo, 'confirm-keep', await box(confirm.getByRole('button', { name: /Keep this coordinator/ })));
  record(testInfo, 'confirm-replace', await box(confirm.getByRole('button', { name: /Complete and start a new one/ })));
  await page.keyboard.press('Escape');

  await page.goto(P43A_PATHS.tasks);
  const labels = page.locator('.tasks-labelfilter');
  await labels.click();
  const option = () => page.locator('[role="option"], .ant-select-item-option').filter({ visible: true }).filter({ hasText: /^ui-migration/ }).first();
  await option().click();
  await page.waitForTimeout(500);
  record(testInfo, 'picked-option', await box(option()));
  record(testInfo, 'picked-opt', await box(option().locator('.tasks-labelopt')));
  record(testInfo, 'picked-count', await box(option().locator('.tasks-labelopt-count')));
  record(testInfo, 'picked-check', await box(option().locator('svg').last()));
  const other = page.locator('[role="option"], .ant-select-item-option').filter({ visible: true }).filter({ hasText: /^baseline/ }).first();
  record(testInfo, 'other-count', await box(other.locator('.tasks-labelopt-count')));
});
