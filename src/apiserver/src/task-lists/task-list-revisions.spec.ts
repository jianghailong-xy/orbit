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
    ...initial,
  };
  const revisions: Revision[] = [];
  const tx = {
    $queryRaw: async () => [{ id: LIST_ID }],
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
    task: { findMany: async () => [], groupBy: async () => [] },
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
  const service = new TaskListsService(prisma, { publishForUser() {} } as never);
  // get() is authorization plus a heavy detail read; these tests are about the revision
  // bookkeeping around it.
  (service as unknown as { get: unknown }).get = async () => ({ ...list });
  return { service, revisions, list };
}

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
