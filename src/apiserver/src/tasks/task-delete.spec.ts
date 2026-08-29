import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_OWNER_ID = '00000000-0000-7000-8000-000000000002';
const TASK_A = '550e8400-e29b-41d4-a716-446655440000';
const TASK_B = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_TASK = '550e8400-e29b-41d4-a716-446655440002';

/**
 * A delete now runs inside a transaction and scans for the task's live runs first, so every
 * stub needs those two even when the test is about something else. Defaults say "no runs":
 * a test that cares supplies its own `session.findMany`.
 */
let lastTxOptions: any;

function serviceWith(
  prisma: any,
  realtime: unknown = { publishForUser: () => undefined },
  sessions: unknown = { cancel: async () => true },
): TasksService {
  const tx = {
    $queryRaw: async () => [],
    session: { findMany: async () => [] },
    taskDependency: { findMany: async () => [] },
    ...prisma,
  };
  const $transaction = async (fn: (t: unknown) => unknown, options: unknown) => {
    lastTxOptions = options;
    return fn(tx);
  };
  return new TasksService({ ...tx, $transaction } as never, sessions as never, realtime as never);
}

test('batch delete is exposed as POST tasks/batch-delete and forwards the authenticated owner', async () => {
  const seen: { ownerId?: string; taskIds?: string[] } = {};
  const expected = { deleted: 2 };
  const tasks = {
    batchDelete: async (ownerId: string, taskIds: string[]) => {
      seen.ownerId = ownerId;
      seen.taskIds = taskIds;
      return expected;
    },
  } as never;
  const controller = new TasksController(tasks, {} as never);

  const result = await controller.batchDelete(
    { userId: OWNER_ID, email: 'owner@example.com' },
    { taskIds: [TASK_A, TASK_B] },
  );

  assert.deepEqual(seen, { ownerId: OWNER_ID, taskIds: [TASK_A, TASK_B] });
  assert.equal(result, expected);
  const handler = TasksController.prototype.batchDelete;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'batch-delete');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
});

test('batch delete deduplicates ids and deletes only rows owned by the caller', async () => {
  const rows = new Map([
    [TASK_A, OWNER_ID],
    [TASK_B, OWNER_ID],
    [OTHER_TASK, OTHER_OWNER_ID],
  ]);
  let deleteWhere: any;
  const published: unknown[][] = [];
  const service = serviceWith(
    {
      task: {
        deleteMany: async ({ where }: any) => {
          deleteWhere = where;
          let count = 0;
          for (const id of where.id.in) {
            if (rows.get(id) === where.ownerId) {
              rows.delete(id);
              count += 1;
            }
          }
          return { count };
        },
      },
    },
    { publishForUser: (...args: unknown[]) => published.push(args) },
  );

  const result = await service.batchDelete(OWNER_ID, [TASK_A, TASK_A, OTHER_TASK, TASK_B]);

  assert.deepEqual(deleteWhere, {
    ownerId: OWNER_ID,
    id: { in: [TASK_A, OTHER_TASK, TASK_B] },
  });
  assert.deepEqual(result, { deleted: 2 });
  assert.equal(rows.has(TASK_A), false);
  assert.equal(rows.has(TASK_B), false);
  assert.equal(rows.get(OTHER_TASK), OTHER_OWNER_ID);
  assert.deepEqual(published, [[OWNER_ID, 'task_changed', { taskIds: [], resync: true }]]);
});

test('empty batch delete is a no-op', async () => {
  let writes = 0;
  const service = serviceWith({
    task: {
      deleteMany: async () => {
        writes += 1;
        return { count: 0 };
      },
    },
  });

  assert.deepEqual(await service.batchDelete(OWNER_ID, []), { deleted: 0 });
  assert.equal(writes, 0);
});

test('single delete rejects malformed and non-owned ids before deleting', async () => {
  let lookups = 0;
  let deletes = 0;
  let lookupWhere: any;
  const service = serviceWith({
    task: {
      findFirst: async ({ where }: any) => {
        lookups += 1;
        lookupWhere = where;
        return null;
      },
      deleteMany: async () => {
        deletes += 1;
        return { count: 0 };
      },
    },
  });

  await assert.rejects(service.remove(OWNER_ID, 'not-a-uuid'), /task not found/);
  assert.equal(lookups, 0);

  await assert.rejects(service.remove(OWNER_ID, OTHER_TASK), /task not found/);
  assert.deepEqual(lookupWhere, { id: OTHER_TASK, ownerId: OWNER_ID });
  assert.equal(deletes, 0);
});

const ownedTask = () => ({
  id: TASK_A,
  ownerId: OWNER_ID,
  status: 'CANCELLED',
  creatorSessionId: null,
  comments: [],
  dependsOn: [],
});

test('single delete hard-deletes an owned task', async () => {
  let deleteWhere: any;
  const published: unknown[][] = [];
  const service = serviceWith(
    {
      task: {
        findFirst: async () => ownedTask(),
        deleteMany: async ({ where }: any) => {
          deleteWhere = where;
          return { count: 1 };
        },
      },
    },
    { publishForUser: (...args: unknown[]) => published.push(args) },
  );

  assert.deepEqual(await service.remove(OWNER_ID, TASK_A), { ok: true });
  assert.deepEqual(deleteWhere, { ownerId: OWNER_ID, id: { in: [TASK_A] } });
  assert.deepEqual(published, [[OWNER_ID, 'task_changed', { taskIds: [], resync: true }]]);
});

// A run reaches its terminal state by finishing its task. Delete the task under a live run and
// that route is gone: the run parks at AWAITING_INPUT and stays there, detached by the SET NULL
// foreign key and indistinguishable from an ordinary chat, so nothing later can settle it. These
// cover the one moment that still can.

const RUN_A = '550e8400-e29b-41d4-a716-4466554400a0';
const RUN_B = '550e8400-e29b-41d4-a716-4466554400a1';

/** Records the order of the delete's steps, so "scan, then delete" can be asserted. */
function deleteRecorder(runs: string[], deleted = 1) {
  const calls: string[] = [];
  const cancelled: Array<[string, string, string]> = [];
  const prisma = {
    task: {
      findFirst: async () => ownedTask(),
      deleteMany: async () => {
        calls.push('delete');
        return { count: deleted };
      },
    },
    // Two calling conventions reach here and both are production shapes: a tagged template
    // (`tx.$queryRaw\`...\``) and a prepared `Prisma.sql`. The cascade walk uses the second, and
    // reading it as a template array throws inside the client — which reads as a failure of the
    // code under test rather than of the stub.
    $queryRaw: async (strings: TemplateStringsArray | Prisma.Sql, ...bound: unknown[]) => {
      const query = 'raw' in strings
        ? Prisma.sql(strings as TemplateStringsArray, ...(bound as never[]))
        : (strings as Prisma.Sql);
      const sql = query.text.replace(/\s+/g, ' ').trim();
      // Labelled by what it DOES, and the lock clause decides first: the rank-30 session pre-lock
      // walks the same cascade to find its rows, so testing for the walk first would relabel an
      // acquisition as a read and hide it from the order assertion.
      if (/FOR (?:NO KEY )?UPDATE|FOR (?:KEY )?SHARE/.test(sql)) {
        calls.push('lock');
        calls.push(sql);
        return [];
      }
      if (/WITH RECURSIVE cascaded/.test(sql)) {
        calls.push('cascade');
        // Echo the seeds back rather than a fixed row: the bound values live on `.values`, and a
        // double that answered with one id would make a batch delete look like it only ever
        // reached its first task.
        const seeds = (query.values as unknown[]).find(Array.isArray) as string[] | undefined;
        return (seeds ?? []).map((id) => ({ id }));
      }
      calls.push('lock');
      calls.push(sql);
      return [];
    },

    session: {
      findMany: async ({ where }: any) => {
        calls.push('scan');
        calls.push(JSON.stringify(where));
        return runs.map((id) => ({ id }));
      },
    },
  };
  const sessions = {
    cancel: async (ownerId: string, id: string, reason: string) => {
      calls.push('cancel');
      cancelled.push([ownerId, id, reason]);
      return true;
    },
  };
  return { service: serviceWith(prisma, undefined, sessions), calls, cancelled };
}

test('deleting a task ends the runs that were still working it', async () => {
  const { service, cancelled } = deleteRecorder([RUN_A, RUN_B]);

  await service.remove(OWNER_ID, TASK_A);

  // task_cancelled, not cancelled: it is a graceful reason, so a runner that never honors the
  // end is force-finalized to CANCELLED rather than recorded as a run failure. Nothing failed.
  assert.deepEqual(cancelled, [
    [OWNER_ID, RUN_A, 'task_cancelled'],
    [OWNER_ID, RUN_B, 'task_cancelled'],
  ]);
});

test('only runs that could still be working the task are ended', async () => {
  const { service, calls } = deleteRecorder([]);

  await service.remove(OWNER_ID, TASK_A);

  // Finished runs stay untouched: detaching them instead of cascading them away is what keeps a
  // deleted task's history readable. TASK_OCCUPYING is the set that has not finished — PENDING
  // included, since a queued run would otherwise start working a task that no longer exists.
  const scan = JSON.parse(calls[calls.indexOf('scan') + 1]);
  assert.deepEqual(scan, {
    ownerId: OWNER_ID,
    taskId: { in: [TASK_A] },
    status: { in: ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'] },
  });
});

test('the runs are read under a lock on the task, before it is deleted', async () => {
  const { service, calls } = deleteRecorder([RUN_A]);

  await service.remove(OWNER_ID, TASK_A);

  // Order is the whole fix: after the delete the SET NULL foreign key has already erased the
  // link, and there is nothing left to scan for.
  //
  // Four locks now, in the ranks of the canonical order (common/lock-order.ts): the owner graph
  // mutex (10), because a delete cascades edges away and writes many `task` rows; the runs
  // attached to those tasks (30), because the DELETE's SET NULL cascade writes them and this is
  // the one transaction that would otherwise take a `session` lock from inside a `task` lock;
  // their projects (40), the lock `project_acceptance_reopen` takes from an AFTER trigger on each
  // DELETE; then the tasks themselves (50).
  assert.deepEqual(
    calls.filter((c) => ['lock', 'scan', 'delete', 'cancel'].includes(c)),
    ['lock', 'lock', 'lock', 'lock', 'scan', 'delete', 'cancel'],
  );
  const sql = calls.filter((c) => c.startsWith('SELECT'));
  assert.match(sql[0], /FROM "user"/);
  assert.match(sql[0], /FOR UPDATE/);
  assert.match(sql[1], /FROM "session"/);
  assert.match(sql[1], /ORDER BY "id"/);
  assert.match(sql[1], /FOR UPDATE/);
  assert.match(sql[2], /FROM "project"/);
  assert.match(sql[2], /ORDER BY "id"/);
  assert.match(sql[2], /FOR NO KEY UPDATE/);
  // FOR UPDATE on the task row conflicts with the FOR KEY SHARE a session insert takes on it,
  // so a dispatch landing mid-delete either commits before the scan or fails its foreign key.
  // Without it, a run could slip in between the scan and the delete and be stranded.
  assert.match(sql[3], /FROM "task"/);
  assert.match(sql[3], /FOR UPDATE/);
});

test('a run that cannot be ended does not fail the delete', async () => {
  const published: unknown[][] = [];
  const service = serviceWith(
    {
      task: { findFirst: async () => ownedTask(), deleteMany: async () => ({ count: 1 }) },
      session: { findMany: async () => [{ id: RUN_A }, { id: RUN_B }] },
    },
    { publishForUser: (...args: unknown[]) => published.push(args) },
    {
      cancel: async (_o: string, id: string) => {
        if (id === RUN_A) throw new Error('runner gone');
        return true;
      },
    },
  );

  // The task is deleted either way, and an end nobody honors is force-finalized by the reaper.
  assert.deepEqual(await service.remove(OWNER_ID, TASK_A), { ok: true });
  assert.deepEqual(published, [[OWNER_ID, 'task_changed', { taskIds: [], resync: true }]]);
});

test('batch delete ends the runs of every task it removes', async () => {
  const { service, cancelled, calls } = deleteRecorder([RUN_A, RUN_B], 2);

  assert.deepEqual(await service.batchDelete(OWNER_ID, [TASK_A, TASK_B]), { deleted: 2 });

  assert.deepEqual(JSON.parse(calls[calls.indexOf('scan') + 1]).taskId, { in: [TASK_A, TASK_B] });
  assert.deepEqual(cancelled.map((c) => c[1]), [RUN_A, RUN_B]);
  // The delete was one implicit statement before, under no client deadline. Prisma's default
  // aborts an interactive transaction at 5s, which a batch cascading through thousands of
  // comments and edges would hit — deletes that used to work would start failing as P2028.
  assert.ok(lastTxOptions.timeout >= 30_000, `transaction deadline: ${lastTxOptions?.timeout}`);
});
