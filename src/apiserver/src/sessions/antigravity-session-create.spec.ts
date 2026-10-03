import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { SessionsService } from './sessions.service';

/** A create() harness that records the row it would insert and every provider lookup it makes. */
function harness() {
  const created: Array<Record<string, unknown>> = [];
  const providerLookups: unknown[] = [];
  const workspace = { id: 'workspace-1', enableWorktree: false, permissionMode: 'acceptEdits' };
  const prisma = {
    workspace: { findFirst: async () => workspace },
    // create() reads the owner's account-level permission default when the caller names none.
    user: { findUnique: async () => ({ preferences: {} }) },
    runner: { findFirst: async () => ({ id: 'runner-1' }) },
    // The project last ran on Claude; the explicit pick below is what must win.
    $queryRaw: async () => [
      { workspace_id: 'workspace-1', provider: AgentProvider.CLAUDE, provider_builtin: true },
    ],
    modelProvider: {
      findFirst: async (args: unknown) => {
        providerLookups.push(args);
        return null;
      },
    },
    providerPool: {
      findFirst: async (args: unknown) => {
        providerLookups.push(args);
        return null;
      },
    },
    session: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return {
          id: 'session-1',
          ...data,
          endReason: null,
          completedAt: null,
          archivedAt: null,
          deletedAt: null,
        };
      },
    },
  } as never;
  const queue = { notifySessionQueued: () => undefined } as never;
  const realtime = {
    publishSessionCreated: () => undefined,
    // create() also refreshes the workspace list — a user-started session moves the project's
    // provider default.
    publishWorkspaceChanged: () => undefined,
  } as never;
  return { service: new SessionsService(prisma, queue, realtime), created, providerLookups };
}

async function withoutNamingKey<T>(run: () => Promise<T>): Promise<T> {
  const previousNamingKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    return await run();
  } finally {
    if (previousNamingKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousNamingKey;
  }
}

test('creating an Antigravity session does not preseed a Claude runtime id', async () => {
  const { service, created, providerLookups } = harness();

  await withoutNamingKey(() =>
    service.create('owner-1', {
      title: 'Antigravity session',
      prompt: 'Use agy',
      assignedRunnerId: 'runner-1',
      workspaceId: 'workspace-1',
      provider: AgentProvider.ANTIGRAVITY,
      model: 'gemini-3.1-pro',
      // An account default last picked on Claude: agy's top level is `high`.
      effort: 'max',
    }),
  );

  const data = created[0];
  // Stored verbatim, as the built-in it is: no configured provider or pool is consulted.
  assert.equal(data?.provider, AgentProvider.ANTIGRAVITY);
  assert.equal(data?.providerBuiltin, true);
  assert.deepEqual(providerLookups, []);
  // agy mints the conversation id and reports it in its init event; a Claude-style id seeded here
  // would make the first spawn resume a conversation that does not exist.
  assert.equal(data?.runtimeSessionId, null);
  assert.equal(data?.model, 'gemini-3.1-pro');
  assert.equal(data?.effort, 'high');
});

test('an Antigravity session keeps only efforts agy has a name for', async () => {
  for (const [asked, stored] of [
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['', ''],
    ['minimal', 'low'],
    ['none', 'low'],
    ['xhigh', 'high'],
    ['ultra', 'high'],
    ['project-custom', ''],
  ]) {
    const { service, created } = harness();
    await withoutNamingKey(() =>
      service.create('owner-1', {
        title: 'Antigravity effort',
        prompt: 'Use agy',
        assignedRunnerId: 'runner-1',
        workspaceId: 'workspace-1',
        provider: AgentProvider.ANTIGRAVITY,
        effort: asked,
      }),
    );
    assert.equal(created[0]?.effort, stored, `${asked} -> ${stored}`);
  }
});
