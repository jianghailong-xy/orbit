// Real-build shots of the Orbit Cloud browser viewer (docs/runner-browser-design.md §5), frames 4–9 of
// docs/mocks/runner-browser/01-board-2.png, each taken from the shipped web build.
//
// Not a test: run by hand after a fresh `npm run build`. It serves src/web/dist with vite preview, the UI-migration
// fixtures answer every API call, and a small RFB server stands in for the runner's x11vnc on the viewer WebSocket
// (a real WebSocket upgrade on the preview server), drawing a staged page and counting the pointer and key events
// it receives:
//   node src/web/ui-migration/runner-browser.capture.mjs
// Writes into docs/mocks/runner-browser/real-page/, with input-log.json: what reached the "runner" in each frame.
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { WebSocketServer } from 'ws';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS, installFixtures, installFixedDate } from './fixtures.mjs';
import { RUNNER, SESSION, SESSION_PATH, WORKSPACE } from './session-fixtures.mjs';

const web = fileURLToPath(new URL('../', import.meta.url));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const board = `${repo}docs/mocks/runner-browser/`;
const out = `${board}real-page/`;
mkdirSync(out, { recursive: true });

const fixture = JSON.parse(readFileSync(`${repo}src/shared/src/managed-runner-states.fixture.json`, 'utf8'));
const available = { ...fixture.states.find((s) => s.name === 'available').status, runnerId: RUNNER.id, workspaceId: WORKSPACE.id };
const MANAGED = {
  ...RUNNER, managed: true, online: true, version: '0.1.262', lastHeartbeatAt: '2026-09-28T11:59:50.000Z',
  capabilities: ['browser-clear/v1'],
  engines: [
    { engine: 'claude', installed: true, auth: 'yes' },
    { engine: 'codex', installed: true, auth: 'yes' },
  ],
};
const TITLE = 'Check the signup form on the staging site';
const RUNNING_SESSION = { ...SESSION, title: TITLE, status: 'RUNNING', runState: 'RUNNING' };
const T = '2026-09-28T12:00:00.000Z';
const turnId = 'turn-signup';
const tool = (seq, id, name, input) => [
  { seq, type: 'tool_use', payload: { id, name, input }, turnId, ts: T },
  { seq: seq + 1, type: 'tool_result', payload: { toolUseId: id, content: 'ok' }, turnId, ts: T },
];
const EVENTS = [
  { seq: 1, type: 'user', payload: { text: 'Open staging.example.com/signup, fill it with a test user and tell me if it submits.' }, turnId, ts: T },
  { seq: 2, type: 'assistant', payload: { text: "I'll open the page in the browser and fill the form." }, turnId, ts: T },
  ...tool(3, 'b1', 'mcp__browser__browser_navigate', { url: 'https://staging.example.com/signup' }),
  ...tool(5, 'b2', 'mcp__browser__browser_type', { element: 'Email', text: 'test+0117@example.com' }),
  ...tool(7, 'b3', 'mcp__browser__browser_click', { element: 'Create account' }),
  { seq: 9, type: 'assistant', payload: { text: 'The form shows an error under Password. Trying a longer password…' }, turnId, ts: T },
];

// The runner's browser as GET /runners/:id/browser reports it; each frame sets it.
let browserState = null;
const stateOf = (state, holder) => ({
  runnerId: RUNNER.id, state, holderSessionId: holder ? SESSION.id : null, holderTitle: holder ? TITLE : null,
  viewers: 0, reportedAt: T, clearRequestedAt: null, profileClearedAt: null,
});

// ---- The stand-in runner display: a staged page at 1280×800, served as RFB Raw rectangles. ----
const W = 1280;
const H = 800;
const scenes = {};
async function renderScenes(browser) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const chrome = (url, body) => `<!doctype html><html><body style="margin:0;font:15px Inter,system-ui,sans-serif;color:#1f1f1f">
    <div style="height:44px;display:flex;align-items:center;gap:14px;padding:0 14px;background:#dee1e6;color:#444">
      <span>◀</span><span>▶</span><span>⟳</span>
      <div style="flex:1;height:30px;border-radius:15px;background:#fff;display:flex;align-items:center;padding:0 16px;font-size:14px">${url}</div>
    </div><div style="padding:48px 64px">${body}</div></body></html>`;
  const field = (label, value, bad) => `<div style="margin:0 0 6px;font-weight:500">${label}</div>
    <div style="width:520px;height:40px;border:1px solid ${bad ? '#e5484d' : '#c9c9c9'};border-radius:6px;display:flex;align-items:center;padding:0 12px;margin:0 0 ${bad ? 6 : 18}px">${value}</div>`;
  const button = (text) => `<div style="display:inline-block;margin-top:10px;padding:10px 18px;border-radius:6px;background:#1677ff;color:#fff;font-weight:500">${text}</div>`;
  const pages = {
    signupError: chrome('staging.example.com/signup', `<h1 style="font-size:28px;margin:0 0 28px">Create your account</h1>
      ${field('Email', 'test+0117@example.com')}${field('Password', '••••••••••••', true)}
      <div style="color:#e5484d;font-size:13px;margin-bottom:16px">Password must include a symbol.</div>${button('Create account')}`),
    signupFixed: chrome('staging.example.com/signup', `<h1 style="font-size:28px;margin:0 0 28px">Create your account</h1>
      ${field('Email', 'test+0117@example.com')}${field('Password', '••••••••••••!')}${button('Create account')}`),
    welcome: chrome('staging.example.com/welcome', `<h1 style="font-size:28px;margin:0 0 14px">Welcome, test user</h1><div>Your account is ready.</div>`),
    login: chrome('accounts.example.com/login', `<h1 style="font-size:28px;margin:0 0 28px">Sign in to Example</h1>
      ${field('Email', 'me@example.com')}${field('Password', '••••••••••|')}${button('Sign in')}`),
  };
  for (const [name, html] of Object.entries(pages)) {
    await page.setContent(html);
    const png = (await page.screenshot()).toString('base64');
    // The pixels, as RGBX: noVNC's own pixel format (32 bpp, little-endian, red at shift 0), which it asks for.
    const b64 = await page.evaluate(async ({ png, W, H }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, W, H).data;
      let s = '';
      for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return btoa(s);
    }, { png, W, H });
    scenes[name] = Buffer.from(b64, 'base64');
  }
  await page.close();
}

/** One viewer connection to the stand-in runner: RFB 3.8, no security, Raw frames, input counted. */
function rfbServer(ws, display) {
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  let buf = Buffer.alloc(0);
  let stage = 'version';
  let waiting = false;
  let sent = null;
  const frame = () => {
    sent = display.scene;
    waiting = false;
    ws.send(Buffer.concat([Buffer.from([0, 0]), u16(1), u16(0), u16(0), u16(W), u16(H), u32(0), scenes[display.scene]]));
  };
  display.viewers.add(() => { if (waiting && sent !== display.scene) frame(); });
  ws.send(Buffer.from('RFB 003.008\n'));
  ws.on('message', (message) => {
    buf = Buffer.concat([buf, message]);
    for (;;) {
      if (stage === 'version') {
        if (buf.length < 12) return;
        buf = buf.subarray(12);
        ws.send(Buffer.from([1, 1]));
        stage = 'security';
      } else if (stage === 'security') {
        if (buf.length < 1) return;
        buf = buf.subarray(1);
        ws.send(u32(0));
        stage = 'init';
      } else if (stage === 'init') {
        if (buf.length < 1) return;
        buf = buf.subarray(1);
        const name = Buffer.from('orbit-runner');
        ws.send(Buffer.concat([u16(W), u16(H), Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]), u32(name.length), name]));
        stage = 'messages';
      } else {
        if (!buf.length) return;
        const type = buf[0];
        let length;
        if (type === 0) length = 20;
        else if (type === 2) { if (buf.length < 4) return; length = 4 + 4 * buf.readUInt16BE(2); }
        else if (type === 3) length = 10;
        else if (type === 4) length = 8;
        else if (type === 5) length = 6;
        else if (type === 6) { if (buf.length < 8) return; length = 8 + (buf.readInt32BE(4) < 0 ? 4 : buf.readUInt32BE(4)); }
        else { display.log.push({ frame: display.frame, unknown: type }); buf = Buffer.alloc(0); return; }
        if (buf.length < length) return;
        const m = buf.subarray(0, length);
        buf = buf.subarray(length);
        if (type === 3) {
          if (m[1] === 0 || sent !== display.scene) frame();
          else waiting = true;
        } else if (type === 4) {
          display.input[display.frame] ??= { keys: 0, pointer: 0, typed: '' };
          display.input[display.frame].keys++;
          const keysym = m.readUInt32BE(4);
          if (m[1] === 1 && keysym >= 0x20 && keysym < 0x7f) display.input[display.frame].typed += String.fromCharCode(keysym);
        } else if (type === 5) {
          display.input[display.frame] ??= { keys: 0, pointer: 0, typed: '' };
          display.input[display.frame].pointer++;
        }
      }
    }
  });
}

const display = { scene: 'signupError', frame: '', input: {}, log: [], viewers: new Set() };
const show = (scene) => { display.scene = scene; for (const wake of display.viewers) wake(); };

/** Every request the page made other than reads: proof that taking control and handing back write nothing. */
const writes = [];
async function account(page) {
  await installFixedDate(page);
  const api = await installFixtures(page, { theme: 'light' });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (method !== 'GET') writes.push({ frame: display.frame, method, path });
    if (method === 'GET' && path === '/api/auth/capabilities') return json({ managedRunners: { enabled: true, contractVersion: 1 } });
    if (method === 'GET' && path === '/api/managed-runner') return json(available);
    if (method === 'GET' && path === '/api/runners') return json([MANAGED]);
    if (method === 'GET' && path === `/api/runners/${RUNNER.id}/browser`) {
      return browserState ? json(browserState) : json({ message: `Cannot GET ${path}`, statusCode: 404 }, 404);
    }
    if (method === 'POST' && path === `/api/runners/${RUNNER.id}/browser/clear`) return json({ requestedAt: T }, 202);
    if (method === 'GET' && /^\/api\/runners\/[^/]+\/resources$/.test(path)) return json({ available: false });
    if (method === 'GET' && path === '/api/sessions') return json([RUNNING_SESSION]);
    if (method === 'GET' && path === `/api${SESSION_PATH}`) {
      return json({ ...RUNNING_SESSION, isolationStatus: 'worktree', branch: 'orbit/check-signup', changedFiles: [
        { path: 'notes/signup.md', additions: 12, deletions: 0, status: 'added' },
        { path: 'scripts/check-signup.sh', additions: 20, deletions: 3, status: 'modified' },
      ] });
    }
    if (method === 'GET' && path === `/api${SESSION_PATH}/events/page`) return json({ events: EVENTS, hasMore: false });
    return route.fallback();
  });
  return api;
}

// The shipped build, with the viewer route upgraded to the stand-in runner.
const server = await preview({ root: web, logLevel: 'warn', preview: { host: '127.0.0.1', port: 0, strictPort: false } });
const vncServer = new WebSocketServer({ noServer: true });
server.httpServer.on('upgrade', (req, socket, head) => {
  if (!/^\/api\/runners\/[^/]+\/browser\/vnc\?access_token=./.test(req.url ?? '')) return socket.destroy();
  vncServer.handleUpgrade(req, socket, head, (ws) => rfbServer(ws, display));
});
const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: process.env.FONTCONFIG_FILE ?? '/var/tmp/admin-mock/fonts.conf' } });
await renderScenes(browser);
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, baseURL, locale: 'en-US', timezoneId: 'UTC' });
await account(page);
if (process.env.DEBUG) page.on('console', (m) => console.log('[page]', m.type(), m.text()));
const settle = async () => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(400);
};
const shot = async (name) => { await settle(); await page.screenshot({ path: `${out}${name}.png` }); };
const live = () => page.locator('.rb-link.is-live').waitFor({ timeout: 10_000 }).catch(async (error) => {
  console.log('link:', await page.locator('.rb-link').textContent(), 'canvases:', await page.locator('.rb-screen canvas').count());
  throw error;
});
const canvas = () => page.locator('.rb-screen canvas');

// ④ The session's outputs: the Browser chip while the browser runs (and nothing while it is off).
browserState = null;
display.frame = '4-off';
await page.goto(PATHS.session);
await page.locator('#boot').waitFor({ state: 'detached' }).catch(() => page.locator('#boot').waitFor({ state: 'hidden' }));
await page.getByText('Trying a longer password').waitFor();
await settle();
const chipWhenOff = await page.locator('.rb-chip').count();
await shot('4a-session-switch-off');
browserState = stateOf('RUNNING', true);
display.frame = '4';
await page.reload();
await page.locator('.rb-chip').waitFor();
await shot('4-session-browser-chip');

// ⑤ The drawer, view only: a key pressed on the canvas reaches nothing.
display.frame = '5';
await page.locator('.rb-chip').click();
await live();
await canvas().click({ position: { x: 200, y: 200 } });
await page.keyboard.type('x');
await shot('5-drawer-view-only');

// ⑥ Take control: pointer and keys go to the runner; the session's turn goes on.
display.frame = '6';
await page.getByRole('button', { name: 'Take control' }).click();
await page.locator('.rb-drawer.is-controlling').waitFor();
await canvas().click({ position: { x: 300, y: 260 } });
await page.keyboard.type('!');
show('signupFixed');
await shot('6-take-control');

// ⑦ Hand back: view only again; nothing typed reaches the runner, nothing is sent to the agent.
display.frame = '7';
await page.getByRole('button', { name: 'Hand back' }).click();
await page.locator('.rb-drawer:not(.is-controlling)').waitFor();
await canvas().click({ position: { x: 200, y: 200 } });
await page.keyboard.type('y');
show('welcome');
await shot('7-hand-back');
await page.locator('.orbit-overlay-close').click();

// ⑧ Settings → Orbit Cloud: the Browser section, idle.
browserState = stateOf('IDLE', false);
display.frame = '8';
show('login');
await page.goto(`/settings/machines/${RUNNER.id}`);
await page.locator('.machine-section-browser').waitFor();
await page.locator('.machine-section-browser').scrollIntoViewIfNeeded();
await shot('8-settings-browser-section');
await page.getByRole('button', { name: 'Clear saved logins' }).click();
await page.getByText('Clear saved logins?').waitFor();
await shot('8b-clear-saved-logins-confirm');
await page.getByRole('button', { name: 'Cancel' }).click();

// ⑨ Open browser: the drawer already in control, Done instead of Hand back; signing in types into it.
display.frame = '9';
await page.getByRole('button', { name: 'Open browser' }).click();
await live();
await canvas().click({ position: { x: 300, y: 330 } });
await page.keyboard.type('me@example.com');
await shot('9-settings-open-browser-in-control');
await page.getByRole('button', { name: 'Done' }).click();
await page.locator('.rb-drawer').waitFor({ state: 'detached' });

// The real frames side by side with the board, numbered as it numbers them.
const img = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
const frames = [
  ['4-session-browser-chip', '④ Session: the Browser chip'], ['5-drawer-view-only', '⑤ Drawer: view only'],
  ['6-take-control', '⑥ Take control: the agent keeps running'], ['7-hand-back', '⑦ Hand back: input stops'],
  ['8-settings-browser-section', '⑧ Settings → Orbit Cloud: Browser'], ['9-settings-open-browser-in-control', '⑨ Open browser: in control, Done'],
];
const compose = await browser.newPage({ viewport: { width: 2400, height: 1200 } });
await compose.setContent(`<!doctype html><body style="margin:0;font:16px system-ui;background:#fff">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:24px">
  ${frames.map(([file, caption]) => `<figure style="margin:0"><figcaption style="margin-bottom:6px;color:#333;font-weight:600">${caption}</figcaption>
    <img src="${img(`${out}${file}.png`)}" style="width:100%;border:1px solid #ddd"></figure>`).join('')}
  </div></body>`);
await compose.screenshot({ path: `${out}real-page-frames-4-9.png`, fullPage: true });
await compose.setViewportSize({ width: 3000, height: 1400 });
await compose.setContent(`<!doctype html><body style="margin:0;font:16px system-ui;background:#fff">
  <div style="display:flex;gap:24px;padding:24px;align-items:flex-start">
  <figure style="margin:0;flex:1"><figcaption style="margin-bottom:8px;color:#555">Board 2 (design), frames 4–9</figcaption>
    <img src="${img(`${board}01-board-2.png`)}" style="width:100%;border:1px solid #ddd"></figure>
  <figure style="margin:0;flex:1"><figcaption style="margin-bottom:8px;color:#555">Real build</figcaption>
    <img src="${img(`${out}real-page-frames-4-9.png`)}" style="width:100%;border:1px solid #ddd"></figure>
  </div></body>`);
await compose.screenshot({ path: `${out}beside-board-2.png`, fullPage: true });
await browser.close();
vncServer.close();
await server.close();

const log = { chipWhenSwitchOff: chipWhenOff, inputReachingRunnerByFrame: display.input, writesByFrame: writes, protocolNotes: display.log };
writeFileSync(`${out}input-log.json`, `${JSON.stringify(log, null, 2)}\n`);
console.log(JSON.stringify(log, null, 2));
console.log(`wrote ${out}`);
