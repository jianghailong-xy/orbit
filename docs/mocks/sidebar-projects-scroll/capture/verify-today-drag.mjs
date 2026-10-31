// Real-browser checks of the implemented sidebar scroll (the worktree's own build, src/web/dist):
// which mode at which height, the switch on resize and on collapse, ⌘↓ into view, Edit-drag
// auto-scroll, ⌘P/⌘1 alignment, the phone drawer. Prints one JSON object; shots in impl-shots/.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const K = '/var/tmp/sidebar-scroll-mock';
const WT = '/root/.orbit/worktrees/01a1929c-d2be-76c1-91ae-9672d194267c';
const OUT = `${K}/impl-shots`;
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { RUNNERS, WORKSPACES, COUNTS, PROJECTS } = await import(`${K}/scripts/data.mjs`);
const DIST = `${K}/today/src/web/dist`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let f = path.join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/cursor-engine-mock/fonts.conf' },
  ignoreDefaultArgs: ['--hide-scrollbars'],
});
async function open(w, h, route = `/workspaces/${WORKSPACES[0].id}`) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-US', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await installFixedDate(page);
  await installFixtures(page, { theme: 'light' });
  await page.route('**/api/**', (route) => {
    const req = route.request(); const p = new URL(req.url()).pathname;
    if (req.method() !== 'GET') return route.fallback();
    if (p === '/api/runners') return route.fulfill({ json: RUNNERS });
    if (p === '/api/workspaces') return route.fulfill({ json: WORKSPACES });
    if (p === '/api/sessions/counts') return route.fulfill({ json: COUNTS });
    if (p === '/api/projects/sidebar') return route.fulfill({ json: PROJECTS });
    return route.fallback();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}${route}`);
  if (w <= 960) { await page.locator('button[aria-label="Open menu"]').click(); await page.waitForTimeout(400); }
  await page.locator('.tp-project').nth(23).waitFor({ state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(w - 5, h - 5);
  await page.waitForTimeout(250);
  return { context, page, errors };
}
const state = (page) => page.evaluate(() => {
  const r = (el) => { const b = el?.getBoundingClientRect(); return b ? { top: Math.round(b.top), bottom: Math.round(b.bottom), right: Math.round(b.right), h: Math.round(b.height) } : null; };
  const lists = document.querySelector('.tp-lists') ?? document.querySelector('.tp-scroll');
  const ws = document.querySelector('.tp-group-workspaces') ?? document.querySelectorAll('.tp-group')[0];
  const pj = document.querySelector('.tp-group-projects') ?? document.querySelectorAll('.tp-group')[1];
  return {
    pinned: lists.classList.contains('pin-workspaces'),
    lists: r(lists), listsScroll: lists.scrollTop, ws: r(ws), pj: r(pj), pjScroll: pj.scrollTop,
    nav: r(document.querySelector('.tp-section')),
    navKbd: r(document.querySelector('.tp-nav-shortcut'))?.right, ws1Kbd: r(document.querySelector('.tp-workspace-shortcut'))?.right,
    active: document.querySelector('.tp-item.active .tp-workspace-name')?.textContent ?? null,
    activeRow: r(document.querySelector('.tp-item.active')),
  };
});
const out = {};
{
  const { context, page, errors } = await open(1440, 600);
  await page.locator('.tp-group-head').first().hover();
  await page.locator('.tp-group-action').first().click();
  await page.waitForTimeout(300);
  const handle = page.locator('.tp-workspace-handle').first();
  const hb = await handle.boundingBox();
  const s0 = await state(page);
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let y = hb.y; y < s0.lists.bottom - 6; y += 20) await page.mouse.move(hb.x + hb.width / 2, y);
  await page.mouse.move(hb.x + hb.width / 2, s0.lists.bottom - 4);
  await page.waitForTimeout(1500);
  const s1 = await state(page);
  const max = await page.evaluate(() => { const e = document.querySelector('.tp-scroll'); return e.scrollHeight - e.clientHeight; });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  out.todayEditDrag = { scrollBefore: s0.listsScroll, scrollWhileHeld: s1.listsScroll, maxScrollWhileHeld: max, errors };
  await context.close();
}
console.log(JSON.stringify(out));
await browser.close(); server.close();
