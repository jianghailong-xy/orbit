import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { PATHS } from './fixtures.mjs';
// Probe (dev-only): the P0 settings page; pixel (0,0) and the right 8px column of a viewport screenshot
// with no overflow, with a plain 1px box making the document 1px taller, and with the toast's live region.
const OUT = process.env.PROBE_OUT;
const read = async (page) => {
  const require = createRequire(import.meta.url);
  const { PNG } = require(`${dirname(require.resolve('playwright-core/package.json'))}/lib/utilsBundle.js`);
  const png = PNG.sync.read(await page.screenshot());
  const at = (x, y) => [...png.data.slice((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];
  return { corner: at(0, 0), rightColumn: at(png.width - 3, 300), doc: await page.evaluate(() => [document.documentElement.scrollHeight, innerWidth - document.documentElement.clientWidth]) };
};
test('settings page: corner pixel and right column', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await page.goto(PATHS.settings);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  const rows = { none: await read(page) };
  await page.evaluate(() => { const box = document.createElement('div'); box.id = 'probe-box'; box.style.cssText = 'position:absolute;width:1px;height:1px'; document.body.appendChild(box); });
  rows.plainBox = await read(page);
  await page.evaluate(() => document.getElementById('probe-box').remove());
  rows.boxRemoved = await read(page);
  const first = page.getByRole('switch').first();
  await first.click();
  await expect(page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Setting saved', { exact: true })).toBeVisible();
  rows.afterNotice = await read(page);
  rows.liveRegion = await page.evaluate(() => { const el = document.querySelector('body > [aria-live]'); const r = el.getBoundingClientRect(); return { position: getComputedStyle(el).position, rect: [r.x, r.y, r.width, r.height] }; });
  appendFileSync(OUT, JSON.stringify({ tree: process.env.LABEL_TREE, project: testInfo.project.name, rows }) + '\n');
});
