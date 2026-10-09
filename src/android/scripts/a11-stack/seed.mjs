// Seeds the isolated A11 stack (FRESH database: run via `setup.sh reset`) through its real HTTP API, and writes
// accounts.json (test credentials) and seed.json (every created object's public id, plus how it was made).
//
// Everything below is an HTTP call against the stack's API (lib.mjs: 127.0.0.1 only): owner calls with the
// owner's JWT, the member's with theirs, and the coordinator's question with the stack runner's own token + the
// coordinator session header (exactly what the coordinator's `ask_owner` MCP tool sends). Runs happen for real on
// the stack runner, whose engine is the fake `claude` in runner-path/ (no model, no account). No row is written to
// the database directly.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { API, S, call, HttpError } from './lib.mjs';

const seed = {
  api: API,
  sourceSha: readFileSync(`${S}/SOURCE_SHA`, 'utf8').trim(),
  createdAt: new Date().toISOString(),
  accounts: {},
  runner: {},
  workspace: {},
  taskLists: {},
  tasks: {},
  projects: {},
  shareLinks: {},
  memberCheck: {},
  dbWrites: [],
  refused: [],
  notes: [],
};
const save = () => writeFileSync(`${S}/seed.json`, JSON.stringify(seed, null, 2) + '\n');
const note = (s) => { seed.notes.push(s); console.log('·', s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

// An optional piece: record the server's refusal instead of dying.
async function attempt(what, fn) {
  try {
    return await fn();
  } catch (e) {
    const why = e instanceof HttpError ? `${e.status} ${e.body.slice(0, 500)}` : String(e?.message ?? e).slice(0, 500);
    seed.refused.push({ what, why });
    console.log('✗', what, '—', why);
    return undefined;
  }
}

async function until(what, fn, { timeoutMs = 120_000, everyMs = 2_000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ── accounts ───────────────────────────────────────────────────────────────────────────────────────
// Passwords are made here, per seeding, and kept only in accounts.json (0600) in the stack directory.
const password = () => randomBytes(18).toString('base64url');
const OWNER = { email: 'owner@a11.test', name: 'A11 Owner', password: password() };
const MEMBER = { email: 'member@a11.test', name: 'A11 Member', password: password() };
let boot;
try {
  boot = await call('POST', '/auth/bootstrap', undefined, OWNER);
} catch (e) {
  if (e instanceof HttpError && e.status === 409) {
    console.error(`This database is already seeded (bootstrap 409). Run: ${S}/setup.sh reset`);
    process.exit(1);
  }
  throw e;
}
const T = boot.accessToken;
const member = await call('POST', '/admin/users', T, { email: MEMBER.email, name: MEMBER.name, password: MEMBER.password });
const memberT = (await call('POST', '/auth/login', undefined, { email: MEMBER.email, password: MEMBER.password })).accessToken;
const admins = await call('GET', '/admin/users', T);
const roleOf = (id) => admins.find((u) => u.id === id)?.role ?? null;
writeFileSync(`${S}/accounts.json`, JSON.stringify({
  api: API,
  note: `Test-only accounts on the isolated A11 stack (${new URL(API).host}). Never valid anywhere else.`,
  owner: { ...OWNER, id: boot.user.id, role: roleOf(boot.user.id) },
  member: { ...MEMBER, id: member.id, role: roleOf(member.id) },
}, null, 2) + '\n', { mode: 0o600 });
chmodSync(`${S}/accounts.json`, 0o600);  // `mode` applies only to a new file
seed.accounts = {
  owner: { id: boot.user.id, email: OWNER.email, role: roleOf(boot.user.id), how: 'POST /api/auth/bootstrap' },
  member: { id: member.id, email: MEMBER.email, role: roleOf(member.id), how: 'POST /api/admin/users {password}' },
};
save();

// ── runner + workspace ─────────────────────────────────────────────────────────────────────────────
const enroll = await call('POST', '/runners/enrollment-tokens', T, { label: 'a11-stack-runner' });
execFileSync(`${S}/setup.sh`, ['register', enroll.token], { stdio: 'inherit' });
execFileSync(`${S}/setup.sh`, ['start'], { stdio: 'inherit' });
const runner = await until('the runner to come online', async () => (await call('GET', '/runners', T)).find((r) => r.online));
seed.runner = { id: runner.id, name: runner.name, version: runner.version, how: 'POST /api/runners/enrollment-tokens + `orbit register --token` (real runner)' };
const ws = await call('POST', '/workspaces', T, {
  name: 'a11-sandbox',
  description: 'Throwaway git repo on the isolated A11 stack runner (fake engine: no model is ever called)',
  runnerId: runner.id,
  workDir: `${S}/runner-work`,
  enableWorktree: true,
  defaultMergeTarget: 'main',
});
const repoUrl = (await until('the runner to report the workspace origin', async () => {
  const w = (await call('GET', '/workspaces', T)).find((x) => x.id === ws.id);
  return w?.repoUrl ? w : null;
}, { timeoutMs: 300_000, everyMs: 3_000 })).repoUrl;
seed.workspace = { id: ws.id, name: ws.name, workDir: `${S}/runner-work`, repoUrl, how: 'POST /api/workspaces (repoUrl detected by the runner probe)' };
save();

const execute = (id) => call('POST', `/tasks/${id}/execute`, T, { triggerId: randomUUID() });
const getTask = (id) => call('GET', `/tasks/${id}`, T);
const waitStatus = (id, statuses, what, timeoutMs = 150_000) =>
  until(what, async () => { const t = await getTask(id); return statuses.includes(t.status) ? t : null; }, { timeoutMs });
const brief = (t) => ({ id: t.id, title: t.title, status: t.status });

// ── tasks outside projects ─────────────────────────────────────────────────────────────────────────
const sprint = await call('POST', '/task-lists', T, { title: 'A11 Sprint' });
await call('PATCH', `/task-lists/${sprint.id}`, T, { instructions: 'Tasks in this list run on the a11-sandbox workspace. Keep each change small.' });
const pausedList = await call('POST', '/task-lists', T, { title: 'A11 Paused list' });
seed.taskLists = { sprint: { id: sprint.id, title: sprint.title }, paused: { id: pausedList.id, title: pausedList.title } };

const NOTES_CHECK = { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'test -f A11_STACK_NOTES.md', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 60 };
const OWNER_OK = { completionCriterion: 'OWNER_CONFIRMED', ownerConfirmationReason: 'OWNER_TRADE_OFF' };

const prereq = await call('POST', '/tasks', T, {
  title: 'Write the sprint notes', description: 'Append a line to A11_STACK_NOTES.md (the fake engine does this on any run).',
  listId: sprint.id, assigneeId: ws.id, labels: ['Sprint, one', 'docs'],
  acceptanceCriteria: 'A11_STACK_NOTES.md exists in the run\'s worktree when the run ends.', ...NOTES_CHECK,
});
const dependent = await call('POST', '/tasks', T, {
  title: 'Publish the sprint notes', description: 'Runs once the notes exist; the owner confirms the result.',
  listId: sprint.id, assigneeId: ws.id, labels: ['Sprint, one'], dependsOnTaskIds: [prereq.id], autoRunWhenReady: false, ...OWNER_OK,
});
const triage = await call('POST', '/tasks', T, {
  title: 'Triage Android crash reports', description: 'Group this week\'s crash reports by stack signature.',
  listId: sprint.id, assigneeId: ws.id, labels: ['Sprint, one', 'android'], ...OWNER_OK,
});
await call('PATCH', `/tasks/${triage.id}`, T, { priority: 2 });
await call('POST', `/tasks/${triage.id}/comments`, T, { body: 'Start with the top three signatures; the rest can wait for next sprint.' });
const scheduled = await call('POST', '/tasks', T, {
  title: 'Send the weekly digest', description: 'Scheduled one-shot run, a week from seeding.',
  listId: sprint.id, assigneeId: ws.id, labels: ['digest'], runAt: new Date(Date.now() + 7 * DAY).toISOString(), ...OWNER_OK,
});
const acceptance = await call('POST', '/tasks', T, {
  title: 'Check the sandbox README', description: 'Has acceptance criteria and an acceptance command; not run by the seed.',
  assigneeId: ws.id, labels: ['docs'],
  acceptanceCriteria: 'README.md is present at the repository root.\nThe acceptance command exits 0 in the run\'s worktree.',
  completionCriterion: 'EXECUTABLE', acceptanceCommand: 'test -f README.md', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 120,
});
const confirmed = await call('POST', '/tasks', T, {
  title: 'Approve the sprint scope', description: 'Done by the owner\'s confirmation alone (no run).', labels: ['Sprint, one'], ...OWNER_OK,
});
await call('POST', `/tasks/${confirmed.id}/owner-confirmation`, T, { decision: 'CONFIRM', note: 'Scope approved for the A11 checks.' });
const failing = await call('POST', '/tasks', T, {
  title: 'Run that fails (outside a project)', description: 'A11-FAIL: the fake engine fails this run on purpose.',
  assigneeId: ws.id, labels: ['android'], ...OWNER_OK,
});
const cancelled = await call('POST', '/tasks', T, { title: 'Old idea we dropped', labels: ['backlog'], ...OWNER_OK });
await call('PATCH', `/tasks/${cancelled.id}`, T, { status: 'CANCELLED', terminalReason: 'ABANDONED' });
const inProgress = await call('POST', '/tasks', T, { title: 'Draft the store listing', description: 'Marked IN_PROGRESS by the owner.', labels: ['android'], ...OWNER_OK });
await call('PATCH', `/tasks/${inProgress.id}`, T, { status: 'IN_PROGRESS' });
const inPaused = await call('POST', '/tasks', T, { title: 'Task in a paused list', listId: pausedList.id, assigneeId: ws.id, ...OWNER_OK });
await call('PATCH', `/task-lists/${pausedList.id}`, T, { paused: true, note: 'Paused for the A11 resume check' });

note('running "Write the sprint notes" and "Run that fails" for real on the stack runner');
await execute(prereq.id);
await execute(failing.id);
await attempt('prerequisite run reaches DONE', () => waitStatus(prereq.id, ['DONE'], 'the prerequisite to be DONE'));
await attempt('failing run reaches FAILED', () => waitStatus(failing.id, ['FAILED'], 'the failing task to be FAILED'));
const taskShare = await attempt('task share link', () => call('PUT', `/tasks/${prereq.id}/share`, T, { include: { commentsAndFiles: true, conversations: true } }));
if (taskShare) seed.shareLinks.task = { taskId: prereq.id, id: taskShare.id, token: taskShare.token, publicRead: `GET /api/shared/${taskShare.token}` };
const memberTask = await call('POST', '/tasks', memberT, { title: 'Member\'s own task', description: 'Created by member@a11.test.', labels: ['Sprint, one'], ...OWNER_OK });
for (const [k, t] of Object.entries({ prereq, dependent, triage, scheduled, acceptance, confirmed, failing, cancelled, inProgress, inPaused })) {
  seed.tasks[k] = brief(await getTask(t.id));
}
seed.tasks.scheduled.runAt = (await getTask(scheduled.id)).runAt;
seed.tasks.memberTask = { ...brief(memberTask), owner: 'member' };
save();

// ── project 1: started, coordinator, criteria, dependencies, failure, question, promotion ───────────
const CRITERIA = [
  { text: 'Release notes exist on the project branch', verificationMethod: 'test -f A11_STACK_NOTES.md on the integration tip' },
  { text: 'The client contract is written down', verificationMethod: 'The owner reads the contract notes' },
  { text: 'The smoke run passes on the sandbox', verificationMethod: 'A run of the smoke task ends DONE' },
];
const BRANCH = 'refs/heads/project/a11-android-release';
const MERGE_CHECK = 'test -f README.md';
let main = await call('POST', '/projects', T, {
  title: 'A11 Android release',
  goal: 'Ship the A11 Tasks & Projects pages to internal testers with notes and a passing smoke run.',
  instructions: 'Work on the a11-sandbox workspace. Land every task on the project branch first; the owner promotes to main.',
  acceptanceCriteriaItems: CRITERIA,
  coordinatorEnabled: true,
  maxConcurrentTasks: 2,
  workspaceId: ws.id,
});
const integration = await call('PATCH', `/projects/${main.id}/integration`, T, {
  line: 'PROJECT_BRANCH', projectBranchName: BRANCH, upstreamRef: 'refs/heads/main',
  mergeCheckCommand: MERGE_CHECK, mergeCheckTimeoutSeconds: 120, exceptionEscalationSeconds: 3600,
});
main = await call('GET', `/projects/${main.id}`, T);
const keyOf = (i) => main.acceptanceCriteriaItems[i].key;
const ptask = (b) => call('POST', '/tasks', T, { projectId: main.id, assigneeId: ws.id, autoRunWhenReady: false, ...b });
const p1 = await ptask({ title: 'Define the client contract', description: 'Write the contract notes.', criterionKey: keyOf(1), labels: ['android'], ...NOTES_CHECK });
const p2 = await ptask({ title: 'Implement the client', description: 'Build on the contract.', criterionKey: keyOf(0), dependsOnTaskIds: [p1.id], labels: ['android'], ...NOTES_CHECK });
const p3 = await ptask({ title: 'Write the release notes', description: 'Owner confirms the wording.', criterionKey: keyOf(0), dependsOnTaskIds: [p2.id], labels: ['docs'], ...OWNER_OK });
const p4 = await ptask({ title: 'Smoke the build', description: 'A11-FAIL: the fake engine fails this run on purpose, so the project gets a real TASK_FAILED exception.', criterionKey: keyOf(2), labels: ['android'], ...OWNER_OK });
const p5 = await attempt('P5 create (exemption argument; lands into a merge conflict)', () => ptask({
  title: 'Contract exemption for the docs-only change', description: 'Serves criterion 2 while arguing it does not apply.',
  criterionKey: keyOf(1), labels: ['docs'], ...NOTES_CHECK,
  completionCriterionOverrideReason: 'Criterion 2 does not apply to this docs-only change: it touches no client contract.',
}));
const conf = await call('GET', `/projects/${main.id}/acceptance/confirmation`, T);
const started = await call('POST', `/projects/${main.id}/start`, T, {
  criteriaDigest: conf.currentVersion.digest, line: 'PROJECT_BRANCH', projectBranchName: BRANCH,
  automatic: false, maxConcurrentTasks: 2, mergeCheckCommand: MERGE_CHECK,
});
note(`project "${main.title}" started (automatic=false, PROJECT_BRANCH ${BRANCH})`);

await execute(p1.id);
await attempt('P1 run reaches DONE', () => waitStatus(p1.id, ['DONE'], 'P1 to be DONE'));
// P4 and P5 start before P1 has landed: P4 fails on purpose (a real TASK_FAILED item); P5 adds the same file P1 did
// from the same base, so its landing after P1's is a real INTEGRATION_CONFLICT.
await attempt('P4 failing run', async () => { await execute(p4.id); return waitStatus(p4.id, ['FAILED'], 'P4 to be FAILED'); });
if (p5) await attempt('P5 run', async () => { await execute(p5.id); return waitStatus(p5.id, ['DONE'], 'P5 to be DONE'); });
// A prerequisite that is DONE but not landed on the project branch refuses its dependent's Run (400), so P2 waits.
const landed = (taskId) => async () => {
  const line = await call('GET', `/projects/${main.id}/integration`, T);
  const lt = (line.landTasks ?? []).find((x) => x.taskId === taskId);
  return lt?.integration?.landTask?.state === 'LANDED' ? lt : null;
};
await attempt('P1 lands on the project branch', () => until('P1 to land', landed(p1.id), { timeoutMs: 180_000, everyMs: 3_000 }));
await attempt('P2 run (after P1 landed)', async () => { await execute(p2.id); return waitStatus(p2.id, ['DONE'], 'P2 to be DONE'); });

// The coordinator's question, as its ask_owner MCP tool files it: runner token + the coordinator session.
const cfg = JSON.parse(readFileSync(`${S}/runner-home/config.json`, 'utf8'));
main = await call('GET', `/projects/${main.id}`, T);
const question = await attempt('coordinator question (runner API, coordinator session)', async () => {
  const res = await fetch(`${API}/runner/projects/${main.id}/owner-questions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.runnerToken}`, 'x-orbit-session-id': main.coordinatorSessionId },
    body: JSON.stringify({
      question: 'Ship the Android build to internal testers before the release notes are final?',
      options: [{ label: 'Ship now', description: 'Testers get it today; the notes follow.' }, { label: 'Wait for the notes', description: 'One build with complete notes.' }],
      recommendedOption: 0, ifUnanswered: 'I will wait for the notes.', blocksTaskIds: [p3.id], clientQuestionId: 'a11-seed-q1',
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError('POST', '/runner/projects/:id/owner-questions', res.status, text);
  return JSON.parse(text);
});

// Let the integration line land what finished and ask for the promotion (automatic=false: it waits for the owner).
const promotion = await attempt('promotion candidate (project branch → main)', () => until('a promotion candidate', async () => {
  const p = await call('GET', `/projects/${main.id}/promotions/current`, T);
  return p?.promotionId ? p : null;
}, { timeoutMs: 180_000, everyMs: 5_000 }));
const projectShare = await attempt('project share link', () => call('PUT', `/projects/${main.id}/share`, T, { include: { taskPages: true, commentsAndFiles: true } }));
if (projectShare) seed.shareLinks.project = { projectId: main.id, id: projectShare.id, token: projectShare.token, publicRead: `GET /api/shared/${projectShare.token}` };

main = await call('GET', `/projects/${main.id}`, T);
const openItems = await call('GET', `/projects/${main.id}/open-items`, T);
const items = (list, where) => list.map((i) => ({ id: i.itemId, kind: i.kind, title: i.title, assignee: i.assignee, assigneeReason: i.assigneeReason, where, taskId: i.taskId ?? null }));
seed.projects.main = {
  id: main.id,
  title: main.title,
  status: main.status,
  startedAt: started.startedAt,
  settings: started.settings,
  coordinatorSessionId: main.coordinatorSessionId,
  coordinatorWorkspaceId: main.coordinatorWorkspaceId,
  integration: { line: integration.line, ref: integration.ref, upstreamRef: integration.upstreamRef, mergeCheckCommand: integration.mergeCheckCommand },
  criteria: main.acceptanceCriteriaItems.map((c) => ({ id: c.id, key: c.key, text: c.text })),
  tasks: Object.fromEntries(await Promise.all(Object.entries({ p1, p2, p3, p4, ...(p5 ? { p5 } : {}) })
    .map(async ([k, t]) => [k, brief(await getTask(t.id))]))),
  dependencies: { p2: [p1.id], p3: [p2.id] },
  openItems: [...items(openItems.needsYou, 'needsYou'), ...items(openItems.withCoordinator, 'withCoordinator')],
  questionItemId: question?.itemId ?? null,
  promotion: promotion ? { id: promotion.promotionId, state: promotion.state, sourceRef: promotion.sourceRef, upstreamRef: promotion.upstreamRef, tasks: promotion.taskIds } : null,
  blockers: (main.blockers?.open ?? []).map((b) => ({ id: b.id, kind: b.kind, requiredAction: b.requiredAction, subject: `${b.subjectType}:${b.subjectId}` })),
  mode: 'manual (start automatic=false sets coordinatorEnabled=false): exceptions go to the owner (NO_COORDINATOR)',
};
save();

// ── project 2: not started, no coordinator, dependencies only ───────────────────────────────────────
const later = await call('POST', '/projects', T, {
  title: 'A11 Tablet layout (not started)',
  goal: 'Adapt the Tasks and Projects pages to tablets.',
  instructions: 'Not started on purpose: the app\'s Start flow can be checked on it.',
  acceptanceCriteriaItems: [
    { text: 'Two-pane layout on tablets', verificationMethod: 'Screenshot on a 10-inch emulator' },
    { text: 'No regressions on phones', verificationMethod: 'Device journeys stay green' },
  ],
  coordinatorEnabled: false,
  maxConcurrentTasks: 1,
});
const q1 = await call('POST', '/tasks', T, { projectId: later.id, title: 'Measure the breakpoints', ...OWNER_OK });
const q2 = await call('POST', '/tasks', T, { projectId: later.id, title: 'Build the two-pane shell', dependsOnTaskIds: [q1.id], ...OWNER_OK });
const q3 = await call('POST', '/tasks', T, { projectId: later.id, title: 'Tablet screenshots', dependsOnTaskIds: [q2.id], ...OWNER_OK });
seed.projects.notStarted = {
  id: later.id, title: later.title, status: later.status, startedAt: later.startedAt ?? null, coordinatorEnabled: false,
  tasks: { q1: brief(q1), q2: brief(q2), q3: brief(q3) },
  dependencies: { q2: [q1.id], q3: [q2.id] },
};
save();

// ── permission check: the member against the owner's objects ───────────────────────────────────────
const probe = async (path) => { try { await call('GET', path, memberT); return 'visible (200)'; } catch (e) { return e instanceof HttpError ? `refused ${e.status}` : String(e); } };
seed.memberCheck = {
  [`GET /api/projects/${main.id}`]: await probe(`/projects/${main.id}`),
  [`GET /api/tasks/${prereq.id}`]: await probe(`/tasks/${prereq.id}`),
  'GET /api/projects (count)': (await call('GET', '/projects', memberT)).length,
  'GET /api/tasks/page (items)': ((await call('GET', '/tasks/page?limit=50', memberT)).items ?? []).length,
};
save();
console.log(JSON.stringify({ projects: Object.keys(seed.projects), refused: seed.refused.map((r) => r.what) }, null, 1));
