/**
 * §13.6 supersession against a real PostgreSQL: the door a caller has, the guard underneath it,
 * and migration 0128's backfill.
 *
 * The unit spec beside this one proves the rules are right. This one proves they HOLD — and the
 * distinction matters more here than usual, because three of the four rules (tenant, project,
 * acyclicity) are enforced by a trigger and not by the service. A service check exists only in the
 * binary that has it; the whole reason those live in the database is that a hand-typed UPDATE, an
 * older apiserver and a migration all have to hit the same wall. So the wall is what is measured.
 *
 * The last section is the one this unit exists for: three cancelled fresh-review attempts, one
 * successor, and the requirement that linking them changes NO status and touches NO session. What
 * happened is the fact being preserved.
 *
 * Destructive: it truncates. It refuses to run anywhere but the disposable server the guard in
 * coordinator-pg-test-safety identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';
import { TaskStatus, uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { TasksService } from './tasks.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';

const URL = process.env.COORDINATOR_PG_URL;

interface World {
  ownerId: string;
  otherOwnerId: string;
  projectId: string;
  otherProjectId: string;
}

function tasksService(db: PrismaClient): TasksService {
  const realtime = { publishTaskChanged: () => {}, publishForUser: () => {} };
  const sessions = {
    create: () => {
      throw new Error('no fixture in this spec should start a run');
    },
    cancel: async () => {},
  };
  return new TasksService(db as unknown as PrismaService, sessions as any, realtime as any);
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  for (const [id, name] of [[ownerId, label], [otherOwnerId, `${label}-other`]] as const) {
    await db.user.create({
      data: { id, email: `${name}-${id}@pcc25c.invalid`, name, passwordHash: 'x' },
    });
  }
  for (const [id, owner, title] of [
    [projectId, ownerId, label],
    [otherProjectId, ownerId, `${label}-other-project`],
  ] as const) {
    await db.project.create({ data: { id, ownerId: owner, title } });
    await db.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
    await establishProjectContractForPgTest(db, owner, id, title);
  }
  return { ownerId, otherOwnerId, projectId, otherProjectId };
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "session_merge_receipt", "project_action",
             "project_runtime", "task", "session", "workspace", "runner", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

/** The refusal `fn` produced, or '' if it did not refuse. */
async function message(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  return '';
}

const suite = URL ? test : test.skip;

suite('task supersession, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  const db = prismaClientFor(URL);
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  // ---------------------------------------------------------------------------------------
  // The door
  // ---------------------------------------------------------------------------------------

  await t.test('a cancelled attempt names its successor, and the cancellation survives', async () => {
    await emptyWorld(client);
    const w = await world(db, 'door');
    const tasks = tasksService(db);

    const old = await tasks.create(w.ownerId, { title: '04R review', projectId: w.projectId });
    const fresh = await tasks.create(w.ownerId, { title: '04R4 review', projectId: w.projectId });
    await tasks.update(w.ownerId, old.id, { status: TaskStatus.CANCELLED });

    const linked = await tasks.update(w.ownerId, old.id, { supersededByTaskId: fresh.id });
    assert.equal(linked.supersededByTaskId, fresh.id);
    assert.equal(linked.terminalReason, 'SUPERSEDED');
    assert.ok(linked.supersededAt instanceof Date);
    // The whole point: nothing rewrote how the attempt ended.
    assert.equal(linked.status, TaskStatus.CANCELLED);

    const read = await tasks.get(w.ownerId, old.id);
    assert.equal(read.outcome, 'SUPERSEDED');
    assert.deepEqual(read.successorChain.map((row: any) => row.id), [fresh.id]);
    assert.equal(read.supersededByTaskIdAbsentReason, null);

    // ...and from the other end, the successor knows what it replaced.
    const successor = await tasks.get(w.ownerId, fresh.id);
    assert.deepEqual(successor.supersedes.map((row: any) => row.id), [old.id]);
    assert.equal(successor.outcome, 'OPEN');
  });

  await t.test('cancelling and superseding in ONE call works, and so does the reverse', async () => {
    // The natural shape of the write: a coordinator that has decided to re-run something says
    // both halves at once. Each half is refused on its own in the wrong order, so this is the
    // case that proves the ordering inside the transaction, not a convenience test.
    await emptyWorld(client);
    const w = await world(db, 'atomic');
    const tasks = tasksService(db);
    const old = await tasks.create(w.ownerId, { title: 'old', projectId: w.projectId });
    const fresh = await tasks.create(w.ownerId, { title: 'fresh', projectId: w.projectId });

    const linked = await tasks.update(w.ownerId, old.id, {
      status: TaskStatus.CANCELLED,
      supersededByTaskId: fresh.id,
    });
    assert.equal(linked.status, TaskStatus.CANCELLED);
    assert.equal(linked.supersededByTaskId, fresh.id);
    assert.equal(linked.terminalReason, 'SUPERSEDED');

    // ...and undone the same way: unlink and reopen together.
    const reopened = await tasks.update(w.ownerId, old.id, {
      status: TaskStatus.OPEN,
      supersededByTaskId: null,
    });
    assert.equal(reopened.status, TaskStatus.OPEN);
    assert.equal(reopened.supersededByTaskId, null);
    assert.equal(reopened.terminalReason, null);
    assert.equal(reopened.supersededAt, null);
  });

  await t.test('a FAILED attempt keeps FAILED — supersession is not a cleanup', async () => {
    await emptyWorld(client);
    const w = await world(db, 'failed');
    const tasks = tasksService(db);
    const old = await tasks.create(w.ownerId, { title: 'attempt', projectId: w.projectId });
    const fresh = await tasks.create(w.ownerId, { title: 'retry', projectId: w.projectId });
    // FAILED is not reachable through the DTO's status enum, which is the honest reason to write it
    // the way the runner does — directly. It is exactly the row the audit is about.
    await client.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [old.id]);

    await tasks.update(w.ownerId, old.id, { supersededByTaskId: fresh.id });
    const read = await tasks.get(w.ownerId, old.id);
    assert.equal(read.status, 'FAILED');
    assert.equal(read.terminalReason, 'SUPERSEDED');
    assert.equal(read.outcome, 'SUPERSEDED');
  });

  await t.test('ABANDONED and SUPERSEDED are different answers about the same status', async () => {
    await emptyWorld(client);
    const w = await world(db, 'abandoned');
    const tasks = tasksService(db);
    const dropped = await tasks.create(w.ownerId, { title: 'dropped', projectId: w.projectId });
    await tasks.update(w.ownerId, dropped.id, {
      status: TaskStatus.CANCELLED,
      terminalReason: 'ABANDONED',
    });
    const read = await tasks.get(w.ownerId, dropped.id);
    assert.equal(read.status, TaskStatus.CANCELLED);
    assert.equal(read.outcome, 'ABANDONED');
    assert.equal(read.supersededByTaskId, null);
    assert.equal(read.supersededByTaskIdAbsentReason, 'NOT_SUPERSEDED');
  });

  await t.test('the refusals name the rule, not a constraint', async () => {
    await emptyWorld(client);
    const w = await world(db, 'refuse');
    const tasks = tasksService(db);
    const old = await tasks.create(w.ownerId, { title: 'old', projectId: w.projectId });
    const fresh = await tasks.create(w.ownerId, { title: 'fresh', projectId: w.projectId });
    const elsewhere = await tasks.create(w.ownerId, { title: 'elsewhere', projectId: w.otherProjectId });
    const theirs = await tasks.create(w.otherOwnerId, { title: 'theirs' });

    assert.match(
      await message(() => tasks.update(w.ownerId, old.id, { supersededByTaskId: fresh.id })),
      /Only a CANCELLED or FAILED task/,
    );
    await tasks.update(w.ownerId, old.id, { status: TaskStatus.CANCELLED });
    assert.match(
      await message(() => tasks.update(w.ownerId, old.id, { supersededByTaskId: elsewhere.id })),
      /same project/,
    );
    // Another tenant's task is not found at all, which is the stronger answer: this door does not
    // confirm that it exists.
    assert.match(
      await message(() => tasks.update(w.ownerId, old.id, { supersededByTaskId: theirs.id })),
      /different owner|not found/,
    );
    assert.match(
      await message(() => tasks.update(w.ownerId, old.id, { supersededByTaskId: old.id })),
      /cannot supersede itself/,
    );
    assert.match(
      await message(() =>
        tasks.update(w.ownerId, old.id, { terminalReason: 'SUPERSEDED' as never }),
      ),
      /pass supersededByTaskId/,
    );
    // Nothing above wrote anything.
    const read = await tasks.get(w.ownerId, old.id);
    assert.equal(read.supersededByTaskId, null);
    assert.equal(read.terminalReason, null);
  });

  // ---------------------------------------------------------------------------------------
  // The guard underneath, reached the way an older binary or a hand-typed UPDATE would
  // ---------------------------------------------------------------------------------------

  await t.test('raw SQL hits the same wall the service does', async () => {
    await emptyWorld(client);
    const w = await world(db, 'raw');
    const tasks = tasksService(db);
    const old = await tasks.create(w.ownerId, { title: 'old', projectId: w.projectId });
    const fresh = await tasks.create(w.ownerId, { title: 'fresh', projectId: w.projectId });
    const elsewhere = await tasks.create(w.ownerId, { title: 'elsewhere', projectId: w.otherProjectId });
    const theirs = await tasks.create(w.otherOwnerId, { title: 'theirs' });
    await tasks.update(w.ownerId, old.id, { status: TaskStatus.CANCELLED });

    const link = (subject: string, successor: string) =>
      client.query(
        `UPDATE "task" SET "superseded_by_task_id" = $2, "superseded_at" = now(),
                           "terminal_reason" = 'SUPERSEDED' WHERE "id" = $1`,
        [subject, successor],
      );

    await assert.rejects(() => link(old.id, elsewhere.id), /TASK_SUPERSESSION_CROSS_PROJECT/);
    await assert.rejects(() => link(old.id, theirs.id), /TASK_SUPERSESSION_CROSS_TENANT/);
    await assert.rejects(() => link(fresh.id, old.id), /TASK_SUPERSESSION_NOT_TERMINAL/);
    await assert.rejects(
      () => client.query(`UPDATE "task" SET "terminal_reason" = 'DROPPED' WHERE "id" = $1`, [old.id]),
      /task_terminal_reason_check/,
    );
    // A self-link is the acyclicity walk's zero-hop case, and the BEFORE trigger reaches it before
    // any table constraint could: one rule, one message.
    await assert.rejects(() => link(old.id, old.id), /TASK_SUPERSESSION_CYCLE/);
    // A link with no reason and no instant is the shape that would let a row claim a successor
    // while reading as never superseded.
    await assert.rejects(
      () => client.query(`UPDATE "task" SET "superseded_by_task_id" = $2 WHERE "id" = $1`, [old.id, fresh.id]),
      /task_superseded_link_check/,
    );
  });

  await t.test('a supersession cycle is unwritable, at any length', async () => {
    await emptyWorld(client);
    const w = await world(db, 'cycle');
    const tasks = tasksService(db);
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const row = await tasks.create(w.ownerId, { title: `attempt ${n}`, projectId: w.projectId });
      await tasks.update(w.ownerId, row.id, { status: TaskStatus.CANCELLED });
      ids.push(row.id);
    }
    await tasks.update(w.ownerId, ids[0], { supersededByTaskId: ids[1] });
    await tasks.update(w.ownerId, ids[1], { supersededByTaskId: ids[2] });
    // Closing the loop three hops later is still closing it.
    await assert.rejects(
      () =>
        client.query(
          `UPDATE "task" SET "superseded_by_task_id" = $2, "superseded_at" = now(),
                             "terminal_reason" = 'SUPERSEDED' WHERE "id" = $1`,
          [ids[2], ids[0]],
        ),
      /TASK_SUPERSESSION_CYCLE/,
    );
    // And the chain that IS legal reads end to end.
    const read = await tasks.get(w.ownerId, ids[0]);
    assert.deepEqual(read.successorChain.map((row: any) => row.id), [ids[1], ids[2]]);
    assert.equal(read.successorChainTruncated, false);
  });

  await t.test('a superseded task cannot be quietly reopened', async () => {
    await emptyWorld(client);
    const w = await world(db, 'reopen');
    const tasks = tasksService(db);
    const old = await tasks.create(w.ownerId, { title: 'old', projectId: w.projectId });
    const fresh = await tasks.create(w.ownerId, { title: 'fresh', projectId: w.projectId });
    await tasks.update(w.ownerId, old.id, { status: TaskStatus.CANCELLED });
    await tasks.update(w.ownerId, old.id, { supersededByTaskId: fresh.id });

    await assert.rejects(
      () => client.query(`UPDATE "task" SET "status" = 'OPEN' WHERE "id" = $1`, [old.id]),
      /TASK_SUPERSESSION_NOT_TERMINAL/,
    );
    // Unlinking first is the supported way, and it leaves no terminal reason behind.
    await tasks.update(w.ownerId, old.id, { supersededByTaskId: null });
    const cleared = await tasks.update(w.ownerId, old.id, { status: TaskStatus.OPEN });
    assert.equal(cleared.terminalReason, null);
    assert.equal(cleared.supersededAt, null);
  });

  await t.test('deleting the successor leaves the record, not a lie', async () => {
    await emptyWorld(client);
    const w = await world(db, 'delete');
    const tasks = tasksService(db);
    const old = await tasks.create(w.ownerId, { title: 'old', projectId: w.projectId });
    const fresh = await tasks.create(w.ownerId, { title: 'fresh', projectId: w.projectId });
    await tasks.update(w.ownerId, old.id, { status: TaskStatus.CANCELLED });
    await tasks.update(w.ownerId, old.id, { supersededByTaskId: fresh.id });

    await client.query(`DELETE FROM "task" WHERE "id" = $1`, [fresh.id]);
    const read = await tasks.get(w.ownerId, old.id);
    assert.equal(read.supersededByTaskId, null);
    assert.equal(read.terminalReason, 'SUPERSEDED');
    // "Something replaced this and the record of what has been deleted" is not "nothing did".
    assert.equal(read.supersededByTaskIdAbsentReason, 'SUCCESSOR_DELETED');
    assert.equal(read.outcome, 'SUPERSEDED');
  });

  // ---------------------------------------------------------------------------------------
  // Base62 on the way out
  // ---------------------------------------------------------------------------------------

  await t.test('the list projection carries the link, and it is an address', async () => {
    await emptyWorld(client);
    const w = await world(db, 'base62');
    const tasks = tasksService(db);
    const old = await tasks.create(w.ownerId, { title: 'old', projectId: w.projectId });
    const fresh = await tasks.create(w.ownerId, { title: 'fresh', projectId: w.projectId });
    await tasks.update(w.ownerId, old.id, { status: TaskStatus.CANCELLED });
    await tasks.update(w.ownerId, old.id, { supersededByTaskId: fresh.id });

    const rows = await tasks.list(w.ownerId);
    const row = rows.find((r: any) => r.id === old.id) as any;
    assert.equal(row.supersededByTaskId, fresh.id);
    assert.equal(row.terminalReason, 'SUPERSEDED');
    // `supersededByTaskId` is classified, so PublicIdInterceptor twins it like every other id. The
    // interceptor is not in this test's path; what it needs is the classification, which is what
    // public-id-coverage.spec asserts. Here we only check the value IS a task id it can encode.
    assert.equal(typeof uuidToBase62(row.supersededByTaskId), 'string');
  });

  // ---------------------------------------------------------------------------------------
  // Migration 0128's backfill, replayed on the shape it was written for
  // ---------------------------------------------------------------------------------------

  await t.test('the backfill links the replaced attempts and leaves everything else alone', async () => {
    await emptyWorld(client);
    const w = await world(db, 'backfill');
    const ownerId = w.ownerId;
    const phase = randomUUID();
    const attempts = [randomUUID(), randomUUID(), randomUUID()];
    const successor = randomUUID();
    const noLabel = randomUUID();
    const lateCancel = randomUUID();
    const otherParent = randomUUID();

    const insert = async (
      id: string,
      title: string,
      status: string,
      parent: string | null,
      labels: string[],
      created: string,
      updated: string,
    ) =>
      client.query(
        `INSERT INTO "task" ("id","title","status","owner_id","creator_type","creator_id",
                             "project_id","parent_task_id","labels","created_at","updated_at","completion_criterion")
         VALUES ($1,$2,$3::task_status,$4,'USER',$4,$5,$6,$7,$8,$9,'EVIDENCE_JUDGMENT')`,
        [id, title, status, ownerId, w.projectId, parent, labels, created, updated],
      );

    await insert(phase, 'phase', 'OPEN', null, [], '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z');
    await insert(otherParent, 'other phase', 'OPEN', null, [], '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z');
    await insert(attempts[0], '04R', 'CANCELLED', phase, ['verify', 'fresh-review'], '2026-08-20T00:13:00Z', '2026-08-21T01:37:59Z');
    await insert(attempts[1], '04R2', 'CANCELLED', phase, ['fresh-review'], '2026-08-20T01:12:00Z', '2026-08-21T01:38:00Z');
    await insert(attempts[2], '04R3', 'CANCELLED', phase, ['fresh-review'], '2026-08-20T02:34:00Z', '2026-08-21T01:38:00Z');
    await insert(successor, '04R4', 'DONE', phase, ['fresh-review'], '2026-08-20T04:08:00Z', '2026-08-20T04:45:00Z');
    // Decoys, one per clause of the rule.
    await insert(noLabel, 'plain cancel', 'CANCELLED', phase, ['verify'], '2026-08-20T00:30:00Z', '2026-08-20T05:00:00Z');
    await insert(lateCancel, 'nothing after it', 'CANCELLED', phase, ['fresh-review'], '2026-08-20T06:00:00Z', '2026-08-20T07:00:00Z');
    await insert(randomUUID(), 'other parent', 'CANCELLED', otherParent, ['fresh-review'], '2026-08-20T00:13:00Z', '2026-08-20T09:00:00Z');

    // The statement migration 0128 runs, verbatim in shape.
    const applied = await client.query<{ id: string }>(`
      WITH candidate AS (
        SELECT c."id" AS cancelled_id, s."id" AS successor_id, s."created_at" AS successor_created_at
          FROM "task" c
          JOIN "task" s
            ON s."project_id"     = c."project_id"
           AND s."parent_task_id" = c."parent_task_id"
           AND s."owner_id"       = c."owner_id"
           AND s."created_at"     > c."created_at"
           AND s."status"         = 'DONE'
           AND s."labels" @> ARRAY['fresh-review']::TEXT[]
         WHERE c."status"                = 'CANCELLED'
           AND c."superseded_by_task_id" IS NULL
           AND c."terminal_reason"       IS NULL
           AND c."project_id"            IS NOT NULL
           AND c."parent_task_id"        IS NOT NULL
           AND c."labels" @> ARRAY['fresh-review']::TEXT[]
      ), pick AS (
        SELECT DISTINCT ON (cancelled_id) cancelled_id, successor_id
          FROM candidate ORDER BY cancelled_id, successor_created_at ASC, successor_id ASC
      )
      UPDATE "task" t
         SET "superseded_by_task_id" = p.successor_id,
             "superseded_at"         = t."updated_at",
             "terminal_reason"       = 'SUPERSEDED'
        FROM pick p
       WHERE t."id" = p.cancelled_id
       RETURNING t."id"`);

    assert.equal(applied.rowCount, 3, 'exactly the three replaced attempts');
    const tasks = tasksService(db);
    for (const id of attempts) {
      const read = await tasks.get(ownerId, id);
      assert.equal(read.supersededByTaskId, successor, 'points at 04R4');
      assert.equal(read.terminalReason, 'SUPERSEDED');
      assert.equal(read.status, 'CANCELLED', 'the cancellation is untouched');
      // The instant is read from the row, not from now(): the migration records history.
      assert.equal(
        (read.supersededAt as Date).toISOString(),
        (read.updatedAt as Date).toISOString(),
      );
    }
    for (const id of [noLabel, lateCancel]) {
      const read = await tasks.get(ownerId, id);
      assert.equal(read.supersededByTaskId, null);
      assert.equal(read.terminalReason, null);
      assert.equal(read.status, 'CANCELLED');
    }
    // The successor answers "what did I replace" with all three, and is itself untouched.
    const head = await tasks.get(ownerId, successor);
    assert.equal(head.status, 'DONE');
    assert.equal(head.terminalReason, null);
    assert.deepEqual(new Set(head.supersedes.map((r: any) => r.id)), new Set(attempts));

    // Running it twice links nothing more — the WHERE clause is the idempotence.
    const again = await client.query(`
      WITH candidate AS (
        SELECT c."id" AS cancelled_id, s."id" AS successor_id
          FROM "task" c
          JOIN "task" s
            ON s."project_id" = c."project_id" AND s."parent_task_id" = c."parent_task_id"
           AND s."owner_id" = c."owner_id" AND s."created_at" > c."created_at"
           AND s."status" = 'DONE' AND s."labels" @> ARRAY['fresh-review']::TEXT[]
         WHERE c."status" = 'CANCELLED' AND c."superseded_by_task_id" IS NULL
           AND c."terminal_reason" IS NULL AND c."project_id" IS NOT NULL
           AND c."parent_task_id" IS NOT NULL AND c."labels" @> ARRAY['fresh-review']::TEXT[]
      )
      UPDATE "task" t SET "terminal_reason" = 'SUPERSEDED'
        FROM candidate p WHERE t."id" = p.cancelled_id RETURNING t."id"`);
    assert.equal(again.rowCount, 0);
  });

  await t.test('the backfill writes no session — the runs that failed stay as they ran', async () => {
    await emptyWorld(client);
    const w = await world(db, 'sessions');
    const ownerId = w.ownerId;
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.runner.create({
      data: { id: runnerId, ownerId, name: 'r', tokenHash: 'x', status: RunnerStatus.ONLINE },
    });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'a', enabled: true } });
    const tasks = tasksService(db);
    const old = await tasks.create(ownerId, { title: 'old', projectId: w.projectId });
    const fresh = await tasks.create(ownerId, { title: 'fresh', projectId: w.projectId });
    // The historical run: it FAILED, and that is the fact the audit is about.
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId, taskId: old.id,
        title: 'the attempt', prompt: 'p', status: RunStatus.FAILED, endReason: 'error',
      },
    });

    await tasks.update(ownerId, old.id, { status: TaskStatus.CANCELLED });
    await tasks.update(ownerId, old.id, { supersededByTaskId: fresh.id });

    const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(session.status, RunStatus.FAILED, 'the run is still recorded as having failed');
    assert.equal(session.endReason, 'error');
    assert.equal(session.taskId, old.id, 'and it is still attached to the attempt it ran');
  });
});
