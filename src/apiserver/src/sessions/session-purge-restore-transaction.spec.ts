import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

function makeHarness() {
  const state = {
    exists: true,
    archivedAt: new Date('2026-08-01T09:00:00.000Z') as Date | null,
    deletedAt: new Date('2026-08-01T10:00:00.000Z') as Date | null,
  };
  let deletes = 0;
  let restoreEvents = 0;
  const tx = {
    $queryRaw: async () =>
      state.exists ? [{ id: SESSION_ID, deletedAt: state.deletedAt }] : [],
    session: {
      update: async ({ data }: { data: { archivedAt: null; deletedAt: null } }) => {
        assert.equal(state.exists, true);
        state.archivedAt = data.archivedAt;
        state.deletedAt = data.deletedAt;
        return { id: SESSION_ID };
      },
      delete: async () => {
        assert.equal(state.exists, true);
        deletes++;
        state.exists = false;
        return { id: SESSION_ID };
      },
    },
  };
  // Model the database row lock by running transactions in acquisition order.
  let tail: Promise<void> = Promise.resolve();
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(tx);
      } finally {
        release();
      }
    },
  } as never;
  const realtime = {
    publishSessionCreated: () => {
      restoreEvents++;
    },
  } as never;
  return {
    service: new SessionsService(prisma, {} as never, realtime),
    state,
    deletes: () => deletes,
    restoreEvents: () => restoreEvents,
  };
}

test('restore winning the row lock makes the following purge fail its Trash guard', async () => {
  const h = makeHarness();

  const [restored, purged] = await Promise.allSettled([
    h.service.restore(OWNER_ID, SESSION_ID),
    h.service.purge(OWNER_ID, SESSION_ID),
  ]);

  assert.equal(restored.status, 'fulfilled');
  assert.equal(purged.status, 'rejected');
  assert.ok(
    purged.status === 'rejected' && purged.reason instanceof BadRequestException,
  );
  assert.equal(h.state.exists, true);
  assert.equal(h.state.archivedAt, null);
  assert.equal(h.state.deletedAt, null);
  assert.equal(h.deletes(), 0);
  assert.equal(h.restoreEvents(), 1);
});

test('purge winning the row lock deletes Trash and the following restore returns 404', async () => {
  const h = makeHarness();

  const [purged, restored] = await Promise.allSettled([
    h.service.purge(OWNER_ID, SESSION_ID),
    h.service.restore(OWNER_ID, SESSION_ID),
  ]);

  assert.equal(purged.status, 'fulfilled');
  assert.equal(restored.status, 'rejected');
  assert.ok(
    restored.status === 'rejected' && restored.reason instanceof NotFoundException,
  );
  assert.equal(h.state.exists, false);
  assert.equal(h.deletes(), 1);
  assert.equal(h.restoreEvents(), 0);
});
