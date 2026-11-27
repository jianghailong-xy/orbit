/**
 * What a proven stop of a managed runner's instance shows (docs/managed-runner-design.md, "Implementation record:
 * failure recovery and visibility", visibility). Over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty, against the in-memory Kubernetes namespace of test-support/fake-kube-client.ts; the clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-stop-visibility.pg.spec.ts
 *
 *   (1) a stop the kubelet reports marks the runner row OFFLINE in the commit that records it, while it restarts;
 *       the next generation's heartbeat marks it ONLINE again;
 *   (2) an eviction for full temporary storage is its own cause, restarting (POD_RESTARTING_STORAGE_FULL) and once
 *       failed (POD_STORAGE_FULL): the owner's status names it, its attempt and its next automatic try, and the row
 *       reads OFFLINE; an eviction for memory is a plain stop;
 *   (3) the two writes are one transaction: when the runner row cannot be written, the stop is not recorded either.
 *
 * Not destructive: every row belongs to a user this run creates; the trigger (3) adds is scoped to one runner and
 * dropped after.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ManagedRunner, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { managedRunnerWorld } from '../test-support/managed-runner-world';
import { demandAnswer } from './managed-runner-demand';
import { managedPodName } from './managed-runner-resources';

const URL = process.env.COORDINATOR_PG_URL;
const TMP_FULL = 'Usage of EmptyDir volume "tmp" exceeds the limit "1Gi". ';

test('managed runner stop visibility: OFFLINE at once, and the cause, attempt and next try', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const codeOf = (m: ManagedRunner) => (m.lastError as { code?: string } | null)?.code ?? null;
  const runnerStatus = async (m: ManagedRunner) => (await db.runner.findUniqueOrThrow({ where: { id: m.runnerId } })).status;

  await t.test('(1) a proven stop marks the runner OFFLINE in the commit that records it', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('stop-offline');
    assert.equal(await runnerStatus(mapping), 'ONLINE', 'READY: its heartbeat says ONLINE');
    w.cluster.stopPod(managedPodName(mapping.runnerId), 1);
    assert.equal(await w.primary.reconcile(mapping.id), 'BACKOFF');
    const restarting = await w.mappingOf(ownerId);
    assert.deepEqual([restarting.managementState, codeOf(restarting), restarting.revision], ['REQUESTED', 'POD_RESTARTING', mapping.revision + 1]);
    assert.equal((restarting.fencingReceipt as { kind: string }).kind, 'OBSERVED_STOP', 'the stop proof recorded');
    assert.equal(await runnerStatus(mapping), 'OFFLINE', 'the machine reads OFFLINE at once, not by its heartbeat\'s age');
    const status = await w.service.status(ownerId);
    assert.equal(status.heartbeatStatus, 'OFFLINE');
    assert.deepEqual([status.attempt, status.nextAttemptAt], [1, restarting.nextAttemptAt!.toISOString()]);

    assert.equal((await w.drive(ownerId)).at(-1), 'READY');
    assert.equal(await runnerStatus(mapping), 'ONLINE', 'the next generation\'s heartbeat marks it ONLINE again');
  });

  await t.test('(2) an eviction for full temporary storage is its own cause, restarting and failed', async () => {
    const w = managedRunnerWorld(db);
    const { maxAttempts } = w.profile.lifecycle;
    const { ownerId, mapping } = await w.readyRunner('stop-tmp-full');
    for (let stop = 1; stop < maxAttempts; stop += 1) {
      w.cluster.evictPod(managedPodName(mapping.runnerId), TMP_FULL);
      assert.equal(await w.primary.reconcile(mapping.id), 'BACKOFF');
      const restarting = await w.mappingOf(ownerId);
      assert.deepEqual([restarting.attempt, codeOf(restarting)], [stop, 'POD_RESTARTING_STORAGE_FULL']);
      assert.equal(await runnerStatus(mapping), 'OFFLINE');
      assert.match((await w.service.status(ownerId)).reason!.message, /filled its temporary storage/);
      assert.equal((await w.drive(ownerId)).at(-1), 'READY');
    }
    w.cluster.evictPod(managedPodName(mapping.runnerId), TMP_FULL);
    assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
    const failed = await w.mappingOf(ownerId);
    assert.deepEqual([failed.managementState, codeOf(failed), failed.attempt], ['FAILED', 'POD_STORAGE_FULL', maxAttempts]);
    assert.ok(failed.nextAttemptAt, 'its slow retry scheduled');
    assert.equal(await runnerStatus(mapping), 'OFFLINE');
    assert.equal(demandAnswer(failed).comingBack, true, 'work sent to it is queued');

    const status = await w.service.status(ownerId);
    assert.deepEqual(
      { state: status.managementState, code: status.reason?.code, retryable: status.reason?.retryable, attempt: status.attempt, next: status.nextAttemptAt, canRetry: status.actions.canRetry },
      { state: 'FAILED', code: 'POD_STORAGE_FULL', retryable: true, attempt: maxAttempts, next: failed.nextAttemptAt.toISOString(), canRetry: true },
    );
    assert.match(status.reason!.message, /kept filling its temporary storage/);

    // An eviction for memory pressure on the node is no full temporary storage: a plain stop.
    const other = managedRunnerWorld(db);
    const second = await other.readyRunner('stop-evicted-memory');
    other.cluster.evictPod(managedPodName(second.mapping.runnerId), 'The node was low on resource: memory. ');
    assert.equal(await other.primary.reconcile(second.mapping.id), 'BACKOFF');
    assert.equal(codeOf(await other.mappingOf(second.ownerId)), 'POD_RESTARTING');
  });

  await t.test('(3) the stop and the OFFLINE are one transaction: neither lands without the other', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('stop-atomic');
    const fn = `refuse_offline_${mapping.runnerId.replace(/-/g, '')}`;
    await sql.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${mapping.runnerId}' AND NEW.status = 'OFFLINE' THEN RAISE EXCEPTION 'refused by the spec'; END IF; RETURN NEW; END $$`);
    await sql.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON "runner" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      w.cluster.stopPod(managedPodName(mapping.runnerId), 1);
      await w.primary.reconcile(mapping.id).catch(() => undefined);
      const after = await w.mappingOf(ownerId);
      assert.deepEqual(
        { state: after.managementState, revision: after.revision, receipt: after.fencingReceipt, attempt: after.attempt },
        { state: 'READY', revision: mapping.revision, receipt: mapping.fencingReceipt, attempt: mapping.attempt },
        'the runner row refused: the stop is not recorded either',
      );
      assert.equal(await runnerStatus(mapping), 'ONLINE');
    } finally {
      await sql.query(`DROP TRIGGER ${fn} ON "runner"`);
      await sql.query(`DROP FUNCTION ${fn}()`);
    }
    assert.equal(await w.primary.reconcile(mapping.id), 'BACKOFF', 'the next pass records it');
    assert.equal(codeOf(await w.mappingOf(ownerId)), 'POD_RESTARTING');
    assert.equal(await runnerStatus(mapping), 'OFFLINE');
  });
});
