import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunnersService } from './runners.service';

test('the runners response carries Antigravity readiness for old, missing and ready machines', async () => {
  const rows = [
    { id: 'old', capabilities: [], engines: null },
    { id: 'missing', capabilities: ['provider:antigravity'], engines: [{ engine: 'antigravity', installed: false, auth: 'no' }] },
    { id: 'ready', capabilities: ['provider:antigravity'], engines: [{ engine: 'antigravity', installed: true, version: '1.2.3', auth: 'yes' }] },
  ];
  const prisma = { runner: { findMany: async () => rows }, session: { groupBy: async () => [] } };
  const runners = await new RunnersService(prisma as never).listRunners('owner-1');
  assert.deepEqual(runners.map((runner) => runner.antigravity), [
    { supported: false, installed: null, version: null, envKeyAvailable: false },
    { supported: true, installed: false, version: null, envKeyAvailable: false },
    { supported: true, installed: true, version: '1.2.3', envKeyAvailable: true },
  ]);
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
