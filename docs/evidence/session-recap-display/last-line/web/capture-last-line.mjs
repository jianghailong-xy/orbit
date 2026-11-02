// Real-UI captures of the Recap card's one ⋯ (07-last-line B): the vite build of this branch over the repo's ui-migration
// fixtures. Adapted from ../hide/capture-hide.mjs. Usage (in a private netns): node capture-last-line.mjs <worktree> <dist> <fixtures-tree> <out-dir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [WT, DIST, FIX, OUT] = process.argv.slice(2);
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${FIX}/src/web/ui-migration/fixtures.mjs`);
const { SESSION } = await import(`${FIX}/src/web/ui-migration/session-fixtures.mjs`);
fs.mkdirSync(OUT, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

const TITLE = 'Disk cleanup';
const LONG = '已删10个旧模型仓库，释放258G，剩余319G；保留的3个模型和vLLM服务复核正常，下一步清164个worktree。';
const SHORT = 'Fixed the login redirect; the tests pass.';
const detail = (recapText) => ({ ...SESSION, title: TITLE, recapText, recapAt: '2026-09-28T11:44:00.000Z',
  lastAssistantText: 'Next: shall I list the 120 worktrees for you to confirm first?' });

const browser = await chromium.launch({ args: ['--disable-features=BackForwardCache'] });
const report = [];
async function shoot(name, { theme = 'light', width = 1440, height = 900, mobile = false, act = null, recap = LONG } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  await installFixedDate(page);
  await installFixtures(page, { theme });
  const row = detail(recap);
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const p = pathname.replace(/^\/api/, '');
    if (route.request().method() === 'GET' && p === '/sessions') return route.fulfill({ status: 200, json: [row] });
    if (route.request().method() === 'GET' && p === `/sessions/${SESSION.id}`) return route.fulfill({ status: 200, json: row });
    return route.fallback();
  });
  await page.goto(`http://127.0.0.1:${PORT}/sessions/${SESSION.id}`);
  await page.waitForSelector('.chat-recap', { timeout: 30_000 });
  await page.waitForFunction(() => !document.getElementById('boot'));
  await page.waitForTimeout(800);
  if (act === 'hover' || act === 'menu' || act === 'leave') await page.hover('.chat-recap-text');
  if (act === 'menu' || act === 'leave') {
    await page.waitForTimeout(200);
    await page.click('.chat-recap-more');
    await page.waitForSelector('[role="menu"]');
  }
  // With the menu open the pointer goes to it: the ⋯ stays shown although the pointer has left the card.
  if (act === 'leave') await page.hover('[role="menu"] [role="menuitem"]:last-child');
  if (act === 'tap') {
    await page.tap('.chat-recap-more');
    await page.waitForSelector('[role="menu"]');
  }
  await page.waitForTimeout(350);
  const facts = await page.evaluate(() => {
    const card = document.querySelector('.chat-recap'), more = document.querySelector('.chat-recap-more');
    const actions = document.querySelector('.chat-recap-actions'), line = document.querySelector('.chat-recap-line');
    const c = card.getBoundingClientRect(), m = more.getBoundingClientRect(), l = line.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('.chat-recap-text'));
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5);
    const lastTop = Math.max(...rects.map((r) => r.top));
    const lastRight = Math.max(...rects.filter((r) => Math.abs(r.top - lastTop) < 4).map((r) => r.right));
    const lh = parseFloat(getComputedStyle(line).lineHeight);
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => el.textContent.trim());
    const last = [...document.querySelectorAll('.chat-assistant')].pop().getBoundingClientRect();
    const menu = document.querySelector('[role="menu"]')?.getBoundingClientRect();
    return {
      buttons: card.querySelectorAll('button').length,
      label: more.getAttribute('aria-label'),
      opacity: getComputedStyle(actions).opacity,
      hoverNone: matchMedia('(hover: none)').matches,
      lines: Math.round(l.height / lh),
      paragraphWidth: Math.round(l.width),
      moreMiddleVsLastLineMiddle: +((m.top + m.bottom) / 2 - (c.bottom - lh / 2)).toFixed(1),
      gapLastWordToMore: +(m.left - lastRight).toFixed(1),
      items,
      clip: { top: Math.max(0, Math.round(last.top - 16)), bottom: Math.round(Math.max(c.bottom, menu ? menu.bottom : 0) + 60) },
    };
  });
  await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled',
    clip: { x: 0, y: facts.clip.top, width, height: Math.min(height, facts.clip.bottom) - facts.clip.top } });
  const entry = { scene: name, ...facts };
  delete entry.clip;
  report.push(entry);
  console.log(JSON.stringify(entry));
  await context.close();
}
try {
  await shoot('desktop-light-rest');
  await shoot('desktop-light-hover', { act: 'hover' });
  await shoot('desktop-light-menu', { act: 'menu' });
  await shoot('desktop-light-menu-pointer-in-menu', { act: 'leave' });
  await shoot('desktop-dark-hover', { theme: 'dark', act: 'hover' });
  await shoot('desktop-light-short-hover', { act: 'hover', recap: SHORT });
  await shoot('phone-light', { width: 390, height: 844, mobile: true });
  await shoot('phone-light-menu', { width: 390, height: 844, mobile: true, act: 'tap' });
} finally {
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
}
