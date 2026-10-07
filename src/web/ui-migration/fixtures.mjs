import assert from 'node:assert/strict';
import { uuidToBase62 } from '@orbit/shared';
import { sessionApi, installSessionStream, WORKSPACE, RUNNER } from './session-fixtures.mjs';

// Synthetic, public test data. Shapes are taken from api.ts, lib/queries.ts and the
// existing TaskDetailPanel, SharedTaskPage, ProjectsPage and WikiPage test fixtures.
// These are REST fixtures for the shipped application, never replacement components.
export const FIXED_NOW = '2026-09-28T12:00:00.000Z';
// Freeze wall-clock text without replacing native timers or Performance Timeline.
export async function installFixedDate(page) {
  await page.addInitScript((timestamp) => {
    window.Date = new Proxy(Date, {
      construct: (OriginalDate, args) => Reflect.construct(OriginalDate, args.length ? args : [timestamp]),
      apply: (OriginalDate) => new OriginalDate(timestamp).toString(),
      get: (OriginalDate, key) => key === 'now' ? () => timestamp : Reflect.get(OriginalDate, key),
    });
  }, Date.parse(FIXED_NOW));
}
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);
export const FIXTURE_IDS = {
  task: id('101'), project: id('201'), space: id('301'), entry: id('401'),
  session: id('10'), workspace: id('20'), runner: id('30'), user: id('40'),
};
export const SHARE_TOKEN = 'uiMigrationBaselineTask20260928';
export const PATHS = {
  task: `/tasks/${FIXTURE_IDS.task}`, projects: '/projects',
  project: `/projects/${FIXTURE_IDS.project}`, share: `/s/${SHARE_TOKEN}`,
  wiki: '/wiki/orbit', settings: '/settings', profile: '/settings/profile',
  session: `/sessions/${FIXTURE_IDS.session}`,
};
const earlier = '2026-09-27T10:00:00.000Z';
const counts = { total: 1, open: 1, inProgress: 0, done: 0, failed: 0, cancelled: 0, running: 0, queued: 0, runnable: 1 };
const buckets = { running: 0, ready: 1, blocked: 1, awaitingVerification: 0, done: 1, failed: 0, cancelled: 0 };
const attention = { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, attentionSinceAt: null, nextCheckAt: null, ownerItems: [], coordinatorItems: null, startRequest: null };
const task = {
  id: FIXTURE_IDS.task, title: 'Review the visual baseline', status: 'OPEN', outcome: 'OPEN',
  description: 'Keep the existing **Orbit appearance** and business interactions.\n\nCheck light and dark themes, keyboard focus, and narrow screens.',
  acceptanceCriteria: 'The representative pages retain their layout and keyboard behavior.',
  acceptanceCommand: null, acceptanceExpectedExitCode: null, completionCriterion: 'EVIDENCE_JUDGMENT', completionPolicy: 'MANUAL',
  createdAt: earlier, updatedAt: earlier, dueDate: null, runAt: null, parentTaskId: null,
  assignee: { id: FIXTURE_IDS.workspace, name: 'Orbit baseline' }, assigneeId: FIXTURE_IDS.workspace,
  provider: 'codex', model: null, modelHint: null, modelHintReason: null,
  project: null, list: null, listId: null, projectId: null, labels: ['ui-migration', 'baseline'],
  autoRunWhenReady: false, unmetCount: 0, blocksCount: 0, topoLevel: 0, dependencyState: 'READY', childCount: 0,
  sessions: [], dependsOn: [], dependedOnBy: [], inputs: [], children: [],
  comments: [{ id: id('501'), body: 'Capture the current interface before the first component migration.', createdAt: earlier, author: { name: 'Baseline Reviewer', email: 'reviewer@example.test' }, authorName: 'Baseline Reviewer', source: 'USER', attachments: [], deliveries: [] }],
};
const projectTasks = [
  { ...task, id: id('111'), title: 'Inventory existing components', status: 'DONE', outcome: 'DONE', workState: 'DONE', dependencyState: 'TERMINAL', topoLevel: 0, blocksCount: 1 },
  { ...task, id: id('112'), title: 'Capture browser baselines', workState: 'READY', topoLevel: 1, blocksCount: 1 },
  { ...task, id: id('113'), title: 'Migrate shared controls', workState: 'BLOCKED', dependencyState: 'BLOCKED', topoLevel: 2, unmetCount: 1 },
].map((row) => ({ ...row, projectId: FIXTURE_IDS.project, project: { id: FIXTURE_IDS.project, title: 'Orbit UI migration', status: 'OPEN' } }));
const project = {
  id: FIXTURE_IDS.project, title: 'Orbit UI migration', status: 'OPEN',
  goal: 'Preserve the familiar interface while moving to owned components.',
  instructions: 'Reuse design variables, themes, and existing business semantics.',
  acceptanceCriteriaItems: [{ id: id('601'), key: 'visual-baseline', ordinal: 1, revision: 1, text: 'Representative browser scenes can be reproduced.', landing: 'UNKNOWN', satisfied: false }],
  createdAt: earlier, updatedAt: earlier, lastActivityAt: FIXED_NOW, _count: { tasks: 3 },
  tasksByStatus: { OPEN: 2, DONE: 1 }, buckets, attention, coordinatorEnabled: false,
  maxConcurrentTasks: 2, configRevision: '1', startedAt: earlier, pausedAt: null,
  blockers: { open: [], resolved: [], resolvedCount: 0 },
};
const integration = {
  line: null, lineAbsentReason: 'NOT_DECIDED', ref: null, upstreamRef: null, source: null,
  locked: false, startedAt: null, mergeCheckCommand: null, mergeCheckCommandAbsentReason: 'NOT_CONFIGURED',
  mergeCheckTimeoutSeconds: null, escalationSeconds: 3600, commitsAheadOfUpstream: null,
  commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET', lastUpstreamSyncAt: null,
  lastUpstreamSyncAbsentReason: 'NEVER_SYNCED', integratingCount: 0, queuedCount: 0, mergeCheckOnTip: 'UNKNOWN', inFlight: null,
};
const space = {
  id: FIXTURE_IDS.space, slug: 'orbit', title: 'Orbit knowledge', repoUrlNorm: 'github.com/example/orbit',
  rootCommitSha: 'b'.repeat(40), createdAt: earlier, updatedAt: earlier, pendingOps: 0,
  settings: { push: true, autoAcceptReinforce: true, maintenance: { enabled: false } },
  usage: { days: 7, sessionsPushed: 12, searches: 4, gets: 3, entries: [] },
};
const entries = [
  { id: FIXTURE_IDS.entry, kind: 'principle', title: 'Preserve visible behavior', summary: 'A component migration keeps the user experience stable.', fields: { statement: 'Preserve visible behavior.', rationale: 'Users depend on familiar controls.' }, topics: ['ui-migration'] },
  { id: id('402'), kind: 'decision', title: 'Capture a baseline before migration', summary: 'Review screenshots in both themes.', fields: { decision: 'Capture browser evidence before changing components.', rationale: 'Compare with a recorded interface.' }, topics: ['ui-migration'] },
].map((entry) => ({ ...entry, spaceId: space.id, status: 'active', trust: 'owner', currentRevision: 1,
  aliases: [], anchors: [], anchorState: 'verified', anchorCheckedRef: 'a'.repeat(40), anchorCheckedAt: earlier,
  tainted: false, challenged: false, unsupported: false, pinned: false, supersedesId: null,
  supersededById: null, validFrom: earlier, validTo: null, recordedAt: earlier, retiredAt: null }));
const share = {
  id: id('701'), kind: 'TASK', token: SHARE_TOKEN,
  include: { commentsAndFiles: true, conversations: false, toolOutput: false }, expiresAt: null,
  revokedAt: null, viewCount: 7, lastViewedAt: earlier, createdAt: earlier, updatedAt: earlier,
  state: 'ACTIVE', stateReason: null, root: { id: task.id, title: task.title, status: task.status },
};
const taskGraph = {
  focusTaskId: projectTasks[1].id, nodes: projectTasks.map((t, index) => ({
    id: t.id, title: t.title, status: t.status, dependencyState: t.dependencyState,
    depth: Math.abs(index - 1), isDirect: true, prerequisiteCount: index ? 1 : 0, dependentCount: index < 2 ? 1 : 0,
  })),
  edges: projectTasks.slice(1).map((t, index) => ({ sourceTaskId: projectTasks[index].id, targetTaskId: t.id })),
  truncated: false, direction: 'both', maxDepth: 2,
};
const coordinator = {
  projectId: project.id, readAt: FIXED_NOW, state: 'NEVER_OPENED',
  coordination: { sessionId: null, sessionIdAbsentReason: 'NEVER_OPENED', session: null, sessionAbsentReason: 'NEVER_OPENED',
    coordinatorGeneration: '0', workspaceId: null, workspaceIdAbsentReason: 'NOT_BOUND', workspaceName: null,
    workspaceNameAbsentReason: 'NOT_BOUND', agentId: null, agentIdAbsentReason: 'NOT_BOUND', agentName: null, agentNameAbsentReason: 'NOT_BOUND' },
  openability: { canOpen: true, willCreate: true, refusalCode: null, refusalDetail: null,
    refusalCodeAbsentReason: 'OPENABLE', requiredAction: null, requiredActionAbsentReason: 'OPENABLE',
    landing: { workspaceId: FIXTURE_IDS.workspace, workspaceIdAbsentReason: null, workspaceName: 'Orbit baseline', workspaceNameAbsentReason: null, agentId: null, agentName: null, fixed: false } },
};

/** Install per-page, isolated REST state. Unknown routes fail assertHandled(), including writes.
 * scenario='projects-error' returns the real error response; 'projects-loading' holds its
 * request until controls.release() so the spinner can be captured without a time-based race.
 * scenario='settings-error' refuses preference saves, exercising the real error notification.
 */
export async function installFixtures(page, { theme = 'light', scenario = 'default' } = {}) {
  const requests = [];
  const unhandled = [];
  const account = { id: FIXTURE_IDS.user, name: 'Baseline Reviewer', email: 'reviewer@example.test',
    createdAt: earlier, avatarUpdatedAt: null, role: 'MEMBER', preferences: { theme, defaultPermissionMode: 'default', notifySessionFinished: true, notifyAgentMessage: true, enableOrchestration: true } };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await installSessionStream(page);
  await page.addInitScript(({ theme, user }) => {
    localStorage.clear();
    localStorage.setItem('orbit_token', `baseline.${btoa(JSON.stringify({ sub: user }))}.fixture`);
    localStorage.setItem('orbit-theme', theme);
  }, { theme, user: FIXTURE_IDS.user });
  await page.route('**/dl/version.json', (route) => route.fulfill({ status: 200, json: { version: '0.0.0-ui-baseline' } }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path, searchParams } = new URL(request.url());
    const method = request.method();
    requests.push({ method, path, query: searchParams.toString(), body: request.postData() });
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (method === 'GET' && path === '/api/events') {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': deterministic control stream\nretry: 3600000\n\n' });
      return;
    }
    if (method === 'GET' && path === '/api/users/me') return json(account);
    if (method === 'PATCH' && ['/api/users/me', '/api/users/me/preferences'].includes(path)) {
      if (scenario === 'settings-error') return json({ message: 'Fixture preference save failed' }, 503);
      if (path.endsWith('/preferences')) Object.assign(account.preferences, request.postDataJSON());
      else Object.assign(account, request.postDataJSON());
      return json(account);
    }
    if (method === 'POST' && path === '/api/auth/change-password') return json({ ok: true });
    if (method === 'GET' && path === '/api/auth/setup-status') return json({ needsSetup: false });
    // main 558a8ba1f (feat(auth): link and unlink Google from the profile page, ... (S4)) made the profile
    // page read GET /auth/methods. The server's default answer: Google sign-in is off until an
    // administrator turns it on, so the password alone (SignInProvidersService.methods()).
    if (method === 'GET' && path === '/api/auth/methods') return json({ password: true, google: false, googleSignup: false });
    if (method === 'GET' && path === '/api/runners') return json([RUNNER]);
    if (method === 'GET' && path === '/api/workspaces') return json([WORKSPACE]);
    if (method === 'GET' && path === '/api/providers') return json([]);
    if (method === 'GET' && path === '/api/watches') return json([]);
    if (await sessionApi(route)) return;
    if (method === 'GET' && path === '/api/task-lists') return json([]);
    if (method === 'GET' && path === '/api/tasks/counts') return json(counts);
    if (method === 'GET' && path === '/api/tasks/active') return json({ items: [], total: 0, truncated: false });
    if (method === 'GET' && path === '/api/tasks/labels') return json({ items: [], labelTotal: 0, truncated: false });
    if (method === 'GET' && path === '/api/tasks/page') return json({ items: [task], nextCursor: null, total: 1, counts });
    if (method === 'GET' && path === '/api/projects/sidebar') return json([project]);
    if (method === 'GET' && path === '/api/projects') {
      if (scenario === 'projects-error') return json({ message: 'Fixture project load failed' }, 503);
      if (scenario === 'projects-loading') await held;
      return json([project, { ...project, id: id('202'), title: 'Release documentation', goal: 'Keep release notes readable on every device.', _count: { tasks: 2 }, buckets: { ...buckets, ready: 0, blocked: 0, done: 2 }, status: 'DONE' }].filter((p) => !searchParams.get('status') || p.status === searchParams.get('status')));
    }
    if (method === 'GET' && path === `/api/projects/${project.id}`) return json(project);
    if (method === 'GET' && path === `/api/projects/${project.id}/tasks/page`) return json({ items: projectTasks, nextCursor: null, total: 3 });
    if (method === 'GET' && path === `/api/projects/${project.id}/integration`) return json(integration);
    if (method === 'GET' && path === `/api/projects/${project.id}/open-items`) return json({ needsYou: [], withCoordinator: [], startRequest: null });
    if (method === 'GET' && path === `/api/projects/${project.id}/promotions/current`) return json(null);
    if (method === 'GET' && path === `/api/projects/${project.id}/handoffs`) return json([]);
    if (method === 'GET' && path === `/api/projects/${project.id}/coordinator/status`) return json(coordinator);
    if (method === 'GET' && path === `/api/projects/${project.id}/panorama`) return json({ buckets, shape: { taskCount: 3, edgeCount: 2, ratio: 1, maxDepth: 2, form: 'chain' } });
    if (method === 'GET' && path === `/api/projects/${project.id}/panorama/blocking`) return json({ remainingCount: 2, items: [{ taskId: projectTasks[1].id, title: projectTasks[1].title, status: 'OPEN', downstreamBlocked: 1 }], truncated: null });
    if (method === 'GET' && path === `/api/projects/${project.id}/panorama/ready`) return json({ readyCount: 1, queuedCount: 0, runningCount: 0, pausedCount: 0, items: [{ taskId: projectTasks[1].id, title: projectTasks[1].title, status: 'OPEN', runState: 'READY', sessionId: null, pausedList: null, downstreamBlocked: 1 }], impactTruncated: null });
    if (method === 'GET' && path === `/api/projects/${project.id}/dependency-graph`) return json({ marks: projectTasks.map((t) => ({ ...t, kind: 'TASK', taskId: t.id })), edges: taskGraph.edges.map((e) => ({ sourceMarkId: e.sourceTaskId, targetMarkId: e.targetTaskId })), taskCount: 3, folded: false, truncated: false, limits: { maxTasks: 1000, maxMarks: 1000 } });
    for (const row of [task, ...projectTasks]) {
      if (method === 'GET' && path === `/api/tasks/${row.id}`) return json(row);
      if (method === 'GET' && path === `/api/tasks/${row.id}/dependency-graph`) return json({ ...taskGraph, focusTaskId: row.id });
      if (method === 'GET' && path === `/api/tasks/${row.id}/evidence`) return json([]);
      if (method === 'GET' && path === `/api/tasks/${row.id}/attribution`) return json({ taskId: row.id, owning: row.project ? { projectId: project.id, title: project.title, status: 'OPEN' } : null, owningAbsentReason: row.project ? null : 'FILED_UNDER_NO_PROJECT', discovery: { recorded: false, project: null, triggerEvent: null, task: null, session: null, authority: 'EVIDENCE_ONLY', absentReason: 'NO_DISCOVERY_RECORDED' }, crossing: null, crossingAbsentReason: 'NO_CROSSING_DECLARED', blocker: null, blockerAbsentReason: 'NOTHING_BLOCKING_ATTRIBUTION' });
      if (method === 'GET' && path === `/api/tasks/${row.id}/share`) return json({ link: share, counts: { comments: 1, files: 0, transcripts: 0, messages: 0, toolCalls: 0 } });
    }
    if (method === 'GET' && path === `/api/projects/${project.id}/share`) return json({ link: null, counts: { tasks: 3, comments: 0, files: 0, transcripts: 0, messages: 0, toolCalls: 0 } });
    if (method === 'GET' && path === `/api/shared/${SHARE_TOKEN}`) return json({ kind: 'TASK', include: share.include, sharedAt: earlier, root: { ...task, supersededBy: null, dependencies: { prerequisites: [], dependents: [], prerequisitesInOtherProjects: 0, dependentsInOtherProjects: 0 }, runs: [], comments: [{ author: 'Baseline Reviewer', body: task.comments[0].body, createdAt: earlier }] } });
    if (method === 'GET' && path === '/api/wiki/spaces') return json([space]);
    if (method === 'GET' && path === `/api/wiki/spaces/${space.id}`) return json(space);
    if (method === 'GET' && path === `/api/wiki/spaces/${space.id}/entries`) return json(entries);
    if (method === 'GET' && path === `/api/wiki/spaces/${space.id}/health`) return json({ spaceId: space.id, entries: entries.length, maintenance: { look: 'off', enabled: false, lastOkAt: null, lastRunAt: null, consecutiveFailures: 0, backlog: 0, oldestPendingAt: null, lagSeconds: 0, dailyLimitReached: false, held: null, running: null, lastRun: null, lastFailure: null } });
    if (method === 'GET' && path === `/api/wiki/spaces/${space.id}/timeline`) return json({ items: [] });
    if (method === 'GET' && path === '/api/wiki/review') return json([]);
    if (method === 'GET' && path === `/api/wiki/spaces/${space.id}/articles`) return json({ spaceId: space.id, categories: [{ key: 'clients', title: 'Clients & UI', topics: [{ slug: 'ui-migration', title: 'UI migration', description: null, category: 'clients', article: null, parts: [] }] }], uncategorized: [] });
    if (method === 'GET' && path === `/api/wiki/spaces/${space.id}/docs`) return json({ spaceId: space.id, plan: null, docs: { total: 0, written: 0 }, categories: [] });
    if (method === 'GET' && path === `/api/wiki/spaces/${space.id}/plan`) return json({ spaceId: space.id, confirmed: null, draft: null, proposals: [], job: null });
    if (method === 'GET' && path === `/api/wiki/entries/${entries[0].id}`) return json({ ...entries[0], sources: [], history: [], exposure: [] });
    unhandled.push(`${method} ${path}${searchParams.size ? `?${searchParams}` : ''}`);
    return json({ message: `Unhandled UI migration fixture: ${method} ${path}` }, 501);
  });
  return { requests, unhandled, release, assertHandled: () => assert.deepEqual(unhandled, [], 'Every API call must have an explicit browser fixture') };
}
