import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService } from './tasks.service';

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
    task: {
      findFirst: async () => ({
        id: TASK_ID,
        title: 'Ship it',
        description: null,
        provider: null,
        model: null,
        ...task,
        assignee: { id: 'workspace-1', runnerId: 'runner-1' },
      }),
    },
    taskDependency: { findMany: async () => [] },
    session: {
      // Two reads in runWorkspaceOnTask: the mid-flight dedup (filters on status) and the
      // most-recent session for this task+workspace (doesn't).
      findFirst: async ({ where }: any) => (where.status ? null : (latestSession ?? null)),
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

test('re-pinning the provider starts a fresh session instead of continuing the old one', async () => {
  // A session's provider is fixed for its lifetime, so resuming would keep running codex
  // forever and the re-pin would silently never take effect.
  const f = runFixture({ provider: 'claude' }, { id: 'session-old', provider: 'codex' });

  const result = await f.service.execute('owner-1', TASK_ID);

  assert.equal(f.resumeCalls.length, 0);
  assert.equal(result.sessionId, 'session-new');
  assert.equal(f.createCalls[0][1].provider, 'claude');
});

test('an unpinned task still resumes its last session whatever provider that session runs', async () => {
  const f = runFixture({}, { id: 'session-old', provider: 'codex' });

  const result = await f.service.execute('owner-1', TASK_ID);

  assert.equal(result.sessionId, 'session-old');
  assert.equal('model' in f.resumeCalls[0][2], false);
});

/** update()'s three-state write: omitted keeps the pin, null clears it back to inheriting. */
function updateFixture() {
  const writes: any[] = [];
  const prisma = {
    task: {
      update: async ({ data }: any) => {
        writes.push(data);
        return { id: TASK_ID };
      },
    },
    modelProvider: { findFirst: async () => ({ slug: 'deepseek' }) },
  } as never;
  const service = new TasksService(prisma, {} as never, {} as never);
  (service as any).get = async () => ({ id: TASK_ID, status: 'OPEN', creatorSessionId: null });
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
    task: { update: async () => ({ id: TASK_ID }) },
    // No configured row matches, and the slug isn't a built-in engine either.
    modelProvider: { findFirst: async () => null },
  } as never;
  const service = new TasksService(prisma, {} as never, {} as never);
  (service as any).get = async () => ({ id: TASK_ID, status: 'OPEN', creatorSessionId: null });

  await assert.rejects(
    service.update('owner-1', TASK_ID, { provider: 'not-a-provider' }),
    /provider not available/,
  );
});

test('a built-in engine slug needs no configured provider row', async () => {
  const prisma = {
    task: { update: async ({ data }: any) => ({ id: TASK_ID, ...data }) },
    modelProvider: {
      findFirst: async () => {
        throw new Error('built-in slugs must not reach the provider lookup');
      },
    },
  } as never;
  const service = new TasksService(prisma, {} as never, {} as never);
  (service as any).get = async () => ({ id: TASK_ID, status: 'OPEN', creatorSessionId: null });

  await service.update('owner-1', TASK_ID, { provider: 'kimi' });
});
