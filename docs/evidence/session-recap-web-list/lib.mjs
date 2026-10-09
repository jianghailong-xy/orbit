// The real session list (WorkspaceView) from this tree's build, served from a static server and fed
// by the repo's own ui-migration fixtures plus three sessions of our own: one the server has
// recapped, one with only a last reply, one working. Same recipe as the composer-fade kit: a static
// dist rather than a dev server (the host is short of memory and reclaims background services).
//
// Run from the repo root after `npm run build -w @orbit/shared && npm run build -w @orbit/web`:
//   node docs/evidence/session-recap-web-list/capture.mjs
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { uuidToBase62 } from '@orbit/shared';
import { installFixtures, installFixedDate } from '../../../src/web/ui-migration/fixtures.mjs';
import { SESSION_TIME, RUNNER, WORKSPACE } from '../../../src/web/ui-migration/session-fixtures.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DIST = join(ROOT, 'src/web/dist');
const PORT = 5877;
export const BASE = `http://127.0.0.1:${PORT}`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

export async function serveDist() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let body, type;
    try {
      body = await readFile(join(DIST, path));
      type = TYPES[extname(path)] ?? 'application/octet-stream';
    } catch {
      body = await readFile(join(DIST, 'index.html'));
      type = 'text/html';
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  return () => new Promise((r) => server.close(r));
}

// 17:38 in the context's Asia/Shanghai — the clock time a recap line wears in the design.
export const RECAP_AT = '2026-09-28T09:38:00.000Z';
export const RECAP_TEXT = 'Moved the recap onto the session list row with its timestamp; the three states are covered and the web suite is green.';

const id = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const base = (n, title, extra) => ({
  id: id(n), workspaceId: WORKSPACE.id, workspace: WORKSPACE,
  runnerId: RUNNER.id, assignedRunnerId: RUNNER.id, title, provider: 'claude',
  status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', lifecycleState: 'OPEN',
  createdAt: SESSION_TIME, updatedAt: SESSION_TIME, startedAt: SESSION_TIME,
  engineStartedAt: SESSION_TIME, lastTurnAt: SESSION_TIME, shareToken: null,
  ...extra,
});

export const RECAPPED = base(201, 'Recap on the session list row', {
  recapText: RECAP_TEXT, recapAt: RECAP_AT,
  lastAssistantText: 'Committed the row change on the task branch.',
});
export const REPLY = base(202, 'Drawer shadow fix', {
  lastAssistantText: 'Fixed the drawer shadow on the collapsed drawer and re-ran the web suite — everything passes.',
});
export const RUNNING = base(203, 'Rebuilding the transcript page', {
  status: 'RUNNING', runState: 'RUNNING', lastToolUse: 'mcp__orbit__task_create',
  recapText: RECAP_TEXT, recapAt: RECAP_AT,
});

export const ROWS = [RECAPPED, REPLY, RUNNING];

const EVENTS = [
  { seq: 1, type: 'user', payload: { text: 'Pick the recap back up on the list row.' }, turnId: 't1', ts: SESSION_TIME },
  { seq: 2, type: 'assistant', payload: { text: 'Done — the row shows the recap and the time it was written.' }, turnId: 't1', ts: SESSION_TIME },
  { seq: 3, type: 'turn_end', payload: {}, turnId: 't1', ts: SESSION_TIME },
];

/** Serve every /api read the session page makes; anything else falls through to the fixtures. */
async function routes(page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (req.method() !== 'GET') return route.fallback();
    const session = ROWS.find((row) => p.startsWith(`/api/sessions/${row.id}`));
    if (p === '/api/sessions/counts') {
      return json([{ workspaceId: WORKSPACE.id, active: 1, running: 1, jobs: 0, needsYou: 0 }]);
    }
    if (p === '/api/sessions') return json(ROWS);
    if (p === '/api/session-tags' || p === '/api/session-folders') return json([]);
    if (p === '/api/providers/pools' || p === '/api/providers/shared-pools') return json([]);
    if (p === '/api/runners') return json([{ ...RUNNER, name: 'HPC' }]);
    if (p === '/api/workspaces') return json([{ ...WORKSPACE, name: 'orbit' }]);
    if (p === '/api/tasks/evidence-decisions/pending') {
      return json({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (session) {
      const suffix = p.slice(`/api/sessions/${session.id}`.length);
      if (!suffix) return json(session);
      if (suffix === '/events/page') return json({ events: EVENTS, hasMore: false });
      if (['/turns', '/approvals', '/background'].includes(suffix)) return json([]);
      if (suffix === '/diff') return json({ files: [], patches: [] });
      if (suffix === '/created-tasks') return json({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
    }
    return route.fallback();
  });
}

// This host's fontconfig (Inter/JetBrains Mono, as the console expects), when it is installed.
const FONTS = '/var/tmp/session-rename-mock/fonts.conf';

export function launch() {
  return chromium.launch({ env: existsSync(FONTS) ? { ...process.env, FONTCONFIG_FILE: FONTS } : process.env });
}

/** A page on the session route, with the list on the left, at desktop size in `theme`. */
export async function open(browser, { theme = 'light', path = `/sessions/${RECAPPED.id}` } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(240000);
  page.setDefaultNavigationTimeout(240000);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await installFixedDate(page);
  await installFixtures(page, { theme });
  await routes(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors };
}

export const settle = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
