// Real-page shots of the web sidebar for the sidebar-scroll board.
//   node capture.mjs [scene ...]     (no args = every scene)
// Serves two static builds (today = HEAD, proto = HEAD + prototype.patch) on port 0, feeds the
// ui-migration fixtures plus data.mjs, clips .app-nav per scene into shots/, boxes into shots/boxes.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const K = '/var/tmp/sidebar-scroll-mock';
const OUT = `${K}/shots`;
const { chromium } = await import(`${K}/today/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${K}/today/src/web/ui-migration/fixtures.mjs`);
const { RUNNERS, WORKSPACES, COUNTS, PROJECTS } = await import(`${K}/scripts/data.mjs`);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
function serve(dist) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.join(dist, p);
      if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const trees = {};
for (const t of ['today', 'proto', 'proto2']) trees[t] = await serve(`${K}/${t}/src/web/dist`);

// Variants drawn over a build: A = proto with the Workspaces group never scrolling (only Projects
// do); C = today with each group head held at the top of the one scroll.
const CSS = {
  // Not a scroll container, so never shrunk; 16px right keeps its rows on the others' gutter line.
  A: `.tp-group-scroll:has(.tp-workspace-name) { overflow: visible; padding-right: 16px; }`,
  C: `.tp-group-head { position: sticky; top: 0; z-index: 1; background: var(--bg-raised); }`,
  // B' = proto with the two groups split 2:1 when both overflow (fr tracks: no hand-back when one is short).
  B2: `.tp-scroll { grid-template-rows: max-content max-content minmax(0, 2fr) max-content minmax(0, 1fr); }`,
  // PIN = proto2's "only Projects scroll" layout forced on, whatever the measurement says: the rule
  // taken literally, with no room kept for the projects.
  PIN: `.tp-lists { display: flex; flex-direction: column; overflow: hidden; scrollbar-gutter: auto; }
    .tp-lists > * { flex: none; }
    .tp-lists > .tp-group-workspaces { overflow: hidden; scrollbar-gutter: stable; }
    .tp-lists > .tp-group-projects { flex: 1 1 0; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
    .tp-lists > .tp-group-projects .tp-group-head { position: sticky; top: 0; z-index: 1; background: var(--bg-raised); }`,
};
const D = { w: 1440, h: 800 };
const SCENES = {
  'today-top': { tree: 'today', vp: D },
  'today-scrolled': { tree: 'today', vp: D, scroll: { sel: '.tp-scroll', to: 'end' } },
  'b-rest': { tree: 'proto', vp: D },
  'b-projects-scrolled': { tree: 'proto', vp: D, scroll: { sel: 'projects', to: 8 * 36 } },
  'b-ws-scrolled': { tree: 'proto', vp: D, scroll: { sel: 'workspaces', to: 'end' } },
  'b-ws-folded': { tree: 'proto', vp: D, fold: 'Workspaces' },
  'b-tall': { tree: 'proto', vp: { w: 1440, h: 1300 } },
  'today-tall': { tree: 'today', vp: { w: 1440, h: 1300 } },
  'b-drawer': { tree: 'proto', vp: { w: 390, h: 760 }, drawer: true },
  'today-drawer': { tree: 'today', vp: { w: 390, h: 760 }, drawer: true },
  'a-rest': { tree: 'proto', vp: D, css: 'A' },
  'b2-rest': { tree: 'proto', vp: D, css: 'B2' },
  // The owner's rule (proto2): Workspaces fit -> only Projects scroll; else both scroll as one.
  'd-tall-rest': { tree: 'proto2', vp: { w: 1440, h: 1300 } },
  'd-tall-scrolled': { tree: 'proto2', vp: { w: 1440, h: 1300 }, scroll: { sel: 'projects', to: 8 * 36 } },
  'd-laptop-rest': { tree: 'proto2', vp: D },
  'd-laptop-scrolled': { tree: 'proto2', vp: D, scroll: { sel: '.tp-lists', to: 330 } },
  'd-900-literal': { tree: 'proto2', vp: { w: 1440, h: 900 }, css: 'PIN' },
  'd-900': { tree: 'proto2', vp: { w: 1440, h: 900 } },
  'd-900-literal-scrolled': { tree: 'proto2', vp: { w: 1440, h: 900 }, css: 'PIN', scroll: { sel: 'projects', to: 4 * 36 } },
  'd-900-scrolled': { tree: 'proto2', vp: { w: 1440, h: 900 }, scroll: { sel: '.tp-lists', to: 'end' } },
  'd-1000': { tree: 'proto2', vp: { w: 1440, h: 1000 } },
  'd-ws-folded': { tree: 'proto2', vp: D, fold: 'Workspaces' },
  'd-drawer': { tree: 'proto2', vp: { w: 390, h: 760 }, drawer: true },
  'c-scrolled': { tree: 'today', vp: D, css: 'C', scroll: { sel: '.tp-scroll', to: 'projects-head' } },
};

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/cursor-engine-mock/fonts.conf' },
  // Real scrollbars: Playwright hides them by default, and their 8px gutter is part of the layout.
  ignoreDefaultArgs: ['--hide-scrollbars'],
});
const boxesFile = `${OUT}/boxes.json`;
const allBoxes = fs.existsSync(boxesFile) ? JSON.parse(fs.readFileSync(boxesFile, 'utf8')) : {};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENES);
for (const name of wanted) {
  const s = SCENES[name];
  const context = await browser.newContext({ viewport: { width: s.vp.w, height: s.vp.h }, deviceScaleFactor: 2,
    colorScheme: 'light', locale: 'en-US', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await installFixedDate(page);
  const fx = await installFixtures(page, { theme: 'light' });
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.method() !== 'GET') return route.fallback();
    if (p === '/api/runners') return route.fulfill({ json: RUNNERS });
    if (p === '/api/workspaces') return route.fulfill({ json: WORKSPACES });
    if (p === '/api/sessions/counts') return route.fulfill({ json: COUNTS });
    if (p === '/api/projects/sidebar') return route.fulfill({ json: PROJECTS });
    return route.fallback();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${trees[s.tree].base}/workspaces/${WORKSPACES[0].id}`);
  if (s.drawer) {
    await page.locator('button[aria-label="Open menu"]').click();
    await page.waitForTimeout(400);
  }
  await page.locator('.tp-project').nth(23).waitFor({ state: 'attached' });
  await page.locator('.tp-workspace-name', { hasText: /^orbit$/ }).waitFor({ state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
  if (s.css) await page.addStyleTag({ content: CSS[s.css] });
  await page.mouse.move(s.vp.w - 5, s.vp.h - 5);
  if (s.fold) {
    await page.locator('.tp-group-head', { has: page.locator('.tp-group-name', { hasText: s.fold }) }).click();
    await page.mouse.move(s.vp.w - 5, s.vp.h - 5);
  }
  await page.waitForTimeout(300);
  if (s.scroll) {
    await page.evaluate(({ sel, to }) => {
      const groups = [...document.querySelectorAll('.app-nav .tp-group')];
      const named = (name) => groups.find((g) => g.querySelector('.tp-group-name')?.textContent === name);
      const el = sel === 'projects' ? named('Projects') : sel === 'workspaces' ? named('Workspaces')
        : document.querySelector(`.app-nav ${sel}`);
      let top = to;
      if (to === 'end') top = el.scrollHeight;
      if (to === 'projects-head') {
        const head = named('Projects').querySelector('.tp-group-head');
        top = head.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop + 4 * 36;
      }
      el.scrollTop = top;
    }, s.scroll);
    await page.waitForTimeout(120); // inside the 1 s the thumb stays up
  }
  const nav = await page.locator('aside.app-nav').boundingBox();
  const clip = { x: nav.x, y: nav.y, width: nav.width, height: Math.min(nav.height, s.vp.h - nav.y) };
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  // Boxes relative to the clip, for the board's pins and its quoted numbers.
  const boxes = await page.evaluate((clip) => {
    const rel = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
      return { x: +(b.x - clip.x).toFixed(1), y: +(b.y - clip.y).toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
    // Found by their heads, so a folded group (no rows) still has its boxes.
    const groups = [...document.querySelectorAll('.app-nav .tp-group')];
    const named = (name) => groups.find((g) => g.querySelector('.tp-group-name')?.textContent === name);
    const ws = named('Workspaces');
    const pj = named('Projects');
    const visibleRows = (g, sel) => {
      if (!g) return 0;
      const gb = g.getBoundingClientRect();
      const scroller = g.closest('.tp-lists') ?? g.closest('.tp-scroll');
      const sb = scroller.getBoundingClientRect();
      const top = Math.max(gb.top, sb.top), bottom = Math.min(gb.bottom, sb.bottom, window.innerHeight);
      let n = 0;
      for (const r of g.querySelectorAll(sel)) { const b = r.getBoundingClientRect();
        n += Math.max(0, Math.min(b.bottom, bottom) - Math.max(b.top, top)) / b.height; }
      return +n.toFixed(1);
    };
    return {
      nav: rel(document.querySelector('.app-nav .tp-section')),
      scroll: rel(document.querySelector('.app-nav .tp-scroll')),
      ws: rel(ws), wsHead: rel(ws?.querySelector('.tp-group-head')),
      pj: rel(pj), pjHead: rel(pj?.querySelector('.tp-group-head')),
      user: rel(document.querySelector('.app-nav .tp-user')),
      lists: rel(document.querySelector('.app-nav .tp-lists')),
      pinned: !!document.querySelector('.app-nav .tp-lists.pin-workspaces'),
      wsRows: visibleRows(ws, '.tp-workspace-name'), pjRows: visibleRows(pj, '.tp-project'),
      firstWsRow: rel(ws?.querySelector('.tp-item')), firstPjRow: rel(pj?.querySelector('.tp-project')),
      wsScroll: ws ? { top: ws.scrollTop, height: ws.scrollHeight, client: ws.clientHeight } : null,
      pjScroll: pj ? { top: pj.scrollTop, height: pj.scrollHeight, client: pj.clientHeight } : null,
    };
  }, clip);
  allBoxes[name] = { vp: s.vp, clip, px: { w: Math.round(clip.width * 2), h: Math.round(clip.height * 2) }, ...boxes,
    errors, unhandled: fx.unhandled.slice(0, 8) };
  console.log(name, JSON.stringify({ pinned: boxes.pinned, wsRows: boxes.wsRows, pjRows: boxes.pjRows, errors: errors.length, unhandled: fx.unhandled.length }));
  await context.close();
}
fs.writeFileSync(boxesFile, JSON.stringify(allBoxes, null, 1));
await browser.close();
for (const t of Object.values(trees)) t.server.close();
