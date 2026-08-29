import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStatus } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { TasksService } from './tasks.service';

const OWNER = '5ccdf9b9-6871-49a6-8595-839c6a1f79d2';
const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
/** What that task is called everywhere its reader can see it, `task_get` included. */
const TASK_PUBLIC_ID = uuidToBase62(TASK_ID);
const LIST_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

interface ListEventWrite {
  listId: string;
  kind: string;
  detail: string;
}

/**
 * Drives one `update` on a task that is currently DONE and records the list event it files.
 *
 * update() is the single point every status move flows through — the user PATCH and the
 * verifier's own task_update alike — so the revert note is written there rather than by whichever
 * caller happened to move the task.
 */
function makeService(verifications = 0) {
  const events: ListEventWrite[] = [];
  const lookups: Array<{ op: string; where: unknown }> = [];
  const task = {
    id: TASK_ID,
    ownerId: OWNER,
    title: 'Download the WARCs',
    status: 'DONE',
    listId: LIST_ID,
    creatorSessionId: null,
    assignee: null,
    comments: [],
    sessions: [],
    creatorSession: null,
    dependsOn: [],
    dependedOnBy: [],
  };
  const prisma: any = {
    task: {
      findFirst: async () => ({ ...task }),
      update: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
        lookups.push({ op: 'update', where });
        return { ...task, ...data };
      },
      count: async ({ where }: { where: unknown }) => {
        lookups.push({ op: 'count', where });
        return verifications;
      },
    },
    taskListEvent: {
      upsert: async ({ create }: { create: ListEventWrite }) => {
        events.push(create);
        return create;
      },
    },
    taskDependency: { findMany: async () => [] },
    // §8.6 LO1: a PURE `{status}` PATCH is an acceptance fact, so it now runs inside a
    // transaction that takes the project, the task closure and nothing else. Before this change it
    // was a single unlocked `task.update`, which is exactly the fast path that let a status write
    // reach `project_acceptance_reopen` from an AFTER trigger with the task already held. The
    // doubles below answer "no project, nothing else in the closure", which is this fixture's world.
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  } as never;
  const service = new TasksService(prisma, {} as never, {
    publishForUser() {},
    publishTaskChanged() {},
  } as never);
  return {
    events,
    lookups,
    revert: (status: TaskStatus) => service.update(OWNER, TASK_ID, { status } as never),
  };
}

test('reverting a DONE task files a completion_reverted event on its list', async () => {
  const f = makeService();

  await f.revert(TaskStatus.IN_PROGRESS);

  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].kind, 'completion_reverted');
  assert.equal(f.events[0].listId, LIST_ID);
});

test('the id that note carries is the public one, not the uuid the column holds', async () => {
  // The detail is persisted and later replayed into agent-visible prose, which is the boundary
  // PublicIdInterceptor does not cover: it rewrites response *fields*, and a stored event detail
  // is not one. Left as a uuid, the id naming *which* completion was reverted is the one id in
  // the note the reader cannot hand back to `task_get` / `task_update`.
  const f = makeService(2);

  await f.revert(TaskStatus.IN_PROGRESS);

  const detail = f.events[0].detail;
  assert.ok(detail.includes(TASK_PUBLIC_ID), detail);
  assert.equal(detail.includes(TASK_ID), false, 'the raw uuid reached the stored event');
  // The rest of the note is unchanged — the encoding is the id's alone.
  assert.match(detail, /从 DONE 被退回 IN_PROGRESS/);
  assert.match(detail, /此前有 2 次验收记录/);
});

test('the ids the write itself uses stay uuids', async () => {
  // Only the rendering boundary is encoded. A base62 id in a `where` clause matches no row, so
  // this is the control that says the fix moved the codec to the text and not into the query.
  const f = makeService();

  await f.revert(TaskStatus.IN_PROGRESS);

  assert.deepEqual(f.lookups, [
    { op: 'update', where: { id: TASK_ID } },
    { op: 'count', where: { verifiesTaskId: TASK_ID } },
  ]);
});

test('reasserting DONE is refused and files no completion-reverted event', async () => {
  const f = makeService();

  await assert.rejects(f.revert(TaskStatus.DONE));

  assert.deepEqual(f.events, []);
});
