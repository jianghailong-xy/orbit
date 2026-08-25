/**
 * Unit L3 on real PostgreSQL: the window between deciding a write is in scope and writing it.
 *
 * The unit tests decide the rules and the wiring. They cannot decide this, because what is under
 * test is an ORDER between two transactions and a sequential test can only ever demonstrate one of
 * them. The counterexample they miss:
 *
 *   T1  derives the scope of coordinator session S — project A, generation G — and allows the write
 *   T2  atomically rotates A's coordinator to S2 (generation G+1) and COMMITS
 *   T1  inserts into A, authorised by a fact that stopped being true while it was deciding
 *
 * A test that rotates and then calls proves nothing about it: it establishes the new world before
 * T1 ever reads, which is the one interleaving that was never in doubt. The interleaving that
 * matters is forced here — the rotation is held open on the project row while T1 does its reading
 * and parks behind the same row, and only then committed — so there are exactly two possible
 * linearizations and both are asserted:
 *
 *   - T1 first: the write lands in A, and the rotation happens afterwards to a project that has it;
 *   - T2 first: T1 refuses with `COORDINATOR_GENERATION_MOVED`, and leaves NOTHING behind.
 *
 * Give it its own database, as `verification-epoch.pg.spec` does:
 *
 *   docker run -d --name pcc-l3-pg -e POSTGRES_USER=pccl3-u -e POSTGRES_PASSWORD=pccl3 \
 *     -e POSTGRES_DB=pccl3-db -p 127.0.0.1:55823:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine
 *   DATABASE_URL=postgresql://pccl3-u:pccl3@127.0.0.1:55823/pccl3-db npx prisma migrate deploy
 *   COORDINATOR_PG_URL=… COORDINATOR_PG_EXPECTED_DATABASE=pccl3-db COORDINATOR_PG_EXPECTED_USER=pccl3-u \
 *     COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=… \
 *     node --test --test-concurrency=1 build/tasks/project-scope-fence.pg.spec.js
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { CreatorType, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const POLL_INTERVAL_MS = 2;
const DEADLINE_MS = 30_000;

interface World {
  ownerId: string;
  projectId: string;
  workspaceId: string;
  /** The session that coordinates the project — the scope every write below is made under. */
  sessionId: string;
  /** The session a rotation hands the project to. */
  successorSessionId: string;
}

test('unit L3: a rotation cannot be written past', { skip, concurrency: 1, timeout: 180_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const { prismaClientFor } = await import('../prisma/prisma-client.js');

  const connect = async (): Promise<Client> => {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await client.connect();
    await verifyCoordinatorPgIdentity(client);
    return client;
  };
  const admin = await connect();
  /** The rotation. Holds the project row open while T1 reads and then parks behind it. */
  const rotator = await connect();
  /** Read-only, so watching a blocked backend never joins what it observes. */
  const observer = await connect();
  const rotatorPid = (await rotator.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const prisma: PrismaClient = prismaClientFor(url);

  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await rotator.query('ROLLBACK').catch(() => undefined);
    for (const client of [admin, rotator, observer]) await client.end().catch(() => undefined);
  });

  function serviceUnderTest(): TasksService {
    return new TasksService(prisma as never, {} as never, {
      publishTaskChanged: () => undefined,
      publishForUser: () => undefined,
    } as never);
  }

  async function seed(label: string): Promise<World> {
    const w: World = {
      ownerId: randomUUID(),
      projectId: randomUUID(),
      workspaceId: randomUUID(),
      sessionId: randomUUID(),
      successorSessionId: randomUUID(),
    };
    const runnerId = randomUUID();
    await admin.query(
      `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
      [w.ownerId, `${label}-${w.ownerId}@l3fence.invalid`, label],
    );
    await admin.query(
      `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
       VALUES ($1,$2,$3,'ONLINE',$4,now())`,
      [runnerId, w.ownerId, `${label}-runner`, `${label}-${runnerId}`],
    );
    await admin.query(
      `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
       VALUES ($1,$2,$3,$4,true,true)`,
      [w.workspaceId, w.ownerId, `${label}-agent`, runnerId],
    );
    await admin.query(
      `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","automation_policy",
         "updated_at")
       VALUES ($1,$2,$3,true,'AUTO'::"project_automation_policy",now())`,
      [w.projectId, w.ownerId, `${label}-project`],
    );
    await admin.query(
      `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
         ON CONFLICT ("project_id") DO NOTHING`,
      [w.projectId],
    );
    for (const id of [w.sessionId, w.successorSessionId]) {
      await admin.query(
        `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
           "provider","status","dispatch_origin","updated_at")
         VALUES ($1,$2,$3,$4,'fixture',$2,'claude','RUNNING'::"run_status",
           'USER'::"session_dispatch_origin",now())`,
        [id, w.ownerId, w.workspaceId, `${label}-session`],
      );
    }
    // The binding this whole file is about, and the generation it starts from.
    await admin.query(
      'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.projectId, w.sessionId],
    );
    return w;
  }

  async function generationOf(projectId: string): Promise<string> {
    const { rows } = await admin.query<{ generation: string }>(
      `SELECT "coordinator_generation"::text AS generation FROM "project_runtime"
        WHERE "project_id" = $1::uuid`,
      [projectId],
    );
    return rows[0].generation;
  }

  async function tasksIn(projectId: string): Promise<string[]> {
    const { rows } = await admin.query<{ title: string }>(
      'SELECT "title" FROM "task" WHERE "project_id" = $1::uuid ORDER BY "title"',
      [projectId],
    );
    return rows.map((row) => row.title);
  }

  /** Wait until some backend is parked in a lock wait behind `blocker`, or give up loudly. */
  async function awaitBlockedBy(blocker: number, what: string): Promise<void> {
    const until = Date.now() + DEADLINE_MS;
    for (;;) {
      const { rows } = await observer.query(
        `SELECT pid FROM pg_stat_activity
          WHERE $1 = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`,
        [blocker],
      );
      if (rows[0]) return;
      assert.ok(Date.now() < until, `deadline exceeded waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  /**
   * Run `work` against a rotation that is already open on the project row and commits only once
   * `work` is parked behind it.
   *
   * This is the whole apparatus. The rotation's UPDATE takes the row immediately, so `work` reads a
   * world in which S is still the coordinator — and then blocks the moment it asks for the same row
   * to fence itself. Committing at that point puts T2 strictly first, which is the ordering a
   * sequential test cannot produce.
   */
  async function underRotation<T>(w: World, work: () => Promise<T>): Promise<T> {
    await rotator.query('BEGIN');
    await rotator.query(
      'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.projectId, w.successorSessionId],
    );
    const running = work();
    running.catch(() => undefined);
    try {
      await awaitBlockedBy(rotatorPid, 'the write parking behind the project row');
      await rotator.query('COMMIT');
    } catch (e) {
      await rotator.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
    return running;
  }

  async function refusalOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof ForbiddenException, `expected a refusal, got ${error}`);
      return error.getResponse() as Record<string, unknown>;
    }
    throw new assert.AssertionError({ message: 'the write was not refused' });
  }

  const agent = (w: World) => ({ type: CreatorType.AGENT, id: w.workspaceId });

  // -------------------------------------------------------------------------
  // T2 first: the de-authorised session refuses, and leaves nothing
  // -------------------------------------------------------------------------

  await t.test('a create loses to a rotation that commits inside its window', async () => {
    const w = await seed('l3-create');
    assert.equal(await generationOf(w.projectId), '0');
    const service = serviceUnderTest();

    // No `scopeToken` anywhere in this call: an old client is fenced by the server's own reading,
    // which is what makes §8 CM1 ("a missing token is not authorization") true under a race too.
    const body = await refusalOf(() => underRotation(w, () =>
      service.create(
        w.ownerId,
        { title: 'l3-create-loser', projectId: w.projectId } as never,
        agent(w),
        w.sessionId,
      )));

    assert.equal(body.code, 'COORDINATOR_GENERATION_MOVED');
    assert.equal(body.requiredAction, 'YIELD_TO_CURRENT_SCOPE');
    assert.equal(body.responsible, 'SYSTEM');
    assert.equal(await generationOf(w.projectId), '1', 'the rotation is what committed');
    assert.deepEqual(await tasksIn(w.projectId), [], 'and the loser left nothing behind');
  });

  await t.test('a batch loses whole, or not at all', async () => {
    const w = await seed('l3-batch');
    const service = serviceUnderTest();

    const body = await refusalOf(() => underRotation(w, () =>
      service.createMany(
        w.ownerId,
        {
          tasks: [
            { title: 'l3-batch-a', projectId: w.projectId },
            { title: 'l3-batch-b', projectId: w.projectId },
          ],
        } as never,
        agent(w),
        w.sessionId,
      )));

    assert.equal(body.code, 'COORDINATOR_GENERATION_MOVED');
    assert.deepEqual(await tasksIn(w.projectId), [],
      'a batch that loses the race must not leave the items it had already written');
  });

  await t.test('an update loses too, and the row it aimed at is untouched', async () => {
    const w = await seed('l3-update');
    const service = serviceUnderTest();
    const created = await service.create(
      w.ownerId, { title: 'l3-update-subject', projectId: w.projectId } as never,
      agent(w), w.sessionId,
    );

    const body = await refusalOf(() => underRotation(w, () =>
      service.update(
        w.ownerId, created.id, { title: 'renamed-by-a-stale-scope' } as never, w.sessionId,
      )));

    assert.equal(body.code, 'COORDINATOR_GENERATION_MOVED');
    assert.deepEqual(await tasksIn(w.projectId), ['l3-update-subject'],
      'the edit is not half-applied, and not applied');
  });

  // -------------------------------------------------------------------------
  // T1 first: the same two transactions, the other way round
  // -------------------------------------------------------------------------

  await t.test('a write that gets there first commits, and the rotation follows it', async () => {
    const w = await seed('l3-winner');
    const service = serviceUnderTest();

    const created = await service.create(
      w.ownerId, { title: 'l3-winner-task', projectId: w.projectId } as never,
      agent(w), w.sessionId,
    );
    // Only now does the rotation happen. Same two facts, opposite order, opposite outcome — which
    // is what makes this a linearization rather than a rule that always says no.
    await admin.query(
      'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.projectId, w.successorSessionId],
    );

    assert.equal(created.projectId, w.projectId);
    assert.deepEqual(await tasksIn(w.projectId), ['l3-winner-task']);
    assert.equal(await generationOf(w.projectId), '1');
    // ...and the rotated-away session cannot write again, now by the ordinary sequential rule.
    const after = await refusalOf(() => service.create(
      w.ownerId, { title: 'l3-after-rotation', projectId: w.projectId } as never,
      agent(w), w.sessionId,
    ));
    assert.equal(after.code, 'PROJECT_SCOPE_MISMATCH');
    assert.equal(after.rule, 'R5_NO_SCOPE');
    assert.deepEqual(await tasksIn(w.projectId), ['l3-winner-task']);
  });

  // -------------------------------------------------------------------------
  // The idempotency winner, on the concurrent path a real unique index produces
  // -------------------------------------------------------------------------
  //
  // The unit tests decide what the validator concludes. What only a real index can decide is that
  // the validator is reached at all: the read-back runs on a P2002 raised by PostgreSQL against a
  // row that committed inside this write's own window, and a fixture that hands the winner over
  // early never gets there. The window is forced the same way the rotation one is — the project row
  // this write must take at rank 40 is held open, the competing row is committed while this write
  // parks behind it, and only then is the lock released.

  /** Insert a task straight into the table under `key`, as a racing writer or a fault would. */
  async function forgeUnderKey(
    client: Client,
    w: World,
    key: string,
    over: { ownerId?: string; title?: string; creatorSessionId?: string | null } = {},
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO "task" ("id","title","status","owner_id","creator_type","creator_id",
         "project_id","creator_session_id","idempotency_key","updated_at")
       VALUES ($1::uuid,$2,'OPEN',$3::uuid,'USER',$3::uuid,$4::uuid,$5::uuid,$6,now())`,
      [
        id,
        over.title ?? 'l3-key-race',
        over.ownerId ?? w.ownerId,
        over.ownerId ? null : w.projectId,
        over.creatorSessionId === undefined ? w.sessionId : over.creatorSessionId,
        key,
      ],
    );
    return id;
  }

  /**
   * Run `work` against a row that commits under `key` while `work` is parked at rank 40.
   *
   * The rotator connection is reused for its lock, not its rotation: it takes the project row, lets
   * `work` read a world without the competing row, blocks it, commits the row, and releases. What
   * `work` then does is exactly what it does in production when it loses the index.
   */
  async function underKeyRace<T>(
    w: World,
    key: string,
    forge: (client: Client) => Promise<unknown>,
    work: () => Promise<T>,
  ): Promise<T> {
    await rotator.query('BEGIN');
    await rotator.query(
      'SELECT "id" FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE', [w.projectId],
    );
    const running = work();
    running.catch(() => undefined);
    try {
      await awaitBlockedBy(rotatorPid, 'the write parking behind the project row');
      await forge(rotator);
      await rotator.query('COMMIT');
    } catch (e) {
      await rotator.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
    return running;
  }

  /** The service's own key template, rebuilt here so the fixture can aim at a real key. */
  async function keyOf(w: World, turnId: string, title: string): Promise<string> {
    const { createHash } = await import('node:crypto');
    return createHash('sha256')
      .update(JSON.stringify(['task-create', w.sessionId, turnId, title, '']))
      .digest('hex');
  }

  /** A live turn, so the create forms a key at all. */
  async function openTurn(w: World): Promise<string> {
    const turnId = randomUUID();
    await admin.query(
      `INSERT INTO "conversation_turn" ("id","session_id","seq","client_turn_id","kind","status")
       VALUES ($1::uuid,$2::uuid,1,$3,'message','IN_FLIGHT')`,
      [turnId, w.sessionId, turnId],
    );
    return turnId;
  }

  await t.test('a create that really loses the index returns the row that won it', async () => {
    const w = await seed('l3-key-win');
    const turnId = await openTurn(w);
    const key = await keyOf(w, turnId, 'l3-key-race');
    const service = serviceUnderTest();

    const replay = await underKeyRace(
      w, key,
      (client) => forgeUnderKey(client, w, key),
      () => service.create(
        w.ownerId, { title: 'l3-key-race', projectId: w.projectId } as never,
        agent(w), w.sessionId,
      ),
    );

    assert.deepEqual(await tasksIn(w.projectId), ['l3-key-race'],
      'exactly one row exists — the winner\'s');
    assert.equal((replay as { title: string }).title, 'l3-key-race');
  });

  // The same interleaving, with the row that wins the index belonging to somebody else. Before the
  // read-back was validated this returned that row to this caller as its own task.
  await t.test('a create that loses the index to another account is refused, not answered', async () => {
    const w = await seed('l3-key-foreign');
    const stranger = await seed('l3-key-stranger');
    const turnId = await openTurn(w);
    const key = await keyOf(w, turnId, 'l3-key-foreign-race');
    const service = serviceUnderTest();

    await assert.rejects(
      () => underKeyRace(
        w, key,
        (client) => forgeUnderKey(client, w, key, { ownerId: stranger.ownerId }),
        () => service.create(
          w.ownerId, { title: 'l3-key-foreign-race', projectId: w.projectId } as never,
          agent(w), w.sessionId,
        ),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, `expected a 409, got ${error}`);
        const body = error.getResponse() as { message?: string };
        assert.match(String(body.message), /different account/);
        return true;
      },
    );

    assert.deepEqual(await tasksIn(w.projectId), [], 'and nothing of this write was left behind');
  });

  // Same account, same key, different payload — the shape a repair script or a rolled-back binary
  // leaves. The index still fires; the row still is not this write.
  await t.test('a create that loses the index to a different payload is refused', async () => {
    const w = await seed('l3-key-payload');
    const turnId = await openTurn(w);
    const key = await keyOf(w, turnId, 'l3-key-payload-race');
    const service = serviceUnderTest();

    await assert.rejects(
      () => underKeyRace(
        w, key,
        (client) => forgeUnderKey(client, w, key, { title: 'something else' }),
        () => service.create(
          w.ownerId, { title: 'l3-key-payload-race', projectId: w.projectId } as never,
          agent(w), w.sessionId,
        ),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, `expected a 409, got ${error}`);
        assert.match(
          String((error.getResponse() as { message?: string }).message),
          /different operation or payload/,
        );
        return true;
      },
    );

    assert.deepEqual(await tasksIn(w.projectId), ['something else'],
      'the forged row stands; this write added nothing');
  });

  // What a real server decides for a BATCH, and what it does not.
  //
  // The legitimate half is a genuine index loss: the row commits while this batch is parked at rank
  // 40, its own INSERT loses, and the reconstruction answers with the winner. The foreign half is
  // refused — but by the validator inside the transaction rather than the one in the catch, because
  // under READ COMMITTED the batch's find-or-create sees the row the instant it commits and there
  // is no lock between that read and the INSERT to hold it open any longer. That is not a gap: both
  // reads call the SAME validator, which is the property being claimed. The catch-path
  // reconstruction is driven directly, with the interleaving forced exactly, in
  // `task-idempotency-winner.spec.ts` — and confirmed there by mutation.
  await t.test('a batch that loses the index answers with its winner, or refuses it', async () => {
    const w = await seed('l3-key-batch');
    const turnId = await openTurn(w);
    const key = await keyOf(w, turnId, 'l3-batch-race');
    const service = serviceUnderTest();

    const rows = await underKeyRace(
      w, key,
      (client) => forgeUnderKey(client, w, key, { title: 'l3-batch-race' }),
      () => service.createMany(
        w.ownerId, { tasks: [{ title: 'l3-batch-race', projectId: w.projectId }] } as never,
        agent(w), w.sessionId,
      ),
    );

    assert.deepEqual(rows.map((row) => row.title), ['l3-batch-race']);
    assert.deepEqual(await tasksIn(w.projectId), ['l3-batch-race'], 'one row, not two');

    // ...and the foreign version of the same race, on the batch's own path.
    const other = await seed('l3-key-batch-foreign');
    const otherTurn = await openTurn(other);
    const otherKey = await keyOf(other, otherTurn, 'l3-batch-foreign');
    const stranger = await seed('l3-key-batch-stranger');
    await assert.rejects(
      () => underKeyRace(
        other, otherKey,
        (client) => forgeUnderKey(client, other, otherKey, { ownerId: stranger.ownerId }),
        () => service.createMany(
          other.ownerId,
          { tasks: [{ title: 'l3-batch-foreign', projectId: other.projectId }] } as never,
          agent(other), other.sessionId,
        ),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, `expected a 409, got ${error}`);
        assert.match(
          String((error.getResponse() as { message?: string }).message),
          /different account/,
        );
        return true;
      },
    );
    assert.deepEqual(await tasksIn(other.projectId), []);
  });

  // The successor is not blocked by any of this: what the fence refuses is a scope that has moved,
  // not the project. A rule that also stopped the new holder would have replaced one silent stall
  // with a loud one.
  await t.test('the successor scope writes normally the moment it holds the project', async () => {
    const w = await seed('l3-successor');
    const service = serviceUnderTest();
    await admin.query(
      'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.projectId, w.successorSessionId],
    );

    const created = await service.create(
      w.ownerId, { title: 'l3-successor-task' } as never, agent(w), w.successorSessionId,
    );

    assert.equal(created.projectId, w.projectId, 'and the project was derived, not asked for');
    assert.deepEqual(await tasksIn(w.projectId), ['l3-successor-task']);
  });
});
