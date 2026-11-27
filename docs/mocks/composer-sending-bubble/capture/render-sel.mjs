// node render.mjs <repoRoot> <board rel path> <outPrefix>: one PNG per section.b-part, served over HTTP.
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
const PW = '/root/.orbit/worktrees/01a1b526-5a6e-749f-8602-e9a88d10a688/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const [root, rel, prefix] = process.argv.slice(2);
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/save-error-mock/fonts.conf' } });
const page = await browser.newPage({ viewport: { width: 1940, height: 1200 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('requestfailed', (r) => errors.push('failed ' + r.url()));
page.on('response', (r) => { if (r.status() >= 400) errors.push(r.status() + ' ' + r.url()); });
await page.goto(`http://127.0.0.1:${server.address().port}/${rel}`);
await page.waitForLoadState('networkidle');
await page.evaluate(() => document.fonts.ready);
const size = await page.evaluate(() => ({ h: document.documentElement.scrollHeight }));
await page.setViewportSize({ width: 1940, height: size.h });
await page.waitForTimeout(300);
await page.evaluate(() => window.drawMarks?.());
const parts = await page.locator(process.argv[5] ?? 'section.b-part').all();
let i = 0;
for (const part of parts) await part.screenshot({ path: `${prefix}-${++i}.png` });
console.log(JSON.stringify({ parts: parts.length, errors }));
await browser.close(); server.close();
