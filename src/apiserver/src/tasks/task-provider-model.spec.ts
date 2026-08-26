import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { TasksService } from './tasks.service';
import { fakeReceiptStore } from './task-run-receipt-fake';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * A task fixture whose run dispatch is observable: `execute` either resumes the task's latest
 * session or creates a new one, and these tests assert which of the two happened and what
 * provider/model travelled with it.
 */
function runFixture(
  task: { provider?: string | null; model?: string | null },
  latestSession?: { id: string; provider: string },
) {
  const createCalls: any[][] = [];
  const resumeCalls: any[][] = [];
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: {
      findFirst: async () => ({
        id: TASK_ID,
        title: 'Ship it',
        description: null,
        provider: null,
        model: null,
        ...task,
        // §13.1 AG6's two facts. Every task in this fixture is an ordinary leaf; the
        // aggregate-parent gate has its own coverage in `task-aggregate-parent-execute.spec.ts`.
        completionPolicy: 'MANUAL',
        children: [],
        assignee: { id: 'workspace-1', runnerId: 'runner-1' },
      }),
    },
    taskDependency: { findMany: async () => [] },
    // A paused run's delivery is read by its own turn key before it is written (H2F).
    conversationTurn: { findUnique: async () => null },
    session: {
      // The door reads THIS request's own Session by id before it writes (H2F).
      findUnique: async () => null,
      // Two reads in runWorkspaceOnTask, and BOTH now filter on status (§13.6 SU6): the mid-flight
      // dedup asks for PENDING/RUNNING, and the continue-this-run read asks for the two PAUSED
      // statuses. A terminal session is no longer a candidate to continue at all — a new attempt
      // gets a new Session and the old row stays readable as what it was — so the fixture's
      // "latest session" is a paused one, which is the only kind that can be continued.
      findFirst: async ({ where }: any) => {
        const wanted = where.status?.in ?? [];
        const paused = wanted.includes(RunStatus.AWAITING_INPUT);
        return paused ? (latestSession ?? null) : null;
      },
    },
  } as never;
  const sessions = {
    create: async (...args: any[]) => {
      createCalls.push(args);
      return { id: 'session-new' };
    },
    resume: async (...args: any[]) => {
      resumeCalls.push(args);
      return { turnId: 'turn-1', seq: 1 };
    },
  } as never;
  const service = new TasksService(prisma, sessions, {} as never);
  return { service, createCalls, resumeCalls };
}

test("a task with no provider/model pin dispatches nothing of its own — the run inherits the workspace's", async () => {
  const f = runFixture({});

  await f.service.execute('owner-1', TASK_ID);

  const dto = f.createCalls[0][1];
  assert.equal('provider' in dto, false);
  assert.equal('model' in dto, false);
});

test('a pinned provider and model travel to the session the task run creates', async () => {
  const f = runFixture({ provider: 'deepseek', model: 'deepseek-reasoner' });

  await f.service.execute('owner-1', TASK_ID);

  const dto = f.createCalls[0][1];
  assert.equal(dto.provider, 'deepseek');
  assert.equal(dto.model, 'deepseek-reasoner');
});

test('resuming the task\'s last session re-applies the pinned model', async () => {
  const f = runFixture({ provider: 'claude', model: 'claude-haiku-4-5' }, {
    id: 'session-old',
    provider: 'claude',
  });

  const result = await f.service.execute('owner-1', TASK_ID);

  assert.equal(result.sessionId, 'session-old');
  assert.equal(f.createCalls.length, 0);
  assert.equal(f.resumeCalls[0][2].model, 'claude-haiku-4-5');
});

test('re-pinning the provider while a run is paused is refused, not silently forked', async () => {
  // A session's provider is fixed for its lifetime, so continuing this one would keep running codex
  // forever and the re-pin would never take effect. Starting a SECOND session beside it is not the
  // answer either, and since 0130 it is not even possible: the paused run holds the task's
  // execution claim across all four live statuses, so the create would fail on a unique index and
  // reach the caller as a duplicate-key error. The honest answer is the reason.
  const f = runFixture({ provider: 'claude' }, { id: 'session-old', provider: 'codex' });

  await assert.rejects(
    () => f.service.execute('owner-1', TASK_ID),
    (error: Error) => /cannot change provider/.test(error.message),
  );
  assert.equal(f.resumeCalls.length, 0);
  assert.equal(f.createCalls.length, 0, 'and no second session beside the paused one');
});

test('an unpinned task still resumes its last session whatever provider that session runs', async () => {
  const f = runFixture({}, { id: 'session-old', provider: 'codex' });

  const result = await f.service.execute('owner-1', TASK_ID);

  assert.equal(result.sessionId, 'session-old');
  assert.equal('model' in f.resumeCalls[0][2], false);
});

/** update()'s three-state write: omitted keeps the pin, null clears it back to inheriting. */
function serviceForUpdate(prisma: unknown): TasksService {
  const service = new TasksService(prisma as never, {} as never, {
    publishForUser: () => undefined,
  } as never);
  (service as unknown as Record<string, unknown>).loadDetail = async () => ({
    id: TASK_ID,
    status: 'OPEN',
    creatorSessionId: null,
  });
  return service;
}

function updateFixture() {
  const writes: any[] = [];
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: {
      update: async ({ data }: any) => {
        writes.push(data);
        return { id: TASK_ID };
      },
    },
    modelProvider: { findFirst: async () => ({ slug: 'deepseek' }) },
  } as never;
  const service = serviceForUpdate(prisma);
  return { service, writes };
}

test('null clears a task\'s provider/model pin; omitting them leaves it alone', async () => {
  const cleared = updateFixture();
  await cleared.service.update('owner-1', TASK_ID, { provider: null, model: null });
  assert.equal(cleared.writes[0].provider, null);
  assert.equal(cleared.writes[0].model, null);

  const untouched = updateFixture();
  await untouched.service.update('owner-1', TASK_ID, { title: 'Renamed' });
  assert.equal(untouched.writes[0].provider, undefined);
  assert.equal(untouched.writes[0].model, undefined);
});

test('a provider the caller cannot dispatch with is rejected on the write, not at run time', async () => {
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: { update: async () => ({ id: TASK_ID }) },
    // No configured row matches, and the slug isn't a built-in engine either.
    modelProvider: { findFirst: async () => null },
  } as never;
  const service = serviceForUpdate(prisma);

  await assert.rejects(
    service.update('owner-1', TASK_ID, { provider: 'not-a-provider' }),
    /provider not available/,
  );
});

test('a built-in engine slug needs no configured provider row', async () => {
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: { update: async ({ data }: any) => ({ id: TASK_ID, ...data }) },
    modelProvider: {
      findFirst: async () => {
        throw new Error('built-in slugs must not reach the provider lookup');
      },
    },
  } as never;
  const service = serviceForUpdate(prisma);

  await service.update('owner-1', TASK_ID, { provider: 'kimi' });
});
