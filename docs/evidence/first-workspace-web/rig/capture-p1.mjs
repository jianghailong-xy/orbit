// Every proposal frame of boards 01 and 02, shot from the real implementation (no prototype, no DOM
// injection): `unshare -n ./run-ns.sh <worktree> capture-p1.mjs [scene…]`. The kit's fixtures and the
// contract's fields (data.mjs). Writes shots-p1/<scene>.png (2x); marks-p1.json holds the element boxes.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { launch, open, settle, K } from './lib.mjs';
import * as D from './data.mjs';

const OUT = process.env.OUT ?? `${K}/shots-p1`;
const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const marksFile = `${OUT}/marks.json`;
const marks = existsSync(marksFile) ? JSON.parse(readFileSync(marksFile, 'utf8')) : {};

const quiet = { 'GET /api/projects/sidebar': [], 'GET /api/wiki/spaces': [], 'GET /api/projects': [] };
const routesFor = (fleet, extra = {}) => ({ ...D.fleetRoutes(fleet), ...quiet, ...extra });
const A = D.IDS.austin;
const CODE = 'B7RXA-EFTR7';
const enrollment = (status) => ({
  userCode: CODE, name: 'orbit@austin', hostname: 'austin', labels: [], maxConcurrent: 16, status,
  requesterIp: '203.0.113.24', sameNetwork: true, nameConflict: false, existingLastSeenAt: null,
  runnerId: status === 'APPROVED' ? A : null, createdAt: D.ago(1), expiresAt: new Date(D.NOW + 9 * 60_000).toISOString(),
});

const SID = D.IDS.session;
const SESSION = {
  id: SID, workspaceId: D.WS_APP.id, workspace: D.WS_APP, runnerId: A, assignedRunnerId: A, createdWorkspace: true,
  title: 'Fix the flaky login test', provider: 'claude', engine: 'claude', model: 'claude-opus-5',
  status: 'RUNNING', runState: 'RUNNING', lifecycleState: 'OPEN',
  createdAt: D.ago(1), updatedAt: D.ago(0.2), startedAt: D.ago(1), engineStartedAt: D.ago(0.9), lastTurnAt: D.ago(1),
  shareToken: null,
};
const TURN = D.IDS.session.replace(/.$/, 'x');
const FIRST = 'Fix the flaky login test in tests/auth — it fails about one run in five on CI.';
const EVENTS = [
  { seq: 1, type: 'user', payload: { text: FIRST }, turnId: TURN, ts: D.ago(1) },
  { seq: 2, type: 'assistant', payload: { text: 'I’ll reproduce it first: running the auth tests 20 times in a row to catch the failing case, then I’ll read the test and the session-expiry code it touches.' }, turnId: TURN, ts: D.ago(0.8) },
];
function sessionHandler(req, url) {
  const p = url.pathname;
  if (req.method() !== 'GET') return undefined;
  if (p === '/api/sessions') return [SESSION];
  if (p === '/api/sessions/counts') return [{ workspaceId: D.WS_APP.id, active: 1, running: 1, jobs: 0, needsYou: 0 }];
  if (!p.startsWith(`/api/sessions/${SID}`)) return undefined;
  const rest = p.slice(`/api/sessions/${SID}`.length);
  if (!rest) return SESSION;
  if (rest === '/events/page') return { events: EVENTS, hasMore: false };
  if (['/turns', '/approvals', '/background'].includes(rest)) return [];
  if (rest === '/diff') return { files: [], patches: [] };
  if (rest === '/created-tasks') return { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] };
  return undefined;
}

async function boxes(page, sels) {
  return page.evaluate((sels) => Object.fromEntries(Object.entries(sels).map(([k, sel]) => {
    let el = null;
    if (sel.startsWith('text=')) {
      const want = sel.slice(5);
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walk.nextNode()) {
        const n = walk.currentNode;
        if ([...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.includes(want))) { el = n; break; }
      }
    } else el = document.querySelector(sel);
    if (!el) return [k, null];
    const r = el.getBoundingClientRect();
    return [k, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }];
  })), sels);
}

const scenes = [];
const scene = (name, fn) => scenes.push({ name, fn });
const sayFirst = async (page) => {
  const box = page.locator('.workspace-composer textarea');
  await box.fill(FIRST);
  await box.press('Enter');
  await page.locator('.msc-held').waitFor();
};

scene('p-landing', async (b) => {
  const s = await open(b, { path: '/', routes: routesFor(D.NEW_USER), height: 900 });
  await s.page.locator('.msc').waitFor();
  await s.page.getByText('Where you ran orbit register').waitFor();
  await settle(s.page);
  return { s, sels: { row: '.tp-setup', card: '.msc', folder: '[data-step="folder"]', engine: '[data-step="engine"]', foot: '.msc-foot', composer: 'textarea' } };
});
scene('p-progress', async (b) => {
  let login = D.LOGIN_IDLE;
  const s = await open(b, {
    path: `/runners/${A}/new`, height: 900,
    routes: routesFor(D.NEW_USER, {
      [`GET /api/runners/${A}/login`]: () => login,
      [`POST /api/runners/${A}/login`]: () => (login = D.LOGIN_AWAITING_CODE),
    }),
  });
  await s.page.locator('.msc').waitFor();
  await s.page.getByRole('button', { name: 'Use this folder' }).click();
  // A real press would park a tab for the sign-in page; the kit has no other tab to look at.
  await s.page.evaluate(() => { window.open = () => null; });
  await s.page.getByRole('button', { name: 'Sign in to Claude Code' }).click();
  await s.page.getByPlaceholder('Paste the code').waitFor({ timeout: 20_000 });
  await sayFirst(s.page);
  await settle(s.page);
  return { s, sels: { folderDone: '[data-step="folder"]', signin: '.rsi', held: '.msc-held' } };
});
scene('p-ready', async (b) => {
  const fleet = { runners: [D.AUSTIN_READY], workspaces: [] };
  const s = await open(b, { path: `/runners/${A}/new`, routes: routesFor(fleet), height: 900 });
  await s.page.locator('.msc').waitFor();
  await s.page.getByText('Where you ran orbit register').waitFor();
  await s.page.getByRole('button', { name: 'Use this folder' }).click();
  await settle(s.page);
  return { s, sels: { card: '.msc', foot: '.msc-foot' } };
});
scene('p-started', async (b) => {
  const fleet = { runners: [D.AUSTIN_READY], workspaces: [D.WS_APP] };
  const s = await open(b, { path: `/sessions/${SID}`, routes: routesFor(fleet), handler: sessionHandler, height: 900 });
  await s.page.getByText('reproduce it first').waitFor({ timeout: 30_000 });
  await s.page.locator('.msc-created').waitFor();
  await settle(s.page);
  return { s, sels: { created: '.msc-created', row: '.tp-item.active', bubble: '.chat-user-wrap' } };
});
scene('p-side-existing', async (b) => {
  const s = await open(b, { path: `/workspaces/${D.IDS.wsOrbit}`, routes: routesFor(D.EXISTING), height: 900 });
  await s.page.locator('.tp-setup').waitFor();
  return { s, sels: { list: '.tp-group', row: '.tp-setup' } };
});
scene('p-enroll', async (b) => {
  const s = await open(b, { path: `/enroll?code=${CODE}`, routes: routesFor(D.NEW_USER, { [`GET /api/runners/device/${CODE}`]: enrollment('APPROVED') }), height: 900 });
  return { s, sels: { next: '.enroll-next', go: '.enroll-actions' } };
});
scene('p-register', async (b) => {
  let calls = 0;
  const s = await open(b, {
    path: '/runners/register', height: 900,
    routes: routesFor(D.NEW_USER, { 'GET /api/runners': () => (calls++ === 0 ? [] : [D.AUSTIN]) }),
  });
  await s.page.getByText('Runner online').waitFor({ timeout: 20_000 });
  await settle(s.page);
  return { s, sels: { status: '.runner-status' } };
});
scene('p-machine', async (b) => {
  const s = await open(b, { path: `/runners/${A}`, routes: routesFor(D.NEW_USER), height: 2000 });
  return { s, sels: { attention: 'text=No coding CLI is signed in', empty: '.rd-empty', section: '.rd-workspaces' } };
});
scene('p-settings', async (b) => {
  const s = await open(b, { path: '/settings', routes: routesFor(D.NEW_USER), height: 1500 });
  return { s, sels: { row: 'text=1 needs you' } };
});
scene('e-home', async (b) => {
  const fleet = { runners: [D.AUSTIN_HOME], workspaces: [] };
  const s = await open(b, { path: `/runners/${A}/new`, routes: routesFor(fleet), height: 900 });
  await s.page.locator('.msc').waitFor();
  await s.page.waitForTimeout(600);
  await s.page.locator('.msc-input input, input.msc-input').first().fill('payments-api');
  await settle(s.page);
  return { s, sels: { card: '.msc' } };
});
const typed = (path) => async (b) => {
  const s = await open(b, { path: `/runners/${A}/new`, routes: routesFor(D.NEW_USER), height: 900 });
  await s.page.locator('.msc').waitFor();
  await s.page.getByText('Where you ran orbit register').waitFor();
  await s.page.getByText('Another folder on orbit@austin').click();
  await s.page.locator('.msc-path-input input, input.msc-path-input').first().fill(path);
  await s.page.waitForTimeout(1200);
  await settle(s.page);
  return { s, sels: { card: '.msc' } };
};
scene('e-missing', typed('/home/orbit/code/ap'));
scene('e-nogit', typed('/home/orbit/notes'));
scene('e-offline', async (b) => {
  const fleet = { runners: [D.AUSTIN_OFFLINE], workspaces: [] };
  const s = await open(b, { path: `/runners/${A}/new`, routes: routesFor(fleet), height: 900 });
  await s.page.locator('.msc').waitFor();
  await s.page.waitForTimeout(400);
  return { s, sels: { card: '.msc' } };
});
scene('e-noprobe', async (b) => {
  const fleet = { runners: [D.AUSTIN_OLD], workspaces: [] };
  const s = await open(b, { path: `/runners/${A}/new`, routes: routesFor(fleet), height: 900 });
  await s.page.locator('.msc').waitFor();
  await s.page.waitForTimeout(400);
  return { s, sels: { card: '.msc' } };
});

const browser = await launch();
for (const sc of scenes) {
  if (only.length && !only.includes(sc.name)) continue;
  const t0 = Date.now();
  try {
    const { s, sels } = await sc.fn(browser);
    await s.page.waitForTimeout(400);
    await settle(s.page);
    marks[sc.name] = { viewport: s.page.viewportSize(), boxes: await boxes(s.page, sels ?? {}) };
    await s.page.screenshot({ path: `${OUT}/${sc.name}.png` });
    const unhandled = [...new Set(s.api.unhandled)];
    console.log(`${sc.name} ${((Date.now() - t0) / 1000).toFixed(1)}s`, unhandled.length ? `UNHANDLED ${unhandled.join(', ')}` : '', s.errors.length ? `ERRORS ${s.errors.slice(0, 3).join(' | ')}` : '');
    await s.context.close();
  } catch (e) {
    console.log(`${sc.name} FAILED`, e.message.split('\n').slice(0, 3).join(' '));
  }
}
writeFileSync(marksFile, JSON.stringify(marks, null, 1));
await browser.close();
