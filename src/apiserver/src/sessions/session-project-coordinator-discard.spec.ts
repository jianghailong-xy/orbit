import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentWorkTerminalizationDouble } from '../test-support/prisma-transaction-double';
import { SessionsService } from './sessions.service';

const OWNER = '00000000-0000-7000-8000-000000000001';
const SESSION = '00000000-0000-7000-8000-0000000000b1';

function fixture(adopted: boolean) {
  const writes: Array<Record<string, unknown>> = [];
  const lifecycle: string[] = [];
  // Discarding a candidate ends the Session, and every end settles undelivered CURRENT_WORK. This
  // fixture has none queued, so both reads must still be answerable and neither write may fire.
  const currentWork = currentWorkTerminalizationDouble();
  const row = {
    id: SESSION,
    ownerId: OWNER,
    status: 'PENDING',
    assignedRunnerId: null,
    cancelRequestedAt: null,
    endReason: null,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    titleManagedByProject: true,
  };
  const prisma: any = {
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(prisma),
    $queryRaw: async () => [{ id: SESSION }],
    $executeRaw: async () => 0,
    project: {
      findFirst: async () => (adopted ? { id: 'project-1' } : null),
    },
    session: {
      findUniqueOrThrow: async () => ({ ...row }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        Object.assign(row, data);
        return { ...row };
      },
    },
    conversationTurn: currentWork.conversationTurn,
  };
  const realtime: any = {
    notifyInbox: () => undefined,
    requestCancel: () => undefined,
    publishSessionUpdated: () => undefined,
    publishQueuedTurnsChanged: () => undefined,
    publishSessionLifecycleChanged: (id: string) => lifecycle.push(id),
  };
  return {
    service: new SessionsService(prisma, {} as never, realtime),
    writes,
    lifecycle,
    currentWork,
  };
}

test('an unbound coordinator candidate clears title ownership and enters Trash atomically', async () => {
  const f = fixture(false);

  assert.equal(await f.service.discardProjectCoordinatorCandidate(OWNER, SESSION), true);

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].titleManagedByProject, false);
  assert.ok(f.writes[0].deletedAt instanceof Date);
  assert.equal(f.writes[0].status, 'CANCELLED');
  assert.deepEqual(f.lifecycle, [SESSION]);
});

test('an adopted coordinator candidate is preserved without any Session write', async () => {
  const f = fixture(true);

  assert.equal(await f.service.discardProjectCoordinatorCandidate(OWNER, SESSION), false);

  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.lifecycle, []);
});

test('discarding an unbound candidate asks both CURRENT_WORK ledgers and writes to neither', async () => {
  const f = fixture(false);

  await f.service.discardProjectCoordinatorCandidate(OWNER, SESSION);

  // The read happens even though the answer is empty: the delegate has to exist for real, and
  // the historical drift was a double that only owned `updateMany` and so never proved the read.
  assert.equal(f.currentWork.calls.steerFinds.length, 1);
  // Ending the Session still answers its open turns — that write is not a delivery receipt. With
  // no candidate to settle, no terminal CURRENT_WORK receipt may be written.
  const receipts = f.currentWork.calls.steerWrites.filter(
    (write) => 'deliveryStatus' in (write.data as Record<string, unknown>),
  );
  assert.deepEqual(receipts, []);
});
