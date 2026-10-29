// R29-10 evidence: the web's delivery mode, the two revision-29 items with their doors, the task rows'
// observation words and the Needs-you surfaces, on this worktree's real web app — its production build
// served from loopback, the repo's ui-migration REST fixtures, and each scene's reads layered over them
// (`page.route`, registered after the fixtures, so these answer first). Light and dark.
//
// usage: (cd src/web && npm run build) && unshare -n docs/evidence/landing-observation/web/rig/run-ns.sh [scene-theme ...]
// Writes <scene>-<theme>.png beside this directory, and prints one JSON line per shot: the text the
// shot drew, page errors, and any API call no fixture answered.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = path.resolve(HERE, '../../../../..');
const OUT = path.resolve(HERE, '..');
const DIST = process.env.DIST ?? `${W}/src/web/dist`;
const ONLY = process.argv.slice(2);
const FONTS = process.env.FONTCONFIG_FILE ?? '/mnt/data/pe-mock/fonts.conf';

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
const TITLE = 'Checkout redesign';
const COORDINATOR = SESSION.id;
const SHA = {
  picker: '9f1c2ab7e4d0b5a6c3f8e1d2a7b4c9e0f1a2b3c4',
  cards: '3b7e0d91a6c2f4e8b1d9a7c3e5f2b8d4a6c1e9f7',
  login: '7d3e9b01c2a4e6f8a1b3c5d7e9f1a3b5c7d9e1f3',
};

// ── the project ────────────────────────────────────────────────────────────────────────────────

const criteria = [{ id: id(601), key: 'checkout-flow', ordinal: 1, revision: 1, text: 'A buyer can pay with a saved card in two taps.', landing: 'UNKNOWN', satisfied: false }];
const attentionNone = { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, attentionSinceAt: null, nextCheckAt: null, ownerItems: [], coordinatorItems: null, startRequest: null };

function projectDoc({ line, deliveryMode, started = true, ownerItems = [], coordinatorItems = null }) {
  return {
    id: PROJECT_ID, title: TITLE, status: 'OPEN',
    goal: 'A buyer pays with a saved card in two taps, on the web and on the phone.',
    instructions: 'Keep the existing payment provider. Every task lands on main.',
    acceptanceCriteriaItems: criteria,
    createdAt: earlier, updatedAt: earlier, lastActivityAt: FIXED_NOW, _count: { tasks: 4 },
    tasksByStatus: { OPEN: 1, DONE: 3 },
    buckets: { running: 0, ready: 0, blocked: 1, awaitingVerification: 0, done: 3, failed: 0, cancelled: 0 },
    attention: { ...attentionNone, ownerItems, coordinatorItems },
    coordinatorEnabled: true, coordinatorSessionId: COORDINATOR,
    maxConcurrentTasks: 3, configRevision: '4', startedAt: started ? at(26 * HOUR) : null, pausedAt: null,
    exceptionEscalationSeconds: 7200,
    blockers: { open: [], resolved: [], resolvedCount: 0 },
    mainBranch: 'main',
    integration: line ? {
      line, ref: line === 'MAIN' ? 'main' : `project/${PROJECT_ID}`, upstreamRef: 'main',
      deliveryMode, deliveryModeChosenAt: deliveryMode === 'AGENT_PUSH' ? at(20 * HOUR) : null,
    } : null,
  };
}

function integrationView({ line, deliveryMode, locked = true }) {
  return {
    line, lineAbsentReason: line ? null : 'NOT_DECIDED',
    ref: line === 'MAIN' ? 'main' : line === 'PROJECT_BRANCH' ? `project/${PROJECT_ID}` : null,
    upstreamRef: 'main', upstreamChosenAt: null, lastMainBranch: null,
    source: line ? 'EXPLICIT' : null, locked, startedAt: locked ? at(26 * HOUR) : null,
    mergeCheckCommand: 'npm ci && npm test', mergeCheckCommandAbsentReason: null, mergeCheckTimeoutSeconds: null,
    escalationSeconds: 7200,
    commitsAheadOfUpstream: null, commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET',
    lastUpstreamSyncAt: null, lastUpstreamSyncAbsentReason: 'NEVER_SYNCED',
    integratingCount: 0, queuedCount: 0, mergeCheckOnTip: 'UNKNOWN', inFlight: null, inFlightJobs: [],
    repository: 'example/checkout', branches: null,
    deliveryMode, deliveryModeChosenAt: deliveryMode === 'AGENT_PUSH' ? at(20 * HOUR) : null,
  };
}

const taskBase = {
  status: 'DONE', outcome: 'DONE', description: '', acceptanceCriteria: 'Covered by the checkout flow tests.',
  acceptanceCommand: null, acceptanceExpectedExitCode: null, completionCriterion: 'EVIDENCE_JUDGMENT', completionPolicy: 'MANUAL',
  createdAt: earlier, updatedAt: earlier, dueDate: null, runAt: null, parentTaskId: null,
  assignee: { id: FIXTURE_IDS.workspace, name: 'Orbit baseline' }, assigneeId: FIXTURE_IDS.workspace,
  provider: 'claude', model: null, modelHint: null, modelHintReason: null,
  project: { id: PROJECT_ID, title: TITLE, status: 'OPEN' }, projectId: PROJECT_ID, list: null, listId: null, labels: [],
  autoRunWhenReady: true, unmetCount: 0, blocksCount: 0, topoLevel: 0, dependencyState: 'TERMINAL', childCount: 0,
  sessions: [], dependsOn: [], dependedOnBy: [], inputs: [], children: [], comments: [],
  workState: 'DONE', landingWaitCount: 0,
};
const integration = (state, over = {}) => ({
  state, since: at(12 * MIN), handler: null, openItemId: null, jobId: null, checksRunningForMs: null,
  landTask: null, mainBranch: 'main', ...over,
});
const agentPushTasks = [
  { ...taskBase, id: id(711), title: 'Ship the delivery mode picker', blocksCount: 1,
    integration: integration('AWAITING_OBSERVATION', { deliveredSha: SHA.picker }) },
  { ...taskBase, id: id(712), title: 'Draw the observation cards',
    integration: integration('AWAITING_OBSERVATION', { deliveredSha: null }) },
  { ...taskBase, id: id(713), title: 'Fix the login redirect', integration: integration('ON_UPSTREAM', { since: at(3 * HOUR) }) },
  { ...taskBase, id: id(714), title: 'Pay with a saved card', status: 'OPEN', outcome: 'OPEN', workState: 'BLOCKED',
    dependencyState: 'BLOCKED', topoLevel: 1, landingWaitCount: 1, integration: integration('NOT_APPLICABLE', { since: null }) },
];

// ── the items ──────────────────────────────────────────────────────────────────────────────────

const itemBase = {
  assigneeReason: 'DEFAULT', escalateAt: null, escalatedAt: null, promotionId: null, fuseEpisodeId: null,
  question: null, facts: null, handling: null, outcome: null,
};
/** Work its agent pushed that the observation could not find on main (§10.7, the coordinator's). */
const UNOBSERVED = {
  ...itemBase,
  itemId: id(801), kind: 'LANDING_UNOBSERVED',
  title: 'Not on main yet: Ship the delivery mode picker',
  detailLine: `Its changes are there as other commits · delivered ${SHA.picker.slice(0, 12)}`,
  assignee: 'COORDINATOR', waitingSince: at(25 * MIN), escalateAt: new Date(NOW + 95 * MIN).toISOString(),
  taskId: id(711), sessionId: id(721),
  delivery: { state: 'DELIVERED', sessionId: COORDINATOR, at: at(24 * MIN) },
  actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'OBSERVE', 'CANCEL_TASK'],
  primaryAction: 'OPEN_TASK_SESSION',
  requiredAction: 'This task’s work is not on main yet — record the commit that carries it, or send the task back to push it.',
};
/** The same kind, handed to the owner, with the observation the owner asked for running (§10.8 H1). */
const UNOBSERVED_OWNER = {
  ...itemBase,
  itemId: id(802), kind: 'LANDING_UNOBSERVED',
  title: 'Not on main yet: Draw the observation cards',
  detailLine: `Its commit was not found on the line · delivered ${SHA.cards.slice(0, 12)}`,
  assignee: 'OWNER', assigneeReason: 'HANDED_OVER', waitingSince: at(70 * MIN), escalatedAt: at(9 * MIN),
  handoverNote: null,
  taskId: id(712), sessionId: id(722),
  delivery: { state: 'DELIVERED', sessionId: COORDINATOR, at: at(69 * MIN) },
  actions: ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'OBSERVE', 'CANCEL_TASK'],
  primaryAction: 'ASK_COORDINATOR_AGAIN',
  requiredAction: 'This task’s work is not on main yet — record the commit that carries it, or send the task back to push it.',
  handling: {
    sessionId: null, userId: FIXTURE_IDS.user, reason: 'I pushed the rebased commit to main by hand',
    startedAt: at(2 * MIN), jobId: id(831), jobKind: 'OBSERVE_LANDING', generation: 3, state: 'RUNNING',
  },
};
/** The project's observations failing three times running (§10.6 O-J4): about the line, no task. */
const OBSERVE_FAILING = {
  ...itemBase,
  itemId: id(803), kind: 'INTEGRATION_ERROR',
  title: 'Integration error: observing main',
  detailLine: '',
  assignee: 'COORDINATOR', waitingSince: at(40 * MIN), escalateAt: new Date(NOW + 80 * MIN).toISOString(),
  taskId: null, sessionId: null,
  delivery: { state: 'DELIVERED', sessionId: COORDINATOR, at: at(39 * MIN) },
  actions: ['OBSERVE'], primaryAction: 'OBSERVE',
  requiredAction: 'Finished work is not recorded as landed until an observation of main succeeds — let a runner reach the repository, then look again.',
  facts: { task: null, targetRef: 'main', targetSha: null, files: [], nothingLanded: false, check: null, branchUnchanged: false, errorCode: 'FETCH_FAILED', failure: null },
};
/** Work that reached main without the owner's confirmation, in a PLATFORM project (§10.7, O-R3). */
const LANDED = {
  ...itemBase,
  itemId: id(804), kind: 'LANDED_WITHOUT_CONFIRMATION',
  title: 'Reached main without your confirmation: Fix the login redirect',
  detailLine: `${SHA.login.slice(0, 12)} is on main · seen by Orbit`,
  assignee: 'OWNER', waitingSince: at(2 * HOUR),
  taskId: id(713), sessionId: id(723),
  delivery: { state: 'NOT_REQUIRED', sessionId: COORDINATOR, at: null },
  actions: ['ACCEPT', 'OPEN_TASK_SESSION'], primaryAction: 'ACCEPT',
  requiredAction: 'This work reached main without your confirmation — accept it, or use Chat about this to have the coordinator file a task that reverts it.',
};

const items = (needsYou, withCoordinator) => ({ needsYou, withCoordinator, startRequest: null, settled: [], closedQuestions: [] });

// ── the coordinator's conversation ─────────────────────────────────────────────────────────────

const turn = (seq, ts, user, assistant) => [
  { seq, type: 'user', payload: { text: user }, turnId: `turn-${seq}`, ts },
  { seq: seq + 1, type: 'assistant', payload: { text: assistant }, turnId: `turn-${seq}`, ts },
  { seq: seq + 2, type: 'turn_end', payload: { subtype: 'success' }, turnId: `turn-${seq}`, ts },
];
const EVENTS = [
  ...turn(1, at(3 * HOUR), 'Keep the saved-card flow on the existing provider.', 'Filed the plan: four tasks, each pushed to main by its agent.'),
  ...turn(4, at(50 * MIN), 'How is the picker doing?', 'Its agent rebased before pushing, so the commit on main is not the one it delivered. Looking into it.'),
  ...turn(7, at(5 * MIN), 'Anything I need to do?', 'One item is yours now; the rest I am handling.'),
];
function coordinatorRow({ ownerItems = [] } = {}) {
  return {
    ...SESSION,
    title: TITLE, projectId: PROJECT_ID, projectTitle: TITLE,
    projectMembership: { projectId: PROJECT_ID, projectTitle: TITLE, projectStatus: 'OPEN', role: 'COORDINATOR' },
    status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
    engineTurnActive: false, lastTurnAt: at(5 * MIN), updatedAt: at(5 * MIN), createdAt: at(4 * HOUR),
    pendingApprovals: ownerItems.length, waitingKind: ownerItems.length ? 'OWNER_ITEM' : null, ownerItems,
  };
}

// ── the scenes ─────────────────────────────────────────────────────────────────────────────────

/** The criteria as a start card reads them: nobody confirmed them yet. A started project's scenes read
 *  them confirmed, so no settlement card joins what the pinned line counts. */
const CONFIRMED = { state: 'CONFIRMED', confirmed: true, currentVersion: { digest: 'c'.repeat(64), material: [] }, confirmation: null };
const STANDING = {
  state: 'UNCONFIRMED', confirmed: false,
  currentVersion: { digest: 'c'.repeat(64), material: criteria.map((c) => ({ definitionId: c.id, revision: 1, contentHash: 'h1' })) },
  confirmation: null, changesSinceConfirmed: null, changesSinceConfirmedAbsentReason: 'NEVER_CONFIRMED',
};
const GRAPH_CHAIN = {
  marks: agentPushTasks.map((t) => ({ kind: 'TASK', id: t.id, taskId: t.id, title: t.title, status: 'OPEN', parentTaskId: null, completionCriterion: 'EVIDENCE_JUDGMENT', autoRunWhenReady: true })),
  edges: [], taskCount: 4, folded: false, truncated: false, limits: { maxTasks: 1000, maxMarks: 1000 },
};
const panorama = { buckets: { running: 0, ready: 0, blocked: 1, awaitingVerification: 0, done: 3, failed: 0, cancelled: 0, integrating: 2, onIntegrationLine: 0, onUpstream: 1, doneNotIntegrated: 0, waitingForLanding: 1 }, shape: { taskCount: 4, edgeCount: 1, ratio: 0.25, maxDepth: 1, form: 'chain' } };

/** The reads every project scene shares; `over` answers first. */
function projectReads({ doc, view, openItems, tasks = agentPushTasks, graph = GRAPH_CHAIN, over = {} }) {
  return {
    [`/api/projects/${PROJECT_ID}`]: doc,
    [`/api/projects/${PROJECT_ID}/integration`]: view,
    [`/api/projects/${PROJECT_ID}/open-items`]: openItems,
    [`/api/projects/${PROJECT_ID}/tasks/page`]: { items: tasks, nextCursor: null, total: tasks.length },
    [`/api/projects/${PROJECT_ID}/panorama`]: panorama,
    [`/api/projects/${PROJECT_ID}/dependency-graph`]: graph,
    [`/api/projects/${PROJECT_ID}/acceptance/confirmation`]: doc.startedAt ? CONFIRMED : STANDING,
    [`/api/projects/${PROJECT_ID}/acceptance/criteria-decisions/pending`]: { readAt: FIXED_NOW, projectId: PROJECT_ID, count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [], settled: [] },
    [`/api/projects/${PROJECT_ID}/promotions/merged`]: [],
    '/api/projects/sidebar': [{ ...doc, taskCounts: { done: 3, failed: 0, total: 4 } }],
    '/api/projects': [doc],
    ...over,
  };
}

const AGENT_PUSH = projectReads({
  doc: projectDoc({ line: 'MAIN', deliveryMode: 'AGENT_PUSH', coordinatorItems: { count: 2, leadKind: 'LANDING_UNOBSERVED', oldestWaitingSince: at(40 * MIN), nextEscalationAt: new Date(NOW + 80 * MIN).toISOString() } }),
  view: integrationView({ line: 'MAIN', deliveryMode: 'AGENT_PUSH' }),
  openItems: items([UNOBSERVED_OWNER], [{ ...UNOBSERVED, handling: { sessionId: COORDINATOR, userId: null, reason: 'its agent says it pushed again after the rebase', startedAt: at(4 * MIN), jobId: id(832), jobKind: 'OBSERVE_LANDING', generation: 4, state: 'QUEUED' } }, OBSERVE_FAILING]),
});
const CARDS_AGENT_PUSH = projectReads({
  doc: AGENT_PUSH[`/api/projects/${PROJECT_ID}`],
  view: integrationView({ line: 'MAIN', deliveryMode: 'AGENT_PUSH' }),
  openItems: items([UNOBSERVED_OWNER], [UNOBSERVED, OBSERVE_FAILING]),
});
const landedOwnerItem = { itemId: LANDED.itemId, kind: 'LANDED_WITHOUT_CONFIRMATION', title: LANDED.title, since: LANDED.waitingSince, need: 'Landed without your confirmation', mainBranch: 'main' };
const PLATFORM = projectReads({
  doc: projectDoc({ line: 'MAIN', deliveryMode: 'PLATFORM', ownerItems: [{ kind: 'LANDED_WITHOUT_CONFIRMATION', count: 1, oldestWaitingSince: LANDED.waitingSince }] }),
  view: integrationView({ line: 'MAIN', deliveryMode: 'PLATFORM' }),
  openItems: items([LANDED], []),
  tasks: agentPushTasks.map((t) => ({ ...t, integration: integration('ON_UPSTREAM', { since: at(2 * HOUR) }) })),
});
const PROJECT_BRANCH = projectReads({
  doc: projectDoc({ line: 'PROJECT_BRANCH', deliveryMode: 'PLATFORM' }),
  view: integrationView({ line: 'PROJECT_BRANCH', deliveryMode: 'PLATFORM' }),
  openItems: items([], []),
});
const notStarted = (line) => projectReads({
  doc: projectDoc({ line: null, deliveryMode: 'PLATFORM', started: false }),
  view: { ...integrationView({ line, deliveryMode: 'PLATFORM', locked: false }), mergeCheckCommand: null, mergeCheckCommandAbsentReason: 'NOT_CONFIGURED' },
  openItems: items([], []),
  graph: line === 'PROJECT_BRANCH' ? { ...GRAPH_CHAIN, edges: [{ sourceMarkId: id(711), targetMarkId: id(714) }] } : GRAPH_CHAIN,
});

const conversation = (reads, ownerItems) => ({
  ...reads,
  [`/api${`/sessions/${COORDINATOR}`}`]: coordinatorRow({ ownerItems }),
  '/api/sessions': [coordinatorRow({ ownerItems })],
  [`/api/sessions/${COORDINATOR}/events/page`]: { events: EVENTS, hasMore: false },
  '/api/auth/capabilities': {},
});

/** A run of an OWNER_CONFIRMED task in an AGENT_PUSH project, waiting on its owner: what confirming
 *  sets off ends with the agent's push, and no merge card follows (§10.5 O-L2, R29-9 `AGENT_PUSHED`). */
const CONFIRMING = {
  taskId: FIXTURE_IDS.task, title: 'Fix the login redirect', status: 'IN_PROGRESS', projectId: PROJECT_ID,
  completionCriterion: 'OWNER_CONFIRMED',
  acceptanceCriteria: 'Signing in from a product page returns the buyer to that page.',
  waiting: {
    requestId: id(901), sessionId: COORDINATOR, requestedAt: at(6 * MIN),
    report: { text: 'Fixed the redirect and pushed it to main: signing in keeps the page the buyer came from.', reportedAt: at(6 * MIN) },
    review: null,
  },
  decisions: [],
  ifConfirmed: {
    startsTasks: [{ id: id(714), title: 'Pay with a saved card', starts: 'NOW' }],
    startsAfterLanding: true,
    branch: { name: 'orbit/fix-login-redirect-7d3e9b', linesAdded: 42, linesRemoved: 7, files: 3, onMain: 'NO' },
    landing: 'AGENT_PUSHED', mainBranch: 'main',
    endsSession: { sessionId: COORDINATOR, runningBgJobs: 0 },
  },
  reviewerReturns: [],
};
const taskRun = {
  ...SESSION, title: 'Fix the login redirect', taskId: FIXTURE_IDS.task, projectId: PROJECT_ID, projectTitle: TITLE,
  status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', engineTurnActive: false,
  pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION', lastTurnAt: at(6 * MIN), updatedAt: at(6 * MIN), createdAt: at(HOUR),
};
const CONFIRMATION_RUN = {
  ...AGENT_PUSH,
  [`/api/sessions/${COORDINATOR}`]: taskRun,
  '/api/sessions': [taskRun],
  [`/api/sessions/${COORDINATOR}/events/page`]: { events: turn(1, at(6 * MIN), 'Fix the login redirect.', CONFIRMING.waiting.report.text), hasMore: false },
  [`/api/tasks/${FIXTURE_IDS.task}/owner-confirmation`]: CONFIRMING,
  '/api/auth/capabilities': {},
};

const PROJECT_PATH = `/projects/${PROJECT_ID}`;
const SESSION_PATH = `/sessions/${COORDINATOR}`;

async function openStart(page) {
  await page.locator('.project-open-item-start').first().click();
  await page.locator('.start-card-dialog .start-card').waitFor();
  await page.locator('.start-card-dialog .start-card-plan span').first().waitFor();
}
async function chooseDelivery(page, label) {
  const row = page.locator('.start-card-dialog .start-card-row').filter({ has: page.locator('.start-card-row-head > span', { hasText: 'Delivery' }) });
  await row.locator('[role="combobox"]').click();
  await page.locator('[role="listbox"] [role="option"]').filter({ hasText: label }).first().click();
  await page.waitForTimeout(300);
}

const SCENES = {
  // The start card on a main line: both ways on offer, the agent's chosen.
  'start-agent-push': {
    path: PROJECT_PATH, reads: notStarted('MAIN'), ready: '.project-open-item-start',
    act: async (page) => { await openStart(page); await chooseDelivery(page, 'The agent pushes it'); },
    shot: '.start-card-dialog .start-card-settings',
  },
  // …and the menu itself, open.
  'start-delivery-menu': {
    path: PROJECT_PATH, reads: notStarted('MAIN'), ready: '.project-open-item-start',
    act: async (page) => {
      await openStart(page);
      const row = page.locator('.start-card-dialog .start-card-row').filter({ has: page.locator('.start-card-row-head > span', { hasText: 'Delivery' }) });
      await row.locator('[role="combobox"]').click();
      await page.locator('[role="listbox"] [role="option"]').first().waitFor();
      await page.waitForTimeout(400);
    },
    union: ['.start-card-dialog .start-card-settings', '[role="listbox"]'],
  },
  // On a project branch the agent cannot push: locked on Orbit's, with the reason.
  'start-project-branch': {
    path: PROJECT_PATH, reads: notStarted('PROJECT_BRANCH'), ready: '.project-open-item-start',
    act: openStart, shot: '.start-card-dialog .start-card-settings',
  },
  // How it runs on a started main line whose agent pushes — the delivery mode does not lock.
  'settings-agent-push': {
    path: PROJECT_PATH, reads: AGENT_PUSH, ready: '.project-run-settings .project-run-delivery',
    shot: '.project-run-settings',
  },
  'settings-project-branch': {
    path: PROJECT_PATH, reads: PROJECT_BRANCH, ready: '.project-run-settings .project-run-delivery',
    shot: '.project-run-settings',
  },
  // The task rows: waiting to be seen (with and without a frozen commit), seen, and the one waiting on them.
  'task-rows': {
    path: PROJECT_PATH, reads: AGENT_PUSH, ready: '[data-integration-state="AWAITING_OBSERVATION"]',
    shot: '[data-project-block="tasks"] > div',
  },
  // The project page's Open items: the observation in flight, and the failing observations' item.
  'open-items-agent-push': {
    path: PROJECT_PATH, reads: AGENT_PUSH, ready: '.project-open-items .project-open-item-row',
    shot: '[data-project-block="open-items"] .project-open-items',
  },
  'open-items-platform': {
    path: PROJECT_PATH, reads: PLATFORM, ready: '.project-open-items .project-open-item-row',
    shot: '[data-project-block="open-items"] .project-open-items',
  },
  // The coordinator's conversation: the cards, at the moments they happened.
  'card-landing-unobserved': {
    path: SESSION_PATH, reads: conversation(CARDS_AGENT_PUSH, []), ready: `[data-open-item="${UNOBSERVED.itemId}"]`,
    shot: `[data-open-item="${UNOBSERVED.itemId}"]`,
  },
  'card-observing': {
    path: SESSION_PATH, reads: conversation(CARDS_AGENT_PUSH, []), ready: `[data-open-item="${UNOBSERVED_OWNER.itemId}"]`,
    shot: `[data-open-item="${UNOBSERVED_OWNER.itemId}"]`,
  },
  'card-observe-failing': {
    path: SESSION_PATH, reads: conversation(CARDS_AGENT_PUSH, []), ready: `[data-open-item="${OBSERVE_FAILING.itemId}"]`,
    shot: `[data-open-item="${OBSERVE_FAILING.itemId}"]`,
  },
  'observe-dialog': {
    path: SESSION_PATH, reads: conversation(CARDS_AGENT_PUSH, []), ready: `[data-open-item="${OBSERVE_FAILING.itemId}"]`,
    act: async (page) => {
      await page.locator(`[data-open-item="${OBSERVE_FAILING.itemId}"] button`).filter({ hasText: 'Observe again' }).click();
      const dialog = page.locator('[role="dialog"]');
      await dialog.waitFor();
      await dialog.locator('textarea').fill('The runner can reach the repository again — its deploy key was rotated.');
      await page.waitForTimeout(300);
    },
    shot: '[role="dialog"]',
  },
  'card-landed-without-confirmation': {
    path: SESSION_PATH, reads: conversation(PLATFORM, [landedOwnerItem]), ready: `[data-open-item="${LANDED.itemId}"]`,
    shot: `[data-open-item="${LANDED.itemId}"]`,
  },
  // The pinned line above the conversation names the item by its kind word.
  'pinned-strip': {
    path: SESSION_PATH, reads: conversation(PLATFORM, [landedOwnerItem]), ready: '.decision-strip-line',
    shot: '.decision-strip',
  },
  // The whole conversation, for where the cards sit: the pinned line over it, the cards at their moments.
  'conversation-agent-push': {
    path: SESSION_PATH, reads: conversation(CARDS_AGENT_PUSH, []), ready: `[data-open-item="${UNOBSERVED.itemId}"]`,
    viewport: { width: 1440, height: 1500 }, focus: `[data-open-item="${UNOBSERVED_OWNER.itemId}"]`, page: true,
  },
  'conversation-landed-without-confirmation': {
    path: SESSION_PATH, reads: conversation(PLATFORM, [landedOwnerItem]), ready: `[data-open-item="${LANDED.itemId}"]`,
    viewport: { width: 1440, height: 1000 }, focus: `[data-open-item="${LANDED.itemId}"]`, page: true,
  },
  // The owner confirmation card in an AGENT_PUSH project: If you confirm says the agent pushes it.
  'owner-confirmation-agent-pushed': {
    path: SESSION_PATH, reads: CONFIRMATION_RUN, ready: '.owner-confirmation-if',
    shot: '.owner-confirmation-if',
  },
  // The projects list: the owner tier's chip.
  'projects-list': {
    path: '/projects', reads: PLATFORM, ready: '.project-row-chip',
    shot: '.project-row-link',
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
await new Promise((resolve) => server.listen(5764, '127.0.0.1', resolve));
const BASE = 'http://127.0.0.1:5764';

async function shoot(browser, name, theme) {
  const scene = SCENES[name];
  const context = await browser.newContext({
    viewport: scene.viewport ?? { width: 1440, height: 2200 }, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US',
    timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await installFixedDate(page);
  const api = await installFixtures(page, { theme });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const where = new URL(request.url()).pathname;
    if (request.method() !== 'GET') return route.fulfill({ status: 200, json: {} });
    if (Object.hasOwn(scene.reads, where)) return route.fulfill({ status: 200, json: scene.reads[where] });
    return route.fallback();
  });
  await page.goto(BASE + scene.path);
  await page.locator(scene.ready).first().waitFor();
  await page.waitForFunction(() => !document.getElementById('boot'));
  if (scene.act) await scene.act(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const file = `${OUT}/${name}-${theme}.png`;
  let text;
  if (scene.page) {
    // The card the frame is about, brought into the conversation's view; the page as the reader sees it.
    await page.locator(scene.focus).first().evaluate((card) => card.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: file, animations: 'disabled' });
    text = await page.locator(scene.focus).first().innerText();
  } else if (scene.union) {
    const boxes = [];
    for (const selector of scene.union) {
      const box = await page.locator(selector).first().boundingBox();
      if (box) boxes.push(box);
    }
    const x = Math.min(...boxes.map((b) => b.x)) - 8;
    const y = Math.min(...boxes.map((b) => b.y)) - 8;
    const right = Math.max(...boxes.map((b) => b.x + b.width)) + 8;
    const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 8;
    await page.screenshot({ path: file, clip: { x, y, width: right - x, height: bottom - y }, animations: 'disabled' });
    text = (await Promise.all(scene.union.map((s) => page.locator(s).first().innerText()))).join('\n---\n');
  } else {
    const target = page.locator(scene.shot).first();
    await target.scrollIntoViewIfNeeded();
    await target.screenshot({ path: file, animations: 'disabled' });
    text = await target.innerText();
  }
  await context.close();
  return { scene: name, theme, file: path.relative(W, file), text, errors, unhandled: api.unhandled };
}

const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: FONTS }, args: ['--disable-features=BackForwardCache'] });
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
