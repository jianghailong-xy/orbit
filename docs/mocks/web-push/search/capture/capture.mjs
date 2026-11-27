// node capture.mjs <worktree> <dist> <outDir>: real web pages for the settings-search entry (docs/mocks/web-push).
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
for (const [scene, configured, perms] of [['search', true, ['notifications']], ['search-unconfigured', false, []], ['blocked', true, []]]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, permissions: perms });
  const page = await ctx.newPage();
  if (perms.length) await page.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'default' }));
  await installFixtures(page, { theme: 'light' });
  await page.route('**/api/push/web-config', (route) => route.fulfill({ status: 200, json: { publicKey: configured ? 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' : null } }));
  await page.goto(`${base}/settings/general`);
  await page.waitForLoadState('networkidle');
  console.log(scene, JSON.stringify(await page.evaluate(() => [Notification.permission, 'PushManager' in window, 'serviceWorker' in navigator])));
  await page.getByPlaceholder('Search settings').fill('browser');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${scene}.png` });
  const hit = page.locator('nav.settings-nav').getByText('Notifications in this browser').first();
  boxes[scene] = { nav: await page.locator('nav.settings-nav').boundingBox(), hit: (await hit.count()) ? await hit.boundingBox() : null };
  if (configured) {
    await hit.click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${out}/${scene === 'search' ? 'opened' : 'opened-blocked'}.png` });
    boxes.opened = { row: await page.locator('[data-anchor="browserNotifications"], #browserNotifications').first().boundingBox().catch(() => null), url: page.url() };
  }
  await ctx.close();
}
writeFileSync(`${out}/boxes.json`, JSON.stringify(boxes, null, 2));
console.log(JSON.stringify(boxes));
await browser.close(); server.close();
