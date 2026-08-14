import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { ReaperService } from './reaper.service';

function runningSession(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    taskId: null,
    assignedRunnerId: '22222222-2222-4222-8222-222222222222',
    status: RunStatus.RUNNING,
    provider: AgentProvider.OPENCODE,
    runtimeSessionId: null,
    claudeSessionId: null,
    lastTurnAt: new Date(Date.now() - 3 * 60_000),
    cancelRequestedAt: null,
    endReason: null,
    task: null,
    workspace: { provider: AgentProvider.CLAUDE },
    assignedRunner: { status: 'ONLINE', lastHeartbeatAt: new Date() },
    ...overrides,
  };
}

test('reaper applies the startup watchdog to OpenCode sessions', async () => {
  const prisma = {
    session: { findMany: async () => [runningSession()] },
  } as never;
  const service = new ReaperService(prisma, {} as never);
  const finalized: unknown[][] = [];
  const sweepable = service as unknown as {
    sweep(): Promise<void>;
    forceFinalize(...args: unknown[]): Promise<void>;
  };
  sweepable.forceFinalize = async (...args: unknown[]) => {
    finalized.push(args);
  };

  await sweepable.sweep();

  assert.deepEqual(finalized, [
    [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      null,
      'opencode runtime not initialized',
      { expectedStatuses: [RunStatus.RUNNING], onlyIfNotCancelling: true },
    ],
  ]);
});

test('reaper leaves initialized OpenCode and uninitialized Claude sessions alone', async () => {
  const prisma = {
    session: {
      findMany: async () => [
        runningSession({ runtimeSessionId: 'opencode-runtime-1' }),
        runningSession({
          id: '33333333-3333-4333-8333-333333333333',
          provider: AgentProvider.CLAUDE,
        }),
      ],
    },
  } as never;
  const service = new ReaperService(prisma, {} as never);
  const finalized: unknown[][] = [];
  const sweepable = service as unknown as {
    sweep(): Promise<void>;
    forceFinalize(...args: unknown[]): Promise<void>;
  };
  sweepable.forceFinalize = async (...args: unknown[]) => {
    finalized.push(args);
  };

  await sweepable.sweep();

  assert.deepEqual(finalized, []);
});
