// Real web console frames for docs/mocks/needs-you-jump (2026-11-26). Serves a `vite build` of main
// (dist-today) over the repo's ui-migration fixtures plus the sample account in data.mjs, clicks the
// coordinator's Needs-you row, and writes <OUT>/<scene>.png and <OUT>/marks.json (CSS-px boxes of the
// elements the board rings). The proposal frames are today's build in the state the change would put
// it in (the column unfolded; in a narrow window, unfolded over the conversation), so nothing here is
// drawn by hand.
//
// RUN: FONTCONFIG_FILE=<fonts.conf> node capture.mjs <outDir> [scene,scene]
//   env TREE (a worktree with node_modules and src/shared/dist), DIST (the vite build), CHROME.
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NOW, makeData } from './data.mjs';

const TREE = process.env.TREE ?? path.resolve(import.meta.dirname, '../../../..');
const DIST = process.env.DIST ?? '/mnt/tmp/nyj-mock/dist-today';
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const OUT = process.argv[2] ?? '/mnt/tmp/nyj-mock/out';
const ONLY = (process.argv[3] ?? '').split(',').filter(Boolean);
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(`${TREE}/node_modules/playwright/index.mjs`);
const { installFixtures } = await import(`${TREE}/src/web/ui-migration/fixtures.mjs`);
const { uuidToBase62 } = await import(`${TREE}/src/shared/dist/index.js`);
const data = makeData(uuidToBase62);
const { R, W, P, D, rows, promotion, sidebarDoc, coordinatorOf, sid } = data;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let file = path.join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

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
    if (p === '/api/runners') return json([R.hpc]);
    if (p === '/api/workspaces') return json([W.test]);
    if (p === '/api/sessions/counts') {
      const open = rows.filter((r) => r.lifecycleState === 'OPEN');
      return json([{ workspaceId: W.test.id, active: 1, running: 1, jobs: 0, needsYou: 1 }].map((c) => ({ ...c, active: open.filter((r) => r.status === 'RUNNING').length })));
    }
    if (p === '/api/sessions') {
      const view = q.get('view') ?? 'open';
      const life = view === 'completed' || view === 'archived' ? 'COMPLETED' : view === 'trash' ? 'TRASH' : 'OPEN';
      let list = rows.filter((r) => r.lifecycleState === life);
      if (q.get('projectId')) list = list.filter((r) => r.projectMembership?.projectId === q.get('projectId'));
      else if (q.get('workspaceId')) list = list.filter((r) => r.workspaceId === q.get('workspaceId'));
      list.sort((a, b) => Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt));
      return json(list);
    }
    if (p === '/api/sessions/project-placement') {
      const life = q.get('view') === 'completed' ? 'COMPLETED' : 'OPEN';
      return json({ projects: (q.get('projectIds') ?? '').split(',').filter(Boolean).map((projectId) => {
        const members = rows.filter((r) => r.projectMembership?.projectId === projectId && r.lifecycleState === life);
        return { projectId, coordinator: rows.find((r) => r.projectMembership?.projectId === projectId && r.projectMembership.role === 'COORDINATOR') ?? null,
          waiting: members.filter((r) => (r.pendingApprovals ?? 0) > 0), sessionCount: members.length };
      }) });
    }
    if (p === '/api/projects/sidebar')return json([sidebarDoc(P.landing)]);
    if (p === '/api/projects') return json([sidebarDoc(P.landing)]);
    const pm = p.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    const project = pm && Object.values(P).find((x) => x.id === pm[1]);
    if (project) {
      const c = coordinatorOf(project);
      const sub = pm[2] ?? '';
      if (!sub) {
        return json({ ...sidebarDoc(project), goal: '', instructions: '', coordinatorSessionId: c?.id ?? null,
          coordinatorWorkspaceId: c?.workspaceId ?? null, _count: { tasks: project.counts.total },
          tasksByStatus: { DONE: project.counts.done, RUNNING: 1, OPEN: project.counts.total - project.counts.done - 1 },
          criteria: [], blockers: { open: [], resolved: [], resolvedCount: 0 } });
      }
      if (sub === '/integration') return json(NO_LINE);
      if (sub === '/promotions/current') return json(promotion);
      if (sub === '/promotions/merged') return json([]);
      if (sub === '/handoffs') return json([]);
      if (sub === '/open-items') {
        return json({ needsYou: [], withCoordinator: [], startRequest: null, readAt });
      }
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
    const out = {};
    for (const [name, css] of Object.entries(spec)) {
      const el = css.startsWith('text=')
        ? [...document.querySelectorAll('.session-row, .session-project-row')].find((r) => r.textContent.includes(css.slice(5)))
        : document.querySelector(css);
      if (!el) { out[name] = null; continue; }
      const r = el.getBoundingClientRect();
      out[name] = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    }
    return out;
  }, spec);
}

const RING = {
  row: 'text=Approve merge',
  pbtn: '.workspace-header-project',
  column: 'aside.session-project-column',
  merge: '.session-project-merge',
};
const WIDE = { width: 1440, height: 820 };
const NARROW = { width: 1120, height: 820 };
// folded: what orbit.projectColumnFolded holds before the click (today keeps a hand fold forever).
// pressButton: the proposal for a narrow window — the column unfolded over the conversation, which is
// what today's ⊞ press already draws.
const SCENES = {
  't-wide': { vp: WIDE, folded: '1' },
  'n-wide': { vp: WIDE, folded: '0' },
  't-narrow': { vp: NARROW, folded: '0' },
  'n-narrow': { vp: NARROW, folded: '0', pressButton: true },
};

const browser = await chromium.launch({ executablePath: CHROME, ignoreDefaultArgs: ['--hide-scrollbars'] });
const report = {};
const marks = {};
for (const [name, scene] of Object.entries(SCENES)) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  const vp = scene.vp;
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 2, timezoneId: 'Asia/Shanghai' });
  const errors = [];
  const unhandled = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 600)); });
  await fixDate(page);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  const fixtures = await installFixtures(page, { theme: 'light' });
  await page.addInitScript((folded) => localStorage.setItem('orbit.projectColumnFolded', folded), scene.folded);
  await routes(page, unhandled);
  // Start on another conversation, as the owner was, then press the coordinator's Needs-you row.
  await page.goto(`${origin}/sessions/${D.notes.id}`);
  try {
    await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 30_000 });
    await page.waitForSelector('.session-row', { timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1_000);
    await page.locator('.session-row, .session-project-row').filter({ hasText: 'Approve merge' }).first().click();
    await page.waitForTimeout(2_000);
    if (scene.pressButton) {
      await page.locator('.workspace-header-project').click();
      await page.waitForTimeout(1_000);
    }
  } catch (error) {
    errors.push(String(error));
  }
  await page.mouse.move(vp.width - 10, vp.height - 10);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 0, ...vp }, animations: 'disabled' });
  marks[name] = { w: vp.width, h: vp.height, url: new URL(page.url()).pathname + new URL(page.url()).search,
    boxes: await boxes(page, RING) };
  report[name] = { errors, unhandled: [...new Set([...unhandled, ...fixtures.unhandled])] };
  await page.close();
}
await browser.close();
server.close();
const prev = existsSync(`${OUT}/marks.json`) ? JSON.parse(readFileSync(`${OUT}/marks.json`, 'utf8')) : {};
writeFileSync(`${OUT}/marks.json`, JSON.stringify({ ...prev, ...marks }, null, 1));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ marks, report }, null, 1));
