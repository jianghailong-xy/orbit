/**
 * Which writes of a runner's answer end the operation and which leave it for the runner to send again (contract
 * `repoOps.unsettled`): a write the database refused fails the operation and is answered 422; a conflict the
 * database rolled back, and the database itself failing, are not the answer's fault — they pass through
 * untouched, and the runner's retry is what settles the operation. The refusals and the rows are
 * wiki-repo-op-nul.pg.spec.ts; this is the decision, over a Prisma that fails as told.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrismaService } from '../prisma/prisma.service';
import { WikiRepoOpRefused, WikiRepoOps } from './wiki-repo-ops';

const OP = '01a11e00-0000-7000-8000-000000000001';
const LEASE = '01a11e00-0000-7000-8000-0000000000aa';
const RUNNER = '01a11e00-0000-7000-8000-0000000000bb';

/** A Prisma whose settle fails with `fault` on its first read, and whose close of the operation succeeds. */
function failing(fault: unknown): { prisma: PrismaService; closes: Array<Record<string, unknown>>; settles: () => number } {
  const closes: Array<Record<string, unknown>> = [];
  let settles = 0;
  const tx = {
    wikiRepoOp: {
      findFirst: async () => {
        settles += 1;
        throw fault;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        closes.push({ ...args.where, ...args.data });
        return { count: 1 };
      },
    },
    wikiRepoOpFragment: { deleteMany: async () => ({ count: 0 }) },
    $executeRaw: async () => 1,
  };
  const prisma = { $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) } as unknown as PrismaService;
  return { prisma, closes, settles: () => settles };
}

function result(ops: WikiRepoOps): Promise<unknown> {
  return ops.applyWikiRepoOpResult({
    id: OP,
    runnerId: RUNNER,
    body: { claimGeneration: 3, leaseOwner: LEASE, state: 'succeeded', result: { diff: { from: 'a', to: 'b', files: [], docs: [] } } },
  });
}

test('a write the database refuses ends the operation failed, under the claim, and is answered UNSTORABLE_RESULT', async () => {
  const refused = Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' });
  const db = failing(refused);
  await assert.rejects(result(new WikiRepoOps(db.prisma)), (error: unknown) => {
    assert.ok(error instanceof WikiRepoOpRefused);
    assert.equal(error.refusal, 'UNSTORABLE_RESULT');
    assert.match(error.message, /could not store the runner's result: 22P05 unsupported Unicode escape sequence; the operation is failed$/u);
    return true;
  });
  assert.equal(db.settles(), 1, 'a refusal is not retried: the data would answer the same');
  assert.equal(db.closes.length, 1);
  assert.deepEqual(
    { ...db.closes[0], endedAt: undefined },
    {
      id: OP, state: 'failed', leaseOwner: null, claimGeneration: 3, runnerId: RUNNER,
      result: db.closes[0].result, error: 'the server could not store the runner\'s result: 22P05 unsupported Unicode escape sequence',
      claimedAt: null, heartbeatAt: null, endedAt: undefined,
    },
  );
});

test('a conflict the database rolled back passes through untouched, for the runner to send again', async () => {
  const conflict = Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
  const db = failing(conflict);
  await assert.rejects(result(new WikiRepoOps(db.prisma)), (error: unknown) => error === conflict);
  assert.ok(db.settles() > 1, 'the transaction was tried again first');
  assert.deepEqual(db.closes, [], 'and the operation was not failed: nothing was refused');
});

test('the database itself failing passes through untouched too: the write did not happen, it was not refused', async () => {
  const gone = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
  const db = failing(gone);
  await assert.rejects(result(new WikiRepoOps(db.prisma)), (error: unknown) => error === gone);
  assert.deepEqual(db.closes, []);
});

test('a claim that names no lease closes nothing: the refusal is answered as it was', async () => {
  const db = failing(new Error('never reached'));
  await assert.rejects(
    new WikiRepoOps(db.prisma).applyWikiRepoOpResult({ id: OP, runnerId: RUNNER, body: { state: 'bogus' } }),
    (error: unknown) => error instanceof WikiRepoOpRefused && error.refusal === 'INVALID_RESULT' && error.message === 'bogus is not a result',
  );
  assert.deepEqual(db.closes, []);
});
