// Real-page shots of the web sidebar for sidebar-scroll board 03.
//   node capture.mjs [scene ...]     (no args = every scene)
// today = origin/main 4e70a8613; proto = the same tree + prototype-3.patch (quiet projects folded).
// css B = one scroll for the whole list, each group head held at the top while its group passes.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const K = '/var/tmp/sbs2';
const OUT = `${K}/shots`;
const { chromium } = await import(`${K}/today/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${K}/today/src/web/ui-migration/fixtures.mjs`);
const { RUNNERS, WORKSPACES, COUNTS, PROJECTS, WIKIS } = await import(`${K}/scripts/data.mjs`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
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
for (const t of ['today', 'proto', 'impl']) trees[t] = await serve(`${K}/${t}/src/web/dist`);
const CSS = {
  B: `.tp-lists.pin-workspaces { display: block; overflow-y: auto; scrollbar-gutter: stable; }
    .tp-lists.pin-workspaces > * { overflow: visible !important; }
    .tp-lists .tp-group-head { position: sticky; top: 0; z-index: 1; background: var(--bg-raised); }`,
  // C = B with the (short) Projects group moved above the Workspaces.
  C: `.tp-lists, .tp-lists.pin-workspaces { display: flex; flex-direction: column; overflow-y: auto; scrollbar-gutter: stable; }
    .tp-lists.tp-lists > * { flex: none !important; overflow: visible !important; }
    .tp-lists > .tp-group-projects { order: -2; }
    .tp-lists > .tp-divider:has(+ .tp-group-projects) { order: -1; }
    .tp-lists .tp-group-head { position: sticky; top: 0; z-index: 1; background: var(--bg-raised); }`,
};
const H = Number(process.env.H ?? 1000);
const SCENES = {
  'today-rest': { tree: 'today', vp: { w: 1440, h: H } },
  'today-scrolled': { tree: 'today', vp: { w: 1440, h: H }, scroll: { sel: 'projects', to: 'end' } },
  'a-rest': { tree: 'proto', vp: { w: 1440, h: H } },
  'b-rest': { tree: 'today', vp: { w: 1440, h: H }, css: 'B' },
  'b-scrolled': { tree: 'today', vp: { w: 1440, h: H }, css: 'B', scroll: { sel: '.tp-lists', to: 'projects-head' } },
  'ab-scrolled': { tree: 'proto', vp: { w: 1440, h: H }, css: 'B', scroll: { sel: '.tp-lists', to: 'projects-head' } },
  'c-rest': { tree: 'proto', vp: { w: 1440, h: H }, css: 'C' },
  'c-laptop': { tree: 'proto', vp: { w: 1440, h: 800 }, css: 'C' },
  'c-laptop-scrolled': { tree: 'proto', vp: { w: 1440, h: 800 }, css: 'C', scroll: { sel: '.tp-lists', to: 'end' } },
  'impl-rest': { tree: 'impl', vp: { w: 1440, h: H } },
  'impl-scrolled': { tree: 'impl', vp: { w: 1440, h: H }, scroll: { sel: '.tp-lists', to: 'projects-head' } },
  'impl-laptop-scrolled': { tree: 'impl', vp: { w: 1440, h: 800 }, scroll: { sel: '.tp-lists', to: 'end' } },
  'a-laptop': { tree: 'proto', vp: { w: 1440, h: 800 } },
  'a-laptop-scrolled': { tree: 'proto', vp: { w: 1440, h: 800 }, scroll: { sel: '.tp-lists', to: 'end' } },
  'ab-laptop-scrolled': { tree: 'proto', vp: { w: 1440, h: 800 }, css: 'B', scroll: { sel: '.tp-lists', to: 'projects-head' } },
};
const browser = await chromium.launch({
  executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome',
  env: { ...process.env, FONTCONFIG_FILE: '/mnt/data/tmp/d-fonts/fonts.conf' },
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
  page.setDefaultTimeout(30_000);
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
    if (p === '/api/wiki/spaces') return route.fulfill({ json: WIKIS });
    return route.fallback();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${trees[s.tree].base}/workspaces/${WORKSPACES[0].id}`);
  await page.locator('.tp-project').first().waitFor({ state: 'attached' });
  await page.locator('.tp-workspace-name', { hasText: /^orbit$/ }).waitFor({ state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
  if (s.css) await page.addStyleTag({ content: CSS[s.css] });
  await page.mouse.move(s.vp.w - 5, s.vp.h - 5);
  await page.waitForTimeout(400);
  if (s.scroll) {
    await page.evaluate(({ sel, to }) => {
      const groups = [...document.querySelectorAll('.app-nav .tp-group')];
      const named = (n) => groups.find((g) => g.querySelector('.tp-group-name')?.textContent === n);
      const el = sel === 'projects' ? named('Projects') : document.querySelector(`.app-nav ${sel}`);
      let top = to;
      if (to === 'end') top = el.scrollHeight;
      if (to === 'projects-head') {
        const head = named('Projects').querySelector('.tp-group-head');
        top = head.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop + 3 * 36;
      }
      el.scrollTop = top;
    }, s.scroll);
    await page.waitForTimeout(120);
  }
  const nav = await page.locator('aside.app-nav').boundingBox();
  const clip = { x: nav.x, y: nav.y, width: nav.width, height: Math.min(nav.height, s.vp.h - nav.y) };
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  const boxes = await page.evaluate((clip) => {
    const rel = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
      return [+(b.x - clip.x).toFixed(1), +(b.y - clip.y).toFixed(1), +b.width.toFixed(1), +b.height.toFixed(1)]; };
    const groups = [...document.querySelectorAll('.app-nav .tp-group')];
    const named = (n) => groups.find((g) => g.querySelector('.tp-group-name')?.textContent === n);
    const ws = named('Workspaces'), wk = named('Wiki'), pj = named('Projects');
    const lists = document.querySelector('.app-nav .tp-lists');
    const visible = (g, sel) => {
      if (!g) return 0;
      const sb = lists.getBoundingClientRect(), gb = g.getBoundingClientRect();
      const top = Math.max(gb.top, sb.top), bottom = Math.min(gb.bottom, sb.bottom);
      let n = 0;
      for (const r of g.querySelectorAll(sel)) { const b = r.getBoundingClientRect();
        n += Math.max(0, Math.min(b.bottom, bottom) - Math.max(b.top, top)) / b.height; }
      return +n.toFixed(1);
    };
    const pjb = pj.getBoundingClientRect(), lb = lists.getBoundingClientRect();
    return {
      ws: rel(ws), wk: rel(wk), pj: [ +(pjb.x - clip.x).toFixed(1), +(Math.max(pjb.top, lb.top) - clip.y).toFixed(1), +pjb.width.toFixed(1), +(Math.min(pjb.bottom, lb.bottom) - Math.max(pjb.top, lb.top)).toFixed(1)],
      pjHead: rel(pj.querySelector('.tp-group-head')), wsHead: rel(ws.querySelector('.tp-group-head')),
      quiet: rel(document.querySelector('.tp-project-quiet')), lists: rel(lists),
      user: rel(document.querySelector('.app-nav .tp-user')),
      pinned: !!document.querySelector('.app-nav .tp-lists.pin-workspaces'),
      wsRows: visible(ws, '.tp-workspace-name'), pjRows: visible(pj, '.tp-project'), pjTotal: pj.querySelectorAll('.tp-project').length,
      top: document.querySelector('.app-nav').innerText.split('\n').slice(0, 3),
    };
  }, clip);
  allBoxes[name] = { vp: s.vp, w: clip.width, h: clip.height, boxes, errors, unhandled: fx.unhandled.slice(0, 5) };
  console.log(name, JSON.stringify({ pinned: boxes.pinned, wsRows: boxes.wsRows, pjRows: boxes.pjRows, pjTotal: boxes.pjTotal, top: boxes.top, errors, unhandled: fx.unhandled.length }));
  await context.close();
}
fs.writeFileSync(boxesFile, JSON.stringify(allBoxes, null, 1));
await browser.close();
for (const t of Object.values(trees)) t.server.close();
