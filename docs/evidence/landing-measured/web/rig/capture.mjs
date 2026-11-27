// Revision 42 part two, web: the five screens the owner ruled on (docs/mocks/landing-measured, D1–D9),
// on this worktree's real web app — its production build served from loopback, the repo's ui-migration REST
// fixtures, and each scene's reads layered over them (`page.route`, registered after the fixtures, so these
// answer first). The reads carry exactly the fields the server's read models carry (landingCheck.setBy/setAt,
// settingChanges with origin/revertedAt/revertible, task landingCheckExempt, a LANDING_CHECK entry skipped
// TASK_EXEMPT). Light and dark.
//
// usage: (cd src/web && npm run build) && unshare -n docs/evidence/landing-measured/web/rig/run-ns.sh [scene[-theme] ...]
// Writes <scene>-<theme>.png beside this directory, and prints one JSON line per shot: the text the shot drew,
// page errors, the API writes the scene made, and any API call no fixture answered.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = path.resolve(HERE, '../../../../..');
const OUT = path.resolve(HERE, '..');
const DIST = process.env.DIST ?? `${W}/src/web/dist`;
const ONLY = process.argv.slice(2);
const FONTS = process.env.FONTCONFIG_FILE;

const { chromium } = await import(`${W}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXTURE_IDS, FIXED_NOW } = await import(`${W}/src/web/ui-migration/fixtures.mjs`);
const { SESSION } = await import(`${W}/src/web/ui-migration/session-fixtures.mjs`);
const { uuidToBase62 } = await import(`${W}/src/shared/dist/index.js`);

const NOW = Date.parse(FIXED_NOW);
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const id = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const earlier = '2026-09-27T10:00:00.000Z';

const PROJECT_ID = FIXTURE_IDS.project;
const TITLE = 'Rotate staging credentials';
const COORDINATOR = SESSION.id;
const TASK_ID = FIXTURE_IDS.task;

const criteria = [{ id: id(601), key: 'rotated', ordinal: 1, revision: 1, text: 'Staging DB password is rotated and every service reads the new one.', landing: 'UNKNOWN', satisfied: false }];
const attentionNone = { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, attentionSinceAt: null, nextCheckAt: null, ownerItems: [], coordinatorItems: null, startRequest: null };

// ── what the server's landing-check read says ─────────────────────────────────────────────────

const lc = (command, setBy, ago) => ({ command, setBy, setBySessionId: setBy === 'COORDINATOR' ? COORDINATOR : null, setAt: ago == null ? null : at(ago) });
const CHECK = 'npm run check:landing';
const exemptReason = 'Only moves cron entries; the landing check needs a database this task cannot reach.';
const changes = [
  { id: id(901), projectId: PROJECT_ID, taskId: null, field: 'LANDING_CHECK', origin: 'COORDINATOR',
    oldValue: { command: CHECK, timeoutSeconds: null, none: false }, newValue: { command: null, timeoutSeconds: null, none: true },
    reason: 'This project only changes infrastructure; the command has nothing to build.', writtenBySessionId: COORDINATOR,
    revertsChangeId: null, revertedAt: null, revertible: true, createdAt: at(12 * MIN) },
  { id: id(902), projectId: PROJECT_ID, taskId: TASK_ID, field: 'TASK_LANDING_CHECK_EXEMPT', origin: 'COORDINATOR',
    oldValue: { exempt: false, reason: null }, newValue: { exempt: true, reason: exemptReason },
    reason: exemptReason, writtenBySessionId: COORDINATOR,
    revertsChangeId: null, revertedAt: null, revertible: true, createdAt: at(20 * MIN) },
  { id: id(903), projectId: PROJECT_ID, taskId: null, field: 'LANDING_CHECK', origin: 'OWNER',
    oldValue: { command: null, timeoutSeconds: null, none: false }, newValue: { command: CHECK, timeoutSeconds: null, none: false },
    reason: null, writtenBySessionId: null, revertsChangeId: null, revertedAt: null, revertible: false, createdAt: at(2 * 24 * HOUR) },
];
const revertedChanges = [
  { ...changes[0], revertedAt: at(MIN), revertible: false },
  ...changes.slice(1),
];

function projectDoc({ line = 'PROJECT_BRANCH', started = true, settingChanges = [] } = {}) {
  return {
    id: PROJECT_ID, title: TITLE, status: 'OPEN',
    goal: 'Rotate the staging database password and make every service read the new one.',
    instructions: 'Nothing touches production.',
    acceptanceCriteriaItems: criteria,
    createdAt: earlier, updatedAt: earlier, lastActivityAt: FIXED_NOW, _count: { tasks: 6 },
    tasksByStatus: { OPEN: 3, DONE: 3 },
    buckets: { running: 1, ready: 0, blocked: 2, awaitingVerification: 0, done: 3, failed: 0, cancelled: 0 },
    attention: attentionNone,
    coordinatorEnabled: true, coordinatorSessionId: COORDINATOR,
    maxConcurrentTasks: 3, configRevision: '4', startedAt: started ? at(26 * HOUR) : null, pausedAt: null,
    exceptionEscalationSeconds: 7200,
    blockers: { open: [], resolved: [], resolvedCount: 0 },
    mainBranch: 'main',
    integration: line ? { line, ref: `project/${PROJECT_ID}`, upstreamRef: 'main', deliveryMode: 'PLATFORM', deliveryModeChosenAt: null } : null,
    settingChanges,
  };
}

function integrationView({ line = 'PROJECT_BRANCH', locked = true, landingCheck, queued = 0 }) {
  const command = landingCheck.command === 'NONE' || landingCheck.command === null ? null : landingCheck.command;
  return {
    line, lineAbsentReason: line ? null : 'NOT_DECIDED',
    ref: line ? `project/${PROJECT_ID}` : null, upstreamRef: 'main', upstreamChosenAt: null, lastMainBranch: null,
    source: line ? 'EXPLICIT' : null, locked, startedAt: locked ? at(26 * HOUR) : null,
    landingCheckCommand: command, landingCheckTimeoutSeconds: null,
    landingCheckCommandAbsentReason: landingCheck.command === 'NONE' ? 'NONE' : command ? null : 'FALLS_BACK_TO_MERGE_CHECK',
    landingCheck,
    mergeCheckCommand: 'npm test', mergeCheckCommandAbsentReason: null, mergeCheckTimeoutSeconds: null,
    escalationSeconds: 7200,
    commitsAheadOfUpstream: null, commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET',
    lastUpstreamSyncAt: null, lastUpstreamSyncAbsentReason: 'NEVER_SYNCED',
    integratingCount: 0, queuedCount: queued, mergeCheckOnTip: 'UNKNOWN',
    inFlight: queued ? { jobId: id(951), kind: 'LAND_TASK', state: 'QUEUED', taskId: id(711), queuedAt: at(9 * MIN), startedAt: null, heartbeatAt: null, phase: null, waitMs: 9 * MIN, timedOut: false } : null,
    inFlightJobs: [],
    repository: 'example/staging', branches: null, deliveryMode: 'PLATFORM', deliveryModeChosenAt: null,
  };
}

const taskBase = {
  status: 'DONE', outcome: 'DONE', description: '', acceptanceCriteria: 'The cron entries run on the new host.',
  acceptanceCommand: null, acceptanceExpectedExitCode: null, completionCriterion: 'EVIDENCE_JUDGMENT', completionPolicy: 'MANUAL',
  createdAt: earlier, updatedAt: earlier, dueDate: null, runAt: null, parentTaskId: null,
  assignee: { id: FIXTURE_IDS.workspace, name: 'Orbit baseline' }, assigneeId: FIXTURE_IDS.workspace,
  provider: 'claude', model: null, modelHint: null, modelHintReason: null,
  project: { id: PROJECT_ID, title: TITLE, status: 'OPEN' }, projectId: PROJECT_ID, list: null, listId: null, labels: [],
  autoRunWhenReady: true, unmetCount: 0, blocksCount: 0, topoLevel: 0, dependencyState: 'TERMINAL', childCount: 0,
  sessions: [], dependsOn: [], dependedOnBy: [], inputs: [], children: [], comments: [],
  workState: 'DONE', landingWaitCount: 0,
};
const exemptTask = {
  ...taskBase, id: TASK_ID, title: 'Move cron jobs off the old VM',
  landingCheckExempt: true, landingCheckExemptReason: exemptReason,
  integration: {
    state: 'ON_INTEGRATION_LINE', since: at(3 * MIN), handler: null, openItemId: null, jobId: id(952), checksRunningForMs: null,
    mainBranch: 'main',
    landTask: {
      jobId: id(952), state: 'LANDED', phase: null, generation: '1', landingSessionId: id(960),
      queuedAt: at(5 * MIN), startedAt: at(4 * MIN), heartbeatAt: at(3 * MIN), finishedAt: at(3 * MIN),
      targetRef: `refs/heads/project/${PROJECT_ID}`, waitMs: 20_000, blockingReason: null,
    },
  },
};

const items = (startRequest) => ({ needsYou: [], withCoordinator: [], startRequest, settled: [], closedQuestions: [] });
const CONFIRMED = { state: 'CONFIRMED', confirmed: true, currentVersion: { digest: 'c'.repeat(64), material: [] }, confirmation: null };
const STANDING = {
  state: 'UNCONFIRMED', confirmed: false,
  currentVersion: { digest: 'c'.repeat(64), material: criteria.map((c) => ({ definitionId: c.id, revision: 1, contentHash: 'h1' })) },
  confirmation: null, changesSinceConfirmed: null, changesSinceConfirmedAbsentReason: 'NEVER_CONFIRMED',
};
const GRAPH = {
  marks: [id(711), id(712)].map((m, i) => ({ kind: 'TASK', id: m, taskId: m, title: ['Rotate the staging database password', 'Delete unused staging buckets'][i], status: 'OPEN', parentTaskId: null, completionCriterion: 'EVIDENCE_JUDGMENT', autoRunWhenReady: true })),
  edges: [], taskCount: 6, folded: false, truncated: false, limits: { maxTasks: 1000, maxMarks: 1000 },
};
const panorama = { buckets: { running: 1, ready: 0, blocked: 2, awaitingVerification: 0, done: 3, failed: 0, cancelled: 0, integrating: 0, onIntegrationLine: 0, onUpstream: 0, doneNotIntegrated: 0, waitingForLanding: 0 }, shape: { taskCount: 6, edgeCount: 0, ratio: 0, maxDepth: 0, form: 'chain' } };

function projectReads({ doc, view, openItems = items(null), over = {} }) {
  return {
    [`/api/projects/${PROJECT_ID}`]: doc,
    [`/api/projects/${PROJECT_ID}/integration`]: view,
    [`/api/projects/${PROJECT_ID}/open-items`]: openItems,
    [`/api/projects/${PROJECT_ID}/tasks/page`]: { items: [], nextCursor: null, total: 0 },
    [`/api/projects/${PROJECT_ID}/panorama`]: panorama,
    [`/api/projects/${PROJECT_ID}/dependency-graph`]: GRAPH,
    [`/api/projects/${PROJECT_ID}/acceptance/confirmation`]: doc.startedAt ? CONFIRMED : STANDING,
    [`/api/projects/${PROJECT_ID}/acceptance/criteria-decisions/pending`]: { readAt: FIXED_NOW, projectId: PROJECT_ID, count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [], settled: [] },
    [`/api/projects/${PROJECT_ID}/promotions/merged`]: [],
    '/api/projects/sidebar': [{ ...doc, taskCounts: { done: 3, failed: 0, total: 6 } }],
    '/api/projects': [doc],
    ...over,
  };
}

// A start request with no line: the coordinator named none (P-M2). `settings.line` is absent.
const NO_LINE_REQUEST = {
  itemId: id(801), kind: 'START_REQUEST', title: 'Start this project?', detailLine: '', assignee: 'OWNER', assigneeReason: 'DEFAULT',
  waitingSince: at(12 * MIN), escalateAt: null, escalatedAt: null, taskId: null, sessionId: null, promotionId: null, fuseEpisodeId: null,
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null }, actions: [], question: null, facts: null,
  startRequest: {
    settings: { automatic: true, maxConcurrentTasks: 3, mergeCheckCommand: null },
    why: 'None of the tasks commits code, so there is no line to choose yet.',
    criteriaDigest: 'c'.repeat(64), planDigest: 'p'.repeat(64), repository: 'https://github.com/example/staging.git', warnings: [],
  },
};

const NO_LINE = projectReads({
  doc: projectDoc({ line: null, started: false }),
  view: { ...integrationView({ line: null, locked: false, landingCheck: lc(null, null, null) }), mergeCheckCommand: null, mergeCheckCommandAbsentReason: 'NOT_CONFIGURED' },
  openItems: items(NO_LINE_REQUEST),
});

// A started project with no line, with a landing waiting that today would draw a Landing card and a Landings row.
const landingRow = (n, title, state) => ({
  id: id(n), sessionKind: 'LANDING', title, createdAt: at(9 * MIN), lastTurnAt: at(9 * MIN), lifecycleState: 'OPEN',
  projectId: PROJECT_ID, projectMembership: { projectId: PROJECT_ID, projectTitle: TITLE, projectStatus: 'OPEN', role: 'TASK' },
  workspaceId: SESSION.workspaceId, workspace: SESSION.workspace,
  landing: { subject: 'TASK', state, settledAs: null, settledAt: null },
});
const coordinatorRow = {
  ...SESSION, title: TITLE, projectId: PROJECT_ID, projectTitle: TITLE,
  projectMembership: { projectId: PROJECT_ID, projectTitle: TITLE, projectStatus: 'OPEN', role: 'COORDINATOR' },
  status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', engineTurnActive: false,
  lastTurnAt: at(MIN), updatedAt: at(MIN), createdAt: at(4 * HOUR), pendingApprovals: 0, ownerItems: [],
};
const turn = (seq, ts, user, assistant) => [
  { seq, type: 'user', payload: { text: user }, turnId: `turn-${seq}`, ts },
  { seq: seq + 1, type: 'assistant', payload: { text: assistant }, turnId: `turn-${seq}`, ts },
  { seq: seq + 2, type: 'turn_end', payload: { subtype: 'success' }, turnId: `turn-${seq}`, ts },
];
const sessionReads = (reads) => ({
  ...reads,
  [`/api/sessions/${COORDINATOR}`]: coordinatorRow,
  '/api/sessions': [coordinatorRow, landingRow(970, 'Land · Rotate the staging database password', 'IN_FLIGHT'), landingRow(971, 'Land · Delete unused staging buckets', 'IN_FLIGHT')],
  [`/api/sessions/${COORDINATOR}/events/page`]: { events: turn(1, at(5 * MIN), 'How is the rotation going?', 'Two tasks running; the third waits on them.'), hasMore: false },
  '/api/auth/capabilities': {},
});

const LINE_WITH_LANDINGS = projectReads({
  doc: projectDoc({ line: 'PROJECT_BRANCH' }),
  view: integrationView({ landingCheck: lc(CHECK, 'COORDINATOR', 12 * MIN), queued: 2 }),
});
const NO_LINE_STARTED = projectReads({
  doc: projectDoc({ line: null }),
  view: integrationView({ line: null, locked: false, landingCheck: lc(null, null, null), queued: 2 }),
});

const settingsScene = (landingCheck, settingChanges = []) => projectReads({
  doc: projectDoc({ settingChanges }),
  view: integrationView({ landingCheck }),
});

// The landing session of the exempt task (D5): its check list.
const E = (n, kind, text, data, check) => ({
  id: `e${n}`, seq: n, kind, at: at(4 * MIN - n * 1000), claim: 1, round: 1, check, phase: 'CHECK', step: null,
  actor: { type: 'RUNNER' }, reason: null, data, text,
});
const landingView = {
  subject: 'TASK', taskId: TASK_ID, promotionId: null, episode: 1, openedAt: at(5 * MIN), settledAt: at(3 * MIN), settledAs: 'LANDED',
  phase: null, round: 1, checks: [], liveness: 'LIVE', blockingReason: null,
  currentAttempt: { jobId: id(952), kind: 'LAND_TASK', state: 'LANDED', generation: 1, claim: 1, round: 1, phase: null, check: null, liveness: null, timedOut: false, targetRef: `refs/heads/project/${PROJECT_ID}`, startedAt: at(4 * MIN), heartbeatAt: at(3 * MIN), queuedAt: at(5 * MIN), finishedAt: at(3 * MIN), runnerName: null },
  todos: [], generations: [],
  timeline: {
    sections: [{
      title: 'Landing · 1', jobId: id(952), kind: 'LAND_TASK', generation: 1, state: 'LANDED',
      entries: [
        E(1, 'CHECK_FINISHED', 'Task acceptance passed · 14s', { exitCode: 0, expectedExitCode: 0, timedOut: false, durationMs: 14000 }, { name: 'TASK_ACCEPTANCE', index: 1 }),
        E(2, 'CHECK_FINISHED', `Landing check skipped · this task is exempt: ${exemptReason}`, { skipped: 'TASK_EXEMPT', reason: exemptReason, exitCode: null, timedOut: false, durationMs: 0 }, { name: 'LANDING_CHECK', index: 2 }),
        E(3, 'RESULT', 'Landed on the project branch', { state: 'LANDED' }, null),
      ],
    }],
    facts: [], truncated: false,
  },
};
const LANDING_SESSION = {
  ...SESSION, id: id(960), title: 'Land · Move cron jobs off the old VM', sessionKind: 'LANDING', landing: landingView,
  projectId: PROJECT_ID, projectTitle: TITLE, status: 'COMPLETED', lifecycleState: 'COMPLETED',
};

const SCENES = {
  // ① the start card for a request that names no line: one sentence, Merge check, At most, Automatic; no line picker.
  'start-no-line': {
    path: `/sessions/${COORDINATOR}?project=${PROJECT_ID}`, reads: sessionReads(NO_LINE), ready: '.start-card',
    viewport: { width: 1440, height: 1700 },
    act: async (page) => { await page.locator('.start-card-plan span').first().waitFor(); },
    shot: '.start-card',
    // the press: what the door is sent
    press: async (page) => {
      await page.locator('.start-card').getByRole('button', { name: 'Start the project' }).click();
      await page.waitForTimeout(500);
    },
  },
  // ② a started project with no line: no Landing card, no Landings row.
  'page-no-line': {
    path: `/sessions/${COORDINATOR}?project=${PROJECT_ID}`, reads: sessionReads(NO_LINE_STARTED), ready: '.session-project-coordinator',
    viewport: { width: 1440, height: 900 }, settle: 1500, page: true, focus: '.session-project-coordinator',
  },
  // …and the same project once a line exists, for comparison: the card and the row are back.
  'page-with-line': {
    path: `/sessions/${COORDINATOR}?project=${PROJECT_ID}`, reads: sessionReads(LINE_WITH_LANDINGS), ready: '.session-project-landings',
    viewport: { width: 1440, height: 900 }, settle: 1500, page: true, focus: '.session-project-landings',
  },
  // ③ the landing check: who set it and when, and No check.
  'settings-coordinator': {
    path: `/projects/${PROJECT_ID}`, reads: settingsScene(lc(CHECK, 'COORDINATOR', 12 * MIN), changes), ready: '.project-landing-origin',
    shot: '.project-run-settings',
  },
  'settings-you': {
    path: `/projects/${PROJECT_ID}`, reads: settingsScene(lc(CHECK, 'OWNER', 2 * 24 * HOUR)), ready: '.project-landing-origin',
    shot: '.project-run-settings',
  },
  'settings-card': {
    path: `/projects/${PROJECT_ID}`, reads: settingsScene(lc(CHECK, 'CARD', 5 * 24 * HOUR)), ready: '.project-landing-origin',
    shot: '.project-run-settings',
  },
  'settings-start': {
    path: `/projects/${PROJECT_ID}`, reads: settingsScene(lc(CHECK, 'START', 3 * 24 * HOUR)), ready: '.project-landing-origin',
    shot: '.project-run-settings',
  },
  'settings-no-check': {
    path: `/projects/${PROJECT_ID}`, reads: settingsScene(lc('NONE', 'OWNER', 3 * MIN)), ready: '.project-landing-none',
    shot: '.project-run-settings',
  },
  // ④ the exemption on a task, and Skipped in the landing's check list.
  'task-exempt': {
    path: `/projects/${PROJECT_ID}/tasks/${TASK_ID}`, reads: { ...settingsScene(lc(CHECK, 'COORDINATOR', 12 * MIN), changes), [`/api/tasks/${TASK_ID}`]: exemptTask }, ready: '[data-task-exempt]',
    shot: '[aria-label="Task landing"]',
  },
  'landing-skipped': {
    path: `/projects/${PROJECT_ID}/landings`, reads: { ...settingsScene(lc(CHECK, 'COORDINATOR', 12 * MIN), changes),
      [`/api/sessions/${LANDING_SESSION.id}`]: LANDING_SESSION,
      '/api/sessions': [coordinatorRow, { ...landingRow(960, 'Land · Move cron jobs off the old VM', 'SETTLED'), id: LANDING_SESSION.id,
        landing: { subject: 'TASK', state: 'SETTLED', settledAs: 'LANDED', settledAt: at(3 * MIN) } }],
      '/api/auth/capabilities': {},
      [`/api/projects/${PROJECT_ID}/coordinator/status`]: { coordination: { sessionId: COORDINATOR }, readAt: FIXED_NOW } },
    ready: '.landings-window', viewport: { width: 1440, height: 1200 },
    act: async (page) => {
      await page.locator('.landings-window-reply').first().click();
      for (let n = 0; n < 8; n += 1) {
        const folded = page.locator('.landings-window-steps-line[aria-expanded="false"], .landing-step-row[aria-expanded="false"]').first();
        if (await folded.count() === 0) break;
        await folded.click();
        await page.waitForTimeout(200);
      }
      await page.locator('[data-step="check:LANDING_CHECK"]').waitFor();
    },
    shot: '[data-step="check:LANDING_CHECK"]',
  },
  // ⑤ the coordinator's change list, the owner's Revert, and the list afterwards.
  'changes-list': {
    path: `/projects/${PROJECT_ID}`, reads: settingsScene(lc(CHECK, 'COORDINATOR', 12 * MIN), changes), ready: '.project-changes-row',
    act: async (page) => { await page.locator('.project-changes-row').click(); await page.locator('.project-changes-list').waitFor(); },
    shot: '.project-changes',
  },
  'changes-confirm': {
    path: `/projects/${PROJECT_ID}`, reads: settingsScene(lc(CHECK, 'COORDINATOR', 12 * MIN), changes), ready: '.project-changes-row',
    act: async (page) => {
      await page.locator('.project-changes-row').click();
      await page.locator('.project-change-row button').first().click();
      await page.locator('[role="dialog"], [role="alertdialog"]').first().waitFor();
      await page.waitForTimeout(300);
    },
    shot: '[role="dialog"], [role="alertdialog"]',
  },
  'changes-reverted': {
    path: `/projects/${PROJECT_ID}`, reads: settingsScene(lc(CHECK, 'OWNER', MIN), revertedChanges), ready: '.project-changes-row',
    act: async (page) => { await page.locator('.project-changes-row').click(); await page.locator('.project-changes-list').waitFor(); },
    shot: '.project-changes',
  },
};

// ── the run ────────────────────────────────────────────────────────────────────────────────────

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(5765, '127.0.0.1', resolve));
const BASE = 'http://127.0.0.1:5765';

async function shoot(browser, name, theme) {
  const scene = SCENES[name];
  const context = await browser.newContext({
    viewport: scene.viewport ?? { width: 1440, height: 2200 }, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US',
    timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  const writes = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.DEBUG_DIR) page.on('request', (r) => { if (r.url().includes('/api/')) console.log('REQ', r.method(), new URL(r.url()).pathname); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await installFixedDate(page);
  const api = await installFixtures(page, { theme });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const where = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      writes.push({ method: request.method(), path: where, body: request.postData() ? JSON.parse(request.postData()) : null });
      return route.fulfill({ status: 200, json: {} });
    }
    if (Object.hasOwn(scene.reads, where)) return route.fulfill({ status: 200, json: scene.reads[where] });
    return route.fallback();
  });
  await page.goto(BASE + scene.path);
  try {
    await page.locator(scene.ready).first().waitFor({ timeout: 20_000 });
  } catch (error) {
    if (process.env.DEBUG_DIR) console.log('unhandled', JSON.stringify(api.unhandled), JSON.stringify(errors));
    if (process.env.DEBUG_DIR) await page.screenshot({ path: `${process.env.DEBUG_DIR}/${name}-${theme}-fail.png` });
    throw error;
  }
  await page.waitForFunction(() => !document.getElementById('boot'));
  if (scene.act) await scene.act(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(scene.settle ?? 500);
  const file = `${OUT}/${name}-${theme}.png`;
  let text;
  if (scene.page) {
    await page.screenshot({ path: file, animations: 'disabled' });
    text = await page.locator('.session-col-list').first().innerText().catch(() => '');
  } else {
    const target = page.locator(scene.shot).first();
    await target.scrollIntoViewIfNeeded();
    await target.screenshot({ path: file, animations: 'disabled' });
    text = await target.innerText();
  }
  if (scene.press) await scene.press(page);
  await context.close();
  return { scene: name, theme, file: path.relative(W, file), text, errors, writes, unhandled: api.unhandled };
}

const browser = await chromium.launch({ env: FONTS ? { ...process.env, FONTCONFIG_FILE: FONTS } : process.env, args: ['--disable-features=BackForwardCache'] });
try {
  for (const name of Object.keys(SCENES)) {
    for (const theme of ['light', 'dark']) {
      if (ONLY.length && !ONLY.includes(`${name}-${theme}`) && !ONLY.includes(name)) continue;
      try {
        console.log(JSON.stringify(await shoot(browser, name, theme)));
      } catch (error) {
        console.log(JSON.stringify({ scene: name, theme, failed: String(error?.message ?? error).slice(0, 600) }));
        process.exitCode = 1;
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
