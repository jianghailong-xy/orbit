import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { CLAIM_LEASE_MS, claimLeaseEnabled, requeueUnactivatedClaim } from '../common/claim-lease';
import { QueueService } from './queue.service';

/**
 * The claim lease, as the claim path writes and undoes it.
 *
 * The property under test is the one the incident is about: after `trySessionClaim` commits, the
 * session is RUNNING and holds a runner slot whether or not the runner was ever told. Everything
 * here is about what the server does with that fact — it writes a name for the handover, and when
 * the handover dies it takes it back under a compare-and-set that refuses every state the session
 * could have legitimately moved to in the meantime.
 *
 * The SQL these produce is asserted as text here and executed for real in
 * `session-claim-lease.pg.spec.ts`; neither is sufficient alone. A predicate that let everything
 * through would satisfy every regex below, and a statement that never compiled would satisfy none
 * of the pg spec's setup.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const CLAIM_TOKEN = '44444444-4444-4444-8444-444444444444';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Claimed {
  /** The bound parameters of the claim UPDATE, in order. */
  values: unknown[];
  /** Its literal segments, so a value can be found by the clause it sits in. */
  segments: readonly string[];
  /** Every statement issued outside the claim transaction, i.e. the compensation. */
  compensations: Prisma.Sql[];
  error?: Error;
}

/**
 * Run one claim whose `buildSession` fails immediately, and report what reached the database.
 *
 * `findUniqueOrThrow` is the first thing `buildSession` does, so throwing there stands in for the
 * whole class: every later step — the seed, the provider row, the model compare-and-set, the
 * credential, the runtime id — reaches this same catch. The pg spec injects them individually.
 */
async function claimThatFailsToBuild(options: {
  supportsClaimLease?: boolean;
  flag?: string;
  claimedRow?: boolean;
  compensationFails?: boolean;
} = {}): Promise<Claimed> {
  const previous = process.env.ORBIT_CLAIM_LEASE;
  if (options.flag === undefined) delete process.env.ORBIT_CLAIM_LEASE;
  else process.env.ORBIT_CLAIM_LEASE = options.flag;
  const captured: Claimed = { values: [], segments: [], compensations: [] };
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (statement: Prisma.Sql) => {
      captured.values = statement.values;
      captured.segments = statement.strings;
      return options.claimedRow === false ? [] : [{ id: SESSION_ID }];
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    $executeRaw: async (statement: Prisma.Sql) => {
      captured.compensations.push(statement);
      if (options.compensationFails) throw new Error('compensation lost the connection');
      return 1;
    },
    session: {
      findUniqueOrThrow: async () => {
        throw new Error('build step failed');
      },
    },
  } as never;
  const queue = new QueueService(prisma);
  try {
    await queue.claimSessionForRunner(
      { id: RUNNER_ID },
      0,
      false,
      options.supportsClaimLease ?? false,
    );
  } catch (err) {
    captured.error = err as Error;
  } finally {
    if (previous === undefined) delete process.env.ORBIT_CLAIM_LEASE;
    else process.env.ORBIT_CLAIM_LEASE = previous;
  }
  return captured;
}

/** The value bound immediately ahead of the literal that contains `marker`. */
function boundBefore(captured: Claimed, marker: string): unknown {
  const at = captured.segments.findIndex((segment) => segment.includes(marker));
  assert.notEqual(at, -1, `no claim SQL segment contains ${marker}`);
  return captured.values[at - 1];
}

test('a claim names the handover it is, and arms a deadline only for a runner that activates', async () => {
  const capable = await claimThatFailsToBuild({ supportsClaimLease: true });
  const token = boundBefore(capable, '::uuid,');
  assert.match(String(token), UUID, 'the claim writes a token identifying this handover');
  assert.equal(boundBefore(capable, '::boolean THEN now()'), true);
  assert.equal(boundBefore(capable, "* interval '1 millisecond'"), CLAIM_LEASE_MS);

  // A runner that never advertised the capability may never have a session taken back by the
  // watchdog — it has no obligation to activate, so an unactivated claim says nothing about it.
  // It still gets a token: the synchronous compensation below runs before that runner is handed
  // anything, so it is safe for every version.
  const legacy = await claimThatFailsToBuild({ supportsClaimLease: false });
  assert.match(String(boundBefore(legacy, '::uuid,')), UUID);
  assert.equal(boundBefore(legacy, '::boolean THEN now()'), false);
});

test('the deadline is computed by the database, not by the API replica', async () => {
  const capable = await claimThatFailsToBuild({ supportsClaimLease: true });
  const sql = capable.segments.join('?');
  assert.match(sql, /"claim_lease_expires_at" = CASE\s+WHEN \?::boolean THEN now\(\)/);
  // Two replicas whose clocks disagree would otherwise disagree about which claims have expired;
  // the reaper compares against `now()` too.
  assert.doesNotMatch(sql, /claim_lease_expires_at" = '\d{4}-/);
});

test('a failed build puts the claim back, and reports the failure that caused it', async () => {
  const captured = await claimThatFailsToBuild({ supportsClaimLease: true });
  assert.equal(captured.error?.message, 'build step failed', 'the original failure is not swallowed');
  assert.equal(captured.compensations.length, 1);
  const sql = captured.compensations[0].strings.join('?');
  assert.match(sql, /UPDATE "session" SET\s+status = 'PENDING'/);
  assert.match(sql, /"claim_token" = NULL/);
  assert.match(sql, /"claim_lease_expires_at" = NULL/);
  // The token the claim minted is what the compensation is entitled to undo.
  assert.equal(captured.compensations[0].values[1], boundBefore(captured, '::uuid,'));
});

test('a compensation that itself fails does not replace the failure it was compensating', async () => {
  const captured = await claimThatFailsToBuild({ supportsClaimLease: true, compensationFails: true });
  assert.equal(captured.error?.message, 'build step failed');
  // For a capable runner the lease deadline is the backstop for exactly this; for a legacy one the
  // outcome is what it was before the lease existed. Neither is improved by hiding the real error.
});

test('the rollback flag returns the claim path to what it was', async () => {
  const off = await claimThatFailsToBuild({ supportsClaimLease: true, flag: 'off' });
  assert.equal(boundBefore(off, '::uuid,'), null, 'no token is written');
  assert.equal(boundBefore(off, '::boolean THEN now()'), false, 'no deadline is armed');
  assert.deepEqual(off.compensations, [], 'and nothing is compensated');
  assert.equal(off.error?.message, 'build step failed');
  assert.equal(claimLeaseEnabled(), true, 'the flag is read per call, not captured at import');
});

test('an empty queue compensates nothing', async () => {
  const captured = await claimThatFailsToBuild({ supportsClaimLease: true, claimedRow: false });
  assert.equal(captured.error, undefined);
  assert.deepEqual(captured.compensations, []);
});

test('the compensation refuses every state the session could have moved to', () => {
  const sql = requeueUnactivatedClaim(SESSION_ID, CLAIM_TOKEN, false).strings.join('?');
  // Activated, re-claimed, or moved into a new inbox generation — all of which change or clear it.
  assert.match(sql, /AND "claim_token" = \?::uuid/);
  // Resumed (already PENDING) or finalized (terminal).
  assert.match(sql, /AND status = 'RUNNING'/);
  // Cancelled: it must settle, not go back into a queue that excludes it anyway.
  assert.match(sql, /AND "cancel_requested_at" IS NULL/);
  // And it addresses exactly one row.
  assert.match(sql, /WHERE id = \?::uuid/);
});

test('only the watchdog checks the deadline, and it checks it against the database clock', () => {
  const immediate = requeueUnactivatedClaim(SESSION_ID, CLAIM_TOKEN, false);
  const expired = requeueUnactivatedClaim(SESSION_ID, CLAIM_TOKEN, true);
  // Same statement, one predicate apart: the claim's own compensation is entitled to undo a
  // handover the moment it fails, and only the sweep has to wait for a deadline.
  assert.equal(immediate.strings.join('?'), expired.strings.join('?'));
  assert.deepEqual(immediate.values, [SESSION_ID, CLAIM_TOKEN, true]);
  assert.deepEqual(expired.values, [SESSION_ID, CLAIM_TOKEN, false]);
  assert.match(
    immediate.strings.join('?'),
    /\?\s+OR \("claim_lease_expires_at" IS NOT NULL AND "claim_lease_expires_at" <= now\(\)\)/,
  );
});
