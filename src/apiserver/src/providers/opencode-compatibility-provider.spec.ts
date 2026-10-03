import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { decryptSecret } from './provider-crypto';
import { COMPATIBILITY_GUARD_SLUGS, ProvidersService } from './providers.service';

test('the guard rows are the OpenCode and Antigravity compatibility fences, and only those', () => {
  // Migrations 0080 and 0367 each park one on the slug that became a built-in runtime.
  assert.deepEqual(COMPATIBILITY_GUARD_SLUGS, [AgentProvider.OPENCODE, AgentProvider.ANTIGRAVITY]);
});

test('provider catalogs hide the OpenCode and Antigravity rolling-compatibility rows', async () => {
  const whereClauses: unknown[] = [];
  const prisma = {
    modelProvider: {
      findMany: async ({ where }: { where: unknown }) => {
        whereClauses.push(where);
        return [];
      },
    },
  } as never;
  const service = new ProvidersService(prisma, {} as never, {} as never);

  await service.listPublic('owner-1');
  await service.listShared();
  await service.listMine('owner-1');

  assert.equal(whereClauses.length, 3);
  for (const where of whereClauses) {
    assert.deepEqual((where as { slug?: unknown }).slug, {
      notIn: [AgentProvider.OPENCODE, AgentProvider.ANTIGRAVITY],
    });
  }
});

test('legacy custom-provider resolution rejects the OpenCode compatibility ciphertext', () => {
  assert.throws(
    () => decryptSecret('orbit-opencode-compatibility-guard'),
    /malformed encrypted secret/,
  );
});

test('legacy custom-provider resolution rejects the Antigravity compatibility ciphertext', () => {
  // What an older replica's reclaim hits when it resolves `antigravity` as a configured provider:
  // the whole response fails before a restarted runner can be told to rebuild agy as Claude.
  assert.throws(
    () => decryptSecret('orbit-antigravity-compatibility-guard'),
    /malformed encrypted secret/,
  );
});
