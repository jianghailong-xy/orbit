import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

// The lookup revealKey scopes with, plus whatever row it should find.
const serviceFor = (row: unknown, wheres: unknown[]) =>
  new ProvidersService(
    {
      modelProvider: {
        findFirst: async ({ where }: { where: unknown }) => {
          wheres.push(where);
          return row;
        },
      },
    } as never,
    {} as never,
    {} as never,
  );

test('revealKey hands a personal provider key back in the clear', async () => {
  const wheres: unknown[] = [];
  const svc = serviceFor({ id: 'p1', apiKeyEnc: encryptSecret('sk-secret') }, wheres);

  assert.deepEqual(await svc.revealKey('owner-1', 'p1'), { apiKey: 'sk-secret' });
  // The fence: the row is looked up by id *and* caller, so a shared row (ownerId null) or another
  // user's misses entirely rather than decrypting.
  assert.equal((wheres[0] as { ownerId?: unknown }).ownerId, 'owner-1');
  assert.equal((wheres[0] as { id?: unknown }).id, 'p1');
});

test('revealKey rejects an id outside the caller scope', async () => {
  const svc = serviceFor(null, []);
  await assert.rejects(() => svc.revealKey('owner-1', 'someone-elses'), /provider not found/);
});

test('revealKey reports a provider with no stored key rather than decrypting nothing', async () => {
  const svc = serviceFor({ id: 'p1', apiKeyEnc: '' }, []);
  await assert.rejects(() => svc.revealKey('owner-1', 'p1'), /no API key/);
});
