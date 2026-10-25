import { test, expect } from './harness.mjs';
import { appendFileSync, readFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Probe (dev-only): the Codex pool page's frame around .app-view, its computed styles and body children.
const OUT = process.env.PROBE_OUT;
test('structure of the pool page', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(P42_PATHS.codexPool);
  await expect(page.locator('.who-card')).toBeVisible();
  const dump = await page.evaluate(readFileSync('/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/probes/dump-structure.js', 'utf8'));
  appendFileSync(OUT, JSON.stringify({ page: 'pool', project: testInfo.project.name, dump }) + '\n');
});
