import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus, TaskStatus } from '@prisma/client';
import { SessionEndReason } from '@orbit/shared';
import { ReaperService } from './reaper.service';

for (const [taskStatus, expectedReason] of [
  [TaskStatus.DONE, SessionEndReason.TASK_DONE],
  [TaskStatus.CANCELLED, SessionEndReason.TASK_CANCELLED],
] as const) {
  test(`reaper records ${expectedReason} for a ${taskStatus} linked task`, async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const runnerId = '22222222-2222-4222-8222-222222222222';
    let claimWhere: Record<string, unknown> | undefined;
    let claimData: Record<string, unknown> | undefined;
    const tx = {
      session: {
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          claimWhere = where;
          claimData = data;
          return { count: 1 };
        },
      },
      conversationTurn: {
        findFirst: async () => ({ seq: 4 }),
        create: async ({ data }: { data: Record<string, unknown> }) => data,
      },
    };
    const prisma = {
      session: {
        findMany: async () => [
          {
            id: sessionId,
            taskId: '33333333-3333-4333-8333-333333333333',
            assignedRunnerId: runnerId,
            status: RunStatus.AWAITING_INPUT,
            provider: 'claude',
            runtimeSessionId: 'runtime-1',
            claudeSessionId: null,
            lastTurnAt: new Date(),
            cancelRequestedAt: null,
            endReason: null,
            task: { status: taskStatus },
            agent: { provider: 'claude' },
            assignedRunner: {
              status: 'ONLINE',
              lastHeartbeatAt: new Date(),
            },
          },
        ],
      },
      runEvent: { findFirst: async () => null },
      $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    } as never;
    let cancelRequests = 0;
    let inboxWakes = 0;
    const realtime = {
      requestCancel: () => cancelRequests++,
      notifyInbox: () => inboxWakes++,
    } as never;
    const service = new ReaperService(prisma, realtime);

    await (service as unknown as { sweep(): Promise<void> }).sweep();

    assert.equal(claimData?.endReason, expectedReason);
    assert.deepEqual((claimWhere?.task as { status: TaskStatus }).status, taskStatus);
    assert.equal(cancelRequests, 1);
    assert.equal(inboxWakes, 1);
  });
}
