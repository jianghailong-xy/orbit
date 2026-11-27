// Revision 42 part one, web: the screens the owner ruled on 2026-11-22 (docs/mocks/landing-fix-own-session, web a–e,
// "Approve as drawn"), on this worktree's real web app — its production build served from loopback, the repo's
// ui-migration REST fixtures for the shell, and each scene's reads layered over them (`page.route`, registered after
// the fixtures, so these answer first). The reads carry exactly the fields the server's read models carry since S5:
// the landing-fix turn's words (apiserver projects/landing-fix-turn.ts), the session row's landing state FIXING, the
// timeline's HANDED_TO_SESSION / FIXED_BY_SESSION / RETURNED_TO_COORDINATOR rows, open items' `withWorkSession` and
// `workSession`, and a task's integration state FIXING with its `workSessionId`. All names are made-up example data.
//
// Scenes (one per ruled frame, the board's a and b each split into the two moments the board drew on one frame):
//   a1-session-card      the task's own session as the failure arrives: Orbit's card; the left column's Fixing card
//                        and the session's row line
//   a2-session-again     the same session after its fix: its reply and "Landing 4be19c2 again · Open landing ›"
//   b1-landing-fixing    the landing window focused on the landing: Fixing, whose hands, which round, Open Session /
//                        Open Task, the "Handed to the task's session" row, the footer's decisions line
//   b2-landing-again     the same landing once the fix landed: "Fixed in 4be19c2 · landing again" opening generation 2
//   c-handed-back        the session could not fix it: its last words on the card, Coordinator has it, the
//                        "Returned to the coordinator: no new commit" row; the left column's Not landed card
//   d-project            the project page: Open items' "Being fixed by its session" group, and (e-task-row) the
//                        same page at its task list, where the row wears "Landing · fixing"
//
// usage: bash docs/evidence/landing-fix-own-session/web/kit/run.sh [outDir]
// Writes <scene>-<theme>.png and report.json (per shot: the text drawn, page errors, writes, unanswered API calls).
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const WT = process.env.WT ?? path.resolve(KIT, '../../../../..');
const DIST = process.env.DIST ?? '/tmp/lfos-web-shots/dist';
const OUT = process.argv[2] ?? `${KIT}/out`;
const ONLY = (process.env.SCENES_ONLY ?? '').split(',').filter(Boolean);
const THEMES = (process.env.THEMES || 'light,dark').split(',');
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

// ── the example ────────────────────────────────────────────────────────────────────────────────

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** A local (Asia/Shanghai) clock time on 2026-11-20, the board's day. */
const local = (hour, minute, second = 0) => new Date(Date.UTC(2026, 10, 20, hour - 8, minute, second)).toISOString();
const sid = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);

const PROJECT = FIXTURE_IDS.project;
const PROJECT_TITLE = 'Wiki server execution and the System model';
const BRANCH = 'project/34ZZnRbX2CsCFp';
const RUNNER = 'workstation-gpu';
const COORDINATOR = SESSION.id;
const ID = {
  task: sid(901), task11k: sid(902), task13f: sid(903), task08l: sid(904),
  work: sid(911), work11k: sid(912), work08l: sid(913),
  landing: sid(921), item: sid(931), item11k: sid(932), job1: sid(941), job2: sid(942),
};
const TASK = 'A10c · Notification cold start drops the session';
const TASKS = {
  t11k: 'A11k · Write back before enabling the button',
  t13f: 'A13f · Order model accounts in Runner settings',
  t08l: 'A08l · Collapse the input on Android 15 window recreation',
};
const FIX_SHA = '4be19c2a71f0d3e98c55b21f6a0e7d44c18f2b90';
const LAST_WORDS = 'The conflict is with A13f’s store refactor, which removes the list-ready signal my fix waits on. '
  + 'Which of the two designs stays is not mine to decide.';

// The landing-fix turn, word for word as apiserver projects/landing-fix-turn.ts `landingFixMessage` writes it.
const TURN_TEXT = [
  `Orbit could not land your work for "${TASK}" on ${BRANCH}.`,
  '',
  `Conflict while rebasing onto ${BRANCH} at 41ac9e0:`,
  'app/src/main/java/notify/ColdStartRouter.kt, app/src/main/java/session/SessionListStore.kt',
  '',
  `Nothing was pushed. ${BRANCH} is unchanged.`,
  '',
  'Fix it on your own branch, in this checkout:',
  `1. Merge ${BRANCH} into your branch and resolve what conflicts.`,
  '2. Run what failed until it passes.',
  '3. Commit, then end your turn.',
  '',
  `Orbit lands the new commit and runs the checks again by itself. Do not push ${BRANCH}.`,
  'If this is not yours to fix, end your turn without committing and say why; the project\'s coordinator takes it from there.',
  `The full record: landing ${ID.landing}.`,
].join('\n');
const REPLY = `Merged \`${BRANCH}\` into my branch. Both conflicts were with A13f’s store refactor: I kept its \`SessionListStore\` `
  + 'API and moved my wait-for-list onto it. `ColdStartRouteTest` passes. Committed `4be19c2`.';

const membership = (role) => ({ projectId: PROJECT, projectTitle: PROJECT_TITLE, projectStatus: 'OPEN', role });
const coordinator = {
  ...SESSION, title: PROJECT_TITLE, projectId: PROJECT, projectTitle: PROJECT_TITLE, projectMembership: membership('COORDINATOR'),
  status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', engineTurnActive: false,
  lastAssistantText: 'Watching any 1 of 12 tasks to finish', lastTurnAt: local(10, 5), updatedAt: local(10, 5),
  createdAt: local(8, 0), pendingApprovals: 0, ownerItems: [],
};
// A member carries its project only as membership: a row's own `projectId` names the project it coordinates.
const member = (id, title, at, o = {}) => ({
  ...SESSION, id, title, projectMembership: membership('TASK'),
  status: 'SUCCEEDED', runState: 'SUCCEEDED', runStatus: 'SUCCEEDED', lastAssistantText: `Recap · ${title} is on its branch`,
  lastTurnAt: at, updatedAt: at, createdAt: local(9, 0), ownerItems: [], ...o,
});
const sourceLanding = (state, phase = null) => ({
  landingSessionId: ID.landing, subject: 'TASK', state, phase, settledAs: null, targetRef: `refs/heads/${BRANCH}`,
});
const workSession = (o = {}) => member(ID.work, `Run task: ${TASK}`, local(9, 59), {
  taskId: ID.task, startsTaskWork: true, lastAssistantText: LAST_WORDS, ...o,
});
const otherMembers = [
  member(ID.work11k, `Run task: ${TASKS.t11k}`, local(10, 5)),
  member(ID.work08l, `Run task: ${TASKS.t08l}`, local(9, 46)),
];
const landingRow = (state, o = {}) => ({
  ...SESSION, id: ID.landing, title: `Land · ${TASK}`, projectId: PROJECT, projectTitle: PROJECT_TITLE,
  projectMembership: membership('TASK'), sessionKind: 'LANDING', taskId: null, lifecycleState: state === 'SETTLED' ? 'COMPLETED' : 'OPEN',
  status: state === 'SETTLED' ? 'SUCCEEDED' : 'RUNNING', runState: state === 'SETTLED' ? 'SUCCEEDED' : 'RUNNING',
  createdAt: local(10, 1), lastTurnAt: local(10, 2), updatedAt: local(10, 2),
  landing: { subject: 'TASK', state, settledAs: state === 'SETTLED' ? 'LANDED' : null, settledAt: state === 'SETTLED' ? local(10, 14) : null },
  ...o,
});

// ── the landing's record ───────────────────────────────────────────────────────────────────────

let seq = 0;
const entry = (kind, text, at, o = {}) => ({ id: `e${++seq}`, seq, kind, at, claim: o.claim ?? 1, round: o.round ?? null,
  check: o.check ?? null, phase: o.phase ?? null, step: null, actor: o.actor ?? { type: 'RUNNER' }, reason: o.reason ?? null,
  data: o.data ?? null, text });
const LANDING_CHECK = { name: 'LANDING_CHECK', index: 1 };
const gen1 = () => [
  entry('ENQUEUED', `Task marked done · queued to land on ${BRANCH}`, local(10, 1), { actor: { type: 'PLATFORM' } }),
  entry('CLAIMED', `Claimed by runner ${RUNNER} · claim 1`, local(10, 2)),
  entry('STEP', `Rebasing onto ${BRANCH}`, local(10, 2, 5), { phase: 'REBASE' }),
  entry('RESULT', 'Conflict in 2 files · nothing was pushed', local(10, 2, 20), { data: { state: 'CONFLICT' }, reason: 'The project branch did not move.' }),
];
// The three rows S5's landing-timeline.ts derives, in its words.
const handed = () => entry('HANDED_TO_SESSION', 'Handed to the task\'s session', local(10, 2, 30),
  { actor: { type: 'PLATFORM' }, data: { itemId: ID.item, sessionId: ID.work } });
const fixed = () => entry('FIXED_BY_SESSION', `Fixed in ${FIX_SHA.slice(0, 7)} · landing again`, local(10, 9),
  { claim: 0, actor: { type: 'TASK_SESSION', sessionId: ID.work }, reason: 'Fixed the conflict on its own branch',
    data: { retryOfJobId: ID.job1, failureClass: 'CONFLICT', sessionId: ID.work, sourceSha: FIX_SHA } });
const returned = () => entry('RETURNED_TO_COORDINATOR', 'Returned to the coordinator: no new commit', local(10, 31),
  { actor: { type: 'PLATFORM' }, reason: 'NO_NEW_COMMIT', data: { itemId: ID.item, sessionId: ID.work, returnReason: 'NO_NEW_COMMIT' } });
const gen2 = () => [
  fixed(),
  entry('ENQUEUED', `Queued again to land on ${BRANCH}`, local(10, 9, 2), { actor: { type: 'PLATFORM' } }),
  entry('CLAIMED', `Claimed by runner ${RUNNER} · claim 1`, local(10, 10)),
  entry('CHECK_STARTED', `Landing check started · claim 1 · ${RUNNER}`, local(10, 10, 20), { round: 1, check: LANDING_CHECK }),
  entry('CHECK_FINISHED', 'Landing check passed · 3m 48s', local(10, 14, 8), { round: 1, check: LANDING_CHECK,
    data: { exitCode: 0, expectedExitCode: 0, timedOut: false, durationMs: 228_000 } }),
  entry('RESULT', `Landed on ${BRANCH} · 7d03b6e`, local(10, 14, 10), { data: { state: 'LANDED' } }),
];
const attempt = (o) => ({ jobId: ID.job1, kind: 'LAND_TASK', state: 'CONFLICT', generation: 1, phase: 'REBASE', round: null,
  step: null, claim: 1, runnerName: RUNNER, sourceSessionId: ID.work, targetRef: `refs/heads/${BRANCH}`,
  startedAt: local(10, 2), heartbeatAt: local(10, 2, 20), outputMovedAt: local(10, 2, 20), progressProtocol: 'v2', check: null,
  liveness: null, blockingReason: null, timedOut: false, limitSeconds: 600, retryable: false, pushBoundaryPassed: false,
  queuedAt: local(10, 1), finishedAt: local(10, 2, 20), ...o });
const trigger1 = { cause: 'DONE', by: 'TASK', at: local(10, 1), sourceRef: `refs/heads/orbit/task-a10c`, sourceSha: '41ac9e0b3', sessionId: ID.work, reason: null };
const trigger2 = { cause: 'RETRY', by: 'TASK', at: local(10, 9), sourceRef: `refs/heads/orbit/task-a10c`, sourceSha: FIX_SHA, sessionId: ID.work, reason: 'Fixed the conflict on its own branch' };
const view = (o) => ({ sessionId: ID.landing, projectId: PROJECT, subject: 'TASK', taskId: ID.task, promotionId: null, episode: 1,
  openedAt: local(10, 1), settledAt: null, settledAs: null, phase: 'REBASE', round: null, checks: [], liveness: null,
  blockingReason: null, generations: [], ...o });
const section1 = (entries, state = 'CONFLICT') => ({ title: 'Generation 1', jobId: ID.job1, kind: 'LAND_TASK', generation: 1, state, entries, trigger: trigger1 });
const section2 = (entries, state) => ({ title: 'Generation 2', jobId: ID.job2, kind: 'LAND_TASK', generation: 2, state, entries, trigger: trigger2 });
const todo = (o = {}) => ({ id: ID.item, kind: 'INTEGRATION_CONFLICT', state: 'OPEN', title: `Conflict while rebasing onto ${BRANCH}: ${TASK}`, waitingSince: local(10, 2, 30), ...o });

const LANDING_FIXING = view({
  currentAttempt: attempt({}), todos: [todo({ workSessionId: ID.work })],
  timeline: { truncated: false, facts: [], sections: [section1([...gen1(), handed()])] },
});
const LANDING_AGAIN_RUNNING = view({
  phase: 'CHECK', currentAttempt: attempt({ jobId: ID.job2, generation: 2, state: 'RUNNING', phase: 'CHECK', startedAt: local(10, 10), heartbeatAt: local(10, 11), finishedAt: null }),
  timeline: { truncated: false, facts: [], sections: [section1([...gen1(), handed()]), section2(gen2().slice(0, 4), 'RUNNING')] },
});
const LANDING_LANDED = view({
  settledAt: local(10, 14, 10), settledAs: 'LANDED', phase: null,
  currentAttempt: attempt({ jobId: ID.job2, generation: 2, state: 'LANDED', phase: null, startedAt: local(10, 10), heartbeatAt: local(10, 14), finishedAt: local(10, 14, 10), pushBoundaryPassed: true }),
  checks: [{ name: 'LANDING_CHECK', exitCode: 0, expectedExitCode: 0, timedOut: false, durationMs: 228_000 }],
  timeline: { truncated: false, facts: [], sections: [section1([...gen1(), handed()]), section2(gen2(), 'LANDED')] },
});
const LANDING_RETURNED = view({
  currentAttempt: attempt({}), todos: [todo()],
  timeline: { truncated: false, facts: [], sections: [section1([...gen1(), handed(), returned()])] },
});

// ── open items, the integration read and the tasks ─────────────────────────────────────────────

const facts = { task: { id: ID.task, title: TASK }, targetRef: `refs/heads/${BRANCH}`, targetSha: '41ac9e0b3',
  files: ['app/src/main/java/notify/ColdStartRouter.kt', 'app/src/main/java/session/SessionListStore.kt'],
  nothingLanded: true, check: null, branchUnchanged: false, errorCode: null, failure: null };
const itemRow = (o = {}) => ({
  itemId: ID.item, kind: 'INTEGRATION_CONFLICT', title: `Conflict while rebasing onto ${BRANCH}: ${TASK}`, detailLine: '',
  assignee: 'COORDINATOR', assigneeReason: 'DEFAULT', waitingSince: local(10, 2, 30), escalateAt: null, escalatedAt: null,
  taskId: ID.task, sessionId: null, landingSessionId: ID.landing, integrationJobId: ID.job1, promotionId: null, fuseEpisodeId: null,
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null }, actions: [], question: null, facts, handling: null,
  workSession: { sessionId: ID.work, offeredAt: local(10, 2, 30), rounds: 0 }, ...o,
});
const other = {
  ...itemRow({ itemId: ID.item11k, kind: 'INTEGRATION_CHECK_FAILED', taskId: ID.task11k, title: `Checks failed on the combined tree: Task acceptance · ${TASKS.t11k}`,
    waitingSince: local(9, 48), facts: { ...facts, task: { id: ID.task11k, title: TASKS.t11k } }, workSession: null,
    delivery: { state: 'DELIVERED', sessionId: COORDINATOR, at: local(9, 48) } }),
};
const items = (o) => ({ needsYou: [], withCoordinator: [], withWorkSession: [], startRequest: null, settled: [], closedQuestions: [],
  readAt: local(10, 6), ...o });
const OPEN_ITEMS_FIXING = items({ withWorkSession: [itemRow()], withCoordinator: [other] });
const OPEN_ITEMS_AGAIN = items({ withWorkSession: [itemRow({ handling: { jobId: ID.job2, sessionId: ID.work, userId: null, at: local(10, 9) } })] });
const OPEN_ITEMS_RETURNED = items({
  withCoordinator: [itemRow({ waitingSince: local(10, 31), delivery: { state: 'DELIVERED', sessionId: COORDINATOR, at: local(10, 31) },
    workSession: { sessionId: ID.work, offeredAt: local(10, 2, 30), returnedAt: local(10, 31), returnReason: 'NO_NEW_COMMIT', rounds: 0 } })],
});

const liveJob = (o = {}) => ({
  jobId: ID.job2, kind: 'LAND_TASK', state: 'RUNNING', phase: 'CHECK', taskId: ID.task, taskTitle: TASK, generation: 2,
  startedAt: local(10, 10), queuedAt: local(10, 9), heartbeatAt: local(10, 11), runnerName: RUNNER, retriedBy: null,
  timedOut: false, limitSeconds: 600, retryable: false, landingSessionId: ID.landing, liveness: 'LIVE', claim: 1, round: 1,
  stepStartedAt: local(10, 10, 20), outputMovedAt: local(10, 11), typicalMs: 4 * MIN,
  check: { name: 'LANDING_CHECK', index: 1, count: 1, budgetSeconds: 1_800, startedAt: local(10, 10, 20) }, ...o,
});
const integration = (live) => ({
  line: 'PROJECT_BRANCH', lineAbsentReason: null, ref: BRANCH, upstreamRef: 'refs/heads/main', source: 'EXPLICIT',
  locked: true, startedAt: local(8, 0), mergeCheckCommand: 'npm test', mergeCheckCommandAbsentReason: null,
  mergeCheckTimeoutSeconds: 1_800, escalationSeconds: 7_200, commitsAheadOfUpstream: 3, commitsAheadOfUpstreamAbsentReason: null,
  lastUpstreamSyncAt: local(9, 0), lastUpstreamSyncAbsentReason: null, integratingCount: live ? 1 : 0, queuedCount: 0,
  mergeCheckOnTip: 'PASSING', inFlight: live ? liveJob() : null, inFlightJobs: live ? [liveJob()] : [],
  landTasks: live ? [{ taskId: ID.task, taskTitle: TASK, integration: { state: 'RUNNING', since: local(10, 10), handler: null, openItemId: null,
    jobId: ID.job2, checksRunningForMs: 60_000, landTask: { jobId: ID.job2, state: 'RUNNING', phase: 'CHECK', generation: '2',
      queuedAt: local(10, 9), startedAt: local(10, 10), heartbeatAt: local(10, 11), finishedAt: null, targetRef: `refs/heads/${BRANCH}`,
      waitMs: 30_000, blockingReason: null, landingSessionId: ID.landing } } }] : [],
  repository: 'example/notify-app', branches: null, deliveryMode: 'PLATFORM', deliveryModeChosenAt: null,
  landingCheck: { command: 'npm run check:landing', setBy: 'OWNER', setBySessionId: null, setAt: local(8, 0) },
  landingCheckCommand: 'npm run check:landing', landingCheckTimeoutSeconds: null, landingCheckCommandAbsentReason: null,
});
const projectDoc = {
  id: PROJECT, title: PROJECT_TITLE, status: 'OPEN', goal: 'Run the wiki server-side and give it the System model.',
  instructions: '', acceptanceCriteriaItems: [], createdAt: local(8, 0), updatedAt: local(10, 0), lastActivityAt: local(10, 5),
  _count: { tasks: 46 }, tasksByStatus: { OPEN: 2, DONE: 44 }, mainBranch: 'main',
  buckets: { running: 1, ready: 0, blocked: 1, awaitingVerification: 0, done: 44, failed: 0, cancelled: 0 },
  taskCounts: { done: 44, failed: 0, total: 46 },
  attention: { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, attentionSinceAt: null, nextCheckAt: null,
    ownerItems: [], coordinatorItems: null, startRequest: null },
  coordinatorEnabled: true, coordinatorSessionId: COORDINATOR, coordinatorActivity: { working: false, lastTurnAt: local(10, 5) },
  maxConcurrentTasks: 3, configRevision: '4', startedAt: local(8, 0), pausedAt: null, exceptionEscalationSeconds: 7_200,
  blockers: { open: [], resolved: [], resolvedCount: 0 },
  integration: { line: 'PROJECT_BRANCH', ref: BRANCH, upstreamRef: 'main', deliveryMode: 'PLATFORM', deliveryModeChosenAt: null },
  settingChanges: [],
};
const taskBase = {
  status: 'DONE', outcome: 'DONE', description: '', acceptanceCriteria: '', acceptanceCommand: null, acceptanceExpectedExitCode: null,
  completionCriterion: 'EVIDENCE_JUDGMENT', completionPolicy: 'MANUAL', createdAt: local(8, 0), updatedAt: local(10, 0),
  dueDate: null, runAt: null, parentTaskId: null, assignee: { id: FIXTURE_IDS.workspace, name: 'Orbit baseline' },
  assigneeId: FIXTURE_IDS.workspace, provider: 'claude', model: null, modelHint: null, modelHintReason: null,
  project: { id: PROJECT, title: PROJECT_TITLE, status: 'OPEN' }, projectId: PROJECT, list: null, listId: null, labels: [],
  autoRunWhenReady: true, unmetCount: 0, blocksCount: 0, topoLevel: 0, dependencyState: 'TERMINAL', childCount: 0,
  sessions: [], dependsOn: [], dependedOnBy: [], inputs: [], children: [], comments: [], workState: 'DONE', landingWaitCount: 0,
};
const none = { since: null, handler: null, openItemId: null, jobId: null, checksRunningForMs: null, landTask: null, mainBranch: 'main' };
const TASK_ROWS = [
  { ...taskBase, id: ID.task, title: TASK, integration: { ...none, state: 'FIXING', since: local(10, 2, 30), openItemId: ID.item, jobId: ID.job1, workSessionId: ID.work } },
  { ...taskBase, id: ID.task11k, title: TASKS.t11k, integration: { ...none, state: 'RUNNING', since: local(10, 3), jobId: sid(943), checksRunningForMs: 120_000 } },
  { ...taskBase, id: ID.task13f, title: TASKS.t13f, integration: { ...none, state: 'ON_INTEGRATION_LINE', since: local(9, 40) } },
  { ...taskBase, id: ID.task08l, title: TASKS.t08l, status: 'OPEN', outcome: 'OPEN', workState: 'RUNNING', dependencyState: 'READY', integration: { ...none, state: 'NOT_APPLICABLE' } },
];
const panorama = { buckets: { running: 1, ready: 0, blocked: 1, awaitingVerification: 0, done: 44, failed: 0, cancelled: 0, integrating: 2, onIntegrationLine: 41, onUpstream: 0, doneNotIntegrated: 0, waitingForLanding: 0 },
  shape: { taskCount: 46, edgeCount: 0, ratio: 0, maxDepth: 0, form: 'chain' } };

const ev = (seq, type, payload, ts, turnId = 'turn-fix') => ({ seq, type, payload, turnId, ts });
const EVENTS_CARD = [ev(1, 'user', { text: TURN_TEXT }, local(10, 2, 31))];
const EVENTS_AGAIN = [...EVENTS_CARD, ev(2, 'assistant', { text: REPLY }, local(10, 8, 50)), ev(3, 'turn_end', { subtype: 'success' }, local(10, 8, 55))];
const EVENTS_RETURNED = [...EVENTS_CARD, ev(2, 'assistant', { text: LAST_WORDS }, local(10, 30, 50)), ev(3, 'turn_end', { subtype: 'success' }, local(10, 30, 55))];

// ── scenes ─────────────────────────────────────────────────────────────────────────────────────

const pagePath = (sessionId) => `/sessions/${sessionId}?project=${PROJECT}`;
const SCENES = {
  'a1-session-card': {
    now: local(10, 6), path: pagePath(ID.work), ready: '.landing-fix-card',
    work: workSession({ status: 'RUNNING', runState: 'RUNNING', runStatus: 'RUNNING', engineTurnActive: true, sourceLanding: sourceLanding('CONFLICT', 'REBASE') }),
    events: EVENTS_CARD, landingRow: landingRow('FIXING'), landing: LANDING_FIXING, openItems: OPEN_ITEMS_FIXING, live: false,
  },
  'a2-session-again': {
    now: local(10, 11), path: pagePath(ID.work), ready: '.landing-fix-again',
    work: workSession({ sourceLanding: sourceLanding('RUNNING', 'CHECK'), lastAssistantText: REPLY }),
    events: EVENTS_AGAIN, landingRow: landingRow('IN_FLIGHT'), landing: LANDING_AGAIN_RUNNING, openItems: OPEN_ITEMS_AGAIN, live: true,
  },
  'b1-landing-fixing': {
    now: local(10, 6), path: pagePath(ID.landing), ready: '.landings-window-card.is-fixing', window: true,
    work: workSession({ status: 'RUNNING', runState: 'RUNNING', runStatus: 'RUNNING', sourceLanding: sourceLanding('CONFLICT', 'REBASE') }),
    events: EVENTS_CARD, landingRow: landingRow('FIXING'), landing: LANDING_FIXING, openItems: OPEN_ITEMS_FIXING, live: false,
  },
  'b2-landing-again': {
    now: local(10, 16), path: pagePath(ID.landing), ready: '[data-landing-fix-row="FIXED_BY_SESSION"]', window: true,
    work: workSession({ sourceLanding: { ...sourceLanding('LANDED'), settledAs: 'LANDED' }, lastAssistantText: REPLY }),
    events: EVENTS_AGAIN, landingRow: landingRow('SETTLED'), landing: LANDING_LANDED, openItems: items({}), live: false,
  },
  'c-handed-back': {
    now: local(10, 31, 20), path: pagePath(ID.landing), ready: '.landing-fix-quote', window: true,
    work: workSession({ sourceLanding: sourceLanding('CONFLICT', 'REBASE') }),
    events: EVENTS_RETURNED, landingRow: landingRow('AWAITING_DECISION'), landing: LANDING_RETURNED, openItems: OPEN_ITEMS_RETURNED, live: false,
  },
  'd-project': {
    now: local(10, 6), path: `/projects/${PROJECT}`, ready: '[data-landing-fix-item]',
    work: workSession({ status: 'RUNNING', runState: 'RUNNING', runStatus: 'RUNNING', sourceLanding: sourceLanding('CONFLICT', 'REBASE') }),
    events: EVENTS_CARD, landingRow: landingRow('FIXING'), landing: LANDING_FIXING, openItems: OPEN_ITEMS_FIXING, live: false,
    viewport: { width: 1440, height: 1500 },
    // e ②: the same page scrolled to its task list, where the row wears "Landing · fixing".
    also: { name: 'e-task-row', at: '[data-testid="project-task-integration"]' },
  },
};

function reads(scene) {
  const work = scene.work;
  return (p, q) => {
    if (p === '/api/projects/sidebar') return [projectDoc];
    if (p === '/api/projects') return [projectDoc];
    if (p === `/api/projects/${PROJECT}`) return projectDoc;
    if (p === `/api/projects/${PROJECT}/integration`) return integration(scene.live);
    if (p === `/api/projects/${PROJECT}/open-items`) return scene.openItems;
    if (p === `/api/projects/${PROJECT}/promotions/current`) return null;
    if (p === `/api/projects/${PROJECT}/promotions/merged`) return [];
    if (p === `/api/projects/${PROJECT}/coordinator/status`) {
      return {
        projectId: PROJECT, readAt: scene.now, state: 'OPEN',
        coordination: { sessionId: COORDINATOR, sessionIdAbsentReason: null, session: coordinator, sessionAbsentReason: null,
          coordinatorGeneration: '1', workspaceId: SESSION.workspaceId, workspaceIdAbsentReason: null, workspaceName: 'Orbit baseline',
          workspaceNameAbsentReason: null, agentId: null, agentIdAbsentReason: 'NOT_BOUND', agentName: null, agentNameAbsentReason: 'NOT_BOUND' },
        openability: { canOpen: true, willCreate: false, refusalCode: null, refusalDetail: null, refusalCodeAbsentReason: 'NOTHING_REFUSES',
          requiredAction: null, requiredActionAbsentReason: 'NOTHING_REFUSES',
          landing: { workspaceId: SESSION.workspaceId, workspaceIdAbsentReason: null, workspaceName: 'Orbit baseline', workspaceNameAbsentReason: null, agentId: null, agentName: null, fixed: false } },
      };
    }
    if (p.startsWith(`/api/projects/${PROJECT}/acceptance/criteria-decisions/pending`)) {
      return { projectId: PROJECT, readAt: scene.now, count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [], settled: [] };
    }
    if (p === `/api/projects/${PROJECT}/acceptance/confirmation`) {
      return { state: 'CONFIRMED', confirmed: true, currentVersion: { digest: 'c'.repeat(64), material: [] }, confirmation: null };
    }
    if (p === `/api/projects/${PROJECT}/tasks/page`) return { items: TASK_ROWS, nextCursor: null, total: TASK_ROWS.length };
    if (p === `/api/projects/${PROJECT}/panorama`) return panorama;
    if (p === `/api/projects/${PROJECT}/dependency-graph`) {
      return { marks: [], edges: [], taskCount: 46, folded: false, truncated: false, limits: { maxTasks: 1000, maxMarks: 1000 } };
    }
    if (p === '/api/sessions' && q.get('projectId') === PROJECT) {
      const completed = q.get('view') === 'completed';
      const row = scene.landingRow;
      const landings = q.get('includeLanding') === '1' && ((row.lifecycleState === 'COMPLETED') === completed) ? [row] : [];
      return [...(completed ? [] : [coordinator, work, ...otherMembers]), ...landings];
    }
    if (p === `/api/sessions/${COORDINATOR}`) return coordinator;
    if (p === `/api/sessions/${ID.work}`) return work;
    if (p === `/api/sessions/${ID.work}/events/page`) return { events: scene.events, hasMore: false };
    if (p === `/api/sessions/${ID.landing}`) return { ...scene.landingRow, landing: scene.landing };
    if (p === `/api/sessions/${COORDINATOR}/events/page`) return { events: [], hasMore: false };
    if (p.endsWith('/approvals') || p.endsWith('/turns') || p.endsWith('/background')) return [];
    if (p.endsWith('/created-tasks')) return { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] };
    if (p.startsWith('/api/sessions/') && p.endsWith('/diff')) return { files: [], patches: [] };
    if (p === '/api/auth/capabilities') return {};
    return undefined;
  };
}

async function fixDate(page, timestamp) {
  await page.addInitScript((at) => {
    window.Date = new Proxy(Date, {
      construct: (D, args) => Reflect.construct(D, args.length ? args : [at]),
      apply: (D) => new D(at).toString(),
      get: (D, key) => key === 'now' ? () => at : Reflect.get(D, key),
    });
  }, Date.parse(timestamp));
}

const browser = await chromium.launch();
const report = [];
for (const theme of THEMES) {
  for (const [name, scene] of Object.entries(SCENES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const context = await browser.newContext({ viewport: scene.viewport ?? { width: 1440, height: 1000 }, deviceScaleFactor: 2,
      colorScheme: theme, locale: 'en-US', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    const writes = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 400)}`); });
    await fixDate(page, scene.now);
    const fixtures = await installFixtures(page, { theme });
    const answer = reads(scene);
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== 'GET') {
        writes.push({ method: request.method(), path: url.pathname });
        return route.fallback();
      }
      const body = answer(url.pathname, url.searchParams);
      if (body !== undefined) return route.fulfill({ status: 200, json: body });
      return route.fallback();
    });
    await page.goto(`http://127.0.0.1:${PORT}${scene.path}`);
    let placed = true;
    try {
      await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 30_000 });
      await page.locator(scene.ready).first().waitFor({ timeout: 20_000 });
    } catch (error) {
      placed = false;
      errors.push(String(error).slice(0, 300));
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1_500);
    if (scene.window) {
      // The record of the focused landing, scrolled into view under its card.
      await page.locator(`[data-landing-entry="${ID.landing}"]`).first().evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
      await page.waitForTimeout(400);
    }
    const file = `${OUT}/${name}-${theme}.png`;
    await page.screenshot({ path: file, animations: 'disabled' });
    if (scene.also) {
      await page.locator(scene.also.at).first().evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${scene.also.name}-${theme}.png`, animations: 'disabled' });
    }
    const drawn = await page.evaluate(() => {
      const text = (selector) => [...document.querySelectorAll(selector)].map((el) => el.innerText.replace(/\s+\n/g, '\n').trim());
      return {
        card: text('.landing-fix-card'),
        again: text('.landing-fix-again'),
        columnCards: text('[data-landing-fix-card]'),
        rowLines: text('.session-preview').filter((line) => line.startsWith('Landing')),
        windowCard: text('.landings-window-card'),
        quote: text('.landing-fix-quote'),
        fixRows: text('[data-landing-fix-row]'),
        triggers: text('.landing-trigger, .landings-window-trigger'),
        footer: text('.landing-page-foot'),
        openItems: text('.project-open-items'),
        taskTags: text('[data-testid="project-task-integration"]'),
      };
    });
    report.push({ theme, scene: name, placed, errors, writes, unhandled: fixtures.unhandled, ...drawn });
    console.log(theme, name, JSON.stringify({ placed, errors: errors.map((e) => e.slice(0, 200)), unhandled: fixtures.unhandled.length }));
    await context.close();
  }
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
server.close();
