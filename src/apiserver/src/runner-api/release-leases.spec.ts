import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { RunnerApiController } from './runner-api.controller';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';

function makeController(assignedRunnerId: string | null = RUNNER_ID) {
  const calls: string[] = [];
  let updateArgs: unknown;
  let notifiedSessionId: string | undefined;
  const prisma = {
    session: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        calls.push(`ownership:${where.id}`);
        return assignedRunnerId === null ? null : { id: where.id, assignedRunnerId };
      },
    },
    conversationTurn: {
      updateMany: async (args: unknown) => {
        calls.push('update');
        updateArgs = args;
        return { count: 1 };
      },
    },
  } as never;
  const realtime = {
    notifyInbox: (sessionId: string) => {
      calls.push('notify');
      notifiedSessionId = sessionId;
    },
  } as never;

  return {
    calls,
    controller: new RunnerApiController(
      prisma,
      {} as never,
      realtime,
      {} as never,
      {} as never,
    ),
    notifiedSessionId: () => notifiedSessionId,
    updateArgs: () => updateArgs,
  };
}

test('release-leases verifies ownership, expires only executable input leases, and wakes the inbox', async () => {
  const h = makeController();
  const before = Date.now();

  const result = await h.controller.releaseLeases({ id: RUNNER_ID }, SESSION_ID);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(h.calls, [`ownership:${SESSION_ID}`, 'update', 'notify']);
  assert.equal(h.notifiedSessionId(), SESSION_ID);
  const args = h.updateArgs() as {
    where: unknown;
    data: { leaseDeadlineAt: Date };
  };
  assert.deepEqual(args.where, {
    sessionId: SESSION_ID,
    kind: { in: ['message', 'shell'] },
    status: 'IN_FLIGHT',
  });
  assert.ok(args.data.leaseDeadlineAt instanceof Date);
  assert.ok(args.data.leaseDeadlineAt.getTime() < before);
});

test('release-leases does not mutate or notify when the runner does not own the session', async () => {
  const h = makeController('another-runner');

  await assert.rejects(
    h.controller.releaseLeases({ id: RUNNER_ID }, SESSION_ID),
    ForbiddenException,
  );

  assert.deepEqual(h.calls, [`ownership:${SESSION_ID}`]);
  assert.equal(h.updateArgs(), undefined);
  assert.equal(h.notifiedSessionId(), undefined);
});
