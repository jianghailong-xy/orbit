// Real-UI captures of the Recap card, before (HEAD) and after (this worktree): two vite builds served side by side, driven by
// Playwright over the repo's ui-migration fixtures with the session list and the opened session's detail answered here.
// Adapted from docs/evidence/session-recap-display/web/capture.mjs. Usage (in a private netns): node capture.mjs <out-dir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const WT = '/root/.orbit/worktrees/01a17de3-acfd-758b-9cc3-70a8fd96ba2a';
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const FIX = '/var/tmp/recap-quiet-mock/before-tree'; // identical fixtures, with src/shared/dist built there
const { installFixtures, installFixedDate } = await import(`${FIX}/src/web/ui-migration/fixtures.mjs`);
const { SESSION } = await import(`${FIX}/src/web/ui-migration/session-fixtures.mjs`);
const DISTS = { before: '/var/tmp/recap-quiet-mock/dist-before', after: '/var/tmp/recap-quiet-mock/dist-after' };
const OUT = process.argv[2] || '/var/tmp/recap-quiet-mock/shots';
fs.mkdirSync(OUT, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };
const serve = (dist, port) => http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1');
const servers = { before: serve(DISTS.before, 5941), after: serve(DISTS.after, 5942) };
const PORT = { before: 5941, after: 5942 };

const recapped = {
  ...SESSION, title: 'Research other coding agents',
  recapText: 'Research done: integrate GitHub Copilot CLI first; Droid, CodeBuddy and Qoder next. Waiting on you to file the probe task.',
  recapAt: '2026-09-28T11:44:00.000Z', lastAssistantText: 'Next: shall I file a protocol probe task for Copilot CLI?',
};
const row = (n, title, extra) => ({ ...SESSION, id: `${SESSION.id.slice(0, -1)}${n}`, title, lastTurnAt: '2026-09-28T10:00:00.000Z', ...extra });
const LIST = [
  recapped,
  row('A', 'Disk space cleanup', { recapText: 'Deleted 10 old model repositories and freed 258G; 319G free. Next: clear 164 old worktrees.', recapAt: '2026-09-27T11:31:00.000Z' }),
  row('B', 'Drawer shadow fix', { lastAssistantText: 'Fixed the drawer shadow on iPad; web and iOS are merged.' }),
];

const browser = await chromium.launch({ args: ['--disable-features=BackForwardCache'] });
const report = [];
async function shoot(tree, name, { theme, width, height, mobile = false, act = null }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  await installFixedDate(page);
  await installFixtures(page, { theme });
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const p = pathname.replace(/^\/api/, '');
    if (route.request().method() === 'GET' && p === '/sessions') return route.fulfill({ status: 200, json: LIST });
    if (route.request().method() === 'GET' && p === `/sessions/${SESSION.id}`) return route.fulfill({ status: 200, json: recapped });
    return route.fallback();
  });
  await page.goto(`http://127.0.0.1:${PORT[tree]}/sessions/${SESSION.id}`);
  await page.waitForSelector('.chat-recap', { timeout: 30_000 });
  await page.waitForFunction(() => !document.getElementById('boot'));
  await page.waitForTimeout(600);
  if (act === 'hover') await page.hover('.chat-recap-text');
  if (act === 'focus') await page.focus('.chat-recap-refresh');
  await page.waitForTimeout(300);
  const facts = await page.evaluate(() => {
    const card = document.querySelector('.chat-recap');
    const btn = document.querySelector('.chat-recap-refresh');
    const cs = getComputedStyle(card);
    const r = card.getBoundingClientRect();
    const last = [...document.querySelectorAll('.chat-assistant')].pop();
    const lr = last ? last.getBoundingClientRect() : null;
    const textEl = document.querySelector('.chat-recap-line') || document.querySelector('.chat-recap-text');
    return {
      background: cs.backgroundColor, radius: cs.borderTopLeftRadius, height: Math.round(r.height), width: Math.round(r.width),
      left: Math.round(r.left), replyLeft: lr ? Math.round(lr.left + parseFloat(getComputedStyle(last).paddingLeft)) : null,
      textLeft: Math.round(textEl.getBoundingClientRect().left),
      textColor: getComputedStyle(textEl).color, fontSize: getComputedStyle(textEl).fontSize,
      refreshOpacity: getComputedStyle(btn).opacity, focusVisible: btn.matches(':focus-visible'),
      hoverNone: matchMedia('(hover: none)').matches, text: card.textContent,
      clip: { top: Math.max(0, Math.round((lr ? lr.top : r.top) - 16)), bottom: Math.round(r.bottom + 120) },
    };
  });
  const clip = { x: 0, y: facts.clip.top, width, height: Math.min(height, facts.clip.bottom) - facts.clip.top };
  await page.screenshot({ path: path.join(OUT, `${tree}-${name}.png`), animations: 'disabled', clip });
  report.push({ tree, name, ...facts });
  console.log(JSON.stringify({ tree, name, ...facts }));
  await context.close();
}
try {
  for (const tree of ['before', 'after']) {
    await shoot(tree, 'desktop-dark', { theme: 'dark', width: 1440, height: 900 });
    await shoot(tree, 'desktop-light', { theme: 'light', width: 1440, height: 900 });
    await shoot(tree, 'phone-dark', { theme: 'dark', width: 390, height: 844, mobile: true });
  }
  await shoot('after', 'desktop-dark-hover', { theme: 'dark', width: 1440, height: 900, act: 'hover' });
  await shoot('after', 'desktop-dark-focus', { theme: 'dark', width: 1440, height: 900, act: 'focus' });
} finally {
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  for (const s of Object.values(servers)) s.close();
}
