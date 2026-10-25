import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Probe (dev-only): the workspace editor's "Always allowed" while its rules load and once they have. The
// rules answer is held until the loading state has been measured. Writes one JSON line to PROBE_OUT.
const OUT = process.env.PROBE_OUT;
test('always allowed: loading and loaded heights', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/workspaces/*/permission-rules', async (route) => { await held; await route.fulfill({ status: 200, json: [] }); });
  await page.goto(P42_PATHS.studio);
  const web = page.locator('.rd-workspace-row').filter({ has: page.locator('.rd-workspace-name', { hasText: /^orbit-web$/ }) }).first();
  await expect(web).toBeVisible();
  await web.click();
  const form = page.locator('.rd-workspace-form');
  await expect(form).toBeVisible();
  await form.locator('.rd-adv-toggle').click();
  await expect(form.getByPlaceholder('KEY', { exact: true })).toBeVisible();
  const field = form.locator('.rd-form-field').filter({ has: page.getByText('Always allowed', { exact: true }) });
  const measure = () => field.evaluate((el) => ({ field: +el.getBoundingClientRect().height.toFixed(2),
    shows: `${el.lastElementChild.tagName.toLowerCase()}.${String(el.lastElementChild.className).split(' ')[0]}` }));
  const loading = await measure();
  release();
  await expect(field.getByText(/^Nothing yet/)).toBeVisible();
  const loaded = await measure();
  appendFileSync(OUT, JSON.stringify({ tree: process.env.TREE, project: testInfo.project.name, loading, loaded }) + '\n');
});
