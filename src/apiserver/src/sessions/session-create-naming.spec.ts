import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_KNOWN_TAGS_PROMPTED } from './naming';
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

function deepSeekResponse(title: string, tags?: string[]): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ title, tags }) } }] }),
  } as Response;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

type TagRow = { id: string; name: string; color: string; position: number };

function makeService(
  enableWorktree = true,
  // The owner's tag library as it stands before this session is named, and how many tags the
  // session already carries (a person tagging it while DeepSeek was in flight).
  seed: { tags?: TagRow[]; existingLinks?: number } = {},
) {
  const creates: Array<Record<string, unknown>> = [];
  const updates: unknown[] = [];
  const realtimeEvents: string[] = [];
  const tags: TagRow[] = [...(seed.tags ?? [])];
  const tagLinks: { sessionId: string; tagId: string }[] = [];
  const tagEvents: string[] = [];
  const prisma = {
    workspace: {
      findFirst: async () => ({
        id: 'workspace-1',
        runnerId: 'runner-1',
        enableWorktree,
        permissionMode: null,
      }),
    },
    // The provider a new session inherits now comes from the project's last interactive run.
    $queryRaw: async () => [{ workspace_id: 'workspace-1', provider: 'codex', provider_builtin: true }],
    runner: { findFirst: async () => ({ id: 'runner-1' }) },
    // create() reads the owner's account-level permission default when the caller names none.
    user: { findUnique: async () => ({ preferences: {} }) },
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
    sessionTag: {
      // Two shapes: the reuse candidates (custom tags only, capped by `take`) and the read-back
      // of freshly created rows by name.
      findMany: async ({ where, take }: { where: { name?: { in: string[] } }; take?: number }) =>
        where.name?.in
          ? tags.filter((t) => where.name!.in.includes(t.name)).map((t) => ({ id: t.id }))
          : tags.slice(0, take).map((t) => ({ id: t.id, name: t.name })),
      aggregate: async () => ({
        _max: { position: tags.length ? Math.max(...tags.map((t) => t.position)) : null },
      }),
      createMany: async ({ data }: { data: Omit<TagRow, 'id'>[] }) => {
        // Mirrors skipDuplicates on the (ownerId, name) unique.
        const fresh = data.filter((d) => !tags.some((t) => t.name === d.name));
        tags.push(
          ...fresh.map((d, i) => ({
            id: `tag-new-${tags.length + i + 1}`,
            name: d.name,
            color: d.color,
            position: d.position,
          })),
        );
        return { count: fresh.length };
      },
    },
    sessionTagLink: {
      count: async () => seed.existingLinks ?? 0,
      createMany: async ({ data }: { data: { sessionId: string; tagId: string }[] }) => {
        tagLinks.push(...data);
        return { count: data.length };
      },
    },
  } as never;
  const queue = { notifySessionQueued: () => undefined } as never;
  const realtime = {
    publishSessionCreated: () => realtimeEvents.push('created'),
    publishSessionUpdated: () => realtimeEvents.push('updated'),
    // Not part of what this spec watches (see realtimeEvents): create() also refreshes the workspace
    // list, because a user-started session moves the project's provider default.
    publishWorkspaceChanged: () => undefined,
    publishForUser: (_ownerId: string, type: string) => tagEvents.push(type),
  } as never;

  return {
    service: new SessionsService(prisma, queue, realtime),
    creates,
    updates,
    realtimeEvents,
    tags,
    tagLinks,
    tagEvents,
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
      workspaceId: 'workspace-1',
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

test('a worktree-disabled workspace keeps a null branch', async () => {
  const fixture = makeService(false);
  await fixture.service.create('owner-1', {
    prompt: '请开始执行任务',
    title: 'Execute task',
    workspaceId: 'workspace-1',
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
      workspaceId: 'workspace-1',
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
        workspaceId: 'workspace-1',
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
    assert.deepEqual(fixture.tagLinks, []);
  } finally {
    if (resolveFetch) resolveFetch(deepSeekResponse('Cleanup title'));
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

/** Drive one unnamed create through its background naming pass and hand back the fixture. */
async function nameSession(
  fixture: ReturnType<typeof makeService>,
  response: Response,
  settled: () => boolean,
): Promise<void> {
  let resolveFetch: ((response: Response) => void) | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as typeof fetch;
  try {
    await withDeadline(
      fixture.service.create('owner-1', { prompt: 'Fix the login timeout', workspaceId: 'workspace-1' }),
    );
    await waitUntil(() => resolveFetch !== undefined, 'background DeepSeek request did not start');
    resolveFetch!(response);
    await waitUntil(settled, 'background tagging did not finish');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('auto-tagging reuses an existing tag instead of coining a near-duplicate', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const fixture = makeService(true, {
    tags: [{ id: 'tag-login', name: 'login', color: '#FF3B30', position: 7 }],
  });

  try {
    // The model echoes the candidate back in another case — one tag to a person, two rows under
    // the (owner, name) unique, so it must land on the row that already exists.
    await nameSession(fixture, deepSeekResponse('Fix login timeout', ['Login']), () => fixture.tagLinks.length > 0);

    assert.deepEqual(fixture.tagLinks, [{ sessionId: 'session-1', tagId: 'tag-login' }]);
    assert.equal(fixture.tags.length, 1);
    assert.deepEqual(fixture.tagEvents, []);
  } finally {
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('auto-tagging creates the tags the owner lacks and announces the new library', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const fixture = makeService(true, {
    tags: [{ id: 'tag-auth', name: 'auth', color: '#FF3B30', position: 7 }],
  });

  try {
    await nameSession(
      fixture,
      deepSeekResponse('Fix login timeout', ['auth', 'timeout']),
      () => fixture.tagLinks.length === 2,
    );

    assert.deepEqual(fixture.tagLinks, [
      { sessionId: 'session-1', tagId: 'tag-auth' },
      { sessionId: 'session-1', tagId: 'tag-new-2' },
    ]);
    // Positions continue past the system block; colors cycle the shared palette.
    assert.deepEqual(fixture.tags[1], {
      id: 'tag-new-2',
      name: 'timeout',
      color: '#FF9500',
      position: 8,
    });
    assert.deepEqual(fixture.tagEvents, ['tag_changed']);
    assert.deepEqual(fixture.realtimeEvents, ['created', 'updated']);
  } finally {
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('auto-tagging leaves a hand-tagged session alone but still fixes its title', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const fixture = makeService(true, { existingLinks: 1 });

  try {
    await nameSession(
      fixture,
      deepSeekResponse('Fix login timeout', ['auth']),
      () => fixture.updates.length === 1,
    );

    assert.deepEqual(fixture.tagLinks, []);
    assert.deepEqual(fixture.tags, []);
    assert.equal((fixture.updates[0] as { data: { title: string } }).data.title, 'Fix login timeout');
  } finally {
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('a library at the ceiling stops growing but still files the session under known tags', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const full = Array.from({ length: MAX_KNOWN_TAGS_PROMPTED }, (_, i) => ({
    id: `tag-${i}`,
    name: `tag-${i}`,
    color: '#FF3B30',
    position: 7 + i,
  }));
  const fixture = makeService(true, { tags: full });

  try {
    await nameSession(
      fixture,
      deepSeekResponse('Fix login timeout', ['tag-3', 'brand-new']),
      () => fixture.tagLinks.length > 0,
    );

    assert.deepEqual(fixture.tagLinks, [{ sessionId: 'session-1', tagId: 'tag-3' }]);
    assert.equal(fixture.tags.length, MAX_KNOWN_TAGS_PROMPTED);
  } finally {
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});
