import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunnerStatus } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

function fixture() {
  const writes: Record<string, unknown>[] = [];
  let install: Record<string, unknown> | null = null;
  const prisma = {
    runner: {
      update: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return { maxConcurrent: 2 }; },
      findUnique: async () => install,
    },
  };
  const realtime = {
    drainCancellations: async () => [], drainMergeRequests: async () => [],
    drainCommitRequests: async () => [], drainArtifactRequests: async () => [],
  };
  const api = new RunnerApiController(prisma as never, {} as never, realtime as never, {} as never, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
  const beat = (providers?: string, capabilities?: string) => api.heartbeat(
    { id: 'runner-1', version: null }, { status: RunnerStatus.ONLINE, idleCapacity: 1 }, capabilities, providers,
  );
  return { writes, beat, setInstall: (value: Record<string, unknown>) => { install = value; } };
}

test('heartbeat replaces the provider declaration and retains protocol capabilities', async () => {
  const h = fixture();
  await h.beat('claude, ANTIGRAVITY', 'session-worktree-ops-v1');
  assert.deepEqual(h.writes[0].capabilities, ['session-worktree-ops-v1', 'provider:claude', 'provider:antigravity']);
  await h.beat('claude', 'session-worktree-ops-v1');
  assert.deepEqual(h.writes[1].capabilities, ['session-worktree-ops-v1', 'provider:claude']);
  await h.beat(undefined, 'session-worktree-ops-v1,provider:antigravity');
  assert.deepEqual(h.writes[2].capabilities, ['session-worktree-ops-v1'], 'only the supported-providers header declares a runtime');
  await h.beat();
  assert.deepEqual(h.writes[3].capabilities, []);
});

test('heartbeat hands the existing Antigravity installer request to the runner', async () => {
  const h = fixture();
  const started = new Date();
  h.setInstall({ installStatus: 'pending', installEngine: 'antigravity', installMode: 'install', installAt: started });
  const response = await h.beat('antigravity');
  assert.deepEqual(response.installRequest, { engine: 'antigravity', attempt: started.toISOString(), mode: 'install' });
});
