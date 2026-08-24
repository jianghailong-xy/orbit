import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { ProjectStatus } from '@orbit/shared';
import { ProjectsService } from './projects.service';

const { PrismaClientKnownRequestError } = Prisma;

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const PROJECT_ID = '00000000-0000-7000-8000-0000000000a1';

// The acceptance service is stubbed to the empty standing: `get` reads a criteria summary beside
// the task tally, and no test in this file is about what that summary contains.
function serviceWith(prisma: unknown): ProjectsService {
  const acceptance = {
    criteriaSummary: async () => ({ total: 0, passed: 0, lastRunAt: null, criteria: [] }),
  };
  return new ProjectsService(prisma as never, acceptance as never);
}

test('create files the project against the caller and stores blank prose as null', async () => {
  let created: any;
  const service = serviceWith({
    project: {
      create: async (args: any) => {
        created = args.data;
        // The two rows every project response is folded from, in the shape the include asks for.
        return { id: PROJECT_ID, ...args.data, members: [], runtime: { coordinatorGeneration: 0n } };
      },
    },
  });

  await service.create(OWNER_ID, {
    title: 'Ship the coordinator',
    goal: 'A project can be driven end to end',
    // Whitespace is not a goal. Stored as null so "not set" has exactly one representation.
    acceptanceCriteria: '   ',
  } as never);

  assert.equal(created.ownerId, OWNER_ID);
  assert.equal(created.title, 'Ship the coordinator');
  assert.equal(created.goal, 'A project can be driven end to end');
  assert.equal(created.acceptanceCriteria, null);
  // Never sent at all: left to the column default rather than written as null-by-guess.
  assert.equal(created.instructions, undefined);
});

// The status vocabulary is the work's, not a reader's list's: a project is OPEN, was achieved
// (DONE), or was abandoned (CANCELLED). Filing — archived, hidden — is a different fact about a
// different thing and must not be spelled by overwriting this one.
test('project status is the work’s lifecycle, in the same words its tasks use', () => {
  assert.deepEqual(Object.values(ProjectStatus), ['OPEN', 'DONE', 'CANCELLED']);
  for (const filing of ['ACTIVE', 'ARCHIVED', 'HIDDEN']) {
    assert.equal(Object.values<string>(ProjectStatus).includes(filing), false);
  }
});

test('a new project starts OPEN without the caller saying so', async () => {
  let created: any;
  const service = serviceWith({
    project: {
      create: async (args: any) => {
        created = args.data;
        return {
          id: PROJECT_ID,
          status: 'OPEN',
          ...args.data,
          members: [],
          runtime: { coordinatorGeneration: 0n },
        };
      },
    },
  });

  await service.create(OWNER_ID, { title: 'Fresh' } as never);

  // Left to the column default rather than written here, so one place decides what "new" means.
  assert.equal(created.status, undefined);
});

test('the index is owner-scoped and newest first, and narrows only when asked', async () => {
  const queries: any[] = [];
  const service = serviceWith({
    project: {
      findMany: async (args: any) => {
        queries.push(args);
        return [];
      },
    },
  });

  await service.list(OWNER_ID);
  await service.list(OWNER_ID, ProjectStatus.DONE as never);

  assert.deepEqual(queries[0].where, { ownerId: OWNER_ID });
  assert.deepEqual(queries[0].orderBy, { createdAt: 'desc' });
  // Counted, not embedded: `GET /task-lists/:id` embeds its tasks and had to grow an escape
  // hatch when one list reached 27k of them. The two coordination rows are bounded the same way —
  // at most one apiece, joined by their own key — and are folded into two fields on the way out.
  assert.deepEqual(queries[0].include, {
    _count: { select: { tasks: true } },
    members: { where: { role: 'COORDINATOR' }, select: { agentId: true } },
    runtime: { select: { coordinatorGeneration: true } },
  });
  assert.deepEqual(queries[1].where, { ownerId: OWNER_ID, status: 'DONE' });
});

test('the detail read reports progress without loading the project’s tasks', async () => {
  let groupByArgs: any;
  const service = serviceWith({
    project: {
      findFirst: async () => ({
        id: PROJECT_ID,
        title: 'Ship it',
        _count: { tasks: 3 },
        members: [],
        runtime: { coordinatorGeneration: 0n },
      }),
    },
    task: {
      groupBy: async (args: any) => {
        groupByArgs = args;
        return [
          { status: 'DONE', _count: { _all: 2 } },
          { status: 'OPEN', _count: { _all: 1 } },
        ];
      },
      findMany: async () => assert.fail('the detail read must not load the project’s tasks'),
    },
    // The acceptance standing the read serves beside the task tally. A project nobody has run
    // acceptance against has no run to read, which is the shape this stub gives it.
    projectAcceptanceRun: { findFirst: async () => null },
  });

  const project = await service.get(OWNER_ID, PROJECT_ID);

  assert.deepEqual(project.tasksByStatus, { DONE: 2, OPEN: 1 });
  assert.equal(project._count.tasks, 3);
  assert.deepEqual(groupByArgs.where, { projectId: PROJECT_ID });
  // The process measure and the outcome measure are both served: a task tally can read 100% while
  // nothing stated has been checked. `project-acceptance-summary.pg.spec.ts` is where the tally
  // itself is decided, against real runs.
  assert.deepEqual(project.acceptance, { total: 0, passed: 0, lastRunAt: null, criteria: [] });
});

test('someone else’s project is a 404, not an empty project', async () => {
  const service = serviceWith({
    project: { findFirst: async () => null },
    // remove() authorizes with the row lock rather than a findFirst — an id nobody owns locks
    // nothing, which is the same 404.
    $transaction: async (fn: any) =>
      fn({ $queryRaw: async () => [], task: { count: async () => 0 } }),
  });

  await assert.rejects(() => service.get(OWNER_ID, PROJECT_ID), /project not found/);
  await assert.rejects(
    () => service.update(OWNER_ID, PROJECT_ID, { title: 'mine now' } as never),
    /project not found/,
  );
  await assert.rejects(() => service.remove(OWNER_ID, PROJECT_ID), /project not found/);
});

test('an update writes only the fields it was sent, and null clears one', async () => {
  const writes: any[] = [];
  const prisma: any = {
    project: {
      findFirst: async () => ({ id: PROJECT_ID, coordinatorEnabled: false }),
      update: async (args: any) => {
        writes.push(args.data);
        return {
          id: PROJECT_ID,
          ...args.data,
          members: [],
          runtime: { coordinatorGeneration: 0n },
        };
      },
    },
    // The project row's lock and the write are one transaction (see ProjectsService.update).
    $queryRaw: async () => [{ id: PROJECT_ID }],
  };
  prisma.$transaction = async (fn: any) => fn(prisma);
  const service = serviceWith(prisma);

  // Settling a project must not blank the goal that says what it was for. CANCELLED rather than
  // DONE because DONE is no longer a field write: it goes through §13.4 AE2's acceptance gate,
  // which is the subject of its own tests (`project-acceptance*.spec.ts`).
  await service.update(OWNER_ID, PROJECT_ID, { status: ProjectStatus.CANCELLED } as never);
  assert.deepEqual(writes[0], { status: 'CANCELLED' });

  await service.update(OWNER_ID, PROJECT_ID, { goal: null, title: 'Renamed' } as never);
  assert.deepEqual(writes[1], { title: 'Renamed', goal: null });
});

/** A `remove()` stub: `tasks` is what the count under the lock finds. */
function removableProject(tasks: number, calls: string[] = []) {
  return {
    prisma: {
      $transaction: async (fn: any) =>
        fn({
          $queryRaw: async (strings: TemplateStringsArray) => {
            calls.push(String.raw({ raw: strings }).includes('FOR UPDATE') ? 'lock' : 'read');
            return [{ id: PROJECT_ID }];
          },
          task: {
            count: async (args: any) => {
              calls.push(`count:${JSON.stringify(args.where)}`);
              return tasks;
            },
            updateMany: async () => assert.fail('deleting a project must not write to any task'),
            deleteMany: async () => assert.fail('deleting a project must not delete any task'),
          },
          project: {
            delete: async () => {
              calls.push('deleteProject');
              return { id: PROJECT_ID };
            },
          },
        }),
    },
    calls,
  };
}

test('an empty project is deleted, under the lock that makes the count binding', async () => {
  const { prisma, calls } = removableProject(0);

  assert.deepEqual(await serviceWith(prisma).remove(OWNER_ID, PROJECT_ID), { ok: true });

  // The lock comes FIRST: inserting a task that references this project takes FOR KEY SHARE on
  // this row, which FOR UPDATE conflicts with, so nothing can be filed into the project between
  // the count and the delete. Counting first would make the check advisory.
  assert.deepEqual(calls, [
    'lock',
    `count:{"projectId":"${PROJECT_ID}"}`,
    'deleteProject',
  ]);
});

// The invariant this phase exists to protect: a task's project is what the task is FOR, so there
// is no version of "delete the project" that silently leaves the task without one.
test('a project that still holds tasks is refused, and the tasks keep their project', async () => {
  const { prisma, calls } = removableProject(7);

  await assert.rejects(
    () => serviceWith(prisma).remove(OWNER_ID, PROJECT_ID),
    (e: any) =>
      e.status === 409 && /still holds 7 task\(s\).*cannot be deleted/.test(e.message),
  );

  // Not deleted, and — because the refusal happens inside the transaction — nothing else written.
  assert.equal(calls.includes('deleteProject'), false);
});

// The row lock makes the application check binding; this is what happens to a writer that somehow
// gets past it anyway. The database's own RESTRICT answers, and it must answer with the SAME
// error — one race must not produce two different verdicts on the same question.
test('the database’s RESTRICT is reported as the same 409 the check raises', async () => {
  const service = serviceWith({
    $transaction: async (fn: any) =>
      fn({
        $queryRaw: async () => [{ id: PROJECT_ID }],
        // The count is honest at the moment it runs; the FK is not, a moment later.
        task: { count: async () => 0 },
        project: {
          delete: async () => {
            throw Object.assign(
              new PrismaClientKnownRequestError('Foreign key constraint failed', {
                code: 'P2003',
                clientVersion: 'test',
              }),
            );
          },
        },
      }),
  });

  await assert.rejects(
    () => service.remove(OWNER_ID, PROJECT_ID),
    (e: any) => e.status === 409 && /cannot be deleted/.test(e.message),
  );
});
