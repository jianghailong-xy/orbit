/**
 * The provider/engine data migration's parts that need no database (provider-engine-migration.ts,
 * provider-engine-resolution.ts, provider-engine-migration.module.ts): how endpoints and keys compare, what
 * a resolution is held equal on, that a start never fails on the migration, and that only the API server
 * runs it. Its PostgreSQL scenarios are provider-engine-migration.pg.spec.ts; both are named in
 * scripts/test-provider-engine-migration.mjs.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { MODULE_METADATA } from '@nestjs/common/constants';
import type { DynamicModule } from '@nestjs/common';

import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { WikiWorkerModule } from '../wiki-worker/wiki-worker.module';
import { ProviderEngineMigrationAtBoot } from './provider-engine-migration.module';
import { keyFingerprint, normalizedEndpoint, sameResolution, type SessionResolution } from './provider-engine-resolution';

test('T4 endpoints compare with scheme and host lowercased and trailing slashes dropped, and nothing else', () => {
  const same = [
    ['https://api.deepseek.com/anthropic', 'https://api.deepseek.com/anthropic'],
    ['HTTPS://API.DeepSeek.com/anthropic/', 'https://api.deepseek.com/anthropic'],
    [' https://api.deepseek.com/anthropic// ', 'https://api.deepseek.com/anthropic'],
  ];
  for (const [input, expected] of same) assert.equal(normalizedEndpoint(input), expected, input);
  // A path, its case, a port or a query is another endpoint.
  const base = normalizedEndpoint('https://api.deepseek.com/anthropic');
  for (const other of [
    'https://api.deepseek.com/anthropic/beta',
    'https://api.deepseek.com/Anthropic',
    'https://api.deepseek.com:8443/anthropic',
    'https://api.deepseek.com/anthropic?x=1',
    'http://api.deepseek.com/anthropic',
  ]) assert.notEqual(normalizedEndpoint(other), base, other);
});

test('T4 a key fingerprint is a prefix of the trimmed key\'s SHA-256, never the key', () => {
  const key = 'sk-0123456789abcdef';
  const expected = createHash('sha256').update(key).digest('hex').slice(0, 16);
  assert.equal(keyFingerprint(key), expected);
  assert.equal(keyFingerprint(`  ${key}\n`), expected, 'the same key, padded, is the same key');
  assert.notEqual(keyFingerprint(`${key}0`), expected);
  assert.ok(!keyFingerprint(key).includes(key.slice(3)));
});

test('T4 two resolutions are the same exactly when engine, key, endpoint, model, runtime id and dispatch are', () => {
  const resolution: SessionResolution = {
    engine: 'dsh', provider: 'deepseek-harness', keyFingerprint: 'abc', endpoint: 'https://api.deepseek.com/anthropic',
    model: 'opaque', runtimeSessionId: 'runtime-1', dispatchable: true, refusal: null,
  };
  // The slug it stores and the words of a refusal are not what it runs on.
  assert.ok(sameResolution(resolution, { ...resolution, provider: 'deepseek-2' }));
  assert.ok(sameResolution({ ...resolution, dispatchable: false, refusal: 'provider is disabled' }, { ...resolution, dispatchable: false, refusal: 'provider not available on OpenCode: "x"' }));
  for (const change of [
    { engine: 'claude' }, { keyFingerprint: 'abd' }, { endpoint: 'https://api.deepseek.com/anthropic/v2' },
    { model: 'other' }, { runtimeSessionId: 'runtime-2' }, { dispatchable: false },
  ]) assert.ok(!sameResolution(resolution, { ...resolution, ...change }), JSON.stringify(change));
});

test('T4 a start never fails on the migration: it logs why and the server comes up', async () => {
  const previous = process.env.DATABASE_URL;
  // Nothing listens on port 1: the migration's lock connection is refused at once.
  process.env.DATABASE_URL = 'postgresql://nobody:nothing@127.0.0.1:1/none';
  const errors: string[] = [];
  try {
    const boot = new ProviderEngineMigrationAtBoot({} as PrismaService);
    (boot as unknown as { log: { error: (m: string) => void } }).log = { error: (m: string) => errors.push(m) };
    await boot.onApplicationBootstrap();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^the provider\/engine migration did not finish and runs again on the next start: /);
});

/** Every provider a module brings in, its imports followed all the way down. */
async function providersOf(root: unknown): Promise<Set<unknown>> {
  const seen = new Set<unknown>();
  const providers = new Set<unknown>();
  const visit = async (entry: unknown): Promise<void> => {
    let node = await entry;
    if (node && typeof node === 'object' && 'forwardRef' in node) node = (node as { forwardRef: () => unknown }).forwardRef();
    if (!node || seen.has(node)) return;
    seen.add(node);
    const dynamic = typeof node === 'object' ? (node as DynamicModule) : undefined;
    const declared = (key: string) => (Reflect.getMetadata(key, dynamic ? dynamic.module : (node as object)) ?? []) as unknown[];
    for (const p of [...declared(MODULE_METADATA.PROVIDERS), ...(dynamic?.providers ?? [])]) providers.add(p);
    for (const i of [...declared(MODULE_METADATA.IMPORTS), ...(dynamic?.imports ?? [])]) await visit(i);
  };
  await visit(root);
  return providers;
}

test('T4 the API server runs the migration when it starts, and the Wiki worker never does', async () => {
  assert.ok((await providersOf(AppModule)).has(ProviderEngineMigrationAtBoot), 'AppModule starts it');
  assert.ok(!(await providersOf(WikiWorkerModule)).has(ProviderEngineMigrationAtBoot), 'the Wiki worker shares the database and must not');
});
