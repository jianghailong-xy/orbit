import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunnerApiController } from './runner-api.controller';

/**
 * POST /runner/sessions/:id/import-result — the checkout the runner's transcript-import step
 * makes when it is done. `ok` clears the `importSourceCwd` marker with a CAS on the pending
 * state, so a retried ok after a lost reply is a no-op (`applied: false`), and may carry the
 * real title read out of the transcript; a failure moves the session to Trash (FAILED +
 * deletedAt) with the reason, where /finalize's LIVE filter leaves it alone. Both sit behind the
 * same lease fence as every other runner write on a session.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const LEASE_OWNER = '9d9aa83d-913b-4b6e-9016-db94b21e8671';

function makeController(opts: {
  /** The tx's $queryRaw answer for the lease lock: row(s) with leaseOwnerMatches. */
  lock?: Array<{ id: string; leaseOwnerMatches: boolean }>;
  /** What the CAS updateMany answers. */
  updateManyCount?: number;
} = {}) {
  const updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const updateCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const published: string[] = [];
  const tx = {
    $queryRaw: async () => opts.lock ?? [{ id: SESSION_ID, leaseOwnerMatches: true }],
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

test('ok clears the pending marker with a CAS on importSourceCwd', async () => {
  const h = makeController();

  const response = await importResult(h.controller, { leaseOwner: LEASE_OWNER, ok: true });

  assert.deepEqual(response, { ok: true, applied: true, failed: false, announced: false });
  assert.equal(h.updateManyCalls.length, 1);
  assert.deepEqual(h.updateManyCalls[0].where, { id: SESSION_ID, importSourceCwd: { not: null } });
  assert.equal(h.updateManyCalls[0].data.importSourceCwd, null);
  assert.deepEqual(h.updateCalls, [], 'an ok never touches the session row itself');
  assert.deepEqual(h.published, [], 'no title change to announce');
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
