/**
 * ACCOUNT HEALTH ON POSTGRESQL (docs/routing-account-health-design.md §6, as amended in §11).
 *
 *   (1) Two dispatches race for one due trial and exactly one claims it; the other is told the trial is held. Raced
 *       under a held row lock, so both UPDATEs are in flight at once, and then twenty times unforced.
 *   (2) The ladders through the real service: a classified refusal blocks for 1 h and each refused trial climbs to
 *       the 24 h cap; the breaker goes suspect, trips at its second strike and climbs 30 min … 24 h; a breaker streak
 *       then a classified refusal continues on the classified column at the shared count.
 *   (3) Any success clears the row (SUCCESS) and the next refusal is trip 1; a run out row is stamped EXPIRED.
 *   (4) Idempotent per session, also after the row was cleared; TRANSPORT writes nothing; CAPACITY cools one model's
 *       own row for 5 minutes and never trips; the partial unique index admits one live row per subject and scope.
 *   (5) A trial claim whose session never started is free again after 15 minutes; a trial that ended some other way
 *       is released and due again.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/providers/account-health.service.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { type PrismaClient, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  type AccountHealthFailure,
  type AccountHealthSubject,
  type HealthFailureKind,
  CAPACITY_COOLDOWN_MS,
  subjectKey,
  TRIAL_CLAIM_STALE_MS,
} from './account-health';
import { AccountHealthService } from './account-health.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CLASSIFIED = [1, 2, 4, 8, 16, 24, 24, 24].map((h) => h * HOUR);
const BREAKER = [0.5, 1, 2, 4, 8, 16, 24, 24].map((h) => h * HOUR);

test('account health: the trial claim race, the ladders, resets and cool-downs on PostgreSQL', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  // A second client for the second dispatch: its own connections, as a second API replica would have.
  const other: PrismaClient = prismaClientFor(url);
  const health = new AccountHealthService(db as unknown as PrismaService);
  const rival = new AccountHealthService(other as unknown as PrismaService);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await other.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** An owner and a runner with a Cursor account on it: the incident's subject. */
  async function account(label: string): Promise<{ ownerId: string; subject: AccountHealthSubject }> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@health.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: { id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE, maxConcurrent: 4 },
    });
    return { ownerId, subject: { type: 'runner', runnerId, engine: 'cursor', account: 'default' } };
  }
  const failure = (kind: HealthFailureKind | null, extra: Partial<AccountHealthFailure> = {}): AccountHealthFailure => ({
    sessionId: randomUUID(), kind, admission: true, runnerOnline: true, ...extra,
  });
  const rows = (ownerId: string) => db.accountHealth.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } });
  const liveRow = async (ownerId: string, scopeModel = '') =>
    db.accountHealth.findFirst({ where: { ownerId, scopeModel, clearedAt: null } });

  /** A refused trial: claimed by its dispatch at the end of the block, then refused with `kind`. */
  async function refusedTrial(ownerId: string, subject: AccountHealthSubject, kind: HealthFailureKind | null): Promise<Date> {
    const row = (await liveRow(ownerId))!;
    const at = row.blockedUntil!;
    const trial = failure(kind);
    assert.equal(await health.claimTrial(ownerId, subject, '', trial.sessionId, at), 'CLAIMED');
    await health.recordFailure(ownerId, subject, trial, at);
    return at;
  }

  await t.test('(1) two dispatches race for one due trial and exactly one claims it', async () => {
    const { ownerId, subject } = await account('race');
    const t0 = new Date('2026-11-22T17:19:00.000Z');
    await health.recordFailure(ownerId, subject, failure('ACCOUNT_ACTION_REQUIRED', { said: 'Add a payment method to continue' }), t0);
    const row = (await liveRow(ownerId))!;
    const due = row.blockedUntil!;
    assert.equal(await health.claimTrial(ownerId, subject, '', randomUUID(), new Date(due.getTime() - 1)), 'NOT_DUE', 'not before the block ends');

    // Forced overlap: hold the row, start both claims, let go. Both UPDATEs are waiting on the same row lock.
    await sql.query('BEGIN');
    await sql.query('SELECT 1 FROM "account_health" WHERE "id" = $1 FOR UPDATE', [row.id]);
    const first = randomUUID();
    const second = randomUUID();
    const racing = Promise.all([
      health.claimTrial(ownerId, subject, '', first, due),
      rival.claimTrial(ownerId, subject, '', second, due),
    ]);
    // Both are blocked on the lock: wait until PostgreSQL shows two waiters on it.
    for (let i = 0; ; i += 1) {
      const waiting = await db.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS "n" FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%UPDATE "account_health" AS h%'`;
      if (waiting[0].n >= 2) break;
      assert.ok(i < 200, 'both claims reach the row lock');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await sql.query('COMMIT');
    const answers = await racing;
    assert.deepEqual([...answers].sort(), ['CLAIMED', 'HELD'], `one claims, one is told it is held: ${answers}`);
    const claimed = (await liveRow(ownerId))!;
    assert.equal(claimed.trialSessionId, answers[0] === 'CLAIMED' ? first : second);
    // The loser routes elsewhere; asking again is still HELD, and the winner asking again keeps its claim.
    assert.equal(await rival.claimTrial(ownerId, subject, '', randomUUID(), due), 'HELD');
    assert.equal(await health.claimTrial(ownerId, subject, '', claimed.trialSessionId!, due), 'CLAIMED');

    // Unforced, twenty rounds: each round a fresh due block and two dispatches at once.
    for (let round = 0; round < 20; round += 1) {
      const { ownerId: owner, subject: subj } = await account(`race-${round}`);
      await health.recordFailure(owner, subj, failure('CREDENTIAL_REFUSED'), t0);
      const at = (await liveRow(owner))!.blockedUntil!;
      const both = await Promise.all([
        health.claimTrial(owner, subj, '', randomUUID(), at),
        rival.claimTrial(owner, subj, '', randomUUID(), at),
      ]);
      assert.deepEqual([...both].sort(), ['CLAIMED', 'HELD'], `round ${round}: ${both}`);
    }
  });

  await t.test('(2) the classified ladder and the breaker ladder to their 24 h caps, and a breaker-then-classified streak', async () => {
    const t0 = new Date('2026-11-22T17:19:00.000Z');
    {
      const { ownerId, subject } = await account('classified');
      await health.recordFailure(ownerId, subject, failure('ACCOUNT_ACTION_REQUIRED', { said: 'Add a payment method to continue' }), t0);
      let at = t0;
      for (let trip = 1; trip <= CLASSIFIED.length; trip += 1) {
        if (trip > 1) at = await refusedTrial(ownerId, subject, 'ACCOUNT_ACTION_REQUIRED');
        const row = (await liveRow(ownerId))!;
        assert.equal(row.state, 'BLOCKED');
        assert.equal(row.trips, trip);
        assert.equal(row.blockedUntil!.getTime() - at.getTime(), CLASSIFIED[trip - 1], `classified trip ${trip}`);
        assert.equal(row.trialSessionId, null, 'a refused trial leaves no claim');
        assert.equal(row.said, 'Add a payment method to continue', 'the provider\'s words carry through the streak');
      }
      assert.equal((await rows(ownerId)).length, 1, 'one row carries the whole streak');
    }
    {
      const { ownerId, subject } = await account('breaker');
      await health.recordFailure(ownerId, subject, failure(null), t0);
      const suspect = (await liveRow(ownerId))!;
      assert.equal(suspect.state, 'SUSPECT');
      assert.equal(suspect.strikes, 1);
      assert.equal(suspect.blockedUntil, null);
      const second = new Date(t0.getTime() + 5 * MINUTE);
      await health.recordFailure(ownerId, subject, failure(null), second);
      let at = second;
      for (let trip = 1; trip <= BREAKER.length; trip += 1) {
        if (trip > 1) at = await refusedTrial(ownerId, subject, null);
        const row = (await liveRow(ownerId))!;
        assert.equal(row.state, 'BLOCKED');
        assert.equal(row.kind, 'UNCLASSIFIED_ADMISSION');
        assert.equal(row.trips, trip);
        assert.equal(row.blockedUntil!.getTime() - at.getTime(), BREAKER[trip - 1], `breaker trip ${trip}`);
      }
    }
    {
      const { ownerId, subject } = await account('streak');
      await health.recordFailure(ownerId, subject, failure(null), t0);
      await health.recordFailure(ownerId, subject, failure(null), t0);
      await refusedTrial(ownerId, subject, null);
      await refusedTrial(ownerId, subject, null);
      assert.equal((await liveRow(ownerId))!.trips, 3);
      const at = await refusedTrial(ownerId, subject, 'ACCOUNT_ACTION_REQUIRED');
      const row = (await liveRow(ownerId))!;
      assert.equal(row.trips, 4);
      assert.equal(row.kind, 'ACCOUNT_ACTION_REQUIRED');
      assert.equal(row.blockedUntil!.getTime() - at.getTime(), 8 * HOUR, 'trip 4 of the classified column');
    }
  });

  await t.test('(3) any success resets the ladder; a row that ran out is stamped EXPIRED', async () => {
    const t0 = new Date('2026-11-22T17:19:00.000Z');
    const { ownerId, subject } = await account('reset');
    await health.recordFailure(ownerId, subject, failure('ACCOUNT_ACTION_REQUIRED'), t0);
    await refusedTrial(ownerId, subject, 'ACCOUNT_ACTION_REQUIRED');
    await refusedTrial(ownerId, subject, 'ACCOUNT_ACTION_REQUIRED');
    const before = (await liveRow(ownerId))!;
    assert.equal(before.trips, 3);
    const trialAt = before.blockedUntil!;
    assert.equal(await health.claimTrial(ownerId, subject, '', randomUUID(), trialAt), 'CLAIMED');
    await health.recordSuccess(ownerId, subject, 'gpt-5', trialAt);
    assert.equal(await liveRow(ownerId), null);
    const cleared = (await rows(ownerId))[0];
    assert.equal(cleared.clearedBy, 'SUCCESS');
    assert.equal(cleared.trialSessionId, null);
    assert.deepEqual(await health.live(ownerId, trialAt), []);
    const later = new Date(trialAt.getTime() + MINUTE);
    await health.recordFailure(ownerId, subject, failure('ACCOUNT_ACTION_REQUIRED'), later);
    const fresh = (await liveRow(ownerId))!;
    assert.equal(fresh.trips, 1, 'the next refusal is trip 1');
    assert.equal(fresh.blockedUntil!.getTime() - later.getTime(), 1 * HOUR);

    // A suspect period that ran out: the next strike stamps it EXPIRED and starts a new one.
    const { ownerId: o2, subject: s2 } = await account('expired');
    await health.recordFailure(o2, s2, failure(null), t0);
    const afterWindow = new Date(t0.getTime() + 61 * MINUTE);
    await health.recordFailure(o2, s2, failure(null), afterWindow);
    const [old, current] = await rows(o2);
    assert.equal(old.clearedBy, 'EXPIRED');
    assert.equal(current.state, 'SUSPECT');
    assert.equal(current.strikes, 1);
    assert.equal(current.clearedAt, null);
  });

  await t.test('(4) idempotent per session; TRANSPORT never strikes; CAPACITY cools one model and never trips', async () => {
    const t0 = new Date('2026-11-22T17:19:00.000Z');
    const { ownerId, subject } = await account('idempotent');
    const once = failure(null);
    await health.recordFailure(ownerId, subject, once, t0);
    await health.recordFailure(ownerId, subject, once, new Date(t0.getTime() + MINUTE));
    await health.recordFailure(ownerId, subject, once, new Date(t0.getTime() + 2 * MINUTE));
    const row = (await liveRow(ownerId))!;
    assert.equal(row.state, 'SUSPECT', 'a retried finalize is not a second strike');
    assert.equal(row.strikes, 1);
    // And after a success cleared its row, the retried finalize still writes nothing.
    await health.recordSuccess(ownerId, subject, null, new Date(t0.getTime() + 3 * MINUTE));
    await health.recordFailure(ownerId, subject, once, new Date(t0.getTime() + 4 * MINUTE));
    assert.equal(await liveRow(ownerId), null);

    const { ownerId: o2, subject: s2 } = await account('transport');
    for (let i = 0; i < 6; i += 1) await health.recordFailure(o2, s2, failure('TRANSPORT'), new Date(t0.getTime() + i * MINUTE));
    await health.recordFailure(o2, s2, failure(null, { runnerOnline: false }), t0);
    await health.recordFailure(o2, s2, failure(null, { admission: false }), t0);
    assert.deepEqual(await rows(o2), [], 'TRANSPORT, an offline runner and an admitted failure write nothing');

    const { ownerId: o3, subject: s3 } = await account('capacity');
    const model = 'gpt-5.5-codex';
    let at = t0;
    for (let i = 0; i < 6; i += 1) {
      at = new Date(t0.getTime() + i * 2 * MINUTE);
      await health.recordFailure(o3, s3, failure('CAPACITY', { model }), at);
    }
    const cool = (await liveRow(o3, model))!;
    assert.equal(cool.state, 'COOLDOWN');
    assert.equal(cool.trips, 0, 'never a trip');
    assert.equal(cool.blockedUntil!.getTime() - at.getTime(), CAPACITY_COOLDOWN_MS);
    assert.equal(await liveRow(o3, ''), null, 'the rest of the account stays usable');
    assert.equal(await health.claimTrial(o3, s3, model, randomUUID(), cool.blockedUntil!), 'NOT_DUE', 'a cool-down has no trial');
    assert.deepEqual((await health.live(o3, at)).map((e) => [e.scopeModel, e.view]), [[model, 'cooldown']]);
    assert.deepEqual(await health.live(o3, cool.blockedUntil!), [], 'when it runs out the model is simply a candidate');
    // A success on another model leaves this model's cool-down alone; one on this model clears it.
    await health.recordSuccess(o3, s3, 'gpt-5', at);
    assert.ok(await liveRow(o3, model));
    await health.recordSuccess(o3, s3, model, at);
    assert.equal(await liveRow(o3, model), null);

    // One live row per subject and scope.
    await health.recordFailure(o2, s2, failure('CREDENTIAL_REFUSED'), t0);
    await assert.rejects(
      sql.query(
        `INSERT INTO "account_health" ("id", "owner_id", "subject_key", "scope_model", "state", "kind", "blocked_until")
         VALUES (gen_random_uuid(), $1, $2, '', 'BLOCKED', 'CREDENTIAL_REFUSED', now())`,
        [o2, subjectKey(s2)],
      ),
      /account_health_live_key/,
    );
    // The two concurrent first failures of one account: one row, one trip.
    const { ownerId: o4, subject: s4 } = await account('concurrent');
    await Promise.all([
      health.recordFailure(o4, s4, failure('ACCOUNT_ACTION_REQUIRED'), t0),
      rival.recordFailure(o4, s4, failure('ACCOUNT_ACTION_REQUIRED'), t0),
    ]);
    const both = await rows(o4);
    assert.equal(both.length, 1);
    assert.equal(both[0].trips, 1, 'the second refusal fell inside the block the first opened');
  });

  await t.test('(5) a claim whose run never started frees after 15 minutes; a trial that ended otherwise is due again', async () => {
    const t0 = new Date('2026-11-22T17:19:00.000Z');
    const { ownerId, subject } = await account('stale');
    await health.recordFailure(ownerId, subject, failure('CREDENTIAL_REFUSED'), t0);
    const due = (await liveRow(ownerId))!.blockedUntil!;
    const first = randomUUID();
    assert.equal(await health.claimTrial(ownerId, subject, '', first, due), 'CLAIMED');
    assert.deepEqual((await health.live(ownerId, due)).map((e) => e.view), ['trial-running']);
    const almost = new Date(due.getTime() + TRIAL_CLAIM_STALE_MS - 1);
    assert.equal(await health.claimTrial(ownerId, subject, '', randomUUID(), almost), 'HELD');
    const stale = new Date(due.getTime() + TRIAL_CLAIM_STALE_MS);
    assert.deepEqual((await health.live(ownerId, stale)).map((e) => e.view), ['trial-due']);
    const second = randomUUID();
    assert.equal(await health.claimTrial(ownerId, subject, '', second, stale), 'CLAIMED');
    // That trial ends by a transport error before admission: unchanged, due again, not a trip.
    await health.recordFailure(ownerId, subject, failure('TRANSPORT', { sessionId: second }), stale);
    const after = (await liveRow(ownerId))!;
    assert.equal(after.trips, 1);
    assert.equal(after.trialSessionId, null);
    assert.equal(await health.claimTrial(ownerId, subject, '', randomUUID(), stale), 'CLAIMED');
    // Cancelled: released by the run-end path.
    const claim = (await liveRow(ownerId))!.trialSessionId!;
    await health.releaseTrial(ownerId, subject, claim, stale);
    assert.equal((await liveRow(ownerId))!.trialSessionId, null);
    assert.equal((await liveRow(ownerId))!.trips, 1);
  });
});
