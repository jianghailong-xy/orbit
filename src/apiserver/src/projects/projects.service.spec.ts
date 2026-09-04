import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { ProjectStatus, uuidToBase62 } from '@orbit/shared';
import { criterionKeyOf } from './project-acceptance';
import { ProjectsService } from './projects.service';

const { PrismaClientKnownRequestError } = Prisma;

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const PROJECT_ID = '00000000-0000-7000-8000-0000000000a1';
const CRITERION_A_ID = '00000000-0000-7000-8000-0000000000b1';
const CRITERION_B_ID = '00000000-0000-7000-8000-0000000000b2';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

// The acceptance service is a stub: since 0229 nothing on ProjectsService's read paths calls into
// it, and no test in this file is about the merge-evidence write that remains on it.
function serviceWith(prisma: unknown): ProjectsService {
  return new ProjectsService(prisma as never, {} as never);
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
    // Whitespace is not an instruction. Stored as null so "not set" has one representation.
    instructions: '   ',
  } as never);

  assert.equal(created.ownerId, OWNER_ID);
  assert.equal(created.title, 'Ship the coordinator');
  assert.equal(created.goal, 'A project can be driven end to end');
  assert.equal(created.instructions, null);
  // 0229 removed the legacy text column and the marker beside it; neither is written any more.
  assert.equal(created.acceptanceCriteria, undefined);
  assert.equal(created.acceptanceCriteriaFormat, undefined);
});

test('create stores explicit assertions and required methods', async () => {
  let created: any;
  const definitions: any[] = [];
  const prisma: any = {
    project: {
      create: async (args: any) => {
        created = args.data;
        return {
          id: PROJECT_ID, ...args.data, acceptanceCriterionDefinitions: [],
          members: [], runtime: { coordinatorGeneration: 0n },
        };
      },
      // The re-read a structured create makes once its definitions are written.
      findUniqueOrThrow: async () => ({
        id: PROJECT_ID,
        ...created,
        acceptanceCriterionDefinitions: definitions,
        members: [],
        runtime: { coordinatorGeneration: 0n },
      }),
    },
    projectAcceptanceCriterionDefinition: {
      findMany: async () => [],
      updateMany: async () => undefined,
      deleteMany: async () => undefined,
      create: async ({ data }: any) => { definitions.push(data); },
    },
  };
  prisma.$transaction = async (fn: any) => fn(prisma);
  const service = serviceWith(prisma);

  const project: any = await service.create(OWNER_ID, {
    title: 'Structured',
    acceptanceCriteriaItems: [
      {
        text: '  the image boots  ',
        verificationMethod: ' Run the image smoke test ',
        completionCriterionOverrideReason: 'A person judges the visible product behaviour',
      },
      {
        text: 'the full suite passes',
        verificationMethod: 'Run npm test; require exit code 0',
        completionCriterionOverrideReason: 'This fixture exercises structured persistence',
      },
    ],
  } as never);

  assert.deepEqual(definitions.map(({ id: _id, projectId: _projectId, contentHash: _hash, ...row }) => row), [
    {
      ordinal: 1,
      text: 'the image boots',
      verificationMethod: 'Run the image smoke test',
      completionCriterionOverrideReason: 'A person judges the visible product behaviour',
      revision: 1,
    },
    {
      ordinal: 2,
      text: 'the full suite passes',
      verificationMethod: 'Run npm test; require exit code 0',
      completionCriterionOverrideReason: 'This fixture exercises structured persistence',
      revision: 1,
    },
  ]);
  assert.deepEqual(project.acceptanceCriteriaItems.map((item: any) => ({
    text: item.text,
    verificationMethod: item.verificationMethod,
  })), [
    { text: 'the image boots', verificationMethod: 'Run the image smoke test' },
    { text: 'the full suite passes', verificationMethod: 'Run npm test; require exit code 0' },
  ]);
});

test('the service refuses structured input with no verification method before writing', async () => {
  const service = serviceWith({ project: { create: async () => assert.fail('must not insert') } });
  await assert.rejects(
    () => service.create(OWNER_ID, {
      title: 'Incomplete',
      acceptanceCriteriaItems: [{ text: 'the suite passes' }],
    } as never),
    /requires a verificationMethod/,
  );
});

test('create refuses a null acceptanceCriteriaItems rather than reading it as a clear', async () => {
  const service = serviceWith({ project: { create: async () => assert.fail('must not insert') } });
  await assert.rejects(
    () => service.create(OWNER_ID, {
      title: 'Ambiguous',
      acceptanceCriteriaItems: null,
    } as never),
    /must be an array/,
  );
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
  let rawQueries = 0;
  const service = serviceWith({
    project: {
      findMany: async (args: any) => {
        queries.push(args);
        return [];
      },
    },
    $queryRaw: async () => {
      rawQueries += 1;
      return [];
    },
  });

  await service.list(OWNER_ID);
  await service.list(OWNER_ID, ProjectStatus.DONE as never);

  assert.deepEqual(queries[0].where, { ownerId: OWNER_ID });
  assert.deepEqual(queries[0].orderBy, { createdAt: 'desc' });
  // Counted, not embedded: `GET /task-lists/:id` embeds its tasks and had to grow an escape
  // hatch when one list reached 27k of them. The two coordination rows are bounded the same way —
  // at most one apiece, joined by their own key — and are folded into two fields on the way out.
  assert.deepEqual(queries[0].select, {
    id: true,
    title: true,
    status: true,
    goal: true,
    createdAt: true,
    updatedAt: true,
    members: { where: { role: 'COORDINATOR' }, select: { agentId: true } },
    runtime: { select: { coordinatorGeneration: true } },
  });
  assert.equal(queries[0].include, undefined);
  assert.deepEqual(queries[1].where, { ownerId: OWNER_ID, status: 'DONE' });
  // An empty page has no task or blocker groups to discover.
  assert.equal(rawQueries, 0);
});

// The one claim a fake Prisma can settle about the buckets: what they COST. Their values are
// SQL and are checked against a real server, and against the project page's own numbers, in
// project-list-rollup.pg.spec.ts.
test('the index buckets every project in one aggregate, not one query per project', async () => {
  const listed = ['a1', 'b2', 'c3'].map((id) => ({
    id,
    members: [],
    runtime: { coordinatorGeneration: 0n },
  }));
  let rawQueries = 0;
  const service = serviceWith({
    project: { findMany: async () => listed },
    $queryRaw: async (...args: unknown[]) => {
      rawQueries += 1;
      if (rawQueries === 2) {
        return [{
          projectId: 'a1',
          userBlockers: 2,
          coordinatorBlockers: 1,
          systemBlockers: 0,
          maxSeverity: 'CRITICAL',
          attentionSinceAt: new Date('2026-07-31T00:00:00.000Z'),
          nextCheckAt: new Date('2026-08-01T01:00:00.000Z'),
        }];
      }
      // Two of the three projects grouped; `c3` has no tasks and so has no row here at all.
      return [
        { projectId: 'a1', taskCount: 15, running: 1, ready: 2, blocked: 3,
          awaitingVerification: 0, done: 4, failed: 0, cancelled: 5,
          lastActivityAt: new Date('2026-08-01T00:00:00.000Z') },
        { projectId: 'b2', taskCount: 9, running: 0, ready: 0, blocked: 0,
          awaitingVerification: 0, done: 9, failed: 0, cancelled: 0,
          lastActivityAt: new Date('2026-08-02T00:00:00.000Z') },
      ];
    },
  });

  const rows: any[] = await service.list(OWNER_ID);

  // Two page-wide overlays: the task rollup and open blockers. Neither grows with the number of
  // projects.
  assert.equal(rawQueries, 2);
  assert.deepEqual(rows[0].buckets, {
    running: 1, ready: 2, blocked: 3, awaitingVerification: 0, done: 4, failed: 0, cancelled: 5,
  });
  assert.deepEqual(rows[0].lastActivityAt, new Date('2026-08-01T00:00:00.000Z'));
  // A project the aggregate had nothing to say about is seven zeroes and no activity, never a row
  // missing the fields: one shape for every element, so no client has to handle two.
  assert.deepEqual(rows[2].buckets, {
    running: 0, ready: 0, blocked: 0, awaitingVerification: 0, done: 0, failed: 0, cancelled: 0,
  });
  assert.equal(rows[2].lastActivityAt, null);
  assert.deepEqual(rows[0].attention, {
    userBlockers: 2,
    coordinatorBlockers: 1,
    systemBlockers: 0,
    maxSeverity: 'CRITICAL',
    attentionSinceAt: new Date('2026-07-31T00:00:00.000Z'),
    nextCheckAt: new Date('2026-08-01T01:00:00.000Z'),
  });
  assert.deepEqual(rows[2].attention, {
    userBlockers: 0,
    coordinatorBlockers: 0,
    systemBlockers: 0,
    maxSeverity: null,
    attentionSinceAt: null,
    nextCheckAt: null,
  });
  // The established tally shape is kept, now sourced from the same aggregate. The missing group
  // for c3 means it has no tasks, so its explicit total is zero.
  assert.deepEqual(rows.map((row) => row._count.tasks), [15, 9, 0]);
});

test('concurrent identical project indexes share one aggregate without caching it', async () => {
  const found = deferred<any[]>();
  let projectReads = 0;
  let aggregateReads = 0;
  const service = serviceWith({
    project: {
      findMany: async () => {
        projectReads += 1;
        return found.promise;
      },
    },
    $queryRaw: async () => {
      aggregateReads += 1;
      return [];
    },
  });

  const first = service.list(OWNER_ID, ProjectStatus.OPEN as never);
  const second = service.list(OWNER_ID, ProjectStatus.OPEN as never);

  assert.equal(first, second, 'both callers share the exact in-flight promise');
  assert.equal(projectReads, 1);
  found.resolve([{ id: PROJECT_ID, members: [], runtime: { coordinatorGeneration: 0n } }]);
  await Promise.all([first, second]);
  assert.equal(
    aggregateReads,
    2,
    'one task rollup and one blocker rollup for both callers',
  );

  await service.list(OWNER_ID, ProjectStatus.OPEN as never);
  assert.equal(projectReads, 2, 'settlement removes the promise; the next request reads fresh state');
  assert.equal(aggregateReads, 4);
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
  });

  const project = await service.get(OWNER_ID, PROJECT_ID);

  assert.deepEqual(project.tasksByStatus, { DONE: 2, OPEN: 1 });
  assert.equal(project._count.tasks, 3);
  assert.deepEqual(groupByArgs.where, { projectId: PROJECT_ID });
  // The task tally is a PROCESS measure and it is the only one left: migration 0229 removed the
  // acceptance judgment, so nothing on this read concludes anything about the stated criteria.
  assert.equal('acceptance' in project, false,
    'a standing that would always read the same thing is not a standing');
});

test('the detail read serves the authored criteria and no second representation of them', async () => {
  const text = '项目完成时：1. build； 2. boot';
  const service = serviceWith({
    project: {
      findFirst: async () => ({
        id: PROJECT_ID,
        title: 'LFS',
        acceptanceCriterionDefinitions: [{
          id: CRITERION_A_ID,
          ordinal: 1,
          text,
          verificationMethod: 'Human review against direct evidence for this migrated criterion',
          revision: 1,
          contentHash: 'a'.repeat(64),
        }],
        _count: { tasks: 0 },
        members: [],
        runtime: { coordinatorGeneration: 0n },
      }),
    },
    task: { groupBy: async () => [] },
  });

  const project: any = await service.get(OWNER_ID, PROJECT_ID);

  assert.deepEqual(project.acceptanceCriteriaItems.map((item: any) => item.text), [text]);
  // 0229 removed the legacy text column, its LEGACY_TEXT/STRUCTURED marker and the ambiguity
  // review that existed to warn about a parse. There is one representation now, so there is
  // nothing for a second one to disagree with.
  assert.equal('acceptanceCriteriaMigration' in project, false);
  assert.equal('acceptanceCriteria' in project, false);
  assert.equal('acceptanceCriteriaFormat' in project, false);
});

test('the detail item is the authored declaration, with no derived verdict beside it', async () => {
  const definition = {
    id: CRITERION_A_ID,
    ordinal: 1,
    text: 'the suite passes',
    verificationMethod: 'Run npm test and require exit code 0',
    completionCriterionOverrideReason: null,
    revision: 2,
    contentHash: 'a'.repeat(64),
  };
  const service = serviceWith({
    project: {
      findFirst: async () => ({
        id: PROJECT_ID,
        acceptanceCriterionDefinitions: [definition],
        _count: { tasks: 0 },
        members: [],
        runtime: { coordinatorGeneration: 0n },
      }),
    },
    task: { groupBy: async () => [] },
  });

  const project: any = await service.get(OWNER_ID, PROJECT_ID);

  // Exactly the stored row, plus the one thing the projection derives: `key`, the name a caller
  // uses for this criterion, which is its own id and not a reading of its text. `currentStatus`
  // was a projection over acceptance conclusions, and 0229 removed those: reporting a constant
  // 'UNDECIDED' forever would be a verdict pretending to be a reading.
  assert.deepEqual(project.acceptanceCriteriaItems[0],
    { ...definition, key: criterionKeyOf(CRITERION_A_ID) });
  assert.equal(project.acceptanceCriteriaItems[0].key, uuidToBase62(CRITERION_A_ID));
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

  // Settling a project must not blank the goal that says what it was for. Since 0229 DONE is an
  // ordinary field write too — it is asserted separately, in the removal suites.
  await service.update(OWNER_ID, PROJECT_ID, { status: ProjectStatus.CANCELLED } as never);
  assert.deepEqual(writes[0], { status: 'CANCELLED' });

  await service.update(OWNER_ID, PROJECT_ID, { goal: null, title: 'Renamed' } as never);
  assert.deepEqual(writes[1], { title: 'Renamed', goal: null });
});

test('a structured update preserves ids and revisions across reorder, and increments only an edit', async () => {
  const definitionWrites: any[] = [];
  const projectWrites: any[] = [];
  const finalDefinitions = [
    {
      id: CRITERION_B_ID, ordinal: 1, text: 'Image boots', verificationMethod: 'Smoke the image',
      completionCriterionOverrideReason: 'A person judges the visible product behaviour',
      revision: 1, contentHash: 'b'.repeat(64),
    },
    {
      id: CRITERION_A_ID, ordinal: 2, text: 'Build with docs', verificationMethod: 'Run npm test',
      completionCriterionOverrideReason: 'This fixture exercises structured persistence',
      revision: 3, contentHash: 'a'.repeat(64),
    },
  ];
  const prisma: any = {
    project: {
      findFirst: async () => ({ id: PROJECT_ID, coordinatorEnabled: false }),
      update: async (args: any) => {
        projectWrites.push(args.data);
        if (args.include) {
          return {
            id: PROJECT_ID,
            status: 'OPEN',
            acceptanceCriterionDefinitions: finalDefinitions,
            members: [],
            runtime: { coordinatorGeneration: 0n },
          };
        }
        return { id: PROJECT_ID };
      },
    },
    projectAcceptanceCriterionDefinition: {
      findMany: async () => [
        {
          id: CRITERION_A_ID, text: 'Build succeeds', verificationMethod: 'Run npm test',
          completionCriterionOverrideReason: 'This fixture exercises structured persistence',
          revision: 2,
        },
        {
          id: CRITERION_B_ID, text: 'Image boots', verificationMethod: 'Smoke the image',
          completionCriterionOverrideReason: 'A person judges the visible product behaviour',
          revision: 1,
        },
      ],
      updateMany: async (args: any) => definitionWrites.push(['vacate', args.data]),
      deleteMany: async (args: any) => definitionWrites.push(['delete', args.where]),
      update: async (args: any) => definitionWrites.push(['update', args.where.id, args.data]),
      create: async () => assert.fail('retained ids must not create replacement definitions'),
    },
    $queryRaw: async () => [{
      coordinator_enabled: false,
      config_revision: 0n,
      status: 'OPEN',
    }],
  };
  prisma.$transaction = async (fn: any) => fn(prisma);

  const updated: any = await serviceWith(prisma).update(OWNER_ID, PROJECT_ID, {
    acceptanceCriteriaItems: [
      {
        id: CRITERION_B_ID, text: 'Image boots', verificationMethod: 'Smoke the image',
        completionCriterionOverrideReason: 'A person judges the visible product behaviour',
      },
      {
        id: CRITERION_A_ID, text: 'Build with docs', verificationMethod: 'Run npm test',
        completionCriterionOverrideReason: 'This fixture exercises structured persistence',
      },
    ],
  } as never);

  // One project write, and it carries no criteria: 0229 removed the compatibility text column and
  // its format marker, so a criteria edit writes the definition rows and nothing on `project`.
  assert.equal(projectWrites.length, 1);
  assert.deepEqual(projectWrites[0], {});
  assert.deepEqual(definitionWrites[2], ['update', CRITERION_B_ID, {
    ordinal: 1,
    text: 'Image boots',
    verificationMethod: 'Smoke the image',
    completionCriterionOverrideReason: 'A person judges the visible product behaviour',
    contentHash: definitionWrites[2][2].contentHash,
    revision: 1,
  }]);
  assert.deepEqual(definitionWrites[3], ['update', CRITERION_A_ID, {
    ordinal: 2,
    text: 'Build with docs',
    verificationMethod: 'Run npm test',
    completionCriterionOverrideReason: 'This fixture exercises structured persistence',
    contentHash: definitionWrites[3][2].contentHash,
    revision: 3,
  }]);
  assert.deepEqual(updated.acceptanceCriteriaItems.map((item: any) => ({
    id: item.id, ordinal: item.ordinal, text: item.text,
    verificationMethod: item.verificationMethod,
    completionCriterionOverrideReason: item.completionCriterionOverrideReason,
    revision: item.revision,
  })), finalDefinitions.map(({ contentHash: _contentHash, ...item }) => item));
  // And the four fields migration 0233 removed are absent from the projection, rather than
  // present and null: a null would still be the criterion saying something about the work.
  for (const item of updated.acceptanceCriteriaItems) {
    for (const gone of ['completionCriterion', 'acceptanceCommand',
      'acceptanceExpectedExitCode', 'evidenceTaskId']) {
      assert.equal(gone in item, false, `${gone} is still projected onto a criterion`);
    }
  }
  // No derived status beside the declaration: 0229 removed what would have derived one.
  for (const item of updated.acceptanceCriteriaItems) {
    assert.equal('currentStatus' in item, false);
  }
});

test('a structured update refuses an id from another project before moving any definition', async () => {
  let mutated = false;
  const prisma: any = {
    project: {
      findFirst: async () => ({ id: PROJECT_ID, coordinatorEnabled: false }),
    },
    projectAcceptanceCriterionDefinition: {
      findMany: async () => [{
        id: CRITERION_A_ID, text: 'Build succeeds', verificationMethod: 'Run npm test', revision: 1,
      }],
      updateMany: async () => { mutated = true; },
      deleteMany: async () => { mutated = true; },
      update: async () => { mutated = true; },
      create: async () => { mutated = true; },
    },
    $queryRaw: async () => [{
      coordinator_enabled: false,
      config_revision: 0n,
      status: 'OPEN',
    }],
  };
  prisma.$transaction = async (fn: any) => fn(prisma);

  await assert.rejects(
    () => serviceWith(prisma).update(OWNER_ID, PROJECT_ID, {
      acceptanceCriteriaItems: [{
        id: CRITERION_B_ID, text: 'Not ours', verificationMethod: 'Run npm test',
      }],
    } as never),
    /does not belong to this project's current definitions/,
  );
  assert.equal(mutated, false);
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
