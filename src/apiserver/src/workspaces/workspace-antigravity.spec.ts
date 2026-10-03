import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspacesService } from './workspaces.service';

function fixture() {
  let stored: Record<string, unknown> = { id: 'workspace-1', runnerId: null, env: null };
  const runnerReads: unknown[] = [];
  const prisma = {
    runner: {
      findMany: async (args: unknown) => {
        runnerReads.push(args);
        return [
          { id: 'runner-key', engines: [{ engine: 'antigravity', installed: true, auth: 'yes' }] },
          { id: 'runner-none', engines: [{ engine: 'antigravity', installed: true, auth: 'no' }] },
          { id: 'runner-unreported', engines: null },
        ];
      },
    },
    workspace: {
      findMany: async () => [stored],
      findFirst: async () => stored,
      create: async ({ data }: { data: Record<string, unknown> }) => (stored = { ...stored, ...data }),
      update: async ({ data }: { data: Record<string, unknown> }) => (stored = { ...stored, ...data }),
    },
    $queryRaw: async () => [],
  };
  return { service: new WorkspacesService(prisma as never), runnerReads, setEnv: (env: unknown) => { stored.env = env; } };
}

test('workspace reads resolve the selected runner rather than only the bound machine', async () => {
  const h = fixture();
  const expected = { 'runner-key': true, 'runner-none': false, 'runner-unreported': false };
  const read = await h.service.get('owner-1', 'workspace-1');
  assert.deepEqual(read.antigravityKeyAvailableByRunner, expected);
  assert.equal(read.runnerId, null, 'an unbound workspace still resolves every owned runner');
  assert.deepEqual((await h.service.list('owner-1'))[0].antigravityKeyAvailableByRunner, expected);
  assert.deepEqual(h.runnerReads, [
    { where: { ownerId: 'owner-1' }, select: { id: true, engines: true } },
    { where: { ownerId: 'owner-1' }, select: { id: true, engines: true } },
  ]);
  h.setEnv({ GEMINI_API_KEY: '  ' });
  assert.deepEqual((await h.service.get('owner-1', 'workspace-1')).antigravityKeyAvailableByRunner, expected);
});

test('workspace create/update compute the key availability while returning only booleans in its map', async () => {
  const h = fixture();
  const created = await h.service.create('owner-1', { name: 'Gemini', env: { GEMINI_API_KEY: 'test-key' } });
  assert.deepEqual(created.antigravityKeyAvailableByRunner, {
    'runner-key': true, 'runner-none': true, 'runner-unreported': true,
  });
  assert.equal(JSON.stringify(created.antigravityKeyAvailableByRunner).includes('test-key'), false);
  const updated = await h.service.update('owner-1', 'workspace-1', { env: { GEMINI_API_KEY: '' } });
  assert.deepEqual(updated.antigravityKeyAvailableByRunner, {
    'runner-key': true, 'runner-none': false, 'runner-unreported': false,
  });
});
