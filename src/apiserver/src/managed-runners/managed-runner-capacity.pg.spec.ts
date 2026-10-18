/**
 * Capacity admission (docs/managed-runner-design.md, "Resource admission model supply and isolation";
 * managed-runner-capacity.ts): the manager against the in-memory Kubernetes namespace of
 * `test-support/fake-kube-client.ts`, with the single-Pod admission guard installed, over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty. The switch is on; no cluster,
 * kubeconfig or credential is involved, and the clock is the test's. Each case has a pool of its own.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-capacity.pg.spec.ts
 *
 *   (1) admission is atomic under concurrency: eight owners, four manager replicas reconciling every
 *       mapping at once, a budget of three active users — exactly three admitted, five waiting with
 *       the reason and a retry time, and the pool's reserved figures equal the sum of the mappings'
 *       recorded shares; more passes change nothing;
 *   (2) the budget is the pool's alone: a CPU budget for two runners admits two whatever the runners'
 *       maxConcurrent says, and the third waits short of CPU;
 *   (3) storage is reserved per volume against the pool's usable bytes less its headroom, and a
 *       sleeping runner keeps its storage share: its sleep frees compute, not storage;
 *   (4) a release rescans the waiting intents before their retry time, oldest first: the runner that
 *       sleeps makes room for the first waiter, the second keeps waiting, and the status says why
 *       and until when; nothing was deleted, evicted or resized;
 *   (5) a provisioning that fails for good gives its compute back (no Pod existed), so another owner
 *       is admitted, and an explicit retry is admitted again — or waits;
 *   (6) a restart with a larger budget moves the pool, and the waiting intent is admitted.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MANAGED_RUNNER_CAPACITY_UNAVAILABLE } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { managedRunnerWorld, quiet } from '../test-support/managed-runner-world';
import { computeShare, storageShare } from './managed-runner-capacity';
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';

const URL = process.env.COORDINATOR_PG_URL;

const ADMITTED = new Set(['PROVISIONING', 'STARTING', 'READY']);

test('managed runner capacity admission: persistent, atomic reservations of a fixed budget', {
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

  await t.test('(1) eight owners, four replicas at once, three active users: exactly three admitted, and the pool is the sum of the shares', async () => {
    const w = managedRunnerWorld(db, { capacity: { maxActiveUsers: 3 } });
    const owners = await Promise.all(Array.from({ length: 8 }, (_, i) => w.makeUser(`concurrent-${i}`)));
    await Promise.all(owners.map((owner, i) => w.service.ensure(owner, `ensure-${i}`)));
    const mappings = await Promise.all(owners.map((owner) => w.mappingOf(owner)));
    const replicas = [w.manager('replica-a', 1), w.manager('replica-b', 1), w.manager('replica-c', 1), w.manager('replica-d', 1)];
    // Every replica reconciles every mapping at once, round after round: admissions race on the pool.
    for (let round = 0; round < 3; round += 1) {
      await Promise.all(replicas.flatMap((replica) => mappings.map((m) => replica.reconcile(m.id))));
    }
    const after = await Promise.all(owners.map((owner) => w.mappingOf(owner)));
    const admitted = after.filter((m) => ADMITTED.has(m.managementState));
    const waiting = after.filter((m) => m.managementState === 'WAITING_CAPACITY');
    assert.equal(admitted.length, 3, `admitted: ${after.map((m) => m.managementState).join(', ')}`);
    assert.equal(waiting.length, 5);
    for (const m of waiting) {
      const reason = m.lastError as { code: string; message: string; retryable: boolean; short: string[] };
      assert.equal(reason.code, MANAGED_RUNNER_CAPACITY_UNAVAILABLE);
      assert.equal(reason.retryable, true);
      assert.deepEqual(reason.short, ['activeUsers']);
      assert.ok(m.nextAttemptAt && m.nextAttemptAt > w.now(), 'a retry time is recorded');
      assert.equal(m.reservation, null, 'a refused admission holds nothing: no storage, no compute');
      assert.equal(m.pvcUid, null, 'and nothing was created for it');
      const status = await w.service.status(m.ownerId);
      assert.equal(status.managementState, 'WAITING_CAPACITY');
      assert.equal(status.reason?.code, MANAGED_RUNNER_CAPACITY_UNAVAILABLE);
      assert.equal(status.retryAfter, m.nextAttemptAt!.toISOString());
      assert.equal(status.usable, false);
    }
    const { pool, shares } = await w.ledger();
    assert.deepEqual(pool, shares, 'the pool reserves exactly what the mappings recorded');
    const compute = computeShare(w.profile);
    assert.equal(pool.users, 3);
    assert.equal(pool.cpu, 3 * compute.cpuMillis);
    assert.equal(pool.durable, 3 * storageShare(w.profile).durableBytes);

    // More passes, by every replica, past the retry time: still three, and still the same figures.
    w.advance(w.profile.lifecycle.capacityRetrySeconds * 1000 + 1);
    for (let round = 0; round < 2; round += 1) {
      await Promise.all(replicas.flatMap((replica) => mappings.map((m) => replica.reconcile(m.id))));
    }
    const again = await Promise.all(owners.map((owner) => w.mappingOf(owner)));
    assert.equal(again.filter((m) => ADMITTED.has(m.managementState)).length, 3);
    assert.deepEqual((await w.ledger()).pool, pool);
  });

  await t.test('(2) the decision is the pool\'s: a CPU budget for two admits two, whatever the runners\' session slots say', async () => {
    // Each runner Pod requests 1000m (the larger of its two containers); 2200m holds two of them.
    const w = managedRunnerWorld(db, { capacity: { compute: { cpu: '2200m', memory: '2000Gi', ephemeralStorage: '2000Gi', pods: 50, attachments: 50 } } });
    const first = await w.readyRunner('cpu-first');
    const second = await w.readyRunner('cpu-second');
    // Session concurrency is not capacity: raising the runners' maxConcurrent frees nothing.
    await db.runner.updateMany({ where: { id: { in: [first.mapping.runnerId, second.mapping.runnerId] } }, data: { maxConcurrent: 64 } });
    const thirdOwner = await w.makeUser('cpu-third');
    await w.service.ensure(thirdOwner, 'ensure-cpu-third');
    const outcomes = await w.drive(thirdOwner, ['WAITING_CAPACITY']);
    assert.equal(outcomes.at(-1), 'WAITING_CAPACITY', outcomes.join(' → '));
    const third = await w.mappingOf(thirdOwner);
    assert.deepEqual((third.lastError as { short: string[] }).short, ['cpu']);
    assert.equal(w.cluster.all('pods').length, 2, 'no Pod was created for the third');
    assert.equal(w.cluster.all('persistentvolumeclaims').length, 2, 'nor a volume');
  });

  await t.test('(3) storage is reserved per volume and kept asleep: a sleeping runner frees compute, not its storage', async () => {
    // 70Gi usable less 10Gi headroom holds three 20Gi volumes.
    const w = managedRunnerWorld(db, { capacity: { storage: { usable: '70Gi', headroom: '10Gi' } } });
    const runners = [await w.readyRunner('disk-a'), await w.readyRunner('disk-b'), await w.readyRunner('disk-c')];
    const fourthOwner = await w.makeUser('disk-d');
    await w.service.ensure(fourthOwner, 'ensure-disk-d');
    assert.equal((await w.drive(fourthOwner, ['WAITING_CAPACITY'])).at(-1), 'WAITING_CAPACITY');
    assert.deepEqual(((await w.mappingOf(fourthOwner)).lastError as { short: string[] }).short, ['storage']);

    const asleep = await w.putToSleep(runners[0].ownerId);
    const held = asleep.reservation as { storage: unknown; compute: unknown };
    assert.ok(held.storage, 'asleep, its volume still holds its storage share');
    assert.equal(held.compute, null, 'and its compute share is released');
    const { pool, shares } = await w.ledger();
    assert.deepEqual(pool, shares);
    assert.equal(pool.durable, 3 * storageShare(w.profile).durableBytes);
    assert.equal(pool.users, 2);

    // The fourth looks again at once — the pool moved — and is still short of storage.
    assert.equal(await w.primary.reconcile((await w.mappingOf(fourthOwner)).id), 'WAITING_CAPACITY');
    assert.deepEqual(((await w.mappingOf(fourthOwner)).lastError as { short: string[] }).short, ['storage']);
    assert.equal(w.cluster.all('persistentvolumeclaims').length, 3, 'no volume was removed to make room');
  });

  await t.test('(4) a release rescans the waiting intents at once, oldest first; nothing is removed to make room', async () => {
    // A retry time far beyond the idle interval: what makes them look again below is the release.
    const w = managedRunnerWorld(db, { capacity: { maxActiveUsers: 1 }, lifecycle: { idleSeconds: 60, capacityRetrySeconds: 3600 } });
    const holder = await w.readyRunner('rescan-holder');
    const firstOwner = await w.makeUser('rescan-first');
    await w.service.ensure(firstOwner, 'ensure-rescan-first');
    assert.equal((await w.drive(firstOwner, ['WAITING_CAPACITY'])).at(-1), 'WAITING_CAPACITY');
    w.advance(1_000);
    const secondOwner = await w.makeUser('rescan-second');
    await w.service.ensure(secondOwner, 'ensure-rescan-second');
    assert.equal((await w.drive(secondOwner, ['WAITING_CAPACITY'])).at(-1), 'WAITING_CAPACITY');
    const waitingSince = (await w.mappingOf(firstOwner)).nextAttemptAt!;

    // Neither is due by its retry time yet.
    const notYet = await w.primary.dueMappings(50);
    assert.ok(!notYet.includes((await w.mappingOf(firstOwner)).id) && !notYet.includes((await w.mappingOf(secondOwner)).id));

    await w.putToSleep(holder.ownerId);
    assert.ok(w.now() < waitingSince, 'their retry time has not come');
    // The release moved the pool: both are due now, the older first.
    const due = await w.primary.dueMappings(50);
    const first = await w.mappingOf(firstOwner);
    const second = await w.mappingOf(secondOwner);
    assert.ok(due.indexOf(first.id) >= 0 && due.indexOf(first.id) < due.indexOf(second.id), 'oldest waiter first');
    // One pass of the worker's order: the first is admitted, the second finds no room again.
    for (const id of due) await w.primary.reconcile(id);
    assert.ok(ADMITTED.has((await w.mappingOf(firstOwner)).managementState), 'the first waiter was admitted');
    assert.equal((await w.mappingOf(secondOwner)).managementState, 'WAITING_CAPACITY');
    assert.equal((await w.drive(firstOwner)).at(-1), 'READY', 'and started');
    const status = await w.service.status(secondOwner);
    assert.equal(status.reason?.code, MANAGED_RUNNER_CAPACITY_UNAVAILABLE);
    assert.ok(status.retryAfter, 'the waiting one says when it looks again');
    // The sleeping holder kept its volume; nothing was deleted or evicted.
    assert.equal((await w.mappingOf(holder.ownerId)).managementState, 'SLEEPING');
    assert.equal(w.cluster.all('persistentvolumeclaims').length, 2);
    assert.equal(w.cluster.count('delete', 'persistentvolumeclaims'), 0);
    assert.deepEqual((await w.ledger()).pool, (await w.ledger()).shares);
  });

  await t.test('(5) a provisioning that fails for good gives its compute back; a retry is admitted again, or waits', async () => {
    const w = managedRunnerWorld(db, { capacity: { maxActiveUsers: 1 }, lifecycle: { maxAttempts: 2 } });
    const failingOwner = await w.makeUser('fails');
    await w.service.ensure(failingOwner, 'ensure-fails');
    w.cluster.inject({ op: 'create', kind: 'persistentvolumeclaims', mode: 'status', status: 500, times: Infinity });
    const outcomes = await w.drive(failingOwner);
    assert.equal(outcomes.at(-1), 'FAILED', outcomes.join(' → '));
    const failed = await w.mappingOf(failingOwner);
    assert.equal((failed.lastError as { code: string }).code, 'RETRY_EXHAUSTED');
    assert.equal((failed.reservation as { compute: unknown }).compute, null, 'no Pod could exist: compute is back in the pool');
    assert.equal((await w.ledger()).pool.users, 0);
    w.cluster.clearFaults();

    const other = await w.readyRunner('takes-the-slot');
    assert.equal(other.mapping.managementState, 'READY', 'the freed slot admitted another owner');

    const retried = await w.service.retry(failingOwner, 'retry-fails', failed.revision);
    assert.equal(retried.managementState, 'REQUESTED');
    assert.equal((await w.drive(failingOwner, ['WAITING_CAPACITY'])).at(-1), 'WAITING_CAPACITY', 'the slot is taken now: it waits');
    await w.putToSleep(other.ownerId);
    assert.equal((await w.drive(failingOwner)).at(-1), 'READY', 'and starts once the slot frees');
    assert.deepEqual((await w.ledger()).pool, (await w.ledger()).shares);
  });

  await t.test('(6) a restart with a larger budget moves the pool, and the waiting intent is admitted', async () => {
    const clusterKey = `resize-${Date.now()}`;
    const w = managedRunnerWorld(db, { capacity: { maxActiveUsers: 1 }, clusterKey });
    await w.readyRunner('resize-holder');
    const waitingOwner = await w.makeUser('resize-waiting');
    await w.service.ensure(waitingOwner, 'ensure-resize-waiting');
    assert.equal((await w.drive(waitingOwner, ['WAITING_CAPACITY'])).at(-1), 'WAITING_CAPACITY');

    // The operator raises the budget and restarts: a new manager over the same database and cluster.
    const larger = testManagedRunnerProfile({ capacity: { maxActiveUsers: 2 }, clusterKey });
    const restarted = new ManagedRunnerManager(w.prisma as unknown as PrismaService, w.cluster.client(), larger, { holder: 'restarted', now: w.now, random: () => 0.5, log: quiet });
    const due = await restarted.dueMappings(50);
    const waiting = await w.mappingOf(waitingOwner);
    assert.ok(due.includes(waiting.id), 'the changed budget is a capacity change: it looks again at once');
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < 20 && outcomes.at(-1) !== 'READY'; i += 1) {
      outcomes.push(await restarted.reconcile(waiting.id));
      const m = await w.mappingOf(waitingOwner);
      if (m.podUid && m.managementState === 'STARTING') {
        w.advance(1_000);
        await w.heartbeat(m.runnerId);
      }
    }
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
  });
});
