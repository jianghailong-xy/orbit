// Renders docs/mocks/admin-settings-style/01-board.html to one PNG per section.b-part.
//   node render.mjs <boardDir> <outPrefix>
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
const K = '/var/tmp/admin-mock';
const [dir, prefix] = process.argv.slice(2);
const { chromium } = await import(`${K}/proto/node_modules/playwright/index.mjs`);
const TYPES = { '.html': 'text/html', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome', timeout: 300000,
  env: { ...process.env, FONTCONFIG_FILE: `${K}/fonts.conf` } });
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(240000);
await page.goto(`http://127.0.0.1:${server.address().port}/01-board.html`, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
const h = await page.evaluate(() => document.documentElement.scrollHeight);
await page.setViewportSize({ width: 1500, height: h });
await page.waitForTimeout(500);
let i = 0;
for (const part of await page.locator('section.b-part').all()) await part.screenshot({ path: `${prefix}-${++i}.png` });
console.log('parts', i);
await browser.close(); server.close();
