// Renders docs/mocks/sidebar-projects-scroll/board.html, one PNG per section.b-part (board-N.png).
// Served over HTTP so the board can fetch its prototype.patch; marks drawn after layout.
//   node render.mjs <board dir>
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const K = '/var/tmp/sidebar-scroll-mock';
const DIR = path.resolve(process.argv[2]);
const ROOT = path.dirname(DIR); // docs/mocks, for ../session-list-projects/web.css
const { chromium } = await import(`${K}/today/node_modules/playwright/index.mjs`);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.patch': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/cursor-engine-mock/fonts.conf' },
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
await page.goto(`http://127.0.0.1:${server.address().port}/${path.basename(DIR)}/board.html`, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => document.getElementById('patch')?.textContent.length > 0);
await page.evaluate(() => window.drawMarks());
const parts = await page.locator('section.b-part').count();
for (let i = 0; i < parts; i++) {
  const el = page.locator('section.b-part').nth(i);
  const box = await el.boundingBox();
  if (box.y + box.height > page.viewportSize().height || box.width > page.viewportSize().width) {
    await page.setViewportSize({ width: Math.ceil(Math.max(1500, box.x + box.width + 60)), height: Math.ceil(box.y + box.height + 60) });
    await page.evaluate(() => window.drawMarks());
  }
  await el.screenshot({ path: path.join(DIR, `board-${i + 1}.png`) });
  console.log(`board-${i + 1}.png`, Math.round(box.width), 'x', Math.round(box.height));
}
console.log('errors', JSON.stringify(errors));
await browser.close(); server.close();
