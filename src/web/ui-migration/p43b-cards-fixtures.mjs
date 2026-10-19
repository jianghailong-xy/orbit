import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIXED_NOW } from './fixtures.mjs';

// REST data for the P4.3b decision-card harness (p43b-cards.html): a pending evidence decision and a
// submission waiting on the reader's own resubmission, an OWNER_CONFIRMED task waiting in this session
// with a review that asks its owner two questions, a held criteria proposal, the late review a
// confirmation can carry, and a project nobody started whose start request no longer stands. Every
// write is refused, with the server's reason, so each card's refusal is drawn. Registered on top of
// installFixtures (later routes win); anything not modeled here still falls through to the P0 handler
// and its unhandled-request check. Synthetic, public test data only.
export const CARD_IDS = JSON.parse(readFileSync(fileURLToPath(new URL('./p43b-cards-ids.json', import.meta.url)), 'utf8'));
const reviews = JSON.parse(readFileSync(fileURLToPath(new URL('../../shared/src/owner-confirmation-review.fixture.json', import.meta.url)), 'utf8'));
const review = (starting) => structuredClone(reviews.bars.find((each) => each.case.startsWith(starting)).review);
export const CARDS_PATH = '/ui-migration/p43b-cards.html';
export const EVIDENCE_REFUSAL = 'The evidence changed while this card was open.';
export const EVIDENCE_STALE = { code: 'EVIDENCE_JUDGMENT_ALREADY_DECIDED', message: 'This version was decided in another conversation.' };
export const OWNER_REFUSAL = 'The run reported again while this card was open.';
export const CRITERIA_REFUSAL = 'The criteria in force moved after this proposal was filed.';
export const REOPEN_REFUSAL = 'Fixture: the task changed while this question was open.';
const now = Date.parse(FIXED_NOW);
const at = (offset) => new Date(now + offset).toISOString();
const MIN = 60_000;
const SEAL = '6b1d02e4c8a1f3d5b7e9a2c4f6081a3c5e7f9b1d3a5c7e9f1b3d5a7c9e1f3b5d';

const evidenceRow = (over = {}) => ({
  taskId: CARD_IDS.evidenceTask, title: 'Migrate the dependency graph to Orbit components', projectId: CARD_IDS.project,
  criterion: { key: '7L4At4DOupG7FwgxfXykzS', text: 'The graph opens, folds and navigates as before.' },
  evidenceRevision: '2', ageSeconds: 10 * 60,
  claim: 'The graph and its full screen draw as the reference does in eight environments; the remove question asks first.',
  gaps: ['Real devices were not used.', 'Screen readers were not listened to.'],
  citations: [{ kind: 'TOOL_CALL', ref: 'toolu_p43b', resolved: true, reason: null, label: 'Bash · npx playwright test p43b' }],
  decidability: { decidable: true, refusal: null, requiredAction: null },
  independence: { independent: true, disqualification: null, requiredAction: null },
  ...over,
});
const QUEUE = {
  decidingSessionId: CARD_IDS.session, count: 1, oldestAgeSeconds: 10 * 60,
  pending: [evidenceRow()],
  waitingOnYou: [evidenceRow({
    taskId: 'p43b-resubmit', title: 'Record the drift registration', criterion: null, claim: '', citations: [],
    decidability: {
      decidable: false,
      refusal: 'this evidence quotes no project criterion, so there is no stated standard to decide it against',
      requiredAction: 'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
    },
  })],
};

const OWNER_VIEW = {
  taskId: CARD_IDS.ownerTask, title: 'File the September invoices', status: 'OPEN', projectId: null,
  completionCriterion: 'OWNER_CONFIRMED', acceptanceCriteria: 'Every September invoice is filed once, and summary.csv matches the statement.',
  waiting: {
    requestId: '01920000-0000-7000-8000-0000000000f1', sessionId: CARD_IDS.session, requestedAt: at(-12 * MIN),
    report: { text: 'Done. 38 invoices are filed under finance/2026-09/.', reportedAt: at(-12 * MIN) },
    review: review('reviewed with questions for the owner, on the card'),
  },
  decisions: [],
};

const proposed = (over = {}) => ({ id: '3t4PyphGUWQtzDGfvOLY9R', ordinal: 1, text: 'Full API is green on the merge boundary', verificationMethod: 'EXECUTABLE', completionCriterionOverrideReason: null, ...over });
const entry = (over = {}) => ({
  change: 'SAME', definitionId: '3t4PyphGUWQtzDGfvOLY9R', ordinal: 1,
  proposed: { text: 'Full API is green on the merge boundary', verificationMethod: 'EXECUTABLE', completionCriterionOverrideReason: null },
  onRecord: { text: 'Full API is green on the merge boundary', verificationMethod: 'EXECUTABLE', completionCriterionOverrideReason: null },
  changed: [], rewrites: [], ...over,
});
const entries = [
  entry({ change: 'CHANGED', changed: ['text'],
    onRecord: { text: 'Full API was green last week', verificationMethod: 'EXECUTABLE', completionCriterionOverrideReason: null },
    rewrites: [{ field: 'text', segments: [{ side: 'KEPT', text: 'Full API ' }, { side: 'REMOVED', text: 'was green last week' }, { side: 'ADDED', text: 'is green on the merge boundary' }] }] }),
  entry({ change: 'NEW', definitionId: null, ordinal: 2, onRecord: null,
    proposed: { text: 'the scheduled nodes are green', verificationMethod: 'EXECUTABLE', completionCriterionOverrideReason: null } }),
];
const CRITERIA_QUEUE = {
  readAt: FIXED_NOW, projectId: CARD_IDS.project, count: 1, oldestAgeSeconds: 12 * 60, decidableCount: 1,
  pending: [{
    intentId: CARD_IDS.intent, projectId: CARD_IDS.project, commitToken: CARD_IDS.commitToken, actionDigest: 'a'.repeat(64),
    filedAt: at(-12 * MIN), ageSeconds: 12 * 60, baselineSeal: SEAL, currentSeal: SEAL,
    proposed: [proposed(), proposed({ id: null, ordinal: 2, text: 'the scheduled nodes are green' })],
    diff: { entries, sameCount: 0, changedCount: 1, newCount: 1, removedCount: 0 },
    supersededIntentId: null, decidability: { decidable: true, refusal: null, requiredAction: null },
  }],
};

const START_STANDING = {
  state: 'UNCONFIRMED', confirmed: false, currentVersion: { digest: SEAL, material: [] }, confirmation: null,
  changesSinceConfirmed: null, changesSinceConfirmedAbsentReason: 'NEVER_CONFIRMED',
};
const START_PROJECT = {
  id: CARD_IDS.startProject, title: 'Release documentation', status: 'OPEN', startedAt: null, coordinatorEnabled: true,
  coordinatorSessionId: CARD_IDS.session, exceptionEscalationSeconds: 7200, _count: { tasks: 2 },
  acceptanceCriteriaItems: [{ id: 'start-c1', key: 'notes', ordinal: 1, revision: 1, text: 'Every component has a usage note.' }],
};

// The start card a conversation draws while its project waits to be started (main d91a0dd48): its card is at
// most 720px wide, More and "Read all" are drawn only while the clamp hides words, and the plan is the
// project's task graph while the whole of it fits the card (otherwise by level, with the graph full screen).
// The coordinator's reasons run past three lines on a phone but not on a desktop; one criterion runs past
// two lines everywhere; the plan fits a desktop card as a graph but not a phone's.
const LIVE_START_PROJECT = {
  id: CARD_IDS.liveStartProject, title: 'Component usage notes', status: 'OPEN', startedAt: null, coordinatorEnabled: true,
  coordinatorSessionId: CARD_IDS.session, exceptionEscalationSeconds: 7200, _count: { tasks: 5 },
  acceptanceCriteriaItems: [
    { id: 'live-c1', key: 'notes', ordinal: 1, revision: 1, text: 'Every public component has a usage note.' },
    { id: 'live-c2', key: 'examples', ordinal: 2, revision: 1, text: 'Each usage note shows the component in both themes, at a desktop and a phone width, with the states a reader meets in the product: at rest, under the pointer, focused from the keyboard, disabled, and while it waits for an answer from the server.' },
    { id: 'live-c3', key: 'links', ordinal: 3, revision: 1, text: 'The notes are linked from the component README.' },
  ],
};
const LIVE_START_ROW = {
  itemId: 'live-start-1', kind: 'START_REQUEST', title: 'Start this project?', detailLine: '', assignee: 'OWNER',
  assigneeReason: 'DEFAULT', waitingSince: FIXED_NOW, escalateAt: null, escalatedAt: null, taskId: null, sessionId: null,
  promotionId: null, fuseEpisodeId: null, delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null }, actions: [],
  question: null, facts: null,
  startRequest: {
    settings: {
      line: 'PROJECT_BRANCH', projectBranchName: `refs/heads/project/${CARD_IDS.liveStartProject}`, automatic: true,
      maxConcurrentTasks: 3, mergeCheckCommand: 'npm run build -w @orbit/web',
    },
    why: 'The notes for the overlays and the pickers both build on the shared examples page, so one branch checks them together before anything reaches main; the README links land last.',
    criteriaDigest: SEAL, planDigest: 'p'.repeat(64), repository: 'https://github.com/example/orbit.git', warnings: [],
  },
};
const liveMark = (id, title, completionCriterion = 'EVIDENCE_JUDGMENT') => ({
  kind: 'TASK', id, taskId: id, title, status: 'OPEN', parentTaskId: null, completionCriterion, autoRunWhenReady: true,
});
const LIVE_START_GRAPH = {
  marks: [
    liveMark('live-a', 'A · The shared examples page'),
    liveMark('live-b', 'B · Notes for the overlays'),
    liveMark('live-c', 'C · Notes for the pickers'),
    liveMark('live-d', 'D · Notes for the feedback components'),
    liveMark('live-e', 'E · Link the notes from the README', 'OWNER_CONFIRMED'),
  ],
  // A, then B, C and D side by side, then E: it fits a desktop card, not a phone's.
  edges: [['live-a', 'live-b'], ['live-a', 'live-c'], ['live-a', 'live-d'], ['live-b', 'live-e'], ['live-c', 'live-e'], ['live-d', 'live-e']]
    .map(([sourceMarkId, targetMarkId]) => ({ sourceMarkId, targetMarkId })),
  taskCount: 5, folded: false, truncated: false, limits: { maxTasks: 500, maxMarks: 500 },
};

/**
 * Install the harness routes. `state.evidence` decides how the evidence door refuses the next press
 * ('error': no code; 'stale': already decided elsewhere). Returns the requests answered here, with
 * their bodies, for behaviour traces.
 */
export async function installCardFixtures(page) {
  const requests = [];
  const state = { evidence: 'error' };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path, searchParams } = new URL(request.url());
    const method = request.method();
    const json = (value, status = 200) => {
      requests.push({ method, path, query: searchParams.toString(), body: request.postData() });
      return route.fulfill({ status, json: value });
    };
    if (method === 'GET' && path === '/api/tasks/evidence-decisions/pending') return json(QUEUE);
    if (method === 'POST' && path === `/api/tasks/${CARD_IDS.evidenceTask}/evidence/decision`) {
      return state.evidence === 'stale' ? json(EVIDENCE_STALE, 409) : json({ message: EVIDENCE_REFUSAL }, 409);
    }
    if (method === 'GET' && path === `/api/tasks/${CARD_IDS.ownerTask}/owner-confirmation`) return json(OWNER_VIEW);
    if (method === 'POST' && path === `/api/tasks/${CARD_IDS.ownerTask}/owner-confirmation`) return json({ message: OWNER_REFUSAL }, 409);
    if (method === 'GET' && path === `/api/projects/${CARD_IDS.project}/acceptance/criteria-decisions/pending`) return json(CRITERIA_QUEUE);
    if (method === 'POST' && path === `/api/projects/${CARD_IDS.project}/acceptance/criteria-decisions/${CARD_IDS.intent}`) {
      return json({ message: CRITERIA_REFUSAL }, 409);
    }
    if (method === 'PATCH' && path === `/api/tasks/${CARD_IDS.receiptTask}`) return json({ message: REOPEN_REFUSAL }, 409);
    if (method === 'GET' && path === `/api/projects/${CARD_IDS.startProject}/acceptance/confirmation`) return json(START_STANDING);
    if (method === 'GET' && path === `/api/projects/${CARD_IDS.startProject}`) return json(START_PROJECT);
    if (method === 'GET' && path === `/api/projects/${CARD_IDS.startProject}/open-items`) {
      return json({ needsYou: [], withCoordinator: [], doneRequest: null, startRequest: null });
    }
    const live = `/api/projects/${CARD_IDS.liveStartProject}`;
    if (method === 'GET' && path === `${live}/acceptance/confirmation`) return json(START_STANDING);
    if (method === 'GET' && path === live) return json(LIVE_START_PROJECT);
    if (method === 'GET' && path === `${live}/open-items`) {
      return json({ needsYou: [], withCoordinator: [], doneRequest: null, startRequest: LIVE_START_ROW });
    }
    if (method === 'GET' && path === `${live}/dependency-graph`) return json(LIVE_START_GRAPH);
    return route.fallback();
  });
  return { requests, state };
}
