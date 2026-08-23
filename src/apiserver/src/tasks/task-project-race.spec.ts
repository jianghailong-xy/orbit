import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { TaskStatus } from '@orbit/shared';
import { TasksService } from './tasks.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const PROJECT_ID = '00000000-0000-7000-8000-0000000000a1';
const TASK_ID = '00000000-0000-7000-8000-0000000000b1';
const LIST_ID = '00000000-0000-7000-8000-0000000000c1';

/**
 * A write that a project's deletion beat to the database.
 *
 * `ON DELETE RESTRICT` plus the row lock ProjectsService.remove holds mean the loser of that race
 * is always the write. It loses in one of two ways, and which one is a matter of milliseconds:
 * PostgreSQL refuses the reference (P2003), or Prisma resolves a `connect:` first and finds
 * nothing to connect to (P2025). Both are raised by a concurrently deleted list, assignee or
 * parent task too, which is why the translation re-reads the project instead of trusting the code.
 */
function foreignKeyViolation(constraint = 'task_project_id_fkey (index)') {
  return new Prisma.PrismaClientKnownRequestError(`Foreign key constraint violated: ${constraint}`, {
    code: 'P2003',
    clientVersion: 'test',
    meta: { field_name: constraint },
  });
}

/** The other face of the same race: `update`'s nested connect, resolved before the constraint. */
function missingConnect(relation = 'ProjectToTask') {
  return new Prisma.PrismaClientKnownRequestError(
    `An operation failed because it depends on one or more records that were required but not ` +
      `found. No 'Project' record(s) was found for a nested connect on relation '${relation}'.`,
    { code: 'P2025', clientVersion: 'test' },
  );
}

/** A service whose task writes all fail with `error`, and whose projects are `liveProjects`. */
function serviceFailingWith(error: unknown, liveProjects: string[]) {
  const lookups: unknown[] = [];
  const client: Record<string, unknown> = {
    workspace: { findMany: async () => [] },
    modelProvider: { findMany: async () => [] },
    projectHandoffApproval: { findFirst: async () => null },
    project: {
      // The pre-write ownership check passes: at that moment the project was still there.
      findFirst: async () => ({ id: PROJECT_ID }),
      // Unit L4's preflight: the project is gone by the time this is asked, which is the whole
      // point of these cases — an empty answer here leaves the refusal to the write itself.
      findMany: async () => [],
      count: async (args: any) => {
        lookups.push(args.where);
        return liveProjects.filter((id) => (args.where.id.in as string[]).includes(id)).length;
      },
    },
    task: {
      findFirst: async () => ({
        id: TASK_ID,
        ownerId: OWNER_ID,
        status: TaskStatus.OPEN,
        projectId: null,
        parentTaskId: null,
        comments: [],
        sessions: [],
        dependsOn: [],
        dependedOnBy: [],
      }),
      create: async () => {
        throw error;
      },
      update: async () => {
        throw error;
      },
      count: async () => 0,
      // §13.6 SU3's other direction: moving a task now reads whether it is anybody's SUCCESSOR
      // before it commits. Nothing here replaces anything, so the answer is nobody.
      findMany: async () => [],
    },
    // Like the project, the list passes its pre-write check — the race is what happens after.
    taskList: { findFirst: async () => ({ id: LIST_ID }), findMany: async () => [] },
    taskDependency: { findMany: async () => [] },
  };
  // Naming a project makes the write take the owner lock, so the stub has to answer it.
  // The owner lock answers with a row; the live-session probe a project move now makes (§12.3 D3)
  // must answer with none — nothing in these cases is running, and a blanket row would make every
  // move refuse before it could reach the failure each case is actually about.
  client.$queryRaw = async (strings: unknown, ...bound: unknown[]) => {
    const query = strings && typeof strings === 'object' && 'raw' in (strings as object)
      ? Prisma.sql(strings as TemplateStringsArray, ...(bound as never[]))
      : (strings as Prisma.Sql);
    return /FROM "session"/i.test(query.text) ? [] : [{ id: OWNER_ID }];
  };
  client.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(client);
  return { service: new TasksService(client as never, {} as never, {} as never), lookups };
}

// Losing this race by a millisecond and asking a day later are the same request with the same
// answer. A 500 says the server broke; nothing broke — RESTRICT did exactly its job.
test('create into a project deleted mid-write answers 403, not 500', async () => {
  const { service, lookups } = serviceFailingWith(foreignKeyViolation(), []);

  await assert.rejects(
    () => service.create(OWNER_ID, { title: 'filed', projectId: PROJECT_ID } as never),
    (e: any) => e.status === 403 && e.message === 'project not found',
  );
  // It re-read the project this request actually named, scoped to the caller.
  assert.deepEqual(lookups, [{ id: { in: [PROJECT_ID] }, ownerId: OWNER_ID }]);
});

// `update` connects the relation rather than writing the column, so Prisma may notice the missing
// project before PostgreSQL does. Whichever guard catches it, the caller hears the same thing —
// the alternative is a 500 that appears only sometimes, which is worse than one that always does.
test('update into a project deleted mid-write answers 403 for either failure shape', async () => {
  for (const failure of [foreignKeyViolation(), missingConnect()]) {
    const { service } = serviceFailingWith(failure, []);
    await assert.rejects(
      () => service.update(OWNER_ID, TASK_ID, { projectId: PROJECT_ID } as never),
      (e: any) => e.status === 403 && e.message === 'project not found',
    );
  }
});

// P2025 on an update can equally mean the TASK is gone, so the re-read is what makes it safe to
// translate at all: project alive means this error was about something else entirely.
test('a missing-connect failure with the project still present is left alone', async () => {
  const failure = missingConnect('TaskHierarchy');
  const { service } = serviceFailingWith(failure, [PROJECT_ID]);

  await assert.rejects(
    () => service.update(OWNER_ID, TASK_ID, { projectId: PROJECT_ID } as never),
    (e: unknown) => e === failure,
  );
});

test('batch-create into a project deleted mid-write answers 403, not 500', async () => {
  const { service } = serviceFailingWith(foreignKeyViolation(), []);

  await assert.rejects(
    () =>
      service.createMany(OWNER_ID, {
        tasks: [{ title: 'a', projectId: PROJECT_ID }, { title: 'b' }],
      } as never),
    (e: any) => e.status === 403 && e.message === 'project not found',
  );
});

// The narrowness is the whole point. A list or a parent task deleted mid-write raises the SAME
// P2003, and relabelling that as "project not found" would send the caller to fix the wrong thing.
// The project is still there, so whatever the database refused, it was not this.
test('a foreign-key failure with the project still present is left exactly as it was', async () => {
  const violation = foreignKeyViolation('task_list_id_fkey (index)');
  const { service, lookups } = serviceFailingWith(violation, [PROJECT_ID]);

  for (const call of [
    () =>
      service.create(OWNER_ID, {
        title: 'filed',
        projectId: PROJECT_ID,
        listId: LIST_ID,
      } as never),
    () =>
      service.update(OWNER_ID, TASK_ID, { projectId: PROJECT_ID, listId: LIST_ID } as never),
    () =>
      service.createMany(OWNER_ID, {
        tasks: [{ title: 'a', projectId: PROJECT_ID, listId: LIST_ID }],
      } as never),
  ]) {
    await assert.rejects(call, (e: unknown) => e === violation);
  }
  // Each path asked, and each got the same answer: the project is fine, so this is not its error.
  assert.equal(lookups.length, 3);
});

// A request that never mentioned a project cannot have lost this race, so it does not even ask.
test('a write that named no project is never relabelled, and costs no extra query', async () => {
  const violation = foreignKeyViolation('task_assignee_id_fkey (index)');
  const { service, lookups } = serviceFailingWith(violation, []);

  await assert.rejects(
    () => service.create(OWNER_ID, { title: 'no project here' } as never),
    (e: unknown) => e === violation,
  );
  await assert.rejects(
    () => service.update(OWNER_ID, TASK_ID, { title: 'renamed' } as never),
    (e: unknown) => e === violation,
  );
  assert.deepEqual(lookups, []);
});

// Only the foreign key means "the project went away". Every other database error is somebody
// else's diagnosis to make.
test('errors other than a foreign-key violation are not touched', async () => {
  const other = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
  const { service, lookups } = serviceFailingWith(other, []);

  await assert.rejects(
    () => service.create(OWNER_ID, { title: 'x', projectId: PROJECT_ID } as never),
    (e: unknown) => e === other,
  );
  assert.deepEqual(lookups, []);
});
