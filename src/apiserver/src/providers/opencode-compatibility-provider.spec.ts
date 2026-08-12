import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { decryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';

test('provider catalogs hide the OpenCode rolling-compatibility row', async () => {
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

  for (const where of whereClauses) {
    assert.deepEqual((where as { slug?: unknown }).slug, { not: AgentProvider.OPENCODE });
  }
});

test('legacy custom-provider resolution rejects the OpenCode compatibility ciphertext', () => {
  assert.throws(
    () => decryptSecret('orbit-opencode-compatibility-guard'),
    /malformed encrypted secret/,
  );
});
