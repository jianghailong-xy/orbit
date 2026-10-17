/**
 * The manager's state machine on a run backend that is not Kubernetes (managed-runner-backend.ts):
 * `test-support/memory-run-backend.ts`, one host's volumes, credential files and containers held in
 * memory, over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty. The same manager,
 * service, admission, gate and sleep code the Kubernetes specs drive; nothing here imports a
 * Kubernetes client, and the clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-backend.pg.spec.ts
 *
 *   (1) provisioning: the mapping's location and volume name are the backend's, every identity it
 *       records is the backend's, the runner's credential is the one the backend delivered, and
 *       admission reserves the backend's shares from the backend's own pool; the single-instance
 *       guard is asked before the one instance is created;
 *   (2) sleep and wake: an idle runner drains, accepts, exits; the backend's stop report retires the
 *       generation, the instance is removed by UID, compute goes back; demand wakes it on the same
 *       volume, with the retired credential removed and the next one issued;
 *   (3) the single-writer gate: an instance gone without a report, or declared exited by anything
 *       but its host, fences — in the backend's words — and the predecessor's credential dies;
 *   (4) a disabled owner's runner is drained to sleep and not woken;
 *   (5) capacity: the backend's budget admits one runner, the second waits, and runs once the
 *       first sleeps;
 *   (6) a backend failure: transient is a backoff, definite is FAILED with the backend's code.
 *
 * Not destructive: every row belongs to a user this run creates, and each world has a pool of its own.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { MANAGED_RUNNER_CAPACITY_UNAVAILABLE, MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY } from '@orbit/shared';
import { Prisma, type ManagedRunner, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import { MemoryBackendError, MemoryRunBackend } from '../test-support/memory-run-backend';
import type { CapacityBudget } from './managed-runner-capacity';
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import type { ManagedRunnerRuntime } from './managed-runner-runtime';
import { managedRunnerHeartbeat, storedWorkloadFor } from './managed-runner-sleep';
import { recordManagedDemand } from './managed-runner-work';
import { ManagedRunnerWorker } from './managed-runner-worker';
import { ManagedRunnerService } from './managed-runner.service';

const URL = process.env.COORDINATOR_PG_URL;
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const ON = { enabled: true, problem: null } as const;
const IDLE = { activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 0 };
const GiB = 2 ** 30;
const COMPUTE = { cpuMillis: 1000, memoryBytes: 2 * GiB, ephemeralBytes: GiB, pods: 1, attachments: 1, activeUsers: 1 };
const STORAGE = { durableBytes: 10 * GiB };
const ROOMY: CapacityBudget = {
  cpuMillis: 100_000, memoryBytes: 200 * GiB, ephemeralBytes: 100 * GiB, pods: 100, attachments: 100, activeUsers: 100,
  storageUsableBytes: 2000 * GiB, storageHeadroomBytes: 100 * GiB,
};
/** Room for exactly one runner's compute (and plenty of storage). */
const ONE_RUNNER: CapacityBudget = { ...ROOMY, cpuMillis: 1000, memoryBytes: 2 * GiB, ephemeralBytes: GiB, pods: 1, attachments: 1, activeUsers: 1 };

test('the manager drives a mapping on a run backend with no Kubernetes in it', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  function world(budget: CapacityBudget = ROOMY) {
    const profile = testManagedRunnerProfile();
    const backend = new MemoryRunBackend(
      { clusterKey: `memory-${randomUUID().slice(0, 8)}`, namespace: 'orbit-managed-memory' },
      { budget, compute: COMPUTE, storage: STORAGE },
    );
    const clock = { ms: Date.now() };
    const now = () => new Date(clock.ms);
    const manager = new ManagedRunnerManager(prisma, backend, profile, { holder: 'memory-replica', now, random: () => 0.5, log: quiet });
    const runtime: ManagedRunnerRuntime = { available: true, profile, manager, worker: new ManagedRunnerWorker(manager, 60_000, quiet) };
    const service = new ManagedRunnerService(prisma, ON, runtime);
    const advance = (ms: number) => void (clock.ms += ms);
    const mappingOf = async (ownerId: string): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId } }))!;

    /** The authorized instance's heartbeat, as the runner route records it: fresh, signed in, idle unless said. */
    async function heartbeat(runnerId: string, workload: Partial<typeof IDLE> = {}) {
      const mapping = (await db.managedRunner.findUnique({ where: { runnerId } }))!;
      await db.runner.update({
        where: { id: runnerId },
        data: {
          status: 'ONLINE',
          lastHeartbeatAt: now(),
          engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
          capabilities: [MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY],
          managedWorkload: mapping.podUid
            ? (storedWorkloadFor({ ...IDLE, ...workload }, { mappingId: mapping.id, generation: mapping.generation, podUid: mapping.podUid }, false, now()) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      });
    }

    /** Reconcile until `until` or FAILED: past every backoff, heartbeating once an instance runs. */
    async function drive(ownerId: string, until: ReconcileOutcome[] = ['READY']): Promise<ReconcileOutcome[]> {
      const outcomes: ReconcileOutcome[] = [];
      for (let i = 0; i < 40; i += 1) {
        const outcome = await manager.reconcile((await mappingOf(ownerId)).id);
        outcomes.push(outcome);
        if (until.includes(outcome) || outcome === 'FAILED') return outcomes;
        const after = await mappingOf(ownerId);
        if (after.podUid && after.managementState === 'STARTING') {
          advance(1_000);
          await heartbeat(after.runnerId);
        }
        if (after.nextAttemptAt && after.nextAttemptAt > now() && after.managementState !== 'WAITING_CAPACITY') clock.ms = after.nextAttemptAt.getTime() + 1;
      }
      return outcomes;
    }

    async function owner(label: string): Promise<string> {
      return (await db.user.create({ data: { email: `${label}-${randomUUID()}@example.invalid`, name: label } })).id;
    }

    async function readyRunner(label: string): Promise<{ ownerId: string; mapping: ManagedRunner }> {
      const ownerId = await owner(label);
      await service.ensure(ownerId, `ensure-${label}`);
      const outcomes = await drive(ownerId);
      assert.equal(outcomes.at(-1), 'READY', `${label}: ${outcomes.join(' → ')}`);
      return { ownerId, mapping: await mappingOf(ownerId) };
    }

    /** Idle past the interval, drained, accepted, exited by itself: SLEEPING. */
    async function putToSleep(ownerId: string): Promise<ManagedRunner> {
      const ready = await mappingOf(ownerId);
      advance(profile.lifecycle.idleSeconds * 1000 + 1_000);
      await heartbeat(ready.runnerId, { idleSeconds: profile.lifecycle.idleSeconds + 1 });
      assert.equal(await manager.reconcile(ready.id), 'DRAINING', 'idle long enough: it drains');
      const draining = await mappingOf(ownerId);
      const answer = await managedRunnerHeartbeat(
        prisma,
        { mappingId: draining.id, generation: draining.generation, podUid: draining.podUid! },
        { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() },
        now(),
      );
      assert.equal(answer.sleep?.confirmed, true, 'the idle instance\'s acceptance is confirmed');
      backend.exit(draining.runnerId);
      const outcomes: ReconcileOutcome[] = [];
      for (let i = 0; i < 6 && outcomes.at(-1) !== 'SLEEPING'; i += 1) outcomes.push(await manager.reconcile(draining.id));
      assert.equal(outcomes.at(-1), 'SLEEPING', outcomes.join(' → '));
      return mappingOf(ownerId);
    }

    /** The pool keyed by the backend's location, as reserved now. */
    async function reserved(): Promise<Record<string, number>> {
      const [row] = await sql.query(
        `SELECT cpu_millis_reserved, memory_bytes_reserved, ephemeral_bytes_reserved, pods_reserved, attachments_reserved,
                active_users_reserved, durable_bytes_reserved
           FROM managed_runner_capacity WHERE cluster_key = $1 AND namespace = $2`,
        [backend.location.clusterKey, backend.location.namespace],
      ).then((r) => r.rows);
      return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]));
    }

    return { profile, backend, now, advance, manager, service, mappingOf, heartbeat, drive, owner, readyRunner, putToSleep, reserved };
  }

  const shares = (computeHeld: boolean) => ({
    cpu_millis_reserved: computeHeld ? COMPUTE.cpuMillis : 0,
    memory_bytes_reserved: computeHeld ? COMPUTE.memoryBytes : 0,
    ephemeral_bytes_reserved: computeHeld ? COMPUTE.ephemeralBytes : 0,
    pods_reserved: computeHeld ? 1 : 0,
    attachments_reserved: computeHeld ? 1 : 0,
    active_users_reserved: computeHeld ? 1 : 0,
    durable_bytes_reserved: STORAGE.durableBytes,
  });

  await t.test('(1) provisioning records the backend\'s location, identities and credential, and admits from its pool', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('provision');
    const names = w.backend.names(mapping.runnerId);
    assert.deepEqual(
      { clusterKey: mapping.clusterKey, namespace: mapping.namespace, pvcName: mapping.pvcName },
      { ...w.backend.location, pvcName: names.volume },
      'the volume lives where the backend says',
    );
    const volume = w.backend.volumes.get(names.volume)!;
    const instance = w.backend.instances.get(names.instance)!;
    assert.deepEqual(
      { pvcUid: mapping.pvcUid, pvUid: mapping.pvUid, volumeHandle: mapping.volumeHandle, podName: mapping.podName, podUid: mapping.podUid, nodeName: mapping.nodeName },
      { pvcUid: volume.uid, pvUid: volume.uid, volumeHandle: `local/${names.volume}/${volume.uid}`, podName: names.instance, podUid: instance.uid, nodeName: 'host-a' },
    );
    assert.equal(instance.generation, 1);
    assert.equal(mapping.initialProvider, 'claude');
    const credential = w.backend.credentials.get(names.credential)!;
    assert.equal((await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } })).tokenHash, sha256(credential.token), 'the runner holds the credential the backend delivered');
    assert.deepEqual(await w.reserved(), shares(true), 'the backend\'s shares, from the backend\'s pool');
    const creates = w.backend.calls.filter((c) => /^(createVolume|issueCredential|requireInstanceGuard|createInstance)$/.test(c));
    assert.deepEqual(creates, ['createVolume', 'issueCredential', 'requireInstanceGuard', 'createInstance'], 'each once, the guard before the instance');
    assert.equal((await w.service.status(ownerId)).managementState, 'READY');
  });

  await t.test('(2) it sleeps on the backend\'s stop report and wakes on the same volume', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('sleep');
    const names = w.backend.names(mapping.runnerId);
    const before = await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } });
    const asleep = await w.putToSleep(ownerId);
    assert.deepEqual(
      { state: asleep.managementState, desired: asleep.desiredState, generation: asleep.generation, podUid: asleep.podUid, pvcUid: asleep.pvcUid },
      { state: 'SLEEPING', desired: 'SLEEPING', generation: 2, podUid: null, pvcUid: mapping.pvcUid },
    );
    assert.equal(w.backend.instances.has(names.instance), false, 'the stopped instance was removed');
    assert.equal(w.backend.count('removeInstance'), 1);
    const proof = asleep.fencingReceipt as { kind: string; retiredAt?: string; predecessor: { podUid: string } };
    assert.deepEqual([proof.kind, proof.predecessor.podUid, typeof proof.retiredAt], ['OBSERVED_STOP', mapping.podUid, 'string']);
    assert.notEqual((await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } })).tokenHash, before.tokenHash, 'the old generation\'s credential is dead');
    assert.deepEqual(await w.reserved(), shares(false), 'compute back in the pool, storage kept');

    assert.ok(await recordManagedDemand(prisma, mapping.runnerId, w.now()));
    assert.equal((await w.drive(ownerId)).at(-1), 'READY');
    const awake = await w.mappingOf(ownerId);
    assert.equal(awake.generation, 2);
    assert.equal(awake.pvcUid, mapping.pvcUid, 'the same volume');
    assert.notEqual(awake.podUid, mapping.podUid, 'a new instance');
    assert.equal(w.backend.count('createVolume'), 1, 'the volume was never created again');
    assert.equal(w.backend.count('removeCredential'), 1, 'the retired credential was removed');
    assert.equal(w.backend.credentials.get(names.credential)!.generation, 2);
    assert.equal(w.backend.instances.get(names.instance)!.generation, 2);
    assert.deepEqual(await w.reserved(), shares(true));
  });

  await t.test('(3) the gate fences an instance gone or declared exited without its host\'s report', async () => {
    const w = world();
    const gone = await w.readyRunner('gone');
    const credential = (await db.runner.findUniqueOrThrow({ where: { id: gone.mapping.runnerId } })).tokenHash;
    w.backend.vanish(gone.mapping.runnerId);
    assert.equal(await w.manager.reconcile(gone.mapping.id), 'FENCING');
    const fenced = await w.mappingOf(gone.ownerId);
    const error = fenced.lastError as { code: string; detail: string };
    assert.equal(error.code, 'PREDECESSOR_STOP_UNPROVEN');
    assert.equal(error.detail, `container ${gone.mapping.podUid} of generation 1 is gone without a stop proof`, 'in the backend\'s words');
    assert.equal(fenced.generation, 1, 'no new generation without proof');
    assert.notEqual((await db.runner.findUniqueOrThrow({ where: { id: gone.mapping.runnerId } })).tokenHash, credential, 'the predecessor\'s credential stopped working');
    const calls = w.backend.calls.length;
    assert.equal(await w.manager.reconcile(gone.mapping.id), 'FENCING', 'and it waits');
    assert.deepEqual(w.backend.calls.slice(calls).filter((c) => /^(create|remove|issue)/.test(c)), [], 'nothing created or removed while it waits');

    const declared = await w.readyRunner('declared');
    w.backend.declareExited(declared.mapping.runnerId);
    assert.equal(await w.manager.reconcile(declared.mapping.id), 'FENCING');
    assert.equal(((await w.mappingOf(declared.ownerId)).lastError as { detail: string }).detail, `container ${declared.mapping.podUid} is exited, but not by the host's report`);
    assert.equal(w.backend.instances.has(w.backend.names(declared.mapping.runnerId).instance), true, 'kept for an operator');
  });

  await t.test('(4) a disabled owner\'s runner is drained to sleep and not woken', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('disabled');
    await db.user.update({ where: { id: ownerId }, data: { disabledAt: w.now() } });
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING', 'at once: no idle interval, no instance report');
    w.backend.exit(mapping.runnerId);
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < 6 && outcomes.at(-1) !== 'SLEEPING'; i += 1) outcomes.push(await w.manager.reconcile(mapping.id));
    assert.equal(outcomes.at(-1), 'SLEEPING', outcomes.join(' → '));
    const asleep = await w.mappingOf(ownerId);
    assert.deepEqual([asleep.managementState, asleep.desiredState], ['SLEEPING', 'SLEEPING']);
    assert.equal(await recordManagedDemand(prisma, mapping.runnerId, w.now()), null, 'demand does not wake it');
    assert.deepEqual(await w.reserved(), shares(false));
  });

  await t.test('(5) the backend\'s budget admits one runner; the second waits, then runs once the first sleeps', async () => {
    const w = world(ONE_RUNNER);
    const first = await w.readyRunner('first');
    const secondOwner = await w.owner('second');
    await w.service.ensure(secondOwner, 'ensure-second');
    assert.equal((await w.drive(secondOwner, ['WAITING_CAPACITY'])).at(-1), 'WAITING_CAPACITY');
    const waiting = await w.mappingOf(secondOwner);
    assert.equal((waiting.lastError as { code: string }).code, MANAGED_RUNNER_CAPACITY_UNAVAILABLE);
    assert.equal(w.backend.count('createVolume'), 1, 'nothing made for the one that waits');
    await w.putToSleep(first.ownerId);
    assert.equal((await w.drive(secondOwner)).at(-1), 'READY');
  });

  await t.test('(6) a transient backend failure backs off; a definite one fails with the backend\'s code', async () => {
    const w = world();
    const ownerId = await w.owner('failing');
    await w.service.ensure(ownerId, 'ensure-failing');
    w.backend.failNext('createVolume', true);
    const id = (await w.mappingOf(ownerId)).id;
    const outcomes: ReconcileOutcome[] = [await w.manager.reconcile(id)];
    assert.equal(outcomes.at(-1), 'BACKOFF');
    assert.equal(((await w.mappingOf(ownerId)).lastError as { code: string }).code, 'TRANSIENT');
    assert.equal((await w.drive(ownerId)).at(-1), 'READY', 'and it goes on');

    const other = await w.owner('rejected');
    await w.service.ensure(other, 'ensure-rejected');
    w.backend.failNext('issueCredential', false);
    assert.equal((await w.drive(other)).at(-1), 'FAILED');
    const failed = await w.mappingOf(other);
    assert.deepEqual(
      { code: (failed.lastError as { code: string }).code, detail: (failed.lastError as { detail: string }).detail },
      { code: 'BACKEND_REJECTED', detail: 'injected failure of issueCredential' },
    );
    assert.ok(new MemoryBackendError(false, 'x') instanceof Error);
  });
});
