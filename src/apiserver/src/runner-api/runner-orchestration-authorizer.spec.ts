import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

const RUNNER = { id: 'runner-1', ownerId: 'owner-1' } as never;

function makeAuthorizer(result: { id: string } | null) {
  const lookups: Array<Record<string, unknown>> = [];
  const prisma = {
    session: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        lookups.push(where);
        return result;
      },
    },
  };
  return {
    authorizer: new RunnerOrchestrationAuthorizer(prisma as never),
    lookups,
  };
}

test('orchestration authorization requires an explicit calling session', async () => {
  const { authorizer, lookups } = makeAuthorizer({ id: 'unused' });
  await assert.rejects(
    () => authorizer.assert(RUNNER, undefined),
    (error: unknown) =>
      error instanceof BadRequestException && error.message === 'missing session context',
  );
  assert.deepEqual(lookups, []);
});

test('orchestration authorization is bound to a live, non-deleted session and its current agent', async () => {
  const { authorizer, lookups } = makeAuthorizer({ id: 'caller-session' });
  assert.equal(await authorizer.assert(RUNNER, 'caller-session'), 'caller-session');
  assert.deepEqual(lookups, [
    {
      id: 'caller-session',
      ownerId: 'owner-1',
      assignedRunnerId: 'runner-1',
      deletedAt: null,
      cancelRequestedAt: null,
      status: {
        in: [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED],
      },
      agent: { enableOrchestration: true, deletedAt: null },
    },
  ]);
});

test('orchestration authorization fails closed when no current database row satisfies every guard', async () => {
  const { authorizer } = makeAuthorizer(null);
  await assert.rejects(
    () => authorizer.assert(RUNNER, 'caller-session'),
    (error: unknown) =>
      error instanceof ForbiddenException &&
      error.message === 'orchestration is not enabled for this session',
  );
});
