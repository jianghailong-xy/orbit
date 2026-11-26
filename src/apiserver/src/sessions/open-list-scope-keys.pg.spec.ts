import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { readOpenListVersionParts } from './open-list-version';
import { fixtureFacts } from '../test-support/session-word';

/**
 * Migration 1464 (docs/list-freshness-scope-hints.md §5.1, §8.2): the Open-list counters of the sources that hang
 * on one session or one workspace are keyed by that workspace, `<source>@w:<ws>` for a row in an Open list and
 * `<source>@c:<ws>` for one in none, with the root rule and the request rule; every other source keeps its account
 * key, and the version still reads each source as one.
 *
 * Every assertion reads the keys a statement moved: each key's total (`split_part(source, '#', 1)`, the shards of
 * one key added up) before and after it. Not destructive: every case owns freshly generated ids.
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

type T = { after: (fn: () => Promise<void> | void) => void };

interface Fixture {
  db: PrismaClient;
  ownerId: string;
  runnerId: string;
  /** Three workspaces of one runner. */
  a: string;
  b: string;
  c: string;
  /** Open conversations: two in A, one in B. */
  a1: string;
  a2: string;
  b1: string;
  /** A completed conversation in A. */
  done: string;
  /** A scheduled run's session in A, in no Open list. */
  scheduled: string;
}

async function session(
  db: PrismaClient,
  f: { ownerId: string; runnerId: string },
  workspaceId: string | null,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId: f.ownerId, creatorId: f.ownerId, workspaceId, assignedRunnerId: f.runnerId, title: `olsk ${id}`,
      prompt: 'olsk', provider: 'claude', providerBuiltin: true, turnState: 'IN_FLIGHT', startedAt: new Date(),
      dispatchOrigin: SessionDispatchOrigin.USER, ...fixtureFacts(extra),
    },
  });
  return id;
}

async function fixture(t: T): Promise<Fixture> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `olsk-${ownerId}@open-list-scope-keys.invalid`, name: 'olsk', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'olsk-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  for (const [id, name] of [[a, 'A'], [b, 'B'], [c, 'C']]) {
    await db.workspace.create({ data: { id, ownerId, runnerId, name: `olsk-${name}`, enabled: true } });
  }
  const base = { ownerId, runnerId };
  const a1 = await session(db, base, a);
  const a2 = await session(db, base, a);
  const b1 = await session(db, base, b);
  const done = await session(db, base, a, { status: RunStatus.SUCCEEDED, finishedAt: new Date(), completedAt: new Date() });
  const scheduled = await session(db, base, a);
  await db.$executeRaw`UPDATE session SET run_source = 'SCHEDULE' WHERE id = ${scheduled}::uuid`;
  return { db, ownerId, runnerId, a, b, c, a1, a2, b1, done, scheduled };
}

/** Each counter key's total for the account. */
async function keys(db: PrismaClient | Client, ownerId: string): Promise<Map<string, bigint>> {
  const sql = `SELECT split_part(source, '#', 1) AS key, sum(epoch)::text AS total
                 FROM open_list_epoch WHERE owner_id = $1::uuid GROUP BY 1`;
  const rows = db instanceof Client
    ? (await db.query<{ key: string; total: string }>(sql, [ownerId])).rows
    : await db.$queryRawUnsafe<Array<{ key: string; total: string }>>(sql, ownerId);
  return new Map(rows.map((row) => [row.key, BigInt(row.total)]));
}

/** The keys `write` moved, each with how far: `{ 'session@w:<A>': 1 }`. */
async function moved(f: Fixture, write: () => Promise<unknown>): Promise<Record<string, number>> {
  const before = await keys(f.db, f.ownerId);
  await write();
  const after = await keys(f.db, f.ownerId);
  const out: Record<string, number> = {};
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const by = (after.get(key) ?? 0n) - (before.get(key) ?? 0n);
    if (by !== 0n) out[key] = Number(by);
  }
  return out;
}

const w = (source: string, ws: string) => `${source}@w:${ws}`;
const c = (source: string, ws: string) => `${source}@c:${ws}`;

/**
 * How every counter source is keyed (§5.1): by the scope of the session or workspace its row hangs on, by both of
 * its sessions' scopes (`session_request`), or by the account. A source added to the catalogue must be classed here.
 */
const CLASS: Record<string, 'scope' | 'peers' | 'account'> = {
  session: 'scope',
  conversation_turn: 'scope',
  approval: 'scope',
  session_tag_link: 'scope',
  scheduled_wakeup: 'scope',
  watch: 'scope',
  workspace: 'scope',
  session_request: 'peers',
  task: 'account',
  project: 'account',
  coordinator_wake: 'account',
  criterion_definition: 'account',
  task_status_count: 'account',
  project_open_item: 'account',
  ratified_intent: 'account',
  ratified_commit: 'account',
  criteria_decision: 'account',
  standard_set_confirmation: 'account',
  promotion: 'account',
  integration_job: 'account',
  codebase: 'account',
  criteria_authorship: 'account',
  merge_receipt: 'account',
  completion_evidence: 'account',
  evidence_decision: 'account',
  confirmation_request: 'account',
  confirmation_claim: 'account',
  owner_decision: 'account',
  confirmation_review: 'account',
  confirmation_review_record: 'account',
  session_tag: 'account',
  owner_request: 'account',
  handoff_approval: 'account',
};

test('1. every source in the trigger catalogue is classed, and its bump function keys it as its class says', { skip }, async (t) => {
  const f = await fixture(t);
  const rows = await f.db.$queryRaw<Array<{ tbl: string; def: string }>>`
    SELECT tgrelid::regclass::text AS tbl, pg_get_triggerdef(oid) AS def
      FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%open_list_epoch%'`;
  const catalogue = new Map<string, { table: string; fn: string }>();
  for (const { tbl, def } of rows) {
    const table = tbl.replace(/^public\./, '');
    const call = /EXECUTE FUNCTION (open_list_bump_\w+)\((?:'([^']+)')?\)/.exec(def);
    assert.ok(call, `${table}: a counter trigger that calls no bump function (${def})`);
    catalogue.set(call[2] ?? 'session', { table, fn: call[1] });
  }
  assert.deepEqual([...catalogue.keys()].sort(), Object.keys(CLASS).sort(), 'a counter source is not classed in CLASS');
  for (const [source, { table, fn }] of catalogue) {
    // What the function does with the source, read from which branch serves it.
    const keyed = fn === 'open_list_bump_session' || fn === 'open_list_bump_via_session' || fn === 'open_list_bump_watch'
      || (fn === 'open_list_bump_owner' && table === 'workspace');
    const peers = fn === 'open_list_bump_owner' && table === 'session_request';
    assert.equal(keyed ? 'scope' : peers ? 'peers' : 'account', CLASS[source], `${source} (${table}, ${fn}) is keyed unlike its class`);
  }
});

test('2. one write per class: each source bumps exactly its key', { skip }, async (t) => {
  const f = await fixture(t);
  const { db } = f;
  // Scope: the session's own row, and every table that hangs on one session or one workspace.
  assert.deepEqual(await moved(f, () => db.session.update({ where: { id: f.a1 }, data: { title: 'renamed' } })), { [w('session', f.a)]: 1 });
  assert.deepEqual(await moved(f, () => db.session.update({ where: { id: f.b1 }, data: { title: 'renamed' } })), { [w('session', f.b)]: 1 });
  assert.deepEqual(await moved(f, () => db.conversationTurn.create({
    data: { sessionId: f.b1, seq: 1, clientTurnId: `olsk-${randomUUID()}`, kind: 'message', content: 'hi', status: 'IN_FLIGHT', deliveredAt: new Date() },
  })), { [w('conversation_turn', f.b)]: 1 });
  assert.deepEqual(await moved(f, () => db.approval.create({
    data: { sessionId: f.a1, toolName: 'Bash', input: {}, toolUseId: `toolu_${randomUUID()}` },
  })), { [w('approval', f.a)]: 1 });
  const tag = await db.sessionTag.create({ data: { ownerId: f.ownerId, name: 'olsk-tag', color: '#ff0000' } });
  assert.deepEqual(await moved(f, () => db.sessionTagLink.create({ data: { sessionId: f.b1, tagId: tag.id } })), { [w('session_tag_link', f.b)]: 1 });
  assert.deepEqual(await moved(f, () => db.sessionScheduledWakeup.create({
    data: { sessionId: f.a2, delaySeconds: 600, reason: 'olsk', dueAt: new Date(Date.now() + 600_000) },
  })), { [w('scheduled_wakeup', f.a)]: 1 });
  const watch = (observer: string) => db.watch.create({
    data: {
      ownerId: f.ownerId, observerType: 'SESSION', observerSessionId: observer,
      predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' }, mode: 'ONE_SHOT', action: 'RESUME_SESSION',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  assert.deepEqual(await moved(f, () => watch(f.b1)), { [w('watch', f.b)]: 1 });
  assert.deepEqual(await moved(f, () => db.workspace.update({ where: { id: f.c }, data: { name: 'olsk-C2' } })), { [w('workspace', f.c)]: 1 });
  // Account: a task, a project, a tag, a project fact through project_id, an owner item, a landing job.
  const task = await db.task.create({
    data: { ownerId: f.ownerId, title: 'olsk task', creatorType: 'USER', creatorId: f.ownerId, completionCriterion: 'OWNER_CONFIRMED' },
  });
  assert.deepEqual(await moved(f, () => db.task.update({ where: { id: task.id }, data: { title: 'olsk task 2' } })), { task: 1 });
  const project = await db.project.create({ data: { ownerId: f.ownerId, title: 'olsk project' } });
  assert.deepEqual(await moved(f, () => db.project.update({ where: { id: project.id }, data: { title: 'olsk project 2' } })), { project: 1 });
  assert.deepEqual(await moved(f, () => db.sessionTag.update({ where: { id: tag.id }, data: { name: 'olsk-tag-2' } })), { session_tag: 1 });
  const now = new Date();
  assert.deepEqual(await moved(f, () => db.projectOpenItem.create({
    data: {
      projectId: project.id, ownerId: f.ownerId, kind: 'PROMOTION_APPROVAL', state: 'OPEN', assignee: 'OWNER',
      assigneeReason: 'DEFAULT', dedupeKey: `olsk:${project.id}`, title: 'Approve merge to main', payload: {}, waitingSince: now, assignedAt: now,
    },
  })), { project_open_item: 1 });
  assert.deepEqual(await moved(f, () => db.projectCoordinatorWake.create({
    data: {
      id: randomUUID(), projectId: project.id, event: 'PROJECT_TASKS_SETTLED', subjectType: 'TASK', subjectId: task.id,
      subjectVersion: '1', idempotencyKey: `olsk:${randomUUID()}`,
    },
  })), { coordinator_wake: 1 });
  // Peers: a request bumps both of its sessions' scopes.
  const [request] = await requestBetween(f, f.a1, f.b1);
  assert.deepEqual(request, { [w('session_request', f.a)]: 1, [w('session_request', f.b)]: 1 });
});

/** One OPEN message request from `from` to `to`, and the keys its insert moved. */
async function requestBetween(f: Fixture, from: string, to: string): Promise<[Record<string, number>, string]> {
  const id = randomUUID();
  const turn = await f.db.conversationTurn.create({
    data: { sessionId: to, seq: 50 + Math.floor(Math.random() * 1_000_000), clientTurnId: `olsk-${randomUUID()}`, kind: 'message', content: 'asked', status: 'PENDING' },
  });
  const keysMoved = await moved(f, () => f.db.$executeRaw`
    INSERT INTO session_request (id, owner_id, from_session_id, to_session_id, turn_id, client_turn_id, request_preview, reply_by, kind)
    VALUES (${id}::uuid, ${f.ownerId}::uuid, ${from}::uuid, ${to}::uuid, ${turn.id}::uuid, ${turn.clientTurnId}, 'asked',
            now() + interval '1 hour', 'MESSAGE')`);
  return [keysMoved, id];
}

test('3. the Open and closed edges: completing, a completed row, a scheduled run, a move, the root rule', { skip }, async (t) => {
  const f = await fixture(t);
  const { db } = f;
  // Completing an Open session moves its workspace's Open key: it leaves that list.
  assert.deepEqual(await moved(f, () => db.session.update({ where: { id: f.a2 }, data: { completedAt: new Date() } })), { [w('session', f.a)]: 1 });
  // A write to a completed one, and to a scheduled run's: in no Open list.
  assert.deepEqual(await moved(f, () => db.session.update({ where: { id: f.done }, data: { title: 'done renamed' } })), { [c('session', f.a)]: 1 });
  assert.deepEqual(await moved(f, () => db.session.update({ where: { id: f.scheduled }, data: { title: 'run renamed' } })), { [c('session', f.a)]: 1 });
  // A schedule's Change… conversation (main's 1447) is in no session list either.
  const change = await session(db, f, f.a);
  await db.$executeRaw`UPDATE session SET run_source = 'SCHEDULE_CHANGE' WHERE id = ${change}::uuid`;
  assert.deepEqual(await moved(f, () => db.session.update({ where: { id: change }, data: { title: 'change renamed' } })), { [c('session', f.a)]: 1 });
  // A turn of a completed session is the closed key too.
  assert.deepEqual(await moved(f, () => db.conversationTurn.create({
    data: { sessionId: f.done, seq: 1, clientTurnId: `olsk-${randomUUID()}`, kind: 'message', content: 'late', status: 'PENDING' },
  })), { [c('conversation_turn', f.a)]: 1 });
  // Reopening is an Open move again.
  assert.deepEqual(await moved(f, () => db.session.update({ where: { id: f.a2 }, data: { completedAt: null } })), { [w('session', f.a)]: 1 });
  // A move between workspaces: both workspaces, and the account (the root rule: a row elsewhere may read it).
  assert.deepEqual(await moved(f, () => db.session.update({ where: { id: f.a2 }, data: { workspaceId: f.c } })),
    { [w('session', f.a)]: 1, [w('session', f.c)]: 1, session: 1 });
  // The root rule: kind, task_id, context_task_id and root_session_id each bump the account key besides the row's.
  const task = await db.task.create({
    data: { ownerId: f.ownerId, title: 'olsk task', creatorType: 'USER', creatorId: f.ownerId, completionCriterion: 'OWNER_CONFIRMED' },
  });
  for (const [what, data] of [
    ['task_id', { taskId: task.id }],
    ['context_task_id', { taskId: null, contextTaskId: task.id }],
    ['root_session_id', { rootSessionId: f.a1 }],
  ] as const) {
    assert.deepEqual(await moved(f, () => db.session.update({ where: { id: f.b1 }, data })), { [w('session', f.b)]: 1, session: 1 }, what);
  }
  assert.deepEqual(await moved(f, () => db.$executeRaw`UPDATE session SET kind = 'LANDING' WHERE id = ${f.b1}::uuid`),
    { [w('session', f.b)]: 1, session: 1 }, 'kind');
  // A LANDING row bumps nothing of its own, as before.
  assert.deepEqual(await moved(f, () => db.$executeRaw`UPDATE session SET title = 'landing' WHERE id = ${f.b1}::uuid`), {});
});

test('4. a statement over two workspaces bumps each once; one with no workspace bumps the account key', { skip }, async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await moved(f, () => f.db.session.updateMany({ where: { id: { in: [f.a1, f.a2, f.b1] } }, data: { title: 'bulk' } })),
    { [w('session', f.a)]: 1, [w('session', f.b)]: 1 },
  );
  const loose = await session(f.db, f, null);
  assert.deepEqual(await moved(f, () => f.db.session.update({ where: { id: loose }, data: { title: 'nowhere' } })), { session: 1 });
  // A root deleted: its children read it, wherever they are, and no column of theirs is written.
  const root = await session(f.db, f, f.c);
  await f.db.session.update({ where: { id: f.a1 }, data: { rootSessionId: root } });
  assert.deepEqual(await moved(f, () => f.db.session.delete({ where: { id: root } })), { [w('session', f.c)]: 1, session: 1 });
});

test('5. session_request bumps both peers\' scopes on every write; its closing too', { skip }, async (t) => {
  const f = await fixture(t);
  const [opened, id] = await requestBetween(f, f.a1, f.b1);
  assert.deepEqual(opened, { [w('session_request', f.a)]: 1, [w('session_request', f.b)]: 1 });
  assert.deepEqual(
    await moved(f, () => f.db.$executeRaw`UPDATE session_request SET state = 'REPLIED', reply_text = 'answered', closed_at = now() WHERE id = ${id}::uuid`),
    { [w('session_request', f.a)]: 1, [w('session_request', f.b)]: 1 },
  );
  // A request to a completed session elsewhere: the closed key for that peer.
  const doneInB = await session(f.db, f, f.b, { status: RunStatus.SUCCEEDED, finishedAt: new Date(), completedAt: new Date() });
  const [toDone] = await requestBetween(f, f.a1, doneInB);
  assert.deepEqual(toDone, { [w('session_request', f.a)]: 1, [c('session_request', f.b)]: 1 });
});

test('6. a watch is keyed by its observer; its clock columns still move nothing', { skip }, async (t) => {
  const f = await fixture(t);
  const watch = await f.db.watch.create({
    data: {
      ownerId: f.ownerId, observerType: 'SESSION', observerSessionId: f.a1,
      predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' }, mode: 'ONE_SHOT', action: 'RESUME_SESSION',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  assert.deepEqual(await moved(f, () => f.db.watch.update({
    where: { id: watch.id }, data: { lastEvaluatedAt: new Date(), nextEvaluateAt: new Date(Date.now() + 60_000) },
  })), {});
  assert.deepEqual(await moved(f, () => f.db.watch.update({ where: { id: watch.id }, data: { observerSessionId: f.b1 } })),
    { [w('watch', f.a)]: 1, [w('watch', f.b)]: 1 });
  assert.deepEqual(await moved(f, () => f.db.watch.update({ where: { id: watch.id }, data: { state: 'CANCELLED', nextEvaluateAt: null } })), { [w('watch', f.b)]: 1 });
});

test('7. a workspace write of the probe columns alone moves no key; a rename moves its own', { skip }, async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await moved(f, () => f.db.$executeRaw`
    UPDATE workspace SET work_dir_exists = true, work_dir_is_git = true, work_dir_probed_at = now(),
                         work_dir_free_bytes = 123456789, work_dir_total_bytes = 987654321
     WHERE runner_id = ${f.runnerId}::uuid`), {});
  assert.deepEqual(await moved(f, () => f.db.$executeRaw`UPDATE workspace SET name = name || '!' WHERE runner_id = ${f.runnerId}::uuid`),
    { [w('workspace', f.a)]: 1, [w('workspace', f.b)]: 1, [w('workspace', f.c)]: 1 });
});

/** The bump functions as they stood before 1464: 1420's two, 1428's and 0641's, read from their migrations. */
function functionsBefore1464(): string {
  const dir = path.resolve(__dirname, '../..', 'prisma/migrations');
  const body = (migration: string, name: string) => {
    const sql = readFileSync(path.join(dir, migration, 'migration.sql'), 'utf8');
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}()`);
    assert.ok(start >= 0, `${migration} has no ${name}`);
    return sql.slice(start, sql.indexOf('END $$;', start) + 'END $$;'.length);
  };
  return [
    body('1420_open_list_undrawn_writes', 'open_list_bump_session'),
    body('1420_open_list_undrawn_writes', 'open_list_bump_via_session'),
    body('1428_open_list_workspace_probes', 'open_list_bump_owner'),
    body('0641_open_list_epoch_session_waits', 'open_list_bump_watch'),
  ].join('\n');
}

test('8. rollout: the old aggregation sees every bump, and the per-base-source epochs equal the ones before 1464', { skip }, async (t) => {
  // The same writes, each in one scope, once on the functions before 1464 (installed in a transaction that is then
  // rolled back) and once on 1464's: per base source, the counters move alike.
  const script = async (f: Fixture, run: (sql: string, ...args: unknown[]) => Promise<unknown>) => {
    await run(`UPDATE session SET title = 'one' WHERE id = $1::uuid`, f.a1);
    await run(`UPDATE session SET title = 'two' WHERE id = $1::uuid`, f.b1);
    await run(`UPDATE session SET title = 'three' WHERE id = $1::uuid`, f.done);
    await run(`UPDATE session SET context_tokens = 7 WHERE id = $1::uuid`, f.a1);
    await run(`INSERT INTO conversation_turn (id, session_id, seq, client_turn_id, kind, content, status)
               VALUES (gen_random_uuid(), $1::uuid, 1, 'olsk-' || gen_random_uuid(), 'message', 'x', 'PENDING')`, f.a2);
    await run(`INSERT INTO approval (id, session_id, tool_name, input) VALUES (gen_random_uuid(), $1::uuid, 'Bash', '{}')`, f.b1);
    await run(`UPDATE workspace SET name = name || '!' WHERE id = $1::uuid`, f.c);
    await run(`UPDATE workspace SET work_dir_probed_at = now() WHERE id = $1::uuid`, f.c);
    await run(`UPDATE session SET completed_at = now() WHERE id = $1::uuid`, f.a2);
  };
  /** Each base source's total, as the version adds them up. */
  const epochs = async (db: Client, ownerId: string) => new Map((await db.query<{ src: string; total: string }>(
    `SELECT split_part(split_part(source, '#', 1), '@', 1) AS src, sum(epoch)::text AS total
       FROM open_list_epoch WHERE owner_id = $1::uuid GROUP BY 1`,
    [ownerId],
  )).rows.map(({ src, total }) => [src, BigInt(total)]));
  const delta = (from: Map<string, bigint>, to: Map<string, bigint>) => Object.fromEntries([...new Set([...from.keys(), ...to.keys()])]
    .map((src) => [src, Number((to.get(src) ?? 0n) - (from.get(src) ?? 0n))] as const)
    .filter(([, by]) => by !== 0)
    .sort(([x], [y]) => x.localeCompare(y)));
  const sumOf = async (db: Client, ownerId: string) => BigInt((await db.query<{ n: string }>(
    `SELECT COALESCE(sum(epoch), 0)::text AS n FROM open_list_epoch WHERE owner_id = $1::uuid`, [ownerId])).rows[0].n);

  const before = await fixture(t);
  const old = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await old.connect();
  t.after(() => old.end());
  await old.query('BEGIN');
  await old.query(functionsBefore1464());
  const oldStart = await epochs(old, before.ownerId);
  await script(before, (sql, ...args) => old.query(sql, args));
  const onOld = delta(oldStart, await epochs(old, before.ownerId));
  await old.query('ROLLBACK');

  const after = await fixture(t);
  const db = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await db.connect();
  t.after(() => db.end());
  const newStart = await epochs(db, after.ownerId);
  const totalBefore = await sumOf(db, after.ownerId);
  let bumps = 0;
  await script(after, async (sql, ...args) => {
    const was = await sumOf(db, after.ownerId);
    await db.query(sql, args);
    // The old aggregation reads every key apart, so what it adds up is the account's whole sum: one more per bump.
    if (await sumOf(db, after.ownerId) !== was) bumps += 1;
  });
  const onNew = delta(newStart, await epochs(db, after.ownerId));
  assert.deepEqual(onNew, onOld, 'the per-base-source epochs moved unlike they did before 1464');
  assert.deepEqual(onNew, { approval: 1, conversation_turn: 1, session: 4, workspace: 1 });
  // Every write of the script but the two undrawn ones (context_tokens, the probe column) is one bump.
  assert.equal(bumps, 7);
  assert.equal(await sumOf(db, after.ownerId) - totalBefore, 7n);
  // And the version reads one entry per base source, never a key apart.
  const { epochs: read } = await readOpenListVersionParts(after.db as unknown as PrismaService, after.ownerId);
  assert.ok(Object.keys(read).every((source) => !source.includes('@')), `the version reads a keyed source apart: ${Object.keys(read).join(', ')}`);
});
