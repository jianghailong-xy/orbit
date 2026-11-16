// Renders board.html into board-N.png (one per section.b-part), deviceScaleFactor 2.
// RUN: FONTCONFIG_FILE=<fonts.conf with Inter/Noto/JetBrains Mono> node render.mjs <repoRoot> <playwrightDir>
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
const PW = process.argv[3];
const BOARD = 'docs/mocks/ios-project-page-and-coordinator-cards';
const { chromium } = await import(`${PW}/index.mjs`);
const T = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': T[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1900, height: 1200 }, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${server.address().port}/${BOARD}/board.html`);
await page.waitForLoadState('networkidle');
await page.waitForTimeout(800);
const parts = await page.$$('section.b-part');
for (const [i, part] of parts.entries()) {
  await part.screenshot({ path: path.join(ROOT, BOARD, `board-${i + 1}.png`) });
  const b = await part.boundingBox();
  console.log(`board-${i + 1}.png`, `${Math.round(b.width)}x${Math.round(b.height)}`);
}
await browser.close();
server.close();
