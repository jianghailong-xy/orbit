import { test, expect } from '@playwright/test';
import { appendFileSync, readFileSync } from 'node:fs';
// Probe (dev-only): the app-frame fixture's frame around .app-view, its computed styles and body children.
const OUT = process.env.PROBE_OUT;
test('structure of the app frame fixture', async ({ page }, info) => {
  await page.goto('/ui-migration/overlays.html?app-frame');
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  const dump = await page.evaluate(readFileSync('/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/probes/dump-structure.js', 'utf8'));
  appendFileSync(OUT, JSON.stringify({ page: 'fixture', project: info.project.name, dump }) + '\n');
});
