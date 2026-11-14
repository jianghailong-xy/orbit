// Real web console frames for docs/mocks/project-rows-by-workspace (2026-11-07). Serves three
// builds of the same main tree — today, option A (+ the two fixes), option B — over the repo's
// ui-migration fixtures plus the sample account in data.mjs, drives keys and clicks, and writes
// <OUT>/<scene>.png and <OUT>/marks.json (CSS-px boxes of the elements the board rings).
//
// RUN: bash run.sh <outDir> [scene,scene]
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NOW, makeData } from './data.mjs';

const TREE = process.env.TREE ?? '/var/tmp/prj-col/today';
const BUILDS = process.env.BUILDS ?? '/var/tmp/prj-col';
const OUT = process.argv[2] ?? '/mnt/data/tmp/prj-col-kit/out';
const ONLY = (process.argv[3] ?? '').split(',').filter(Boolean);
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(`${TREE}/node_modules/playwright/index.mjs`);
const { installFixtures } = await import(`${TREE}/src/web/ui-migration/fixtures.mjs`);
const { uuidToBase62 } = await import(`${TREE}/src/shared/dist/index.js`);
const data = makeData(uuidToBase62);
const { R, W, P, D, S, rows, sidebarDoc, coordinatorOf, sid } = data;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
async function serve(dist) {
  const server = http.createServer((req, res) => {
    let file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
const SITES = {};
for (const build of ['today']) SITES[build] = await serve(`${BUILDS}/dist-${build}`);

async function fixDate(page) {
  await page.addInitScript((timestamp) => {
    window.Date = new Proxy(Date, {
      construct: (D, args) => Reflect.construct(D, args.length ? args : [timestamp]),
      apply: (D) => new D(timestamp).toString(),
      get: (D, key) => key === 'now' ? () => timestamp : Reflect.get(D, key),
    });
  }, NOW);
}

const readAt = new Date(NOW).toISOString();
const NO_LINE = {
  line: null, lineAbsentReason: 'NOT_DECIDED', ref: null, upstreamRef: null, source: null,
  locked: false, startedAt: null, mergeCheckCommand: null, mergeCheckCommandAbsentReason: 'NOT_CONFIGURED',
  mergeCheckTimeoutSeconds: null, escalationSeconds: 3600, commitsAheadOfUpstream: null,
  commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET', lastUpstreamSyncAt: null,
  lastUpstreamSyncAbsentReason: 'NEVER_SYNCED', integratingCount: 0, queuedCount: 0, mergeCheckOnTip: 'UNKNOWN', inFlight: null,
};
const byId = new Map(rows.map((row) => [row.id, row]));
let turn = 7000;
const eventsFor = (row) => {
  const turnId = sid(turn++);
  const events = [{ seq: 1, type: 'user', payload: { text: row.prompt }, turnId, ts: row.createdAt }];
  if (row.lastAssistantText) events.push({ seq: 2, type: 'assistant', payload: { text: row.lastAssistantText }, turnId, ts: row.lastTurnAt });
  if (row.status !== 'RUNNING') events.push({ seq: 3, type: 'turn_end', payload: {}, turnId, ts: row.lastTurnAt });
  return events;
};

async function routes(page, unhandled) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const q = url.searchParams;
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (request.method() !== 'GET') return route.fallback();
    if (p === '/api/runners') return json([R.hpc, R.wikova]);
    if (p === '/api/workspaces') return json([W.dev, W.prod]);
    if (p === '/api/sessions/counts') {
      return json([W.dev, W.prod].map((w) => {
        const open = rows.filter((r) => r.workspaceId === w.id && r.lifecycleState === 'OPEN');
        const running = open.filter((r) => r.status === 'RUNNING').length;
        return { workspaceId: w.id, active: running, running, jobs: 0, needsYou: 0 };
      }));
    }
    if (p === '/api/sessions') {
      const view = q.get('view') ?? 'open';
      const life = view === 'completed' || view === 'archived' ? 'COMPLETED' : view === 'trash' ? 'TRASH' : 'OPEN';
      let list = rows.filter((r) => r.lifecycleState === life);
      if (q.get('projectId')) list = list.filter((r) => r.projectMembership?.projectId === q.get('projectId'));
      else {
        if (q.get('workspaceId')) list = list.filter((r) => r.workspaceId === q.get('workspaceId'));
        if (q.get('runnerId')) list = list.filter((r) => r.runnerId === q.get('runnerId'));
      }
      list.sort((a, b) => Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt));
      return json(list);
    }
    if (p === '/api/projects/sidebar') return json([P.search, P.android, P.google].map(sidebarDoc));
    if (p === '/api/projects') {
      const all = Object.values(P).map(sidebarDoc);
      return json(q.get('status') ? all.filter((x) => x.status === q.get('status')) : all);
    }
    const pm = p.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    const project = pm && Object.values(P).find((x) => x.id === pm[1]);
    if (project) {
      const c = coordinatorOf(project);
      const sub = pm[2] ?? '';
      if (!sub) {
        return json({ ...sidebarDoc(project), goal: '', instructions: '', coordinatorSessionId: c?.id ?? null,
          coordinatorWorkspaceId: c?.workspaceId ?? null, _count: { tasks: project.counts.total },
          tasksByStatus: { DONE: project.counts.done, OPEN: project.counts.total - project.counts.done },
          blockers: { open: [], resolved: [], resolvedCount: 0 } });
      }
      if (sub === '/integration') return json(NO_LINE);
      if (sub === '/promotions/current') return json(null);
      if (sub === '/promotions/merged') return json([]);
      if (sub === '/handoffs') return json([]);
      if (sub === '/open-items') return json({ needsYou: [], withCoordinator: [], startRequest: null, readAt });
      if (sub === '/coordinator/status') return json({ coordination: { sessionId: c?.id ?? null, workspaceId: c?.workspaceId ?? null }, readAt });
      if (sub.startsWith('/acceptance/criteria-decisions/pending')) {
        return json({ projectId: project.id, readAt, count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [], settled: [] });
      }
      if (sub === '/acceptance/confirmation') return json(null);
    }
    const sm = p.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
    const row = sm && byId.get(sm[1]);
    if (row) {
      const sub = sm[2] ?? '';
      if (!sub) return json(row);
      if (sub === '/events/page') return json({ events: eventsFor(row), hasMore: false });
      if (sub === '/diff') return json({ files: [], patches: [] });
      if (sub === '/created-tasks') return json({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return json([]);
    }
    if (p.startsWith('/api/sessions/') || p.startsWith('/api/projects/')) unhandled.push(`${p}?${q}`);
    return route.fallback();
  });
}

// Named boxes, in CSS px of the viewport, for the board's rings.
async function boxes(page, spec) {
  return page.evaluate((spec) => {
    const rowByTitle = (title) => [...document.querySelectorAll('.session-row')]
      .find((r) => r.querySelector('.session-title')?.textContent.trim() === title) ?? null;
    const find = (l) => {
      if (l.k === 'row') return rowByTitle(l.title);
      if (l.k === 'project') return document.querySelector(`.session-project-row[data-project-id="${l.id}"]`);
      if (l.k === 'active') return document.querySelector('.session-row.active');
      if (l.k === 'ws') return [...document.querySelectorAll('.tp-group-workspaces .tp-item')].find((el) => el.textContent.includes(l.name)) ?? null;
      if (l.k === 'menu') return [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim().startsWith(l.text)) ?? null;
      if (l.k === 'menuAll') {
        const items = [...document.querySelectorAll('[role="menuitem"]')].filter((el) => l.texts.some((t) => el.textContent.trim().startsWith(t)));
        return items.length ? items : null;
      }
      if (l.k === 'head') return [...document.querySelectorAll('h1, h2, h3, div, span')]
        .find((el) => el.children.length === 0 && el.textContent.trim() === l.title && el.getBoundingClientRect().x > 600) ?? null;
      if (l.k === 'css') return document.querySelector(l.css);
      if (l.k === 'sub') {
        const of = find(l.of);
        return of ? of.querySelector(l.css) : null;
      }
      return null;
    };
    const out = {};
    for (const [name, l] of Object.entries(spec)) {
      const found = find(l);
      const els = Array.isArray(found) ? found : found ? [found] : [];
      if (!els.length) { out[name] = null; continue; }
      const rs = els.map((el) => el.getBoundingClientRect());
      const x = Math.min(...rs.map((r) => r.x)); const y = Math.min(...rs.map((r) => r.y));
      const x2 = Math.max(...rs.map((r) => r.x + r.width)); const y2 = Math.max(...rs.map((r) => r.y + r.height));
      out[name] = [Math.round(x), Math.round(y), Math.round(x2 - x), Math.round(y2 - y)];
    }
    return out;
  }, spec);
}

const at = (session, extra = '') => `/sessions/${session.id}${extra}`;
const pq = (p) => `?project=${p.id}`;
const proj = (p) => ({ k: 'project', id: p.id });
const rowT = (title) => ({ k: 'row', title });
const sub = (of, css) => ({ k: 'sub', of, css });
const COMMON = { active: { k: 'active' }, aside: { k: 'css', css: 'aside.session-col' }, nav: { k: 'css', css: 'aside.app-nav' } };
const PAGE = { coord: { k: 'css', css: '.session-project-coordinator .session-row' }, back: { k: 'css', css: '.session-folder-back' },
  head: { k: 'css', css: '.session-project-page-header' }, open: { k: 'css', css: '.session-project-page-open' }, t7: rowT(D.t7.title) };
const SCENES = {
  't-list': { path: at(D.review), boxes: { project: proj(P.search) } },
  't-click': { path: at(D.review), clickProject: P.search, boxes: PAGE },
  'c-coord': { path: at(D.c1), boxes: { project: proj(P.search) } },
  'c-coord-page': { path: at(D.c1, pq(P.search)), closeGlyph: true, boxes: PAGE },
  'c-member': { path: at(D.t7), boxes: { project: proj(P.search) } },
  'c-member-page': { path: at(D.t7, pq(P.search)), closeGlyph: true, boxes: PAGE },
  // Decisions of 11-11: column at the right, a project button in the coordinator's title bar.
  'n-wide': { path: at(D.c1, pq(P.search)), closeGlyph: true, button: 'on', boxes: { ...PAGE, pbtn: { k: 'css', css: '#b-pbtn' } } },
  'n-narrow': { path: at(D.c1), button: 'off', boxes: { project: proj(P.search), pbtn: { k: 'css', css: '#b-pbtn' } } },
  'n-member': { path: at(D.t7, pq(P.search)), closeGlyph: true, button: 'on', boxes: { ...PAGE, pbtn: { k: 'css', css: '#b-pbtn' } } },
  'p-coord': { phone: true, path: at(D.c1), button: 'off', boxes: { pbtn: { k: 'css', css: '#b-pbtn' }, head: { k: 'css', css: '.workspace-header' } } },
  'p-page': { phone: true, path: `/workspaces/${W.dev.id}${pq(P.search)}`, closeGlyph: true, boxes: PAGE },
};

const VIEW = { width: 1180, height: 760 };
const browser = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome', ignoreDefaultArgs: ['--hide-scrollbars'] });
const report = {};
const marks = {};
for (const [name, scene] of Object.entries(SCENES)) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  const vp = scene.phone ? { width: 393, height: 852 } : VIEW;
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 2, timezoneId: 'Asia/Shanghai', isMobile: !!scene.phone, hasTouch: !!scene.phone });
  const errors = [];
  const unhandled = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await fixDate(page);
  // The owner's Mac: shortcut labels read ⌘, as on the 10-17 board.
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  const fixtures = await installFixtures(page, { theme: 'light' });
  await routes(page, unhandled);
  await page.goto(`${SITES.today.origin}${scene.path}`);
  try {
    await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 30_000 });
    await page.waitForSelector('.session-row', { timeout: 20_000 });
  } catch (error) {
    errors.push(String(error));
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1_200);
  if (scene.keys) {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
    for (const key of scene.keys) {
      await page.keyboard.press(key);
      await page.waitForTimeout(900);
    }
  }
  if (scene.scrollTo) {
    await page.locator(`.session-project-row[data-project-id="${scene.scrollTo.id}"]`).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
  }
  if (scene.menuOn) {
    const row = page.locator(`.session-project-row[data-project-id="${scene.menuOn.id}"]`);
    await row.hover();
    await row.locator('.session-kebab').click();
    await page.waitForSelector('[role="menuitem"]', { timeout: 10_000 });
    await page.waitForTimeout(500);
  }
  if (scene.clickProject) {
    await page.locator(`.session-project-row[data-project-id="${scene.clickProject.id}"] .session-title`).click();
    await page.waitForTimeout(1_500);
  }
  if (scene.clickMark) {
    const row = page.locator('.session-row').filter({ has: page.locator('.session-title', { hasText: scene.clickMark.title }) });
    await row.locator('.session-project-progress').click();
    await page.waitForTimeout(1_500);
  }
  if (scene.closeGlyph) {
    // The proposal's column header closes the column instead of going back: an × in the back button's place.
    await page.evaluate(() => {
      const b = document.querySelector('.session-folder-back');
      if (b) { b.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>'; b.setAttribute('aria-label', 'Close'); }
    });
  }
  if (scene.button) {
    // Drawn into the live header: a project button left of ⋮, the console's own icon button classes and
    // the project row's glyph. 'on' = the column is open (tinted), 'off' = folded.
    await page.evaluate((on) => {
      const head = document.querySelector('.workspace-header');
      const more = head?.lastElementChild;
      const glyph = document.querySelector('.session-project-icon svg, .tp-item svg')?.outerHTML ?? '';
      if (!head || !more) return;
      const wrap = document.createElement('span');
      wrap.style.cssText = 'display:flex;align-items:center;gap:2px;flex:none';
      const b = document.createElement('button');
      b.id = 'b-pbtn'; b.type = 'button'; b.title = 'Project sessions';
      b.className = 'orbit-button orbit-button-text orbit-button-middle';
      b.style.cssText = 'display:inline-flex;align-items:center;gap:5px;padding:0 9px;height:30px;border-radius:8px;font-size:13px;' +
        (on ? 'background:rgba(51,112,255,.12);color:#2f6bff;' : 'color:#55555c;');
      b.innerHTML = `<span style="display:inline-flex;width:15px;height:15px">${glyph}</span><span>11</span>`;
      b.querySelector('svg')?.setAttribute('width', '15'); b.querySelector('svg')?.setAttribute('height', '15');
      head.insertBefore(wrap, more); wrap.append(b, more);
    }, scene.button === 'on');
    await page.waitForTimeout(200);
  }
  if (!scene.menuOn) {
    // Off the rows, so none of them shows its hover ⋯.
    await page.mouse.move(vp.width - 10, vp.height - 100);
    await page.waitForTimeout(300);
  }
  if (process.env.DUMP) report[name+':dump'] = await page.evaluate(() => {
    let el = document.elementFromPoint(1144, 52); const out = [];
    for (let i = 0; el && i < 6; i++, el = el.parentElement) out.push(el.tagName + '.' + [...el.classList].join('.') + ' kids=' + el.children.length);
    const h = document.elementFromPoint(1144, 52)?.closest('header, [class*=head]');
    return { chain: out, head: h ? h.outerHTML.slice(0, 2500) : null };
  });
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 0, ...vp }, animations: 'disabled' });
  marks[name] = { w: vp.width, h: vp.height, url: new URL(page.url()).pathname + new URL(page.url()).search,
    boxes: { ...(await boxes(page, { ...COMMON, ...scene.boxes })) } };
  report[name] = { errors, unhandled: [...new Set([...unhandled, ...fixtures.unhandled])] };
  await page.close();
}
await browser.close();
for (const { server } of Object.values(SITES)) server.close();
const prev = existsSync(`${OUT}/marks.json`) ? JSON.parse(readFileSync(`${OUT}/marks.json`, 'utf8')) : {};
writeFileSync(`${OUT}/marks.json`, JSON.stringify({ ...prev, ...marks }, null, 1));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
