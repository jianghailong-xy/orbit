import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { ANTIGRAVITY_GOOGLE_LOGIN_LINUX_ONLY, ANTIGRAVITY_GOOGLE_LOGIN_V1 } from '../common/antigravity-readiness';
import { RunnersService } from './runners.service';

test('the runners response carries Antigravity readiness for old, missing and ready machines', async () => {
  const rows = [
    { id: 'old', capabilities: [], engines: null },
    { id: 'missing', capabilities: ['provider:antigravity'], engines: [{ engine: 'antigravity', installed: false, auth: 'no' }] },
    { id: 'ready', capabilities: ['provider:antigravity'], engines: [{ engine: 'antigravity', installed: true, version: '1.2.3', auth: 'yes' }] },
    {
      id: 'google',
      capabilities: ['provider:antigravity', ANTIGRAVITY_GOOGLE_LOGIN_V1, 'os:linux'],
      engines: [{ engine: 'antigravity', installed: true, version: '1.2.16', auth: 'yes', authSource: 'google' }],
    },
    {
      id: 'mac',
      capabilities: ['provider:antigravity', ANTIGRAVITY_GOOGLE_LOGIN_V1, 'os:darwin'],
      engines: [{ engine: 'antigravity', installed: true, version: '1.2.16', auth: 'yes', authSource: 'env_key' }],
    },
  ];
  const prisma = { runner: { findMany: async () => rows }, session: { groupBy: async () => [] } };
  const runners = await new RunnersService(prisma as never).listRunners('owner-1');
  assert.deepEqual(runners.map((runner) => runner.antigravity), [
    { supported: false, installed: null, version: null, envKeyAvailable: false, authSource: null, googleLogin: 'needs_update' },
    { supported: true, installed: false, version: null, envKeyAvailable: false, authSource: null, googleLogin: 'needs_update' },
    { supported: true, installed: true, version: '1.2.3', envKeyAvailable: true, authSource: 'env_key', googleLogin: 'needs_update' },
    { supported: true, installed: true, version: '1.2.16', envKeyAvailable: true, authSource: 'google', googleLogin: 'available' },
    { supported: true, installed: true, version: '1.2.16', envKeyAvailable: true, authSource: 'env_key', googleLogin: 'unsupported_platform' },
  ]);
});

test('the runners response hands clients the Google sign-in and its quota, and nothing that names the account', async () => {
  const stored = [{
    engine: 'antigravity',
    installed: true,
    auth: 'yes',
    authSource: 'google',
    email: 'owner@example.com',
    planUsage: {
      provider: 'antigravity',
      fetchedAt: '2026-10-04T02:00:00Z',
      email: 'owner@example.com',
      buckets: [
        { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.25, resetTime: '2026-10-10T17:31:03Z', description: 'You have used some of your weekly limit.' },
        { id: 'gemini-5h', window: '5h', remainingFraction: 0 },
      ],
    },
  }];
  const prisma = {
    runner: { findMany: async () => [{ id: 'google', capabilities: [ANTIGRAVITY_GOOGLE_LOGIN_V1], engines: stored }] },
    session: { groupBy: async () => [] },
  };
  const [runner] = await new RunnersService(prisma as never).listRunners('owner-1');
  assert.deepEqual(runner.engines, [{
    engine: 'antigravity',
    installed: true,
    auth: 'yes',
    authSource: 'google',
    planUsage: {
      provider: 'antigravity',
      fetchedAt: '2026-10-04T02:00:00.000Z',
      buckets: [
        { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.25, resetTime: '2026-10-10T17:31:03.000Z' },
        { id: 'gemini-5h', window: '5h', remainingFraction: 0 },
      ],
    },
  }]);
  assert.equal(JSON.stringify(runner).includes('example.com'), false);
});

test('Antigravity sign-in is started only on a runner that relays it, as its one login', async () => {
  const writes: Record<string, unknown>[] = [];
  const runner: Record<string, unknown> = { id: 'runner-1', status: 'ONLINE', capabilities: [ANTIGRAVITY_GOOGLE_LOGIN_V1], engines: null };
  const prisma = {
    runner: {
      findFirst: async () => runner,
      update: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return { ...runner, ...data }; },
    },
  };
  const service = new RunnersService(prisma as never);
  const started = await service.startLogin('owner-1', 'runner-1', { engine: 'antigravity' });
  assert.deepEqual([started.status, started.engine], ['pending', 'antigravity']);
  assert.deepEqual([writes[0].loginEngine, writes[0].loginAccount, writes[0].loginAccountName], ['antigravity', null, null]);

  // A runner that does not declare it would only fail the start on the machine: refused here, saying why.
  for (const capabilities of [[], ['provider:antigravity', 'codex-account-login/v1', 'os:linux']]) {
    runner.capabilities = capabilities;
    await assert.rejects(
      service.startLogin('owner-1', 'runner-1', { engine: 'antigravity' }),
      (error: unknown) => error instanceof BadRequestException && /too old to sign Antigravity in with Google — update it/.test(error.message),
    );
  }
  // A macOS runner declares it too — it is the same binary — but the sign-in is Linux-only for now.
  for (const os of ['os:darwin', 'os:windows']) {
    runner.capabilities = [ANTIGRAVITY_GOOGLE_LOGIN_V1, os];
    await assert.rejects(
      service.startLogin('owner-1', 'runner-1', { engine: 'antigravity' }),
      (error: unknown) => error instanceof BadRequestException && error.message === ANTIGRAVITY_GOOGLE_LOGIN_LINUX_ONLY,
    );
  }
  // One Google account per runner, like Kimi's one login: there is no other account to name.
  runner.capabilities = [ANTIGRAVITY_GOOGLE_LOGIN_V1, 'os:linux'];
  await assert.rejects(service.startLogin('owner-1', 'runner-1', { engine: 'antigravity', account: 'default' }), /keeps a login per directory/);
  await assert.rejects(service.startLogin('owner-1', 'runner-1', { engine: 'antigravity', accountName: 'Work' }), /keeps a login per directory/);
  assert.equal(writes.length, 1, 'a refused start writes nothing');
  // A Linux runner that says so starts it.
  assert.equal((await service.startLogin('owner-1', 'runner-1', { engine: 'antigravity' })).status, 'pending');
});

test('Antigravity install uses the existing relay and refuses runners that do not declare support', async () => {
  const writes: Record<string, unknown>[] = [];
  const runner = { status: 'ONLINE', capabilities: ['provider:antigravity'], engines: null };
  const prisma = {
    runner: {
      findFirst: async () => runner,
      update: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return data; },
    },
  };
  const service = new RunnersService(prisma as never);
  const install = await service.startInstall('owner-1', 'runner-1', 'antigravity');
  assert.equal(install.engine, 'antigravity');
  assert.equal(install.status, 'pending');
  assert.equal(install.mode, 'install');
  assert.equal(writes[0].installEngine, 'antigravity');
  runner.capabilities = [];
  await assert.rejects(service.startInstall('owner-1', 'runner-1', 'antigravity'), /0\.1\.209 or newer/);
  assert.equal(writes.length, 1);
});
