import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreatorType } from '@prisma/client';
import { TaskListsService } from './task-lists.service';

const LIST_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const OWNER = '5ccdf9b9-6871-49a6-8595-839c6a1f79d2';

interface Revision {
  listId: string;
  version: number;
  instructions: string | null;
  paused: boolean;
  maxConcurrent: number | null;
  note: string | null;
  authorType: CreatorType;
  authorId: string;
  authorSessionId: string | null;
}

/**
 * An in-memory task list plus its revision table. The transaction callback runs against the same
 * stub, so the ordering the service relies on — lock, seed v1, write, append — is exercised
 * exactly as written rather than mocked away.
 */
function makeService(initial: Partial<Revision> = {}) {
  const list = {
    id: LIST_ID,
    title: 'FineWeb CC-MAIN-2025-26',
    instructions: null as string | null,
    paused: false,
    maxConcurrent: null as number | null,
    // The pause decision, counted. It lives on the list rather than in the revision table: a
    // revision records what the policy IS, and this records how many times the pause has been
    // decided, which is what the projector converges against.
    pauseEpoch: 0,
    ...initial,
  };
  const revisions: Revision[] = [];
  const published: unknown[][] = [];
  // Every task.updateMany the policy write issues. It must stay empty: the tasks are converged by
  // the projector AFTER the decision commits, and a policy write that widens a 27,468-task list
  // into its own transaction is the 2026-09-14 outage this split exists to remove.
  const projected: Array<{ where: unknown; data: unknown }> = [];
  // What the projector was kicked for, in order. The kick is how a decision reaches the tasks.
  const kicks: string[] = [];
  const tx = {
    $queryRaw: async () => [{ id: LIST_ID, paused: list.paused, pauseEpoch: list.pauseEpoch }],
    task: {
      updateMany: async (args: { where: unknown; data: unknown }) => {
        projected.push(args);
        return { count: 0 };
      },
    },
    // A ceiling change brings the sessions already queued under the old one along with it, in this
    // same transaction. These cases are about the revision bookkeeping, so the convergence is a
    // stub; what it must do is asserted against real PostgreSQL, where the claim can be run.
    session: {
      updateMany: async () => ({ count: 0 }),
    },
    taskList: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(list, data);
        return { ...list };
      },
      findUniqueOrThrow: async () => ({
        instructions: list.instructions,
        paused: list.paused,
        maxConcurrent: list.maxConcurrent,
      }),
    },
    taskListRevision: {
      count: async () => revisions.length,
      create: async ({ data }: { data: Revision }) => {
        // The unique index the migration creates; a stub that let two writers share a version
        // could not fail on the bug the lock exists to prevent.
        if (revisions.some((r) => r.version === data.version)) {
          throw new Error(`duplicate version ${data.version}`);
        }
        revisions.push(data);
        return data;
      },
      aggregate: async () => ({
        _max: { version: revisions.reduce((m, r) => Math.max(m, r.version), 0) || null },
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    taskList: {
      ...tx.taskList,
      findFirst: async () => ({ ...list }),
    },
    taskListRevision: {
      ...tx.taskListRevision,
      findMany: async () => [...revisions].sort((a, b) => b.version - a.version),
      findUnique: async ({ where }: { where: { listId_version: { version: number } } }) =>
        revisions.find((r) => r.version === where.listId_version.version) ?? null,
    },
    task: { ...tx.task, findMany: async () => [], groupBy: async () => [] },
    // The author's session is validated against the owner before it is recorded; an id this
    // owner does not have becomes null rather than failing the write it merely annotates.
    session: {
      findMany: async () => [],
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === 'session-9' ? { id: 'session-9' } : null,
    },
    user: { findMany: async () => [] },
    workspace: { findMany: async () => [] },
  } as never;
  const service = new TaskListsService(prisma, {
    publishForUser: (...args: unknown[]) => void published.push(args),
  } as never, {} as never, {
    kick: (listId: string) => void kicks.push(listId),
  } as never);
  // get() is authorization plus a heavy detail read; these tests are about the revision
  // bookkeeping around it.
  (service as unknown as { get: unknown }).get = async () => ({ ...list });
  return { service, revisions, list, projected, published, kicks };
}

test('pausing a list decides it in O(1), and kicks the projector to converge the tasks', async () => {
  const { service, projected, published, kicks, list } = makeService();

  await service.update(OWNER, LIST_ID, { paused: true });
  // The decision: the list row gains the value and its epoch. Nothing here is proportional to how
  // many tasks the list has — that is the whole point of the split, and `projected` staying empty
  // is the assertion that pins it. A policy write that reaches into `task` is the 2026-09-14
  // outage: 5+ minutes holding the owner mutex, with the tasks of a 27,468-task list to rewrite.
  assert.equal(list.paused, true);
  assert.equal(list.pauseEpoch, 1);
  assert.deepEqual(projected, [], 'the decision write wrote task rows');
  assert.deepEqual(kicks, [LIST_ID]);

  await service.update(OWNER, LIST_ID, { paused: false });
  assert.equal(list.paused, false);
  assert.equal(list.pauseEpoch, 2);
  assert.deepEqual(projected, []);
  assert.deepEqual(kicks, [LIST_ID, LIST_ID]);
  // The tasks are now unheld, which is an unbounded runnable-row change: every client has to
  // reconcile rather than be told which rows moved.
  assert.deepEqual(
    published.filter((event) => event[1] === 'task_changed'),
    [
      [OWNER, 'task_changed', { taskIds: [], resync: true }],
      [OWNER, 'task_changed', { taskIds: [], resync: true }],
    ],
  );
});

test('pausing a list that is already paused is a no-op: no epoch, no projection, no resync', async () => {
  const { service, projected, published, kicks, list } = makeService();

  await service.update(OWNER, LIST_ID, { paused: false });

  // The stored value already equals the one asked for, so there is no decision to project and no
  // work for the projector to reclaim. Bumping the epoch here would put every same-value PATCH —
  // and every client that retries one, which is exactly what happened for 14 minutes on
  // 2026-09-14 — behind a full sweep of the list.
  assert.equal(list.pauseEpoch, 0);
  assert.deepEqual(projected, []);
  assert.deepEqual(kicks, []);
  assert.equal(published.some((event) => event[1] === 'task_changed'), false);
});

test('an edit that is not a pause leaves the tasks alone and wakes no projector', async () => {
  const { service, projected, published, kicks, list } = makeService();

  await service.update(OWNER, LIST_ID, { title: 'Renamed', maxConcurrent: 3 });

  assert.deepEqual(projected, []);
  assert.deepEqual(kicks, []);
  assert.equal(list.pauseEpoch, 0);
  assert.equal(published.some((event) => event[1] === 'task_changed'), false);
});

test('restoring a revision that was paused decides the pause again', async () => {
  // Starts paused, then resumed — so v1 (the state seeded before the first tracked edit) is the
  // paused one, and restoring it must decide the pause once more.
  const { service, projected, kicks, list } = makeService({ paused: true });
  await service.update(OWNER, LIST_ID, { paused: false });
  assert.equal(list.pauseEpoch, 1);

  // Restore goes through the same writePolicy, which is the point of it being the choke point:
  // there is no second way to set `paused` that could forget to project it.
  await service.restoreRevision(OWNER, LIST_ID, 1);

  assert.equal(list.paused, true);
  assert.equal(list.pauseEpoch, 2, 'a restore that changes `paused` is a new decision');
  assert.deepEqual(projected, []);
  // Kicked unconditionally, unlike the PATCH: a restore always includes `paused`, and it may move
  // several policy fields at once. The projector reads the epoch before it does anything, so a
  // restore that decided nothing costs one indexed read.
  assert.deepEqual(kicks, [LIST_ID, LIST_ID]);
});

test('a policy change records the resulting state as a revision', async () => {
  const { service, revisions } = makeService();

  await service.update(OWNER, LIST_ID, { maxConcurrent: 3, note: 'starving the other lists' });

  // v1 is the pre-change state, seeded because this list had no history; v2 is the change.
  assert.equal(revisions.length, 2);
  assert.deepEqual(
    revisions.map((r) => [r.version, r.maxConcurrent]),
    [
      [1, null],
      [2, 3],
    ],
  );
  assert.equal(revisions[1].note, 'starving the other lists');
});

test('a rename records nothing — history is for dispatch decisions', async () => {
  const { service, revisions } = makeService();

  await service.update(OWNER, LIST_ID, { title: 'Renamed' });

  assert.deepEqual(revisions, []);
});

test('the pre-change state is seeded only once, however many edits follow', async () => {
  const { service, revisions } = makeService();

  await service.update(OWNER, LIST_ID, { paused: true });
  await service.update(OWNER, LIST_ID, { paused: false });
  await service.update(OWNER, LIST_ID, { instructions: '按 manifest 逐个下载。' });

  assert.deepEqual(
    revisions.map((r) => r.version),
    [1, 2, 3, 4],
  );
});

test('restoring a revision puts the policy back', async () => {
  const { service, list } = makeService();
  await service.update(OWNER, LIST_ID, { instructions: 'v2 text', maxConcurrent: 6 });
  await service.update(OWNER, LIST_ID, { instructions: 'v3 text', maxConcurrent: 1, paused: true });

  await service.restoreRevision(OWNER, LIST_ID, 2);

  assert.equal(list.instructions, 'v2 text');
  assert.equal(list.maxConcurrent, 6);
  assert.equal(list.paused, false);
});

test('a restore appends to the history rather than rewinding it', async () => {
  // A history that erased what it undid could not answer the question it exists for.
  const { service, revisions } = makeService();
  await service.update(OWNER, LIST_ID, { maxConcurrent: 6 });
  await service.update(OWNER, LIST_ID, { maxConcurrent: 1 });

  await service.restoreRevision(OWNER, LIST_ID, 2);

  assert.deepEqual(
    revisions.map((r) => [r.version, r.maxConcurrent]),
    [
      [1, null],
      [2, 6],
      [3, 1],
      [4, 6],
    ],
  );
  assert.equal(revisions[3].note, 'Restored v2');
});

test('restoring a version that does not exist is a 404, not a silent no-op', async () => {
  const { service } = makeService();
  await service.update(OWNER, LIST_ID, { paused: true });

  await assert.rejects(() => service.restoreRevision(OWNER, LIST_ID, 99));
});

test('an agent author and its session are recorded, so a run can be traced back', async () => {
  const { service, revisions } = makeService();

  await service.update(
    OWNER,
    LIST_ID,
    { paused: true, note: 'disk below floor' },
    { type: CreatorType.AGENT, id: 'workspace-1', sessionId: 'session-9' },
  );

  const latest = revisions[revisions.length - 1];
  assert.equal(latest.authorType, CreatorType.AGENT);
  assert.equal(latest.authorId, 'workspace-1');
  assert.equal(latest.authorSessionId, 'session-9');
});

test('an HTTP edit is attributed to the owning user', async () => {
  const { service, revisions } = makeService();

  await service.update(OWNER, LIST_ID, { paused: true });

  const latest = revisions[revisions.length - 1];
  assert.equal(latest.authorType, CreatorType.USER);
  assert.equal(latest.authorId, OWNER);
  assert.equal(latest.authorSessionId, null);
});
