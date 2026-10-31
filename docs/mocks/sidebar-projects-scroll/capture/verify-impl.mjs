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
const DIST = `${WT}/src/web/dist`;
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
  const lists = document.querySelector('.tp-lists');
  const ws = document.querySelector('.tp-group-workspaces');
  const pj = document.querySelector('.tp-group-projects');
  return {
    pinned: lists.classList.contains('pin-workspaces'),
    lists: r(lists), listsScroll: lists.scrollTop, ws: r(ws), pj: r(pj), pjScroll: pj.scrollTop,
    nav: r(document.querySelector('.tp-section')),
    navKbd: r(document.querySelector('.tp-nav-shortcut'))?.right, ws1Kbd: r(document.querySelector('.tp-workspace-shortcut'))?.right,
    active: document.querySelector('.tp-group-workspaces .tp-item.active .tp-workspace-name')?.textContent ?? null,
    activeRow: r(document.querySelector('.tp-group-workspaces .tp-item.active')),
  };
});
const out = {};

// a. 1300 tall: Workspaces fit -> pinned; scrolling Projects moves nothing else.
{
  const { context, page, errors } = await open(1440, 1300);
  const before = await state(page);
  await page.evaluate(() => { document.querySelector('.tp-group-projects').scrollTop = 288; });
  await page.waitForTimeout(120);
  const after = await state(page);
  await page.screenshot({ path: `${OUT}/i-1300-projects-scrolled.png`, clip: { x: 0, y: 0, width: 280, height: 1300 } });
  out.tall = { pinned: before.pinned, wsTopBefore: before.ws.top, wsTopAfter: after.ws.top, navTopAfter: after.nav.top, pjScroll: after.pjScroll, alignment: [before.navKbd, before.ws1Kbd], errors };
  // d. resize down and back up: the switch follows the window.
  await page.setViewportSize({ width: 1440, height: 700 }); await page.waitForTimeout(300);
  const small = await state(page);
  await page.setViewportSize({ width: 1440, height: 1300 }); await page.waitForTimeout(300);
  const big = await state(page);
  out.resize = { at700: small.pinned, at1300again: big.pinned, alignmentAt700: [small.navKbd, small.ws1Kbd] };
  // i. collapse to the icon rail and expand again.
  await page.locator('.tp-collapse-btn').click(); await page.waitForTimeout(400);
  const folded = await page.evaluate(() => ({ pinned: document.querySelector('.tp-lists').classList.contains('pin-workspaces'), shown: getComputedStyle(document.querySelector('.tp-scroll')).display }));
  await page.locator('.tp-collapse-btn').click(); await page.waitForTimeout(400);
  out.collapse = { whileFolded: folded, afterExpand: (await state(page)).pinned };
  await context.close();
}
// b. 800 tall, the literal rule: Workspaces + the Projects head fit -> pinned.
{
  const { context, page, errors } = await open(1440, 800);
  const s = await state(page);
  await page.screenshot({ path: `${OUT}/i-800.png`, clip: { x: 0, y: 0, width: 280, height: 800 } });
  out.at800 = { pinned: s.pinned, pjBox: s.pj, lists: s.lists, errors };
  await context.close();
}
// c. 780 tall: no room for the head -> one list; scrolling moves the Workspaces, the nav stays.
{
  const { context, page, errors } = await open(1440, 780);
  const before = await state(page);
  await page.evaluate(() => { document.querySelector('.tp-lists').scrollTop = 330; });
  await page.waitForTimeout(120);
  const after = await state(page);
  await page.screenshot({ path: `${OUT}/i-780-scrolled.png`, clip: { x: 0, y: 0, width: 280, height: 780 } });
  out.at780 = { pinned: before.pinned, wsTopBefore: before.ws.top, wsTopAfter: after.ws.top, navTopBefore: before.nav.top, navTopAfter: after.nav.top, alignment: [before.navKbd, before.ws1Kbd], errors };
  await context.close();
}
// e. ⌘↓ nine times at 600 tall: the stepped-to row stays inside the list.
{
  const { context, page, errors } = await open(1440, 600);
  const steps = [];
  for (let i = 0; i < 9; i += 1) {
    await page.keyboard.press('Meta+ArrowDown');
    await page.waitForTimeout(250);
    const s = await state(page);
    steps.push({ active: s.active, inView: s.activeRow && s.activeRow.top >= s.lists.top - 1 && s.activeRow.bottom <= s.lists.bottom + 1, listsScroll: s.listsScroll });
  }
  out.stepDown = { pinned: (await state(page)).pinned, steps, errors };
  await page.screenshot({ path: `${OUT}/i-600-stepped.png`, clip: { x: 0, y: 0, width: 280, height: 600 } });
  await context.close();
}
// f. Edit, then drag the first row toward the list's foot and hold: the list scrolls under it.
{
  const { context, page, errors } = await open(1440, 600);
  await page.locator('.tp-group-workspaces .tp-group-head').hover();
  await page.locator('.tp-group-workspaces .tp-group-action').click();
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
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(300);
  out.editDrag = { pinned: s0.pinned, listsScrollBefore: s0.listsScroll, listsScrollWhileHeld: s1.listsScroll, errors };
  await context.close();
}
// h. the phone drawer: no room -> one list.
{
  const { context, page, errors } = await open(390, 760);
  const s = await state(page);
  await page.screenshot({ path: `${OUT}/i-drawer.png`, clip: { x: 0, y: 0, width: 320, height: 760 } });
  out.drawer = { pinned: s.pinned, lists: s.lists, errors };
  await context.close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
