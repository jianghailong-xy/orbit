import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ProvidersService } from './providers.service';

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

const ROW = {
  id: 'prov-1',
  ownerId: 'user-1',
  baseUrl: 'https://api.anthropic.com',
  apiKeyEnc: 'iv:tag:ct',
  slug: 'anthropic',
  label: 'Anthropic',
  runtime: 'claude',
  models: [],
  defaultModel: null,
  presetSlug: null,
  followsPreset: false,
};

const serviceFor = (asked: unknown[]) =>
  new ProvidersService(
    { modelProvider: { findMany: async () => [ROW] } } as never,
    {} as never,
    {
      snapshot: (row: unknown) => {
        asked.push(row);
        return { provider: 'claude', fiveHour: { utilization: 40 } };
      },
    } as never,
  );

test('the picker catalog carries each credential its own quota', async () => {
  const asked: unknown[] = [];
  const [provider] = await serviceFor(asked).listPublic('user-1');

  assert.deepEqual(provider.planUsage, { provider: 'claude', fiveHour: { utilization: 40 } });
  // The quota is asked of the row's own credential — not of the runner the session lands on,
  // which is logged into a different account.
  assert.deepEqual(asked, [
    { id: 'prov-1', ownerId: 'user-1', runtime: 'claude', baseUrl: 'https://api.anthropic.com', apiKeyEnc: 'iv:tag:ct' },
  ]);
});

test('reading a quota does not put the key or the endpoint in a browser payload', async () => {
  const [provider] = await serviceFor([]).listPublic('user-1');
  for (const secret of ['apiKeyEnc', 'baseUrl', 'ownerId', 'id']) {
    assert.equal(secret in provider, false, `${secret} must not reach the picker`);
  }
});
