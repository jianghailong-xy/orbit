// The Landings window drawn as a chat on the web console (owner 2026-11-02, option C,
// docs/mocks/landings-chat-bubbles): the BUILT console (dist/), the repo's ui-migration REST fixtures
// for the shell and sign-in, and the project's own reads served here. Adapted from
// docs/evidence/landings-one-window/web/kit/capture.mjs. Frames:
//   a-bottom   the window as it opens, at its bottom: Today's group, then Now's (T5 waits, T6 checks)
//   b-history  scrolled up: Yesterday's chip and its three groups, one avatar each, then Today's chip
//   c-open     Today's T3 bubble pressed: its record on the quiet panel under it
//   d-menu     the ⋯ beside T3's bubble pressed: the landing's own menu
//   e-focused  a landing session's own address (/sessions/<T2's id>): the window scrolled to T2,
//              opened, its bubble outlined — taken the moment it is placed
//   f-phone    not a board frame: the window on a 390 px phone, scrolled up, the long names wrapping
// All data is made-up example data, every instant relative to the capture's frozen clock. Writes
// <theme>-<frame>.png and report.json.
//
// RUN: bash ./run.sh [outDir]
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const WT = process.env.WT ?? path.resolve(KIT, '../../../../..');
const DIST = process.env.DIST ?? '/tmp/lcb-web-shots/dist';
const OUT = process.argv[2] ?? `${KIT}/out`;
const PORT = 5898;
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

// The capture's frozen moment: 2026-11-02 10:20 in Asia/Shanghai, the board's 10:20.
const NOW = Date.parse('2026-11-02T02:20:00.000Z');
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const ago = (ms) => new Date(NOW - ms).toISOString();
/** A local (Asia/Shanghai) clock time on the capture's day, or `days` before it. */
const local = (hour, minute, second = 0, days = 0) =>
  new Date(Date.UTC(2026, 10, 2 - days, hour - 8, minute, second)).toISOString();
const yesterday = (hour, minute, second = 0) => local(hour, minute, second, 1);
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
const PROJECT_TITLE = 'install.sh on multi-user machines';
const BRANCH = 'project/34qA6WJMbY7fxSXILV3ht';
const RUNNER = 'workstation-gpu';
const sid = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const ID = {
  t1: sid(801), m1: sid(802), t2: sid(803), m2: sid(804), t4: sid(805), m4: sid(806), t3: sid(807), m3: sid(808),
  t5: sid(809), t6: sid(810), source3: sid(811), source5: sid(812), source6: sid(813),
};
const TASK = {
  t1: 'T1 install.sh: keep one orbit binary per account',
  t2: 'T2 host setup refuses a binary it did not install',
  t4: 'T4 install.sh under sudo writes the unit file once',
  t3: 'T3 sudo hints name the binary’s real path',
  t5: 'T5 orbit doctor reports the runner’s own binary',
  t6: 'T6 upgrade keeps each account’s service running',
};

const membership = (role) => ({ projectId: PROJECT, projectTitle: PROJECT_TITLE, projectStatus: 'OPEN', role });
const coordinator = {
  ...SESSION, title: PROJECT_TITLE, projectId: PROJECT, projectTitle: PROJECT_TITLE,
  projectMembership: membership('COORDINATOR'), status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
  runStatus: 'AWAITING_INPUT', lastAssistantText: 'Fixing T5’s check; watching T6 land',
  lastTurnAt: ago(2 * MIN), updatedAt: ago(2 * MIN),
};
const member = (id, title, minutes) => ({
  ...SESSION, id, title, projectId: PROJECT, projectTitle: PROJECT_TITLE, projectMembership: membership('TASK'),
  status: 'SUCCEEDED', runState: 'SUCCEEDED', lastAssistantText: `Recap · ${title} is on its branch`,
  lastTurnAt: ago(minutes * MIN), updatedAt: ago(minutes * MIN),
});
const MEMBERS = [coordinator, member(ID.source6, TASK.t6, 9), member(ID.source5, TASK.t5, 25)];

// The landings: (id, task or round title, subject, settledAs, settledAt, openedAt). Each task landed
// on the project line, then its round merged into main a minute or few later.
const ROUND = (n) => `Merge ${BRANCH} → main · #${n}`;
const SETTLED = [
  [ID.t1, `Land · ${TASK.t1}`, 'TASK', 'LANDED', yesterday(22, 11, 5), yesterday(21, 58)],
  [ID.m1, ROUND(1), 'PROMOTION', 'MERGED', yesterday(22, 13, 20), yesterday(22, 11, 30)],
  [ID.t2, `Land · ${TASK.t2}`, 'TASK', 'LANDED', yesterday(23, 7, 10), yesterday(22, 56)],
  [ID.m2, ROUND(2), 'PROMOTION', 'MERGED', yesterday(23, 9, 30), yesterday(23, 7, 40)],
  [ID.t4, `Land · ${TASK.t4}`, 'TASK', 'LANDED', yesterday(23, 25, 10), yesterday(23, 13)],
  [ID.m4, ROUND(3), 'PROMOTION', 'MERGED', yesterday(23, 29, 30), yesterday(23, 25, 40)],
  [ID.t3, `Land · ${TASK.t3}`, 'TASK', 'LANDED', local(0, 19, 5), local(0, 10)],
  [ID.m3, ROUND(4), 'PROMOTION', 'MERGED', local(0, 19, 40), local(0, 19, 20)],
];
const OPEN = [
  [ID.t5, `Land · ${TASK.t5}`, 'AWAITING_DECISION', local(9, 58)],
  [ID.t6, `Land · ${TASK.t6}`, 'IN_FLIGHT', local(10, 13)],
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
  step: null, claim: 1, runnerName: RUNNER, sourceSessionId: ID.source3, targetRef: `refs/heads/${BRANCH}`,
  startedAt: ago(HOUR), heartbeatAt: ago(HOUR), outputMovedAt: ago(HOUR), progressProtocol: 'v2', check: null,
  liveness: null, blockingReason: null, timedOut: false, limitSeconds: 600, retryable: false,
  pushBoundaryPassed: true, ...o });
const view = (id, o) => ({ sessionId: id, projectId: PROJECT, subject: 'TASK', taskId: `task-${id.slice(-4)}`,
  promotionId: null, episode: 1, openedAt: ago(HOUR), settledAt: null, settledAs: null, phase: 'CHECK', round: 1,
  checks: [], liveness: null, blockingReason: null, currentAttempt: null, todos: [], generations: [],
  timeline: { truncated: false, facts: [], sections: [] }, ...o });

function landingView(id) {
  const settled = SETTLED.find(([sid]) => sid === id);
  if (settled) {
    const [, , subject, settledAs, settledAt, openedAt] = settled;
    if (subject === 'PROMOTION') {
      const n = [ID.m1, ID.m2, ID.m4, ID.m3].indexOf(id) + 1;
      return view(id, { subject, taskId: null, promotionId: `promo-${n}`, episode: n, openedAt, settledAt, settledAs,
        currentAttempt: attempt({ jobId: `job-m${n}`, kind: 'LAND_PROMOTION', state: 'MERGED' }),
        checks: [{ name: 'MERGE_CHECK', ...PASSED, durationMs: 1 * MIN + 12 * SEC }],
        timeline: { truncated: false, facts: [{ kind: 'PROMOTION_STATE', text: 'Merge round · merged', data: null }], sections: [
          { title: 'Merge check · 1', jobId: `job-c${n}`, kind: 'CHECK_PROMOTION', generation: 1, state: 'READY', entries: [
            entry('CHECK_STARTED', 'Merge check started on the combined tree', openedAt, { round: 1, check: MERGE_CHECK }),
            entry('CHECK_FINISHED', 'Merge check passed · 1m 12s', plus(openedAt, 1.2), { round: 1, check: MERGE_CHECK, data: PASSED }),
          ] },
          { title: 'Merge to main · 1', jobId: `job-m${n}`, kind: 'LAND_PROMOTION', generation: 1, state: 'MERGED', entries: [
            entry('CLAIMED', `Claimed by runner ${RUNNER} · claim 1`, plus(openedAt, 1.3)),
            entry('RESULT', 'Landed on main', settledAt, { data: { state: 'LANDED' } }),
          ] },
        ] } });
    }
    if (id === ID.t3) {
      // Board 03 e: the record a task's bubble opens to.
      return view(id, { openedAt, settledAt, settledAs, currentAttempt: attempt({ jobId: 'job-t3', state: 'LANDED' }),
        timeline: { truncated: false, facts: [], sections: [
          { title: 'Generation 1', jobId: 'job-t3', kind: 'LAND_TASK', generation: 1, state: 'LANDED', entries: [
            entry('ENQUEUED', `Task marked done · queued to land on ${BRANCH}`, openedAt),
            entry('CLAIMED', `Claimed by runner ${RUNNER} · claim 1`, local(0, 10, 20)),
            entry('CHECK_STARTED', `Merge check started · claim 1 · ${RUNNER}`, local(0, 10, 24), { round: 1, check: MERGE_CHECK }),
            entry('CHECK_FINISHED', 'Merge check passed · 8m 41s', local(0, 19, 5), { round: 1, check: MERGE_CHECK, data: PASSED }),
            entry('RESULT', `Landed on ${BRANCH} · 4b1d0e2`, settledAt, { data: { state: 'LANDED' } }),
          ] },
        ] } });
    }
    return view(id, { openedAt, settledAt, settledAs, currentAttempt: attempt({ jobId: `job-${id.slice(-4)}`, state: settledAs }),
      timeline: { truncated: false, facts: [], sections: [
        { title: 'Generation 1', jobId: `job-${id.slice(-4)}`, kind: 'LAND_TASK', generation: 1, state: settledAs, entries: [
          entry('ENQUEUED', `Task marked done · queued to land on ${BRANCH}`, openedAt),
          entry('CLAIMED', `Claimed by runner ${RUNNER} · claim 1`, plus(openedAt, 0.5)),
          entry('CHECK_FINISHED', 'Merge check passed · 9m 02s', plus(settledAt, -0.2), { round: 1, check: MERGE_CHECK, data: PASSED }),
          entry('RESULT', `Landed on ${BRANCH} · 7a90c3e`, settledAt, { data: { state: settledAs } }),
        ] },
      ] } });
  }
  if (id === ID.t5) {
    const openedAt = local(9, 58);
    return view(id, { openedAt, currentAttempt: attempt({ jobId: 'job-t5', state: 'CHECK_FAILED', pushBoundaryPassed: false,
      sourceSessionId: ID.source5, startedAt: plus(openedAt, 1) }),
      checks: [{ name: 'MERGE_CHECK', exitCode: 1, expectedExitCode: 0, timedOut: false, durationMs: 3 * MIN + 52 * SEC }],
      timeline: { truncated: false, facts: [], sections: [
        { title: 'Generation 1', jobId: 'job-t5', kind: 'LAND_TASK', generation: 1, state: 'CHECK_FAILED', entries: [
          entry('ENQUEUED', `Task marked done · queued to land on ${BRANCH}`, openedAt),
          entry('CLAIMED', `Claimed by runner ${RUNNER} · claim 1`, plus(openedAt, 1)),
          entry('CHECK_FINISHED', 'Merge check failed · exit 1 after 3m 52s', plus(openedAt, 5), { round: 1, check: MERGE_CHECK,
            data: { exitCode: 1, expectedExitCode: 0, timedOut: false } }),
          entry('RESULT', 'Check failed · nothing was pushed', plus(openedAt, 5), { data: { state: 'CHECK_FAILED' } }),
          entry('HANDED_TO', 'Asked the coordinator to fix it', plus(openedAt, 5), { actor: 'PLATFORM' }),
        ] },
      ] } });
  }
  if (id === ID.t6) {
    const checkStart = ago(6 * MIN + 12 * SEC);
    return view(id, { openedAt: local(10, 13), liveness: 'LIVE', currentAttempt: attempt({ jobId: 'job-t6', state: 'RUNNING',
      pushBoundaryPassed: false, sourceSessionId: ID.source6, startedAt: local(10, 13), heartbeatAt: ago(1 * SEC),
      outputMovedAt: ago(2 * SEC), check: { name: 'MERGE_CHECK', index: 1, count: 1, budgetSeconds: 1_800, startedAt: checkStart },
      liveness: 'LIVE' }),
      timeline: { truncated: false, facts: [], sections: [
        { title: 'Generation 1', jobId: 'job-t6', kind: 'LAND_TASK', generation: 1, state: 'RUNNING', entries: [
          entry('ENQUEUED', `Task marked done · queued to land on ${BRANCH}`, local(10, 13)),
          entry('CLAIMED', `Claimed by runner ${RUNNER} · claim 1`, local(10, 13, 30)),
          entry('CHECK_STARTED', 'Merge check started on the combined tree', checkStart, { round: 1, check: MERGE_CHECK }),
        ] },
      ] } });
  }
  return null;
}

const merged = (promotionId, at, landingSessionId, tasks, sha) => ({
  promotionId, state: 'MERGED', sourceKind: 'PROJECT_BRANCH', sourceRef: `refs/heads/${BRANCH}`, sourceSha: 'a'.repeat(40),
  upstreamRef: 'refs/heads/main', commitsAhead: tasks.length, filesChanged: 4,
  tasks: tasks.map((title, i) => ({ taskId: `t${i}`, title })), taskIds: tasks.map((_, i) => `t${i}`),
  checks: [{ name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false, durationMs: 1 * MIN + 12 * SEC }],
  conflicts: [], blockedReason: null, upstreamShaChecked: 'b'.repeat(40), landsTreeSha: '5e5bfca' + '0'.repeat(33),
  landsAs: 'MERGE_COMMIT', askedAt: null, upstream: { syncedAt: null, conflicts: false }, recheckedAt: null, recheck: null,
  decidedAt: null, onPass: null, landingSessionId,
  merged: { sha: sha + '0'.repeat(33), at, automatic: true, byUserId: null, revert: null },
});
const MERGES = [
  merged('promo-4', local(0, 19, 40), ID.m3, [TASK.t3], '91fd6b2'),
  merged('promo-3', yesterday(23, 29, 30), ID.m4, [TASK.t4], 'e05a8c3'),
  merged('promo-2', yesterday(23, 9, 30), ID.m2, [TASK.t2], 'b74d2f1'),
  merged('promo-1', yesterday(22, 13, 20), ID.m1, [TASK.t1], '3c1e9a0'),
];
const liveJob = {
  jobId: 'job-t6', kind: 'LAND_TASK', state: 'RUNNING', phase: 'CHECK', taskId: 'task-t6', taskTitle: TASK.t6,
  generation: 1, startedAt: local(10, 13), queuedAt: local(10, 13), heartbeatAt: ago(1 * SEC), runnerName: RUNNER,
  retriedBy: null, timedOut: false, limitSeconds: 600, retryable: false, landingSessionId: ID.t6, liveness: 'LIVE',
  claim: 1, round: 1, stepStartedAt: ago(6 * MIN + 12 * SEC), outputMovedAt: ago(2 * SEC), typicalMs: 9 * MIN,
  check: { name: 'MERGE_CHECK', index: 1, count: 1, budgetSeconds: 1_800, startedAt: ago(6 * MIN + 12 * SEC) },
};
const INTEGRATION = {
  line: 'PROJECT_BRANCH', lineAbsentReason: null, ref: BRANCH, upstreamRef: 'refs/heads/main', source: 'EXPLICIT',
  locked: true, startedAt: ago(28 * HOUR), mergeCheckCommand: 'npm test', mergeCheckCommandAbsentReason: null,
  mergeCheckTimeoutSeconds: 1_800, escalationSeconds: 3_600, commitsAheadOfUpstream: 0,
  commitsAheadOfUpstreamAbsentReason: null, lastUpstreamSyncAt: ago(3 * HOUR), lastUpstreamSyncAbsentReason: null,
  integratingCount: 1, queuedCount: 0, mergeCheckOnTip: 'PASSING', inFlight: liveJob, inFlightJobs: [liveJob],
  landTasks: [{ taskId: 'task-t6', taskTitle: TASK.t6, integration: { state: 'RUNNING', since: local(10, 13),
    handler: null, openItemId: null, jobId: 'job-t6', checksRunningForMs: null, landTask: { jobId: 'job-t6',
      state: 'RUNNING', phase: 'CHECK', generation: '1', queuedAt: local(10, 13), startedAt: local(10, 13),
      heartbeatAt: ago(1 * SEC), finishedAt: null, targetRef: `refs/heads/${BRANCH}`, waitMs: 20_000, blockingReason: null,
      landingSessionId: ID.t6 } } }],
};
const projectDoc = {
  id: PROJECT, title: PROJECT_TITLE, status: 'OPEN', createdAt: '2026-10-28T00:00:00.000Z', lastActivityAt: ago(2 * MIN),
  mainBranch: 'main', buckets: { running: 1, ready: 0, blocked: 0, awaitingVerification: 0, done: 4, failed: 1, cancelled: 0 },
  taskCounts: { done: 4, failed: 1, total: 6 },
  attention: { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, ownerItems: [], coordinatorItems: null, startRequest: null },
  coordinatorActivity: { working: false, lastTurnAt: ago(2 * MIN) }, startedAt: ago(5 * 24 * HOUR),
};

const windowPath = `/projects/${PROJECT}/landings?project=${PROJECT}`;
const FRAMES = {
  'a-bottom': { path: windowPath, wait: '.landings-window-now' },
  'b-history': { path: windowPath, wait: '.landings-window-now', scrollUp: true },
  'c-open': { path: windowPath, wait: '.landings-window-now', open: ID.t3 },
  'd-menu': { path: windowPath, wait: '.landings-window-now', menuOn: ID.t3 },
  'e-focused': { path: `/sessions/${ID.t2}?project=${PROJECT}`, wait: '.landings-window-entry.is-outlined', fast: true },
  // Not a board frame: the same window on a phone, scrolled up — long names wrap in their bubbles.
  'f-phone': { path: windowPath, wait: '.landings-window-now', scrollUp: true, viewport: { width: 390, height: 844 } },
};

const THEMES = (process.env.THEMES || 'light,dark').split(',');
const ONLY = (process.env.FRAMES_ONLY ?? '').split(',').filter(Boolean);
const browser = await chromium.launch();
const report = [];
for (const theme of THEMES) {
  for (const [name, frame] of Object.entries(FRAMES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const page = await browser.newPage({ viewport: frame.viewport ?? { width: 1440, height: 1000 }, deviceScaleFactor: 2,
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
          return json({ jobId: 'job-t5', nextCursor: null, entries: [{ jobId: 'job-t5', claim: 1, round: 1, check: MERGE_CHECK, seq: 0,
            truncatedBytes: 0, at: local(10, 3), text: '$ go test ./cmd/orbit/...\n--- FAIL: TestDoctorReportsTheRunnersOwnBinary (0.42s)\n    doctor_test.go:88: binary: got /usr/local/bin/orbit, want ~/.orbit/bin/orbit\nFAIL\nexit status 1\n' }] });
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
    if (frame.scrollUp) {
      // A reader's wheel, so the window lets go of its bottom as it does for one.
      const body = page.locator('.landings-window-body');
      await body.hover();
      await page.mouse.wheel(0, -4_000);
      await page.waitForTimeout(600);
      // Then off the bubbles, so none of them shows its hover ⋯.
      await page.locator('.landings-window .landing-page-title').hover();
      await page.waitForTimeout(300);
    }
    if (frame.open) {
      const bubble = page.locator(`[data-landing-entry="${frame.open}"] .landings-window-row`);
      await bubble.scrollIntoViewIfNeeded();
      await bubble.click();
      await page.waitForSelector(`[data-landing-entry="${frame.open}"] .landing-timeline`, { timeout: 10_000 });
      await page.waitForTimeout(700);
      await page.locator(`[data-landing-entry="${frame.open}"]`).evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(300);
    }
    if (frame.menuOn) {
      const bubble = page.locator(`[data-landing-entry="${frame.menuOn}"] .landings-window-row`);
      await bubble.scrollIntoViewIfNeeded();
      await bubble.hover();
      await page.locator(`[data-landing-entry="${frame.menuOn}"] .landings-window-more`).click();
      await page.waitForSelector('[role="menuitem"]:has-text("Open Task")', { timeout: 10_000 });
      await page.waitForTimeout(500);
    }
    const file = `${OUT}/${theme}-${name}.png`;
    await page.screenshot({ path: file, animations: 'disabled' });
    const drawn = await page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const look = (el) => {
        const s = getComputedStyle(el);
        return { radius: s.borderTopLeftRadius, border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
          background: s.backgroundColor, shadow: s.boxShadow };
      };
      // What the conversation's composer card and a person's ⊕ note panel are drawn with, out of the
      // same built stylesheet, to hold the footer and the record panel to.
      const composer = document.createElement('div');
      composer.className = 'composer-box';
      const wrap = document.createElement('div');
      wrap.className = 'chat-user-wrap';
      const note = document.createElement('div');
      note.className = 'chat-injected-panel';
      wrap.append(note);
      document.body.append(composer, wrap);
      const composerLook = look(composer);
      const noteLook = look(note);
      composer.remove();
      wrap.remove();
      const foot = document.querySelector('.landings-window .landing-page-foot');
      const record = document.querySelector('.landings-window-entry:not(.is-card) .landings-window-record');
      const outlinedBubble = document.querySelector('.landings-window-entry.is-outlined .landings-window-row');
      return {
        windowTitle: document.querySelector('.landings-window .landing-page-title')?.textContent ?? null,
        windowSub: document.querySelector('.landings-window .landing-page-sub')?.textContent ?? null,
        days: [...document.querySelectorAll('.landings-window-day')].map((day) => {
          const chip = day.querySelector('.landings-window-day-head');
          const chipStyle = getComputedStyle(chip);
          return {
            chip: chip.textContent,
            chipLook: { color: chipStyle.color, background: chipStyle.backgroundColor, radius: chipStyle.borderTopLeftRadius,
              centered: Math.abs((box(chip).x + box(chip).w / 2) - (box(day).x + box(day).w / 2)) <= 1 },
            groups: [...day.querySelectorAll(':scope > .landings-window-group')].map((group) => ({
              avatars: group.querySelectorAll('.landings-window-avatar').length,
              avatar: box(group.querySelector('.landings-window-avatar')),
              entries: [...group.querySelectorAll('[data-landing-entry]')].map((entry) => {
                const bubble = entry.querySelector('.landings-window-row');
                const words = entry.querySelector('.landings-window-row-text, .landings-window-card-task');
                const column = entry.closest('.landings-window-column');
                return {
                  id: entry.getAttribute('data-landing-entry'),
                  words: words?.textContent ?? null,
                  foot: entry.querySelector('.landings-window-row-foot')?.textContent ?? null,
                  // A cut-short title would be wider than the box it is drawn in.
                  cut: words ? words.scrollWidth > words.clientWidth + 1 : null,
                  bubble: bubble ? box(bubble) : null,
                  gutter: bubble ? Math.round(box(column).x + box(column).w - (box(bubble).x + box(bubble).w)) : null,
                };
              }),
            })),
          };
        }),
        outlined: [...document.querySelectorAll('.landings-window-entry.is-outlined')].map((entry) => entry.getAttribute('data-landing-entry')),
        outlinedBubbleShadow: outlinedBubble ? getComputedStyle(outlinedBubble).boxShadow : null,
        open: [...document.querySelectorAll('.landings-window-entry.is-open')].map((entry) => entry.getAttribute('data-landing-entry')),
        record: record ? { text: record.textContent.slice(0, 400), look: look(record), noteLook,
          sameFillAsNote: look(record).background === noteLook.background,
          width: box(record).w, columnWidth: box(record.closest('.landings-window-column')).w } : null,
        menu: [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
        footer: foot ? {
          line: foot.querySelector('.landing-page-foot-line')?.textContent ?? null,
          bar: foot.querySelector('.landing-page-foot-bar')?.textContent ?? null,
          door: foot.querySelector('.landing-page-foot-open')?.textContent ?? null,
          inputs: foot.querySelectorAll('input, textarea, [contenteditable]').length,
          look: look(foot), composerLook,
          sameLookAsComposer: JSON.stringify(look(foot)) === JSON.stringify(composerLook),
        } : null,
        composer: !!document.querySelector('.workspace-composer textarea'),
        bodyScroll: (() => {
          const body = document.querySelector('.landings-window-body');
          return body ? { top: Math.round(body.scrollTop), height: body.scrollHeight, client: body.clientHeight } : null;
        })(),
        url: location.pathname + location.search,
      };
    });
    report.push({ theme, frame: name, placed, errors, unhandled: fixtures.unhandled, ...drawn });
    console.log(theme, name, JSON.stringify({ placed, errors: errors.map((e) => e.slice(0, 200)), unhandled: fixtures.unhandled }));
    await page.close();
  }
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
server.close();
