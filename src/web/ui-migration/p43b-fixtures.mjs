import { uuidToBase62 } from '@orbit/shared';
import { FIXED_NOW, FIXTURE_IDS } from './fixtures.mjs';

// P4.3b data: the project page's dependency graph with every kind of mark (a finished block, a run,
// a repeated motif, a parent's box, and tasks ready, blocked, running and failed) and its loading,
// failed, empty and truncated reads; the crossings card; a coordinator question; a merge into main;
// the done question; and the owner's own start of a project nobody started. Registered on top of
// installFixtures (later routes win), so every path not modeled here still falls through to the P0
// handler and its unhandled-request check. `state` is read on every request, so a test changes an
// answer before the step that asks. Synthetic, public test data only.
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);
const now = Date.parse(FIXED_NOW);
const at = (offset) => new Date(now + offset).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const earlier = '2026-09-27T10:00:00.000Z';
const PROJECT = FIXTURE_IDS.project;

// The ready and blocked tasks are the P0 project's own (fixtures.mjs), so a mark opens a task the P0
// handler serves.
export const P43B_IDS = {
  project: PROJECT, other: id('202'), parent: id('4320'), ready: id('112'), blocked: id('113'), failed: id('4360'),
  moveTask: id('4410'), question: id('4501'), doneRequest: id('4601'), promotion: id('4701'),
  crossingMove: id('4801'), crossingFile: id('4802'), crossingApplied: id('4803'), crossingDenied: id('4804'),
};
export const P43B_PATHS = { project: `/projects/${PROJECT}` };
export const CROSSING_REFUSAL = { code: 'MOVE_TASK_LANDING_IN_FLIGHT', message: 'The task is being landed right now; the request still waits.' };
export const ANSWER_REFUSAL = 'The coordinator withdrew this question before your answer arrived.';
export const MERGE_REFUSAL = 'main moved after the checks ran: the candidate is being checked again.';
export const DONE_REFUSAL = 'The criteria changed after the coordinator asked; read them again.';
export const DECLINE_REFUSAL = 'The coordinator has already been told the project is not done.';
export const START_REFUSAL = 'The acceptance criteria changed after this card was drawn.';
export const GRAPH_ERROR = 'Fixture: the dependency graph read timed out.';
export const CROSSINGS_ERROR = 'Fixture: the crossings read failed.';
const SEAL = `5eal${'0'.repeat(60)}`;

// The P0 project (fixtures.mjs), restated: the reads here answer it with fields the P0 page never
// needed — what done means so far, or that nobody has started it.
const buckets = { running: 0, ready: 1, blocked: 1, awaitingVerification: 0, done: 1, failed: 0, cancelled: 0 };
const attention = { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, attentionSinceAt: null, nextCheckAt: null, ownerItems: [], coordinatorItems: null, startRequest: null };
const criterion = { id: id('601'), key: 'visual-baseline', ordinal: 1, revision: 1, text: 'Representative browser scenes can be reproduced.', landing: 'UNKNOWN', satisfied: false };
const criterion2 = { id: id('602'), key: 'graph-semantics', ordinal: 2, revision: 1, text: 'The dependency graph opens, folds and navigates as before.', landing: 'UNKNOWN', satisfied: true };
function projectDocument({ started, done }) {
  return {
    id: PROJECT, title: 'Orbit UI migration', status: 'OPEN',
    goal: 'Preserve the familiar interface while moving to owned components.',
    instructions: 'Reuse design variables, themes, and existing business semantics.',
    acceptanceCriteriaItems: [criterion, criterion2],
    createdAt: earlier, updatedAt: earlier, lastActivityAt: FIXED_NOW, _count: { tasks: 3 },
    tasksByStatus: { OPEN: 2, DONE: 1 }, buckets, attention, coordinatorEnabled: false,
    maxConcurrentTasks: 2, configRevision: '1', startedAt: started ? earlier : null, pausedAt: null,
    blockers: { open: [], resolved: [], resolvedCount: 0 },
    coordinatorSessionId: null, exceptionEscalationSeconds: 7200,
    ...(done ? {
      derivedDone: {
        status: 'OPEN', done: false, withheld: ['CRITERION_UNMET'], confirmation: 'CONFIRMED',
        criteria: [
          { definitionId: criterion.id, satisfied: false, landing: 'UNKNOWN', landingReason: null },
          { definitionId: criterion2.id, satisfied: true, landing: 'LANDED', landingReason: null },
        ],
        counts: { criteria: 2, met: 1, landed: 1, onMain: 1, byReason: { IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 0, CODELESS: 0 } },
      },
    } : {}),
  };
}

const standing = (state) => ({
  state, confirmed: state === 'CONFIRMED',
  currentVersion: { digest: SEAL, material: [criterion, criterion2].map((c) => ({ definitionId: c.id, revision: 1, contentHash: `h${c.ordinal}` })) },
  confirmation: state === 'CONFIRMED' ? { criteriaDigest: SEAL, criteriaMaterial: [], confirmedAt: at(-2 * HOUR), confirmedById: FIXTURE_IDS.user } : null,
  changesSinceConfirmed: null,
  changesSinceConfirmedAbsentReason: state === 'CONFIRMED' ? 'UNCHANGED' : 'NEVER_CONFIRMED',
});

// ── The dependency graph ──────────────────────────────────────────────────────────────────────
const task = (suffix, title, status, over = {}) => ({
  kind: 'TASK', id: id(suffix), taskId: id(suffix), title, status, parentTaskId: null,
  dependencyState: status === 'DONE' ? 'TERMINAL' : 'READY', running: false, queued: false, autoRunWhenReady: true,
  workState: status === 'DONE' ? 'DONE' : status === 'FAILED' ? 'FAILED' : 'READY', completionCriterion: 'EVIDENCE_JUDGMENT',
  ...over,
});
const member = (suffix, title, status, over = {}) => ({ taskId: id(suffix), title, status, workState: status === 'DONE' ? 'DONE' : 'READY', ...over });
const marks = [
  // Two finished tasks in a row: this side folds them into one block.
  task('111', 'Inventory existing components', 'DONE'),
  task('4302', 'Capture the P0 baseline', 'DONE'),
  {
    kind: 'RUN', id: id('4310'), title: 'Shared overlays', taskCount: 4,
    statusCounts: { DONE: 2, IN_PROGRESS: 1, OPEN: 1 }, parentTaskId: null, expandable: true,
    members: [
      member('4311', 'Dialog and drawer', 'DONE'),
      member('4312', 'Menus and popovers', 'DONE'),
      member('4313', 'Selects and comboboxes', 'IN_PROGRESS', { running: true, workState: 'RUNNING' }),
      member('4314', 'Toasts in overlays', 'OPEN', { workState: 'BLOCKED' }),
    ],
  },
  // A parent with two subtasks: drawn as the box they sit in.
  task('4320', 'Decision cards', 'IN_PROGRESS', { running: true, workState: 'RUNNING', dependencyState: 'READY' }),
  task('4321', 'Evidence decision card', 'DONE', { parentTaskId: id('4320') }),
  task('4322', 'Owner confirmation card', 'IN_PROGRESS', { parentTaskId: id('4320'), running: true, workState: 'RUNNING' }),
  {
    kind: 'MOTIF', id: id('4330'), title: 'Compare one page', instanceCount: 4, taskCount: 8,
    statusCounts: { DONE: 5, IN_PROGRESS: 1, FAILED: 1, OPEN: 1 }, parentTaskId: null,
    samples: [
      member('4331', 'Compare the settings page', 'FAILED', { workState: 'FAILED' }),
      member('4332', 'Compare the wiki page', 'IN_PROGRESS', { running: true, workState: 'RUNNING' }),
      member('4333', 'Compare the runner page', 'DONE'),
    ],
  },
  task('112', 'Capture browser baselines', 'OPEN'),
  task('113', 'Migrate shared controls', 'OPEN', { workState: 'BLOCKED', dependencyState: 'BLOCKED' }),
  task('4360', 'Fix the toolbar overlap', 'FAILED', { dependencyState: 'TERMINAL' }),
  task('4370', 'Register the drift', 'OPEN', { workState: 'BLOCKED', dependencyState: 'BLOCKED_FAILED' }),
];
const edge = (from, to) => ({ sourceMarkId: id(from), targetMarkId: id(to) });
const edges = [
  edge('111', '4302'), edge('4302', '4310'), edge('4310', '4320'), edge('4302', '4330'), edge('4302', '112'),
  edge('4320', '113'), edge('112', '113'), edge('4330', '113'), edge('4302', '4360'), edge('4360', '4370'),
];
export const RICH_GRAPH = { marks, edges, taskCount: 18, folded: true, truncated: false, limits: { maxTasks: 500, maxMarks: 500 } };
export const EMPTY_GRAPH = { marks: [], edges: [], taskCount: 0, folded: false, truncated: false, limits: { maxTasks: 500, maxMarks: 500 } };
export const TRUNCATED_GRAPH = { ...RICH_GRAPH, truncated: true, taskCount: 500 };

// ── The crossings card ────────────────────────────────────────────────────────────────────────
const crossing = (suffix, over) => ({
  id: id(suffix), publicId: id(suffix),
  fromProjectId: PROJECT, fromProjectPublicId: PROJECT, toProjectId: P43B_IDS.other, toProjectPublicId: P43B_IDS.other,
  fromProject: { title: 'Orbit UI migration', status: 'OPEN' }, toProject: { title: 'Release documentation', status: 'DONE' },
  kind: 'FILE_TASK', subjectTaskId: null, subjectTask: null, requestedCriterion: null, withdrawnCriterion: null,
  crossingKey: `${suffix}c0ffee`.padEnd(64, '0'), state: 'PENDING', title: 'Write the migration notes', reason: null,
  requestedAt: at(-3 * HOUR), decidedAt: null, expiresAt: null, ...over,
});
const CROSSINGS = [
  crossing('4801', {
    kind: 'MOVE_TASK', subjectTaskId: P43B_IDS.moveTask, subjectTaskPublicId: P43B_IDS.moveTask,
    subjectTask: { id: P43B_IDS.moveTask, publicId: P43B_IDS.moveTask, title: 'Document the Orbit components' },
    requestedCriterion: { key: 'usage-notes', text: 'Every shared component has a usage note.' },
    withdrawnCriterion: { key: criterion.key, text: criterion.text },
    title: 'Document the Orbit components', reason: 'The release documentation project owns the usage notes.',
  }),
  crossing('4802', { reason: 'Notes for the people who upgrade.' }),
  crossing('4803', { state: 'APPLIED', title: 'Publish the component guide', decidedAt: at(-HOUR) }),
  crossing('4804', { state: 'DENIED', title: 'Rewrite the changelog', decidedAt: at(-2 * HOUR) }),
];

// ── Open items: a question, and the done question ────────────────────────────────────────────
const row = (over) => ({
  title: '', detailLine: '', assignee: 'OWNER', assigneeReason: 'DEFAULT', waitingSince: at(-40 * MIN),
  escalateAt: null, escalatedAt: null, taskId: null, sessionId: null, promotionId: null, fuseEpisodeId: null,
  facts: null, actions: [], delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null }, question: null, ...over,
});
const QUESTION = row({
  itemId: P43B_IDS.question, kind: 'COORDINATOR_QUESTION', title: 'Which batch lands first?',
  detailLine: 'Blocks 2 tasks',
  question: {
    question: 'P4.3a and P4.3b both change the project page. Both are ready to land, and the second one will have to merge the first. Which should land first?',
    options: [
      { label: 'The lists and toolbars first', description: 'The graph batch merges them afterwards.' },
      { label: 'The graph and cards first' },
    ],
    recommendedOption: 0, blocksTaskIds: [id('112'), id('113')], ifUnanswered: null,
  },
});
const DONE_ROW = row({
  itemId: P43B_IDS.doneRequest, kind: 'DONE_REQUEST', title: 'Is this project done?', waitingSince: at(-25 * MIN),
  doneRequest: {
    criteriaDigest: SEAL,
    judgment: 'Every batch landed and the final regression passed; one criterion is left for you to judge.',
    gaps: [{
      criterionKey: criterion.key, title: criterion.text,
      whyNotProven: 'The browser scenes were reproduced on Linux only.',
      coordinatorChecked: 'The P0 regression passed on the merged tip.',
      evidenceRefs: ['p0-standard'],
    }],
  },
});

// ── A merge into main the checks passed on ───────────────────────────────────────────────────
const PROMOTION = {
  promotionId: P43B_IDS.promotion, state: 'READY', sourceKind: 'PROJECT_BRANCH', sourceRef: 'project/orbit-ui-migration',
  sourceSha: '58f3a4709c1f4c2c0b0a9a1f3d7e5b6c8d9e0f12', upstreamRef: 'main', commitsAhead: 7, filesChanged: 18,
  taskIds: [id('112'), id('4320')],
  tasks: [{ taskId: id('112'), title: 'Capture browser baselines' }, { taskId: id('4320'), title: 'Decision cards' }],
  checks: [{ name: 'MERGE_CHECK', command: 'npm run build -w @orbit/web && npm run test -w @orbit/web', expectedExitCode: 0, exitCode: 0, timedOut: false, durationMs: 7 * MIN, outputTail: 'Test Files  368 passed\n' }],
  conflicts: [], upstreamShaChecked: '9a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
  upstream: { syncedAt: at(-12 * MIN), conflicts: false }, landsTreeSha: '58f3a4700000000000000000000000000000abcd',
  landsAs: 'MERGE_COMMIT', askedAt: at(-2 * HOUR), recheckedAt: null, recheck: null, decidedAt: null, merged: null,
};

/** A request held until `release()`: a read caught while it is still loading. */
export function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

/**
 * Install the P4.3b routes. `options`:
 *  - graph: 'rich' (default), 'p0' (the P0 page's three tasks), 'empty' or 'truncated';
 *  - started: false draws the owner's own Start… (the project document says nobody started it);
 *  - done: true gives the project what done means so far and a done question in its open items;
 *  - question, crossings, promotion: whether each of those is there.
 * `state` is read on every request: `holdGraph`/`holdCrossings`/`holdStanding` hold that read until
 * the gate is released, `graphError`/`crossingsError`/`standingError` fail it, and each write is
 * refused while its `refuse*` flag is set. `requests` are the writes and holds answered here.
 */
export async function installP43bFixtures(page, {
  graph = 'rich', started = true, done = false, question = false, crossings = true, promotion = false,
} = {}) {
  const requests = [];
  const state = {
    graph: graph === 'p0' ? null : graph === 'empty' ? EMPTY_GRAPH : graph === 'truncated' ? TRUNCATED_GRAPH : RICH_GRAPH,
    holdGraph: null, graphError: false, holdCrossings: null, crossingsError: false, holdStanding: null, standingError: false,
    refuseCrossing: true, refuseAnswer: true, refuseMerge: true, refuseDone: true, refuseDecline: true, refuseStart: true,
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path, searchParams } = new URL(request.url());
    const method = request.method();
    const record = () => requests.push({ method, path, query: searchParams.toString(), body: request.postData() });
    const json = (value, status = 200) => { record(); return route.fulfill({ status, json: value }); };
    const prefix = `/api/projects/${PROJECT}`;
    if (method === 'GET' && path === prefix) return json(projectDocument({ started, done }));
    if (method === 'GET' && path === `${prefix}/dependency-graph` && state.graph) {
      if (state.holdGraph) await state.holdGraph.promise;
      if (state.graphError) return json({ message: GRAPH_ERROR }, 503);
      return json(state.graph);
    }
    if (method === 'GET' && path === `${prefix}/handoffs`) {
      if (state.holdCrossings) await state.holdCrossings.promise;
      if (state.crossingsError) return json({ message: CROSSINGS_ERROR }, 503);
      return json(crossings ? CROSSINGS : []);
    }
    if (method === 'POST' && path.startsWith(`${prefix}/handoffs/`) && path.endsWith('/decision')) {
      if (state.refuseCrossing) return json(CROSSING_REFUSAL, 409);
      return json({ ok: true });
    }
    if (method === 'GET' && path === `${prefix}/open-items`) {
      return json({ needsYou: question ? [QUESTION] : [], withCoordinator: [], doneRequest: done ? DONE_ROW : null, startRequest: null });
    }
    if (method === 'POST' && path === `${prefix}/open-items/${P43B_IDS.question}/answer`) {
      if (state.refuseAnswer) return json({ message: ANSWER_REFUSAL }, 409);
      return json({ ok: true });
    }
    if (method === 'GET' && path === `${prefix}/promotions/current`) return json(promotion ? PROMOTION : null);
    if (method === 'POST' && path === `${prefix}/promotions/${P43B_IDS.promotion}/confirm`) {
      if (state.refuseMerge) return json({ message: MERGE_REFUSAL }, 409);
      return json({ ...PROMOTION, state: 'CONFIRMED' });
    }
    if (method === 'GET' && path === `${prefix}/acceptance/confirmation`) {
      if (state.holdStanding) await state.holdStanding.promise;
      if (state.standingError) return json({ message: 'Fixture: the confirmation read failed.' }, 503);
      return json(standing(done || started ? 'CONFIRMED' : 'UNCONFIRMED'));
    }
    if (method === 'POST' && path === `${prefix}/done`) {
      if (state.refuseDone) return json({ message: DONE_REFUSAL }, 409);
      return json({ id: PROJECT, status: 'DONE', doneAt: FIXED_NOW, doneBy: 'OWNER', acceptedGaps: [] });
    }
    if (method === 'POST' && path === `${prefix}/done-requests/${P43B_IDS.doneRequest}/decline`) {
      if (state.refuseDecline) return json({ message: DECLINE_REFUSAL }, 409);
      return json({ ok: true });
    }
    if (method === 'POST' && path === `${prefix}/start`) {
      if (state.refuseStart) return json({ message: START_REFUSAL }, 409);
      return json({ ok: true });
    }
    return route.fallback();
  });
  return { requests, state };
}
