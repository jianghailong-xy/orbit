// Landing entries on the web console (task 34bVVGk4SrMknliGplqbJ): the BUILT console (dist/),
// the repo's ui-migration REST fixtures for the shell and sign-in, and this project's own reads
// overridden per frame — the frames docs/mocks/landing-session/v4/04 and 06 draw, the way the
// board asks for them (owner 2026-10-19, 方案 A).
//
// RUN (the dist is built from the session worktree first):
//   cd <wt>/src/web && npx vite build --outDir /var/tmp/le-shots/dist --emptyOutDir
//   FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf \
//     unshare -n bash -c 'ip link set lo up && cd <kit> && WT=<wt> node capture.mjs <outDir>'
//
// Writes <theme>-<frame>.png per frame plus report.json: what each frame drew (the entries' own
// words and hrefs) and every fixture call the console left unhandled.
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const WT = process.env.WT ?? '/root/.orbit/worktrees/b163147e-7ec9-5b5b-901c-c1f57a3c1b0d';
const DIST = process.env.DIST ?? '/var/tmp/le-shots/dist';
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

// 2026-10-19 15:02 Asia/Shanghai — the board's 06 c moment (the clock the X-E5 card was opened on).
const NOW = Date.parse('2026-10-19T07:02:00.000Z');
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const ago = (ms) => new Date(NOW - ms).toISOString();
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
const sid = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const PROJECT_TITLE = 'Wiki 服务端执行与 System model';
const BRANCH = 'project/34bmzOkov3xN2yLPrnsCk';
const TASK = '维护每日轮数上限在服务端路径上没生效：byJob 计数恒为 0（SQL 三值逻辑；10-10 跑了 13 轮，上限 8）';
const TASK_2 = '维护：同一会话跨页时，dossier 在一轮里被重复发出（计数虚高；会话中途有新记录时整轮会失败）';
const TASK_3 = 'P10 · 本部署切换到服务端执行';
const RUNNER = 'workstation-gpu';
const LANDING_A = sid(501);
const LANDING_ROUND = sid(502);
const LANDING_FAILED = sid(503);
// The task the frames are about: a real public id, because every link to it is built with `encodeId`.
const TASK_ID = sid(601);

const coordinator = {
  ...SESSION, title: PROJECT_TITLE, projectId: PROJECT, projectTitle: PROJECT_TITLE,
  projectMembership: { projectId: PROJECT, projectTitle: PROJECT_TITLE, projectStatus: 'OPEN', role: 'COORDINATOR' },
  status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT',
  lastTurnAt: ago(60 * SEC), updatedAt: ago(60 * SEC),
};
const member = (id, title, over = {}) => ({
  ...SESSION, id, title, projectId: PROJECT, projectTitle: PROJECT_TITLE,
  projectMembership: { projectId: PROJECT, projectTitle: PROJECT_TITLE, projectStatus: 'OPEN', role: 'TASK' },
  lastTurnAt: ago(20 * MIN), updatedAt: ago(20 * MIN), ...over,
});
const TASK_SESSION = member(uuidToBase62('0196e000-0000-7000-8000-000000000113'), `执行任务：${TASK}`);
const landingSession = (id, title, landing, over = {}) => ({
  ...SESSION, id, title, projectId: PROJECT, projectTitle: PROJECT_TITLE,
  projectMembership: { projectId: PROJECT, projectTitle: PROJECT_TITLE, projectStatus: 'OPEN', role: 'TASK' },
  sessionKind: 'LANDING', landing, lifecycleState: 'OPEN', status: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT', lastTurnAt: null, createdAt: ago(13 * MIN), ...over,
});

// ── The reads the sessions page draws ────────────────────────────────────────────────────────────
const job = (o) => ({
  jobId: 'job-1', kind: 'LAND_TASK', state: 'RUNNING', phase: 'CHECK', taskId: TASK_ID, taskTitle: TASK,
  generation: 1, startedAt: ago(3 * MIN + 12 * SEC), queuedAt: ago(4 * MIN), heartbeatAt: ago(2 * SEC),
  runnerName: RUNNER, retriedBy: null, timedOut: false, limitSeconds: 4_200, retryable: false,
  landingSessionId: LANDING_A, liveness: 'LIVE', claim: 1, round: 1, stepStartedAt: ago(2 * MIN + 40 * SEC),
  outputMovedAt: ago(1 * SEC), typicalMs: 18 * MIN, ...o,
});
const mergeJob = (o) => job({
  jobId: 'job-merge', kind: 'LAND_PROMOTION', phase: null, state: 'QUEUED', taskId: null, taskTitle: null,
  startedAt: ago(41 * MIN), queuedAt: ago(41 * MIN), heartbeatAt: null, runnerName: null,
  landingSessionId: LANDING_ROUND, liveness: null, claim: 0, round: null, stepStartedAt: null,
  outputMovedAt: null, typicalMs: null, ...o,
});
const checkJob = (o) => job({
  jobId: 'job-check', kind: 'CHECK_PROMOTION', phase: 'CHECK', state: 'RUNNING', taskId: null, taskTitle: null,
  startedAt: ago(2 * MIN + 40 * SEC), queuedAt: ago(3 * MIN), landingSessionId: LANDING_ROUND,
  stepStartedAt: ago(2 * MIN + 40 * SEC), ...o,
});
const integration = (jobs, over = {}) => ({
  line: 'PROJECT_BRANCH', lineAbsentReason: null, ref: BRANCH, upstreamRef: 'refs/heads/main',
  source: 'EXPLICIT', locked: true, startedAt: ago(28 * HOUR),
  mergeCheckCommand: 'npm test', mergeCheckCommandAbsentReason: null, mergeCheckTimeoutSeconds: 4_200,
  escalationSeconds: 3_600, commitsAheadOfUpstream: 2, commitsAheadOfUpstreamAbsentReason: null,
  lastUpstreamSyncAt: ago(3 * HOUR), lastUpstreamSyncAbsentReason: null,
  integratingCount: jobs.filter((j) => j.state === 'RUNNING').length,
  queuedCount: jobs.filter((j) => j.state === 'QUEUED').length,
  mergeCheckOnTip: 'PASSING', inFlight: jobs[0] ?? null, inFlightJobs: jobs,
  // The task a landing job lands, as `landTasks` serves it — the branch the card names under its
  // rows ("onto project/…").
  landTasks: jobs.filter((j) => j.taskId).slice(0, 1).map((j) => ({
    taskId: j.taskId, taskTitle: j.taskTitle,
    integration: { state: 'RUNNING', since: j.startedAt, handler: null, openItemId: null, jobId: j.jobId,
      checksRunningForMs: null,
      landTask: { jobId: j.jobId, state: 'RUNNING', phase: j.phase, generation: '1', queuedAt: j.queuedAt,
        startedAt: j.startedAt, heartbeatAt: j.heartbeatAt, finishedAt: null, targetRef: `refs/heads/${BRANCH}`,
        waitMs: 48_000, blockingReason: null } },
  })),
  ...over,
});
const promotion = (o) => ({
  promotionId: '3fFMHLbE7JTsr3vHFOzIDM', state: 'CHECKING', sourceKind: 'PROJECT_BRANCH',
  sourceRef: `refs/heads/${BRANCH}`, sourceSha: 'a'.repeat(40), upstreamRef: 'refs/heads/main',
  commitsAhead: 2, filesChanged: 3, tasks: [], taskIds: [], checks: [], conflicts: [], blockedReason: null,
  upstreamShaChecked: null, landsTreeSha: null, landsAs: null, askedAt: null,
  upstream: { syncedAt: null, conflicts: false }, recheckedAt: null, recheck: null,
  decidedAt: null, merged: null, onPass: 'MERGE', landingSessionId: LANDING_ROUND, ...o,
});
const landingSummary = (o) => ({ subject: 'TASK', state: 'SETTLED', settledAs: 'LANDED', settledAt: ago(HOUR), ...o });
const projectDoc = {
  id: PROJECT, title: PROJECT_TITLE, status: 'OPEN', createdAt: '2026-10-10T00:00:00.000Z',
  lastActivityAt: ago(2 * MIN),
  buckets: { running: 1, ready: 0, blocked: 0, awaitingVerification: 0, done: 44, failed: 0, cancelled: 0 },
  taskCounts: { done: 44, failed: 0, total: 46 },
  attention: { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, ownerItems: [], coordinatorItems: null, startRequest: null },
  coordinatorActivity: { working: false, lastTurnAt: ago(60 * SEC) },
};
const xe5 = {
  itemId: '6LeAsEExpIrEd00000001', kind: 'LANDING_LEASE_EXPIRED',
  title: 'No word from the runner: 维护每日轮数上限在服务端路径上没生效',
  detailLine: `No report from runner ${RUNNER} since ${new Date(Date.parse('2026-10-19T06:35:00Z')).toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
  assignee: 'OWNER', assigneeReason: 'ESCALATED', waitingSince: ago(2 * MIN), escalateAt: null,
  escalatedAt: ago(2 * MIN), taskId: TASK_ID, sessionId: null, landingSessionId: LANDING_A,
  integrationJobId: 'job-1', promotionId: null, fuseEpisodeId: null,
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  actions: ['ABANDON', 'OPEN_LANDING'], primaryAction: 'ABANDON',
  requiredAction: 'The runner stopped reporting; abandon this landing, or wait for the runner to come back.',
  question: null, facts: null,
  lease: { lastReportAt: ago(27 * MIN), jobKind: 'LAND_TASK', progressProtocol: 'v2', pushReported: false },
  chat: { canMessage: true, sessionId: SESSION.id, refusal: null },
};
const checksFailedItem = {
  ...xe5, itemId: '7CheCkFaIlEd000000001', kind: 'INTEGRATION_CHECK_FAILED',
  title: `Checks failed on the combined tree: ${TASK_3}`,
  detailLine: 'TASK_ACCEPTANCE exited 1 · nothing landed',
  assignee: 'COORDINATOR', assigneeReason: 'DEFAULT', waitingSince: ago(13 * MIN), escalateAt: ago(-102 * MIN),
  escalatedAt: null, landingSessionId: LANDING_FAILED, integrationJobId: null,
  actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'OPEN_LANDING'], primaryAction: 'OPEN_TASK_SESSION',
  requiredAction: 'Fix the branch, or run the landing again when the tree is clean.',
  facts: { task: { id: TASK_ID, title: TASK_3 }, targetRef: BRANCH, targetSha: 'b'.repeat(40), files: [],
    nothingLanded: true, check: { name: 'TASK_ACCEPTANCE', command: 'npm test', expectedExitCode: 0, exitCode: 1,
      timedOut: false, durationMs: 5 * MIN, outputTail: 'not ok 1 - task acceptance\n' }, branchUnchanged: true, errorCode: null, failure: null },
};
const deliveryCard = {
  itemId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d', kind: 'INTEGRATION_CHECK_FAILED',
  title: `Checks failed on the combined tree: ${TASK_3}`,
  task: { id: TASK_ID, title: TASK_3, sessionId: TASK_SESSION.id },
  files: [], targetRef: `refs/heads/${BRANCH}`, check: { name: 'TASK_ACCEPTANCE', exitCode: 1, expectedExitCode: 0 },
  errorCode: null, failure: null, actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY'],
  landing: { receipts: 0, state: 'NOT_KNOWN', upstream: 'main', integration: BRANCH },
  landingSessionId: LANDING_FAILED,
};
const deliveryEvent = {
  seq: 4, type: 'user', turnId: 'turn-1', ts: ago(18 * MIN),
  payload: { text: '【例外待办】Checks failed on the combined tree — task_get 34OEE9DwfWYjo3aRFuBgo.', openItemDelivery: deliveryCard },
};
const taskDetail = {
  id: TASK_ID, title: TASK_3, status: 'DONE',
  description: 'Land the server-side execution switch.', project: null,
  projectId: null, assignee: null, comments: [], sessions: [], labels: [], createdAt: ago(30 * HOUR),
  updatedAt: ago(20 * MIN), mainBranch: 'main',
  integration: {
    state: 'ON_INTEGRATION_LINE', since: ago(20 * MIN), handler: null, openItemId: null, jobId: 'job-1',
    checksRunningForMs: null,
    landTask: { jobId: 'job-1', state: 'CHECK_FAILED', phase: 'CHECK', generation: '1',
      queuedAt: ago(22 * MIN), startedAt: ago(20 * MIN), heartbeatAt: ago(18 * MIN), finishedAt: ago(17 * MIN),
      targetRef: `refs/heads/${BRANCH}`, waitMs: 48_000,
      blockingReason: { code: 'CHECK_FAILED', summary: 'Checks failed on the combined tree: Task acceptance exited 1 (expected 0)' },
      landingSessionId: LANDING_FAILED },
  },
};

// ── Frames ──────────────────────────────────────────────────────────────────────────────────────
const sessionsPath = `/sessions/${coordinator.id}?project=${PROJECT}`;
const groupRows = (extra = []) => [
  // The waiting landing is the one the project's open item is about (`checksFailedItem`): the row
  // and the card name the same landing session, which is how the group says who holds it.
  landingSession(LANDING_FAILED, `Land · ${TASK_3}`,
    landingSummary({ state: 'AWAITING_DECISION', settledAs: null, settledAt: null }), { createdAt: ago(13 * MIN) }),
  ...extra,
  landingSession(uuidToBase62('0196e000-0000-7000-8000-000000000202'), `Land · ${TASK}`,
    landingSummary({ settledAs: 'LANDED', settledAt: ago(HOUR) }), { createdAt: ago(3 * HOUR) }),
  landingSession(uuidToBase62('0196e000-0000-7000-8000-000000000203'), `Merge ${BRANCH} → main · #8`,
    landingSummary({ subject: 'PROMOTION', settledAs: 'MERGED', settledAt: ago(HOUR) }), { createdAt: ago(3 * HOUR) }),
  landingSession(uuidToBase62('0196e000-0000-7000-8000-000000000204'), `Land · ${TASK_2}`,
    landingSummary({ settledAs: 'NOTHING_TO_LAND', settledAt: ago(2 * HOUR) }), { createdAt: ago(5 * HOUR) }),
];
const oldSettled = [1, 2, 3, 4, 5, 6].map((n) => landingSession(
  uuidToBase62(`0196e000-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`),
  `Land · earlier ${n}`, landingSummary({ settledAs: n > 5 ? 'NOTHING_TO_LAND' : 'LANDED', settledAt: ago(30 * HOUR + n * MIN) }),
));

const FRAMES = {
  // 04 b1/b2 — the Landing card, one job and several: each job's own Open landing, the merge row's
  // word and no link, and the card's press still opening the jobs list.
  'landing-card-one': {
    path: sessionsPath, clip: '.session-col',
    sessions: [coordinator, TASK_SESSION], jobs: [job({ landingSessionId: LANDING_A })],
    promotion: null, items: { needsYou: [], withCoordinator: [] },
  },
  'landing-card-many': {
    path: sessionsPath, clip: '.session-col',
    sessions: [coordinator, TASK_SESSION],
    jobs: [job({ landingSessionId: LANDING_A }), mergeJob({ landingSessionId: LANDING_ROUND })],
    promotion: null, items: { needsYou: [], withCoordinator: [] },
  },
  // 04 a2 — the jobs list: a row each, with its own Open landing (the merge row's only way in).
  'jobs-sheet': {
    path: sessionsPath, clip: '.workspace-view', openSheet: true, viewport: true,
    sessions: [coordinator, TASK_SESSION],
    jobs: [job({ landingSessionId: LANDING_A }), mergeJob({ landingSessionId: LANDING_ROUND })],
    promotion: null, items: { needsYou: [], withCoordinator: [] },
  },
  // 04 b4 — the merge check's row opens this round's landing; +N job queued · All jobs › beneath.
  'merge-check': {
    path: sessionsPath, clip: '.session-col',
    sessions: [coordinator, TASK_SESSION], jobs: [checkJob(), job({ landingSessionId: LANDING_A })],
    promotion: promotion({ landingSessionId: LANDING_ROUND }), items: { needsYou: [], withCoordinator: [] },
  },
  // 04 c2/c3 — the confirmed merge (Open landing beside Details) and the cancelling shape.
  'merge-confirmed': {
    path: sessionsPath, clip: '.session-col',
    sessions: [coordinator, TASK_SESSION], jobs: [mergeJob({ state: 'QUEUED' })],
    promotion: promotion({ state: 'CONFIRMED', execution: { state: 'QUEUED', phase: null, startedAt: ago(MIN) } }),
    items: { needsYou: [], withCoordinator: [] },
  },
  'merge-cancelling': {
    path: sessionsPath, clip: '.session-col',
    sessions: [coordinator, TASK_SESSION], jobs: [mergeJob({ state: 'RUNNING', phase: 'CHECK', runnerName: RUNNER,
      heartbeatAt: ago(5 * SEC), startedAt: ago(4 * MIN), claim: 1, round: 1, stepStartedAt: ago(4 * MIN), liveness: 'LIVE' })],
    promotion: promotion({ state: 'CONFIRMED', cancelRequested: true,
      execution: { state: 'RUNNING', phase: 'CHECK', startedAt: ago(4 * MIN) } }),
    items: { needsYou: [], withCoordinator: [] },
  },
  // 04 c5/c6 — the two timed-out rounds: Re-run the check + Abandon, and Abandon alone.
  'merge-check-timeout': {
    path: sessionsPath, clip: '.session-col',
    sessions: [coordinator, TASK_SESSION],
    jobs: [checkJob({ timedOut: true, liveness: 'LEASE_EXPIRED', heartbeatAt: ago(110 * MIN), startedAt: ago(113 * MIN), retryable: false })],
    promotion: promotion({ landingSessionId: LANDING_ROUND }), items: { needsYou: [], withCoordinator: [] },
  },
  'merge-timed-out': {
    path: sessionsPath, clip: '.session-col',
    sessions: [coordinator, TASK_SESSION],
    jobs: [mergeJob({ state: 'RUNNING', phase: 'PUSH', runnerName: RUNNER, claim: 1, round: 1,
      startedAt: ago(30 * MIN), heartbeatAt: ago(23 * MIN), stepStartedAt: ago(23 * MIN), liveness: 'LEASE_EXPIRED',
      timedOut: true, limitSeconds: 600 })],
    promotion: promotion({ state: 'CONFIRMED', pushBoundaryPassed: true,
      execution: { state: 'RUNNING', phase: 'PUSH', startedAt: ago(30 * MIN) } }),
    items: { needsYou: [], withCoordinator: [] },
  },
  // 04 c1 — the Landings group: waiting, the day's outcomes, the fold.
  'landings-group': {
    path: sessionsPath, clip: '.session-col',
    sessions: [coordinator, TASK_SESSION, ...groupRows(oldSettled)],
    jobs: [], promotion: null,
    items: { needsYou: [], withCoordinator: [checksFailedItem] },
  },
  // 06 c — the X-E5 card in the coordinator conversation: its heading, Abandon leading, Open landing.
  'chat-xe5': {
    path: sessionsPath, clip: '.workspace-main',
    sessions: [coordinator, TASK_SESSION], jobs: [], promotion: null,
    items: { needsYou: [xe5], withCoordinator: [] },
  },
  // 06 b — a delivery card, with Open the landing ↗ after the two main had.
  'chat-delivery': {
    path: sessionsPath, clip: '.workspace-main',
    sessions: [coordinator, TASK_SESSION], jobs: [], promotion: null,
    items: { needsYou: [], withCoordinator: [] }, events: [deliveryEvent],
  },
  // 06 e — a source work session's derived landing label at its bottom.
  'source-session': {
    path: `/sessions/${TASK_SESSION.id}`, clip: '.workspace-view',
    sessions: [coordinator, TASK_SESSION], jobs: [], promotion: null,
    items: { needsYou: [], withCoordinator: [] },
    events: [
      { seq: 1, type: 'user', turnId: 'turn-1', ts: ago(24 * MIN),
        payload: { text: '维护每日轮数上限：byJob 计数恒为 0，查一下每日轮数上限在服务端路径上为什么没生效。' } },
      { seq: 2, type: 'assistant', turnId: 'turn-1', ts: ago(21 * MIN),
        payload: { text: '原因是 SQL 三值逻辑：`job_id = NULL` 永远不成立，byJob 一直数到 0。改成 `IS NOT DISTINCT FROM`，10-10 的 13 轮在新查询下是 8 轮；补了 NULL 的单测，已提交 `b71c0e4`，任务标记完成。' } },
      { seq: 3, type: 'turn_end', turnId: 'turn-1', ts: ago(20 * MIN), payload: {} },
    ],
    sourceLanding: { landingSessionId: LANDING_A, subject: 'TASK', state: 'RUNNING', phase: 'CHECK',
      settledAs: null, targetRef: `refs/heads/${BRANCH}` },
  },
  // 06 d — the task page's Landing section, with its one Open landing link.
  'task-page': {
    path: `/tasks/${taskDetail.id}`, clip: '.tdp-panel, .tdp-body, body',
    sessions: [coordinator, TASK_SESSION], jobs: [], promotion: null,
    items: { needsYou: [], withCoordinator: [] },
  },
};

const ONLY = (process.env.FRAMES_ONLY ?? '').split(',').filter(Boolean);
const THEMES = (process.env.THEMES ?? 'light,dark').split(',');
const browser = await chromium.launch();
const report = [];
for (const theme of THEMES) {
  for (const [name, frame] of Object.entries(FRAMES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const page = await browser.newPage({ viewport: { width: 1440, height: 1280 }, deviceScaleFactor: 2,
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
      if (p === '/api/sessions') {
        const view = url.searchParams.get('view');
        return json(view === 'completed' ? [] : frame.sessions);
      }
      if (p === `/api/projects/${PROJECT}/integration`) return json(integration(frame.jobs));
      if (p === `/api/projects/${PROJECT}/promotions/current`) return json(frame.promotion);
      if (p === `/api/projects/${PROJECT}/promotions/merged`) return json([]);
      if (p === `/api/projects/${PROJECT}/open-items`) {
        return json({ ...frame.items, startRequest: null, readAt: new Date(NOW).toISOString() });
      }
      if (p === `/api/projects/${PROJECT}/coordinator/status`) {
        return json({ coordination: { sessionId: coordinator.id, workspaceId: SESSION.workspaceId }, readAt: new Date(NOW).toISOString() });
      }
      if (p.startsWith(`/api/projects/${PROJECT}/acceptance/criteria-decisions/pending`)) {
        return json({ projectId: PROJECT, readAt: new Date(NOW).toISOString(), count: 0, oldestAgeSeconds: null,
          decidableCount: 0, pending: [], settled: [] });
      }
      if (p === `/api/projects/${PROJECT}/acceptance/confirmation`) return json(null);
      if (p === `/api/projects/${PROJECT}/panorama`) {
        return json({ buckets: { running: 1, ready: 0, blocked: 0, awaitingVerification: 0, done: 44, failed: 0, cancelled: 0 },
          shape: { taskCount: 46, edgeCount: 20, ratio: 20 / 46, maxDepth: 6, form: 'chain' } });
      }
      if (p === `/api/sessions/${coordinator.id}`) return json(coordinator);
      if (p === `/api/sessions/${TASK_SESSION.id}`) {
        return json({ ...TASK_SESSION, sourceLanding: frame.sourceLanding ?? null });
      }
      if (p.endsWith('/events/page')) {
        return json({ events: frame.events ?? [], hasMore: false, ...(url.searchParams.get('after') ? { hasMore: false } : {}) });
      }
      if (p === `/api/tasks/${taskDetail.id}`) return json(taskDetail);
      // The session detail's own reads. Each answers its REAL shape: an empty array where the page
      // expects an object (or a list where it expects a payload) is a crash, not an empty state.
      if (p.endsWith('/approvals')) return json([]);
      if (p.endsWith('/turns')) return json([]);
      if (p.endsWith('/background')) return json([]);
      if (p.endsWith('/created-tasks')) return json({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      if (p.startsWith('/api/sessions/') && p.endsWith('/diff')) return json({ files: [] });
      if (p.startsWith(`/api/sessions/${coordinator.id}/`)) return json([]);
      return route.fallback();
    });
    await page.goto(`http://127.0.0.1:${PORT}${frame.path}`);
    try {
      await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 30_000 });
    } catch (error) {
      report.push({ theme, frame: name, errors: [...errors, String(error)] });
      console.log(theme, name, 'DID NOT BOOT', JSON.stringify(errors));
      await page.close();
      continue;
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(900);
    if (frame.openSheet) {
      const press = page.locator('.session-project-landing button.spl-press').first();
      if (await press.count()) { await press.click(); await page.waitForTimeout(600); }
    }
    if (errors.length) console.log(theme, name, 'PAGE ERRORS', JSON.stringify(errors));
    const drawn = await page.evaluate(() => ({
      landingCard: document.querySelector('.session-project-landing')?.textContent ?? null,
      landingLinks: [...document.querySelectorAll('.session-project-landing a, .landing-jobs a')]
        .map((a) => `${a.textContent} → ${a.getAttribute('href')}`),
      sheetRows: [...document.querySelectorAll('.landing-jobs-row')].map((row) => row.textContent),
      mergeCard: document.querySelector('.session-project-merge')?.textContent ?? null,
      mergeLinks: [...document.querySelectorAll('.session-project-merge a')]
        .map((a) => `${a.textContent} → ${a.getAttribute('href')}`),
      landingsGroup: document.querySelector('.session-project-landings')?.textContent ?? null,
      landingsRows: [...document.querySelectorAll('.session-project-landing-row')]
        .map((row) => row.textContent),
      landingFold: document.querySelector('.session-project-landing-fold')?.textContent ?? null,
      headerCount: document.querySelector('.session-folder-workspace')?.textContent ?? null,
      xe5: [...document.querySelectorAll('.project-open-item-card')].map((card) => card.textContent),
      deliveryLinks: [...document.querySelectorAll('.oic-links a')].map((a) => `${a.textContent} → ${a.getAttribute('href')}`),
      sourceChip: document.querySelector('.session-source-landing-chip')?.textContent ?? null,
      sourceChipHref: document.querySelector('.session-source-landing-chip')?.getAttribute('href') ?? null,
      taskLanding: document.querySelector('.landing-section, section[aria-label="Task landing"]')?.textContent ?? null,
      taskLandingLink: [...document.querySelectorAll('section[aria-label="Task landing"] a')]
        .map((a) => `${a.textContent} → ${a.getAttribute('href')}`),
    }));
    const file = `${OUT}/${theme}-${name}.png`;
    try {
      if (frame.viewport) throw new Error('viewport frame');
      await page.locator(frame.clip.split(',')[0].trim()).first().screenshot({ path: file, animations: 'disabled' });
    } catch {
      // The dialog frames are the window's own: a dialog is centred over the pane, not inside it.
      await page.screenshot({ path: file, animations: 'disabled' });
    }
    report.push({ theme, frame: name, errors, unhandled: fixtures.unhandled, ...drawn });
    console.log(theme, name, JSON.stringify({ errors, unhandled: fixtures.unhandled }));
    await page.close();
  }
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
server.close();
