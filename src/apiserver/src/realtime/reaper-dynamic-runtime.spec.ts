import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { ReaperService } from './reaper.service';

test('reaper applies the runtime-initialization watchdog to Kimi', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const runnerId = '22222222-2222-4222-8222-222222222222';
  const prisma = {
    session: {
      findMany: async () => [
        {
          id: sessionId,
          taskId: null,
          assignedRunnerId: runnerId,
          status: RunStatus.RUNNING,
          provider: AgentProvider.KIMI,
          runtimeSessionId: null,
          claudeSessionId: null,
          lastTurnAt: new Date(Date.now() - 3 * 60_000),
          cancelRequestedAt: null,
          endReason: null,
          task: null,
          agent: { provider: AgentProvider.KIMI },
          assignedRunner: { status: 'ONLINE', lastHeartbeatAt: new Date() },
        },
      ],
    },
  } as never;
  const service = new ReaperService(prisma, {} as never);
  let failure: { id: string; reason: string } | undefined;
  (
    service as unknown as {
      forceFinalize(id: string, runnerId: string | null, taskId: string | null, reason: string): Promise<void>;
    }
  ).forceFinalize = async (id, _runnerId, _taskId, reason) => {
    failure = { id, reason };
  };

  await (service as unknown as { sweep(): Promise<void> }).sweep();

  assert.deepEqual(failure, { id: sessionId, reason: 'kimi runtime not initialized' });
});
