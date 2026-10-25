import { test, expect } from './harness.mjs';
import { appendFileSync, readFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
const OUT = process.env.PROBE_OUT;
test('pool page content', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(P42_PATHS.codexPool);
  await expect(page.locator('.who-card')).toBeVisible();
  appendFileSync(OUT, JSON.stringify(await page.evaluate(readFileSync('/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/probes/dump-content.js', 'utf8'))) + '\n');
});
