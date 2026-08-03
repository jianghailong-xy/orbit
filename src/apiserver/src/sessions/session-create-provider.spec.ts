import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionsService } from './sessions.service';

/**
 * The New Session provider picker sends its choice as `CreateSessionDto.provider`. The session
 * row is what dispatch reads (`session.provider ?? agent.provider`), so the override has to land
 * there — and it has to be checked, since the slug arrives from the client.
 */
function makeService(agentProvider = 'claude', configuredRows: Array<{ slug: string }> = []) {
  const creates: Array<Record<string, unknown>> = [];
  const providerQueries: unknown[] = [];
  const prisma = {
    agent: {
      findFirst: async () => ({
        id: 'agent-1',
        runnerId: 'runner-1',
        provider: agentProvider,
        providerBuiltin: true,
        enableWorktree: false,
        permissionMode: null,
      }),
    },
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

test('omitting provider keeps inheriting the agent’s', async () => {
  const fixture = makeService('codex');
  await fixture.service.create('owner-1', {
    prompt: 'Fix the login timeout',
    title: 'Fix login',
    agentId: 'agent-1',
  });

  assert.equal(fixture.creates[0].provider, 'codex');
  assert.equal(fixture.creates[0].providerBuiltin, true);
  // No slug to check means no lookup — the inherited path must stay a single query.
  assert.deepEqual(fixture.providerQueries, []);
});

test('a built-in engine slug overrides the agent without a provider lookup', async () => {
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

test('a configured provider the caller can reach overrides the agent', async () => {
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
