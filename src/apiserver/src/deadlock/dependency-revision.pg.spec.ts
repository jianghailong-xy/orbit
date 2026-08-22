import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Client } from 'pg';

import {
  APPLY_DISPATCH_ACTION,
  COUNT_INCOMPLETE_PREREQUISITES,
  DELETE_EDGE,
  INSERT_COORDINATOR_SESSION,
  INSERT_EDGE,
  LOCK_DEPENDENCY_REVISION,
  LOCK_OWNER_GRAPH,
  ROLLBACK_0131,
  claimDispatchAction,
  dispatchSteps,
  insertTask,
  liveSessionCount,
  newRevisionIds,
  revisionOf,
  seedRevisionFixture,
  type RevisionIds,
} from './dependency-revision-fixture';
import { Deadline, Observer } from './pg-barrier';

const URL = process.env.COORDINATOR_PG_URL;
const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
/** `__dirname` is `build/deadlock`, so sources are two levels up — the same shape lock-order.spec uses. */
const read = (rel: string): string =>
  readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
const MIGRATION_0131 = readFileSync(
  path.join(MIGRATIONS, '0131_task_dependency_revision/migration.sql'), 'utf8',
);

/** A hard budget for every wait in this file. A barrier that times out is red, never a pass. */
const BUDGET_MS = 20_000;

/**
 * Poll until PostgreSQL reports `pid` parked in a lock wait blocked by exactly `blockers`.
 *
 * The same condition the barrier harness advances on (`pg-barrier.ts`), reused here through its
 * `Observer` because these cases need the QUERY RESULTS either side of the wait — which a
 * `ScenarioSpec` deliberately does not return — rather than only the wait graph.
 */
async function awaitBlocked(
  observer: Observer, pid: number, blockers: number[], what: string,
): Promise<void> {
  const deadline = new Deadline(BUDGET_MS);
  const want = [...blockers].sort();
  for (;;) {
    deadline.assertLive(what);
    const state = await observer.blockedState(pid);
    const got = [...state.blockingPids].sort();
    if (state.waitEventType === 'Lock' && got.length === want.length
        && got.every((v, i) => v === want[i])) return;
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

async function backendPid(client: Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0].pid;
}

async function xminOf(client: Client, taskId: string): Promise<string> {
  const { rows } = await client.query<{ xmin: string }>(
    'SELECT xmin::text AS xmin FROM "task" WHERE "id" = $1::uuid', [taskId],
  );
  return rows[0].xmin;
}

async function incompletePrerequisites(client: Client, ids: RevisionIds): Promise<number> {
  const { rows } = await client.query<{ incomplete: number }>(
    COUNT_INCOMPLETE_PREREQUISITES, [ids.dependentTaskId, ids.ownerId],
  );
  return rows[0].incomplete;
}

/**
 * Migration 0131: the dependency dispatch boundary, moved off `task.updated_at`.
 *
 * 0122 gave a dispatch decision something to lock by touching the dependent Task. That worked and
 * cost three things it did not need to: a `task` row write, the `task_creator_session_id_fkey`
 * re-check that write arms, and a re-fire of every FOR EACH ROW trigger on `task`. 0131 replaces
 * it with `task_dependency_revision` — one row per Task, advanced by the edge write itself.
 *
 * What is proven here, in the order the claims depend on each other:
 *
 *  1. the schema is what the lock order says (the touch is gone; the boundary is statement-level);
 *  2. an edge write no longer writes its dependent Task at all — read from `xmin`, not argued;
 *  3. a batch advances each Task exactly once, and takes the rows in Task-uuid order;
 *  4. BOTH commit orders of dispatch-vs-dependency-change end correctly, with the wait observed;
 *  5. the commit-boundary check refuses a dispatch whose prerequisites moved — which is what makes
 *     an OLD apiserver replica, that does not know to take the revision, safe during a rollout;
 *  6. the rollback runs, and re-applying 0131 to a database that already has tasks and edges
 *     backfills every one of them.
 *
 * Destructive: it seeds, contends and (in the last case) rebuilds schema, so it runs only against
 * the disposable server `scripts/deadlock-barrier.sh` provisions (see coordinator-pg-test-safety).
 */
test('the dependency dispatch boundary is a revision, not a Task touch',
  { skip: !URL, timeout: 240_000 }, async (t) => {
  const url = URL!;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  t.after(() => admin.end());
  const observer = new Observer(admin);

  await t.test('the schema says what the lock order says it says', async () => {
    const { rows: touch } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
        WHERE r.relname = 'task_dependency' AND t.tgname = 'task_dependency_dispatch_touch'`,
    );
    // Not just "the migration drops it": a run whose earlier gate rebuilt the historical trigger
    // and died before its `finally` would otherwise measure the wrong schema all the way through.
    assert.equal(touch[0].n, '0', 'task_dependency_dispatch_touch is still installed');

    const { rows: triggers } = await admin.query<{ tgname: string; def: string }>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
        WHERE r.relname = 'task_dependency' AND NOT t.tgisinternal
        ORDER BY t.tgname`,
    );
    const revision = triggers.filter((r) => r.tgname.startsWith('task_dependency_revision_'));
    assert.deepEqual(revision.map((r) => r.tgname), [
      'task_dependency_revision_delete',
      'task_dependency_revision_insert',
      'task_dependency_revision_update',
    ]);
    for (const r of revision) {
      assert.match(r.def, /FOR EACH STATEMENT/, `${r.tgname} is not statement-level`);
      assert.match(r.def, /REFERENCING/, `${r.tgname} has no transition table`);
    }

    // The commit-boundary half is a DEFERRED constraint trigger, or it would run at insert time
    // and be exactly as blind as the read it is there to backstop.
    const { rows: deferred } = await admin.query<{ deferred: boolean; def: string }>(
      `SELECT t.tginitdeferred AS deferred, pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
        WHERE r.relname = 'session' AND t.tgname = 'session_dispatch_dependency_check'`,
    );
    assert.equal(deferred.length, 1, 'session_dispatch_dependency_check is missing');
    assert.equal(deferred[0].deferred, true, 'the commit-boundary check is not deferred');

    // Every Task is lockable — the property that replaces the touch's job of giving the EMPTY
    // edge set a row. A Task without one would silently lose the fence.
    const { rows: orphans } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "task" t
        WHERE NOT EXISTS (SELECT 1 FROM "task_dependency_revision" r WHERE r."task_id" = t."id")`,
    );
    assert.equal(orphans[0].n, '0', 'some Task has no dependency revision row');

    // The fixture replays statements; these are the sources it claims to be replaying.
    assert.match(read('src/projects/project-authorization.service.ts'),
      /FROM "task_dependency_revision" r[\s\S]{0,120}FOR SHARE/);
    // Rank 10 in the dispatch's first statement. Without it rank 70 is unreachable safely, which
    // the `a dispatch that skips the owner pre-lock deadlocks` case below demonstrates rather
    // than assumes — so this assertion is the link between that demonstration and the real code.
    assert.match(read('src/projects/project-task-dispatcher.service.ts'),
      /FOR KEY SHARE OF u FOR SHARE OF t/);
  });

  await t.test('an edge write advances the revision and does not write its Task', async () => {
    const ids = newRevisionIds('rev-no-touch');
    await seedRevisionFixture(admin, ids);
    const before = await xminOf(admin, ids.dependentTaskId);
    const { rows: stamps } = await admin.query<{ same: boolean }>(
      `SELECT ("updated_at" = "created_at") AS same FROM "task" WHERE "id" = $1::uuid`,
      [ids.dependentTaskId],
    );
    assert.equal(stamps[0].same, true, 'the fixture already moved updated_at');
    assert.equal(await revisionOf(admin, ids.dependentTaskId), 0);

    await admin.query(INSERT_EDGE, [ids.dependentTaskId, ids.doneTaskId]);
    assert.equal(await revisionOf(admin, ids.dependentTaskId), 1, 'the INSERT did not advance it');
    await admin.query(DELETE_EDGE, [ids.dependentTaskId, ids.doneTaskId]);
    assert.equal(await revisionOf(admin, ids.dependentTaskId), 2, 'the DELETE did not advance it');

    // `xmin` is the whole claim in one number: unchanged means the row was never written, so no
    // foreign key was re-checked, no FOR EACH ROW trigger on `task` re-fired, and no user-visible
    // clock moved. Under 0122 both statements above bumped it.
    assert.equal(await xminOf(admin, ids.dependentTaskId), before,
      'the dependent Task row was written by an edge change');
    const { rows: after } = await admin.query<{ same: boolean }>(
      `SELECT ("updated_at" = "created_at") AS same FROM "task" WHERE "id" = $1::uuid`,
      [ids.dependentTaskId],
    );
    assert.equal(after[0].same, true, 'updated_at moved for a change that is not a Task change');

    // Deleting a PREREQUISITE still has to advance its dependents: their prerequisite set changed
    // even though nobody wrote an edge. The cascade is the write.
    await admin.query(INSERT_EDGE, [ids.dependentTaskId, ids.openTaskId]);
    assert.equal(await revisionOf(admin, ids.dependentTaskId), 3);
    await admin.query('DELETE FROM "task" WHERE "id" = $1::uuid', [ids.openTaskId]);
    assert.equal(await revisionOf(admin, ids.dependentTaskId), 4,
      'a cascaded edge delete did not advance the dependent');
  });

  await t.test('a batch advances each Task once, in Task-uuid order', async () => {
    const ids = newRevisionIds('rev-batch');
    await seedRevisionFixture(admin, ids);
    const [low, high] = [randomUUID(), randomUUID()].sort();
    await insertTask(admin, ids, low, 'low-dependent');
    await insertTask(admin, ids, high, 'high-dependent');

    // Once per Task per statement, however many of that Task's edges the statement changed.
    await admin.query(
      `INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid), (gen_random_uuid(), $1::uuid, $3::uuid)`,
      [ids.dependentTaskId, ids.doneTaskId, ids.openTaskId],
    );
    assert.equal(await revisionOf(admin, ids.dependentTaskId), 1,
      'two edges on one Task in one statement advanced it twice');

    // And in uuid order across Tasks. A holder takes the LOW Task's row; a batch naming the HIGH
    // one first must still reach for the low one first, and therefore must not be holding the
    // high one while it waits. Unsorted, this is the pair of overlapping batches that deadlock.
    const holder = new Client({ connectionString: url });
    const batch = new Client({ connectionString: url });
    const probe = new Client({ connectionString: url });
    await Promise.all([holder.connect(), batch.connect(), probe.connect()]);
    try {
      // Read every backend pid BEFORE anything is left waiting: `pg` serialises queries per
      // client, so asking a client for its pid while it has a statement parked in a lock queues
      // the question behind the wait and never answers it.
      const [holderPid, batchPid] = await Promise.all([backendPid(holder), backendPid(batch)]);
      await holder.query('BEGIN');
      await holder.query(LOCK_DEPENDENCY_REVISION.replace('FOR SHARE', 'FOR NO KEY UPDATE'), [low]);

      await batch.query('BEGIN');
      const blocked = batch.query(
        `INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id")
         VALUES (gen_random_uuid(), $1::uuid, $3::uuid), (gen_random_uuid(), $2::uuid, $3::uuid)`,
        [high, low, ids.doneTaskId],
      );
      await awaitBlocked(observer, batchPid, [holderPid],
        'the batch never queued on the low Task');

      await probe.query("SET lock_timeout = '2s'");
      await probe.query('BEGIN');
      await probe.query(LOCK_DEPENDENCY_REVISION.replace('FOR SHARE', 'FOR NO KEY UPDATE'), [high]);
      await probe.query('ROLLBACK');

      await holder.query('ROLLBACK');
      await blocked;
      await batch.query('COMMIT');
      assert.equal(await revisionOf(admin, low), 1);
      assert.equal(await revisionOf(admin, high), 1);
    } finally {
      await Promise.all([holder, batch, probe].map((c) =>
        c.query('ROLLBACK').catch(() => undefined).then(() => c.end().catch(() => undefined))));
    }
  });

  // The two commit orders, which are the whole point. In both, a dispatch decision and a
  // dependency change overlap in time; the boundary decides which one the other sees.
  //
  // The first of them drives the edge with RAW SQL rather than through `TasksService`'s owner
  // graph mutex, deliberately. Every edge writer in the repo today takes that mutex FOR UPDATE,
  // and a dispatch holds the same row FOR KEY SHARE from its first statement — so in production
  // the two are ALSO serialized by rank 10, and a test that let that happen would prove rank 10
  // and say nothing about rank 70. Dropping the mutex isolates the boundary this migration adds:
  // it has to hold on its own, not because some other lock happens to cover the same pair.
  await t.test('dispatch first: the edge waits on the revision and lands after the Session', async () => {
    const ids = newRevisionIds('rev-dispatch-first');
    await seedRevisionFixture(admin, ids);
    await claimDispatchAction(admin, ids);
    const dispatch = new Client({ connectionString: url });
    const mutation = new Client({ connectionString: url });
    await Promise.all([dispatch.connect(), mutation.connect()]);
    try {
      const [dispatchPid, mutationPid] = await Promise.all([
        backendPid(dispatch), backendPid(mutation)]);
      await dispatch.query('BEGIN');
      for (const step of dispatchSteps(ids, { takeRevisionLock: true })) {
        await dispatch.query(step.sql, step.values as never);
      }
      assert.equal(await incompletePrerequisites(dispatch, ids), 0, 'the Task starts ready');

      // The edge arrives mid-decision. It gets as far as writing the edge row and then queues on
      // the revision this transaction is holding — which is what "the decision snapshot is
      // fenced" means: the count above cannot become untrue while it is being used.
      await mutation.query('BEGIN');
      const blocked = mutation.query(INSERT_EDGE, [ids.dependentTaskId, ids.openTaskId]);
      await awaitBlocked(observer, mutationPid, [dispatchPid],
        'the edge write never queued on the dependency revision');
      // On the revision row, and on nothing else: the edge INSERT's own foreign keys take
      // FOR KEY SHARE on two `task` rows, which the decision's FOR SHARE allows through.
      const waiting = (await observer.locks([mutationPid]))
        .filter((l) => l.locktype === 'tuple').map((l) => l.relation);
      assert.deepEqual(waiting, ['task_dependency_revision']);

      await dispatch.query(INSERT_COORDINATOR_SESSION, [
        ids.sessionId, ids.ownerId, ids.dependentTaskId, ids.workspaceId, ids.runnerId, ids.actionId,
      ]);
      await dispatch.query(APPLY_DISPATCH_ACTION, [ids.actionId, ids.sessionId]);
      // Including `session_dispatch_dependency_check`, which sees the edge set as it stands: the
      // mutation cannot have committed, because it is still queued behind this transaction.
      await dispatch.query('COMMIT');

      await blocked;
      await mutation.query('COMMIT');
      assert.equal(await liveSessionCount(admin, ids.dependentTaskId), 1, 'the dispatch did not land');
      assert.equal(await incompletePrerequisites(admin, ids), 1, 'the edge did not land after it');
      assert.equal(await revisionOf(admin, ids.dependentTaskId), 1);
    } finally {
      await Promise.all([dispatch, mutation].map((c) =>
        c.query('ROLLBACK').catch(() => undefined).then(() => c.end().catch(() => undefined))));
    }
  });

  await t.test('dependency first: the decision waits and then refuses', async () => {
    const ids = newRevisionIds('rev-dependency-first');
    await seedRevisionFixture(admin, ids);
    await claimDispatchAction(admin, ids);
    const dispatch = new Client({ connectionString: url });
    const mutation = new Client({ connectionString: url });
    await Promise.all([dispatch.connect(), mutation.connect()]);
    try {
      const [dispatchPid, mutationPid] = await Promise.all([
        backendPid(dispatch), backendPid(mutation)]);
      await mutation.query('BEGIN');
      await mutation.query(LOCK_OWNER_GRAPH, [ids.ownerId]);
      await mutation.query(INSERT_EDGE, [ids.dependentTaskId, ids.openTaskId]);

      // The real shape, mutex and all — so this is where the wait actually lands in production:
      // rank 10, on the very first statement the dispatch issues. Rank 70's own wait is the
      // previous case's subject; this one is about the ANSWER after the wait, which is the half a
      // lock order cannot give you.
      await dispatch.query('BEGIN');
      const steps = dispatchSteps(ids, { takeRevisionLock: true });
      const blocked = dispatch.query(steps[0].sql, steps[0].values as never);
      await awaitBlocked(observer, dispatchPid, [mutationPid],
        'the decision never queued behind the edge writer');

      await mutation.query('COMMIT');
      await blocked;
      for (const step of steps.slice(1)) await dispatch.query(step.sql, step.values as never);
      // READ COMMITTED gives each statement a snapshot taken after that commit, so the count the
      // decision uses is the one the edge produced — not the one it would have read had it not
      // waited. A DEFER here is the whole point: nothing is dispatched.
      assert.equal(await incompletePrerequisites(dispatch, ids), 1,
        'the decision read a prerequisite set that had already changed');
      await dispatch.query('ROLLBACK');
      assert.equal(await liveSessionCount(admin, ids.dependentTaskId), 0, 'it dispatched anyway');
      assert.equal(await revisionOf(admin, ids.dependentTaskId), 1);
    } finally {
      await Promise.all([dispatch, mutation].map((c) =>
        c.query('ROLLBACK').catch(() => undefined).then(() => c.end().catch(() => undefined))));
    }
  });

  await t.test('a dispatch that skips the owner pre-lock deadlocks against an edge write', async () => {
    // Why `FOR KEY SHARE OF u` is in the dispatcher's first statement, demonstrated by taking it
    // out. Rank 70 is the LAST lock a dispatch takes and rank 10 is taken IMPLICITLY by its
    // Session insert, several statements later — so without the pre-lock the transaction reaches
    // 70 while an edge writer sits on 10 waiting for 70, and the two close a ring. This is the
    // 40P01 the fix is measured against, not an argument about the SQL's shape.
    const ids = newRevisionIds('rev-no-prelock');
    await seedRevisionFixture(admin, ids);
    await claimDispatchAction(admin, ids);
    const dispatch = new Client({ connectionString: url });
    const mutation = new Client({ connectionString: url });
    await Promise.all([dispatch.connect(), mutation.connect()]);
    try {
      const [dispatchPid, mutationPid] = await Promise.all([
        backendPid(dispatch), backendPid(mutation)]);
      await dispatch.query('BEGIN');
      // The detector is pinned by configuration, not by who arrives first: the dispatch is the
      // only backend whose deadlock check can fire inside this run.
      await dispatch.query("SET LOCAL deadlock_timeout = '1s'");
      for (const step of dispatchSteps(ids, { takeRevisionLock: true, preLockOwner: false })) {
        await dispatch.query(step.sql, step.values as never);
      }
      await mutation.query('BEGIN');
      await mutation.query("SET LOCAL deadlock_timeout = '30min'");
      await mutation.query(LOCK_OWNER_GRAPH, [ids.ownerId]);
      const edge = mutation.query(INSERT_EDGE, [ids.dependentTaskId, ids.openTaskId])
        .then(() => null, (e: { code?: string }) => e.code ?? 'unknown');
      await awaitBlocked(observer, mutationPid, [dispatchPid], 'the edge write never queued');

      // Closing the ring: the Session insert asks for the owner row the edge writer is holding.
      const victim = await dispatch.query(INSERT_COORDINATOR_SESSION, [
        ids.sessionId, ids.ownerId, ids.dependentTaskId, ids.workspaceId, ids.runnerId, ids.actionId,
      ]).then(() => null, (e: { code?: string }) => e.code ?? 'unknown');
      assert.equal(victim, '40P01',
        'without the rank-10 pre-lock this pair is supposed to deadlock — it did not');
      await dispatch.query('ROLLBACK');
      assert.equal(await edge, null, 'the survivor did not get through');
      await mutation.query('COMMIT');
      assert.equal(await liveSessionCount(admin, ids.dependentTaskId), 0);
    } finally {
      await Promise.all([dispatch, mutation].map((c) =>
        c.query('ROLLBACK').catch(() => undefined).then(() => c.end().catch(() => undefined))));
    }
  });

  await t.test('an old replica that skips the revision is refused at COMMIT', async () => {
    const ids = newRevisionIds('rev-old-binary');
    await seedRevisionFixture(admin, ids);
    await claimDispatchAction(admin, ids);
    const dispatch = new Client({ connectionString: url });
    const mutation = new Client({ connectionString: url });
    await Promise.all([dispatch.connect(), mutation.connect()]);
    try {
      // A pre-0131 apiserver, in full: neither the revision lock nor the rank-10 owner pre-lock,
      // because both arrived with this migration. That is what makes the race below possible at
      // all — a new binary would have serialized with the edge writer on the owner row.
      await dispatch.query('BEGIN');
      for (const step of dispatchSteps(ids, { takeRevisionLock: false, preLockOwner: false })) {
        await dispatch.query(step.sql, step.values as never);
      }
      assert.equal(await incompletePrerequisites(dispatch, ids), 0);

      // Nothing stops the edge now: it commits straight through, because the only lock that would
      // have held it is the one this replica is too old to take.
      await mutation.query('BEGIN');
      await mutation.query(LOCK_OWNER_GRAPH, [ids.ownerId]);
      await mutation.query(INSERT_EDGE, [ids.dependentTaskId, ids.openTaskId]);
      await mutation.query('COMMIT');

      await dispatch.query(INSERT_COORDINATOR_SESSION, [
        ids.sessionId, ids.ownerId, ids.dependentTaskId, ids.workspaceId, ids.runnerId, ids.actionId,
      ]);
      await dispatch.query(APPLY_DISPATCH_ACTION, [ids.actionId, ids.sessionId]);
      await assert.rejects(
        () => dispatch.query('COMMIT'),
        /DISPATCH_DEPENDENCY_CHANGED/,
        'the stale dispatch was allowed to commit',
      );
      // Rolled back whole — Session, action transition and all. The reconciler retries against
      // the state that actually exists, which is the "safe retry" half of the guarantee.
      assert.equal(await liveSessionCount(admin, ids.dependentTaskId), 0);
      const { rows: action } = await admin.query<{ status: string }>(
        `SELECT "status"::text AS status FROM "project_action" WHERE "id" = $1::uuid`, [ids.actionId],
      );
      assert.equal(action[0].status, 'CLAIMED', 'the action was left APPLIED by a rolled-back dispatch');
    } finally {
      await Promise.all([dispatch, mutation].map((c) =>
        c.query('ROLLBACK').catch(() => undefined).then(() => c.end().catch(() => undefined))));
    }
  });

  await t.test('the commit-boundary check refuses nothing it should not', async () => {
    // Control 1: a Coordinator dispatch whose prerequisites are all DONE commits.
    const ready = newRevisionIds('rev-guard-ready');
    await seedRevisionFixture(admin, ready);
    await claimDispatchAction(admin, ready);
    await admin.query(INSERT_EDGE, [ready.dependentTaskId, ready.doneTaskId]);
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(INSERT_COORDINATOR_SESSION, [
        ready.sessionId, ready.ownerId, ready.dependentTaskId, ready.workspaceId,
        ready.runnerId, ready.actionId,
      ]);
      await client.query(APPLY_DISPATCH_ACTION, [ready.actionId, ready.sessionId]);
      await client.query('COMMIT');
      assert.equal(await liveSessionCount(admin, ready.dependentTaskId), 1);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
    }

    // Control 2: a person starting a task ahead of its prerequisites is not a stale dispatch.
    // `dependenciesReady` is a Coordinator admission fact, and the check is scoped to it.
    const manual = newRevisionIds('rev-guard-manual');
    await seedRevisionFixture(admin, manual);
    await admin.query(INSERT_EDGE, [manual.dependentTaskId, manual.openTaskId]);
    await admin.query(
      `INSERT INTO "session" ("id", "title", "prompt", "status", "creator_id", "owner_id",
         "task_id", "workspace_id", "dispatch_origin", "updated_at")
       VALUES ($1::uuid, 'manual', 'manual', 'PENDING', $2::uuid, $2::uuid, $3::uuid, $4::uuid,
               'USER', CURRENT_TIMESTAMP)`,
      [manual.sessionId, manual.ownerId, manual.dependentTaskId, manual.workspaceId],
    );
    assert.equal(await liveSessionCount(admin, manual.dependentTaskId), 1);
  });

  // Last, because it rebuilds schema: the rollback, and the data migration on the way back in.
  await t.test('the rollback runs, and re-applying 0131 backfills what is already there', async () => {
    const ids = newRevisionIds('rev-rollback');
    await seedRevisionFixture(admin, ids);
    await admin.query(INSERT_EDGE, [ids.dependentTaskId, ids.doneTaskId]);
    const bumped = await revisionOf(admin, ids.dependentTaskId);
    assert.equal(bumped, 1);

    try {
      await admin.query(ROLLBACK_0131);
      // Pre-0131 again, all the way down to the touch being the boundary once more.
      const { rows: back } = await admin.query<{ table: string | null; touch: string }>(
        `SELECT to_regclass('public.task_dependency_revision')::text AS table,
                count(t.tgname)::text AS touch
           FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
          WHERE r.relname = 'task_dependency' AND t.tgname = 'task_dependency_dispatch_touch'`,
      );
      assert.equal(back[0].table, null, 'the rollback left the table behind');
      assert.equal(back[0].touch, '1', 'the rollback did not restore the touch');
      // And it works: an edge write moves the Task's clock again, which is the behaviour 0131
      // removed and therefore the behaviour a rollback has to bring back.
      const before = await xminOf(admin, ids.dependentTaskId);
      await admin.query(INSERT_EDGE, [ids.dependentTaskId, ids.openTaskId]);
      assert.notEqual(await xminOf(admin, ids.dependentTaskId), before,
        'the restored touch did not write the dependent Task');
    } finally {
      await admin.query(MIGRATION_0131);
    }

    // The data migration, run against a database that already has Tasks and edges — which is the
    // only state it will ever run against in production.
    const { rows: orphans } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "task" t
        WHERE NOT EXISTS (SELECT 1 FROM "task_dependency_revision" r WHERE r."task_id" = t."id")`,
    );
    assert.equal(orphans[0].n, '0', 'the backfill missed a Task that existed before the table');
    assert.equal(await revisionOf(admin, ids.dependentTaskId), 0,
      'a re-applied 0131 should start every Task from the same value');
    // And the boundary is live again on rows that predate it.
    await admin.query(DELETE_EDGE, [ids.dependentTaskId, ids.doneTaskId]);
    assert.equal(await revisionOf(admin, ids.dependentTaskId), 1);
  });
});
