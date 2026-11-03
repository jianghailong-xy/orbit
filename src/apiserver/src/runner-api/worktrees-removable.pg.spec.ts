/**
 * The runner's `POST sessions/worktrees-removable` against a real, fully migrated PostgreSQL: the
 * second answer it now gives, `resumable`, and that the first, `removable`, is what it always was.
 * Held to:
 *
 *   (1) a session at rest on this runner that a message would resume is resumable, and is not removable:
 *       awaiting input, interrupted, or ended (failed, cancelled, succeeded) but not Completed;
 *   (2) a session on its way to an engine, or being ended, is neither: it is kept, and not resumable;
 *   (3) so is one ended in a way a resume refuses, and one no runner holds or another runner holds;
 *   (4) what is no longer a session's (Completed, in Trash, moved away, another account's, gone, not
 *       a session id at all) stays removable and is never resumable, and another account's row says
 *       nothing about itself in either list.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/worktrees-removable.pg.spec.ts
 *
 * Not destructive: every row belongs to an owner this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunnerStatus, RunStatus } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from './runner-api.controller';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

test('worktrees-removable: what is kept, and what of that is resumable', {
  skip: !URL, concurrency: 1, timeout: 120_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const account = async (name: string) => {
    const user = await prisma.user.create({
      data: { email: `worktrees-${name}-${RUN}@orbit.test`, passwordHash: 'x', name },
    });
    return user.id;
  };
  const ownerId = await account('owner');
  const strangerId = await account('stranger');
  const machine = async (name: string, owner: string) =>
    (
      await prisma.runner.create({
        data: {
          ownerId: owner,
          name: `${name}-${RUN}`,
          tokenHash: `${name}-${RUN}`,
          status: RunnerStatus.ONLINE,
        },
      })
    ).id;
  const runnerId = await machine('here', ownerId);
  const otherRunnerId = await machine('elsewhere', ownerId);
  const strangerRunnerId = await machine('stranger', strangerId);

  const session = async (
    title: string,
    columns: Record<string, unknown>,
    owner: string = ownerId,
    assigned: string | null = runnerId,
  ) =>
    (
      await prisma.session.create({
        data: {
          title: `${title} ${RUN}`,
          prompt: title,
          ownerId: owner,
          creatorId: owner,
          assignedRunnerId: assigned,
          startedAt: new Date(),
          numTurns: 1,
          runtimeSessionId: randomUUID(),
          branch: `orbit/${title.replace(/\W+/g, '-')}-${RUN}`,
          ...columns,
        } as never,
      })
    ).id;

  const controller = new RunnerApiController(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  );
  const ask = (ids: string[], asker: { id: string; ownerId?: string } = { id: runnerId, ownerId }) =>
    controller.worktreesRemovable(asker, { ids });
  const named = (answer: { resumable?: { id: string; branch: string }[] }) =>
    (answer.resumable ?? []).map((r) => r.id).sort();

  await t.test('(1) at rest here, a message resumes it: resumable, and kept', async () => {
    const atRest = {
      awaiting: await session('awaiting input', { status: RunStatus.AWAITING_INPUT }),
      interrupted: await session('interrupted', { status: RunStatus.INTERRUPTED }),
      failed: await session('failed', { status: RunStatus.FAILED }),
      cancelled: await session('parked', { status: RunStatus.CANCELLED, endReason: 'idle' }),
      succeeded: await session('succeeded', { status: RunStatus.SUCCEEDED }),
      // Asked by a runner the row reads as stale: the asker is plainly online.
      awaitingNoContext: await session('awaiting, no thread yet', {
        status: RunStatus.AWAITING_INPUT, runtimeSessionId: null,
      }),
    };
    const ids = Object.values(atRest);
    const answer = await ask(ids);
    assert.deepEqual(answer.removable, []);
    assert.deepEqual(named(answer), [...ids].sort());
    // Each with the branch it comes back on, which is the one thing the runner cannot read off the checkout.
    const failed = (answer.resumable ?? []).find((r) => r.id === atRest.failed);
    assert.equal(failed?.branch, `orbit/failed-${RUN}`);
  });

  await t.test('(2) on its way to an engine or being ended: kept, not resumable', async () => {
    const ids = [
      await session('queued', { status: RunStatus.PENDING }),
      await session('running', { status: RunStatus.RUNNING }),
      await session('being ended', { status: RunStatus.AWAITING_INPUT, cancelRequestedAt: new Date() }),
    ];
    const answer = await ask(ids);
    assert.deepEqual(answer.removable, []);
    assert.deepEqual(answer.resumable, []);
  });

  await t.test('(3) a resume it would refuse, or not this runner’s to answer for: kept, not resumable', async () => {
    const refused = [
      await session('never started', { status: RunStatus.FAILED, startedAt: null }),
      await session('turns but no thread', { status: RunStatus.FAILED, runtimeSessionId: null }),
    ];
    const answer = await ask(refused);
    assert.deepEqual(answer.removable, []);
    assert.deepEqual(answer.resumable, []);

    const unassigned = await session('no runner holds it', { status: RunStatus.AWAITING_INPUT }, ownerId, null);
    const unheld = await ask([unassigned]);
    assert.deepEqual(unheld.removable, [], 'kept, as it always was');
    assert.deepEqual(unheld.resumable, []);

    // A session that runs in the shared directory has no branch to come back on.
    const shared = await ask([await session('no branch', { status: RunStatus.AWAITING_INPUT, branch: null })]);
    assert.deepEqual(shared.removable, []);
    assert.deepEqual(shared.resumable, []);
  });

  await t.test('(4) no longer a session’s: removable as ever, and never resumable', async () => {
    const leftover = [
      await session('completed', { status: RunStatus.AWAITING_INPUT, completedAt: new Date() }),
      await session('archived', { status: RunStatus.FAILED, archivedAt: new Date() }),
      await session('in trash', { status: RunStatus.AWAITING_INPUT, deletedAt: new Date() }),
      await session('moved to another runner', { status: RunStatus.AWAITING_INPUT }, ownerId, otherRunnerId),
      await session('another account’s', { status: RunStatus.AWAITING_INPUT }, strangerId, strangerRunnerId),
      randomUUID(),
      'not-a-uuid',
    ];
    const answer = await ask(leftover);
    assert.deepEqual(answer.removable, leftover);
    assert.deepEqual(answer.resumable, []);
  });

  await t.test('a runner reads only its own answer about the same row', async () => {
    const id = await session('here', { status: RunStatus.AWAITING_INPUT });
    assert.deepEqual(await ask([id]), { removable: [], resumable: [{ id, branch: `orbit/here-${RUN}` }] });
    assert.deepEqual(await ask([id], { id: otherRunnerId, ownerId }), { removable: [id], resumable: [] });
  });

  await t.test('nothing asked about, nothing answered', async () => {
    assert.deepEqual(await ask([]), { removable: [], resumable: [] });
  });
});
