import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  agentProviderSeed,
  DEFAULT_AGENT_PROVIDER,
  lastProviderByAgent,
  withProviderSeed,
} from './agent-provider';

/** Captures the raw query the lookup builds, and answers with fixed rows. */
function prismaStub(rows: unknown[] = []) {
  const seen: { sql?: string; values?: unknown[] } = {};
  return {
    seen,
    prisma: {
      $queryRaw: async (query: { strings: string[]; values: unknown[] }) => {
        seen.sql = query.strings.join('?');
        seen.values = query.values;
        return rows;
      },
    } as never,
  };
}

test('the seed is read from the project history, newest first, one row per agent', async () => {
  const { prisma, seen } = prismaStub();
  await lastProviderByAgent(prisma, ['a1', 'a2']);
  // One indexed LIMIT 1 per agent. The DISTINCT ON form reads every session these agents own and
  // sorts it — a sequential scan that grows with the table, on every client boot.
  assert.match(seen.sql ?? '', /CROSS JOIN LATERAL/);
  assert.match(seen.sql ?? '', /ORDER BY created_at DESC\s*LIMIT 1/);
  assert.doesNotMatch(seen.sql ?? '', /DISTINCT ON/);
  assert.deepEqual(seen.values, ['a1', 'a2']);
});

test('task-launched runs are excluded, so a pinned job cannot re-point the project', async () => {
  const { prisma, seen } = prismaStub();
  await lastProviderByAgent(prisma, ['a1']);
  assert.match(seen.sql ?? '', /task_id IS NULL/);
});

test('duplicate and empty ids collapse, and an empty list never hits the database', async () => {
  const { prisma, seen } = prismaStub();
  await lastProviderByAgent(prisma, ['a1', 'a1', null, undefined]);
  assert.deepEqual(seen.values, ['a1']);

  const empty = prismaStub();
  assert.equal((await lastProviderByAgent(empty.prisma, [null])).size, 0);
  assert.equal(empty.seen.sql, undefined);
});

test('a project that has never run anything starts where Orbit starts', async () => {
  const { prisma } = prismaStub([]);
  assert.deepEqual(await agentProviderSeed(prisma, 'a1'), DEFAULT_AGENT_PROVIDER);
  assert.deepEqual(DEFAULT_AGENT_PROVIDER, { provider: 'claude', providerBuiltin: true });
});

test('a project that has run something starts there again', async () => {
  const { prisma } = prismaStub([{ agent_id: 'a1', provider: 'anthropic', provider_builtin: false }]);
  assert.deepEqual(await agentProviderSeed(prisma, 'a1'), {
    provider: 'anthropic',
    providerBuiltin: false,
  });
});

test('agent payloads carry the derived default, not a stored one', () => {
  const seeds = new Map([['a1', { provider: 'codex', providerBuiltin: true }]]);
  const [ran, neverRan] = withProviderSeed(
    // `provider` here stands in for the tombstoned column: it must not win.
    [
      { id: 'a1', name: 'orbit', provider: 'claude' },
      { id: 'a2', name: 'fresh', provider: 'claude' },
    ],
    seeds,
  );
  assert.equal(ran.lastProvider, 'codex');
  assert.equal(ran.provider, 'codex', 'the alias old iOS/macOS builds read agrees with it');
  assert.equal(neverRan.lastProvider, 'claude');
  assert.equal(neverRan.providerBuiltin, true);
});
