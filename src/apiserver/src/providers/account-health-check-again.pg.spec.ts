/**
 * CHECK AGAIN AND THE ALERT ON POSTGRESQL (docs/routing-account-health-design.md §8).
 *
 *   (1) A classified refusal alerts once, at trip 1; a refused trial (trip 2) does not.
 *   (2) Check again clears the block (cleared_by OWNER) and resets the ladder; a refusal after it is trip 1 again, for
 *       one hour, and alerts once more: the answer to the press.
 *   (3) Another owner cannot clear the row; a second press finds nothing to clear.
 *   (4) The breaker alerts at its third trip only, and a changed classified kind alerts once.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/providers/account-health-check-again.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { type PrismaClient, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AccountHealthFailure, AccountHealthSubject, HealthFailureKind } from './account-health';
import { AccountHealthService } from './account-health.service';
import type { PushService } from '../push/push.service';

const URL = process.env.COORDINATOR_PG_URL;
const HOUR = 3_600_000;

test('account health: the alert and Check again on PostgreSQL', { skip: !URL, concurrency: 1, timeout: 120_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const sent: Array<{ ownerId: string; kind: string; trips: number }> = [];
  const push = { notifyAccountNeedsAction: async (ownerId: string, a: { kind: string; trips: number }) => { sent.push({ ownerId, kind: a.kind, trips: a.trips }); } };
  const moduleRef = { get: () => push as unknown as PushService };
  const health = new AccountHealthService(db as unknown as PrismaService, moduleRef as never);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

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
  const live = (ownerId: string) => db.accountHealth.findFirst({ where: { ownerId, scopeModel: '', clearedAt: null } });
  const alertsOf = async (ownerId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return sent.filter((s) => s.ownerId === ownerId);
  };
  async function refusedTrial(ownerId: string, subject: AccountHealthSubject, kind: HealthFailureKind | null): Promise<void> {
    const at = (await live(ownerId))!.blockedUntil!;
    const trial = failure(kind);
    assert.equal(await health.claimTrial(ownerId, subject, '', trial.sessionId, at), 'CLAIMED');
    await health.recordFailure(ownerId, subject, trial, at);
  }

  await t.test('(1)(2)(3) a classified refusal alerts once; Check again clears, resets, and a refusal after it is trip 1', async () => {
    const { ownerId, subject } = await account('check');
    const t0 = new Date('2026-11-22T17:19:00.000Z');
    await health.recordFailure(ownerId, subject, failure('ACCOUNT_ACTION_REQUIRED', { said: 'Add a payment method to continue' }), t0);
    await refusedTrial(ownerId, subject, 'ACCOUNT_ACTION_REQUIRED');
    const row = (await live(ownerId))!;
    assert.equal(row.trips, 2);
    assert.equal((await alertsOf(ownerId)).length, 1, 'one alert, at trip 1; the refused trial is silent');

    // Another owner cannot clear it.
    const stranger = await account('stranger');
    assert.equal(await health.checkAgain(stranger.ownerId, row.id), 0);
    assert.ok(await live(ownerId), 'still blocked');

    assert.equal(await health.checkAgain(ownerId, row.id, new Date(t0.getTime() + 2 * HOUR)), 1);
    assert.equal(await live(ownerId), null);
    const cleared = await db.accountHealth.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(cleared.clearedBy, 'OWNER');
    assert.equal(await health.checkAgain(ownerId, row.id), 0, 'a second press finds nothing');

    const t1 = new Date(t0.getTime() + 3 * HOUR);
    await health.recordFailure(ownerId, subject, failure('ACCOUNT_ACTION_REQUIRED', { said: 'Add a payment method to continue' }), t1);
    const again = (await live(ownerId))!;
    assert.equal(again.trips, 1, 'a refusal after Check again is trip 1');
    assert.equal(again.blockedUntil!.getTime() - t1.getTime(), HOUR, 'for one hour');
    assert.equal((await alertsOf(ownerId)).length, 2, 'the new streak alerts at its own alert point');
  });

  await t.test('(4) the breaker alerts at its third trip only; a changed classified kind alerts once', async () => {
    const { ownerId, subject } = await account('breaker');
    const t0 = new Date('2026-11-22T17:19:00.000Z');
    await health.recordFailure(ownerId, subject, failure(null), t0);
    await health.recordFailure(ownerId, subject, failure(null), t0);
    assert.equal((await live(ownerId))!.trips, 1);
    await refusedTrial(ownerId, subject, null);
    assert.equal((await live(ownerId))!.trips, 2);
    assert.equal((await alertsOf(ownerId)).length, 0, 'two trips: a guess, still silent');
    await refusedTrial(ownerId, subject, null);
    assert.equal((await live(ownerId))!.trips, 3);
    assert.deepEqual((await alertsOf(ownerId)).map((a) => a.kind), ['UNCLASSIFIED_ADMISSION']);
    await refusedTrial(ownerId, subject, null);
    assert.equal((await alertsOf(ownerId)).length, 1, 'trip 4 is silent');
    await refusedTrial(ownerId, subject, 'CREDENTIAL_REFUSED');
    assert.deepEqual((await alertsOf(ownerId)).map((a) => a.kind), ['UNCLASSIFIED_ADMISSION', 'CREDENTIAL_REFUSED']);
    await refusedTrial(ownerId, subject, 'CREDENTIAL_REFUSED');
    await refusedTrial(ownerId, subject, 'ACCESS_DENIED');
    assert.deepEqual((await alertsOf(ownerId)).map((a) => a.kind), ['UNCLASSIFIED_ADMISSION', 'CREDENTIAL_REFUSED', 'ACCESS_DENIED']);
  });
});
