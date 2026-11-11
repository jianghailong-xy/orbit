import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { readOpenListVersion } from './open-list-version';
import { EVIDENCE_REVIEW_TURN_KEY_PREFIX } from './watch-turn-key';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * The Open list answers 304 from `readOpenListVersion` without building the list, so the version
 * must move whenever the list would read differently. Each case changes one thing the list row
 * shows — through Prisma, through raw SQL that leaves `updated_at` alone, or only by the clock
 * passing a threshold — and asserts that the list really changed (so the case means something)
 * and that the version, and the ETag the controller sends, changed with it. The door itself is
 * driven too: a matching If-None-Match is answered without the list being read, and so is a
 * `since=` cursor built at the version that still stands.
 *
 * Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

function inert<T>(): T {
  return new Proxy({}, { get: () => () => undefined }) as T;
}

interface Fixture {
  db: PrismaClient;
  sessions: SessionsService;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  /** A conversation mid-turn, the kind that can hold an approval card. */
  sessionId: string;
  /** A second, settled conversation. */
  otherId: string;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<Fixture> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());
  const prisma = db as unknown as PrismaService;
  const sessions = new SessionsService(
    prisma,
    inert<ConstructorParameters<typeof SessionsService>[1]>(),
    inert<ConstructorParameters<typeof SessionsService>[2]>(),
  );
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  const otherId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `olv-${ownerId}@open-list-version.invalid`, name: 'olv', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'olv-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'olv-workspace', enabled: true } });
  for (const [id, status] of [[sessionId, RunStatus.RUNNING], [otherId, RunStatus.SUCCEEDED]] as const) {
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: `olv ${id}`,
        prompt: 'olv', provider: 'claude', providerBuiltin: true, status, startedAt: new Date(),
        dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
  }
  return { db, sessions, ownerId, runnerId, workspaceId, sessionId, otherId };
}

/** The Open list as the clients receive it. */
async function openList(
  f: Fixture,
  filters: { projectId?: string; includeLanding?: boolean } = {},
): Promise<string> {
  return JSON.stringify(await f.sessions.list(f.ownerId, { view: 'open', ...filters }));
}

/** One GET of the Open list through the controller, as the clients poll it. */
async function poll(
  f: Fixture,
  ifNoneMatch?: string,
  filters: { projectId?: string; includeLanding?: boolean; since?: string } = {},
) {
  let listed = 0;
  const service = new Proxy(f.sessions, {
    get(target, key, receiver) {
      if (key === 'list') {
        return (...args: Parameters<SessionsService['list']>) => {
          listed += 1;
          return target.list(...args);
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const controller = new SessionsController(service, {} as never, {} as never, {} as never, {} as never, {} as never);
  const headers: Record<string, string> = {};
  let status = 200;
  const res = {
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
    status: (code: number) => { status = code; return res; },
  };
  const body = await controller.list(
    { userId: f.ownerId } as never,
    undefined, undefined, undefined, undefined, 'open', undefined,
    filters.projectId, filters.includeLanding ? '1' : undefined, filters.since, ifNoneMatch, res as never,
  );
  return { etag: headers.etag, body, listed, status };
}

type Row = { id: string; title: string };
type Delta =
  | { full: true; sessions: Row[]; cursor: string }
  | { full: false; upserts: Row[]; removedIds: string[]; order?: string[]; cursor: string };

/** One `since=` read of the Open list through the controller, as the native clients poll it. */
async function pollSince(f: Fixture, since: string) {
  const { body, listed } = await poll(f, undefined, { since });
  return { delta: body as unknown as Delta, listed };
}

/** Assert that `change` moves the list, the version and the ETag, and that an unchanged poll is a hit. */
async function changes(f: Fixture, label: string, change: () => Promise<unknown>): Promise<void> {
  const before = await poll(f);
  const listBefore = await openList(f);
  const hit = await poll(f, before.etag);
  assert.equal(hit.status, 304, `${label}: an unchanged list was not answered from the version`);
  assert.equal(hit.body, undefined);
  assert.equal(hit.listed, 0, `${label}: an unchanged list was built anyway`);
  await change();
  assert.notEqual(await openList(f), listBefore, `${label}: the change did not reach the list (the case proves nothing)`);
  const after = await poll(f, before.etag);
  assert.notEqual(after.etag, before.etag, `${label}: the list changed but its ETag did not`);
  assert.equal(after.status, 200, `${label}: a changed list was answered 304`);
  assert.equal(after.listed, 1, `${label}: a changed list was not rebuilt`);
  assert.ok(after.body, `${label}: a changed list was not sent`);
}

test('an unchanged Open list keeps its version and is answered without being read', { skip }, async (t) => {
  const f = await fixture(t);
  const first = await poll(f);
  assert.match(first.etag, /^W\/"ol1-[A-Za-z0-9_-]+"$/);
  assert.equal(first.listed, 1);
  assert.equal(await readOpenListVersion(f.db as never, f.ownerId), await readOpenListVersion(f.db as never, f.ownerId));
  const second = await poll(f, first.etag);
  assert.equal(second.etag, first.etag);
  assert.equal(second.status, 304);
  assert.equal(second.listed, 0);
  assert.equal(second.body, undefined);
});

test('every source the Open list row shows moves its version', { skip }, async (t) => {
  const f = await fixture(t);
  const { db } = f;
  await changes(f, 'session title (Prisma)', () =>
    db.session.update({ where: { id: f.sessionId }, data: { title: 'renamed' } }));
  await changes(f, 'retry_at by raw SQL, updated_at untouched', () =>
    db.$executeRaw`UPDATE session SET retry_at = now() + interval '1 hour' WHERE id = ${f.otherId}::uuid`);
  await changes(f, 'a new session', () => db.session.create({
    data: {
      ownerId: f.ownerId, creatorId: f.ownerId, workspaceId: f.workspaceId, title: 'new', prompt: 'new',
      status: RunStatus.PENDING, dispatchOrigin: SessionDispatchOrigin.USER,
    },
  }));
  await changes(f, 'a session completed', () =>
    db.session.update({ where: { id: f.otherId }, data: { completedAt: new Date() } }));
  await changes(f, 'workspace renamed', () =>
    db.workspace.update({ where: { id: f.workspaceId }, data: { name: 'renamed workspace' } }));
  await changes(f, 'runner heartbeat', () =>
    db.runner.update({ where: { id: f.runnerId }, data: { lastHeartbeatAt: new Date(Date.now() + 1_000) } }));
  // A beat lands in the runner's presence row (migration 0444) and leaves its own row alone, so the
  // row the list shows moves without the runner row's version moving at all.
  await changes(f, 'runner presence beat, the runner row untouched', () =>
    db.runnerPresence.create({ data: { runnerId: f.runnerId, lastBeatAt: new Date(Date.now() + 2_000), linkState: 'HTTP' } }));
  await changes(f, 'the next presence beat', () =>
    db.runnerPresence.update({ where: { runnerId: f.runnerId }, data: { lastBeatAt: new Date(Date.now() + 3_000) } }));
  const tag = await db.sessionTag.create({ data: { ownerId: f.ownerId, name: 'olv-tag', color: '#ff0000' } });
  await changes(f, 'tag linked', () => db.sessionTagLink.create({ data: { sessionId: f.sessionId, tagId: tag.id } }));
  await changes(f, 'tag renamed', () => db.sessionTag.update({ where: { id: tag.id }, data: { name: 'olv-tag-2' } }));
  await changes(f, 'pending approval', () => db.approval.create({
    data: { sessionId: f.sessionId, toolName: 'Bash', input: {}, toolUseId: `toolu_${randomUUID()}` },
  }));
  await changes(f, 'share link', () => db.shareLink.create({
    data: { ownerId: f.ownerId, sessionId: f.sessionId, token: randomUUID() },
  }));
  const task = await db.task.create({
    data: {
      ownerId: f.ownerId, title: 'olv task', creatorType: 'USER', creatorId: f.ownerId,
      completionCriterion: 'OWNER_CONFIRMED',
    },
  });
  await changes(f, 'session given a task', () =>
    db.session.update({ where: { id: f.sessionId }, data: { taskId: task.id } }));
  // An unanswered turn moves currentTurnStartedAt; its table carries the counter.
  await changes(f, 'an unanswered turn arrives', () => db.conversationTurn.create({
    data: {
      sessionId: f.sessionId, seq: 1, clientTurnId: `turn-${randomUUID()}`, kind: 'message',
      content: 'hello', status: 'IN_FLIGHT', deliveredAt: new Date(),
    },
  }));
  await changes(f, 'task renamed', () => db.task.update({ where: { id: task.id }, data: { title: 'olv task 2' } }));
  // The counter is bumped by the table itself, so a write that never goes through Prisma's
  // updatedAt still moves it.
  await changes(f, 'task title by raw SQL, updated_at untouched', () =>
    db.$executeRaw`UPDATE task SET title = 'olv task 3' WHERE id = ${task.id}::uuid`);
  // One statement over more than one row: the trigger is statement-level and must bump once for
  // the statement, not once per row, and must not stop at the first row's owner.
  const secondTask = await db.task.create({
    data: {
      ownerId: f.ownerId, title: 'olv task second', creatorType: 'USER', creatorId: f.ownerId,
      completionCriterion: 'OWNER_CONFIRMED',
    },
  });
  await changes(f, 'two tasks renamed in one statement', () =>
    db.task.updateMany({ where: { id: { in: [task.id, secondTask.id] } }, data: { title: 'bulk renamed' } }));
  const project = await db.project.create({ data: { ownerId: f.ownerId, title: 'olv project' } });
  await changes(f, 'session made a coordinator', () =>
    db.project.update({ where: { id: project.id }, data: { coordinatorSessionId: f.sessionId } }));
  await changes(f, 'project renamed', () =>
    db.project.update({ where: { id: project.id }, data: { title: 'olv project 2' } }));
  // A merge approval on the coordinator's row names the project's main branch
  // (`ownerItems[].mainBranch`), read off its binding: binding a repository and moving its main
  // branch both change the row.
  const now = new Date();
  await changes(f, 'owner item', () => db.projectOpenItem.create({
    data: {
      projectId: project.id, ownerId: f.ownerId, kind: 'PROMOTION_APPROVAL', state: 'OPEN', assignee: 'OWNER',
      assigneeReason: 'DEFAULT', dedupeKey: `olv:${project.id}`, title: 'Approve merge to main',
      payload: {}, waitingSince: now, assignedAt: now,
    },
  }));
  await changes(f, 'repository bound', () => db.projectCodebase.create({
    data: {
      ownerId: f.ownerId, projectId: project.id, canonicalRepoUrl: `https://github.com/example/olv-${project.id}`,
      upstreamRef: 'refs/heads/main', integrationRef: 'refs/heads/main', refAuthority: 'REMOTE',
    },
  }));
  await changes(f, 'main branch moved by raw SQL, updated_at untouched', () =>
    db.$executeRaw`UPDATE project_codebase SET upstream_ref = 'refs/heads/master',
      integration_ref = 'refs/heads/master' WHERE project_id = ${project.id}::uuid`);
});

test('a threshold the clock passes moves the version with no write', { skip }, async (t) => {
  const f = await fixture(t);
  // The runner's heartbeat ages out on the JS clock the capability check uses.
  const now = Date.now();
  assert.notEqual(
    await readOpenListVersion(f.db as never, f.ownerId, now),
    await readOpenListVersion(f.db as never, f.ownerId, now + 91_000),
    'a runner going offline by the clock alone did not move the version',
  );
  // A background job going quiet, which takes it out of the row's runningBgJobCount.
  await f.db.$executeRaw`UPDATE session SET running_bg_jobs = ARRAY['bgj_quiet'],
    running_bg_job_activity = ${JSON.stringify({ bgj_quiet: now - 599_000 })}::jsonb WHERE id = ${f.sessionId}::uuid`;
  assert.notEqual(
    await readOpenListVersion(f.db as never, f.ownerId, now),
    await readOpenListVersion(f.db as never, f.ownerId, now + 2_000),
    'a job going quiet by the clock alone did not move the version',
  );
  // A share link expiring on Postgres' clock, which `listRows` decides `shared` on.
  await f.db.$executeRaw`INSERT INTO share_link (id, owner_id, session_id, token, expires_at)
    VALUES (gen_random_uuid(), ${f.ownerId}::uuid, ${f.sessionId}::uuid, ${randomUUID()}, now() + interval '1500 milliseconds')`;
  const before = await poll(f);
  const listBefore = await openList(f);
  await sleep(2_000);
  assert.notEqual(await openList(f), listBefore, 'the link did not expire in the list');
  const after = await poll(f, before.etag);
  assert.notEqual(after.etag, before.etag, 'an expired share link left the ETag alone');
  assert.equal(after.listed, 1);
});

/**
 * The evidence-review hold ends 30 minutes after its turn was delivered. The delivery moment is
 * stamped onto the evidence row by migration 0484's trigger (the probe no longer joins the turn
 * and the task to find it), so this case also pins the trigger's prefix to the TypeScript constant
 * that SQL cannot import: a change to one without the other is red here.
 */
test('an evidence-review window closing moves the version with no write', { skip }, async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  const task = await f.db.task.create({
    data: {
      ownerId: f.ownerId, title: 'olv evidence task', creatorType: 'USER', creatorId: f.ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT', creatorSessionId: f.sessionId,
    },
  });
  const evidence = await f.db.taskCompletionEvidence.create({
    data: {
      taskId: task.id, ownerId: f.ownerId, actorType: 'USER', actorId: f.ownerId,
      sourceSessionId: randomUUID(), criterionRevision: 'a'.repeat(64),
      criterion: { completionCriterion: 'EVIDENCE_JUDGMENT' }, evidence: { artifact: 'olv' },
      evidenceDigest: 'b'.repeat(64), revision: 1n,
    },
  });
  const delivered = new Date(now - 1_800_000 + 60_000); // the window closes a minute from now
  await f.db.conversationTurn.create({
    data: {
      sessionId: f.sessionId, seq: 1, kind: 'message', status: 'IN_FLIGHT',
      clientTurnId: `${EVIDENCE_REVIEW_TURN_KEY_PREFIX}${evidence.id}`,
      deliveredAt: delivered, createdAt: delivered,
    },
  });
  const stamped = await f.db.taskCompletionEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
  assert.equal(stamped.reviewTurnAt?.getTime(), delivered.getTime(),
    'the delivery turn did not stamp the evidence row (the trigger and the prefix have drifted)');
  // Keep the runner online across the comparison, so only the review window moves.
  await f.db.runner.update({ where: { id: f.runnerId }, data: { lastHeartbeatAt: new Date(now + 3_600_000) } });
  assert.notEqual(
    await readOpenListVersion(f.db as never, f.ownerId, now),
    await readOpenListVersion(f.db as never, f.ownerId, now + 120_000),
    'an evidence-review window closing by the clock alone did not move the version',
  );
});

/**
 * The version reads counters instead of rows (migration 0484), so a source whose table has no
 * triggers is a source that silently stops invalidating. This is the list of tables the probe's
 * counters cover; a new source added to the row must add its table here and in the migration.
 */
test('every counter source has its table triggers', { skip }, async (t) => {
  const f = await fixture(t);
  const rows = await f.db.$queryRaw<Array<{ tbl: string; def: string }>>`
    SELECT tgrelid::regclass::text AS tbl, pg_get_triggerdef(oid) AS def
      FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%open_list_epoch%'`;
  const actual = new Set(rows.map(({ tbl, def }) => {
    const table = tbl.replace(/^public\./, '');
    const source = /open_list_bump_(?:owner|via_project|via_session)\('([^']+)'\)/.exec(def)?.[1];
    return `${table}:${source ?? (table === 'session' ? 'session' : '?')}`;
  }));
  const expected = new Set([
    'approval:approval',
    'conversation_turn:conversation_turn',
    'owner_request:owner_request',
    'project:project',
    'project_acceptance_criterion_definition:criterion_definition',
    'project_codebase:codebase',
    'project_coordinator_wake:coordinator_wake',
    'project_criteria_authorship:criteria_authorship',
    'project_criteria_decision:criteria_decision',
    'project_handoff_approval:handoff_approval',
    'project_integration_job:integration_job',
    'project_open_item:project_open_item',
    'project_promotion:promotion',
    'project_ratified_action_commit:ratified_commit',
    'project_ratified_action_intent:ratified_intent',
    'project_standard_set_confirmation:standard_set_confirmation',
    'project_task_status_count:task_status_count',
    'session:session',
    'session_merge_receipt:merge_receipt',
    'session_request:session_request',
    'session_tag:session_tag',
    'session_tag_link:session_tag_link',
    'task:task',
    'task_completion_evidence:completion_evidence',
    'task_evidence_decision:evidence_decision',
    'task_owner_confirmation_claim:confirmation_claim',
    'task_owner_confirmation_request:confirmation_request',
    'task_owner_confirmation_review:confirmation_review',
    'task_owner_confirmation_review_record:confirmation_review_record',
    'task_owner_decision:owner_decision',
    'workspace:workspace',
  ]);
  assert.deepEqual([...actual].sort(), [...expected].sort());
});

test("another account's writes leave this account's version alone", { skip }, async (t) => {
  const mine = await fixture(t);
  const theirs = await fixture(t);
  const theirTask = await theirs.db.task.create({
    data: {
      ownerId: theirs.ownerId, title: 'theirs', creatorType: 'USER', creatorId: theirs.ownerId,
      completionCriterion: 'OWNER_CONFIRMED',
    },
  });
  const before = await readOpenListVersion(mine.db as never, mine.ownerId);
  await theirs.db.session.update({ where: { id: theirs.sessionId }, data: { title: 'theirs' } });
  assert.equal(await readOpenListVersion(mine.db as never, mine.ownerId), before);
  await theirs.db.task.update({ where: { id: theirTask.id }, data: { title: 'theirs renamed' } });
  assert.equal(await readOpenListVersion(mine.db as never, mine.ownerId), before);
});

/** A connection of its own, for a transaction held open beside the writes under test. */
async function connection(t: { after: (fn: () => Promise<void>) => void }): Promise<Client> {
  const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await client.connect();
  t.after(() => client.end());
  return client;
}

/** How many rows the account's `session` counter is spread over (0487). */
async function sessionCounterRows(f: Fixture): Promise<number> {
  const [row] = await f.db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM open_list_epoch
     WHERE owner_id = ${f.ownerId}::uuid AND split_part(source, '#', 1) = 'session'`;
  return row.n;
}

/**
 * 0484 bumped one row per (owner, source) inside the writing transaction, so that row stayed
 * locked until the writer committed, and every other write of the account to the same table
 * queued behind it, rows the two never shared included: the runner link's ingest held its
 * account's session counter through its whole run_event insert. A bump now takes a counter row no
 * other transaction holds, and adds one only when it finds them all held. `lock_timeout` turns a
 * wait into an error (55P03), so a writer that queues fails here instead of only being slow.
 */
test("a write never waits for another open transaction's counter, and still moves the version", { skip }, async (t) => {
  const f = await fixture(t);
  for (const title of ['one', 'two', 'three']) {
    await f.db.session.update({ where: { id: f.sessionId }, data: { title } });
  }
  assert.equal(await sessionCounterRows(f), 1, 'writes one after another took more than one counter row');

  const holder = await connection(t);
  const writer = await connection(t);
  await holder.query('BEGIN');
  await holder.query(`UPDATE session SET title = 'held' WHERE id = $1`, [f.sessionId]);
  const held = await readOpenListVersion(f.db as never, f.ownerId);

  // Another session row of the same account: it shares nothing with the holder but the counter.
  await writer.query(`SET lock_timeout = '500ms'`);
  await writer.query(`UPDATE session SET title = 'beside' WHERE id = $1`, [f.otherId]);
  assert.equal(await sessionCounterRows(f), 2, 'the write beside an open one did not take a row of its own');
  const beside = await readOpenListVersion(f.db as never, f.ownerId);
  assert.notEqual(beside, held, 'a write committed beside an open one did not move the version');

  await holder.query('COMMIT');
  assert.notEqual(await readOpenListVersion(f.db as never, f.ownerId), beside, "the held write's commit did not move the version");

  for (const title of ['four', 'five']) {
    await f.db.session.update({ where: { id: f.otherId }, data: { title } });
  }
  assert.equal(await sessionCounterRows(f), 2, 'a counter grew a row with no writer open beside it');
});

/**
 * 0484's counters were taken in the order a transaction WROTE its tables, which no lock-order rank
 * governs, so two writers taking `session` and `task` in opposite orders deadlocked on them
 * (40P01) though they shared no row. A bump waits for nobody now, so both commit.
 */
test('two writers taking two counters in opposite orders both commit', { skip }, async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all(['a', 'b'].map((name) => f.db.task.create({
    data: {
      ownerId: f.ownerId, title: `olv ${name}`, creatorType: 'USER', creatorId: f.ownerId,
      completionCriterion: 'OWNER_CONFIRMED',
    },
  })));
  const a = await connection(t);
  const b = await connection(t);
  for (const client of [a, b]) {
    await client.query('BEGIN');
    // Longer than deadlock_timeout, so that on 0484 the deadlock detector is what ends the wait.
    await client.query(`SET LOCAL lock_timeout = '5s'`);
  }
  await a.query(`UPDATE session SET title = 'a' WHERE id = $1`, [f.sessionId]);
  await b.query(`UPDATE task SET title = 'b' WHERE id = $1`, [second.id]);
  const crossed = await Promise.allSettled([
    a.query(`UPDATE task SET title = 'a' WHERE id = $1`, [first.id]),
    b.query(`UPDATE session SET title = 'b' WHERE id = $1`, [f.otherId]),
  ]);
  assert.deepEqual(
    crossed.map((outcome) => outcome.status === 'fulfilled' ? 'committed' : (outcome.reason as { code?: string }).code),
    ['committed', 'committed'],
  );
  const before = await readOpenListVersion(f.db as never, f.ownerId);
  await a.query('COMMIT');
  await b.query('COMMIT');
  assert.notEqual(await readOpenListVersion(f.db as never, f.ownerId), before);
});

/**
 * A LANDING row is in no flat list (contract §2.9 LS6), so only the project grouping's
 * `includeLanding=1` read can show it. That read is built every time — its rows are a few — and
 * takes Express's body-hash ETag, while the flat Open list must not move for a change it never
 * shows: a landing insert or settlement leaves its version (and ETag) exactly where it was.
 */
test('a landing insert and its settlement leave the flat Open list alone', { skip }, async (t) => {
  const f = await fixture(t);
  const { db } = f;
  const project = await db.project.create({ data: { ownerId: f.ownerId, title: 'olv landing project' } });
  const codebase = await db.projectCodebase.create({
    data: {
      ownerId: f.ownerId, projectId: project.id,
      canonicalRepoUrl: `https://github.com/example/olv-landing-${project.id}`,
      upstreamRef: 'refs/heads/main', integrationRef: 'refs/heads/main', refAuthority: 'REMOTE',
    },
  });
  const task = await db.task.create({
    data: {
      ownerId: f.ownerId, creatorType: 'USER', creatorId: f.ownerId, title: 'olv landing task',
      projectId: project.id, completionCriterion: 'OWNER_CONFIRMED',
    },
  });
  const scope = { projectId: project.id, includeLanding: true };
  const plain = await poll(f);
  const landing = await poll(f, undefined, scope);
  // A project read never consults the account-wide version: there is no version-derived ETag.
  assert.equal(landing.etag, undefined);
  assert.deepEqual(landing.body, []);
  const landingListBefore = await openList(f, scope);

  // The subject opens and its container row is inserted: a row the landing-aware list shows.
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId: f.ownerId, creatorId: f.ownerId, title: 'Land the task',
      prompt: 'Orbit runs this landing.', status: RunStatus.AWAITING_INPUT,
      sessionKind: 'LANDING', provider: 'orbit', providerBuiltin: true, startsTaskWork: false,
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await db.projectLanding.create({
    data: {
      id: randomUUID(), projectId: project.id, ownerId: f.ownerId, codebaseId: codebase.id,
      subject: 'TASK', taskId: task.id, episode: 1, sessionId,
    },
  });
  assert.notEqual(await openList(f, scope), landingListBefore, 'the insert did not reach the landing-aware list');
  assert.ok((await openList(f, scope)).includes(sessionId), 'the landing row is not in its list');
  const plainAfterInsert = await poll(f, plain.etag);
  assert.equal(plainAfterInsert.status, 304, 'a landing insert moved the plain list');
  assert.equal(plainAfterInsert.etag, plain.etag);
  // Without a project the flag names no list of its own: the plain read is the answer.
  assert.equal((await poll(f, plain.etag, { includeLanding: true })).status, 304);

  // Settlement writes the subject and the container's terminal state.
  await db.projectLanding.update({
    where: { sessionId }, data: { settledAt: new Date(), settledAs: 'LANDED' },
  });
  await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.SUCCEEDED, completedAt: new Date() } });
  const plainAfterSettlement = await poll(f, plain.etag);
  assert.equal(plainAfterSettlement.status, 304, 'a settlement moved the plain list');
  assert.equal(plainAfterSettlement.etag, plain.etag);
});

/**
 * `since=` is the native clients' poll (every 4 s on macOS and iOS), and it answers from the same
 * version first: while the version the cursor was built at stands, the answer is an empty delta
 * under the same cursor and the list is not built. One write that moves the version costs exactly
 * one build, which sends only the row that changed, under a cursor that is answered from the
 * version again.
 */
test('a since= read whose version stands is an empty delta, answered without building the list', { skip }, async (t) => {
  const f = await fixture(t);
  const first = await pollSince(f, '');
  assert.equal(first.delta.full, true);
  assert.equal(first.listed, 1);
  const { cursor } = first.delta;
  for (const read of ['first', 'second']) {
    const unchanged = await pollSince(f, cursor);
    assert.equal(unchanged.listed, 0, `${read} unchanged read: the list was built`);
    assert.deepEqual(unchanged.delta, { full: false, upserts: [], removedIds: [], cursor });
  }

  const version = await readOpenListVersion(f.db as never, f.ownerId);
  await f.db.session.update({ where: { id: f.sessionId }, data: { title: 'renamed' } });
  assert.notEqual(await readOpenListVersion(f.db as never, f.ownerId), version,
    'the write did not move the version (the case proves nothing)');
  const changed = await pollSince(f, cursor);
  assert.equal(changed.listed, 1, 'a moved version did not build the list exactly once');
  assert.equal(changed.delta.full, false);
  const delta = changed.delta as Extract<Delta, { full: false }>;
  assert.deepEqual(delta.upserts.map((row) => [row.id, row.title]), [[f.sessionId, 'renamed']]);
  assert.deepEqual(delta.removedIds, []);
  assert.equal(delta.order, undefined);
  assert.notEqual(delta.cursor, cursor);

  const settled = await pollSince(f, delta.cursor);
  assert.equal(settled.listed, 0, 'the new cursor was not answered from the version');
  assert.deepEqual(settled.delta, { full: false, upserts: [], removedIds: [], cursor: delta.cursor });
});

/**
 * The version is read before the list is built, never after. A write that lands between the build
 * and the snapshot then still moves the version past the one kept beside rows that miss it. Read
 * after the build, the version would already cover that write, and the next read would answer an
 * empty delta over a list that had moved.
 */
test('a write landing after the build is not hidden behind the version kept with the rows', { skip }, async (t) => {
  const f = await fixture(t);
  const racing = new Proxy(f.sessions, {
    get(target, key, receiver) {
      if (key === 'list') {
        return async (...args: Parameters<SessionsService['list']>) => {
          const rows = await target.list(...args);
          await f.db.session.update({ where: { id: f.sessionId }, data: { title: 'written after the build' } });
          return rows;
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const raced = await racing.listOpenSince(f.ownerId, {}, '');
  assert.equal(raced.full, true);
  assert.ok(!JSON.stringify(raced).includes('written after the build'),
    'the write landed before the build (the case proves nothing)');

  const next = await pollSince(f, raced.cursor);
  assert.equal(next.listed, 1, 'a write after the build was answered from the version');
  assert.equal(next.delta.full, false);
  const delta = next.delta as Extract<Delta, { full: false }>;
  assert.deepEqual(delta.upserts.map((row) => [row.id, row.title]), [[f.sessionId, 'written after the build']]);

  const settled = await pollSince(f, delta.cursor);
  assert.equal(settled.listed, 0, 'the cursor that carries the write was not answered from the version');
  assert.deepEqual(settled.delta, { full: false, upserts: [], removedIds: [], cursor: delta.cursor });
});
