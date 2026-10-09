import { uuidToBase62 } from '@orbit/shared';
import { FIXED_NOW, FIXTURE_IDS } from './fixtures.mjs';
import { PILOT_IDS } from './pilot-fixtures.mjs';
import { RUNNER, SESSION as P0_SESSION, WORKSPACE } from './session-fixtures.mjs';

// P4.3a data: the Projects list in each of its lanes and its history, a project page with every block
// this batch draws (header questions and the share menu, open items, the coordinator in its states,
// How it runs, the work overview, goal, chain, blockers, the run queue, acceptance criteria and the task
// plan with subtasks), the public page of a shared project, the Tasks page (scope menu, filters, labels,
// selection and its batch actions) and, over the P3.2 pilot task, a task's schedule, acceptance,
// attribution and mention deliveries. Registered on top of installFixtures (later routes win), so every
// path not modeled here still falls through to the P0 handler and its unhandled-request check. `state`
// is read on every request, so a test changes an answer before the step that asks. Synthetic, public
// test data only.
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);
const now = Date.parse(FIXED_NOW);
const at = (offset) => new Date(now + offset).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const earlier = '2026-09-27T10:00:00.000Z';

export const P43A_IDS = {
  project: FIXTURE_IDS.project,
  accessibility: id('4301'), releaseNotes: id('4302'), search: id('4303'), billing: id('4304'), onboarding: id('4305'),
  tokens: id('4306'), cleanup: id('4307'),
  dialogs: id('4321'), toasts: id('4322'), focus: id('4323'), datePicker: id('4324'), settings: id('4325'), sidebar: id('4326'),
  icons: id('4327'), legacyTokens: id('4328'), colors: id('4329'), inventory: id('4330'), oldModal: id('4331'),
  dialogPort: id('4341'), popconfirmPort: id('4342'), darkAudit: id('4343'), keyboardRecord: id('4344'),
  accessibilityList: id('4351'), uiWave: id('4352'), releaseList: id('4353'),
  docsSite: id('4361'), releaseBot: id('4362'),
  blockerScope: id('4371'), blockerConflict: id('4372'), blockerProvider: id('4373'), blockerResolved: id('4374'),
  failedItem: id('4381'), conflictItem: id('4382'), doneItem: id('4383'),
  runTask: id('4391'), queueTask: id('4392'), readyTask: id('4393'), retryTask: id('4394'), blockedTask: id('4395'), doneTask: id('4396'),
  shareLink: id('4397'), delivered: id('4398'), blockedDelivery: id('4399'), deadDelivery: id('4400'),
};
export const PROJECT_SHARE_TOKEN = 'uiMigrationP43aProject20260928';
export const P43A_PATHS = {
  projects: '/projects', running: '/projects?view=RUNNING', ready: '/projects?view=READY', history: '/projects?status=DONE',
  cancelled: '/projects?status=CANCELLED', project: `/projects/${P43A_IDS.project}`, share: `/s/${PROJECT_SHARE_TOKEN}`,
  tasks: '/tasks', labelled: '/tasks?labels=ui-migration', createdIn: `/tasks?createdIn=${FIXTURE_IDS.session}`,
  list: `/lists/${P43A_IDS.uiWave}`, task: `/tasks/${PILOT_IDS.task}`, coordinator: `/sessions/${P0_SESSION.id}`,
};
export const STATUS_REFUSAL = 'A request made from a session cannot write a project’s status — record it from the project page.';
export const DELETE_REFUSAL = 'This project still holds 11 task(s) and cannot be deleted — move them to another project or delete them first';
export const RESOLVE_REFUSAL = 'The blocker changed while this question was open.';
export const SAVE_REFUSAL = 'The settings changed since you read them (configRevision 5); read them again.';
export const HANDLED_REFUSAL = 'The item was already closed by its rerun.';

const attention = { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, attentionSinceAt: null, nextCheckAt: null,
  ownerItems: [], coordinatorItems: null, startRequest: null };
const buckets = (over = {}) => ({ running: 0, ready: 0, blocked: 0, awaitingVerification: 0, done: 0, failed: 0, cancelled: 0, ...over });
const listed = (over) => ({
  status: 'OPEN', goal: null, instructions: null, acceptanceCriteriaItems: [], createdAt: earlier, updatedAt: earlier,
  lastActivityAt: FIXED_NOW, _count: { tasks: 3 }, tasksByStatus: { OPEN: 2, DONE: 1 }, buckets: buckets(), attention,
  coordinatorEnabled: false, maxConcurrentTasks: 2, configRevision: '1', startedAt: earlier, pausedAt: null,
  blockers: { open: [], resolved: [], resolvedCount: 0 }, integration: null, ...over,
});

/** One project in each lane of the Open list: two that need the reader (an escalation on a project
 *  branch; a warning blocker), one running with its coordinator on a conflict, the P0 project ready,
 *  one waiting and one with no tasks yet. */
export function openProjects() {
  return [
    listed({ id: P43A_IDS.accessibility, title: 'Accessibility sweep', goal: 'Every control reachable by **keyboard** and by a screen reader.',
      _count: { tasks: 10 }, buckets: buckets({ ready: 2, blocked: 3, done: 5 }), lastActivityAt: at(-30 * MIN),
      attention: { ...attention, ownerItems: [{ kind: 'ESCALATED', count: 3, oldestWaitingSince: '2026-09-28T08:00:00.000Z' }] },
      integration: { line: 'PROJECT_BRANCH', ref: 'project/accessibility' } }),
    listed({ id: P43A_IDS.releaseNotes, title: 'Release notes pipeline', goal: 'Publish readable notes for every release, in both languages.',
      _count: { tasks: 4 }, buckets: buckets({ ready: 1, blocked: 1, done: 2 }), lastActivityAt: at(-2 * HOUR),
      attention: { ...attention, userBlockers: 1, maxSeverity: 'WARNING', attentionSinceAt: '2026-09-26T12:00:00.000Z' } }),
    listed({ id: P43A_IDS.search, title: 'Search indexing', goal: 'Find any task, comment or wiki entry from one box.',
      _count: { tasks: 6 }, buckets: buckets({ running: 1, blocked: 1, done: 4 }), lastActivityAt: at(-5 * MIN),
      attention: { ...attention, coordinatorItems: { count: 1, leadKind: 'INTEGRATION_CONFLICT', oldestWaitingSince: '2026-09-28T11:42:00.000Z', nextEscalationAt: '2026-09-28T13:30:00.000Z' } },
      integration: { line: 'MAIN', ref: 'main' } }),
    listed({ id: P43A_IDS.project, title: 'Orbit UI migration', goal: 'Preserve the familiar interface while moving to owned components.',
      buckets: buckets({ ready: 1, blocked: 1, done: 1 }) }),
    listed({ id: P43A_IDS.billing, title: 'Billing exports', goal: 'Monthly invoices as CSV and PDF, signed.',
      _count: { tasks: 5 }, buckets: buckets({ blocked: 2, awaitingVerification: 1, done: 2 }), lastActivityAt: at(-3 * DAY) }),
    listed({ id: P43A_IDS.onboarding, title: 'Mobile onboarding', _count: { tasks: 0 }, tasksByStatus: {}, lastActivityAt: null }),
  ];
}
export function doneProjects() {
  return [
    listed({ id: P43A_IDS.tokens, title: 'Theme tokens', status: 'DONE', goal: 'One set of colour tokens for both themes.', doneBy: 'OWNER',
      acceptedGaps: [{ criterionKey: 'contrast' }], buckets: buckets({ done: 6 }), _count: { tasks: 6 }, lastActivityAt: at(-2 * DAY) }),
    listed({ id: P43A_IDS.cleanup, title: 'Legacy cleanup', status: 'DONE', goal: 'Retire the old settings screens.',
      buckets: buckets({ done: 3, cancelled: 1 }), _count: { tasks: 4 }, lastActivityAt: at(-6 * DAY) }),
  ];
}

const R = (n, over) => ({
  id: n, title: '', status: 'OPEN', outcome: 'OPEN', description: null, acceptanceCriteria: 'The page keeps its layout and keyboard behaviour.',
  acceptanceCommand: null, acceptanceExpectedExitCode: null, createdAt: earlier, updatedAt: earlier, dueDate: null, runAt: null,
  parentTaskId: null, assignee: { id: WORKSPACE.id, name: WORKSPACE.name }, assigneeId: WORKSPACE.id, labels: [], autoRunWhenReady: false,
  unmetCount: 0, blocksCount: 0, topoLevel: 0, dependencyState: 'READY', childCount: 0, landingWaitCount: 0, workState: 'READY',
  projectId: P43A_IDS.project, project: { id: P43A_IDS.project, title: 'Orbit UI migration', status: 'OPEN' }, ...over,
});
const I = (state, over = {}) => ({ state, since: earlier, handler: null, openItemId: null, jobId: null, checksRunningForMs: null, landTask: null, ...over });

/** The project's top-level tasks, filling each group of the plan with its tags. */
export function projectTasks() {
  return [
    R(P43A_IDS.dialogs, { title: 'Port the dialog primitives', status: 'IN_PROGRESS', workState: 'RUNNING', blocksCount: 2, childCount: 2 }),
    R(P43A_IDS.toasts, { title: 'Restyle the toast stack', workState: 'READY', autoRunWhenReady: true, runAt: '2026-09-29T09:30:00.000Z' }),
    R(P43A_IDS.focus, { title: 'Verify focus rings', workState: 'AWAITING_VERIFICATION', verificationState: 'RUNNING', topoLevel: 1 }),
    R(P43A_IDS.datePicker, { title: 'Swap the date picker', status: 'FAILED', outcome: 'FAILED', workState: 'FAILED', topoLevel: 1, blocksCount: 1 }),
    R(P43A_IDS.settings, { title: 'Migrate settings forms', workState: 'BLOCKED', dependencyState: 'BLOCKED', topoLevel: 2, unmetCount: 2, childCount: 1, acceptanceCriteria: null }),
    R(P43A_IDS.sidebar, { title: 'Replace the sidebar tree', workState: 'BLOCKED', dependencyState: 'BLOCKED', topoLevel: 1, landingWaitCount: 1,
      acceptanceCriteria: 'The sidebar keeps its order, its folding and its drag handles, and every row stays reachable from the keyboard in the same order as before — including the rows of folded groups once they are opened.' }),
    R(P43A_IDS.icons, { title: 'Inventory icon usage', status: 'DONE', outcome: 'DONE', workState: 'DONE', integration: I('RUNNING', { jobId: id('4401'), checksRunningForMs: 42_000 }) }),
    R(P43A_IDS.legacyTokens, { title: 'Retire legacy tokens', status: 'DONE', outcome: 'DONE', workState: 'DONE', integration: I('CONFLICT', { handler: 'OWNER', openItemId: id('4402') }) }),
    R(P43A_IDS.colors, { title: 'Capture color tokens', status: 'DONE', outcome: 'DONE', workState: 'DONE', blocksCount: 1, integration: I('ON_INTEGRATION_LINE') }),
    R(P43A_IDS.inventory, { title: 'Inventory components', status: 'DONE', outcome: 'DONE', workState: 'DONE', integration: I('ON_UPSTREAM') }),
    R(P43A_IDS.oldModal, { title: 'Drop the old modal', status: 'CANCELLED', outcome: 'CANCELLED', workState: 'CANCELLED' }),
  ];
}
const children = {
  [P43A_IDS.dialogs]: [
    R(P43A_IDS.dialogPort, { title: 'Port Dialog', parentTaskId: P43A_IDS.dialogs, status: 'IN_PROGRESS', workState: 'RUNNING' }),
    R(P43A_IDS.popconfirmPort, { title: 'Port Popconfirm', parentTaskId: P43A_IDS.dialogs, workState: 'READY' }),
  ],
  [P43A_IDS.settings]: [],
};

const criteria = () => [
  { id: id('4411'), key: 'visual-baseline', ordinal: 1, revision: 1, text: 'Baselines reproduce with `npm run ui:baseline`.', satisfied: true, unmet: [],
    landing: 'LANDED', verificationMethod: 'Run the Playwright suite and compare the screenshots with the recorded ones.' },
  { id: id('4412'), key: 'contrast', ordinal: 2, revision: 1, text: 'Both themes keep **AA** contrast.', satisfied: true, unmet: [], landing: 'ON_INTEGRATION_LINE', verificationMethod: null },
  { id: id('4413'), key: 'keyboard', ordinal: 3, revision: 2, text: 'Every control is keyboard reachable.', satisfied: false, landing: 'UNKNOWN', unmet: [
    { clause: 'SERVING_WORK_UNSETTLED', heldUpBy: [
      { taskId: P43A_IDS.focus, title: 'Verify focus rings', requiredAction: 'RUN_ACCEPTANCE_COMMAND' },
      { taskId: P43A_IDS.settings, title: 'Migrate settings forms', requiredAction: 'AWAIT_THE_NEXT_THING' }] }] },
  { id: id('4414'), key: 'unanswered', ordinal: 4, revision: 1, text: 'Screen readers announce every state change.' },
  { id: id('4415'), key: 'receipt', ordinal: 5, revision: 1, text: 'The release notes name every migrated page.', satisfied: true, unmet: [], landing: 'UNKNOWN' },
];

const blockers = () => ({
  open: [
    { id: P43A_IDS.blockerScope, kind: 'AWAITING_USER_APPROVAL', owner: 'USER', severity: 'CRITICAL',
      requiredAction: 'This delivery changed files its declaration never mentioned. Decide before anything merges.',
      subjectType: 'TASK', subjectId: P43A_IDS.colors, subjectTitle: 'Capture color tokens', agentArgument: null,
      criterionOrdinal: 1, criterionRevision: 1, criterionText: null,
      detail: { reason: 'OUTSIDE_DECLARED_SCOPE', source: 'CRITERION_UNLANDED', paths: ['src/web/src/components/ui/Button.tsx', 'src/web/src/components/ui/Button.css', 'src/web/src/index.css'] },
      firstSeenAt: '2026-09-22T12:00:00.000Z', resolvedAt: null, resolvedBy: null, resolutionNote: null },
    { id: P43A_IDS.blockerConflict, kind: 'HUMAN_DECISION_REQUIRED', owner: 'USER', severity: 'WARNING', requiredAction: 'Resolve the conflict on the task branch and re-run its checks.',
      subjectType: 'TASK', subjectId: P43A_IDS.legacyTokens, subjectTitle: 'Retire legacy tokens', agentArgument: null,
      criterionOrdinal: null, criterionRevision: null, criterionText: null, detail: { reason: 'MERGE_REFUSED_BY_GIT', paths: [] },
      firstSeenAt: '2026-09-28T08:00:00.000Z', resolvedAt: null, resolvedBy: null, resolutionNote: null },
    { id: P43A_IDS.blockerProvider, kind: 'PROVIDER_UNAVAILABLE', owner: 'SYSTEM', severity: 'INFO', requiredAction: 'Wait for the provider to come back.',
      subjectType: 'PROJECT', subjectId: P43A_IDS.project, subjectTitle: null, agentArgument: null,
      criterionOrdinal: null, criterionRevision: null, criterionText: null, detail: {},
      firstSeenAt: '2026-09-28T11:30:00.000Z', resolvedAt: null, resolvedBy: null, resolutionNote: null },
  ],
  resolved: [{ id: P43A_IDS.blockerResolved, kind: 'AWAITING_USER_APPROVAL', owner: 'USER', severity: 'CRITICAL', requiredAction: '—',
    subjectType: 'TASK', subjectId: P43A_IDS.inventory, subjectTitle: 'Inventory components', agentArgument: null,
    criterionOrdinal: null, criterionRevision: null, criterionText: null, detail: { reason: 'OUTSIDE_DECLARED_SCOPE', paths: [] },
    firstSeenAt: '2026-09-26T09:00:00.000Z', resolvedAt: '2026-09-27T11:46:00.000Z', resolvedBy: 'AUTO', resolutionNote: 'the work landed on main' }],
  resolvedCount: 1,
});

/** The project document: started, Automatic on, eleven tasks, five criteria, three open blockers. */
export function projectDocument() {
  return {
    id: P43A_IDS.project, title: 'Orbit UI migration', status: 'OPEN',
    goal: '## Why\n\nPreserve the familiar interface while moving to **owned components**.\n\n- Keep every page’s layout and density\n- Keep keyboard behaviour and focus order\n- Change nothing a reader relies on',
    instructions: 'Reuse design variables, themes, and existing business semantics.',
    acceptanceCriteriaItems: criteria(),
    integration: { line: 'PROJECT_BRANCH', lineAbsentReason: null, ref: 'project/ui-migration', upstreamRef: 'main', source: 'EXPLICIT', locked: false,
      startedAt: null, mergeCheckCommand: null, mergeCheckCommandAbsentReason: 'NOT_CONFIGURED', mergeCheckTimeoutSeconds: null, escalationSeconds: 3600 },
    createdAt: earlier, updatedAt: earlier, lastActivityAt: FIXED_NOW, _count: { tasks: 11 },
    tasksByStatus: { OPEN: 4, IN_PROGRESS: 1, FAILED: 1, DONE: 4, CANCELLED: 1 },
    buckets: buckets({ running: 1, ready: 1, blocked: 2, awaitingVerification: 1, done: 4, failed: 1, cancelled: 1 }), attention,
    coordinatorEnabled: true, maxConcurrentTasks: 3, configRevision: '4', startedAt: earlier, pausedAt: null, blockers: blockers(),
  };
}

/** GET …/integration: the project branch, Automatic on and no merge check (How it runs warns), or locked. */
const integrationView = (locked) => ({
  line: 'PROJECT_BRANCH', lineAbsentReason: null, ref: 'project/ui-migration', upstreamRef: 'main', source: locked ? 'DEFAULT_RULE' : 'EXPLICIT',
  locked, startedAt: locked ? '2026-09-28T10:00:00.000Z' : null, mergeCheckCommand: locked ? 'npm test' : null,
  mergeCheckCommandAbsentReason: locked ? null : 'NOT_CONFIGURED', mergeCheckTimeoutSeconds: locked ? 900 : null, escalationSeconds: locked ? 7200 : 3600,
  commitsAheadOfUpstream: locked ? 3 : null, commitsAheadOfUpstreamAbsentReason: locked ? null : 'NO_LANDING_YET',
  lastUpstreamSyncAt: locked ? '2026-09-28T09:00:00.000Z' : null, lastUpstreamSyncAbsentReason: locked ? null : 'NEVER_SYNCED',
  integratingCount: 0, queuedCount: 0, mergeCheckOnTip: locked ? 'PASSING' : 'UNKNOWN', inFlight: null,
});

const SESSION = FIXTURE_IDS.session;
const landing = (over) => ({ workspaceId: null, workspaceIdAbsentReason: 'COORDINATOR_ALREADY_LIVE', workspaceName: null, workspaceNameAbsentReason: 'COORDINATOR_ALREADY_LIVE',
  agentId: null, agentName: null, fixed: true, ...over });
const coordination = (over) => ({
  sessionId: SESSION, sessionIdAbsentReason: null,
  session: { id: SESSION, title: 'Coordinating Orbit UI migration', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', lifecycleState: 'OPEN', filingState: 'OPEN',
    endReason: null, startedAt: '2026-09-28T11:48:00.000Z', finishedAt: null, completedAt: null, deletedAt: null, lastTurnAt: '2026-09-28T11:48:00.000Z',
    engineTurnActive: false, pendingApprovals: 0 },
  sessionAbsentReason: null, coordinatorGeneration: '1',
  workspaceId: WORKSPACE.id, workspaceIdAbsentReason: null, workspaceName: WORKSPACE.name, workspaceNameAbsentReason: null,
  agentId: null, agentIdAbsentReason: 'NO_COORDINATOR_AGENT', agentName: null, agentNameAbsentReason: 'NO_COORDINATOR_AGENT', ...over,
});
/** GET …/coordinator/status, by state: a live coordinator waiting on the reader, one that cannot be
 *  opened (its workspace disabled), and one never opened that has no workspace to open in. */
const coordinatorStatus = (kind) => {
  const base = { projectId: P43A_IDS.project, readAt: FIXED_NOW };
  if (kind === 'live') {
    return { ...base, state: 'LIVE', coordination: coordination({ wakeups: { state: 'DELIVERED', at: '2026-09-28T11:56:00.000Z' }, fuse: { selfStartedToday: 6, limit: 30, paused: false, episodeId: null } }),
      openability: { canOpen: true, willCreate: false, refusalCode: null, refusalDetail: null, refusalCodeAbsentReason: 'NOTHING_REFUSES', requiredAction: null,
        requiredActionAbsentReason: 'NOTHING_REFUSES', landing: landing({}) } };
  }
  if (kind === 'unavailable') {
    return { ...base, state: 'UNAVAILABLE', coordination: coordination({ sessionId: null, sessionIdAbsentReason: 'NEVER_OPENED', session: null, sessionAbsentReason: 'NEVER_OPENED' }),
      openability: { canOpen: false, willCreate: false, refusalCode: 'COORDINATOR_UNAVAILABLE', refusalDetail: 'WORKSPACE_DISABLED', refusalCodeAbsentReason: null,
        requiredAction: 'Enable workspace Orbit baseline, or rebind this project’s coordination workspace, then open the coordinator again.', requiredActionAbsentReason: null,
        landing: landing({ workspaceIdAbsentReason: 'LANDING_REFUSED', workspaceNameAbsentReason: 'LANDING_REFUSED' }) } };
  }
  return { ...base, state: 'NEVER_OPENED',
    coordination: coordination({ sessionId: null, sessionIdAbsentReason: 'NEVER_OPENED', session: null, sessionAbsentReason: 'NEVER_OPENED', coordinatorGeneration: '0',
      workspaceId: null, workspaceIdAbsentReason: 'NOT_BOUND', workspaceName: null, workspaceNameAbsentReason: 'NOT_BOUND' }),
    openability: { canOpen: false, willCreate: true, refusalCode: 'NO_LANDING_WORKSPACE', refusalDetail: 'NO_TASK_ASSIGNEE', refusalCodeAbsentReason: null,
      requiredAction: 'Assign a task in this project to an agent first.', requiredActionAbsentReason: null,
      landing: landing({ workspaceIdAbsentReason: 'LANDING_REFUSED', workspaceNameAbsentReason: 'LANDING_REFUSED', fixed: false }) } };
};

const f0 = { task: null, targetRef: null, targetSha: null, files: [], nothingLanded: false, check: null, branchUnchanged: false, errorCode: null, failure: null };
/** GET …/open-items: a failed task escalated to the reader, a conflict with the coordinator, and the
 *  coordinator's question whether the project is done (the header's Ready to close). */
const openItems = (doneRequest) => ({
  needsYou: [{ itemId: P43A_IDS.failedItem, kind: 'TASK_FAILED', title: 'Task failed: Swap the date picker',
    detailLine: 'The acceptance command disagreed with what the task declared · exit 1, expected 0 · attempt 3 of 3 in this chain',
    assignee: 'OWNER', assigneeReason: 'ESCALATED', waitingSince: at(-126 * MIN), escalateAt: at(-6 * MIN), escalatedAt: at(-6 * MIN),
    taskId: P43A_IDS.datePicker, sessionId: SESSION, promotionId: null, fuseEpisodeId: null, delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
    actions: ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'CANCEL_TASK'], question: null,
    facts: { ...f0, task: { id: P43A_IDS.datePicker, title: 'Swap the date picker' }, failure: { how: 'ACCEPTANCE_EXIT_MISMATCH', exitCode: 1, expectedExitCode: 0, attempt: 3, limit: 3 } } }],
  withCoordinator: [{ itemId: P43A_IDS.conflictItem, kind: 'INTEGRATION_CONFLICT', title: 'Merge conflict: Retire legacy tokens',
    detailLine: '2 files conflict with project/ui-migration · nothing landed', assignee: 'COORDINATOR', assigneeReason: 'DEFAULT',
    waitingSince: at(-18 * MIN), escalateAt: at(102 * MIN), escalatedAt: null, taskId: P43A_IDS.legacyTokens, sessionId: SESSION, promotionId: null, fuseEpisodeId: null,
    delivery: { state: 'DELIVERED', sessionId: SESSION, at: at(-17 * MIN) }, actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'], question: null,
    facts: { ...f0, targetRef: 'project/ui-migration', files: ['src/web/src/components/ui/Button.tsx', 'src/web/src/components/ui/Menu.tsx'], nothingLanded: true } }],
  settled: [], startRequest: null,
  doneRequest: doneRequest && { itemId: P43A_IDS.doneItem, kind: 'DONE_REQUEST', title: 'Is this project done?', detailLine: 'The coordinator asked',
    assignee: 'OWNER', assigneeReason: 'DEFAULT', waitingSince: at(-120 * MIN), escalateAt: null, escalatedAt: null,
    taskId: null, sessionId: null, promotionId: null, fuseEpisodeId: null, delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
    actions: [], question: null, facts: null,
    doneRequest: { criteriaDigest: 'sha256:fixture', judgment: 'Every representative scene reproduces in both themes.',
      gaps: [{ criterionKey: id('4415'), title: 'No merge receipt', whyNotProven: 'Merged outside Orbit.', coordinatorChecked: 'main has the baseline commit', evidenceRefs: [] }] } },
});

/** GET …/panorama/ready: one running (its session open), one queued, one ready and one in a paused list. */
const readyQueue = () => ({ readyCount: 1, queuedCount: 1, runningCount: 1, pausedCount: 1,
  manualReady: { count: 1, taskId: P43A_IDS.toasts, title: 'Restyle the toast stack' }, impactTruncated: null,
  items: [
    { taskId: P43A_IDS.dialogs, title: 'Port the dialog primitives', status: 'IN_PROGRESS', runState: 'RUNNING', sessionId: SESSION, runReason: 'TURN', runStalled: false, pausedList: null, downstreamBlocked: 2 },
    { taskId: P43A_IDS.darkAudit, title: 'Audit dark theme', status: 'OPEN', runState: 'QUEUED', sessionId: null, pausedList: null, downstreamBlocked: 0 },
    { taskId: P43A_IDS.toasts, title: 'Restyle the toast stack', status: 'OPEN', runState: 'READY', sessionId: null, pausedList: null, downstreamBlocked: 1 },
    { taskId: P43A_IDS.keyboardRecord, title: 'Record keyboard focus', status: 'OPEN', runState: 'PAUSED', sessionId: null,
      pausedList: { id: P43A_IDS.accessibilityList, title: 'Accessibility', readyCount: 1, autoRunReadyCount: 0 }, downstreamBlocked: 0 },
  ] });

const shareCounts = { tasks: 11, comments: 0, files: 0, runs: 0, transcripts: 0 };
export const liveShare = () => ({ id: P43A_IDS.shareLink, kind: 'PROJECT', token: PROJECT_SHARE_TOKEN,
  include: { taskPages: true, commentsAndFiles: false, conversations: false }, expiresAt: null, revokedAt: null,
  viewCount: 3, lastViewedAt: earlier, createdAt: earlier, updatedAt: earlier, state: 'ACTIVE', stateReason: null,
  root: { id: P43A_IDS.project, title: 'Orbit UI migration', status: 'OPEN' } });

/** GET /api/shared/<token> for the project link: Task pages and Conversations on, three tasks. */
const sharedProject = () => {
  const [T1, T2, T3] = [P43A_IDS.inventory, P43A_IDS.dialogs, P43A_IDS.settings];
  return { kind: 'PROJECT', sharedAt: earlier,
    include: { taskPages: true, commentsAndFiles: false, conversations: true, toolOutput: false },
    root: { id: P43A_IDS.project, title: 'Orbit UI migration', status: 'OPEN', createdAt: earlier, lastActivityAt: '2026-09-28T11:00:00.000Z', taskCount: 3,
      overview: { buckets: { running: 1, ready: 0, blocked: 1, awaitingVerification: 0, done: 1, failed: 0, cancelled: 0, integrating: 0, onIntegrationLine: 1, onUpstream: 0, doneNotIntegrated: 0, waitingForLanding: 0 },
        shape: { taskCount: 3, edgeCount: 2, ratio: 0.67, maxDepth: 2, form: 'chain' }, integrationLine: 'PROJECT_BRANCH' },
      coordinator: { sessionId: SESSION },
      goal: 'Preserve the familiar interface while moving to **owned components**.',
      graph: { marks: [
        { kind: 'TASK', id: T1, taskId: T1, title: 'Inventory components', status: 'DONE', parentTaskId: null, running: false, queued: false, workState: 'DONE' },
        { kind: 'TASK', id: T2, taskId: T2, title: 'Port the dialog primitives', status: 'IN_PROGRESS', parentTaskId: null, running: true, queued: false, workState: 'RUNNING' },
        { kind: 'TASK', id: T3, taskId: T3, title: 'Migrate settings forms', status: 'OPEN', parentTaskId: null, running: false, queued: false, workState: 'BLOCKED' }],
        edges: [{ sourceMarkId: T1, targetMarkId: T2 }, { sourceMarkId: T2, targetMarkId: T3 }], taskCount: 3, folded: false, truncated: false, limits: { maxTasks: 50000, maxMarks: 500 } },
      chain: { current: { id: T2, title: 'Port the dialog primitives', status: 'IN_PROGRESS' }, next: { id: T3, title: 'Migrate settings forms', status: 'OPEN' } },
      criteria: [
        { ordinal: 1, text: 'Browser scenes can be reproduced.', verificationMethod: 'Run the baseline suite.', satisfied: true, landing: 'NOT_ON_MAIN_YET', heldUpBy: [] },
        { ordinal: 2, text: 'Controls keep keyboard focus.', verificationMethod: null, satisfied: false, landing: 'NO_MERGE_RECEIPT',
          heldUpBy: [{ id: T2, title: 'Port the dialog primitives', status: 'IN_PROGRESS' }, { id: T3, title: 'Migrate settings forms', status: 'OPEN' }] }],
      tasks: { hasMore: false, items: [
        { id: T3, title: 'Migrate settings forms', status: 'OPEN', workState: 'BLOCKED', landing: null, dependencyState: 'BLOCKED', landingWaitCount: 0, topoLevel: 2, unmetCount: 1, blocksCount: 0, childCount: 2 },
        { id: T2, title: 'Port the dialog primitives', status: 'IN_PROGRESS', workState: 'RUNNING', landing: null, dependencyState: 'READY', landingWaitCount: 0, topoLevel: 1, unmetCount: 0, blocksCount: 1, childCount: 0 },
        { id: T1, title: 'Inventory components', status: 'DONE', workState: 'DONE', landing: 'ON_PROJECT_BRANCH', dependencyState: 'READY', landingWaitCount: 0, topoLevel: 0, unmetCount: 0, blocksCount: 1, childCount: 0 }] } },
    scope: { projectId: P43A_IDS.project, tasks: [{ id: T1 }, { id: T2 }, { id: T3 }], conversations: [{ id: SESSION }] } };
};

// The Tasks page.
const ws = { id: WORKSPACE.id, name: WORKSPACE.name, runner: { id: RUNNER.id, name: RUNNER.name } };
const T = (n, title, createdAt, over = {}) => ({ id: n, title, status: 'OPEN', outcome: 'OPEN', running: false, queued: false, blocked: false, runnable: false,
  dependencyState: 'READY', unmetCount: 0, assignee: ws, assigneeId: ws.id, labels: [], project: null, projectId: null, listId: null, list: null,
  runAt: null, dueDate: null, sessions: [], createdAt, updatedAt: createdAt, parentTaskId: null, childCount: 0, ...over });
/** The P3.2 pilot task as a row of the Tasks page, newest of all: the one task every read of its page is answered
 *  for, so it can be the row a keyboard test has open. */
export const pilotRow = () => T(PILOT_IDS.task, 'Migrate the task detail pilot', '2026-09-28T12:00:00.000Z');
export function listTasks() {
  return [
    T(P43A_IDS.runTask, 'Migrate the task list toolbar', '2026-09-28T11:00:00.000Z', { status: 'IN_PROGRESS', running: true, labels: ['ui-migration'], listId: P43A_IDS.uiWave }),
    T(P43A_IDS.queueTask, 'Capture dark-theme baselines', '2026-09-28T10:00:00.000Z', { queued: true, labels: ['ui-migration', 'baseline'], listId: P43A_IDS.uiWave }),
    T(P43A_IDS.readyTask, 'Review keyboard focus order', '2026-09-28T09:00:00.000Z', { runnable: true, labels: ['accessibility'], runAt: '2026-10-10T01:00:00.000Z' }),
    T(P43A_IDS.blockedTask, 'Replace legacy select popups', '2026-09-28T08:00:00.000Z', { blocked: true, dependencyState: 'BLOCKED', unmetCount: 1, assignee: null, assigneeId: null, labels: ['ui-migration'], listId: P43A_IDS.uiWave }),
    T(P43A_IDS.retryTask, 'Publish the release notes', '2026-09-28T07:00:00.000Z', { status: 'FAILED', outcome: 'FAILED', runnable: true, labels: ['release'] }),
    T(P43A_IDS.doneTask, 'Inventory existing components', '2026-09-28T06:00:00.000Z', { status: 'DONE', outcome: 'DONE', dependencyState: 'TERMINAL', labels: ['ui-migration', 'baseline'], listId: P43A_IDS.uiWave }),
  ];
}
const countsOf = (rows) => ({
  total: rows.length, open: rows.filter((r) => r.status === 'OPEN').length, inProgress: rows.filter((r) => r.status === 'IN_PROGRESS').length,
  done: rows.filter((r) => r.status === 'DONE').length, failed: rows.filter((r) => r.status === 'FAILED').length,
  cancelled: rows.filter((r) => r.status === 'CANCELLED').length, running: rows.filter((r) => r.running).length,
  queued: rows.filter((r) => r.queued).length, runnable: rows.filter((r) => r.runnable).length,
});
const LABELS = { items: [
  { label: 'ui-migration', total: 4, open: 2, inProgress: 1, done: 1, failed: 0, cancelled: 0 },
  { label: 'baseline', total: 2, open: 1, inProgress: 0, done: 1, failed: 0, cancelled: 0 },
  { label: 'accessibility', total: 1, open: 1, inProgress: 0, done: 0, failed: 0, cancelled: 0 },
  { label: 'release', total: 1, open: 0, inProgress: 0, done: 0, failed: 1, cancelled: 0 } ], labelTotal: 4, truncated: false };
const LISTS = [
  { id: P43A_IDS.uiWave, title: 'UI migration wave 1', _count: { tasks: 4 }, runningTasks: 1, completed: false, tasksOutsideProjects: 4, paused: false },
  { id: P43A_IDS.releaseList, title: 'Release 0.1.200 checks', _count: { tasks: 2 }, runningTasks: 0, completed: true, tasksOutsideProjects: 2, paused: false },
];
const WORKSPACES = [WORKSPACE, { ...WORKSPACE, id: P43A_IDS.docsSite, name: 'Docs site' }, { ...WORKSPACE, id: P43A_IDS.releaseBot, name: 'Release bot' }];

/** The fullest attribution answer: counted towards the project, noticed elsewhere, a pending crossing
 *  and a blocker. */
const attribution = (taskId) => ({
  taskId,
  owning: { projectId: '0196e000-0000-7000-8000-000000000201', projectPublicId: P43A_IDS.project, title: 'Orbit UI migration', status: 'OPEN' }, owningAbsentReason: null,
  discovery: { recorded: true, authority: 'EVIDENCE_ONLY', absentReason: null,
    project: { projectId: '0196e000-0000-7000-8000-000000000202', projectPublicId: id('202'), title: 'Release documentation', status: 'DONE' },
    triggerEvent: 'session.transcript',
    task: { taskId: '0196e000-0000-7000-8000-000000000112', taskPublicId: id('112'), title: 'Capture browser baselines' },
    session: { sessionId: '0196e000-0000-7000-8000-000000000010', sessionPublicId: FIXTURE_IDS.session, title: null } },
  crossing: { handoffId: id('4451'), kind: 'FILE_TASK', state: 'PENDING',
    from: { projectId: '0196e000-0000-7000-8000-000000000201', projectPublicId: P43A_IDS.project, title: 'Orbit UI migration', status: 'OPEN' },
    to: { projectId: '0196e000-0000-7000-8000-000000000202', projectPublicId: id('202'), title: 'Release documentation', status: 'DONE' },
    subjectTaskId: taskId, crossingKey: 'c'.repeat(64), requestedAt: earlier, decidedAt: null, expiresAt: null, code: 'APPROVAL_PENDING', requiredAction: 'AWAIT_HANDOFF_APPROVAL' },
  crossingAbsentReason: null,
  blocker: { blockerId: id('4461'), kind: 'AWAITING_USER_INPUT', owner: 'USER', requiredAction: 'Say which project owns this work.', nextCheckAt: '2026-09-28T12:10:00.000Z', code: 'UNMAPPED_PROJECT_WORK' },
  blockerAbsentReason: null,
});
/** A comment that mentions three agents: delivered (into a session), held (no runner) and dead. */
export const mentionComment = () => ({
  id: id('4471'), body: '@Orbit baseline @Docs site @Release bot please check the migrated pages.', createdAt: earlier,
  author: { name: 'Pilot Owner', email: 'reviewer@example.test' }, authorName: 'Pilot Owner', source: 'USER', attachments: [],
  mentions: [WORKSPACE.id, P43A_IDS.docsSite, P43A_IDS.releaseBot],
  deliveries: [
    { id: P43A_IDS.delivered, workspaceId: WORKSPACE.id, status: 'DELIVERED', attempts: 1, errorCode: null, requiredAction: null, lastError: null, nextAttemptAt: earlier, targetSessionId: FIXTURE_IDS.session },
    { id: P43A_IDS.blockedDelivery, workspaceId: P43A_IDS.docsSite, status: 'BLOCKED', attempts: 0, errorCode: 'NO_RUNNER',
      requiredAction: 'bind this agent to a runner; the mention then delivers itself with no further action', lastError: 'the mentioned agent is not bound to a runner', nextAttemptAt: FIXED_NOW, targetSessionId: null },
    { id: P43A_IDS.deadDelivery, workspaceId: P43A_IDS.releaseBot, status: 'DEAD', attempts: 8, errorCode: 'WORKSPACE_GONE',
      requiredAction: 'mention an agent that still exists, in a new comment', lastError: 'the mentioned agent no longer exists', nextAttemptAt: earlier, targetSessionId: null },
  ],
});

export function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

/**
 * Install the P4.3a routes. `state` holds every answer a test changes between steps: the lists
 * (`open`, `done`, `cancelled`; `holdProjects` and `projectsError` for the loading and error states),
 * the project document and its reads (`coordinator`: 'live' | 'unavailable' | 'never'; `locked`;
 * `share`; refusals for the status, delete, blocker and settings writes), the Tasks page rows, a held
 * task read, and the task attribution hold. Requests it answers are kept in `requests` (method, path with query, body).
 */
export async function installP43aFixtures(page) {
  const state = {
    open: openProjects(), done: doneProjects(), cancelled: [], holdProjects: null, projectsError: null,
    project: projectDocument(), coordinator: 'live', locked: false, share: null, holdPanorama: null,
    statusRefusal: null, deleteRefusal: null, resolveRefusal: null, saveRefusal: null,
    tasks: listTasks(), holdTasks: null, holdTask: null, holdAttribution: null, attributionError: null,
    // `{ id, gate }`: that task's first read waits on the gate (a row opened from the keyboard waits there).
    holdRead: null,
    // Over the P3.2 pilot task: its own task lists and model routing stay the pilot's.
    pilot: false,
    // The P0 conversation as this project's coordinator, which draws the project's exceptions as cards;
    // `doneRequest` off leaves out the coordinator's done question (P4.3b's card) there.
    coordinatorSession: false, handledRefusal: null, doneRequest: true,
  };
  const requests = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path, searchParams } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    const body = () => { try { return request.postDataJSON(); } catch { return request.postData(); } };
    const note = () => requests.push({ method, path: path + (searchParams.size ? `?${searchParams}` : ''), body: method === 'GET' ? undefined : body() });
    const P = `/api/projects/${P43A_IDS.project}`;

    // The Projects list.
    if (method === 'GET' && path === '/api/projects') {
      note();
      if (state.holdProjects) await state.holdProjects.promise;
      if (state.projectsError) return json({ message: state.projectsError }, 503);
      const status = searchParams.get('status') ?? 'OPEN';
      return json(status === 'DONE' ? state.done : status === 'CANCELLED' ? state.cancelled : state.open);
    }
    if (method === 'GET' && path === '/api/workspaces') return json(state.pilot ? WORKSPACES.map((w) => ({ ...w, modelRouting: true })) : WORKSPACES);

    // The project page.
    if (method === 'GET' && path === P) return json(state.project);
    if (method === 'PATCH' && path === P) {
      note();
      const asked = request.postDataJSON();
      if ('status' in asked) {
        if (state.statusRefusal) return json({ message: state.statusRefusal, statusCode: 403 }, 403);
        state.project = { ...state.project, status: asked.status };
        return json({ id: P43A_IDS.project });
      }
      if (state.saveRefusal) return json({ message: state.saveRefusal, code: 'STALE_CONFIG_REVISION' }, 409);
      state.project = { ...state.project, ...('automatic' in asked ? { coordinatorEnabled: asked.automatic } : {}),
        ...('maxConcurrentTasks' in asked ? { maxConcurrentTasks: asked.maxConcurrentTasks } : {}), configRevision: String(Number(state.project.configRevision) + 1) };
      return json(state.project);
    }
    if (method === 'DELETE' && path === P) {
      note();
      if (state.deleteRefusal) return json({ message: state.deleteRefusal, statusCode: 409 }, 409);
      return json({ ok: true });
    }
    if (method === 'GET' && path === `${P}/integration`) return json(integrationView(state.locked));
    if (method === 'PATCH' && path === `${P}/integration`) { note(); return json(integrationView(state.locked)); }
    if (method === 'POST' && (path === `${P}/pause` || path === `${P}/resume`)) {
      note();
      const paused = path.endsWith('/pause');
      state.project = { ...state.project, pausedAt: paused ? FIXED_NOW : null };
      return json({ projectId: P43A_IDS.project, startedAt: earlier, pausedAt: paused ? FIXED_NOW : null, pausedReason: paused ? 'OWNER' : null });
    }
    if (method === 'GET' && path === `${P}/open-items`) return json(openItems(state.doneRequest));
    if (method === 'GET' && path === `${P}/coordinator/status`) return json(coordinatorStatus(state.coordinator));
    if (method === 'POST' && path === `${P}/coordinator/rebind`) {
      note();
      state.coordinator = 'live';
      return json({ projectId: P43A_IDS.project, coordinatorWorkspaceId: request.postDataJSON().workspaceId, coordinatorSessionId: null, moved: true });
    }
    if (method === 'GET' && path === `${P}/panorama`) {
      if (state.holdPanorama) await state.holdPanorama.promise;
      return json({ buckets: state.project.buckets, shape: { taskCount: 11, edgeCount: 12, ratio: 1.09, maxDepth: 3, form: 'chain' } });
    }
    if (method === 'GET' && path === `${P}/panorama/blocking`) {
      return json({ remainingCount: 7, truncated: null, items: [
        { taskId: P43A_IDS.dialogs, title: 'Port the dialog primitives', status: 'IN_PROGRESS', downstreamBlocked: 3 },
        { taskId: P43A_IDS.settings, title: 'Migrate settings forms', status: 'OPEN', downstreamBlocked: 1 }] });
    }
    if (method === 'GET' && path === `${P}/panorama/ready`) return json(readyQueue());
    if (method === 'GET' && path === `${P}/share`) return json({ link: state.share, counts: shareCounts });
    if (method === 'GET' && path === `${P}/tasks/page`) {
      const parent = searchParams.get('parentId');
      return json({ items: parent ? (children[parent] ?? []) : projectTasks(), nextCursor: null, total: parent ? (children[parent] ?? []).length : 11 });
    }
    const resolving = path.match(new RegExp(`^${P}/blockers/([^/]+)/resolve$`));
    if (method === 'POST' && resolving) {
      note();
      if (state.resolveRefusal) return json({ message: state.resolveRefusal }, 409);
      const open = state.project.blockers.open.filter((b) => b.id !== resolving[1]);
      state.project = { ...state.project, blockers: { ...state.project.blockers, open } };
      return json({ id: resolving[1], resolvedAt: FIXED_NOW });
    }
    if (method === 'GET' && path === `/api/tasks/${P43A_IDS.settings}/dependency-graph`) {
      return json({ focusTaskId: P43A_IDS.settings, nodes: [
        { id: P43A_IDS.settings, title: 'Migrate settings forms', status: 'OPEN' }, { id: P43A_IDS.focus, title: 'Verify focus rings', status: 'OPEN' },
        { id: P43A_IDS.datePicker, title: 'Swap the date picker', status: 'FAILED' }],
      edges: [{ sourceTaskId: P43A_IDS.focus, targetTaskId: P43A_IDS.settings }, { sourceTaskId: P43A_IDS.datePicker, targetTaskId: P43A_IDS.settings }] });
    }
    if (method === 'POST' && /^\/api\/tasks\/[^/]+\/execute$/.test(path)) { note(); return json({ ok: true }); }
    if (method === 'PATCH' && /^\/api\/task-lists\/[^/]+$/.test(path)) { note(); return json({ ok: true }); }

    if (method === 'GET' && path === `/api/sessions/${P0_SESSION.id}` && state.coordinatorSession) return json({ ...P0_SESSION, projectId: P43A_IDS.project });
    // What a coordinator conversation reads besides: no criteria change waiting, the criteria as
    // confirmed, no merge into main yet.
    if (method === 'GET' && path === `${P}/acceptance/criteria-decisions/pending`) {
      return json({ readAt: FIXED_NOW, projectId: P43A_IDS.project, count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [], settled: [] });
    }
    if (method === 'GET' && path === `${P}/acceptance/confirmation`) {
      return json({ state: 'CONFIRMED', confirmed: true, currentVersion: { digest: 'sha256:fixture', material: [] }, confirmation: null });
    }
    if (method === 'GET' && path === `${P}/promotions/merged`) return json([]);
    const handled = path.match(new RegExp(`^${P}/open-items/([^/]+)/resolve$`));
    if (method === 'POST' && handled) {
      note();
      if (state.handledRefusal) return json({ message: state.handledRefusal }, 409);
      return json({ itemId: handled[1], resolvedAt: FIXED_NOW });
    }

    // The public page of the project link.
    if (method === 'GET' && path === `/api/shared/${PROJECT_SHARE_TOKEN}`) return json(sharedProject());

    // The Tasks page.
    if (method === 'GET' && path === '/api/task-lists' && !state.pilot) return json(LISTS);
    if (method === 'GET' && path === '/api/tasks/labels') return json(LABELS);
    if (method === 'GET' && (path === '/api/tasks/page' || path === '/api/tasks/counts')) {
      const labels = searchParams.getAll('labels');
      const listId = searchParams.get('listId');
      const creator = searchParams.get('creatorSessionId');
      let rows = state.tasks;
      if (labels.length) rows = rows.filter((row) => labels.every((label) => row.labels.includes(label)));
      if (listId === 'none') rows = rows.filter((row) => !row.listId);
      else if (listId) rows = rows.filter((row) => row.listId === listId);
      if (creator) rows = rows.slice(0, 2);
      if (path === '/api/tasks/counts') return json(countsOf(rows));
      if (searchParams.get('limit') === '1') return json({ items: rows.slice(0, 1), nextCursor: null, total: rows.length, counts: countsOf(rows) });
      if (state.holdTasks) await state.holdTasks.promise;
      return json({ items: rows, nextCursor: null, total: rows.length, counts: countsOf(rows) });
    }
    if (method === 'POST' && path === '/api/tasks/batch-execute') {
      note();
      const { taskIds } = request.postDataJSON();
      const runnable = taskIds.filter((taskId) => state.tasks.find((row) => row.id === taskId)?.runnable);
      return json({ dispatched: runnable.length, failed: [], skipped: taskIds.filter((taskId) => !runnable.includes(taskId)).map(() => ({ reason: 'NOT_RUNNABLE' })) });
    }
    if (method === 'POST' && path === '/api/tasks/batch-assign') { note(); return json({ updated: request.postDataJSON().taskIds.length }); }
    if (method === 'POST' && path === '/api/tasks/batch-stop') { note(); return json({ stopped: 1, failed: [], tasks: [] }); }
    if (method === 'POST' && path === '/api/tasks/batch-delete') { note(); return json({ deleted: request.postDataJSON().taskIds.length }); }

    if (method === 'GET' && state.holdRead && path === `/api/tasks/${state.holdRead.id}`) {
      await state.holdRead.gate.promise;
      return route.fallback();
    }

    // The task page (the P3.2 pilot task): its first read can be held (then the pilot answers it), and
    // its attribution held or refused.
    if (method === 'GET' && path === `/api/tasks/${PILOT_IDS.task}` && state.holdTask) {
      await state.holdTask.promise;
      return route.fallback();
    }
    if (method === 'GET' && path === `/api/tasks/${PILOT_IDS.task}/attribution`) {
      if (state.holdAttribution) await state.holdAttribution.promise;
      if (state.attributionError) return json({ message: state.attributionError }, 503);
      return json(attribution(PILOT_IDS.task));
    }
    if (method !== 'GET') note();
    return route.fallback();
  });
  return { state, requests };
}
