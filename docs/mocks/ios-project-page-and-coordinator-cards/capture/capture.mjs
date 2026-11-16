// Real web page at a phone viewport for docs/mocks/ios-project-page-and-coordinator-cards.
// Fixtures from src/web/ui-migration plus the real project read (project.json/tasks.json from the orbit CLI).
import http from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const TREE = '/var/tmp/ipc-mock/tree', KIT = '/var/tmp/ipc-mock/kit', OUT = process.argv[2] ?? '/var/tmp/ipc-mock/out';
const W = Number(process.env.W ?? 440);
const { chromium } = await import(`${TREE}/node_modules/playwright/index.mjs`);
const { installFixtures } = await import(`${TREE}/src/web/ui-migration/fixtures.mjs`);
const dist = `${TREE}/src/web/dist`;
const server = http.createServer((req, res) => {
  let file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  const T = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
  res.writeHead(200, { 'content-type': T[path.extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const project = JSON.parse(readFileSync(`${KIT}/project.json`, 'utf8'));
const tasks = JSON.parse(readFileSync(`${KIT}/tasks.json`, 'utf8'));
const NOW = Date.parse('2026-11-16T17:40:00Z');
const P = project.id;
const edges = [['34yccDtqtOQLgG38CGqXr','34yccDvnkPypifATUbqU2'],['34yccDxMNc7yUaE88xNLh','34yccDy2iRK2Bttk2YjXd'],
  ...['34yccDtqtOQLgG38CGqXr','34yccDvnkPypifATUbqU2','34yccDwm2vRhzmU0Zyllz','34yccDxMNc7yUaE88xNLh','34yccDy2iRK2Bttk2YjXd'].map((s) => [s,'34yccDyv3ylb7yVxp3ryd'])];
const rows = tasks.map((t) => ({ ...t, outcome: t.status, project: { id: P, title: project.title, status: 'OPEN' },
  workState: t.status === 'DONE' ? 'DONE' : t.running ? 'RUNNING' : t.blocked ? 'BLOCKED' : 'READY',
  unmetCount: edges.filter(([, d]) => d === t.id).filter(([s]) => tasks.find((x) => x.id === s)?.status !== 'DONE').length,
  blocksCount: edges.filter(([s]) => s === t.id).length, topoLevel: t.id === '34yccDyv3ylb7yVxp3ryd' ? 2 : edges.some(([, d]) => d === t.id) ? 1 : 0,
  sessions: [], dependsOn: [], dependedOnBy: [], inputs: [], children: [], childCount: 0, comments: [] }));
const buckets = { running: rows.filter((r) => r.running).length, ready: rows.filter((r) => r.workState === 'READY').length, blocked: rows.filter((r) => r.blocked).length, awaitingVerification: 0, done: 1, failed: 0, cancelled: 0 };
const integ = { ...project.integration, commitsAheadOfUpstream: null, commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET', lastUpstreamSyncAt: null,
  lastUpstreamSyncAbsentReason: 'NEVER_SYNCED', integratingCount: 0, queuedCount: 0, mergeCheckOnTip: 'UNKNOWN', inFlight: null };
const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
const H = Number(process.env.H ?? 956);
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.addInitScript((t) => { const D = Date; window.Date = new Proxy(D, { construct: (X, a) => Reflect.construct(X, a.length ? a : [t]), apply: (X) => new X(t).toString(), get: (X, k) => k === 'now' ? () => t : Reflect.get(X, k) }); }, NOW);
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 700)); });
page.on('pageerror', (e) => console.log('PAGEERROR', e.stack?.slice(0,600)));
const fx = await installFixtures(page, { theme: 'light' });
let base;
await page.route('**/api/**', async (route) => {
  const u = new URL(route.request().url()), p = u.pathname, json = (b) => route.fulfill({ status: 200, json: b });
  if (!p.startsWith('/api/projects')) return route.fallback();
  const full = { ...project, buckets, attention: { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, attentionSinceAt: null, nextCheckAt: null, ownerItems: [], coordinatorItems: null, startRequest: null }, lastActivityAt: project.updatedAt, workspaceId: null };
  if (p === '/api/projects' || p === '/api/projects/sidebar') return json([full]);
  if (p === `/api/projects/${P}`) return json(full);
  if (p === `/api/projects/${P}/tasks/page`) return json({ items: rows, nextCursor: null, total: rows.length });
  if (p === `/api/projects/${P}/integration`) return json(integ);
  if (p === `/api/projects/${P}/open-items`) return json({ needsYou: [], withCoordinator: [], startRequest: null });
  if (p === `/api/projects/${P}/promotions/current`) return json(null);
  if (p === `/api/projects/${P}/handoffs`) return json([]);
  if (p === `/api/projects/${P}/share`) return json({ link: null, counts: { tasks: 6, comments: 0, files: 0, transcripts: 0, messages: 0, toolCalls: 0 } });
  if (p === `/api/projects/${P}/panorama`) return json({ buckets, shape: { taskCount: 6, edgeCount: edges.length, ratio: 1, maxDepth: 2, form: 'dag' } });
  if (p === `/api/projects/${P}/panorama/blocking`) return json({ remainingCount: 5, items: rows.filter((r) => r.blocksCount && r.status !== 'DONE').map((r) => ({ taskId: r.id, title: r.title, status: r.status, downstreamBlocked: r.blocksCount })), truncated: null });
  if (p === `/api/projects/${P}/panorama/ready`) return json({ readyCount: buckets.ready, queuedCount: 0, runningCount: buckets.running, pausedCount: 0, items: [], impactTruncated: null });
  if (p === `/api/projects/${P}/dependency-graph`) return json({ marks: rows.map((t) => ({ ...t, kind: 'TASK', taskId: t.id })), edges: edges.map(([s, d]) => ({ sourceMarkId: s, targetMarkId: d })), taskCount: 6, folded: false, truncated: false, limits: { maxTasks: 1000, maxMarks: 1000 } });
  if (p === `/api/projects/${P}/coordinator/status`) return json({ projectId: P, readAt: new Date(NOW).toISOString(), state: 'LIVE',
    coordination: { sessionId: '34yXcuezzGDY91mHmIvR7', sessionIdAbsentReason: null, session: { id: '34yXcuezzGDY91mHmIvR7', title: 'Coordinator handoff v2',
      runStatus: 'PENDING', runState: 'QUEUED', lifecycleState: 'OPEN', filingState: 'OPEN', endReason: null, startedAt: '2026-11-16T11:23:00.640Z', finishedAt: null, completedAt: null, deletedAt: null, engineTurnActive: false, pendingApprovals: 0 },
      sessionAbsentReason: null, coordinatorGeneration: '0', workspaceId: '34ZHGcIxwsZUxkgh2z65V', workspaceIdAbsentReason: null, workspaceName: 'orbit-develop', workspaceNameAbsentReason: null,
      agentId: '34ZHGcIxwsZUxkgh2z65V', agentIdAbsentReason: null, agentName: 'orbit-develop', agentNameAbsentReason: null },
    openability: { canOpen: true, willCreate: false, refusalCode: null, refusalDetail: null, refusalCodeAbsentReason: 'NOTHING_REFUSES', requiredAction: null, requiredActionAbsentReason: 'NOTHING_REFUSES',
      landing: { workspaceId: null, workspaceIdAbsentReason: 'COORDINATOR_ALREADY_LIVE', workspaceName: null, workspaceNameAbsentReason: 'COORDINATOR_ALREADY_LIVE', agentId: null, agentName: null, fixed: true } } });
  return route.fallback();
});
await page.goto(`${origin}/projects/${P}`);
await page.waitForTimeout(3500);
if (process.env.EXPAND) { await page.getByRole('button', { name: /View all 5 criteria/ }).click(); await page.waitForTimeout(600); }
const scrollH = await page.evaluate(() => Math.max(...[...document.querySelectorAll('*')].map((e) => e.scrollHeight)));
await page.setViewportSize({ width: W, height: Math.min(scrollH + 40, 9000) });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/web-phone-${W}${process.env.EXPAND ? '-all' : ''}.png`, fullPage: true });
const outline = await page.evaluate(() => [...document.querySelectorAll('h1,h2,h3,h4,[role=heading],summary,button,section>header,.section-title, [class*=section] > [class*=title]')]
  .filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.top)}\t${e.tagName}.${(e.className+'').slice(0,40)}\t${e.textContent.trim().replace(/\s+/g,' ').slice(0,90)}`; }));
writeFileSync(`${OUT}/web-outline-${W}.txt`, outline.join('\n'));
console.log('unhandled', fx.unhandled);
await browser.close(); server.close();
