import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpException, HttpStatus } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SPAWN_TREE_OUTSTANDING } from '../common/session-scheduling';
import { SessionsService } from './sessions.service';

/** What the tree actually holds, by status — the mock answers counts from this. */
type Tree = Partial<Record<RunStatus, number>>;

function makeService(tree: Tree | number, startedThisHour = 0) {
  // A bare number is "this many sessions queued", the common case in these tests.
  const inventory: Tree = typeof tree === 'number' ? { [RunStatus.PENDING]: tree } : tree;
  const created: string[] = [];
  let counted: unknown;
  const prisma = {
    session: {
      findFirst: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        rootSessionId: 'root',
        spawnDepth: 0,
        agent: { enableOrchestration: true },
      }),
      update: async () => ({}),
      // Two different questions about the same tree: how much of it is unfinished, and how
      // fast it is being created. They are told apart by what the count filters on.
      //
      // The status filter is applied for real rather than ignored, so these tests measure
      // which statuses the service decided to charge for — the thing that was wrong.
      count: async ({
        where,
      }: {
        where: { createdAt?: unknown; status?: { in: RunStatus[] } };
      }) => {
        if (where.createdAt !== undefined) return startedThisHour;
        counted = where;
        return (where.status?.in ?? []).reduce((n, s) => n + (inventory[s] ?? 0), 0);
      },
    },
    user: { findUnique: async () => null },
    agent: { findFirst: async () => null },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);
  (service as unknown as { create: SessionsService['create'] }).create = (async (
    _ownerId: string,
    _dto: unknown,
    _opts: unknown,
  ) => {
    created.push('spawned');
    return { id: 'spawned', status: RunStatus.PENDING, title: 'spawned', agentId: null };
  }) as unknown as SessionsService['create'];
  return { service, created, counted: () => counted };
}

test('a tree at its outstanding limit refuses to grow', async () => {
  const { service, created } = makeService(SPAWN_TREE_OUTSTANDING);

  await assert.rejects(
    () => service.spawnFromSession('owner', 'root', { prompt: 'one more' }),
    (error: unknown) =>
      error instanceof HttpException &&
      error.getStatus() === HttpStatus.TOO_MANY_REQUESTS &&
      /unfinished sessions/.test(error.message),
  );
  assert.deepEqual(created, [], 'nothing is queued behind the refusal');
});

test('a tree below the limit still spawns', async () => {
  const { service, created } = makeService(SPAWN_TREE_OUTSTANDING - 1);

  await service.spawnFromSession('owner', 'root', { prompt: 'one more' });

  assert.deepEqual(created, ['spawned']);
});

/**
 * The quota has to release itself, and it only does if "outstanding" means work that still owes
 * an answer. A child parked at AWAITING_INPUT already handed back its result — that is exactly
 * when session_create(wait) returns — and it parks there indefinitely, so counting it makes the
 * quota monotonic: the same lifetime-cap trap that killed MAX_CHILDREN_PER_SESSION (de125146)
 * under a different name.
 */
test('the limit counts only sessions that still owe an answer', async () => {
  const { service, counted } = makeService(0);

  await service.spawnFromSession('owner', 'root', { prompt: 'work' });

  assert.deepEqual(counted(), {
    rootSessionId: 'root',
    status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
  });
});

// The exact shape observed in production: children parked at AWAITING_INPUT well past the
// limit, nothing queued and nothing running — a tree that had done its work and could never
// spawn again. Counting open sessions rather than unsettled ones made the quota monotonic,
// because nothing ever moves a parked session off AWAITING_INPUT on its own.
test('a tree whose children have all finished is not wedged by them', async () => {
  const { service, created } = makeService({
    [RunStatus.AWAITING_INPUT]: SPAWN_TREE_OUTSTANDING + 35,
    [RunStatus.PENDING]: 0,
    [RunStatus.RUNNING]: 0,
  });

  await service.spawnFromSession('owner', 'root', { prompt: 'the next sub-task' });

  assert.deepEqual(created, ['spawned']);
});

// The bound it still has to enforce: an orchestrator creating work faster than it settles
// accumulates exactly the statuses that are counted.
test('unsettled work still reaches the limit', async () => {
  const { service, created } = makeService({
    [RunStatus.RUNNING]: 20,
    [RunStatus.PENDING]: SPAWN_TREE_OUTSTANDING - 20,
    [RunStatus.AWAITING_INPUT]: 400,
  });

  await assert.rejects(
    () => service.spawnFromSession('owner', 'root', { prompt: 'one more' }),
    (error: unknown) => error instanceof HttpException && /unfinished sessions/.test(error.message),
  );
  assert.deepEqual(created, []);
});

/**
 * A loop in agent space — A spawns B, B messages A back with session_send, A spawns again —
 * stays one level deep forever, so no depth guard can see it, and if each child finishes
 * quickly it never trips the outstanding cap either. It just burns tokens. The rate is what
 * catches this shape.
 */
test('a tree churning through sessions is stopped even while it holds almost none', async () => {
  const { service, created } = makeService(1, 60);

  await assert.rejects(
    () => service.spawnFromSession('owner', 'root', { prompt: 'round 61' }),
    (error: unknown) =>
      error instanceof HttpException &&
      error.getStatus() === HttpStatus.TOO_MANY_REQUESTS &&
      /looping rather than making progress/.test(error.message),
  );
  assert.deepEqual(created, []);
});

test('an ordinary dispatcher stays far under the rate', async () => {
  // One child per incoming human message lives in the single digits per hour.
  const { service, created } = makeService(2, 7);

  await service.spawnFromSession('owner', 'root', { prompt: 'next message' });

  assert.deepEqual(created, ['spawned']);
});
