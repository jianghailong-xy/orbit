import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CreatorType, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { Deadline } from '../deadlock/pg-barrier';
import { newFixtureIds, seedLockFixture, type FixtureIds } from '../deadlock/orbit-lock-fixture';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
/** How often the barrier re-reads the server, as in the barrier harness itself. */
const POLL_INTERVAL_MS = 2;

/**
 * `TasksService.create` and `createMany` against a PostgreSQL that really picks them as a victim.
 *
 * The unit tests prove the loop does what a thrown object asks of it. Three things they cannot
 * prove live here, and all three are properties of the server and the driver rather than of the
 * code:
 *
 *  1. **A real 40P01 is still recognisable as one by the time it leaves Prisma.** The statement
 *     that loses the cycle is the creator-Session pre-lock, a raw query, so the SQLSTATE arrives
 *     buried in a `P2010` wrapper. If the classifier ever stops reading it there, the answer
 *     silently becomes a 500 and every unit test still passes.
 *  2. **Re-running the closure actually succeeds.** A retry retakes locks, re-reads rows and
 *     re-resolves the batch's own refs; only a real transaction can say whether that lands.
 *  3. **The victim left nothing.** A rolled-back attempt is invisible by construction to the
 *     transaction that ran it — so the only place the claim can be checked is a third connection,
 *     afterwards, counting `task`, `task_dependency` and `project_event` rows.
 *
 * The conflict is scheduled, never raced. The competitor takes the Session the create is about to
 * ask for, the create is allowed to park behind it (observed in `pg_stat_activity`, not waited
 * out), and only then does the competitor ask for the owner row the create is already holding —
 * closing a two-party cycle whose victim is decided by configuration rather than by timing.
 *
 * Destructive: it seeds and contends rows, so it runs only against the disposable server
 * `scripts/deadlock-barrier.sh` provisions (see coordinator-pg-test-safety).
 */
test('a Task create that loses a deadlock re-runs whole and commits once', { skip: !URL, timeout: 180_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);

  const connect = async (): Promise<Client> => {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await client.connect();
    await verifyCoordinatorPgIdentity(client);
    return client;
  };

  const admin = await connect();
  /** The other side of the cycle, and the only writer besides the service. */
  const competitor = await connect();
  /** Read-only, so watching a blocked backend never joins what it observes. */
  const observer = await connect();
  const competitorPid = (await competitor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;

  // The production client, built exactly as the API server builds it: same driver adapter, same
  // interactive-transaction machinery, so the error shape reaching the classifier is production's.
  const prisma: PrismaClient = prismaClientFor(url);

  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await competitor.query('ROLLBACK').catch(() => undefined);
    for (const client of [admin, competitor, observer]) await client.end().catch(() => undefined);
  });

  /** A service over the real client, with the two effects that must be counted recorded. */
  function serviceUnderTest() {
    const published: string[] = [];
    const logged: string[] = [];
    const service = new TasksService(prisma as never, {} as never, {
      publishTaskChanged: (_sessionId: string, taskId: string) => void published.push(taskId),
    } as never);
    (service as unknown as { logger: unknown }).logger = {
      warn: (line: string) => void logged.push(line),
      error: () => undefined,
      log: () => undefined,
    };
    return { service, published, logged };
  }

  /** The pid of whichever backend is parked in a lock wait behind `blocker`. */
  async function awaitBlockedBy(blocker: number, deadline: Deadline, what: string): Promise<number> {
    for (;;) {
      deadline.assertLive(what);
      const { rows } = await observer.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE $1 = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`,
        [blocker],
      );
      // Both halves of one snapshot, as the barrier harness insists on: a backend joins the wait
      // queue before it publishes its wait event, so a read that only trusted pg_blocking_pids
      // could advance before the wait is real.
      if (rows[0]) return rows[0].pid;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  /**
   * Run `work` as the victim of a real two-party deadlock.
   *
   * The cycle: the create holds the owner row (rank 10) and waits for the Session (rank 30); the
   * competitor holds the Session and asks for the owner. Which side PostgreSQL aborts is decided
   * by `deadlock_timeout` and not by arrival — whichever backend runs the detector that finds the
   * cycle is the one thrown away — so the competitor's is pushed out of reach and the create is
   * always the victim, as it was in production on 2026-08-21.
   */
  async function underDeadlock<T>(ids: FixtureIds, work: () => Promise<T>): Promise<T> {
    const deadline = new Deadline(30_000);
    await competitor.query('BEGIN');
    await competitor.query("SET LOCAL deadlock_timeout = '20s'");
    await competitor.query('SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE', [
      ids.contendedSessionId,
    ]);
    const running = work();
    // Swallowed here and rethrown by the caller's await: an assertion inside this helper must not
    // race the rejection, and the competitor still has to be unwound either way.
    running.catch(() => undefined);
    try {
      await awaitBlockedBy(competitorPid, deadline, 'the create parking behind the Session lock');
      // The second edge. It is granted at the moment the victim rolls back, which is also the
      // moment the retry's next attempt starts asking for the owner row again — so the commit
      // below is what lets that attempt through.
      await competitor.query('SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE', [ids.ownerId]);
      await competitor.query('COMMIT');
    } catch (e) {
      await competitor.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
    return running;
  }

  const creatorOf = (ids: FixtureIds) => ({ type: CreatorType.AGENT, id: ids.workspaceId });

  /**
   * Unit L3: give the session doing the creating the scope it is writing under.
   *
   * `seedLockFixture` is the deadlock harness's world and coordinates nothing — it is about lock
   * order, not about projects. Since L3, an agent session that files INTO a project must hold that
   * project's scope, so a session with no binding is refused before it ever reaches the lock this
   * file is about. Bound here rather than in the shared fixture: the barrier scripts and
   * `dependency-revision.pg.spec` read that fixture too, and none of them makes this write.
   */
  async function bindCoordinator(ids: FixtureIds): Promise<void> {
    await admin.query(
      'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [ids.projectId, ids.contendedSessionId],
    );
  }

  /** Every `project_event` this project holds, and how many times each was observed. */
  async function projectEvents(ids: FixtureIds): Promise<{ rows: number; occurrences: number }> {
    const { rows } = await admin.query<{ rows: string; occurrences: string | null }>(
      `SELECT count(*)::text AS rows, sum("occurrences")::text AS occurrences
         FROM "project_event" WHERE "project_id" = $1::uuid`,
      [ids.projectId],
    );
    return { rows: Number(rows[0].rows), occurrences: Number(rows[0].occurrences ?? 0) };
  }

  await t.test('one create: one task, one edge, one publish', async () => {
    const ids = newFixtureIds('taskretry-create');
    await seedLockFixture(admin, ids);
    await bindCoordinator(ids);
    const { service, published, logged } = serviceUnderTest();

    const task = await underDeadlock(ids, () =>
      service.create(
        ids.ownerId,
        {
          title: 'taskretry-create-subject',
          projectId: ids.projectId,
          // What makes this create take the owner mutex at all — and the shape the production
          // cycle had: a create that also writes an edge.
          dependsOnTaskIds: [ids.prerequisiteTaskId],
        } as never,
        creatorOf(ids),
        ids.contendedSessionId,
      ),
    );

    // 1. The classifier read a REAL SQLSTATE out of a real Prisma 7 error, and said so once.
    assert.deepEqual(
      logged.filter((line) => line.includes('outcome=RETRYING')),
      ['operation=tasks.create outcome=RETRYING attempt=1/4 sqlstate=40P01'],
      `the create should have been the deadlock victim exactly once (saw: ${logged.join(' | ')})`,
    );
    assert.ok(
      logged.some((line) => line.startsWith('operation=tasks.create outcome=COMMITTED attempt=2/4')),
      'and the second attempt should have committed',
    );

    // 2. Exactly one task, not two — the aborted attempt's INSERT is not sitting beside it.
    const tasks = await admin.query<{ id: string }>(
      `SELECT "id" FROM "task" WHERE "title" = $1`,
      ['taskretry-create-subject'],
    );
    assert.equal(tasks.rowCount, 1, 'the retried create landed exactly one task');
    assert.equal(tasks.rows[0].id, task.id, 'and it is the one the caller was handed');

    // 3. Its edge came with it, in the same transaction.
    const edges = await admin.query(
      `SELECT 1 FROM "task_dependency" WHERE "task_id" = $1::uuid AND "depends_on_task_id" = $2::uuid`,
      [task.id, ids.prerequisiteTaskId],
    );
    assert.equal(edges.rowCount, 1, 'the prerequisite edge committed with the task');

    // 4. The effect that cannot be rolled back happened after the attempt that committed, once.
    assert.deepEqual(published, [task.id], 'exactly one realtime publish, for the surviving task');
  });

  await t.test('one batch: the whole batch, and nothing from the attempt that was thrown away', async () => {
    // The control: the same batch, uncontended, so what a clean run leaves behind is measured
    // rather than assumed. Comparing against it is what makes "no partial rows and no duplicate
    // events" checkable — a count on its own cannot tell a missing event from an extra one.
    const control = newFixtureIds('taskretry-control');
    await seedLockFixture(admin, control);
    await bindCoordinator(control);
    const clean = serviceUnderTest();
    const controlRows = await clean.service.createMany(
      control.ownerId,
      {
        tasks: [
          { title: 'taskretry-control-a', ref: 'a', projectId: control.projectId },
          { title: 'taskretry-control-b', dependsOnRefs: ['a'], projectId: control.projectId },
        ],
      } as never,
      creatorOf(control),
      control.contendedSessionId,
    );
    assert.equal(controlRows.length, 2);
    assert.deepEqual(clean.logged, [], 'the control run met no conflict at all');
    const expected = await projectEvents(control);

    const ids = newFixtureIds('taskretry-batch');
    await seedLockFixture(admin, ids);
    await bindCoordinator(ids);
    const { service, published, logged } = serviceUnderTest();

    const created = await underDeadlock(ids, () =>
      service.createMany(
        ids.ownerId,
        {
          tasks: [
            { title: 'taskretry-batch-item-a', ref: 'a', projectId: ids.projectId },
            { title: 'taskretry-batch-item-b', dependsOnRefs: ['a'], projectId: ids.projectId },
          ],
        } as never,
        creatorOf(ids),
        ids.contendedSessionId,
      ),
    );

    assert.deepEqual(
      logged.filter((line) => line.includes('outcome=RETRYING')),
      ['operation=tasks.createMany outcome=RETRYING attempt=1/4 sqlstate=40P01'],
      `the batch should have been the deadlock victim exactly once (saw: ${logged.join(' | ')})`,
    );
    assert.equal(created.length, 2);

    // All-or-nothing, in both directions: the batch is whole, and the attempt that was thrown
    // away contributed nothing to it.
    const tasks = await admin.query<{ id: string; title: string }>(
      // `item-`, because the fixture's own seed puts a `taskretry-batch-prerequisite` task in
      // this same owner. The prefix has to name the batch and only the batch for the count to
      // mean "once".
      `SELECT "id", "title" FROM "task" WHERE "title" LIKE 'taskretry-batch-item-%' ORDER BY "title"`,
    );
    assert.deepEqual(
      tasks.rows.map((row) => row.title),
      ['taskretry-batch-item-a', 'taskretry-batch-item-b'],
      'exactly the batch, once',
    );
    const edges = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "task_dependency"
        WHERE "task_id" = ANY($1::uuid[]) OR "depends_on_task_id" = ANY($1::uuid[])`,
      [tasks.rows.map((row) => row.id)],
    );
    // A ref names a row this very transaction wrote, so the edge had to be re-resolved on the
    // second attempt. One edge, pointing at the rows that actually exist.
    assert.equal(Number(edges.rows[0].n), 1, 'one within-batch edge, re-resolved and committed');
    assert.equal(tasks.rows[1].id, created[1].id);

    // The outbox: the same events a clean run produces, no more and no fewer. `occurrences` is
    // summed as well because the outbox merges on its dedupe key — an event the victim had
    // already written would come back as a second observation rather than as a second row.
    assert.deepEqual(await projectEvents(ids), expected, 'the outbox matches an uncontended run');

    // And nothing pointing at a task that does not exist: an event the victim left behind would
    // be exactly this, since its task went back with the rollback.
    const orphans = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "project_event" e
        WHERE e."source_type" = 'TASK'
          AND NOT EXISTS (SELECT 1 FROM "task" t WHERE t."id" = e."source_id")`,
    );
    assert.equal(Number(orphans.rows[0].n), 0, 'no project_event outlived the task it is about');

    assert.deepEqual(
      published,
      created.map((row) => row.id),
      'one publish per task, after the attempt that committed',
    );
  });
});
