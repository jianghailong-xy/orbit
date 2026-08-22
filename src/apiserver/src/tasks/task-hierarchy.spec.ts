import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { TaskStatus } from '@orbit/shared';
import { TasksService } from './tasks.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const PROJECT_ID = '00000000-0000-7000-8000-0000000000a1';
const OTHER_PROJECT_ID = '00000000-0000-7000-8000-0000000000a2';
const TASK_ID = '00000000-0000-7000-8000-0000000000b1';
const PARENT_ID = '00000000-0000-7000-8000-0000000000b2';
const CHILD_ID = '00000000-0000-7000-8000-0000000000b3';

/**
 * A TasksService over `models`, whose `$transaction` hands those same stubs back as the
 * transactional client — so a test can assert not only WHAT the service asked but whether it asked
 * inside a transaction, and whether it took the owner lock first. Every raw statement and
 * transaction boundary lands in `calls`, which a test's own stubs can push into as well to pin
 * down the order.
 */
function serviceOn(models: Record<string, unknown>, calls: string[] = []) {
  const client: Record<string, unknown> = { ...models };
  // §13.6 SU3's other direction: a project move now reads whether this task is anybody's SUCCESSOR
  // before it commits. None of these cases has one, so the double answers "nobody" — spelled here
  // rather than in each fixture so a case that adds one has to say so.
  const task = client.task as Record<string, unknown> | undefined;
  if (task && !task.findMany) task.findMany = async () => [];
  client.$queryRaw = async (strings: TemplateStringsArray | Prisma.Sql, ...bound: unknown[]) => {
    // Two calling conventions reach this double, and both are production shapes: a tagged template
    // (`tx.$queryRaw\`...\``) and a prepared `Prisma.sql` object. Handing the second to
    // `Prisma.sql()` as if it were a template array throws inside the client runtime, which reads
    // as a failure of the code under test rather than of the stub.
    const query = 'raw' in strings
      ? Prisma.sql(strings as TemplateStringsArray, ...(bound as never[]))
      : (strings as Prisma.Sql);
    const sql = query.text.replace(/\s+/g, ' ').trim();
    // Labelled by the table it locks: the owner lock is `... FROM "user" ... FOR UPDATE`.
    calls.push(
      /FOR UPDATE/i.test(sql) ? `lock:${/FROM\s+"(\w+)"/i.exec(sql)?.[1] ?? '?'}` : `raw:${sql}`,
    );
    // The live-session probe a project move now makes (§12.3 D3 / §13.6 SU8) must answer "no live
    // run" here: none of these cases has one, and a blanket row would refuse every move.
    if (/FROM "session"/i.test(sql)) return [];
    return [{ id: OWNER_ID }];
  };
  client.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    calls.push('BEGIN');
    const result = await fn(client);
    calls.push('COMMIT');
    return result;
  };
  return { service: new TasksService(client as never, {} as never, {} as never), calls };
}

/** A task row as `get` returns it, with only what update() reads off it. */
function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    ownerId: OWNER_ID,
    status: TaskStatus.OPEN,
    projectId: null,
    parentTaskId: null,
    comments: [],
    sessions: [],
    dependsOn: [],
    dependedOnBy: [],
    ...overrides,
  };
}

test('a task is created into the project and parent it names', async () => {
  let created: any;
  const { service } = serviceOn({
    project: { findFirst: async () => ({ id: PROJECT_ID }) },
    task: {
      findFirst: async () => ({ id: PARENT_ID, projectId: PROJECT_ID }),
      create: async (args: any) => {
        created = args.data;
        return { id: TASK_ID, ...args.data };
      },
    },
    taskList: { findMany: async () => [] },
  });

  await service.create(OWNER_ID, {
    title: 'Write the migration',
    projectId: PROJECT_ID,
    parentTaskId: PARENT_ID,
    acceptanceCriteria: 'It applies to an empty database and to this one',
  } as never);

  assert.equal(created.projectId, PROJECT_ID);
  assert.equal(created.parentTaskId, PARENT_ID);
  assert.equal(created.acceptanceCriteria, 'It applies to an empty database and to this one');
});

// The parent's project is read and then relied on by the row written next. Unserialized, a
// concurrent move of that parent into another project lands between the two and the child is
// written into a project its parent has already left.
test('creating a subtask reads its parent under the owner lock, in one transaction', async () => {
  const calls: string[] = [];
  const { service } = serviceOn(
    {
      project: { findFirst: async () => ({ id: PROJECT_ID }) },
      task: {
        findFirst: async () => {
          calls.push('readParent');
          return { id: PARENT_ID, projectId: PROJECT_ID };
        },
        create: async (args: any) => {
          calls.push('createTask');
          return { id: TASK_ID, ...args.data };
        },
      },
      taskList: { findMany: async () => [] },
    },
    calls,
  );

  await service.create(OWNER_ID, {
    title: 'subtask',
    projectId: PROJECT_ID,
    parentTaskId: PARENT_ID,
  } as never);

  // The lock is taken before the parent is read, and the write happens before the commit — so no
  // other writer can observe or change the parent in between.
  assert.deepEqual(calls, ['BEGIN', 'lock:user', 'readParent', 'createTask', 'COMMIT']);
});

// The other half of the same rule: an ordinary create must not queue behind another request's DAG
// rewrite for the same owner.
test('creating an ordinary task takes no transaction and no lock', async () => {
  const calls: string[] = [];
  const { service } = serviceOn(
    {
      task: {
        create: async (args: any) => {
          calls.push('createTask');
          return { id: TASK_ID, ...args.data };
        },
      },
      taskList: { findMany: async () => [] },
    },
    calls,
  );

  await service.create(OWNER_ID, { title: 'just a task' } as never);

  assert.deepEqual(calls, ['createTask']);
});

test('a project belonging to somebody else cannot be filed into', async () => {
  const { service } = serviceOn({
    project: { findFirst: async () => null },
    task: { create: async () => assert.fail('must not write a task against a foreign project') },
    taskList: { findMany: async () => [] },
  });

  await assert.rejects(
    () => service.create(OWNER_ID, { title: 'sneaky', projectId: OTHER_PROJECT_ID } as never),
    /project not found/,
  );
});

test('a parent in another project is refused, at create and at update', async () => {
  const { service } = serviceOn({
    project: { findFirst: async () => ({ id: PROJECT_ID }) },
    task: {
      // The parent lives in a different project from the child being written.
      findFirst: async (args: any) =>
        args.where.id === PARENT_ID
          ? { id: PARENT_ID, projectId: OTHER_PROJECT_ID }
          : taskRow({ projectId: PROJECT_ID }),
      create: async () => assert.fail('must not write a cross-project subtask'),
      update: async () => assert.fail('must not write a cross-project subtask'),
    },
    taskList: { findMany: async () => [] },
    taskDependency: { findMany: async () => [] },
  });

  await assert.rejects(
    () =>
      service.create(OWNER_ID, {
        title: 'subtask',
        projectId: PROJECT_ID,
        parentTaskId: PARENT_ID,
      } as never),
    /same project as its parent/,
  );
  await assert.rejects(
    () => service.update(OWNER_ID, TASK_ID, { parentTaskId: PARENT_ID } as never),
    /same project as its parent/,
  );
});

test('a parent that is not the caller’s is a 404 rather than a silent link', async () => {
  const { service } = serviceOn({
    task: {
      findFirst: async () => null,
      create: async () => assert.fail('must not write a task against a foreign parent'),
    },
    taskList: { findMany: async () => [] },
  });

  await assert.rejects(
    () => service.create(OWNER_ID, { title: 'orphan', parentTaskId: PARENT_ID } as never),
    /parent task not found/,
  );
});

test('a task cannot be its own parent', async () => {
  const { service } = serviceOn({
    task: {
      findFirst: async () => taskRow(),
      update: async () => assert.fail('must not write a self-parent'),
    },
    taskDependency: { findMany: async () => [] },
  });

  await assert.rejects(
    () => service.update(OWNER_ID, TASK_ID, { parentTaskId: TASK_ID } as never),
    /cannot be its own parent/,
  );
});

// The cycle that a self-parent check alone would miss: the proposed parent is further DOWN this
// task's own subtree, so the link only closes a loop once you walk up from it.
test('a parent that sits under this task closes a cycle and is refused', async () => {
  const parentOf: Record<string, string | null> = {
    // grandchild -> child -> task
    [CHILD_ID]: TASK_ID,
    [TASK_ID]: null,
  };
  const { service } = serviceOn({
    task: {
      findFirst: async (args: any) =>
        args.where.id === CHILD_ID ? { id: CHILD_ID, projectId: null } : taskRow(),
      findUnique: async (args: any) => ({ parentTaskId: parentOf[args.where.id] ?? null }),
      update: async () => assert.fail('must not write a cycle'),
    },
    taskDependency: { findMany: async () => [] },
  });

  await assert.rejects(
    () => service.update(OWNER_ID, TASK_ID, { parentTaskId: CHILD_ID } as never),
    /already one of this task’s subtasks/,
  );
});

// Every step of that walk has to read through the transaction that will do the writing. Two
// simultaneous requests — A under B, B under A — each pass against a graph that does not yet
// contain the other and commit a cycle between them, unless the walk runs under the owner lock.
test('the cycle walk runs inside the locked transaction, not before it', async () => {
  const calls: string[] = [];
  const { service } = serviceOn(
    {
      task: {
        findFirst: async (args: any) => {
          if (args.where.id === PARENT_ID) {
            calls.push('readParent');
            return { id: PARENT_ID, projectId: null };
          }
          calls.push('reReadTask');
          return taskRow();
        },
        findUnique: async () => {
          calls.push('walkUp');
          return { parentTaskId: null };
        },
        count: async () => 0,
        update: async () => {
          calls.push('updateTask');
          return { id: TASK_ID };
        },
      },
      taskDependency: { findMany: async () => [] },
    },
    calls,
  );

  await service.update(OWNER_ID, TASK_ID, { parentTaskId: PARENT_ID } as never);

  // `get()`'s read comes first (outside), then everything that decides and writes is inside one
  // transaction, behind the lock. No rank-30 pre-lock here: a re-point writes the task row once,
  // and PostgreSQL only re-runs `task_creator_session_id_fkey` on a SECOND write of a row this
  // transaction already wrote (common/lock-order.ts, I2) — which a dependency replacement or a
  // supersession does and this does not.
  assert.deepEqual(calls, [
    'reReadTask',
    'BEGIN',
    'lock:user',
    'reReadTask',
    'readParent',
    'walkUp',
    'updateTask',
    'COMMIT',
  ]);
});

// The re-read is the point of the lock, not a formality: judging against the copy loaded before
// the lock is exactly how two individually-legal writes commit an illegal state together.
test('the hierarchy is judged against the state under the lock, not the one read before it', async () => {
  let reads = 0;
  const { service } = serviceOn({
    task: {
      findFirst: async (args: any) => {
        if (args.where.id === PARENT_ID) return { id: PARENT_ID, projectId: PROJECT_ID };
        reads += 1;
        // First read is `get()`, before the lock: the task is still in PROJECT_ID, so the parent
        // below would be a legal link. By the time the lock is held, another writer has moved it.
        return reads === 1
          ? taskRow({ projectId: PROJECT_ID })
          : taskRow({ projectId: OTHER_PROJECT_ID });
      },
      count: async () => 0,
      update: async () => assert.fail('must not link against a project the task has already left'),
    },
    taskDependency: { findMany: async () => [] },
  });

  await assert.rejects(
    () => service.update(OWNER_ID, TASK_ID, { parentTaskId: PARENT_ID } as never),
    /same project as its parent/,
  );
  assert.equal(reads, 2);
});

// A malformed tree must not make the walk spin: it terminates and, since the loop it met is not
// one this write is creating, it does not blame the caller for it.
test('a cycle already in the stored tree stops the walk instead of hanging it', async () => {
  const parentOf: Record<string, string | null> = {
    [PARENT_ID]: CHILD_ID,
    [CHILD_ID]: PARENT_ID,
  };
  let writes = 0;
  const { service } = serviceOn({
    task: {
      findFirst: async (args: any) =>
        args.where.id === PARENT_ID ? { id: PARENT_ID, projectId: null } : taskRow(),
      findUnique: async (args: any) => ({ parentTaskId: parentOf[args.where.id] ?? null }),
      count: async () => 0,
      update: async () => {
        writes += 1;
        return { id: TASK_ID };
      },
    },
    taskDependency: { findMany: async () => [] },
  });

  await service.update(OWNER_ID, TASK_ID, { parentTaskId: PARENT_ID } as never);
  assert.equal(writes, 1);
});

test('moving a task that has subtasks is refused, and says how to do it', async () => {
  const { service } = serviceOn({
    project: { findFirst: async () => ({ id: OTHER_PROJECT_ID }) },
    task: {
      findFirst: async () => taskRow({ projectId: PROJECT_ID }),
      count: async (args: any) => {
        assert.deepEqual(args.where, { ownerId: OWNER_ID, parentTaskId: TASK_ID });
        return 3;
      },
      update: async () => assert.fail('must not strand subtasks in another project'),
    },
    taskDependency: { findMany: async () => [] },
  });

  await assert.rejects(
    () => service.update(OWNER_ID, TASK_ID, { projectId: OTHER_PROJECT_ID } as never),
    /3 subtask\(s\).*detach them/s,
  );
});

test('a task with no subtasks moves project, and detaching a parent always works', async () => {
  const writes: any[] = [];
  const { service } = serviceOn({
    project: { findFirst: async () => ({ id: OTHER_PROJECT_ID }) },
    task: {
      findFirst: async () => taskRow({ projectId: PROJECT_ID, parentTaskId: PARENT_ID }),
      count: async () => 0,
      update: async (args: any) => {
        writes.push(args.data);
        return { id: TASK_ID };
      },
    },
    taskDependency: { findMany: async () => [] },
  });

  await service.update(OWNER_ID, TASK_ID, {
    projectId: OTHER_PROJECT_ID,
    // Detaching needs no parent to be eligible — there is no parent left to disagree with.
    parentTaskId: null,
  } as never);

  assert.deepEqual(writes[0].project, { connect: { id: OTHER_PROJECT_ID } });
  assert.deepEqual(writes[0].parent, { disconnect: true });
});

test('acceptance criteria are replaced when sent and cleared by null', async () => {
  const writes: any[] = [];
  const { service } = serviceOn({
    task: {
      findFirst: async () => taskRow(),
      update: async (args: any) => {
        writes.push(args.data);
        return { id: TASK_ID };
      },
      count: async () => 0,
    },
    taskDependency: { findMany: async () => [] },
  });

  await service.update(OWNER_ID, TASK_ID, { acceptanceCriteria: 'The suite is green' } as never);
  await service.update(OWNER_ID, TASK_ID, { acceptanceCriteria: null } as never);
  await service.update(OWNER_ID, TASK_ID, { title: 'renamed' } as never);

  assert.equal(writes[0].acceptanceCriteria, 'The suite is green');
  assert.equal(writes[1].acceptanceCriteria, null);
  // Omitted means "leave it alone", like every other three-state field on this DTO.
  assert.equal(writes[2].acceptanceCriteria, undefined);
});

// The guarantee this whole phase rests on: an update that says nothing about a project or a parent
// behaves exactly as it did before the columns existed — same writes, no extra query, and no lock.
test('an update that mentions neither column asks no hierarchy questions', async () => {
  const calls: string[] = [];
  const { service } = serviceOn(
    {
      project: { findFirst: async () => assert.fail('must not look up a project it was not given') },
      task: {
        findFirst: async () => taskRow({ projectId: PROJECT_ID, parentTaskId: PARENT_ID }),
        findUnique: async () => assert.fail('must not walk the parent chain'),
        count: async () => assert.fail('must not count subtasks'),
        update: async (args: any) => {
          calls.push('updateTask');
          return { id: TASK_ID, ...args.data };
        },
      },
      taskDependency: { findMany: async () => [] },
    },
    calls,
  );

  const updated: any = await service.update(OWNER_ID, TASK_ID, {
    title: 'renamed',
    status: TaskStatus.OPEN,
  } as never);

  // No hierarchy question, and no owner mutex — this write restructures nothing. The one lock is
  // rank 40: a status write on a project-filed task makes `project_acceptance_task_fact_update`
  // take FOR NO KEY UPDATE on that project, so it is taken here rather than left to an AFTER
  // trigger holding the task row already (common/lock-order.ts).
  assert.deepEqual(calls, [
    'BEGIN',
    'raw:SELECT 1 FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE',
    'updateTask',
    'COMMIT',
  ]);
  // Not the owner mutex: a status write restructures nothing, so it must not queue behind
  // another request's DAG rewrite. And not the creator-Session pre-lock: that is for a write
  // that touches the task row TWICE, which this one does not.
  assert.equal(updated.project, undefined);
  assert.equal(updated.parent, undefined);
});

// The other half of that rule: no project, no acceptance fact, nothing to order against — so the
// cheapest write stays the cheapest write.
test('a status write on a task with no project stays a single statement', async () => {
  const calls: string[] = [];
  const { service } = serviceOn(
    {
      task: {
        findFirst: async () => taskRow({ projectId: null }),
        update: async (args: any) => {
          calls.push('updateTask');
          return { id: TASK_ID, ...args.data };
        },
      },
      taskDependency: { findMany: async () => [] },
    },
    calls,
  );

  await service.update(OWNER_ID, TASK_ID, { status: TaskStatus.OPEN } as never);

  assert.deepEqual(calls, ['updateTask']);
});

// batch-create shares taskCreateData with create, so it would otherwise be a way to write the
// hierarchy columns without a single check.
test('batch-create validates every item’s parent under the lock, before writing any of them', async () => {
  const calls: string[] = [];
  const { service } = serviceOn(
    {
      project: { findFirst: async () => ({ id: PROJECT_ID }) },
      task: {
        findFirst: async () => {
          calls.push('readParent');
          return { id: PARENT_ID, projectId: OTHER_PROJECT_ID };
        },
        create: async () => assert.fail('a rejected batch must write nothing'),
      },
      taskList: { findMany: async () => [] },
    },
    calls,
  );

  await assert.rejects(
    () =>
      service.createMany(OWNER_ID, {
        tasks: [
          { title: 'fine', projectId: PROJECT_ID },
          { title: 'cross-project subtask', projectId: PROJECT_ID, parentTaskId: PARENT_ID },
        ],
      } as never),
    /same project as its parent/,
  );
  // The batch opens its transaction and locks before it reads the first parent, and never reaches
  // a write — so item 1 is not left behind by item 2's rejection.
  assert.deepEqual(calls, ['BEGIN', 'lock:user', 'readParent']);
});

test('a batch with parents but no dependencies still takes the lock', async () => {
  const calls: string[] = [];
  const { service } = serviceOn(
    {
      project: { findFirst: async () => ({ id: PROJECT_ID }) },
      task: {
        findFirst: async () => ({ id: PARENT_ID, projectId: PROJECT_ID }),
        create: async (args: any) => {
          calls.push('createTask');
          return { id: TASK_ID, ...args.data };
        },
      },
      taskList: { findMany: async () => [] },
    },
    calls,
  );

  await service.createMany(OWNER_ID, {
    tasks: [{ title: 'subtask', projectId: PROJECT_ID, parentTaskId: PARENT_ID }],
  } as never);

  assert.deepEqual(calls, ['BEGIN', 'lock:user', 'createTask', 'COMMIT']);
});

test('a batch with neither parents nor dependencies still takes the owner lock', async () => {
  const calls: string[] = [];
  const { service } = serviceOn(
    {
      task: {
        create: async (args: any) => {
          calls.push('createTask');
          return { id: TASK_ID, ...args.data };
        },
      },
      taskList: { findMany: async () => [] },
    },
    calls,
  );

  await service.createMany(OWNER_ID, { tasks: [{ title: 'a' }, { title: 'b' }] } as never);

  // Not for the hierarchy — there is none — but because a batch writes several `task` rows in
  // item order, and rank 10 of the canonical order is what stops two multi-row Task writes from
  // taking the same rows in opposite orders (common/lock-order.ts, I1).
  assert.deepEqual(calls, ['BEGIN', 'lock:user', 'createTask', 'createTask', 'COMMIT']);
});
