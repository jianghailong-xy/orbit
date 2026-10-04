import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveProviderExec } from './custom-provider';
import { encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';

process.env.PROVIDER_SECRET_KEY = 'p2-synthetic-storage-key';

function row(name: string, key: string) {
  return {
    id: name, ownerId: 'synthetic-owner', slug: name, label: name, runtime: 'dsh',
    baseUrl: `https://${name}.example/anthropic`, apiKeyEnc: encryptSecret(key),
    enabled: true, models: [], defaultModel: null, presetSlug: 'deepseek-harness', followsPreset: true,
  };
}

test('P2 encrypted dsh dispatch keeps concurrent provider keys and endpoints separate', async () => {
  const keys = ['fake-encrypted-alpha', 'fake-encrypted-beta'];
  const rows = keys.map((key, i) => row(`harness-${i}`, key));
  const executions = await Promise.all(rows.map(async (customRow) => resolveProviderExec({
    declaredProvider: customRow.slug, customRow,
    workspaceEnv: { ORBIT_DSH_API_KEY: 'fake-workspace-override', ORBIT_DSH_BASE_URL: 'https://wrong.example', DSH_HOME: '/user-harness-home' },
  })));
  for (let i = 0; i < executions.length; i++) {
    assert.equal(executions[i].provider, 'dsh');
    assert.equal(executions[i].env?.ORBIT_DSH_API_KEY, keys[i]);
    assert.equal(executions[i].env?.ORBIT_DSH_BASE_URL, rows[i].baseUrl);
    assert.ok(!JSON.stringify(rows[i]).includes(keys[i]), 'stored provider data must be encrypted');
  }
  const service = new ProvidersService({ modelProvider: { findMany: async () => rows } } as never, {} as never, {} as never);
  for (const views of [await service.listMine('synthetic-owner'), await service.listShared()]) {
    const api = JSON.stringify(views);
    for (const key of keys) assert.ok(!api.includes(key));
    for (const stored of rows) assert.ok(!api.includes(stored.apiKeyEnc));
    assert.ok(views.every((view) => view.hasApiKey));
  }
});

test('P2 dsh credential rotation revocation and disabled dispatch cannot reuse a saved key', () => {
  const saved = row('harness-rotating', 'fake-original');
  const dispatch = () => resolveProviderExec({ declaredProvider: saved.slug, customRow: saved });
  assert.equal(dispatch().env?.ORBIT_DSH_API_KEY, 'fake-original');
  saved.apiKeyEnc = encryptSecret('fake-rotated');
  assert.equal(dispatch().env?.ORBIT_DSH_API_KEY, 'fake-rotated');
  saved.apiKeyEnc = encryptSecret('');
  assert.throws(dispatch, /malformed encrypted secret/, 'revoked storage cannot dispatch the previous key');
  saved.enabled = false;
  assert.throws(dispatch, /provider is disabled/);
});
