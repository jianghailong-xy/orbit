import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionsService } from './sessions.service';

/**
 * The New Session provider picker sends its choice as `CreateSessionDto.provider`. The session row
 * is the only place dispatch reads it from, so the override has to land there — and it has to be
 * checked, since the slug arrives from the client. Without one, the session starts on whatever the
 * project last ran interactively (agents/agent-provider.ts); `lastProvider` is that history.
 */
function makeService(
  lastProvider: string | null = 'claude',
  configuredRows: Array<{ slug: string; runtime?: string }> = [],
  lastProviderBuiltin = true,
) {
  const creates: Array<Record<string, unknown>> = [];
  const providerQueries: unknown[] = [];
  const prisma = {
    agent: {
      findFirst: async () => ({
        id: 'agent-1',
        runnerId: 'runner-1',
        enableWorktree: false,
        permissionMode: null,
      }),
    },
    $queryRaw: async () =>
      lastProvider
        ? [{ agent_id: 'agent-1', provider: lastProvider, provider_builtin: lastProviderBuiltin }]
        : [],
    runner: { findFirst: async () => ({ id: 'runner-1' }) },
    modelProvider: {
      findFirst: async (args: unknown) => {
        providerQueries.push(args);
        const where = (args as { where: { slug: string } }).where;
        return configuredRows.find((r) => r.slug === where.slug) ?? null;
      },
    },
    session: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { id: 'session-1', ...data, endReason: null, completedAt: null, archivedAt: null, deletedAt: null };
      },
      updateMany: async () => ({ count: 1 }),
    },
  } as never;
  const queue = { notifySessionQueued: () => undefined } as never;
  const realtime = {
    publishSessionCreated: () => undefined,
    publishSessionUpdated: () => undefined,
  } as never;
  return { service: new SessionsService(prisma, queue, realtime), creates, providerQueries };
}

test('omitting provider starts the session where the project last started', async () => {
  const fixture = makeService('codex');
  await fixture.service.create('owner-1', {
    prompt: 'Fix the login timeout',
    title: 'Fix login',
    agentId: 'agent-1',
  });

  assert.equal(fixture.creates[0].provider, 'codex');
  assert.equal(fixture.creates[0].providerBuiltin, true);
  // A built-in slug needs no ModelProvider lookup — the seeded path must not add one.
  assert.deepEqual(fixture.providerQueries, []);
});

test('a project that has never run anything starts on claude', async () => {
  const fixture = makeService(null);
  await fixture.service.create('owner-1', {
    prompt: 'Fix the login timeout',
    title: 'Fix login',
    agentId: 'agent-1',
  });

  assert.equal(fixture.creates[0].provider, 'claude');
  assert.equal(fixture.creates[0].providerBuiltin, true);
});

test('a built-in engine slug overrides the seed without a provider lookup', async () => {
  for (const slug of ['claude', 'codex', 'kimi', 'opencode']) {
    const fixture = makeService('claude');
    await fixture.service.create('owner-1', {
      prompt: 'Fix the login timeout',
      title: 'Fix login',
      agentId: 'agent-1',
      provider: slug,
    });

    assert.equal(fixture.creates[0].provider, slug, slug);
    assert.equal(fixture.creates[0].providerBuiltin, true, slug);
    assert.deepEqual(fixture.providerQueries, [], slug);
  }
});

test('a configured provider the caller can reach overrides the seed', async () => {
  const fixture = makeService('claude', [{ slug: 'deepseek' }]);
  await fixture.service.create('owner-1', {
    prompt: 'Fix the login timeout',
    title: 'Fix login',
    agentId: 'agent-1',
    provider: 'deepseek',
  });

  assert.equal(fixture.creates[0].provider, 'deepseek');
  assert.equal(fixture.creates[0].providerBuiltin, false);
  // Owner-scoped and enabled-only: a disabled row, or another user's, must not resolve.
  assert.deepEqual((fixture.providerQueries[0] as { where: unknown }).where, {
    slug: 'deepseek',
    enabled: true,
    OR: [{ ownerId: null }, { ownerId: 'owner-1' }],
  });
});

/**
 * The pre-generated session id is Claude's alone: Codex and Kimi mint their own thread after the
 * process starts, and one they never issued turns their first spawn into a resume of a
 * conversation that does not exist. Which CLI runs a configured provider is on its row, not in
 * its slug, so the row has to be consulted before that id is minted.
 */
test('a configured provider gets a pre-generated session id only if it borrows Claude', async () => {
  const cases = [
    { slug: 'deepseek', runtime: 'claude', pregenerated: true },
    { slug: 'moonshot', runtime: 'kimi', pregenerated: false },
    { slug: 'gemini', runtime: 'codex', pregenerated: false },
  ];
  for (const { slug, runtime, pregenerated } of cases) {
    const fixture = makeService('claude', [{ slug, runtime }]);
    await fixture.service.create('owner-1', {
      prompt: 'Fix the login timeout',
      title: 'Fix login',
      agentId: 'agent-1',
      provider: slug,
    });
    assert.equal(typeof fixture.creates[0].runtimeSessionId === 'string', pregenerated, slug);
  }
});

test('a seeded configured provider is looked up for the runtime it borrows', async () => {
  const fixture = makeService('moonshot', [{ slug: 'moonshot', runtime: 'kimi' }], false);
  await fixture.service.create('owner-1', {
    prompt: 'Fix the login timeout',
    title: 'Fix login',
    agentId: 'agent-1',
  });

  assert.equal(fixture.creates[0].provider, 'moonshot');
  assert.equal(fixture.creates[0].runtimeSessionId, null);
  // Same owner scoping as the explicit path: the picker's rules don't loosen for a seeded slug.
  assert.deepEqual((fixture.providerQueries[0] as { where: unknown }).where, {
    slug: 'moonshot',
    enabled: true,
    OR: [{ ownerId: null }, { ownerId: 'owner-1' }],
  });
});

test('an unknown or unreachable provider slug is rejected, not silently ignored', async () => {
  const fixture = makeService('claude', [{ slug: 'deepseek' }]);
  await assert.rejects(
    fixture.service.create('owner-1', {
      prompt: 'Fix the login timeout',
      title: 'Fix login',
      agentId: 'agent-1',
      provider: 'someone-elses-key',
    }),
    /provider not available/,
  );
  assert.deepEqual(fixture.creates, []);
});
