// Real-UI captures of the Recap card's × (06-hide), before (HEAD) and after (this worktree): two vite builds over the repo's
// ui-migration fixtures. Usage (in a private netns): node capture-hide.mjs <out-dir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const WT = '/root/.orbit/worktrees/01a17de3-acfd-758b-9cc3-70a8fd96ba2a';
const FIX = '/var/tmp/recap-quiet-mock/before-tree'; // identical fixtures, with src/shared/dist built there
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${FIX}/src/web/ui-migration/fixtures.mjs`);
const { SESSION } = await import(`${FIX}/src/web/ui-migration/session-fixtures.mjs`);
const DISTS = { before: '/var/tmp/recap-quiet-mock/dist-before', after: '/var/tmp/recap-quiet-mock/dist-after' };
const OUT = process.argv[2] || '/var/tmp/recap-quiet-mock/shots-hide';
fs.mkdirSync(OUT, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };
const serve = (dist, port) => http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1');
const servers = [serve(DISTS.before, 5951), serve(DISTS.after, 5952)];
const PORT = { before: 5951, after: 5952 };

const TITLE = 'Research other coding agents';
const RECAP_AT = '2026-09-28T11:44:00.000Z';
const recapped = {
  ...SESSION, title: TITLE,
  recapText: 'Research done: integrate GitHub Copilot CLI first; Droid, CodeBuddy and Qoder next. Waiting on you to file the probe task.',
  recapAt: RECAP_AT, lastAssistantText: 'Next: shall I file a protocol probe task for Copilot CLI?',
};
const newer = { ...recapped, recapText: 'Probe task filed for Copilot CLI; the common ACP layer waits on your call.', recapAt: '2026-09-28T11:58:00.000Z' };
const row = (n, title, extra) => ({ ...SESSION, id: `${SESSION.id.slice(0, -1)}${n}`, title, lastTurnAt: '2026-09-28T10:00:00.000Z', ...extra });

const browser = await chromium.launch({ args: ['--disable-features=BackForwardCache'] });
const report = [];
async function shoot(tree, name, { theme = 'dark', width = 1440, height = 900, mobile = false, act = null, hiddenKey = null, detail = recapped } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  await installFixedDate(page);
  await installFixtures(page, { theme });
  // The fixtures clear localStorage on every load; a recap hidden on an earlier visit is put back after them.
  if (hiddenKey) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [`orbit.recap.hidden.${SESSION.id}`, hiddenKey]);
  const list = [detail, row('A', 'Drawer shadow fix', { lastAssistantText: 'Fixed the drawer shadow on iPad; web and iOS are merged.' })];
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const p = pathname.replace(/^\/api/, '');
    if (route.request().method() === 'GET' && p === '/sessions') return route.fulfill({ status: 200, json: list });
    if (route.request().method() === 'GET' && p === `/sessions/${SESSION.id}`) return route.fulfill({ status: 200, json: detail });
    return route.fallback();
  });
  await page.goto(`http://127.0.0.1:${PORT[tree]}/sessions/${SESSION.id}`);
  await page.waitForSelector('.chat-assistant', { timeout: 30_000 });
  await page.waitForFunction(() => !document.getElementById('boot'));
  await page.waitForTimeout(800);
  if (act === 'hover' || act === 'hide') await page.hover('.chat-recap-text');
  if (act === 'focus') await page.focus('.chat-recap-hide');
  if (act === 'hide') { await page.waitForTimeout(200); await page.click('.chat-recap-hide'); }
  await page.waitForTimeout(350);
  const facts = await page.evaluate((title) => {
    const card = document.querySelector('.chat-recap');
    const actions = document.querySelector('.chat-recap-actions') || document.querySelector('.chat-recap-refresh');
    const hide = document.querySelector('.chat-recap-hide');
    const rowEl = [...document.querySelectorAll('.session-row')].find((el) => el.querySelector('.session-title')?.textContent === title);
    const last = [...document.querySelectorAll('.chat-assistant')].pop().getBoundingClientRect();
    const r = card ? card.getBoundingClientRect() : null;
    return {
      card: card ? card.textContent : null,
      actionsOpacity: actions ? getComputedStyle(actions).opacity : null,
      hideLabel: hide ? hide.getAttribute('aria-label') : null,
      hiddenStored: Object.keys(localStorage).filter((k) => k.startsWith('orbit.recap.hidden.')).map((k) => [k.slice(-6), localStorage.getItem(k)]),
      listLine: rowEl?.querySelector('.session-preview')?.textContent ?? null,
      clip: { top: Math.max(0, Math.round(last.top - 16)), bottom: Math.round((r ? r.bottom : last.bottom) + 120) },
    };
  }, TITLE);
  await page.screenshot({ path: path.join(OUT, `${tree}-${name}.png`), animations: 'disabled',
    clip: { x: 0, y: facts.clip.top, width, height: Math.min(height, facts.clip.bottom) - facts.clip.top } });
  const entry = { tree, name, ...facts };
  delete entry.clip;
  report.push(entry);
  console.log(JSON.stringify(entry));
  await context.close();
}
try {
  await shoot('before', 'desktop-dark-hover', { act: 'hover' });
  await shoot('before', 'phone-dark', { width: 390, height: 844, mobile: true });
  await shoot('after', 'desktop-dark', {});
  await shoot('after', 'desktop-dark-hover', { act: 'hover' });
  await shoot('after', 'desktop-dark-focus', { act: 'focus' });
  await shoot('after', 'desktop-dark-hidden', { act: 'hide' });
  await shoot('after', 'desktop-dark-reopened', { hiddenKey: RECAP_AT });
  await shoot('after', 'desktop-dark-newer', { hiddenKey: RECAP_AT, detail: newer });
  await shoot('after', 'phone-dark', { width: 390, height: 844, mobile: true });
} finally {
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  for (const s of servers) s.close();
}
