import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const DIR = process.argv[2];
const { chromium } = await import('/var/tmp/tlip/proto/node_modules/playwright/index.mjs');
const srv = http.createServer((q, r) => { const f = path.join(DIR, decodeURIComponent(q.url.split('?')[0])); if (!existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.png') ? 'image/png' : 'application/octet-stream' }); r.end(readFileSync(f)); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const b = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome' });
const page = await b.newPage({ viewport: { width: 1700, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${srv.address().port}/01-board.html`); await page.waitForLoadState('networkidle'); await page.waitForTimeout(500);
for (const el of await page.locator('section.b-part').all()) { const id = await el.getAttribute('id'); await el.screenshot({ path: path.join(DIR, `01-board-${id.replace('part-', '')}.png`) }); }
await b.close(); srv.close();
