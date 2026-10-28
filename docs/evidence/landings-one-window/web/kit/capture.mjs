// A project's Landings window on the web console (task 34nGbUykKeP4geymwZYB8, owner 2026-10-27,
// docs/mocks/landings-one-window): the BUILT console (dist/), the repo's ui-migration REST fixtures for
// the shell and sign-in, and the project's own reads served here. Copied in shape from
// docs/evidence/landing-entries-web/kit/capture.mjs. Frames (the board's letters):
//   b project-page  the project's sessions page: one Landings row, no Merged into main on the timeline
//   d window        the row's Landings window, at its bottom: the days, then Now's two cards
//   e merge-open    a Merged into main row opened in place: its receipt over its round's own record
//   f focused       a landing session's own address (/sessions/<id>): the window on that landing,
//                   opened and outlined — taken the moment it is placed
//   g card-menu     a right-click on a card in hand: the old landing page's ⋯ rows
//   f-entry         f again, from an entrance: the project page's Landing card's `Open landing ›`
//                   opens the window on that landing (here the card in hand), outlined
// All data is made-up example data. Writes <theme>-<frame>.png and report.json.
//
// RUN: bash ./run.sh [outDir]
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const WT = process.env.WT ?? path.resolve(KIT, '../../../../..');
const DIST = process.env.DIST ?? '/var/tmp/lw-shots/dist';
const OUT = process.argv[2] ?? `${KIT}/out`;
const PORT = 5899;
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const { installFixtures, FIXTURE_IDS } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { SESSION } = await import(`${WT}/src/web/ui-migration/session-fixtures.mjs`);
const { uuidToBase62 } = await import(`${WT}/src/shared/dist/index.js`);

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let file = path.join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

// 2026-10-27 10:20 in Asia/Shanghai — the board's moment.
const NOW = Date.parse('2026-10-27T02:20:00.000Z');
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const ago = (ms) => new Date(NOW - ms).toISOString();
/** A local (Asia/Shanghai) clock time on the 27th, or on another day. */
const local = (hour, minute, day = 27) => new Date(Date.UTC(2026, 9, day, hour - 8, minute)).toISOString();
async function fixDate(page) {
  await page.addInitScript((timestamp) => {
    window.Date = new Proxy(Date, {
      construct: (D, args) => Reflect.construct(D, args.length ? args : [timestamp]),
      apply: (D) => new D(timestamp).toString(),
      get: (D, key) => key === 'now' ? () => timestamp : Reflect.get(D, key),
    });
  }, NOW);
}

const PROJECT = FIXTURE_IDS.project;
const PROJECT_TITLE = 'Wiki server';
const BRANCH = 'project/34bmzOkov3xN2yLPrnsCk';
const RUNNER = 'workstation-gpu';
const sid = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const ID = {
  yesterday: sid(701), search: sid(702), nothing: sid(703), webhook: sid(704), round: sid(705),
  runner: sid(706), waiting: sid(707), live: sid(708), sourceLive: sid(709), sourceWaiting: sid(710),
};

const membership = (role) => ({ projectId: PROJECT, projectTitle: PROJECT_TITLE, projectStatus: 'OPEN', role });
const coordinator = {
  ...SESSION, title: PROJECT_TITLE, projectId: PROJECT, projectTitle: PROJECT_TITLE,
  projectMembership: membership('COORDINATOR'), status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
  runStatus: 'AWAITING_INPUT', lastAssistantText: 'Watching the landings of 2 tasks',
  lastTurnAt: ago(2 * MIN), updatedAt: ago(2 * MIN),
};
const member = (id, title, minutes) => ({
  ...SESSION, id, title, projectId: PROJECT, projectTitle: PROJECT_TITLE, projectMembership: membership('TASK'),
  status: 'SUCCEEDED', runState: 'SUCCEEDED', lastAssistantText: `Recap · ${title.toLowerCase()} is on its branch`,
  lastTurnAt: ago(minutes * MIN), updatedAt: ago(minutes * MIN),
});
const MEMBERS = [coordinator, member(ID.sourceLive, 'Task page reload', 9), member(ID.sourceWaiting, 'Notification cold start', 25)];

// The landings: (id, task or round title, subject, settledAs, settledAt, openedAt).
const SETTLED = [
  [ID.yesterday, 'Land · Ledger migration order', 'TASK', 'LANDED', local(17, 42, 26), local(16, 20, 26)],
  [ID.search, 'Land · Session list search', 'TASK', 'LANDED', local(8, 12), local(7, 50)],
  [ID.nothing, 'Land · Fix the wiki deep link', 'TASK', 'NOTHING_TO_LAND', local(8, 30), local(8, 26)],
  [ID.webhook, 'Land · Webhook signature check', 'TASK', 'LANDED', local(9, 5), local(8, 41)],
  [ID.round, `Merge project/${PROJECT} → main · #12`, 'PROMOTION', 'MERGED', local(9, 52), local(9, 31)],
  [ID.runner, 'Land · Runner model order', 'TASK', 'LANDED', local(10, 2), local(9, 40)],
];
const OPEN = [
  [ID.waiting, 'Land · Notification cold start', 'AWAITING_DECISION', local(10, 2)],
  [ID.live, 'Land · Task page reload', 'IN_FLIGHT', local(10, 13)],
];
const landingRow = (id, title, subject, state, settledAs, settledAt, openedAt) => ({
  ...SESSION, id, title, projectId: PROJECT, projectTitle: PROJECT_TITLE, projectMembership: membership('TASK'),
  sessionKind: 'LANDING', taskId: null, lifecycleState: settledAt ? 'COMPLETED' : 'OPEN',
  status: settledAt ? 'SUCCEEDED' : 'RUNNING', runState: settledAt ? 'SUCCEEDED' : 'RUNNING',
  createdAt: openedAt, lastTurnAt: settledAt ?? openedAt, updatedAt: settledAt ?? openedAt,
  landing: { subject, state, settledAs, settledAt },
});
const ROWS = [
  ...SETTLED.map(([id, title, subject, settledAs, settledAt, openedAt]) =>
    landingRow(id, title, subject, 'SETTLED', settledAs, settledAt, openedAt)),
  ...OPEN.map(([id, title, state, openedAt]) => landingRow(id, title, 'TASK', state, null, null, openedAt)),
];

const PASSED = { exitCode: 0, expectedExitCode: 0, timedOut: false };
let seq = 0;
const entry = (kind, text, at, o = {}) => ({ id: `e${++seq}`, seq, kind, at, claim: o.claim ?? 1, round: o.round ?? null,
  check: o.check ?? null, phase: o.phase ?? null, step: null, actor: { type: o.actor ?? 'RUNNER' }, reason: null,
  data: o.data ?? null, text });
const plus = (at, minutes) => new Date(Date.parse(at) + minutes * MIN).toISOString();
const MERGE_CHECK = { name: 'MERGE_CHECK', index: 1 };
const attempt = (o) => ({ jobId: 'job', kind: 'LAND_TASK', state: 'LANDED', generation: 1, phase: 'CHECK', round: 1,
  step: null, claim: 1, runnerName: RUNNER, sourceSessionId: ID.sourceLive, targetRef: `refs/heads/${BRANCH}`,
  startedAt: ago(HOUR), heartbeatAt: ago(HOUR), outputMovedAt: ago(HOUR), progressProtocol: 'v2', check: null,
  liveness: null, blockingReason: null, timedOut: false, limitSeconds: 600, retryable: false,
  pushBoundaryPassed: true, ...o });
const view = (id, o) => ({ sessionId: id, projectId: PROJECT, subject: 'TASK', taskId: `task-${id.slice(-4)}`,
  promotionId: null, episode: 1, openedAt: ago(HOUR), settledAt: null, settledAs: null, phase: 'CHECK', round: 1,
  checks: [], liveness: null, blockingReason: null, currentAttempt: null, todos: [], generations: [],
  timeline: { sections: [], facts: [], truncated: false }, ...o });

function landingView(id) {
  const settled = SETTLED.find(([sid]) => sid === id);
  if (settled) {
    const [, , subject, settledAs, settledAt, openedAt] = settled;
    if (id === ID.yesterday) {
      return view(id, { openedAt, settledAt, settledAs, currentAttempt: attempt({ jobId: 'job-y2', sourceSessionId: ID.sourceWaiting }),
        timeline: { truncated: false, facts: [], sections: [
          { title: 'Generation 1', jobId: 'job-y1', kind: 'LAND_TASK', generation: 1, state: 'CHECK_FAILED', entries: [
            entry('ENQUEUED', `Task marked done · queued to land on ${BRANCH}`, openedAt),
            entry('CLAIMED', `Claimed by runner ${RUNNER} · claim 1`, plus(openedAt, 1)),
            entry('CHECK_FINISHED', 'Merge check failed · exit 1 after 18m 02s', plus(openedAt, 19), { round: 1,
              check: MERGE_CHECK, data: { exitCode: 1, expectedExitCode: 0, timedOut: false } }),
            entry('HANDED_TO', 'Asked the coordinator to fix it', plus(openedAt, 19), { actor: 'PLATFORM' }),
          ] },
          { title: 'Generation 2', jobId: 'job-y2', kind: 'LAND_TASK', generation: 2, state: 'LANDED', entries: [
            entry('NEXT_GENERATION', 'Rerun by the coordinator · the emulator timed out booting', plus(openedAt, 52), { actor: 'SESSION' }),
            entry('ENQUEUED', `Queued again to land on ${BRANCH}`, plus(openedAt, 52)),
            entry('CHECK_FINISHED', 'Merge check passed · 16m 48s', plus(openedAt, 81), { round: 1, check: MERGE_CHECK, data: PASSED }),
            entry('RESULT', `Landed on ${BRANCH} · 9c2e7d1`, settledAt, { data: { state: 'LANDED' } }),
          ] },
        ] } });
    }
    if (id === ID.round) {
      return view(id, { subject, taskId: null, promotionId: 'promo-12', episode: 12, openedAt, settledAt, settledAs,
        currentAttempt: attempt({ jobId: 'job-m2', kind: 'LAND_PROMOTION', state: 'MERGED' }),
        checks: [{ name: 'MERGE_CHECK', ...PASSED, durationMs: 17 * MIN + 41 * SEC }],
        timeline: { truncated: false, facts: [{ kind: 'PROMOTION_STATE', text: 'Merge round · merged', data: null }], sections: [
          { title: 'Merge check · 1', jobId: 'job-m1', kind: 'CHECK_PROMOTION', generation: 1, state: 'READY', entries: [
            entry('CHECK_STARTED', 'Merge check started on the combined tree', plus(openedAt, 2), { round: 1, check: MERGE_CHECK }),
            entry('CHECK_FINISHED', 'Merge check passed · 17m 41s', plus(openedAt, 19), { round: 1, check: MERGE_CHECK, data: PASSED }),
          ] },
          { title: 'Merge to main · 1', jobId: 'job-m2', kind: 'LAND_PROMOTION', generation: 1, state: 'MERGED', entries: [
            entry('CLAIMED', `Claimed by runner ${RUNNER} · claim 1`, plus(openedAt, 20)),
            entry('RESULT', 'Landed on main · 3f1c2a9', settledAt, { data: { state: 'LANDED' } }),
          ] },
        ] } });
    }
    return view(id, { openedAt, settledAt, settledAs, currentAttempt: attempt({ jobId: `job-${id.slice(-4)}`, state: settledAs }),
      timeline: { truncated: false, facts: [], sections: [
        { title: 'Generation 1', jobId: `job-${id.slice(-4)}`, kind: 'LAND_TASK', generation: 1, state: settledAs, entries: [
          entry('ENQUEUED', `Task marked done · queued to land on ${BRANCH}`, openedAt),
          entry('CLAIMED', `Claimed by runner ${RUNNER} · claim 1`, plus(openedAt, 1)),
          entry('RESULT', settledAs === 'NOTHING_TO_LAND' ? 'Nothing to push · the branch carried no commits'
            : `Landed on ${BRANCH} · 4b1d0e2`, settledAt, { data: { state: settledAs } }),
        ] },
      ] } });
  }
  if (id === ID.waiting) {
    const openedAt = local(10, 2);
    return view(id, { openedAt, currentAttempt: attempt({ jobId: 'job-w', state: 'CHECK_FAILED', pushBoundaryPassed: false,
      sourceSessionId: ID.sourceWaiting, startedAt: plus(openedAt, 1) }),
      checks: [{ name: 'MERGE_CHECK', exitCode: 1, expectedExitCode: 0, timedOut: false, durationMs: 3 * MIN + 52 * SEC }],
      timeline: { truncated: false, facts: [], sections: [
        { title: 'Generation 1', jobId: 'job-w', kind: 'LAND_TASK', generation: 1, state: 'CHECK_FAILED', entries: [
          entry('ENQUEUED', `Task marked done · queued to land on ${BRANCH}`, openedAt),
          entry('CLAIMED', `Claimed by runner ${RUNNER} · claim 1`, plus(openedAt, 1)),
          entry('CHECK_FINISHED', 'Merge check failed · exit 1 after 3m 52s', plus(openedAt, 5), { round: 1, check: MERGE_CHECK,
            data: { exitCode: 1, expectedExitCode: 0, timedOut: false } }),
          entry('RESULT', 'Check failed · nothing was pushed', plus(openedAt, 5), { data: { state: 'CHECK_FAILED' } }),
          entry('HANDED_TO', 'Asked the coordinator to fix it', plus(openedAt, 5), { actor: 'PLATFORM' }),
        ] },
      ] } });
  }
  if (id === ID.live) {
    const checkStart = ago(6 * MIN + 12 * SEC);
    return view(id, { openedAt: local(10, 13), liveness: 'LIVE', currentAttempt: attempt({ jobId: 'job-live', state: 'RUNNING',
      pushBoundaryPassed: false, startedAt: local(10, 13), heartbeatAt: ago(1 * SEC), outputMovedAt: ago(2 * SEC),
      check: { name: 'MERGE_CHECK', index: 1, count: 1, budgetSeconds: 1_800, startedAt: checkStart }, liveness: 'LIVE' }),
      timeline: { truncated: false, facts: [], sections: [
        { title: 'Generation 1', jobId: 'job-live', kind: 'LAND_TASK', generation: 1, state: 'RUNNING', entries: [
          entry('ENQUEUED', `Task marked done · queued to land on ${BRANCH}`, local(10, 13)),
          entry('CLAIMED', `Claimed by runner ${RUNNER} · claim 1`, local(10, 13)),
          entry('CHECK_STARTED', 'Merge check started on the combined tree', checkStart, { round: 1, check: MERGE_CHECK }),
        ] },
      ] } });
  }
  return null;
}

const merged = (promotionId, at, landingSessionId, tasks, sha, automatic) => ({
  promotionId, state: 'MERGED', sourceKind: 'PROJECT_BRANCH', sourceRef: `refs/heads/${BRANCH}`, sourceSha: 'a'.repeat(40),
  upstreamRef: 'refs/heads/main', commitsAhead: tasks.length, filesChanged: 6,
  tasks: tasks.map((title, i) => ({ taskId: `t${i}`, title })), taskIds: tasks.map((_, i) => `t${i}`),
  checks: [{ name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false, durationMs: 17 * MIN + 41 * SEC }],
  conflicts: [], blockedReason: null, upstreamShaChecked: 'b'.repeat(40), landsTreeSha: '5e5bfca' + '0'.repeat(33),
  landsAs: 'MERGE_COMMIT', askedAt: null, upstream: { syncedAt: null, conflicts: false }, recheckedAt: null, recheck: null,
  decidedAt: null, onPass: null, landingSessionId,
  merged: { sha: sha + '0'.repeat(33), at, automatic, byUserId: automatic ? null : 'user-1', revert: null },
});
const MERGES = [
  merged('promo-12', local(9, 51), ID.round, ['Session list search', 'Webhook signature check (#2)'], '3f1c2a9', true),
  merged('promo-3', local(11, 30, 15), null, ['Search index warm-up'], '8d5a868', false),
];
const liveJob = {
  jobId: 'job-live', kind: 'LAND_TASK', state: 'RUNNING', phase: 'CHECK', taskId: 'task-live', taskTitle: 'Task page reload',
  generation: 1, startedAt: local(10, 13), queuedAt: local(10, 13), heartbeatAt: ago(1 * SEC), runnerName: RUNNER,
  retriedBy: null, timedOut: false, limitSeconds: 600, retryable: false, landingSessionId: ID.live, liveness: 'LIVE',
  claim: 1, round: 1, stepStartedAt: ago(6 * MIN + 12 * SEC), outputMovedAt: ago(2 * SEC), typicalMs: 9 * MIN,
  check: { name: 'MERGE_CHECK', index: 1, count: 1, budgetSeconds: 1_800, startedAt: ago(6 * MIN + 12 * SEC) },
};
const INTEGRATION = {
  line: 'PROJECT_BRANCH', lineAbsentReason: null, ref: BRANCH, upstreamRef: 'refs/heads/main', source: 'EXPLICIT',
  locked: true, startedAt: ago(28 * HOUR), mergeCheckCommand: 'npm test', mergeCheckCommandAbsentReason: null,
  mergeCheckTimeoutSeconds: 1_800, escalationSeconds: 3_600, commitsAheadOfUpstream: 2,
  commitsAheadOfUpstreamAbsentReason: null, lastUpstreamSyncAt: ago(3 * HOUR), lastUpstreamSyncAbsentReason: null,
  integratingCount: 1, queuedCount: 0, mergeCheckOnTip: 'PASSING', inFlight: liveJob, inFlightJobs: [liveJob],
  landTasks: [{ taskId: 'task-live', taskTitle: 'Task page reload', integration: { state: 'RUNNING', since: local(10, 13),
    handler: null, openItemId: null, jobId: 'job-live', checksRunningForMs: null, landTask: { jobId: 'job-live',
      state: 'RUNNING', phase: 'CHECK', generation: '1', queuedAt: local(10, 13), startedAt: local(10, 13),
      heartbeatAt: ago(1 * SEC), finishedAt: null, targetRef: `refs/heads/${BRANCH}`, waitMs: 20_000, blockingReason: null,
      landingSessionId: ID.live } } }],
};
const projectDoc = {
  id: PROJECT, title: PROJECT_TITLE, status: 'OPEN', createdAt: '2026-10-10T00:00:00.000Z', lastActivityAt: ago(2 * MIN),
  mainBranch: 'main', buckets: { running: 1, ready: 0, blocked: 0, awaitingVerification: 0, done: 79, failed: 1, cancelled: 0 },
  taskCounts: { done: 79, failed: 1, total: 91 },
  attention: { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, ownerItems: [], coordinatorItems: null, startRequest: null },
  coordinatorActivity: { working: false, lastTurnAt: ago(2 * MIN) }, startedAt: ago(10 * 24 * HOUR),
};

const windowPath = `/projects/${PROJECT}/landings?project=${PROJECT}`;
const FRAMES = {
  'b-project-page': { path: `/sessions/${coordinator.id}?project=${PROJECT}`, wait: '.session-project-landings' },
  'd-window': { path: windowPath, wait: '.landings-window-now' },
  'e-merge-open': { path: windowPath, wait: '.landings-window-now', open: ID.round },
  'f-focused': { path: `/sessions/${ID.yesterday}?project=${PROJECT}`, wait: '.landings-window-entry.is-outlined', fast: true },
  'g-card-menu': { path: windowPath, wait: '.landings-window-now', menuOn: ID.live },
  'f-entry': { path: `/sessions/${coordinator.id}?project=${PROJECT}`, wait: '.session-project-landing', follow: true },
};

const THEMES = (process.env.THEMES ?? 'light,dark').split(',');
const ONLY = (process.env.FRAMES_ONLY ?? '').split(',').filter(Boolean);
const browser = await chromium.launch();
const report = [];
for (const theme of THEMES) {
  for (const [name, frame] of Object.entries(FRAMES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2,
      timezoneId: 'Asia/Shanghai' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? ''}`));
    await fixDate(page);
    const fixtures = await installFixtures(page, { theme });
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const p = url.pathname;
      if (request.method() !== 'GET') return route.fallback();
      const json = (body) => route.fulfill({ status: 200, json: body });
      if (p === '/api/projects/sidebar') return json([projectDoc]);
      if (p === `/api/projects/${PROJECT}`) return json(projectDoc);
      if (p === '/api/sessions' && url.searchParams.get('projectId') === PROJECT) {
        const completed = url.searchParams.get('view') === 'completed';
        const landings = url.searchParams.get('includeLanding') === '1'
          ? ROWS.filter((row) => (row.lifecycleState === 'COMPLETED') === completed) : [];
        return json([...(completed ? [] : MEMBERS), ...landings]);
      }
      if (p === `/api/projects/${PROJECT}/integration`) return json(INTEGRATION);
      if (p === `/api/projects/${PROJECT}/promotions/current`) return json(null);
      if (p === `/api/projects/${PROJECT}/promotions/merged`) return json(MERGES);
      if (p === `/api/projects/${PROJECT}/open-items`) return json({ needsYou: [], withCoordinator: [], startRequest: null, readAt: new Date(NOW).toISOString() });
      if (p === `/api/projects/${PROJECT}/coordinator/status`) {
        return json({ coordination: { sessionId: coordinator.id, workspaceId: SESSION.workspaceId }, readAt: new Date(NOW).toISOString() });
      }
      if (p.startsWith(`/api/projects/${PROJECT}/acceptance/criteria-decisions/pending`)) {
        return json({ projectId: PROJECT, readAt: new Date(NOW).toISOString(), count: 0, oldestAgeSeconds: null,
          decidableCount: 0, pending: [], settled: [] });
      }
      if (p === `/api/projects/${PROJECT}/acceptance/confirmation`) return json(null);
      if (p === `/api/sessions/${coordinator.id}`) return json(coordinator);
      const landingMatch = p.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
      if (landingMatch) {
        const row = ROWS.find((candidate) => candidate.id === landingMatch[1]);
        if (row && !landingMatch[2]) return json({ ...row, landing: landingView(row.id) });
        if (row && landingMatch[2] === '/landing/log') {
          return json({ jobId: 'job-w', nextCursor: null, entries: [{ jobId: 'job-w', claim: 1, round: 1, check: MERGE_CHECK, seq: 0,
            truncatedBytes: 0, at: local(10, 7), text: '$ npm test\n FAIL  src/notifications/cold-start.test.ts\n AssertionError: expected the session page but the list was open\n Test Files  1 failed | 4 passed (5)\n' }] });
        }
      }
      if (p.endsWith('/events/page')) return json({ events: [], hasMore: false });
      if (p.endsWith('/approvals')) return json([]);
      if (p.endsWith('/turns')) return json([]);
      if (p.endsWith('/background')) return json([]);
      if (p.endsWith('/created-tasks')) return json({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      if (p.startsWith('/api/sessions/') && p.endsWith('/diff')) return json({ files: [] });
      if (p.startsWith(`/api/sessions/${coordinator.id}/`)) return json([]);
      return route.fallback();
    });
    await page.goto(`http://127.0.0.1:${PORT}${frame.path}`);
    let placed = true;
    try {
      await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 30_000 });
      await page.waitForSelector(frame.wait, { timeout: 20_000 });
    } catch (error) {
      placed = false;
      errors.push(String(error));
    }
    if (frame.fast) {
      // The outline lasts 1.5 s from the moment the window is placed: past its 200 ms fade-in, well
      // inside its life.
      await page.waitForTimeout(450);
    } else {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1_500);
    }
    if (frame.open) {
      const row = page.locator(`[data-landing-entry="${frame.open}"] .landings-window-row`);
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await page.waitForSelector(`[data-landing-entry="${frame.open}"] .landings-window-receipt`, { timeout: 10_000 });
      await page.waitForTimeout(700);
      await page.locator(`[data-landing-entry="${frame.open}"]`).evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(300);
    }
    if (frame.follow) {
      // The Landing card's own way in, as a reader presses it.
      await page.locator('.session-project-landing a', { hasText: 'Open landing' }).first().click();
      await page.waitForSelector('.landings-window-entry.is-outlined', { timeout: 20_000 });
      await page.waitForTimeout(450);
    }
    if (frame.menuOn) {
      await page.locator(`[data-landing-entry="${frame.menuOn}"] .landings-window-card-press`).click({ button: 'right' });
      await page.waitForSelector('[role="menu"]', { timeout: 10_000 });
      await page.waitForTimeout(500);
    }
    const file = `${OUT}/${theme}-${name}.png`;
    await page.screenshot({ path: file, animations: 'disabled' });
    const drawn = await page.evaluate(() => ({
      landingsRow: document.querySelector('.session-project-landings')?.textContent ?? null,
      timelineMergeRows: [...document.querySelectorAll('.session-col-list .session-project-merge-row')]
        .filter((row) => !row.closest('.session-project-landings')).map((row) => row.textContent),
      windowTitle: document.querySelector('.landings-window .landing-page-title')?.textContent ?? null,
      windowSub: document.querySelector('.landings-window .landing-page-sub')?.textContent ?? null,
      days: [...document.querySelectorAll('.landings-window-day')].map((day) => ({
        title: day.querySelector('.landings-window-day-head')?.textContent,
        entries: [...day.querySelectorAll('[data-landing-entry]')].map((entry) => entry.querySelector('.session-project-merge-row-title, .landings-window-card-task')?.textContent),
      })),
      outlined: [...document.querySelectorAll('.landings-window-entry.is-outlined')].map((entry) => entry.getAttribute('data-landing-entry')),
      open: [...document.querySelectorAll('.landings-window-entry.is-open')].map((entry) => entry.getAttribute('data-landing-entry')),
      receipt: document.querySelector('.landings-window-receipt')?.textContent ?? null,
      menu: [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
      footer: document.querySelector('.landings-window .landing-page-foot')?.textContent ?? null,
      composer: !!document.querySelector('.workspace-composer textarea'),
      url: location.pathname + location.search,
    }));
    report.push({ theme, frame: name, placed, errors, unhandled: fixtures.unhandled, ...drawn });
    console.log(theme, name, JSON.stringify({ placed, errors: errors.map((e) => e.slice(0, 200)), unhandled: fixtures.unhandled }));
    await page.close();
  }
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
server.close();
