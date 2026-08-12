import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionsService } from './sessions.service';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('operation missed its deadline')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function deepSeekResponse(title: string): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ title }) } }] }),
  } as Response;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makeService(enableWorktree = true) {
  const creates: Array<Record<string, unknown>> = [];
  const updates: unknown[] = [];
  const realtimeEvents: string[] = [];
  const prisma = {
    agent: {
      findFirst: async () => ({
        id: 'agent-1',
        runnerId: 'runner-1',
        enableWorktree,
        permissionMode: null,
      }),
    },
    // The provider a new session inherits now comes from the project's last interactive run.
    $queryRaw: async () => [{ agent_id: 'agent-1', provider: 'codex', provider_builtin: true }],
    runner: { findFirst: async () => ({ id: 'runner-1' }) },
    task: { findFirst: async () => ({ id: 'task-1' }) },
    session: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return {
          id: `session-${creates.length}`,
          ...data,
          endReason: null,
          completedAt: null,
          archivedAt: null,
          deletedAt: null,
        };
      },
      updateMany: async (args: unknown) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  } as never;
  const queue = { notifySessionQueued: () => undefined } as never;
  const realtime = {
    publishSessionCreated: () => realtimeEvents.push('created'),
    publishSessionUpdated: () => realtimeEvents.push('updated'),
  } as never;

  return {
    service: new SessionsService(prisma, queue, realtime),
    creates,
    updates,
    realtimeEvents,
  };
}

test('an explicit title creates synchronously without calling DeepSeek', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let fetchCalls = 0;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error('DeepSeek must not run for an explicit title');
  }) as typeof fetch;

  try {
    const fixture = makeService();
    await fixture.service.create('owner-1', {
      prompt: '请开始执行任务',
      title: 'Execute task: Shipping fix',
      agentId: 'agent-1',
      taskId: 'task-1',
    });

    assert.equal(fetchCalls, 0);
    assert.equal(fixture.creates[0].title, 'Execute task: Shipping fix');
    assert.match(
      fixture.creates[0].branch as string,
      /^orbit\/execute-task-shipping-fix-[a-f0-9]{6}$/,
    );
    assert.deepEqual(fixture.updates, []);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('a worktree-disabled agent keeps a null branch', async () => {
  const fixture = makeService(false);
  await fixture.service.create('owner-1', {
    prompt: '请开始执行任务',
    title: 'Execute task',
    agentId: 'agent-1',
  });

  assert.equal(fixture.creates[0].branch, null);
});

test('a runtime null title is treated as omitted instead of failing branch creation', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const fixture = makeService();
    await fixture.service.create('owner-1', {
      prompt: 'Fix the login timeout',
      title: null as unknown as string,
      agentId: 'agent-1',
    });

    assert.equal(fixture.creates[0].title, 'Fix the login timeout');
    assert.match(
      fixture.creates[0].branch as string,
      /^orbit\/fix-the-login-timeout-[a-f0-9]{6}$/,
    );
  } finally {
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('an unnamed session returns its fallback immediately and only beautifies its title later', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let resolveFetch: ((response: Response) => void) | undefined;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as typeof fetch;
  const fixture = makeService();

  try {
    const session = await withDeadline(
      fixture.service.create('owner-1', {
        prompt: '\n  修复登录超时  \n更多详情',
        agentId: 'agent-1',
      }),
    );
    await waitUntil(() => resolveFetch !== undefined, 'background DeepSeek request did not start');

    assert.equal(session.title, '修复登录超时');
    assert.equal(fixture.creates[0].title, '修复登录超时');
    assert.match(fixture.creates[0].branch as string, /^orbit\/session-[a-f0-9]{6}$/);
    assert.deepEqual(fixture.updates, []);

    resolveFetch!(deepSeekResponse('修复登录超时问题'));
    await waitUntil(() => fixture.updates.length === 1, 'background title update did not finish');

    assert.deepEqual(fixture.updates[0], {
      where: { id: 'session-1', title: '修复登录超时' },
      data: { title: '修复登录超时问题' },
    });
    assert.equal('branch' in (fixture.updates[0] as { data: object }).data, false);
    assert.deepEqual(fixture.realtimeEvents, ['created', 'updated']);
  } finally {
    if (resolveFetch) resolveFetch(deepSeekResponse('Cleanup title'));
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});
