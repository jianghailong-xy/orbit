// node render.mjs <boardDir>: one PNG per section.b-part, at 2×.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
const dir = process.argv[2];
const { chromium } = await import('/var/tmp/dashscope-406-mock/after/node_modules/playwright/index.mjs');
const server = await new Promise((r) => { const s = createServer((q, a) => { const f = join(dir, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!existsSync(f)) { a.writeHead(404); return a.end(); } a.writeHead(200, { 'content-type': { '.html': 'text/html; charset=utf-8', '.png': 'image/png' }[extname(f)] ?? 'application/octet-stream' }); a.end(readFileSync(f)); }).listen(0, '127.0.0.1', () => r(s)); });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1520, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${server.address().port}/board.html`);
await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]));
await page.waitForTimeout(400);
const n = await page.locator('section.b-part').count();
for (let i = 0; i < n; i++) await page.locator('section.b-part').nth(i).screenshot({ path: `${dir}/board-${i + 1}.png` });
console.log('rendered', n);
await browser.close(); server.close();
