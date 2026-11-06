// Renders 01-delete-wiki.html, one PNG per section.b-part (01-delete-wiki-N.png). Served over HTTP from the
// repository root for the shipped CSS the board links; marks drawn after layout.
//   KIT=/var/tmp/wiki-delete-mock SCRIPT=render.mjs unshare -n docs/mocks/wiki-delete/capture/run-ns.sh
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '..');
const ROOT = path.resolve(HERE, '../../../..');
const KIT = process.env.KIT ?? '/var/tmp/wiki-delete-mock';
const FILE = '01-delete-wiki.html';
const PREFIX = '01-delete-wiki';
const { chromium } = await import(`${KIT}/new/node_modules/playwright/index.mjs`);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: process.env.FONTCONFIG_FILE ?? '/mnt/data/pe-mock/fonts.conf' } });
const page = await browser.newPage({ viewport: { width: 1640, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
await page.goto(`http://127.0.0.1:${server.address().port}/docs/mocks/${path.basename(DIR)}/${FILE}`, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => window.drawMarks());
const parts = await page.locator('section.b-part').count();
for (let i = 0; i < parts; i++) {
  const el = page.locator('section.b-part').nth(i);
  const box = await el.boundingBox();
  if (box.y + box.height > page.viewportSize().height) {
    await page.setViewportSize({ width: 1640, height: Math.ceil(box.y + box.height + 60) });
    await page.evaluate(() => window.drawMarks());
  }
  await el.screenshot({ path: path.join(DIR, `${PREFIX}-${i + 1}.png`) });
  console.log(`${PREFIX}-${i + 1}.png`, Math.round(box.width), 'x', Math.round(box.height));
}
const overflow = await page.evaluate(() => [...document.querySelectorAll('.b-part, .an, .pb-ios, .b-note, td')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => `${el.className || el.tagName}: ${el.scrollWidth} > ${el.clientWidth}`));
console.log('overflow', JSON.stringify(overflow));
console.log('errors', JSON.stringify(errors));
await browser.close();
server.close();
