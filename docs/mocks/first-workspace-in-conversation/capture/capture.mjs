// Every frame of the first-workspace boards, shot from the real web app (today = HEAD, new = HEAD + the
// prototype in new/). Run one tree at a time:
//   unshare -n ./run-ns.sh /var/tmp/first-ws-mock/today capture.mjs [scene…]
//   unshare -n ./run-ns.sh /var/tmp/first-ws-mock/new   capture.mjs [scene…]
// Writes shots/<scene>.png (2x) and merges each scene's element boxes (css px) into marks.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { launch, open, settle, K } from './lib.mjs';
import * as D from './data.mjs';

const TREE = (process.env.TREE ?? '').split('/').pop();
const only = process.argv.slice(2);
mkdirSync(`${K}/shots`, { recursive: true });
const marksFile = `${K}/marks.json`;
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

// The session the proposal opens once both steps are done: its first message, and the reply under way.
const SID = D.IDS.session;
const SESSION = {
  id: SID, workspaceId: D.WS_APP.id, workspace: D.WS_APP, runnerId: A, assignedRunnerId: A,
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

/** css-px boxes of the first match of each selector, for the board's numbered marks. */
async function boxes(page, sels) {
  return page.evaluate((sels) => Object.fromEntries(Object.entries(sels).map(([k, sel]) => {
    let el = null;
    if (sel.startsWith('text=')) {
      const want = sel.slice(5);
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walk.nextNode()) {
        const n = walk.currentNode;
        if (n.children.length === 0 && n.textContent && n.textContent.includes(want)) { el = n; break; }
        if ([...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.includes(want))) { el = n; break; }
      }
    } else el = document.querySelector(sel);
    if (!el) return [k, null];
    const r = el.getBoundingClientRect();
    return [k, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }];
  })), sels);
}

const scenes = [];
const scene = (name, tree, fn) => scenes.push({ name, tree, fn });

// ───────────────────────────── today ─────────────────────────────
scene('t-landing', 'today', async (b) => {
  const s = await open(b, { path: '/', routes: routesFor(D.NEW_USER), height: 900 });
  return { s, sels: { engines: 'text=Signed out', side: '.tp-divider' } };
});
scene('t-landing-tall', 'today', async (b) => {
  const s = await open(b, { path: `/runners/${A}`, routes: routesFor(D.NEW_USER), height: 2000 });
  return { s, sels: { add: 'text=Add workspace', empty: '.rd-empty' } };
});
scene('t-form', 'today', async (b) => {
  const s = await open(b, { path: `/runners/${A}`, routes: routesFor(D.NEW_USER), height: 2400 });
  await s.page.getByRole('button', { name: 'Add workspace' }).click();
  await s.page.waitForTimeout(600);
  await s.page.locator('.rd-workspace-form-wrap').scrollIntoViewIfNeeded();
  await settle(s.page);
  return { s, sels: { form: '.rd-workspace-form-wrap', name: 'text=Name', dir: 'text=Working directory', create: 'text=Create' } };
});
scene('t-draft-hidden', 'today', async (b) => {
  const s = await open(b, { path: `/workspaces/${A}`, routes: routesFor(D.NEW_USER), height: 900 });
  return { s, sels: { fix: 'text=Fix it', composer: 'textarea' } };
});
scene('t-enroll', 'today', async (b) => {
  const s = await open(b, { path: `/enroll?code=${CODE}`, routes: routesFor(D.NEW_USER, { [`GET /api/runners/device/${CODE}`]: enrollment('APPROVED') }), height: 900 });
  return { s, sels: { next: '.enroll-next', go: '.enroll-actions' } };
});
scene('t-register', 'today', async (b) => {
  let calls = 0;
  const s = await open(b, {
    path: '/runners/register', height: 900,
    routes: routesFor(D.NEW_USER, { 'GET /api/runners': () => (calls++ === 0 ? [] : [D.AUSTIN]) }),
  });
  await s.page.getByText('Runner online').waitFor({ timeout: 20_000 });
  await settle(s.page);
  return { s, sels: { status: '.runner-status' } };
});
scene('t-settings', 'today', async (b) => {
  const s = await open(b, { path: '/settings', routes: routesFor(D.NEW_USER), height: 1500 });
  return { s, sels: { row: 'text=of 1 online' } };
});
scene('t-side-existing', 'today', async (b) => {
  const s = await open(b, { path: `/workspaces/${D.IDS.wsOrbit}`, routes: routesFor(D.EXISTING), height: 900 });
  return { s, sels: { list: '.tp-group' } };
});

// ───────────────────────────── proposal ─────────────────────────────
scene('p-landing', 'new', async (b) => {
  const s = await open(b, { path: '/', routes: routesFor(D.NEW_USER), height: 900 });
  await s.page.locator('.msc').waitFor();
  return { s, sels: { row: '.tp-bare', card: '.msc', folder: '[data-step="folder"]', engine: '[data-step="engine"]', foot: '.msc-foot', composer: 'textarea' } };
});
scene('p-progress', 'new', async (b) => {
  let login = D.LOGIN_IDLE;
  const s = await open(b, {
    path: `/workspaces/${A}`, height: 900,
    routes: routesFor(D.NEW_USER, {
      [`GET /api/runners/${A}/login`]: () => login,
      [`POST /api/runners/${A}/login`]: () => (login = D.LOGIN_AWAITING_CODE),
    }),
  });
  await s.page.locator('.msc').waitFor();
  await s.page.getByRole('button', { name: 'Use this folder' }).click();
  await s.page.getByRole('button', { name: 'Sign in to Claude Code' }).click();
  await s.page.getByText('Paste the code', { exact: false }).first().waitFor({ timeout: 20_000 });
  await s.page.evaluate((text) => {
    const held = document.createElement('div');
    held.className = 'msc-held';
    held.innerHTML = `<div class="chat-user-wrap"><div class="chat-msg chat-user"><p></p></div>
      <div class="msc-held-state">Waiting for orbit@austin — sends once both steps are done · <a class="msc-change">Withdraw</a></div></div>`;
    held.querySelector('p').textContent = text;
    document.querySelector('.msc').after(held);
  }, FIRST);
  await settle(s.page);
  return { s, sels: { folderDone: '[data-step="folder"]', signin: '.rsi', held: '.msc-held' } };
});
scene('p-ready', 'new', async (b) => {
  const fleet = { runners: [D.AUSTIN_READY], workspaces: [] };
  const s = await open(b, { path: `/workspaces/${A}`, routes: routesFor(fleet), height: 900 });
  await s.page.locator('.msc').waitFor();
  await s.page.getByRole('button', { name: 'Use this folder' }).click();
  await settle(s.page);
  return { s, sels: { card: '.msc', foot: '.msc-foot' } };
});
scene('p-started', 'new', async (b) => {
  const fleet = { runners: [D.AUSTIN_READY], workspaces: [D.WS_APP] };
  const s = await open(b, { path: `/sessions/${SID}`, routes: routesFor(fleet), handler: sessionHandler, height: 900 });
  await s.page.getByText('reproduce it first').waitFor({ timeout: 30_000 });
  await s.page.evaluate(() => {
    const first = document.querySelector('.chat-user-wrap');
    const line = document.createElement('div');
    line.className = 'msc-created';
    line.innerHTML = `<span class="msc-created-ico">⌂</span> Created workspace <b>app</b> on orbit@austin · <code>~/code/app</code>
      <span class="msc-created-sep">·</span> <a>Rename</a> <span class="msc-created-sep">·</span> <a>Settings</a>`;
    const style = document.createElement('style');
    style.textContent = `.msc-created{display:flex;align-items:center;justify-content:center;gap:6px;margin:6px 0 14px;color:var(--text-3);font-size:12px}
      .msc-created b{color:var(--text-2);font-weight:600}.msc-created code{font-size:11.5px;color:var(--text-2)}
      .msc-created a{color:var(--brand);cursor:pointer}.msc-created-sep{color:var(--text-4)}
      .msc-created-ico{font-size:13px;color:var(--success-solid)}`;
    document.head.append(style);
    first.parentElement.insertBefore(line, first);
  });
  await settle(s.page);
  return { s, sels: { created: '.msc-created', row: '.tp-item.active', bubble: '.chat-user-wrap' } };
});
scene('p-side-existing', 'new', async (b) => {
  const s = await open(b, { path: `/workspaces/${D.IDS.wsOrbit}`, routes: routesFor(D.EXISTING), height: 900 });
  await s.page.locator('.tp-bare').waitFor();
  return { s, sels: { list: '.tp-group', row: '.tp-bare' } };
});
scene('p-enroll', 'new', async (b) => {
  const s = await open(b, { path: `/enroll?code=${CODE}`, routes: routesFor(D.NEW_USER, { [`GET /api/runners/device/${CODE}`]: enrollment('APPROVED') }), height: 900 });
  return { s, sels: { next: '.enroll-next', go: '.enroll-actions' } };
});
scene('p-register', 'new', async (b) => {
  let calls = 0;
  const s = await open(b, {
    path: '/runners/register', height: 900,
    routes: routesFor(D.NEW_USER, { 'GET /api/runners': () => (calls++ === 0 ? [] : [D.AUSTIN]) }),
  });
  await s.page.getByText('Runner online').waitFor({ timeout: 20_000 });
  await settle(s.page);
  return { s, sels: { status: '.runner-status' } };
});
scene('p-machine', 'new', async (b) => {
  const s = await open(b, { path: `/runners/${A}`, routes: routesFor(D.NEW_USER), height: 2000 });
  return { s, sels: { attention: 'text=No coding CLI is signed in', empty: '.rd-empty' } };
});
scene('p-settings', 'new', async (b) => {
  const s = await open(b, { path: '/settings', routes: routesFor(D.NEW_USER), height: 1500 });
  return { s, sels: { row: 'text=1 needs you' } };
});
// Card states, each cropped to the card.
scene('e-home', 'new', async (b) => {
  const fleet = { runners: [D.AUSTIN_HOME], workspaces: [] };
  const s = await open(b, { path: `/workspaces/${A}`, routes: routesFor(fleet), height: 900 });
  await s.page.locator('.msc').waitFor();
  await s.page.locator('.msc-input input, input.msc-input').first().fill('payments-api');
  await settle(s.page);
  return { s, sels: { card: '.msc' } };
});
const typed = (path) => async (b) => {
  const s = await open(b, { path: `/workspaces/${A}`, routes: routesFor(D.NEW_USER), height: 900 });
  await s.page.locator('.msc').waitFor();
  await s.page.getByText('Another folder on orbit@austin').click();
  await s.page.locator('.msc-path-input input, input.msc-path-input').first().fill(path);
  await s.page.waitForTimeout(1200);
  await settle(s.page);
  return { s, sels: { card: '.msc' } };
};
scene('e-missing', 'new', typed('/home/orbit/code/ap'));
scene('e-nogit', 'new', typed('/home/orbit/notes'));
scene('e-offline', 'new', async (b) => {
  const fleet = { runners: [D.AUSTIN_OFFLINE], workspaces: [] };
  const s = await open(b, { path: `/workspaces/${A}`, routes: routesFor(fleet), height: 900 });
  await s.page.locator('.msc').waitFor();
  return { s, sels: { card: '.msc' } };
});

const browser = await launch();
for (const sc of scenes) {
  if (sc.tree !== TREE) continue;
  if (only.length && !only.includes(sc.name)) continue;
  const t0 = Date.now();
  try {
    const { s, sels } = await sc.fn(browser);
    await s.page.waitForTimeout(400);
    await settle(s.page);
    marks[sc.name] = { viewport: s.page.viewportSize(), boxes: await boxes(s.page, sels ?? {}) };
    await s.page.screenshot({ path: `${K}/shots/${sc.name}.png` });
    const unhandled = [...new Set(s.api.unhandled)];
    console.log(`${sc.name} ${((Date.now() - t0) / 1000).toFixed(1)}s`, unhandled.length ? `UNHANDLED ${unhandled.join(', ')}` : '', s.errors.length ? `ERRORS ${s.errors.slice(0, 3).join(' | ')}` : '');
    await s.context.close();
  } catch (e) {
    console.log(`${sc.name} FAILED`, e.message.split('\n')[0]);
  }
}
writeFileSync(marksFile, JSON.stringify(marks, null, 1));
await browser.close();
