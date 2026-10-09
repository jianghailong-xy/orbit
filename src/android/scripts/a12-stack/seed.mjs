// Seeds the isolated A12 stack (FRESH database: run it through `setup.sh reset`) through its real HTTP API, and
// writes accounts.json (the test credentials, mode 0600) and seed.json (every id, how it was made, and each
// read-back that checked it).
//
// No row is written to the database directly. The owner's calls carry the owner's JWT and the other account's
// carry theirs. The agent's proposals go through the runner door (POST /api/runner/wiki/changesets) with the
// stack runner's own token and the header of a session that runner hosts — what a session's `wiki_propose` sends.
// That session runs for real on the stack runner, whose only engine is the fake `claude` in runner-path/ (no
// model, no account). After every write the server is read back, and a read-back that does not hold stops the
// seed (each one is listed in seed.json → checks).
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { API, S, accountsFile, call, request, sameId, seedFile, HttpError } from './lib.mjs';

const seed = {
  api: API,
  sourceSha: readFileSync(`${S}/SOURCE_SHA`, 'utf8').trim(),
  createdAt: new Date().toISOString(),
  accounts: {},
  runner: {},
  workspace: {},
  session: {},
  wiki: {},
  task: {},
  watch: {},
  other: {},
  crossAccount: {},
  checks: [],
  gaps: [],
  dbWrites: [],
};
const save = () => writeFileSync(seedFile, JSON.stringify(seed, null, 2) + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A read-back that must hold: recorded either way, and the seed stops on the first that does not. */
function check(what, holds, seen) {
  seed.checks.push({ what, pass: !!holds, seen });
  console.log(holds ? '✓' : '✗', what);
  if (!holds) {
    save();
    throw new Error(`read-back failed: ${what}: ${JSON.stringify(seen).slice(0, 1_000)}`);
  }
}

async function until(what, fn, { timeoutMs = 120_000, everyMs = 2_000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ── accounts ───────────────────────────────────────────────────────────────────────────────────────
// Hex passwords, made per seeding and kept only in accounts.json (0600): safe on an `am instrument -e` line.
const password = () => randomBytes(16).toString('hex');
const OWNER = { email: 'owner@a12.test', name: 'A12 Owner', password: password() };
const OTHER = { email: 'other@a12.test', name: 'A12 Other', password: password() };
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
const made = await call('POST', '/admin/users', T, { email: OTHER.email, name: OTHER.name, password: OTHER.password });
const O = (await call('POST', '/auth/login', undefined, { email: OTHER.email, password: OTHER.password })).accessToken;
const ownerAgain = (await call('POST', '/auth/login', undefined, { email: OWNER.email, password: OWNER.password })).accessToken;
const users = await call('GET', '/admin/users', T);
const roleOf = (id) => users.find((u) => sameId(u.id, id))?.role ?? null;
writeFileSync(accountsFile, JSON.stringify({
  api: API,
  note: `Test-only accounts on the isolated A12 stack (${new URL(API).host}). Never valid anywhere else.`,
  owner: { ...OWNER, id: boot.user.id, role: roleOf(boot.user.id) },
  other: { ...OTHER, id: made.id, role: roleOf(made.id) },
}, null, 2) + '\n', { mode: 0o600 });
chmodSync(accountsFile, 0o600);  // `mode` applies only to a new file
seed.accounts = {
  owner: { id: boot.user.id, email: OWNER.email, role: roleOf(boot.user.id), how: 'POST /api/auth/bootstrap' },
  other: { id: made.id, email: OTHER.email, role: roleOf(made.id), how: 'POST /api/admin/users {password}' },
};
check('both accounts sign in through POST /api/auth/login', typeof O === 'string' && typeof ownerAgain === 'string', { owner: !!ownerAgain, other: !!O });
check('the owner is the bootstrap ADMIN and the other account a MEMBER', roleOf(boot.user.id) === 'ADMIN' && roleOf(made.id) === 'MEMBER', seed.accounts);
save();

// ── the stack runner, a workspace on it, and one real session ─────────────────────────────────────
const enroll = await call('POST', '/runners/enrollment-tokens', T, { label: 'a12-stack-runner' });
execFileSync(`${S}/setup.sh`, ['register', enroll.token], { stdio: 'inherit' });
execFileSync(`${S}/setup.sh`, ['start'], { stdio: 'inherit' });
const runner = await until('the stack runner to come online', async () => (await call('GET', '/runners', T)).find((r) => r.online));
const runnerToken = JSON.parse(readFileSync(`${S}/runner-home/config.json`, 'utf8')).runnerToken;
check('the stack runner is registered to the owner and online', runner.online === true && typeof runnerToken === 'string', { id: runner.id, name: runner.name, version: runner.version });
seed.runner = { id: runner.id, name: runner.name, version: runner.version, how: 'POST /api/runners/enrollment-tokens + `orbit register --token` (the real runner, fake engine)' };

const ws = await call('POST', '/workspaces', T, {
  name: 'a12-sandbox',
  description: 'Throwaway git repo on the isolated A12 stack runner (fake engine: no model is ever called)',
  runnerId: runner.id,
  workDir: `${S}/runner-work`,
  enableWorktree: false,
});
const wsBack = (await call('GET', '/workspaces', T)).find((w) => sameId(w.id, ws.id));
check('the workspace is the owner\'s, on the stack runner', sameId(wsBack?.runnerId, runner.id), wsBack && { id: wsBack.id, runnerId: wsBack.runnerId });
seed.workspace = { id: ws.id, name: ws.name, workDir: `${S}/runner-work`, how: 'POST /api/workspaces' };

const PROMPT = 'A12 live check: the owner reads every wiki write back from the server, and a proposal accepted after its entry moved on is recorded as a conflict.';
const session = await call('POST', '/sessions', T, { workspaceId: ws.id, prompt: PROMPT });
const SETTLED = ['AWAITING_INPUT', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'];
const answered = await until('the stack runner to claim and answer the session', async () => {
  const s = await call('GET', `/sessions/${session.id}`, T);
  return SETTLED.includes(s.status) ? s : null;
}, { timeoutMs: 300_000, everyMs: 3_000 });
check('the session ran on the stack runner and waits for input', answered.status === 'AWAITING_INPUT' || answered.status === 'SUCCEEDED',
  { id: answered.id, status: answered.status, assignedRunnerId: answered.assignedRunnerId ?? null });
seed.session = { id: session.id, status: answered.status, prompt: PROMPT, how: 'POST /api/sessions (claimed and answered by the stack runner)' };
save();

// ── the owner's Wiki space ────────────────────────────────────────────────────────────────────────
const W = (path) => `/wiki${path}`;
const space = await call('POST', W('/spaces'), T, { title: 'A12 live wiki', slug: 'a12-live' });
check('a new space is Tiered (the default)', space.settings?.reviewMode === 'tiered', space.settings);
await call('PATCH', W(`/spaces/${space.id}`), T, { reviewMode: 'manual' });
let spaceBack = await call('GET', W(`/spaces/${space.id}`), T);
check('the space reads back Manual: an agent\'s proposal waits for the owner', spaceBack.settings?.reviewMode === 'manual', spaceBack.settings);
await call('POST', W(`/spaces/${space.id}/workspaces`), T, { workspaceId: ws.id });
seed.wiki.space = { id: space.id, slug: space.slug, title: space.title, how: 'POST /api/wiki/spaces, PATCH reviewMode manual, POST …/workspaces (binding)' };
save();

/** The owner's own write (the user door): applies at once, read back entry by entry. */
async function ownerWrite(ops, rationale) {
  const answer = await call('POST', W(`/spaces/${space.id}/changesets`), T, { rationale, ops, idempotencyKey: `a12-seed:${randomUUID()}` });
  check(`owner write applied: ${rationale}`, answer.ops.every((op) => op.status === 'applied'), answer.ops.map((op) => ({ status: op.status, entryId: op.entryId, revision: op.revision })));
  return answer;
}
async function entry(id, who = T) { return call('GET', W(`/entries/${id}?include=history`), who); }

const ENTRIES = {
  principle: {
    kind: 'principle', title: 'Read every write back',
    summary: 'A write is done when the server says so, not when the client drew it.',
    fields: { statement: 'Every write a client makes is read back from the server before it is reported as done.', rationale: 'A client\'s own state is not evidence that the server kept the write.' },
  },
  search: {
    kind: 'concept', title: 'Live stack readback',
    summary: 'The server read with the acting account\'s own token after the app wrote.',
    fields: { definition: 'A device journey\'s check that reads the isolated server with the acting account\'s own token after the UI wrote.', boundaries: 'Not a fixture journal: the stack\'s database is the authority.' },
  },
  decision: {
    kind: 'decision', title: 'Device journeys sign in before launch',
    summary: 'Only the login journey uses the form; the others sign in before the Activity starts.',
    fields: {
      context: 'AuthSession publishes SignedIn from its own thread; under the Compose test rule a live composition can recompose there.',
      decision: 'Sign in with AuthSession.login before ActivityScenario.launch, and sign out after the scenario is closed.',
      alternatives: [{ option: 'Sign in on the login form in every journey', whyRejected: 'It crashed twice at dark/200% with CalledFromWrongThreadException.' }],
      consequences: 'Production is unaffected; only the login journey exercises the form.',
      decidedAt: '2026-10-07',
    },
  },
  stale: {
    kind: 'pitfall', title: 'Accepting a proposal its entry outgrew',
    summary: 'A proposal written against an older revision cannot be applied once the entry moved on.',
    fields: { trigger: { paths: ['src/android/app/src/main/kotlin/io/orbitd/android/wiki/WikiStore.kt'], commands: [] }, symptom: 'The owner presses Accept and nothing changes on the entry.', cause: 'The op names a base revision the entry is no longer at.', fix: 'Show the refusal and read the entry again.' },
  },
  edit: {
    kind: 'pitfall', title: 'Wiki edits carry their base revision',
    summary: 'An edit names the revision it was made against, so a lost race is a 409 rather than a silent overwrite.',
    fields: { trigger: { paths: ['src/android/app/src/main/kotlin/io/orbitd/android/wiki/WikiEntry.kt'], commands: [] }, symptom: 'Two edits of one entry, the second overwriting the first.', cause: 'An amend sent without its base revision.', fix: 'Send baseRevision with every amend.' },
  },
};
seed.wiki.entries = {};
for (const [key, draft] of Object.entries(ENTRIES)) {
  const { kind, title, summary, fields } = draft;
  const answer = await ownerWrite([{ op: 'add', entry: { kind, title, summary, fields } }], `seed: the owner writes "${title}"`);
  const id = answer.ops[0].entryId;
  const back = await entry(id);
  check(`entry "${title}" reads back active, owner-trusted, revision 1`, back.status === 'active' && back.trust === 'owner' && back.currentRevision === 1 && back.title === title,
    { status: back.status, trust: back.trust, currentRevision: back.currentRevision, title: back.title });
  seed.wiki.entries[key] = { id, kind, title, summary, revision: back.currentRevision, how: 'POST /api/wiki/spaces/:id/changesets (owner door, applies at once)' };
}
save();

// ── the agent's proposals: the runner door, as the session the stack runner hosts ─────────────────
const agent = { runner: runnerToken, session: session.id };
async function propose(body, what) {
  const answer = await request('POST', '/runner/wiki/changesets', agent, { ...body, idempotencyKey: `a12-seed:${randomUUID()}` });
  check(`${what}: the runner door answers 200`, answer.status === 200, { status: answer.status, body: answer.body });
  return answer.body;
}
async function changeset(id) { return call('GET', W(`/changesets/${id}`), T); }

const fresh = await propose({
  rationale: 'what this session learned about checking writes',
  ops: [{
    op: 'add',
    entry: {
      kind: 'pitfall', title: 'A write the app showed but the server never kept',
      summary: 'Reading the server back after a write is what tells a kept write from a drawn one.',
      fields: { trigger: { paths: ['src/android/app/src/androidTest/kotlin/io/orbitd/android/wiki/WikiWatchLiveTest.kt'], commands: [] }, symptom: 'The page says Saved while the server still has the old text.', cause: 'The client trusted its own state.', fix: 'Read the server back with the acting account\'s token.' },
    },
    sources: [{ kind: 'turn', session: 'self', seq: 1, quote: 'reads every wiki write back from the server' }],
  }],
}, 'the fresh proposal (an add)');
check('the fresh add waits for the owner', fresh.ops[0].status === 'pending', fresh.ops[0]);
const staleTarget = seed.wiki.entries.stale;
const stale = await propose({
  rationale: 'a sharper summary for the entry, written against revision 1',
  ops: [{
    op: 'amend', entryId: staleTarget.id, baseRevision: 1,
    changes: { summary: 'An acceptance of a proposal whose entry moved on applies nothing and is recorded as a conflict.' },
    sources: [{ kind: 'turn', session: 'self', seq: 1, quote: 'recorded as a conflict' }],
  }],
}, 'the proposal that will be stale (an amend at revision 1)');
check('the amend waits for the owner', stale.ops[0].status === 'pending', stale.ops[0]);
const review = await call('GET', W(`/review?space=${space.id}`), T);
const waiting = review.flatMap((cs) => cs.ops.filter((op) => op.decision === 'pending').map((op) => op.id));
check('Review lists both proposals as pending', waiting.some((id) => sameId(id, fresh.ops[0].opId)) && waiting.some((id) => sameId(id, stale.ops[0].opId)), { waiting });
const freshCs = await changeset(fresh.changesetId);
check('the fresh proposal is the session\'s, in this space', sameId(freshCs.sessionId, session.id) && sameId(freshCs.spaceId, space.id) && freshCs.origin === 'agent',
  { sessionId: freshCs.sessionId, spaceId: freshCs.spaceId, origin: freshCs.origin });

// The owner moves the entry on (revision 2), so the amend written at revision 1 is stale.
const moved = await ownerWrite([{ op: 'amend', entryId: staleTarget.id, baseRevision: 1, changes: { summary: 'The owner rewrote this after the agent proposed its amendment.' } }],
  'seed: the owner moves the entry on, so the pending amend is stale');
const staleBack = await entry(staleTarget.id);
check('the stale target reads back at revision 2 with the owner\'s summary', staleBack.currentRevision === 2 && staleBack.summary === 'The owner rewrote this after the agent proposed its amendment.',
  { currentRevision: staleBack.currentRevision, summary: staleBack.summary, revision: moved.ops[0].revision });
const staleCs = await changeset(stale.changesetId);
check('the amend is still pending at base revision 1', staleCs.ops[0].decision === 'pending' && staleCs.ops[0].baseRevision === 1,
  { decision: staleCs.ops[0].decision, baseRevision: staleCs.ops[0].baseRevision });
seed.wiki.proposals = {
  fresh: { changesetId: fresh.changesetId, opId: fresh.ops[0].opId, op: 'add', entryId: fresh.ops[0].entryId, title: 'A write the app showed but the server never kept', how: 'POST /api/runner/wiki/changesets (runner token + X-Orbit-Session-Id)' },
  stale: { changesetId: stale.changesetId, opId: stale.ops[0].opId, op: 'amend', entryId: staleTarget.id, baseRevision: 1, entryRevisionNow: staleBack.currentRevision, entrySummaryNow: staleBack.summary, how: 'POST /api/runner/wiki/changesets, then the owner amended the entry to revision 2' },
};
save();

// ── a run: what a review mode applies at once (contract reviewModes.run), through the same agent door ────
// Tiered takes an agent's untainted add and applies it at once; that changeset is a run, which Recently changed
// folds into one row with Revert run…. Back to Manual afterwards, so nothing else the journeys do is applied by a mode.
await call('PATCH', W(`/spaces/${space.id}`), T, { reviewMode: 'tiered' });
spaceBack = await call('GET', W(`/spaces/${space.id}`), T);
check('the space reads back Tiered for the run', spaceBack.settings?.reviewMode === 'tiered', spaceBack.settings);
const run = await propose({
  rationale: 'what this session learned about runs',
  ops: [{
    op: 'add',
    entry: {
      kind: 'concept', title: 'A run the review mode applied',
      summary: 'A changeset a review mode applied at once, which the owner can take back in one press.',
      fields: { definition: 'A changeset whose ops the space\'s review mode applied without waiting for the owner.', boundaries: 'Not the owner\'s own write, which no revert takes back.' },
    },
    sources: [{ kind: 'turn', session: 'self', seq: 1, quote: 'the owner reads every wiki write back' }],
  }],
}, 'the run (an add Tiered applies at once)');
check('Tiered applied the add at once', run.ops[0].status === 'applied', run.ops[0]);
await call('PATCH', W(`/spaces/${space.id}`), T, { reviewMode: 'manual' });
spaceBack = await call('GET', W(`/spaces/${space.id}`), T);
check('the space reads back Manual again', spaceBack.settings?.reviewMode === 'manual', spaceBack.settings);
const runCs = await changeset(run.changesetId);
check('the run reads back applied by Tiered and revertible', runCs.appliedByMode === 'tiered' && runCs.revertible === true,
  { appliedByMode: runCs.appliedByMode, revertible: runCs.revertible, counts: runCs.counts, spotCheck: runCs.ops[0].spotCheck });
seed.wiki.run = { changesetId: run.changesetId, opId: run.ops[0].opId, entryId: run.ops[0].entryId, title: 'A run the review mode applied', spotCheck: runCs.ops[0].spotCheck === true,
  how: 'PATCH reviewMode tiered, POST /api/runner/wiki/changesets (applied by the mode), PATCH reviewMode manual' };
save();

// ── a task the owner follows ──────────────────────────────────────────────────────────────────────
const task = await call('POST', '/tasks', T, {
  title: 'A12 live: the followed task',
  description: 'Nothing runs it, so it stays open and the watch on it stays live until the journeys control the watch.',
  completionCriterion: 'OWNER_CONFIRMED', ownerConfirmationReason: 'OWNER_TRADE_OFF',
});
const taskBack = await call('GET', `/tasks/${task.id}`, T);
check('the task reads back open', !['DONE', 'FAILED', 'CANCELLED'].includes(taskBack.status), { status: taskBack.status });
seed.task = { id: task.id, title: task.title, status: taskBack.status, how: 'POST /api/tasks' };
const PREDICATE = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' };  // TaskFollowSheet's first condition
const watch = await call('POST', '/watches', T, {
  predicateVersion: 1, predicate: PREDICATE, targets: [{ kind: 'TASK', id: task.id }],
  action: 'NOTIFY_USER', ttlSeconds: 86_400, idempotencyKey: `a12-seed-follow:${randomUUID()}`,
});
const watchBack = await call('GET', `/watches/${watch.id}`, T);
check('the watch reads back ACTIVE, NOTIFY_USER, on the task', watchBack.state === 'ACTIVE' && watchBack.action === 'NOTIFY_USER',
  { state: watchBack.state, action: watchBack.action, targets: watchBack.targets?.map((t) => t.targetResourceId ?? t.id) });
seed.watch = { id: watch.id, state: watchBack.state, predicate: PREDICATE, how: 'POST /api/watches (TaskFollowSheet\'s body: predicateVersion 1, TASK target, NOTIFY_USER, ttl 86400, idempotencyKey)' };
save();

// ── the other account: a space of its own, and none of the owner's ────────────────────────────────
const otherSpace = await call('POST', W('/spaces'), O, { title: 'Other notes', slug: 'other-notes' });
const otherWrite = await call('POST', W(`/spaces/${otherSpace.id}/changesets`), O, {
  rationale: 'seed: the other account writes its own note', idempotencyKey: `a12-seed:${randomUUID()}`,
  ops: [{ op: 'add', entry: { kind: 'concept', title: 'The other account\'s own note', summary: 'Written by other@a12.test in its own space.', fields: { definition: 'An entry of the second account.', boundaries: 'Never shown to the owner.' } } }],
});
const otherEntryBack = await entry(otherWrite.ops[0].entryId, O);
check('the other account\'s own entry reads back in its own space', otherEntryBack.status === 'active' && sameId(otherEntryBack.spaceId, otherSpace.id), { status: otherEntryBack.status, spaceId: otherEntryBack.spaceId });
seed.other = { space: { id: otherSpace.id, slug: otherSpace.slug, title: otherSpace.title }, entry: { id: otherWrite.ops[0].entryId, title: 'The other account\'s own note' } };

const as = async (token, path) => (await request('GET', path, token)).status;
const probes = {
  [`GET /api/wiki/spaces/${space.id}`]: await as(O, W(`/spaces/${space.id}`)),
  [`GET /api/wiki/entries/${seed.wiki.entries.edit.id}`]: await as(O, W(`/entries/${seed.wiki.entries.edit.id}`)),
  [`GET /api/wiki/changesets/${fresh.changesetId}`]: await as(O, W(`/changesets/${fresh.changesetId}`)),
  [`GET /api/watches/${watch.id}`]: await as(O, `/watches/${watch.id}`),
  [`GET /api/tasks/${task.id}`]: await as(O, `/tasks/${task.id}`),
};
check('the other account gets 404 for each of the owner\'s objects', Object.values(probes).every((status) => status === 404), probes);
const otherSpaces = (await call('GET', W('/spaces'), O)).map((s) => s.slug);
check('the other account lists only its own space', otherSpaces.length === 1 && otherSpaces[0] === 'other-notes', otherSpaces);
const ownerProbe = await as(T, W(`/spaces/${otherSpace.id}`));
check('and the owner gets 404 for the other account\'s space', ownerProbe === 404, { status: ownerProbe });
seed.crossAccount = { otherAsksForOwners: probes, otherSpaces, ownerAsksForOthersSpace: ownerProbe };

// ── what makes a maintenance run and a plan draft (recorded, not faked) ───────────────────────────
const plan = await request('GET', W(`/spaces/${space.id}/plan`), T);
const health = await request('GET', W(`/spaces/${space.id}/health`), T);
seed.gaps.push(
  {
    item: 'a maintenance run (origin maintenance) in Recently changed',
    why: 'Made only by a task of the space\'s hidden «Wiki maintenance» list, run by a session on a runner whose engine '
      + 'reads the dossier and proposes through `orbit wiki` (maintenance on, a workspace and a provider set). The stack '
      + 'runner\'s engine is a fake that calls no model, so it would run such a task but write nothing; no run row of '
      + 'origin maintenance is seeded and none is written to the database. The run seeded above is the review mode\'s '
      + '(Tiered) over an agent\'s proposal, which Recently changed folds and Revert takes back the same way.',
    serverSaid: { health: health.status === 200 ? health.body?.maintenance ?? null : { status: health.status } },
  },
  {
    item: 'a plan draft (Contents → Plan, Confirm)',
    why: 'A draft is a plan job run as a task of the same maintenance list; its acceptance (`orbit wiki plan check`) '
      + 'passes only when the run reported a draft the gate let through, which needs a model engine on a runner. With no '
      + 'maintenance workspace the job is held. Not faked in the database.',
    serverSaid: { plan: plan.status === 200 ? { job: plan.body?.job ?? null, current: plan.body?.current ?? null, draft: plan.body?.draft ?? null } : { status: plan.status } },
  },
);
seed.dbWrites = [];
save();
console.log(JSON.stringify({ space: space.id, entries: Object.keys(seed.wiki.entries), proposals: Object.keys(seed.wiki.proposals), run: seed.wiki.run.changesetId, watch: watch.id, checks: seed.checks.length }, null, 1));
