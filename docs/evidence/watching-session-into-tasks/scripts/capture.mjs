// Real-page frames of the session page for the watching-session-into-tasks board: the web app built
// twice — `before` from main without this change (eb3fb67fa), `after` from the task's worktree — served
// statically from this process, fed by the repo's ui-migration fixtures plus the board's own data: a
// session that task_awaits its task T and session_awaits T's run session, which carries `targetTask`
// as the server sends it since eb3fb67fa. Writes shots/<scenario>-<tree>[-<state>].png and boxes.json.
// One browser per scenario (the event streams of earlier pages would hold Chrome's six connections).
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const WT = '/root/.orbit/worktrees/1c3c7f6d-70e6-51a2-b06b-004d60e5ea8e';
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXED_NOW } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { SESSION, SESSION_PATH, WORKSPACE, RUNNER } = await import(`${WT}/src/web/ui-migration/session-fixtures.mjs`);
const { uuidToBase62 } = await import(`${WT}/src/shared/dist/index.js`);

const OUT = '/mnt/data/tmp/34hIEi97/web-shots/shots';
mkdirSync(OUT, { recursive: true });
const DISTS = {
  before: ['/var/tmp/34hIEi97-web/before/src/web/dist', 5861],
  after: [`${WT}/src/web/dist`, 5862],
};
const BASES = Object.fromEntries(Object.entries(DISTS).map(([k, [, port]]) => [k, `http://127.0.0.1:${port}`]));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

async function serveDists() {
  const servers = await Promise.all(Object.values(DISTS).map(([dir, port]) => new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let body, type;
      try {
        body = await readFile(join(dir, path));
        type = TYPES[extname(path)] ?? 'application/octet-stream';
      } catch {
        body = await readFile(join(dir, 'index.html'));
        type = 'text/html';
      }
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  })));
  return () => Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
}

// ── the board's data (sample titles; the repo is public) ──
const NOW = Date.parse(FIXED_NOW);
const at = (ms) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);

const T1 = { id: id('a01'), title: 'Android: tapping a notification opens the session it names' };
const T2 = { id: id('a02'), title: 'Android: unread-reply badge on the session list' };
const TZ = { id: id('a03'), title: 'iOS: share sheet saves the image to Photos' };
const RUN1 = { id: id('b01'), title: `Task: ${T1.title}` };
const RUNZ = { id: id('b02'), title: `Task: ${TZ.title}` };
const CHILD = { id: id('b03'), title: 'Deploy main 06f4463: runner 0.1.231 at 40%' };
const RUNNING_TASK = { status: 'IN_PROGRESS', running: true, queued: false };
const RUNNING_SESSION = { status: 'RUNNING', running: true, queued: false };

const ws = { ...WORKSPACE, name: 'orbit' };
const observer = {
  ...SESSION, workspace: ws, workspaceId: ws.id, title: 'Notification tap design review',
  status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', lifecycleState: 'OPEN', pendingApprovals: 0,
  engineTurnActive: false, lastTurnAt: FIXED_NOW, updatedAt: FIXED_NOW, tags: [], folderId: null, pinnedAt: null,
  lastAssistantText: 'It is running. I will review its evidence when it submits.',
};
const ROUNDS = [
  ['A notification on Android opens the session list instead of the session it is about. Can you look into it?',
   'The notification carries the session id, but the tap handler drops it: the activity reads the action and never the extras, so every tap lands on the list. The fix has two parts: keep the id on the intent, and open the session once the list has loaded.'],
  ['The unread badge on the session list never clears either.',
   `That one is separate: the badge counts replies since the session was last opened, and opening it from a notification never marks it read. I filed it as its own task, **${T2.title}**, and it is already done.`],
  ['Dispatch the notification one, and tell me when it is done.',
   `Task **${T1.title}** has started; its run session is **${RUN1.title.slice(0, 40)}…**.\n\nWhen it submits evidence, Orbit hands it to me to review against its acceptance criteria. Two other things wake me too: the task failing, or its run session ending or asking for an approval.`],
];
const events = ROUNDS.flatMap(([ask, answer], i) => {
  const turnId = id(`d0${i + 1}`);
  const ts = at((-30 + i * 2) * MIN);
  return [
    { type: 'user', payload: { text: ask }, turnId, ts },
    { type: 'assistant', payload: { text: answer }, turnId, ts },
    { type: 'turn_end', payload: { subtype: 'success', numTurns: 1 }, turnId, ts },
  ];
}).map((event, i) => ({ seq: i + 1, ...event }));

const created = {
  total: 2, running: 1, failed: 0, done: 1, projects: [],
  items: [
    { ...T1, ...RUNNING_TASK, createdAt: at(-25 * MIN), projectId: null, replaces: null },
    { ...T2, status: 'DONE', running: false, queued: false, createdAt: at(-10 * HOUR), projectId: null, replaces: null },
  ],
};
const createdOnlyDone = { total: 1, running: 0, failed: 0, done: 1, projects: [], items: [created.items[1]] };

const target = (kind, row, standing, over = {}) => ({
  targetKind: kind, targetResourceId: row.id, state: 'OBSERVED', targetEpoch: 0, lastEvaluatedAt: at(-25 * MIN),
  targetTitle: row.title, targetStatus: standing, targetTask: null, ...over,
});
const runOf = (run, task) => target('SESSION', run, RUNNING_SESSION, { targetTask: { id: task.id, title: task.title, status: RUNNING_TASK } });
const TASK_AWAIT = { kind: 'ANY_OF', operands: [
  { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' }, { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_FAILED' }] };
const SESSION_AWAIT = { kind: 'ANY_OF', operands: [
  { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' }, { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'SESSION_NEEDS_ATTENTION' }] };
const watch = (suffix, predicate, targets, over = {}) => ({
  id: id(suffix), observerType: 'SESSION', observerSessionId: observer.id, predicateVersion: 1, predicate,
  mode: 'ONE_SHOT', action: 'RESUME_SESSION', state: 'ACTIVE', generation: 0, debounceSeconds: null, wakeBudget: null,
  holding: false, windowOpenedAt: null, windowClosesAt: null, windowCrossings: 0, expiresAt: at(23 * HOUR),
  nextEvaluateAt: at(MIN), lastEvaluatedAt: at(-20_000), idempotencyKey: null, createdAt: at(-25 * MIN),
  updatedAt: at(-25 * MIN), targets, matches: [], expiryDeliveries: [], ...over,
});
const taskAwait = watch('c01', TASK_AWAIT, [target('TASK', T1, RUNNING_TASK)]);
const sessionAwait = watch('c02', SESSION_AWAIT, [runOf(RUN1, T1)]);

const SCENARIOS = {
  // ①②③ the owner's case: a task_await on T and a session_await on T's run session.
  owner: { watches: [taskAwait, sessionAwait], created },
  // a: the run session of a task created elsewhere.
  elsewhere: { watches: [watch('c03', SESSION_AWAIT, [runOf(RUNZ, TZ)])], created: createdOnlyDone },
  // b: the run-session watch nobody has checked for 12 minutes.
  stale: { watches: [{ ...sessionAwait, lastEvaluatedAt: at(-12 * MIN) }], created },
  // option A: a child session that runs no task stays in Watching.
  child: { watches: [taskAwait, watch('c04', SESSION_AWAIT, [target('SESSION', CHILD, RUNNING_SESSION)])], created },
};

async function launch() {
  return chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/kimi-accounts-mock/fonts.conf' } });
}

async function open(browser, base, scenario) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-US',
    timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await installFixedDate(page);
  const fixtures = await installFixtures(page, { theme: 'light' });
  const data = SCENARIOS[scenario];
  // Registered after the fixtures, so these answer first; anything else falls through to them.
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.method() !== 'GET') return route.fallback();
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (p === '/api/watches') {
      const state = url.searchParams.get('state');
      if (url.searchParams.get('needsAttention')) return json([]);
      return json(state ? data.watches.filter((w) => w.state === state) : data.watches);
    }
    if (p === `/api${SESSION_PATH}`) return json(observer);
    if (p === `/api${SESSION_PATH}/events/page`) return json({ events, hasMore: false });
    if (p === `/api${SESSION_PATH}/created-tasks`) return json(data.created);
    if (p === '/api/sessions') return json([observer]);
    if (p === '/api/runners') return json([{ ...RUNNER, name: 'HPC' }]);
    if (p === '/api/workspaces') return json([ws]);
    return route.fallback();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + SESSION_PATH, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.workspace-composer .bg-tray').first().waitFor();
  await page.waitForTimeout(800);
  return { context, page, errors, fixtures };
}

const box = (page, selector) => page.locator(selector).first().evaluate((el) => el.getBoundingClientRect().toJSON());

/** The tail of the conversation, the band and the composer: the slice each board frame draws. */
async function band(page, name, boxes) {
  const composer = await box(page, '.workspace-composer');
  const clip = { x: composer.x - 12, y: composer.y - 230, width: composer.width + 24, height: composer.height + 230 + 8 };
  boxes[name] = { composer, clip };
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
}

const tasksRow = (page) => page.locator('.workspace-composer .bg-tray').filter({ has: page.locator('.bg-tray-title', { hasText: /^Tasks$/ }) }).locator('.bg-tray-row');
const watchingRow = (page) => page.locator('.workspace-composer .bg-tray.watch-strip .bg-tray-row');

const stop = await serveDists();
const boxes = {};
const words = {};
const only = process.argv[2];
const run = async (key, fn) => {
  if (only && !key.startsWith(only)) return;
  const browser = await launch();
  try {
    await fn(browser);
    console.log(key, 'ok');
  } finally {
    await browser.close();
  }
};

for (const tree of ['before', 'after']) {
  await run(`owner-${tree}`, async (browser) => {
    const { page, errors } = await open(browser, BASES[tree], 'owner');
    await band(page, `owner-${tree}-folded`, boxes);
    // The words beside it: the list row's second line and the header's word.
    const row = page.locator('.session-row').filter({ has: page.locator('.session-title', { hasText: observer.title }) }).first();
    words[tree] = {
      row: await row.locator('.session-preview').first().textContent(),
      header: await page.locator('.workspace-sub').first().textContent(),
      watching: await watchingRow(page).count(),
      tasks: await tasksRow(page).first().textContent(),
    };
    const rowBox = await row.evaluate((el) => el.getBoundingClientRect().toJSON());
    await page.screenshot({ path: `${OUT}/words-${tree}-row.png`, clip: { x: rowBox.x - 4, y: rowBox.y - 4, width: rowBox.width + 8, height: rowBox.height + 8 } });
    const head = await box(page, '.workspace-sub');
    await page.screenshot({ path: `${OUT}/words-${tree}-header.png`, clip: { x: head.x - 16, y: head.y - 34, width: Math.min(560, head.width + 32), height: head.height + 44 } });
    await tasksRow(page).first().click();
    await page.waitForTimeout(400);
    await band(page, `owner-${tree}-opened`, boxes);
    if (errors.length) console.log('page errors', errors);
  });
  await run(`elsewhere-${tree}`, async (browser) => {
    const { page } = await open(browser, BASES[tree], 'elsewhere');
    await band(page, `elsewhere-${tree}-folded`, boxes);
    await tasksRow(page).first().click();
    await page.waitForTimeout(400);
    await band(page, `elsewhere-${tree}-opened`, boxes);
  });
  await run(`stale-${tree}`, async (browser) => {
    const { page } = await open(browser, BASES[tree], 'stale');
    await band(page, `stale-${tree}-folded`, boxes);
    await tasksRow(page).first().click();
    await page.waitForTimeout(400);
    await band(page, `stale-${tree}-opened`, boxes);
  });
  await run(`child-${tree}`, async (browser) => {
    const { page } = await open(browser, BASES[tree], 'child');
    await band(page, `child-${tree}-folded`, boxes);
  });
}
writeFileSync(`${OUT}/boxes.json`, JSON.stringify(boxes, null, 1));
writeFileSync(`${OUT}/words.json`, JSON.stringify(words, null, 1));
console.log(JSON.stringify(words, null, 1));
await stop();
