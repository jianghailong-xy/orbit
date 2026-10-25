import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Probe (dev-only): the switches' widths in a pool's "Who can use it" rules and on a provider's edit page.
// Writes one JSON line to PROBE_OUT.
const OUT = process.env.PROBE_OUT;
test('switch widths', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  const widths = (locator) => locator.evaluateAll((els) => els.map((el) => +el.getBoundingClientRect().width.toFixed(2)));
  await page.goto(P42_PATHS.codexPool);
  await expect(page.locator('.who-card')).toBeVisible();
  const rules = await widths(page.locator('.who-card [role="switch"]'));
  await page.goto(P42_PATHS.editOpenai);
  // The edit page's one switch, Enabled (the replaced switch has no accessible name, so not by name).
  await expect(page.getByRole('switch').first()).toBeVisible();
  const enabled = await widths(page.getByRole('switch'));
  appendFileSync(OUT, JSON.stringify({ tree: process.env.TREE, project: testInfo.project.name, rules, enabled }) + '\n');
});
