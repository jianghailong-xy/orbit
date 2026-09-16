import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunnerApiController } from './runner-api.controller';

/**
 * POST /runner/sessions/:id/import-result — the checkout the runner's transcript-import step
 * makes when it is done. `ok` clears the `importSourceCwd` marker with a CAS on the pending
 * state, so a retried ok after a lost reply is a no-op (`applied: false`), may carry the real
 * title read out of the transcript, and parks the session — AWAITING_INPUT, or PENDING when a
 * message is already queued — because the import is the whole of that claim's work and it spawns
 * no engine, so nothing else will ever move the row off RUNNING. A failure moves the session to
 * Trash (FAILED + deletedAt) with the reason, where /finalize's LIVE filter leaves it alone. All
 * of it sits behind the same lease fence as every other runner write on a session.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const LEASE_OWNER = '9d9aa83d-913b-4b6e-9016-db94b21e8671';

function makeController(opts: {
  /** The tx's $queryRaw answer for the lease lock: row(s) with leaseOwnerMatches. */
  lock?: Array<{ id: string; leaseOwnerMatches: boolean }>;
  /** What the CAS updateMany answers. */
  updateManyCount?: number;
  /** Executable turns still queued for the session when the import settles. */
  pendingTurns?: number;
} = {}) {
  const updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const updateCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const published: string[] = [];
  const tx = {
    $queryRaw: async () => opts.lock ?? [{ id: SESSION_ID, leaseOwnerMatches: true }],
    conversationTurn: { count: async () => opts.pendingTurns ?? 0 },
    session: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updateManyCalls.push(args);
        return { count: opts.updateManyCount ?? 1 };
      },
      update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updateCalls.push(args);
        return { id: SESSION_ID };
      },
    },
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) } as never;
  const realtime = { publishSessionUpdated: (id: string) => published.push(id) } as never;
  return {
    controller: new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never),
    updateManyCalls,
    updateCalls,
    published,
  };
}

function importResult(
  controller: RunnerApiController,
  dto: { leaseOwner?: string; ok?: boolean; error?: string; title?: string },
) {
  return controller.importResult({ id: RUNNER_ID }, SESSION_ID, dto);
}

test('ok clears the pending marker with a CAS, and parks the session it was holding', async () => {
  const h = makeController();

  const response = await importResult(h.controller, { leaseOwner: LEASE_OWNER, ok: true });

  assert.deepEqual(response, { ok: true, applied: true, failed: false, announced: true });
  assert.equal(h.updateManyCalls.length, 1);
  assert.deepEqual(h.updateManyCalls[0].where, {
    id: SESSION_ID,
    importSourceCwd: { not: null },
    // The claim set the row RUNNING; a row another writer already finalized is not this
    // receipt's to move, and must not be resurrected as claimable.
    status: RunStatus.RUNNING,
  });
  assert.equal(h.updateManyCalls[0].data.importSourceCwd, null);
  assert.equal(
    h.updateManyCalls[0].data.status,
    RunStatus.AWAITING_INPUT,
    'the import is the whole claim and spawns no engine: nothing else moves the row off RUNNING',
  );
  assert.deepEqual(h.updateCalls, [], 'an ok never touches the session row itself');
  assert.deepEqual(h.published, [SESSION_ID], 'the parked status is a change every client reconciles');
});

test('a message already queued when the import lands keeps the session claimable', async () => {
  // Somebody typed while the import was running: the turn is filed, and with no engine to
  // consume it a parked session would never run it. PENDING is what hands it to a claim.
  const h = makeController({ pendingTurns: 1 });

  await importResult(h.controller, { leaseOwner: LEASE_OWNER, ok: true });

  assert.equal(h.updateManyCalls[0].data.status, RunStatus.PENDING);
});

test('ok may carry the real transcript title, which wins and is announced', async () => {
  const h = makeController();

  const response = await importResult(h.controller, {
    leaseOwner: LEASE_OWNER,
    ok: true,
    title: '基于第一性原理的设计',
  });

  assert.equal(response.applied, true);
  assert.equal(response.announced, true);
  assert.equal(h.updateManyCalls[0].data.title, '基于第一性原理的设计');
  assert.deepEqual(h.published, [SESSION_ID]);
});

test('a retried ok after a lost reply applies nothing (the CAS matches no row)', async () => {
  // The runner crashed between the POST and its reply: the marker is already cleared, so the
  // replayed ok must not re-apply the title or re-announce.
  const h = makeController({ updateManyCount: 0 });

  const response = await importResult(h.controller, {
    leaseOwner: LEASE_OWNER,
    ok: true,
    title: 'again',
  });

  assert.deepEqual(response, { ok: true, applied: false, failed: false, announced: false });
  assert.deepEqual(h.published, []);
});

test('a failed import Trashes the session with the runner’s reason', async () => {
  const h = makeController();

  const response = await importResult(h.controller, {
    leaseOwner: LEASE_OWNER,
    ok: false,
    error: 'transcript holds no conversation',
  });

  assert.deepEqual(response, { ok: true, applied: false, failed: true, announced: true });
  assert.equal(h.updateCalls.length, 1);
  assert.equal(h.updateCalls[0].where.id, SESSION_ID);
  assert.equal(h.updateCalls[0].data.status, RunStatus.FAILED);
  assert.equal(h.updateCalls[0].data.error, 'transcript holds no conversation');
  assert.ok(h.updateCalls[0].data.deletedAt instanceof Date, 'the failed import goes to Trash');
  assert.deepEqual(h.published, [SESSION_ID]);
});

test('a failure with no reason still records one', async () => {
  const h = makeController();

  await importResult(h.controller, { leaseOwner: LEASE_OWNER, ok: false });

  assert.equal(h.updateCalls[0].data.error, 'import failed');
});

test('a runner that no longer owns the session lease cannot settle its import', async () => {
  const h = makeController({ lock: [{ id: SESSION_ID, leaseOwnerMatches: false }] });

  await assert.rejects(
    importResult(h.controller, { leaseOwner: LEASE_OWNER, ok: true }),
    (err: unknown) => err instanceof ConflictException,
  );
  assert.deepEqual(h.updateManyCalls, []);
  assert.deepEqual(h.updateCalls, []);
});

test('a session hosted on another runner cannot be settled', async () => {
  const h = makeController({ lock: [] });

  await assert.rejects(
    importResult(h.controller, { leaseOwner: LEASE_OWNER, ok: true }),
    (err: unknown) => err instanceof ForbiddenException,
  );
  assert.deepEqual(h.updateManyCalls, []);
});
