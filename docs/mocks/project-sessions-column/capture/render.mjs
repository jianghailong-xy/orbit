// Renders a docs/mocks board to PNGs, one per `section.b-part` (or per `[data-part]` element), served
// over HTTP so the board can fetch its patch files.
//   node render.mjs <mocksDir> <board>/<file.html> <outPrefix> [selector]
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const TREE = process.env.TREE ?? '/var/tmp/prj-col/today';
const [mocks, rel, prefix, selector = 'section.b-part'] = process.argv.slice(2);
const { chromium } = await import(`${TREE}/node_modules/playwright/index.mjs`);
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.patch': 'text/plain' };
const server = http.createServer((req, res) => {
  const file = path.join(mocks, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(mocks) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/${rel}`);
await page.waitForLoadState('load');
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => Promise.all([...document.images].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
await page.evaluate(() => window.drawMarks?.());
await page.waitForTimeout(400);
// Grow the viewport to the page, or element shots are cropped at its bottom edge.
const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
await page.setViewportSize({ width: Math.max(1600, size.w), height: size.h });
await page.waitForTimeout(300);
await page.evaluate(() => window.drawMarks?.());
const parts = await page.locator(selector).all();
let i = 0;
for (const part of parts) {
  i += 1;
  await part.screenshot({ path: `${prefix}-${i}.png` });
}
console.log(JSON.stringify({ parts: parts.length, errors }));
await browser.close();
server.close();
