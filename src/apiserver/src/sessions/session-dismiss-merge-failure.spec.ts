import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

function harness(found: boolean, count: number) {
  const writes: unknown[] = [];
  const published: string[] = [];
  const prisma = {
    session: {
      findFirst: async () => (found ? { id: SESSION_ID, ownerId: OWNER_ID, sessionKind: 'WORK' } : null),
      updateMany: async (args: unknown) => {
        writes.push(args);
        return { count };
      },
    },
  } as never;
  const realtime = { publishSessionUpdated: (id: string) => published.push(id) } as never;
  return { service: new SessionsService(prisma, {} as never, realtime), writes, published };
}

test('closing a merge failure clears only a settled conflict or error with no recovery open', async () => {
  const { service, writes, published } = harness(true, 1);
  assert.deepEqual(await service.dismissMergeFailure(OWNER_ID, SESSION_ID), { ok: true, dismissed: true });
  assert.deepEqual(writes, [{
    where: {
      id: SESSION_ID,
      ownerId: OWNER_ID,
      mergeStatus: { in: ['conflict', 'error'] },
      mergeRecovery: { equals: Prisma.AnyNull },
    },
    data: { mergeStatus: null, mergeError: null, mergeOperationId: null, mergeOperationOwner: null },
  }]);
  assert.deepEqual(published, [SESSION_ID]);
});

test('closing it again, or after a newer merge, changes nothing and announces nothing', async () => {
  const { service, published } = harness(true, 0);
  assert.deepEqual(await service.dismissMergeFailure(OWNER_ID, SESSION_ID), { ok: true, dismissed: false });
  assert.deepEqual(published, []);
});

test("another owner's session is not found", async () => {
  const { service, writes } = harness(false, 0);
  await assert.rejects(service.dismissMergeFailure(OWNER_ID, SESSION_ID), NotFoundException);
  assert.deepEqual(writes, []);
});
