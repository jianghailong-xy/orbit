import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import {
  agentProviderSeed,
  DEFAULT_AGENT_PROVIDER,
  lastProviderByWorkspace,
  withProviderSeed,
} from './workspace-provider';

/** Captures the raw query the lookup builds, and answers with fixed rows. */
function prismaStub(rows: unknown[] = []) {
  const seen: { sql?: string; values?: unknown[] } = {};
  return {
    seen,
    prisma: {
      $queryRaw: async (...args: unknown[]) => {
        const rendered = renderRawQuery(args);
        seen.sql = rendered.text;
        seen.values = [...rendered.values];
        return rows;
      },
    } as never,
  };
}

test('the seed is read from the project history, newest first, one row per workspace', async () => {
  const { prisma, seen } = prismaStub();
  await lastProviderByWorkspace(prisma, ['a1', 'a2']);
  // One indexed LIMIT 1 per workspace. The DISTINCT ON form reads every session these workspaces own and
  // sorts it — a sequential scan that grows with the table, on every client boot.
  assert.match(seen.sql ?? '', /CROSS JOIN LATERAL/);
  assert.match(seen.sql ?? '', /ORDER BY created_at DESC\s*LIMIT 1/);
  assert.doesNotMatch(seen.sql ?? '', /DISTINCT ON/);
  assert.deepEqual(seen.values, ['a1', 'a2']);
});

test('task-launched runs are excluded, so a pinned job cannot re-point the project', async () => {
  const { prisma, seen } = prismaStub();
  await lastProviderByWorkspace(prisma, ['a1']);
  assert.match(seen.sql ?? '', /task_id IS NULL/);
});

test('workspace-spawned children are excluded, so a scripted probe cannot re-point the project', async () => {
  // An MCP `session_create` child picks its provider for the job it was spawned to do — e.g. a
  // throwaway "reproduce this on OpenCode" run. Counting it put OpenCode in front of a human who
  // had never chosen it, which is the same coupling `task_id IS NULL` already guards against.
  const { prisma, seen } = prismaStub();
  await lastProviderByWorkspace(prisma, ['a1']);
  assert.match(seen.sql ?? '', /parent_session_id IS NULL/);
});

test('duplicate and empty ids collapse, and an empty list never hits the database', async () => {
  const { prisma, seen } = prismaStub();
  await lastProviderByWorkspace(prisma, ['a1', 'a1', null, undefined]);
  assert.deepEqual(seen.values, ['a1']);

  const empty = prismaStub();
  assert.equal((await lastProviderByWorkspace(empty.prisma, [null])).size, 0);
  assert.equal(empty.seen.sql, undefined);
});

test('a project that has never run anything starts where Orbit starts', async () => {
  const { prisma } = prismaStub([]);
  assert.deepEqual(await agentProviderSeed(prisma, 'a1'), DEFAULT_AGENT_PROVIDER);
  assert.deepEqual(DEFAULT_AGENT_PROVIDER, { engine: 'claude', provider: 'claude', providerBuiltin: true });
});

test('a project that has run something starts there again, on its engine and its credential', async () => {
  const { prisma } = prismaStub([
    { workspace_id: 'a1', engine: 'dsh', provider: 'anthropic', provider_builtin: false, owner_id: 'o1' },
  ]);
  assert.deepEqual(await agentProviderSeed(prisma, 'a1'), {
    engine: 'dsh',
    provider: 'anthropic',
    providerBuiltin: false,
  });
});

test('the seed of a session an older replica wrote derives its engine by the old rules', async () => {
  const rows = [{ workspace_id: 'a1', engine: null, provider: 'anthropic', provider_builtin: false, owner_id: 'o1' }];
  const prisma = {
    $queryRaw: async () => rows,
    user: { findUnique: async () => ({ role: 'USER' }) },
    modelProvider: { findFirst: async () => ({ runtime: 'codex' }) },
  } as never;
  assert.deepEqual(await agentProviderSeed(prisma, 'a1'), { engine: 'codex', provider: 'anthropic', providerBuiltin: false });
});

test("a managed default workspace with no history starts on what its runner was READY with: a runtime, or the owner's key", async () => {
  const { prisma: queried, seen } = prismaStub();
  await lastProviderByWorkspace(queried, ['a1']);
  assert.match(seen.sql ?? '', /m\.owner_id::text\s+FROM a\s+JOIN managed_runner m ON m\.default_workspace_id = a\.id AND m\.initial_provider IS NOT NULL/);

  const asked: unknown[] = [];
  const rows = [
    { workspace_id: 'a1', engine: 'codex', provider: 'codex', provider_builtin: true, owner_id: null, managed_owner_id: 'o1' },
    { workspace_id: 'a2', engine: 'deepseek', provider: 'deepseek', provider_builtin: true, owner_id: null, managed_owner_id: 'o1' },
  ];
  const prisma = {
    $queryRaw: async () => rows,
    modelProvider: { findFirst: async (args: unknown) => (asked.push(args), { runtime: 'claude' }) },
  } as never;
  const seeds = await lastProviderByWorkspace(prisma, ['a1', 'a2']);
  // A runtime signed in on the runner is the engine and the credential at once.
  assert.deepEqual(seeds.get('a1'), { engine: 'codex', provider: 'codex', providerBuiltin: true });
  // A key is a configured credential, on the engine its row names.
  assert.deepEqual(seeds.get('a2'), { engine: 'claude', provider: 'deepseek', providerBuiltin: false });
  assert.deepEqual(asked, [{ where: { slug: 'deepseek', OR: [{ ownerId: 'o1' }, { ownerId: null }] }, select: { runtime: true } }]);
});

test("a managed default workspace whose runner was never ready starts on the owner's own key, or on the floor without one", async () => {
  const { prisma: queried, seen } = prismaStub();
  await lastProviderByWorkspace(queried, ['a1']);
  assert.match(seen.sql ?? '', /true, m\.owner_id::text\s+FROM a\s+JOIN managed_runner m ON m\.default_workspace_id = a\.id AND m\.initial_provider IS NULL\s+WHERE NOT EXISTS/);

  const keys = [
    // A key named like a built-in runtime is passed over, as READY passes it over.
    { slug: 'kimi', runtime: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic', apiKeyEnc: 'not-decryptable', presetSlug: 'kimi' },
    { slug: 'deepseek', runtime: 'claude', baseUrl: 'https://api.deepseek.com/anthropic', apiKeyEnc: 'not-decryptable', presetSlug: 'deepseek' },
  ];
  const owners: unknown[] = [];
  const prisma = {
    $queryRaw: async () => [
      { workspace_id: 'a1', engine: null, provider: null, provider_builtin: false, owner_id: null, managed_unready: true, managed_owner_id: 'o1' },
      { workspace_id: 'a2', engine: null, provider: null, provider_builtin: false, owner_id: null, managed_unready: true, managed_owner_id: 'o2' },
    ],
    modelProvider: {
      findMany: async (args: { where: { ownerId: string; enabled: boolean } }) => (owners.push(args.where), args.where.ownerId === 'o1' ? keys : []),
      findFirst: async () => ({ runtime: 'claude' }),
    },
  } as never;
  const seeds = await lastProviderByWorkspace(prisma, ['a1', 'a2']);
  assert.deepEqual(seeds.get('a1'), { engine: 'claude', provider: 'deepseek', providerBuiltin: false });
  assert.equal(seeds.has('a2'), false, 'an owner with no key of their own: the floor');
  assert.deepEqual(owners, [{ ownerId: 'o1', enabled: true }, { ownerId: 'o2', enabled: true }], "only the owner's own enabled keys");
});

test('workspace payloads carry the derived default, not a stored one', () => {
  const seeds = new Map([['a1', { engine: 'codex' as never, provider: 'codex', providerBuiltin: true }]]);
  const [ran, neverRan] = withProviderSeed(
    // `provider` here stands in for the tombstoned column: it must not win.
    [
      { id: 'a1', name: 'orbit', provider: 'claude' },
      { id: 'a2', name: 'fresh', provider: 'claude' },
    ],
    seeds,
  );
  assert.equal(ran.lastProvider, 'codex');
  assert.equal(ran.lastEngine, 'codex');
  assert.equal(ran.provider, 'codex', 'the alias old iOS/macOS builds read agrees with it');
  assert.equal(neverRan.lastProvider, 'claude');
  assert.equal(neverRan.lastEngine, 'claude');
  assert.equal(neverRan.providerBuiltin, true);
});
