// Shoots this checkout's built web against the stack's real apiserver (seeded by seed.mjs), each running-mode state beside the
// board frame it implements (docs/mocks/permission-mode-actual/frames), and keeps the session payloads the page itself was
// answered with.
//   node scripts/permission-mode-actual-stack/capture.mjs <dist> <outDir>
// <dist> is `vite build --outDir <dist>` of this checkout's src/web; it is served on a free 127.0.0.1 port with /api proxied
// to the stack (its event streams included). Both runners keep beating through the controller while it runs.
import { chromium } from '@playwright/test';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { API, WT, agentToolsReport, heartbeat, iso, readState, services, sleep } from './lib.mjs';

const dist = resolve(process.argv[2] ?? 'dist');
const out = resolve(process.argv[3] ?? 'shots');
const board = `${WT}/docs/mocks/permission-mode-actual/frames`;
mkdirSync(`${out}/payloads`, { recursive: true });
const state = readState();
const { prisma, api } = services();

// ── the web, with /api passed through to the stack ────────────────────────────────────────────────────────────────────────
const upstream = new URL(API);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url === '/api') {
    const proxied = httpRequest({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host } }, (answer) => { res.writeHead(answer.statusCode, answer.headers); answer.pipe(res); });
    proxied.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(proxied);
    return;
  }
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = join(dist, path);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const WEB = `http://127.0.0.1:${server.address().port}`;

// Both runners keep beating, so the web shows them online and the composer editable.
const beat = async () => { for (const r of Object.values(state.runners)) await heartbeat(api, r).catch((e) => console.log(`heartbeat ${r.name}: ${e.message}`)); };
await beat();
const beating = setInterval(beat, 10_000);

// ── the scenes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const S = state.sessions;
const draftPath = `/workspaces/${state.workspaces['workstation-gpu'].id}/new`;
const SCENES = [
  { name: '1a-running', frame: '01-web-01', caption: '①a The engine runs in Auto: the capsule says Auto.', path: `/sessions/${S.running.id}` },
  { name: '1b-running-menu', frame: '01-web-02', caption: '①b The menu: the check is on Auto; no head.', path: `/sessions/${S.running.id}`, open: 'menu' },
  { name: '2-a1-switching', frame: '01-web-03', caption: 'A1, short: Claude reported Default; "Default → Auto" with a spinner while the runner switches it, and why on hover.',
    path: `/sessions/${S.correcting.id}`, open: 'hover', before: 'engineReportsDefault' },
  { name: '2-a1-lasting', frame: '01-web-04', caption: 'A1, lasting: moved to Haiku 4.5, which has no Auto: "Default" with a dot; the menu head says why and how to get Auto back.',
    path: `/sessions/${S.noAuto.id}`, open: 'menu' },
  { name: '2-a1-lasting-drawer', frame: '01-web-04', caption: 'The Agent tools drawer says the same mode and gap.', path: `/sessions/${S.noAuto.id}`, open: 'drawer' },
  { name: '3-b1-lines', frame: '01-web-07', caption: 'B1: each recorded change where it happened, with who or what made it (claim, engine report, runner, owner on web/iOS/Android, Orbit, re-spawn).',
    path: `/sessions/${S.history.id}`, height: 1100 },
  { name: '3-b1-claim-root', frame: '01-web-07', caption: 'B1 and a lasting gap: Bypass asked for on a runner redeployed as root; the claim handed Auto.',
    path: `/sessions/${S.rootBypass.id}`, open: 'menu' },
  { name: '4a-draft-auto', frame: '01-web-09', caption: '④a A new session on Opus 5.5: Auto, no hint.', path: draftPath, open: 'menu' },
  { name: '4-c1-draft-no-auto', frame: '01-web-10', caption: 'C1: Haiku 4.5 picked in the model menu: Auto stays the pick, labelled "starts in Default".',
    path: draftPath, pickModel: 'Haiku 4.5', open: 'menu' },
];

/** The engine's report that Claude settled in Default, through the real ingest, right before the shot that shows the switch. */
async function engineReportsDefault() {
  const s = S.correcting;
  await api.events({ id: s.runnerId }, s.uuid, { events: [{ seq: ++s.seq, type: 'system', ts: iso(), turnId: s.openTurnId,
    payload: { subtype: 'agent_tools', agentTools: agentToolsReport('default') } }] });
}

const browser = await chromium.launch();
// Signed in once through the web's own form; every scene starts from that sign-in in a fresh context (event streams of a
// previous page would hold the host's connections).
const login = await browser.newContext({ baseURL: WEB });
const lp = await login.newPage();
await lp.goto('/login');
await lp.locator('input[type=email]').fill(state.owner.email);
await lp.locator('label.login-field input:not([type=email])').first().fill(state.owner.password);
await lp.locator('button.login-submit').click();
await lp.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
const signedIn = await login.storageState();
await login.close();

async function open(s) {
  const context = await browser.newContext({ baseURL: WEB, storageState: signedIn, viewport: { width: 1420, height: s.height ?? 640 },
    deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const answers = [];
  page.on('response', async (response) => {
    const path = new URL(response.url()).pathname;
    if (!/^\/api\/sessions(\/[^/]+)?$/.test(path) || response.request().method() !== 'GET') return;
    try { answers.push({ url: response.url().replace(WEB, ''), status: response.status(), body: await response.json() }); } catch { /* not JSON */ }
  });
  await page.goto(s.path);
  await page.locator('.composer-toolbar [data-mode-gap]').waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  return { context, page, answers };
}

async function act(page, s) {
  if (s.pickModel) {
    await page.locator('.composer-toolbar .composer-model-chip').click();
    await page.locator('[role^="menuitem"]', { hasText: s.pickModel }).first().click();
    await page.waitForTimeout(600);
  }
  const pill = page.locator('.composer-toolbar .composer-pill:has([data-mode-gap])');
  if (s.open === 'menu') {
    await pill.locator('[role="combobox"]').click();
    await page.locator('[role="listbox"] [role="option"]').first().waitFor();
  } else if (s.open === 'hover') {
    await pill.hover();
    await page.locator('.orbit-tooltip').waitFor();
  } else if (s.open === 'drawer') {
    await page.locator('.workspace-header button[aria-label="More actions"]').click();
    await page.locator('[role="menuitem"]', { hasText: 'Agent tools' }).click();
    await page.locator('.agent-tools').waitFor();
  }
  await page.waitForTimeout(500);
}

async function columnBox(page) {
  return page.evaluate(() => {
    const header = document.querySelector('.workspace-header');
    let el = document.querySelector('.workspace-composer');
    while (el && header && !el.contains(header)) el = el.parentElement;
    const r = (el ?? document.body).getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
}

/** What the scene shows, read off the page. */
const facts = (page) => page.evaluate(() => {
  const text = (el) => el?.textContent?.replace(/\s+/g, ' ').trim();
  const value = document.querySelector('.composer-toolbar [data-mode-gap]');
  return {
    capsule: text(value?.closest('.orbit-choice-value')),
    gap: value?.getAttribute('data-mode-gap'),
    head: text(document.querySelector('.orbit-select-header')),
    checked: text(document.querySelector('[role="listbox"] [role="option"][aria-selected="true"]')),
    tooltip: text(document.querySelector('.orbit-tooltip')),
    lines: [...document.querySelectorAll('.chat-mode-line')].map((l) =>
      `${text(l.querySelector('.chat-mode-line-text'))} @${l.querySelector('time')?.getAttribute('datetime') ?? ''}${l.classList.contains('is-gap') ? ' (amber)' : ''}`),
    drawerMode: text(document.querySelector('.agent-tools-sec .agent-tools-mode-gap')),
    model: text(document.querySelector('.composer-toolbar .composer-model-name')),
  };
});

const img = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
async function beside(s, shot, size) {
  const page = await browser.newPage({ viewport: { width: 1800, height: 800 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><body style="margin:0;font:14px/1.45 Inter,system-ui,sans-serif;background:#eef0f3;color:#222">
    <div style="padding:20px 24px 8px;font-weight:600">${s.caption}</div>
    <div style="display:flex;gap:24px;padding:8px 24px 24px;align-items:flex-start">
      <figure style="margin:0"><figcaption style="margin-bottom:6px;color:#666">Board frame ${s.frame} (approved design)</figcaption>
        <img src="${img(`${board}/${s.frame}.png`)}" style="width:820px;border:1px solid #d5d8de;border-radius:10px;background:#fff"></figure>
      <figure style="margin:0"><figcaption style="margin-bottom:6px;color:#666">This branch's web on its real apiserver and PostgreSQL</figcaption>
        <img src="${img(shot)}" style="width:${size.width}px;border:1px solid #d5d8de;border-radius:10px;background:#fff"></figure>
    </div></body>`);
  await page.waitForTimeout(200);
  const file = shot.replace(/\.png$/, '-beside-board.png');
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return file;
}

for (const s of SCENES) {
  if (s.before === 'engineReportsDefault') await engineReportsDefault();
  const { context, page, answers } = await open(s);
  await act(page, s);
  const box = s.open === 'drawer' ? await page.locator('[role="dialog"]:has(.agent-tools)').boundingBox() : await columnBox(page);
  const clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  const shot = `${out}/${s.name}.png`;
  await page.screenshot({ path: shot, clip });
  const seen = await facts(page);
  await context.close();
  writeFileSync(`${out}/payloads/${s.name}.json`, JSON.stringify(answers, null, 2) + '\n');
  await beside(s, shot, clip);
  console.log(`${s.name} (beside ${s.frame}): ${JSON.stringify(seen)}; the page read ${answers.map((a) => `${a.url} ${a.status}`).join(', ')}`);
}

clearInterval(beating);
await browser.close();
server.close();
await prisma.$disconnect();
process.exit(0);
