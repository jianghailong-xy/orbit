// node capture-offer.mjs <worktree> <dist> <outDir>: the one-time Web Push offer, both placements, real pages.
import http from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [wt, dist, out] = process.argv.slice(2);
const PW = '/root/.orbit/worktrees/01a1b526-5a6e-749f-8602-e9a88d10a688/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const { installFixtures } = await import(path.join(wt, 'src/web/ui-migration/fixtures.mjs'));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/rpr-mock/fonts.conf' }, ignoreDefaultArgs: ['--hide-scrollbars'] });
const boxes = {};
const scenes = [
  ['bar-light', 'bar', 'light', 1280, 760], ['rail-light', 'rail', 'light', 1280, 760],
  ['bar-dark', 'bar', 'dark', 1280, 760], ['rail-dark', 'rail', 'dark', 1280, 760],
  ['bar-phone', 'bar', 'light', 390, 844], ['rail-phone', 'rail', 'light', 390, 844],
];
for (const [scene, keep, theme, w, h] of scenes) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await installFixtures(page, { theme });
  await page.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'default' }));
  await page.route('**/api/push/web-config', (route) => route.fulfill({ status: 200, json: { publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' } }));
  await page.goto(`${base}/`);
  await page.waitForLoadState('networkidle');
  await page.locator(`.web-push-offer--${keep}`).waitFor();
  // Only one placement ships: take the other out of the page, so the shell lays out as it would.
  await page.evaluate((drop) => document.querySelectorAll(`.web-push-offer--${drop}`).forEach((n) => n.remove()), keep === 'bar' ? 'rail' : 'bar');
  if (scene === 'rail-phone') await page.locator('.app-nav-toggle').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${scene}.png` });
  boxes[scene] = await page.locator(`.web-push-offer--${keep}`).boundingBox().catch(() => null);
  await ctx.close();
}
writeFileSync(`${out}/boxes.json`, JSON.stringify(boxes, null, 2));
console.log(JSON.stringify(boxes));
await browser.close(); server.close();
