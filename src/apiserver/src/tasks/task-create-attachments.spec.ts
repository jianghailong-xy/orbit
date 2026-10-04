import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationPipe } from '@nestjs/common';
import { uuidToBase62 } from '@orbit/shared';
import { CreateTaskDto, CreateTasksBatchDto } from './dto';
import { TasksService } from './tasks.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const INPUT = '33333333-3333-4333-8333-333333333333';
const SECOND = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const TURN = '66666666-6666-4666-8666-666666666666';

const taskInput = (title = 'implement the mock', attachmentIds?: string[]): CreateTaskDto => ({
  title, attachmentIds, completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
});

function fixture(options: { disappear?: boolean; failCopy?: boolean } = {}) {
  const source = {
    id: INPUT, ownerId: OWNER, sessionId: SESSION, turnId: TURN, taskId: null,
    fileName: 'mock.png', mimeType: 'image/png', sizeBytes: 3, data: Buffer.from('png'),
  };
  const sources = [source, { ...source, id: SECOND, ownerId: OTHER }];
  const tasks: any[] = [];
  const copies: any[] = [];
  const counts: unknown[] = [];
  let transactions = 0;
  const matches = (where: { ownerId: string; id: { in: string[] } }) => sources.filter(
    (row) => row.ownerId === where.ownerId && where.id.in.includes(row.id),
  );
  const task = {
    findUnique: async ({ where }: any) => tasks.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null,
    findMany: async () => [],
  };
  const tx = {
    $queryRaw: async () => [],
    task: {
      ...task,
      create: async ({ data }: any) => {
        const row = { id: `task-${tasks.length}`, ...data };
        tasks.push(row);
        return row;
      },
    },
    attachment: {
      findMany: async ({ where }: any) => options.disappear ? [] : matches(where),
      create: async ({ data }: any) => {
        if (options.failCopy) throw new Error('copy failed');
        const row = { id: `copy-${copies.length}`, ...data };
        copies.push(row);
        return row;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
      transactions += 1;
      const taskCount = tasks.length;
      const copyCount = copies.length;
      try { return await fn(tx); }
      catch (error) {
        tasks.length = taskCount;
        copies.length = copyCount;
        throw error;
      }
    },
    $queryRaw: async () => [],
    task,
    attachment: {
      count: async ({ where }: any) => { counts.push(where); return matches(where).length; },
    },
    workspace: { findMany: async () => [] },
    taskList: { findMany: async () => [] },
    modelProvider: { findMany: async () => [] },
    project: { findFirst: async () => null, findMany: async () => [] },
    session: {
      findFirst: async () => ({ id: SESSION, taskId: null, task: null, coordinatorForProject: null }),
    },
    conversationTurn: { findFirst: async () => ({ id: TURN }) },
  };
  const service = new TasksService(prisma as never, {} as never, {
    publishForUser: () => {}, publishTaskChanged: () => {},
  } as never);
  return { service, tasks, copies, source, counts, transactions: () => transactions };
}

test('task create DTOs preserve and normalize attachment IDs and reject a non-array', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  const input = taskInput('mock', [uuidToBase62(INPUT)]);
  const single = await pipe.transform(input, { type: 'body', metatype: CreateTaskDto });
  assert.deepEqual(single.attachmentIds, [INPUT]);
  const batch = await pipe.transform({ tasks: [input] }, { type: 'body', metatype: CreateTasksBatchDto });
  assert.deepEqual(batch.tasks[0].attachmentIds, [INPUT]);
  await assert.rejects(pipe.transform(
    { ...input, attachmentIds: INPUT }, { type: 'body', metatype: CreateTaskDto },
  ));
});

test('single create copies each input once into task scope and leaves conversation sources intact', async () => {
  const f = fixture();
  const created = await f.service.create(OWNER, taskInput('mock', [INPUT, INPUT]));
  assert.equal(f.copies.length, 1);
  const copy = f.copies[0];
  assert.equal(copy.taskId, created.id);
  assert.equal(copy.ownerId, OWNER);
  assert.equal(copy.fileName, f.source.fileName);
  assert.equal(copy.mimeType, f.source.mimeType);
  assert.equal(copy.sizeBytes, f.source.sizeBytes);
  assert.deepEqual(copy.data, f.source.data);
  assert.equal(copy.sessionId, undefined);
  assert.equal(copy.turnId, undefined);
  assert.equal(f.source.sessionId, SESSION);
  assert.equal(f.source.turnId, TURN);
  assert.equal(f.source.taskId, null);
  assert.deepEqual(f.counts, [{ ownerId: OWNER, id: { in: [INPUT] } }]);
});

test('batch create can reuse one input across tasks with independent copies', async () => {
  const f = fixture();
  const rows = await f.service.createMany(OWNER, {
    tasks: [taskInput('first', [INPUT]), taskInput('second', [INPUT])],
  });
  assert.deepEqual(f.copies.map((row) => row.taskId), rows.map((row) => row.id));
  assert.notEqual(f.copies[0].id, f.copies[1].id);
});

test('missing and foreign attachments reject single, batch and preview before any write', async () => {
  for (const id of [SECOND, TURN]) {
    for (const mode of ['single', 'batch', 'preview', 'card'] as const) {
      const f = fixture();
      const item = taskInput('mock', [id]);
      const run = () => mode === 'single' ? f.service.create(OWNER, item)
        : mode === 'batch' ? f.service.createMany(OWNER, { tasks: [taskInput('first'), item] })
          : mode === 'preview' ? f.service.previewPlan(OWNER, { tasks: [item] })
            : f.service.previewCreateMany(OWNER, { tasks: [item] });
      await assert.rejects(run, /attachment not found/);
      assert.deepEqual(f.tasks, []);
      assert.deepEqual(f.copies, []);
      assert.equal(f.transactions(), 0);
    }
  }
});

test('a dry run validates existing attachments without copying their bytes or writing tasks', async () => {
  const f = fixture();
  await f.service.previewPlan(OWNER, { tasks: [taskInput('mock', [INPUT])] });
  assert.equal(f.counts.length, 1);
  assert.equal(f.transactions(), 0);
  assert.deepEqual(f.tasks, []);
  assert.deepEqual(f.copies, []);
});

test('deleted sources and failed copies roll back the entire task creation', async () => {
  for (const options of [{ disappear: true }, { failCopy: true }]) {
    for (const batch of [false, true]) {
      const f = fixture(options);
      const item = taskInput('mock', [INPUT]);
      await assert.rejects(() => batch
        ? f.service.createMany(OWNER, { tasks: [taskInput('first'), item] })
        : f.service.create(OWNER, item));
      assert.equal(f.transactions(), 1);
      assert.deepEqual(f.tasks, []);
      assert.deepEqual(f.copies, []);
    }
  }
});

test('replayed single and batch creates do not duplicate task attachment copies', async () => {
  for (const batch of [false, true]) {
    const f = fixture();
    const item = taskInput('mock', [INPUT]);
    const run = () => batch
      ? f.service.createMany(OWNER, { tasks: [item] }, undefined, SESSION)
      : f.service.create(OWNER, item, undefined, SESSION);
    await run();
    await run();
    assert.equal(f.tasks.length, 1);
    assert.equal(f.copies.length, 1);
  }
});
