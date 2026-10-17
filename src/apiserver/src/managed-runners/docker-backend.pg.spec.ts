/**
 * The manager's state machine on DockerBackend (docker-backend.ts), over a channel that keeps the
 * real one's rules in memory (test-support/fake-docker-channel.ts), against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty. The same manager, service and sleep code every
 * backend runs; the clock is the test's. Real Docker is scripts/managed-runner/docker-backend-it.py.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/docker-backend.pg.spec.ts
 *
 *   (1) provisioning: a `docker` mapping in the channel's instance, the volume's identity as the
 *       channel reports it, the guard probe before the one container, an instance UID the runner
 *       door accepts, the credential the channel keeps, and shares of a budget derived from the host;
 *   (2) sleep: the instance accepts and exits; Docker's report (exit code, FinishedAt) is the stop
 *       proof; compute is still held after the exit and released only once the container is removed;
 *       a wake starts the next generation on the same volume with the next credential;
 *   (3) an accepted drain that overruns its drain time is stopped through the channel, and the same
 *       report and removal end it; asking is never the proof;
 *   (4) an abnormal exit of a READY runner: FAILED with Docker's report as the proof, and an owner's
 *       retry replaces it on the same volume;
 *   (5) a container removed by hand, outside the channel: FENCING, and only an operator's host check
 *       moves it on;
 *   (6) a disabled owner's runner that does not stop by itself is stopped past the drain time;
 *   (7) capacity: a budget with room for one runner admits one; the second waits and starts once the
 *       first sleeps;
 *   (8) a Kubernetes mapping in the same database is neither listed nor driven by the Docker manager;
 *   (9) the channel unreachable is a backoff, a volume over its disk limit a FAILED with that reason;
 *  (10) the channel unreachable for many passes spends nothing of a READY or DRAINING runner, which
 *       goes on as it was once the channel answers again.
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
import { testDockerRunnerProfile } from '../test-support/docker-runner-profile.fixture';
import { FakeDockerChannel } from '../test-support/fake-docker-channel';
import { DockerBackend } from './docker-backend';
import { managedRunnerInstanceVerdict } from './managed-runner-instance';
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import type { DockerRunnerProfile } from './managed-runner-profile';
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

test('the manager drives a mapping on DockerBackend, through the restricted channel', {
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

  function world(capacity?: DockerRunnerProfile['capacity']) {
    const profile = testDockerRunnerProfile({ clusterKey: `docker-${randomUUID().slice(0, 8)}`, capacity });
    const channel = new FakeDockerChannel(profile.docker.instanceId, profile.runner.image);
    const backend = new DockerBackend(channel, profile);
    const clock = { ms: Date.now() };
    const now = () => new Date(clock.ms);
    const manager = new ManagedRunnerManager(prisma, backend, profile, { holder: 'docker-replica', now, random: () => 0.5, log: quiet });
    const runtime: ManagedRunnerRuntime = { available: true, profile, manager, worker: new ManagedRunnerWorker(manager, 60_000, quiet) };
    const service = new ManagedRunnerService(prisma, ON, runtime);
    const advance = (ms: number) => void (clock.ms += ms);
    const mappingOf = async (ownerId: string): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId } }))!;

    async function heartbeat(runnerId: string, workload: Partial<typeof IDLE> = {}) {
      const mapping = (await db.managedRunner.findUnique({ where: { runnerId } }))!;
      await db.runner.update({
        where: { id: runnerId },
        data: {
          status: 'ONLINE',
          lastHeartbeatAt: now(),
          engines: [{ engine: 'codex', installed: true, auth: 'yes' }],
          capabilities: [MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY],
          managedWorkload: mapping.podUid
            ? (storedWorkloadFor({ ...IDLE, ...workload }, { mappingId: mapping.id, generation: mapping.generation, podUid: mapping.podUid }, false, now()) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      });
    }

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

    /** Drained for sleep and accepted by the idle instance; still running. */
    async function accepted(ownerId: string): Promise<ManagedRunner> {
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
      return mappingOf(ownerId);
    }

    async function reserved(): Promise<Record<string, number>> {
      const [row] = await sql.query(
        `SELECT cpu_millis, memory_bytes, pods, active_users, storage_usable_bytes, storage_headroom_bytes,
                cpu_millis_reserved, memory_bytes_reserved, ephemeral_bytes_reserved, pods_reserved, attachments_reserved,
                active_users_reserved, durable_bytes_reserved
           FROM managed_runner_capacity WHERE cluster_key = $1 AND namespace = $2`,
        [backend.location.clusterKey, backend.location.namespace],
      ).then((r) => r.rows);
      return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]));
    }

    async function settle(ownerId: string, until: ReconcileOutcome, steps = 8): Promise<ReconcileOutcome[]> {
      const outcomes: ReconcileOutcome[] = [];
      for (let i = 0; i < steps && outcomes.at(-1) !== until; i += 1) outcomes.push(await manager.reconcile((await mappingOf(ownerId)).id));
      return outcomes;
    }

    return { profile, channel, backend, now, advance, manager, service, mappingOf, heartbeat, drive, owner, readyRunner, accepted, reserved, settle };
  }

  const computeHeld = { cpu_millis_reserved: 1000, memory_bytes_reserved: 2 * GiB, ephemeral_bytes_reserved: 512 * 2 ** 20, pods_reserved: 1, attachments_reserved: 1, active_users_reserved: 1 };
  const computeFree = { cpu_millis_reserved: 0, memory_bytes_reserved: 0, ephemeral_bytes_reserved: 0, pods_reserved: 0, attachments_reserved: 0, active_users_reserved: 0 };
  const pick = (row: Record<string, number>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k]]));
  const COMPUTE_KEYS = Object.keys(computeHeld);

  await t.test('(1) provisioning: a docker mapping, the channel\'s identities, the guard before the one container, a host-derived budget', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('provision');
    assert.equal(mapping.backend, 'docker');
    assert.deepEqual({ clusterKey: mapping.clusterKey, namespace: mapping.namespace }, w.backend.location);
    assert.equal(mapping.namespace, w.profile.docker.instanceId, 'the channel\'s instance');
    const volume = w.channel.volumes.get(mapping.pvcName)!;
    const container = w.channel.containers.get(`mr-${mapping.runnerId}`)!;
    assert.deepEqual(
      { pvcUid: mapping.pvcUid, pvUid: mapping.pvUid, volumeHandle: mapping.volumeHandle, podName: mapping.podName, podUid: mapping.podUid, nodeName: mapping.nodeName },
      { pvcUid: volume.uid, pvUid: volume.uid, volumeHandle: `docker:${w.profile.docker.instanceId}/${mapping.pvcName}/${volume.uid}`, podName: container.name, podUid: container.uid, nodeName: 'docker-host-a' },
    );
    assert.equal(volume.limitBytes, 10 * GiB, 'the volume carries its disk limit');
    // The runner door takes the instance UID as it takes a Pod UID.
    assert.equal(managedRunnerInstanceVerdict(mapping, { declared: true, generation: '1', podUid: container.uid }).authorized, true);
    assert.equal((await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } })).tokenHash, sha256(w.channel.credentials.get(mapping.runnerId)!.token!));
    const creates = w.channel.calls.filter((c) => /^(ensureVolume|putCredential|dryRunContainer|createContainer)$/.test(c));
    assert.deepEqual(creates, ['ensureVolume', 'putCredential', 'dryRunContainer', 'createContainer'], 'each once, the guard before the container');
    const pool = await w.reserved();
    // 8 CPUs and 16 GiB less a quarter: 6000m and 12 GiB, six 2 GiB runners; storage from the free disk.
    assert.deepEqual(pick(pool, ['cpu_millis', 'memory_bytes', 'pods', 'active_users', 'storage_usable_bytes', 'storage_headroom_bytes']), {
      cpu_millis: 6000, memory_bytes: 12 * GiB, pods: 6, active_users: 6, storage_usable_bytes: 600 * GiB, storage_headroom_bytes: 100 * GiB,
    });
    assert.deepEqual(pick(pool, [...COMPUTE_KEYS, 'durable_bytes_reserved']), { ...computeHeld, durable_bytes_reserved: 10 * GiB });
    assert.equal((await w.service.status(ownerId)).managementState, 'READY');
  });

  await t.test('(2) sleep ends on Docker\'s report and the removal, compute is released only then, and a wake uses the same volume', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('sleep');
    const before = await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } });
    await w.accepted(ownerId);
    // Accepted, not yet exited: nothing is released, nothing removed.
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING');
    assert.deepEqual(pick(await w.reserved(), COMPUTE_KEYS), computeHeld);
    w.channel.exit(mapping.runnerId, 0);
    const finishedAt = w.channel.containers.get(`mr-${mapping.runnerId}`)!.finishedAt;
    // Exited, and its removal not answered: the report is recorded, and compute is still held.
    w.channel.failNext('removeContainer', { kind: 'unreachable-before' });
    assert.equal(await w.manager.reconcile(mapping.id), 'BACKOFF');
    const exited = await w.mappingOf(ownerId);
    assert.deepEqual([exited.managementState, (exited.fencingReceipt as { kind: string }).kind], ['DRAINING', 'OBSERVED_STOP']);
    assert.equal(w.channel.containers.get(`mr-${mapping.runnerId}`)!.status, 'exited', 'not removed yet');
    assert.deepEqual(pick(await w.reserved(), COMPUTE_KEYS), computeHeld, 'exited is not enough: the container must be gone');
    // Removed by UID: only now does it sleep and give compute back.
    const outcomes = await w.settle(ownerId, 'SLEEPING');
    assert.equal(outcomes.at(-1), 'SLEEPING', outcomes.join(' → '));
    assert.equal(w.channel.count('removeContainer'), 2);
    assert.equal(w.channel.containers.has(`mr-${mapping.runnerId}`), false, 'removed');
    const asleep = await w.mappingOf(ownerId);
    const proof = asleep.fencingReceipt as { kind: string; retiredAt?: string; predecessor: { podUid: string }; observation: { containers: Array<Record<string, unknown>> } };
    assert.deepEqual([proof.kind, proof.predecessor.podUid, typeof proof.retiredAt], ['OBSERVED_STOP', mapping.podUid, 'string']);
    assert.deepEqual(proof.observation.containers, [{ name: 'runner', state: 'terminated', exitCode: 0, finishedAt }], 'Docker\'s report: the exit code and when');
    assert.deepEqual({ state: asleep.managementState, generation: asleep.generation, podUid: asleep.podUid }, { state: 'SLEEPING', generation: 2, podUid: null });
    assert.deepEqual(pick(await w.reserved(), [...COMPUTE_KEYS, 'durable_bytes_reserved']), { ...computeFree, durable_bytes_reserved: 10 * GiB }, 'compute back, storage kept');
    assert.notEqual((await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } })).tokenHash, before.tokenHash, 'the retired generation\'s credential is dead');

    assert.ok(await recordManagedDemand(prisma, mapping.runnerId, w.now()));
    assert.equal((await w.drive(ownerId)).at(-1), 'READY');
    const awake = await w.mappingOf(ownerId);
    const next = w.channel.containers.get(`mr-${mapping.runnerId}`)!;
    assert.deepEqual({ generation: awake.generation, pvcUid: awake.pvcUid, runnerId: awake.runnerId }, { generation: 2, pvcUid: mapping.pvcUid, runnerId: mapping.runnerId });
    assert.deepEqual({ generation: next.generation, volumeUid: next.volumeUid }, { generation: 2, volumeUid: mapping.pvcUid });
    assert.notEqual(awake.podUid, mapping.podUid, 'a new container');
    assert.equal(w.channel.count('ensureVolume'), 1, 'the volume was never created again');
    assert.equal(w.channel.count('deleteCredential'), 1, 'the retired credential was removed');
    assert.equal(w.channel.credentials.get(mapping.runnerId)!.generation, 2);
    assert.deepEqual(pick(await w.reserved(), COMPUTE_KEYS), computeHeld);
  });

  await t.test('(3) an accepted drain that overruns its drain time is stopped, and still ends only on the report and the removal', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('overrun');
    await w.accepted(ownerId);
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING');
    assert.deepEqual(w.channel.stopRequests, [], 'within its drain time nothing is forced');
    // The channel's stop takes effect only on the next read: hold the container running for one pass.
    const stop = w.channel.stopContainer.bind(w.channel);
    let asked = 0;
    w.channel.stopContainer = async (name, uid) => {
      asked += 1;
      w.channel.stopRequests.push({ name, uid });
      return w.channel.containers.get(name) ?? null;
    };
    w.advance(w.profile.lifecycle.drainSeconds * 1000 + 1_000);
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING', 'asked to stop: not yet a proof');
    assert.equal(asked, 1);
    assert.equal(((await w.mappingOf(ownerId)).lastError as { code: string }).code, 'SLEEP_STOP_FORCED');
    assert.deepEqual(pick(await w.reserved(), COMPUTE_KEYS), computeHeld, 'nothing released on asking');
    w.channel.stopContainer = stop;
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING');
    const outcomes = await w.settle(ownerId, 'SLEEPING');
    assert.equal(outcomes.at(-1), 'SLEEPING', outcomes.join(' → '));
    const proof = (await w.mappingOf(ownerId)).fencingReceipt as { observation: { containers: Array<{ exitCode?: number }> } };
    assert.equal(proof.observation.containers[0].exitCode, 143, 'the stop it asked for, as Docker reported it');
    assert.deepEqual(pick(await w.reserved(), COMPUTE_KEYS), computeFree);
  });

  await t.test('(4) an abnormal exit fails the runner on Docker\'s report, and a retry replaces it on the same volume', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('crash');
    w.channel.exit(mapping.runnerId, 137);
    assert.equal(await w.manager.reconcile(mapping.id), 'FAILED');
    const failed = await w.mappingOf(ownerId);
    assert.equal((failed.lastError as { code: string }).code, 'POD_TERMINATED');
    assert.match((failed.lastError as { detail: string }).detail, /exited \(exit 137\)/);
    assert.equal((failed.fencingReceipt as { observation: { containers: Array<{ exitCode?: number }> } }).observation.containers[0].exitCode, 137);
    assert.deepEqual(pick(await w.reserved(), COMPUTE_KEYS), computeHeld, 'a recorded container keeps its compute until it is gone');
    await w.service.retry(ownerId, 'retry-crash', failed.revision);
    assert.equal((await w.drive(ownerId)).at(-1), 'READY');
    const back = await w.mappingOf(ownerId);
    assert.deepEqual({ generation: back.generation, pvcUid: back.pvcUid }, { generation: 2, pvcUid: mapping.pvcUid });
    assert.equal(w.channel.containers.get(`mr-${mapping.runnerId}`)!.generation, 2);
  });

  await t.test('(5) a container removed outside the channel fences, and only an operator\'s host check moves it on', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('vanished');
    w.channel.vanish(mapping.runnerId);
    assert.equal(await w.manager.reconcile(mapping.id), 'FENCING');
    const fenced = await w.mappingOf(ownerId);
    assert.equal((fenced.lastError as { detail: string }).detail, `container ${mapping.podUid} of generation 1 is gone without a stop proof`);
    assert.equal(await w.manager.reconcile(mapping.id), 'FENCING', 'and it waits');
    const predecessor = {
      runnerId: mapping.runnerId, generation: 1, podName: mapping.podName, podUid: mapping.podUid, nodeName: mapping.nodeName,
      pvcUid: mapping.pvcUid, volumeHandle: mapping.volumeHandle,
    };
    const at = new Date(w.now().getTime() - 60_000).toISOString();
    w.channel.receipts.set(mapping.runnerId, {
      schemaVersion: 1, kind: 'orbit.managed-runner.fencing-receipt', method: 'HOST_PROCESS_CHECK', predecessor,
      action: { performedBy: 'operator', performedAt: at, description: 'docker ps -a and fuser on the volume: nothing', reference: 'ops-1' },
      verification: { observedBy: 'second operator', observedAt: at, result: 'NO_PROCESS_OF_THE_INSTANCE', evidenceReference: 'ops-1#2' },
    });
    const outcomes = await w.drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const after = await w.mappingOf(ownerId);
    assert.deepEqual({ generation: after.generation, pvcUid: after.pvcUid }, { generation: 2, pvcUid: mapping.pvcUid });
  });

  await t.test('(6) a disabled owner\'s runner that does not stop by itself is stopped past the drain time', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('disabled');
    await db.user.update({ where: { id: ownerId }, data: { disabledAt: w.now() } });
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING', 'at once');
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING');
    assert.deepEqual(w.channel.stopRequests, []);
    w.advance(w.profile.lifecycle.drainSeconds * 1000 + 1_000);
    const outcomes = await w.settle(ownerId, 'SLEEPING');
    assert.equal(outcomes.at(-1), 'SLEEPING', outcomes.join(' → '));
    assert.equal(w.channel.stopRequests.length, 1);
    assert.deepEqual(pick(await w.reserved(), COMPUTE_KEYS), computeFree);
  });

  await t.test('(7) a budget with room for one runner admits one; the second waits, then starts once the first sleeps', async () => {
    const w = world({ compute: { cpu: '1', memory: '2Gi' } });
    const first = await w.readyRunner('first');
    const second = await w.owner('second');
    await w.service.ensure(second, 'ensure-second');
    assert.equal((await w.drive(second, ['WAITING_CAPACITY'])).at(-1), 'WAITING_CAPACITY');
    assert.equal(((await w.mappingOf(second)).lastError as { code: string }).code, MANAGED_RUNNER_CAPACITY_UNAVAILABLE);
    assert.equal(w.channel.count('ensureVolume'), 1, 'nothing made for the one that waits');
    await w.accepted(first.ownerId);
    w.channel.exit(first.mapping.runnerId, 0);
    assert.equal((await w.settle(first.ownerId, 'SLEEPING')).at(-1), 'SLEEPING');
    assert.equal((await w.drive(second)).at(-1), 'READY');
  });

  await t.test('(8) a Kubernetes mapping in the same database is neither listed nor driven by the Docker manager', async () => {
    const w = world();
    const ownerId = await w.owner('kubernetes');
    await w.service.ensure(ownerId, 'ensure-kubernetes');
    await sql.query(`UPDATE managed_runner SET backend = 'kubernetes' WHERE owner_id = $1`, [ownerId]);
    const theirs = await w.mappingOf(ownerId);
    assert.ok(!(await w.manager.dueMappings(500)).includes(theirs.id), 'not listed');
    assert.equal(await w.manager.reconcile(theirs.id), 'IDLE');
    const after = await w.mappingOf(ownerId);
    assert.deepEqual({ revision: after.revision, state: after.managementState, lease: after.leaseHolder }, { revision: theirs.revision, state: 'REQUESTED', lease: null }, 'untouched, not even leased');
    assert.equal(w.channel.count('ensureVolume'), 0);
  });

  await t.test('(9) the channel unreachable is a backoff; a volume over its disk limit is FAILED with that reason', async () => {
    const w = world();
    const ownerId = await w.owner('unreachable');
    await w.service.ensure(ownerId, 'ensure-unreachable');
    w.channel.failNext('ensureVolume', { kind: 'unreachable-before' });
    assert.equal(await w.manager.reconcile((await w.mappingOf(ownerId)).id), 'BACKOFF');
    assert.equal(((await w.mappingOf(ownerId)).lastError as { code: string }).code, 'TRANSIENT');
    assert.equal((await w.drive(ownerId)).at(-1), 'READY', 'and it goes on');

    const full = await w.owner('full');
    await w.service.ensure(full, 'ensure-full');
    // Its volume already holds more than its limit (the channel's measure): created once, it is adopted as it is.
    const m = await w.mappingOf(full);
    w.channel.volumes.set(m.pvcName, {
      name: m.pvcName, uid: randomUUID(), ownerId: full, runnerId: m.runnerId, limitBytes: 10 * GiB, createdAt: null, usageBytes: 11 * GiB,
    });
    const outcomes = await w.drive(full);
    assert.equal(outcomes.at(-1), 'FAILED', outcomes.join(' → '));
    const failed = await w.mappingOf(full);
    assert.deepEqual([(failed.lastError as { code: string }).code, (failed.lastError as { retryable: boolean }).retryable], ['VOLUME_OVER_LIMIT', true]);
    assert.equal(w.channel.containers.has(`mr-${failed.runnerId}`), false, 'no container on a volume over its limit');
  });

  await t.test('(10) a READY or DRAINING runner the channel does not answer for is left as it was: nothing spent', async () => {
    const w = world({ maxActiveUsers: 2 });
    const { ownerId, mapping } = await w.readyRunner('outage');
    for (let i = 0; i < 20; i += 1) w.channel.failNext('readVolume', { kind: 'unreachable-before' });
    for (let i = 0; i < 20; i += 1) {
      assert.equal(await w.manager.reconcile(mapping.id), 'BACKOFF');
      w.advance(5_000);
    }
    const ready = await w.mappingOf(ownerId);
    assert.deepEqual({ state: ready.managementState, attempt: ready.attempt, lastError: ready.lastError, nextAttemptAt: ready.nextAttemptAt },
      { state: 'READY', attempt: 0, lastError: null, nextAttemptAt: null }, 'twenty unanswered passes, more than maxAttempts: nothing spent, nothing said to the owner');
    w.channel.calls.length = 0;
    assert.equal(await w.manager.reconcile(mapping.id), 'READY', 'answered again: as it was');

    await w.accepted(ownerId);
    for (let i = 0; i < 12; i += 1) w.channel.failNext('readContainer', { kind: 'unreachable-before' });
    for (let i = 0; i < 12; i += 1) assert.equal(await w.manager.reconcile(mapping.id), 'BACKOFF');
    const draining = await w.mappingOf(ownerId);
    assert.deepEqual([draining.managementState, draining.attempt], ['DRAINING', 0]);
    w.channel.exit(mapping.runnerId, 0);
    assert.equal((await w.settle(ownerId, 'SLEEPING')).at(-1), 'SLEEPING');
  });
});
