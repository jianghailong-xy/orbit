// Real-build shots of the mode a session is actually running in (board docs/mocks/permission-mode-actual, the
// owner's A1, B1 and C1): the composer's Mode capsule, its menu, the transcript's mode-change lines and the Agent
// tools drawer, each scene beside the board frame it implements.
//
// Not a test: run by hand against a built dist, with the UI-migration fixtures answering every API call:
//   (cd src/web && npx vite build --outDir <dist>)
//   node src/web/ui-migration/permission-mode-actual.capture.mjs <dist> <outDir>
// It needs src/shared/dist (`npx tsc -p src/shared/tsconfig.json`), which the fixtures import.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidToBase62 } from '@orbit/shared';
import { FIXED_NOW, installFixedDate, installFixtures } from './fixtures.mjs';

const dist = resolve(process.argv[2] ?? 'dist');
const out = resolve(process.argv[3] ?? 'permission-mode-actual-shots');
const board = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/mocks/permission-mode-actual/frames');
mkdirSync(out, { recursive: true });

// ── The scenes' data ────────────────────────────────────────────────────────────────────────────────────────
const NOW = Date.parse(FIXED_NOW);
const iso = (ms) => new Date(ms).toISOString();
/** Minutes before the fixtures' frozen clock. */
const before = (minutes) => iso(NOW - minutes * 60_000);
const uid = (n) => uuidToBase62(`0196e000-0000-7000-8000-0000000007${String(n).padStart(2, '0')}`);
const ALL_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const runnerOf = (runsAsRoot = false) => ({
  id: uid(1), name: 'workstation-gpu', online: true, maxConcurrent: 4, activeSessions: 1, runsAsRoot,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
  modelCatalog: {
    claude: [
      { value: 'claude-opus-5-5', label: 'Opus 5.5', permissionModes: ALL_MODES },
      { value: 'claude-haiku-4-5', label: 'Haiku 4.5', permissionModes: ALL_MODES.filter((m) => m !== 'auto') },
    ],
  },
});
const workspaceOf = (runner, lastModel) => ({
  id: uid(2), name: 'orbit', runnerId: runner.id, createdAt: before(600),
  lastEngine: 'claude', lastProvider: 'claude', provider: 'claude', lastModel, model: null, effort: null,
});
const change = (cause, toMode, fromMode, at, client = null) => ({ cause, toMode, fromMode, client, at });
const CONVERSATION = [
  { seq: 1, type: 'user', ts: before(40), payload: { text: 'Run the staging migration check and tell me what fails.' } },
  { seq: 2, type: 'assistant', ts: before(36), payload: { text: 'Ran it against staging: 14 of 14 checks passed. The slowest step was the index rebuild on `sessions` (41 s).' } },
  { seq: 3, type: 'turn_end', ts: before(36), payload: {} },
];
const LONGER = [
  ...CONVERSATION,
  { seq: 4, type: 'user', ts: before(30), payload: { text: 'Good. Now drop the old `runner_probe` table on staging.' } },
  { seq: 5, type: 'assistant', ts: before(26), payload: { text: 'Dropped it. Nothing else referenced it.' } },
  { seq: 6, type: 'turn_end', ts: before(26), payload: {} },
];

/** A live Claude session: its stored intent, the mode the server recorded it running in, and how that came to be. */
function sessionOf({ n, title, model, intent, actual, actualAt, changes, events = CONVERSATION, runner }) {
  const workspace = workspaceOf(runner, model);
  return {
    id: uid(10 + n), workspaceId: workspace.id, workspace, runnerId: runner.id, assignedRunnerId: runner.id,
    title, status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', lifecycleState: 'OPEN',
    provider: 'claude', engine: 'claude', model, effort: 'max', numTurns: 2,
    permissionMode: intent, actualPermissionMode: actual, actualPermissionModeAt: actualAt, permissionModeChanges: changes,
    createdAt: before(41), updatedAt: before(1), startedAt: before(41), lastTurnAt: before(1), shareToken: null,
    events,
  };
}

const SCENES = [];
const scene = (name, frame, caption, s) => SCENES.push({ name, frame, caption, ...s });
{
  const runner = runnerOf();
  const running = sessionOf({
    n: 1, title: 'Staging migration check', model: 'claude-opus-5-5', intent: 'auto', actual: 'auto', actualAt: before(40),
    changes: [change('CLAIM', 'auto', null, before(40))], runner,
  });
  scene('1a-running', '01-web-01', '①a The engine runs in Auto: the capsule says Auto.', { runner, session: running });
  scene('1b-running-menu', '01-web-02', '①b The menu: the check is on Auto; no head.', { runner, session: running, open: 'menu' });

  const correcting = sessionOf({
    n: 2, title: 'Staging migration check', model: 'claude-opus-5-5', intent: 'auto', actual: 'default', actualAt: iso(NOW - 4_000),
    changes: [change('CLAIM', 'auto', null, iso(NOW - 6_000)), change('ENGINE_REPORT', 'default', 'auto', iso(NOW - 4_000))], runner,
  });
  scene('2-a1-switching', '01-web-03', 'A1, short: "Default → Auto" with a spinner; hovering says why.', { runner, session: correcting, open: 'hover' });

  const noAuto = sessionOf({
    n: 3, title: 'Staging migration check', model: 'claude-haiku-4-5', intent: 'auto', actual: 'default', actualAt: before(20),
    changes: [change('CLAIM', 'auto', null, before(40)), change('OWNER_PICK', 'default', 'auto', before(20), 'web')], runner,
  });
  scene('2-a1-lasting', '01-web-04', 'A1, lasting: "Default" with a dot; the menu head says why and how to get Auto back.', { runner, session: noAuto, open: 'menu' });
  scene('2-a1-lasting-drawer', '01-web-04', 'The Agent tools drawer says the same mode and gap.', { runner, session: noAuto, open: 'drawer' });

  const history = sessionOf({
    n: 4, title: 'Staging migration check', model: 'claude-opus-5-5', intent: 'auto', actual: 'auto', actualAt: before(5),
    changes: [
      change('CLAIM', 'auto', null, before(40)),
      change('ENGINE_REPORT', 'default', 'auto', iso(NOW - 40 * 60_000 + 2_000)),
      change('RUNNER_CORRECTION', 'auto', 'default', iso(NOW - 40 * 60_000 + 5_000)),
      change('OWNER_PICK', 'plan', 'auto', before(29), 'web'),
      change('OWNER_PICK', 'acceptEdits', 'plan', before(28), 'ios'),
      change('OWNER_PICK', 'auto', 'acceptEdits', before(27), 'android'),
      change('ORBIT_CHANGE', 'default', 'auto', before(20)),
      change('RESPAWN', 'auto', 'default', before(5)),
    ],
    events: LONGER, runner,
  });
  // Taller than the board's frame, so every line of the conversation is in the shot.
  scene('3-b1-lines', '01-web-07', 'B1: each change where it happened, who or what made it.', { runner, session: history, height: 980 });
  scene('3-b1-model-no-auto', '01-web-07', 'B1: the change behind a gap still open is amber.', { runner, session: noAuto });

  scene('4a-draft-auto', '01-web-09', '④a A new session on Opus 5.5: Auto, no hint.', { runner, draft: 'claude-opus-5-5', open: 'menu' });
  scene('4-c1-draft-no-auto', '01-web-10', 'C1: on Haiku 4.5 Auto stays the pick, labelled "starts in Default".', { runner, draft: 'claude-haiku-4-5', open: 'menu' });
}
{
  const runner = runnerOf(true);
  const rootBypass = sessionOf({
    n: 5, title: 'Staging migration check', model: 'claude-opus-5-5', intent: 'bypassPermissions', actual: 'auto', actualAt: before(40),
    changes: [change('CLAIM', 'auto', null, before(40))], runner,
  });
  scene('3-b1-claim-root', '01-web-07', 'B1: a claim-time substitution, Bypass on a root runner.', { runner, session: rootBypass, open: 'menu' });
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────────────────────
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = join(dist, path);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const baseURL = `http://127.0.0.1:${server.address().port}`;

async function open(browser, s) {
  // Wide enough that the conversation column is about as wide as the board's 820 px desktop frames.
  const page = await browser.newPage({ viewport: { width: 1420, height: s.height ?? 640 }, deviceScaleFactor: 2, baseURL, locale: 'en-US', timezoneId: 'UTC' });
  await installFixedDate(page);
  await installFixtures(page, { theme: 'light' });
  const sessions = s.session ? [s.session] : [];
  const workspace = s.session?.workspace ?? workspaceOf(s.runner, s.draft);
  // Registered after installFixtures, so these answer first.
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path } = new URL(request.url());
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (request.method() !== 'GET') return route.fallback();
    if (path === '/api/runners') return json([s.runner]);
    if (path === '/api/workspaces') return json([workspace]);
    if (path === '/api/sessions') return json(sessions.map(({ events, permissionModeChanges, ...row }) => row));
    for (const one of sessions) {
      const base = `/api/sessions/${one.id}`;
      if (path === base) return json(Object.fromEntries(Object.entries(one).filter(([key]) => key !== 'events')));
      if (path === `${base}/events/page`) return json({ events: one.events, hasMore: false });
      if ([`${base}/turns`, `${base}/approvals`, `${base}/background`].includes(path)) return json([]);
      if (path === `${base}/diff`) return json({ files: [], patches: [] });
      if (path === `${base}/created-tasks`) return json({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
    }
    return route.fallback();
  });
  await page.goto(s.session ? `/sessions/${s.session.id}` : `/workspaces/${workspace.id}/new`);
  await page.locator('.composer-toolbar [data-mode-gap]').waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  return page;
}

async function act(page, s) {
  const capsule = page.locator('.composer-toolbar .composer-pill:has([data-mode-gap])');
  if (s.open === 'menu') {
    await capsule.locator('[role="combobox"]').click();
    await page.locator('[role="listbox"] [role="option"]').first().waitFor();
  } else if (s.open === 'hover') {
    await capsule.hover();
    await page.locator('.orbit-tooltip').waitFor();
  } else if (s.open === 'drawer') {
    await page.locator('.workspace-header button[title="More actions"]').click();
    await page.locator('[role="menuitem"]', { hasText: 'Agent tools' }).click();
    await page.locator('.agent-tools').waitFor();
  }
  await page.waitForTimeout(500);
}

/** The conversation column: the nearest box holding both the header and the composer. */
async function columnBox(page) {
  return page.evaluate(() => {
    const header = document.querySelector('.workspace-header');
    let el = document.querySelector('.workspace-composer');
    while (el && header && !el.contains(header)) el = el.parentElement;
    const r = (el ?? document.body).getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
}

/** What the scene shows, read off the page: the log a reader checks the shot against. */
async function facts(page) {
  return page.evaluate(() => {
    const capsule = document.querySelector('.composer-toolbar [data-mode-gap]');
    const text = (el) => el?.textContent?.replace(/\s+/g, ' ').trim();
    return {
      capsule: text(capsule?.closest('.orbit-choice-value')),
      gap: capsule?.getAttribute('data-mode-gap'),
      head: text(document.querySelector('.orbit-select-header')),
      checked: text(document.querySelector('[role="listbox"] [role="option"][aria-selected="true"]')),
      tooltip: text(document.querySelector('.orbit-tooltip')),
      lines: [...document.querySelectorAll('.chat-mode-line')].map((l) => `${text(l)}${l.classList.contains('is-gap') ? ' (amber)' : ''}`),
      drawerMode: text(document.querySelector('.agent-tools-sec .agent-tools-mode-gap')),
    };
  });
}

const img = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;

/** The board's frame and the real shot side by side, both at their own scale (CSS pixels), as one image. */
async function beside(browser, s, shot, size) {
  const frame = join(board, `${s.frame}.png`);
  const page = await browser.newPage({ viewport: { width: 1800, height: 800 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><body style="margin:0;font:14px/1.45 Inter,system-ui,sans-serif;background:#eef0f3;color:#222">
    <div style="padding:20px 24px 8px;font-weight:600">${s.caption}</div>
    <div style="display:flex;gap:24px;padding:8px 24px 24px;align-items:flex-start">
      <figure style="margin:0"><figcaption style="margin-bottom:6px;color:#666">Board frame ${s.frame} (approved design)</figcaption>
        <img src="${img(frame)}" style="width:820px;border:1px solid #d5d8de;border-radius:10px;background:#fff"></figure>
      <figure style="margin:0"><figcaption style="margin-bottom:6px;color:#666">Real web build (this branch)</figcaption>
        <img src="${img(shot)}" style="width:${size.width}px;border:1px solid #d5d8de;border-radius:10px;background:#fff"></figure>
    </div></body>`);
  await page.waitForTimeout(200);
  const file = shot.replace(/\.png$/, '-beside-board.png');
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return file;
}

const browser = await chromium.launch();
if (process.env.PROBE) {
  const page = await open(browser, SCENES[0]);
  await page.screenshot({ path: join(out, 'probe.png') });
  console.log(JSON.stringify(await columnBox(page)));
  await browser.close();
  server.close();
  process.exit(0);
}
const log = [];
for (const s of SCENES) {
  const page = await open(browser, s);
  await act(page, s);
  const box = s.open === 'drawer'
    ? await page.locator('[role="dialog"]:has(.agent-tools)').boundingBox()
    : await columnBox(page);
  const clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  const shot = join(out, `${s.name}.png`);
  await page.screenshot({ path: shot, clip });
  const seen = await facts(page);
  await page.close();
  const pair = await beside(browser, s, shot, clip);
  log.push({ scene: s.name, frame: s.frame, shot, pair, ...seen });
  console.log(`${s.name} (beside ${s.frame}): ${JSON.stringify(seen)}`);
}
await browser.close();
server.close();
