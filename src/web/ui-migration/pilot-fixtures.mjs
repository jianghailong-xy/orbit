import { uuidToBase62 } from '@orbit/shared';
import { FIXED_NOW, FIXTURE_IDS } from './fixtures.mjs';
import { RUNNER, WORKSPACE } from './session-fixtures.mjs';

// P3.2 pilot data: the task detail, share and task-input states the P0 task does not reach —
// dependencies, inputs, smart model selection, a stopped task and an unshared one. Registered on
// top of installFixtures (later routes win), so every path not modeled here still falls through
// to the P0 handler and its unhandled-request check. Synthetic, public test data only.
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);
const earlier = '2026-09-27T10:00:00.000Z';
export const PILOT_IDS = {
  task: id('102'), done: id('103'), prerequisiteDone: id('111'), prerequisiteOpen: id('112'), dependent: id('113'),
  image: id('801'), pdf: id('802'), uploaded: id('803'), run: id('901'), list: id('951'), otherList: id('952'),
};
export const PILOT_PATHS = { task: `/tasks/${PILOT_IDS.task}`, done: `/tasks/${PILOT_IDS.done}`, runner: `/runners/${RUNNER.id}` };
export const PILOT_SHARE_TOKEN = 'uiMigrationPilotTask20260928';
export const REOPEN_ERROR = 'Fixture: the task changed while this question was open.';
export const UPLOAD_ERROR = 'Fixture: the attachment store is unavailable.';

// 2×2 PNG, two colours, so a thumbnail that failed to load is visibly different from one that did.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNgYPj/n4GBgYGBgQEAH/8E/U9SPHgAAAAASUVORK5CYII=',
  'base64',
);
const MODEL_HINT_OPTIONS = [
  { level: 'S', provider: 'claude', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', effort: 'low' },
  { level: 'M', provider: 'claude', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', effort: 'medium' },
  { level: 'L', provider: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', effort: 'high' },
  { level: 'XL', provider: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', effort: 'max' },
];
const MODEL_CATALOG = {
  claude: [
    { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
};
const brief = (taskId, title, status) => ({ id: taskId, title, status });
const prerequisites = [
  brief(PILOT_IDS.prerequisiteDone, 'Inventory existing components', 'DONE'),
  brief(PILOT_IDS.prerequisiteOpen, 'Capture browser baselines', 'OPEN'),
];
const dependent = brief(PILOT_IDS.dependent, 'Migrate shared controls', 'OPEN');
const base = {
  status: 'OPEN', outcome: 'OPEN', description: 'Move the task detail panel, share dialog and task inputs onto Orbit components.',
  acceptanceCriteria: 'Same appearance and the same requests for every pilot action.',
  acceptanceCommand: null, acceptanceExpectedExitCode: null, completionCriterion: 'EVIDENCE_JUDGMENT', completionPolicy: 'MANUAL',
  createdAt: earlier, updatedAt: earlier, dueDate: null, runAt: null, parentTaskId: null,
  assignee: { id: WORKSPACE.id, name: WORKSPACE.name }, assigneeId: WORKSPACE.id,
  project: null, projectId: null, labels: ['ui-migration'], unmetCount: 0, blocksCount: 0, topoLevel: 0, childCount: 0,
  inputs: [], children: [], terminalReason: null, supersededByTaskId: null,
};
const comment = (suffix, body, authorName) => ({
  id: id(suffix), body, createdAt: earlier, author: { name: authorName, email: 'reviewer@example.test' }, authorName,
  source: 'USER', attachments: [], deliveries: [], mentions: [],
});

/** The pilot task: every editable field set, two prerequisites (one open), inputs, a run, comments. */
export function pilotTask() {
  return {
    ...base, id: PILOT_IDS.task, title: 'Migrate the task detail pilot',
    provider: 'claude', model: 'claude-opus-5-5', modelHint: 'M',
    modelHintReason: 'one panel and its dialogs; the browser comparison decides it', modelHintOptions: MODEL_HINT_OPTIONS,
    listId: PILOT_IDS.list, list: { id: PILOT_IDS.list, title: 'Pilot' },
    autoRunWhenReady: true, dependencyState: 'BLOCKED',
    dependsOn: prerequisites.map((task) => ({ dependsOnTask: task })),
    dependedOnBy: [{ task: dependent }],
    attachments: [
      { id: PILOT_IDS.image, mimeType: 'image/png', sizeBytes: 2048, fileName: 'login-mock.png', createdAt: earlier },
      { id: PILOT_IDS.pdf, mimeType: 'application/pdf', sizeBytes: 3 * 1024 * 1024, fileName: 'acceptance-spec.pdf', createdAt: earlier },
    ],
    sessions: [{
      id: PILOT_IDS.run, title: 'Run', status: 'SUCCEEDED', runState: 'SUCCEEDED', lifecycleState: 'COMPLETED',
      createdAt: earlier, workspace: { name: WORKSPACE.name }, model: 'claude-sonnet-5-5', effort: 'medium',
      route: { level: 'M', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', applied: true, escalated: false,
        reasons: ['Tier M: suggested by the coordinator', "Engine claude: this agent's own engine"], policyVersion: 1, decidedAt: earlier },
    }],
    comments: [
      comment('511', 'The share dialog keeps its *Live* line and counts.', 'Baseline Reviewer'),
      comment('512', '@Orbit baseline please compare the inputs section too.', 'Pilot Owner'),
    ],
  };
}

/** A stopped task: the header offers Reopen, whose PATCH this fixture refuses once to show the error. */
export function doneTask() {
  return {
    ...base, id: PILOT_IDS.done, title: 'Close the pilot review', status: 'DONE', outcome: 'DONE',
    provider: null, model: null, modelHint: null, modelHintReason: null, modelHintOptions: MODEL_HINT_OPTIONS,
    listId: null, list: null, autoRunWhenReady: false, dependencyState: 'NONE', dependsOn: [], dependedOnBy: [],
    attachments: [], sessions: [], comments: [],
  };
}

const graphOf = (task) => {
  const nodes = [
    { ...brief(task.id, task.title, task.status), dependencyState: task.dependencyState, depth: 0, isDirect: true, prerequisiteCount: 2, dependentCount: 1 },
    ...prerequisites.map((p) => ({ ...p, dependencyState: p.status === 'DONE' ? 'TERMINAL' : 'READY', depth: 1, isDirect: true, prerequisiteCount: 0, dependentCount: 1 })),
    { ...dependent, dependencyState: 'BLOCKED', depth: 1, isDirect: true, prerequisiteCount: 1, dependentCount: 0 },
  ];
  const edges = [
    ...prerequisites.map((p) => ({ sourceTaskId: p.id, targetTaskId: task.id })),
    { sourceTaskId: task.id, targetTaskId: dependent.id },
  ];
  return { focusTaskId: task.id, nodes, edges, truncated: false, direction: 'both', maxDepth: 1, counts: { upstream: 2, downstream: 1 } };
};

const shareLink = (taskId, title, over = {}) => ({
  id: id('702'), kind: 'TASK', token: PILOT_SHARE_TOKEN,
  include: { commentsAndFiles: true, conversations: false, toolOutput: false }, expiresAt: null,
  revokedAt: null, viewCount: 0, lastViewedAt: null, createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  state: 'ACTIVE', stateReason: null, root: { id: taskId, title, status: 'OPEN' }, ...over,
});

/**
 * Install the pilot routes. `options.reopen` decides the stopped task's PATCH ('refuse' answers 409
 * with REOPEN_ERROR, 'accept' reopens); `options.upload` decides POST /attachments ('fail' answers
 * 503 with UPLOAD_ERROR). Returns the requests it answered, with their bodies, for behaviour traces.
 */
export async function installPilotFixtures(page, { theme = 'light', modelRouting = true, reopen = 'refuse', upload = 'ok' } = {}) {
  const requests = [];
  // The P0 account (fixtures.mjs), with the smart model selection switch this pilot needs.
  const account = { id: FIXTURE_IDS.user, name: 'Baseline Reviewer', email: 'reviewer@example.test', createdAt: earlier,
    avatarUpdatedAt: null, role: 'MEMBER', preferences: { theme, defaultPermissionMode: 'default', notifySessionFinished: true,
      notifyAgentMessage: true, enableOrchestration: true, modelRouting } };
  const task = pilotTask();
  const done = doneTask();
  const state = { task, done, share: null };
  const lists = [{ id: PILOT_IDS.list, title: 'Pilot' }, { id: PILOT_IDS.otherList, title: 'Later' }];
  // Two Claude accounts on the runner, so a workspace form asks which one its sessions use.
  const runner = { ...RUNNER, modelCatalog: MODEL_CATALOG, engines: [{ ...RUNNER.engines[0], accounts: [
    { id: 'default', home: '/home/orbit/.claude', auth: 'yes' },
    { id: 'work', name: 'Work', home: '/home/orbit/.claude-work', auth: 'yes' },
  ] }] };
  const search = [
    { ...base, id: PILOT_IDS.prerequisiteDone, title: 'Inventory existing components', status: 'DONE', outcome: 'DONE' },
    { ...base, id: PILOT_IDS.prerequisiteOpen, title: 'Capture browser baselines' },
    { ...base, id: id('114'), title: 'Record the bundle size' },
    { ...base, id: id('115'), title: 'Review the pilot evidence' },
  ];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path, searchParams } = new URL(request.url());
    const method = request.method();
    const body = request.postData();
    const record = () => requests.push({ method, path, query: searchParams.toString(), body: body && !body.startsWith('--') ? body : body ? '<multipart>' : null });
    const json = (value, status = 200) => { record(); return route.fulfill({ status, json: value }); };
    if (method === 'GET' && path === '/api/users/me') return json(account);
    if (method === 'GET' && path === '/api/runners') return json([runner]);
    if (method === 'GET' && path === '/api/workspaces') return json([{ ...WORKSPACE, modelRouting: true }]);
    if (method === 'GET' && path === '/api/task-lists') return json(lists);
    if (method === 'GET' && path === '/api/tasks/page' && searchParams.get('counts') === 'none') {
      const q = (searchParams.get('q') ?? '').toLowerCase();
      return json({ items: search.filter((row) => row.title.toLowerCase().includes(q)), nextCursor: null });
    }
    for (const row of [state.task, state.done]) {
      const prefix = `/api/tasks/${row.id}`;
      if (method === 'GET' && path === prefix) return json(row);
      if (method === 'PATCH' && path === prefix) {
        const patch = request.postDataJSON();
        if (row === state.done && 'status' in patch) {
          if (reopen === 'refuse') return json({ message: REOPEN_ERROR }, 409);
          Object.assign(row, { status: 'OPEN', outcome: 'OPEN' });
          return json(row);
        }
        Object.assign(row, patch);
        return json(row);
      }
      if (method === 'GET' && path === `${prefix}/dependency-graph`) return json(graphOf(row));
      if (method === 'GET' && path === `${prefix}/evidence`) return json([]);
      if (method === 'GET' && path === `${prefix}/attribution`) {
        return json({ taskId: row.id, owning: null, owningAbsentReason: 'FILED_UNDER_NO_PROJECT', discovery: { recorded: false, project: null, triggerEvent: null, task: null, session: null, authority: 'EVIDENCE_ONLY', absentReason: 'NO_DISCOVERY_RECORDED' }, crossing: null, crossingAbsentReason: 'NO_CROSSING_DECLARED', blocker: null, blockerAbsentReason: 'NOTHING_BLOCKING_ATTRIBUTION' });
      }
      if (path === `${prefix}/share`) {
        if (method === 'GET') return json({ link: row === state.task ? state.share : null, counts: { comments: row.comments.length, files: row.attachments.length, transcripts: row.sessions.length } });
        if (method === 'PUT') {
          const put = request.postDataJSON();
          const current = state.share ?? shareLink(row.id, row.title);
          state.share = { ...current, include: { ...current.include, ...put.include }, expiresAt: put.expiresAt === undefined ? current.expiresAt : put.expiresAt };
          return json(state.share);
        }
        if (method === 'DELETE') { state.share = null; return json({ ok: true }); }
      }
      if (method === 'POST' && path === `${prefix}/dependencies`) return json({ ok: true });
      if (method === 'DELETE' && path.startsWith(`${prefix}/dependencies/`)) return json({ ok: true });
      if (method === 'POST' && path === `${prefix}/execute`) return json({ ok: true });
      if (method === 'POST' && path === `${prefix}/comments`) return json({ ok: true });
      if (method === 'DELETE' && path === prefix) return json({ ok: true });
    }
    if (method === 'GET' && [PILOT_IDS.image, PILOT_IDS.uploaded].some((attachment) => path === `/api/attachments/${attachment}`)) {
      record();
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    if (method === 'POST' && path === '/api/attachments' && searchParams.get('taskId') === PILOT_IDS.task) {
      if (upload === 'fail') return json({ message: UPLOAD_ERROR }, 503);
      return json({ id: PILOT_IDS.uploaded });
    }
    if (method === 'DELETE' && [PILOT_IDS.image, PILOT_IDS.pdf, PILOT_IDS.uploaded].some((attachment) => path === `/api/attachments/${attachment}`)) {
      return json({ ok: true });
    }
    return route.fallback();
  });
  return { requests, state, ids: { ...FIXTURE_IDS, ...PILOT_IDS } };
}
