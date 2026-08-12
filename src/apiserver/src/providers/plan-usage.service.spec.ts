import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ProviderPlanUsageService, type UsageProviderRow } from './plan-usage.service';
import { encryptSecret } from './provider-crypto';

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

// Encrypted once: every encryptSecret() call picks a fresh IV, so re-encrypting per row would
// read as a rotated key. A real row's ciphertext is stable until someone saves a new key.
const KEY_ENC = encryptSecret('sk-ant-oat01-good');

const row = (overrides: Partial<UsageProviderRow> = {}): UsageProviderRow => ({
  id: 'prov-1',
  ownerId: 'user-1',
  runtime: 'claude',
  baseUrl: 'https://api.anthropic.com',
  apiKeyEnc: KEY_ENC,
  ...overrides,
});

/** Collects what the service pushed, so a test can assert the client is told to refetch. */
const realtimeStub = () => {
  const published: string[] = [];
  return {
    stub: {
      publishForUser: (_u: string, _t: string, id: string) => published.push(`user:${id}`),
      publishForAllUsers: (_t: string, id: string) => published.push(`all:${id}`),
    } as never,
    published,
  };
};

function stubFetch(replies: Array<{ status: number; body?: unknown } | Error>) {
  const calls: RequestInit[] = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const reply = replies[Math.min(i++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body ?? {},
    };
  }) as never;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const USAGE = { five_hour: { utilization: 40, resets_at: '2026-08-12T17:40:00Z' } };

test('the first read serves nothing and the refresh behind it publishes the gauge', async () => {
  const { stub, published } = realtimeStub();
  const { restore } = stubFetch([{ status: 200, body: USAGE }]);
  try {
    const svc = new ProviderPlanUsageService(stub);
    assert.equal(svc.snapshot(row()), null, 'reads never block on the network');
    await svc.refresh(row());
    assert.equal(svc.snapshot(row())?.fiveHour?.utilization, 40);
    assert.deepEqual(published, ['user:prov-1'], 'the owner is told to refetch');
  } finally {
    restore();
  }
});

test('the request identifies as an OAuth read of the usage endpoint', async () => {
  const { stub } = realtimeStub();
  const { calls, restore } = stubFetch([{ status: 200, body: USAGE }]);
  try {
    await new ProviderPlanUsageService(stub).refresh(row());
    const headers = calls[0]?.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer sk-ant-oat01-good');
    assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
  } finally {
    restore();
  }
});

test('a row that cannot answer is never asked', async () => {
  const { stub } = realtimeStub();
  const { calls, restore } = stubFetch([{ status: 200, body: USAGE }]);
  try {
    const svc = new ProviderPlanUsageService(stub);
    await svc.refresh(row({ apiKeyEnc: encryptSecret('sk-ant-api03-metered') }));
    await svc.refresh(row({ baseUrl: 'https://api.deepseek.com/anthropic' }));
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('a scope-less token keeps the gauge empty instead of surfacing as a broken provider', async () => {
  const { stub, published } = realtimeStub();
  const { restore } = stubFetch([{ status: 403 }]);
  try {
    const svc = new ProviderPlanUsageService(stub);
    await svc.refresh(row());
    assert.equal(svc.snapshot(row()), null);
    assert.deepEqual(published, [], 'nothing changed, so nothing is pushed');
  } finally {
    restore();
  }
});

test('a blip keeps the last good numbers, the way the runner probe does', async () => {
  const { stub } = realtimeStub();
  const { restore } = stubFetch([{ status: 200, body: USAGE }, new Error('offline')]);
  try {
    const svc = new ProviderPlanUsageService(stub);
    await svc.refresh(row());
    await svc.refresh(row());
    assert.equal(svc.snapshot(row())?.fiveHour?.utilization, 40);
  } finally {
    restore();
  }
});

test('a rotated key drops the old account numbers immediately', async () => {
  const { stub } = realtimeStub();
  const { restore } = stubFetch([{ status: 200, body: USAGE }]);
  try {
    const svc = new ProviderPlanUsageService(stub);
    await svc.refresh(row());
    assert.equal(svc.snapshot(row({ apiKeyEnc: encryptSecret('sk-ant-oat01-other') })), null);
  } finally {
    restore();
  }
});

test('a shared provider pushes to everyone, since everyone spends that credential', async () => {
  const { stub, published } = realtimeStub();
  const { restore } = stubFetch([{ status: 200, body: USAGE }]);
  try {
    await new ProviderPlanUsageService(stub).refresh(row({ ownerId: null }));
    assert.deepEqual(published, ['all:prov-1']);
  } finally {
    restore();
  }
});
