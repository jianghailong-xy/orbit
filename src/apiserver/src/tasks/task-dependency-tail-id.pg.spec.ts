/**
 * `task_dependency_tail_id` on real PostgreSQL: the chain it resolves, and the three it refuses.
 *
 * 0285 rewrote the function's body to read the head row once instead of twice. The rewrite is a
 * pure speedup — on this deployment's largest project it halves the buffer traffic of every
 * project-scoped read, because every one of them calls this once per EDGE — but the line it moved
 * is the line that decides who the chain belongs to. Before, `root_owner` came from a SELECT of
 * its own; now it is adopted from the loop's first read. Adopt it on the wrong iteration and the
 * owner test becomes vacuous at every depth instead of only at depth 0, and a supersession chain
 * that walks out of its owner starts RESOLVING — which is one account's DONE task satisfying
 * another account's dependency, silently, in the dispatch gate.
 *
 * So the cases below are not a tour of the function. They are the four answers that would change
 * if the rewrite were subtly wrong, plus the two that say the fast path is still a chain walk:
 *
 *  - a plain prerequisite resolves to ITSELF (the 99.96% path, one iteration, one row read);
 *  - a superseded chain resolves to its TAIL, at depth 1 and again at depth 2;
 *  - a chain that crosses owners resolves to NOTHING — the assertion the moved line owns;
 *  - a chain whose successor pointer was cleared, leaving SUPERSEDED behind, resolves to nothing;
 *  - the branch that stops the walk is unreachable, and the two CHECKs that make it so are there;
 *  - an id belonging to no task resolves to nothing, which is the first read's other job.
 *
 * Give it its own database — it runs against the real migrated schema, because the function IS a
 * migration and a hand-built subset would only ever agree with itself:
 *
 *   scripts/run-pg-spec.sh src/apiserver/src/tasks/task-dependency-tail-id.pg.spec.ts
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

type Db = PrismaClient;

/** A fresh namespace per RUN, so a second run against the same database is as green as the first. */
const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();

async function seedOwner(db: Db, id: string): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "user" ("id","email","name","password_hash")
     VALUES ($1,$2,'tail','x') ON CONFLICT ("id") DO NOTHING`,
    id, `tail-${id}@example.test`,
  );
}

async function task(db: Db, over: {
  owner?: string; status?: string; supersededBy?: string | null; terminalReason?: string | null;
} = {}): Promise<string> {
  const id = randomUUID();
  const owner = over.owner ?? OWNER;
  await db.$executeRawUnsafe(
    `INSERT INTO "task" ("id","title","status","owner_id","creator_type","creator_id","updated_at",
       "completion_criterion")
     VALUES ($1,$2,$3::"task_status",$4,'USER',$4,now(),'EVIDENCE_JUDGMENT')`,
    id, `tail-${id.slice(0, 8)}`, over.status ?? 'OPEN', owner,
  );
  if (over.supersededBy !== undefined || over.terminalReason !== undefined) {
    // Written second: the row has to be terminal before it may name a successor.
    await db.$executeRawUnsafe(
      `UPDATE "task" SET "superseded_by_task_id" = $2::uuid, "terminal_reason" = $3::text,
              "superseded_at" = CASE WHEN $2::uuid IS NULL AND $3::text IS NULL
                                     THEN NULL ELSE now() END
        WHERE "id" = $1::uuid`,
      id, over.supersededBy ?? null, over.terminalReason ?? null,
    );
  }
  return id;
}

/**
 * Point a task at a successor WITHOUT `task_supersession_guard`, which is the point.
 *
 * SU2 and SU4 stop an API caller writing a cross-tenant or non-terminal supersession, so the two
 * rows below cannot be made the ordinary way. The function's own fences are not a second copy of
 * that trigger: they are what decides the answer for a row that is already in the table — one
 * restored from a dump, imported by a recovery (this deployment has 109,968 such task rows), or
 * written before 0128 added the guard. A resolver that trusted the trigger would answer those rows
 * by releasing one account's work into another's dependency.
 */
async function linkPastTheGuard(
  db: Db, id: string, successor: string | null, status: string, reason: string | null,
): Promise<void> {
  await db.$executeRawUnsafe(`ALTER TABLE "task" DISABLE TRIGGER "task_supersession_guard_update"`);
  try {
    await db.$executeRawUnsafe(
      `UPDATE "task" SET "superseded_by_task_id" = $2::uuid, "status" = $3::"task_status",
              "terminal_reason" = $4::text, "superseded_at" = now()
        WHERE "id" = $1::uuid`,
      id, successor, status, reason,
    );
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "task" ENABLE TRIGGER "task_supersession_guard_update"`);
  }
}

async function tailOf(db: Db, id: string): Promise<string | null> {
  const [row] = await db.$queryRawUnsafe<Array<{ tail: string | null }>>(
    `SELECT task_dependency_tail_id($1::uuid) AS "tail"`, id,
  );
  return row.tail;
}

test('task_dependency_tail_id on real PostgreSQL', { skip, concurrency: 1 }, async (t) => {
  const { prismaClientFor } = await import('../prisma/prisma-client.js');
  assertCoordinatorPgUrlIsIsolated(URL!);
  const probe = new Client({ connectionString: URL! });
  await probe.connect();
  await verifyCoordinatorPgIdentity(probe);
  await probe.end();
  const db = prismaClientFor(URL!);
  t.after(async () => { await db.$disconnect(); });
  await seedOwner(db, OWNER);
  await seedOwner(db, OTHER_OWNER);

  await t.test('a prerequisite nothing superseded resolves to itself', async () => {
    const plain = await task(db);
    assert.equal(await tailOf(db, plain), plain);
    const done = await task(db, { status: 'DONE' });
    assert.equal(await tailOf(db, done), done);
  });

  await t.test('a superseded chain resolves to its tail, at one hop and at two', async () => {
    const tail = await task(db);
    const middle = await task(db, {
      status: 'CANCELLED', supersededBy: tail, terminalReason: 'SUPERSEDED',
    });
    const head = await task(db, {
      status: 'FAILED', supersededBy: middle, terminalReason: 'SUPERSEDED',
    });
    assert.equal(await tailOf(db, middle), tail, 'one hop');
    assert.equal(await tailOf(db, head), tail, 'two hops');
    assert.equal(await tailOf(db, tail), tail, 'the tail is its own tail');
  });

  await t.test('a chain that walks out of its owner resolves to nothing', async () => {
    // The assertion the rewrite owns. `root_owner` is taken from the HEAD and compared at every
    // later step; a body that re-adopted it per step would answer `foreign` here, which is one
    // account's task released as another account's satisfied prerequisite.
    const foreign = await task(db, { owner: OTHER_OWNER });
    const head = await task(db);
    await linkPastTheGuard(db, head, foreign, 'FAILED', 'SUPERSEDED');
    assert.equal(await tailOf(db, head), null);
    // And the foreign row still resolves for ITS owner, so the refusal is about the crossing and
    // not about the row being unreachable.
    assert.equal(await tailOf(db, foreign), foreign);
  });

  await t.test('SUPERSEDED with the successor pointer cleared resolves to nothing', async () => {
    // ON DELETE SET NULL preserves SUPERSEDED as honest history; it does not leave a tail whose
    // status can satisfy new work.
    const orphaned = await task(db, {
      status: 'CANCELLED', supersededBy: null, terminalReason: 'SUPERSEDED',
    });
    assert.equal(await tailOf(db, orphaned), null);
  });

  await t.test('the branch that stops the walk has no row that can reach it', async () => {
    // The walk follows a link only when it is BOTH terminal and SUPERSEDED, and refuses otherwise.
    // That refusal has no test because it has no ROW: two CHECK constraints make a task with a
    // successor pointer and any other status or reason unrepresentable, so the branch is pure
    // defence in depth. Asserting the constraints is what keeps that true — the day either is
    // dropped, the branch becomes reachable and needs the cases this test is standing in for.
    const rows = await db.$queryRawUnsafe<Array<{ name: string; definition: string }>>(
      `SELECT conname AS "name", pg_get_constraintdef(oid) AS "definition"
         FROM pg_constraint
        WHERE conrelid = 'task'::regclass
          AND conname IN ('task_retirement_status_check', 'task_superseded_link_check')
        ORDER BY conname`,
    );
    assert.deepEqual(rows.map((row) => row.name),
      ['task_retirement_status_check', 'task_superseded_link_check'],
      'a CHECK the walk relies on is gone; its branch is now reachable and untested');
    const byName = new Map(rows.map((row) => [row.name, row.definition]));
    // Status: only CANCELLED or FAILED may carry a successor pointer.
    assert.match(byName.get('task_retirement_status_check')!, /'CANCELLED'.*'FAILED'/su);
    // Reason: and only SUPERSEDED.
    assert.match(byName.get('task_superseded_link_check')!, /'SUPERSEDED'/u);
  });

  await t.test('an id belonging to no task resolves to nothing', async () => {
    assert.equal(await tailOf(db, randomUUID()), null);
  });

  await t.test('the function is labelled for parallel workers', async () => {
    // Half of 0285's speedup is this label: PARALLEL UNSAFE is what forbade a parallel plan for
    // every query that calls the function, however parallelisable the rest of that query was.
    const [row] = await db.$queryRawUnsafe<Array<{ parallel: string; volatile: string }>>(
      `SELECT proparallel::text AS "parallel", provolatile::text AS "volatile"
         FROM pg_proc WHERE proname = 'task_dependency_tail_id'`,
    );
    assert.equal(row.parallel, 's', 'task_dependency_tail_id is not PARALLEL SAFE');
    assert.equal(row.volatile, 's', 'task_dependency_tail_id is not STABLE');
  });

  await t.test('the head row is read once, not twice', async () => {
    // The other half of 0285, and the one a body could silently lose: the old definition read the
    // row at p_task_id for its owner and then read the SAME row again as the loop's first
    // iteration. Read off the INSTALLED definition rather than the migration file, so a later
    // CREATE OR REPLACE that puts the second read back fails here instead of quietly costing every
    // project-scoped read double — this deployment's largest project calls this 110,866 times in
    // one statement.
    const [row] = await db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT prosrc AS "body" FROM pg_proc WHERE proname = 'task_dependency_tail_id'`,
    );
    const reads = [...row.body.matchAll(/FROM\s+"?task"?\s+t\b/g)].length;
    assert.equal(reads, 1,
      `the installed task_dependency_tail_id reads "task" ${reads} times per call, not once`);
  });
});
