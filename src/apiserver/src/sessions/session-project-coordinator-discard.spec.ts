import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionsService } from './sessions.service';

const OWNER = '00000000-0000-7000-8000-000000000001';
const SESSION = '00000000-0000-7000-8000-0000000000b1';

function fixture(adopted: boolean) {
  const writes: Array<Record<string, unknown>> = [];
  const lifecycle: string[] = [];
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
    conversationTurn: { updateMany: async () => ({ count: 0 }) },
  };
  const realtime: any = {
    notifyInbox: () => undefined,
    requestCancel: () => undefined,
    publishSessionUpdated: () => undefined,
    publishSessionLifecycleChanged: (id: string) => lifecycle.push(id),
  };
  return {
    service: new SessionsService(prisma, {} as never, realtime),
    writes,
    lifecycle,
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
