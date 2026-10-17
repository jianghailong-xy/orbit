/**
 * Failure recovery and visibility, the same on both run backends (docs/managed-runner-design.md,
 * "Implementation record: failure recovery and visibility"). Every case runs twice with the same
 * manager, service and assertions: on Kubernetes — the in-memory namespace of
 * test-support/fake-kube-client.ts with the single-Pod admission guard installed — and on Docker —
 * DockerBackend over test-support/fake-docker-channel.ts — against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty. The clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-recovery.pg.spec.ts
 *
 *   (1) an instance whose host reports it stopped — its host or Docker restarting — is started again
 *       by itself, without a retry: the stopped instance removed by UID after the backoff, then the
 *       next generation on the same volume and runner; never two instances on the volume, compute
 *       held throughout, one warning with the exit code. A stop nobody reported still fences;
 *   (2) a crash loop — stops in READY and in STARTING — spends the attempt budget and ends FAILED
 *       (POD_TERMINATED, retryable), its compute held with the stopped instance; the owner's retry
 *       starts afresh. A runner that stayed READY twice the longest backoff starts its count again;
 *   (3) running out of memory is logged and said to the owner while the runner restarts, until it is
 *       READY, and once the budget is spent (POD_OUT_OF_MEMORY); the host's OOM flag on a runner that
 *       was not killed (exit 255 after a restart) is not out of memory;
 *   (4) an instance that stops after its owner asked it to sleep goes to sleep, compute back only
 *       after the stop proof and the removal;
 *   (5) a wake while something else holds the volume (a backup's helper container; on Kubernetes an
 *       attachment that is not its own) waits — VOLUME_IN_USE, nothing created or spent, no startup
 *       deadline running — and completes by itself once the volume is free; on Docker a holder that
 *       comes between that look and the create is the same wait;
 *   (6) a volume lost while asleep fails the wake (PVC_MISSING), not retryable while it is missing,
 *       another volume is under its name, or the restored one is still held (by the restore's own
 *       container); restored as recorded and free it becomes retryable (PVC_RESTORED), and the retry
 *       starts the runner on it;
 *   (7) Docker only, since the cap is the channel's: a start refused at the channel's cap on
 *       containers (CONTAINER_LIMIT, the cap lowered under running runners) waits for room as for a
 *       held volume — nothing created or spent, no startup deadline running, said once — and starts
 *       by itself once another runner's container is removed.
 *
 * Not destructive: every row belongs to a user this run creates, and each world has a pool of its own.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY, managedRunnerDisplay } from '@orbit/shared';
import { Prisma, type ManagedRunner, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { testDockerRunnerProfile } from '../test-support/docker-runner-profile.fixture';
import { FakeDockerChannel } from '../test-support/fake-docker-channel';
import { IDLE, managedRunnerWorld, quiet } from '../test-support/managed-runner-world';
import { DockerBackend } from './docker-backend';
import type { PersistentVolumeClaim, Pod } from './kube-client';
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import { buildManagedPvc, managedPodName } from './managed-runner-resources';
import type { ManagedRunnerRuntime } from './managed-runner-runtime';
import { managedRunnerHeartbeat, storedWorkloadFor } from './managed-runner-sleep';
import { recordManagedDemand } from './managed-runner-work';
import { ManagedRunnerWorker } from './managed-runner-worker';
import { ManagedRunnerService } from './managed-runner.service';

const URL = process.env.COORDINATOR_PG_URL;
const ON = { enabled: true, problem: null } as const;
type Lifecycle = Partial<ManagedRunnerProfile['lifecycle']>;

/**
 * One backend's world, as the cases below use it: the manager and service, the test's clock, the
 * runner's side (its heartbeat, its acceptance of a sleep), and the host's — a stop it reports, an
 * instance gone without a report, something else holding the volume, the volume lost and restored.
 */
interface Rig {
  readonly backend: 'kubernetes' | 'docker';
  readonly lifecycle: ManagedRunnerProfile['lifecycle'];
  /** The manager's warnings, in order. */
  readonly logs: string[];
  readonly manager: ManagedRunnerManager;
  readonly service: ManagedRunnerService;
  now(): Date;
  advance(ms: number): void;
  /** The clock moved to just after `at`. */
  skipTo(at: Date): void;
  mappingOf(ownerId: string): Promise<ManagedRunner>;
  heartbeat(runnerId: string): Promise<void>;
  readyRunner(label: string): Promise<{ ownerId: string; mapping: ManagedRunner }>;
  putToSleep(ownerId: string): Promise<ManagedRunner>;
  /** The host reports the runner's instance stopped: Kubernetes' kubelet, Docker's exit record. */
  stop(runnerId: string, exitCode: number, outOfMemory?: boolean): void;
  /** The instance gone with no report of how. */
  vanish(runnerId: string): void;
  /** The instance under the runner's fixed name, if any. */
  instance(runnerId: string): { uid: string } | null;
  /** How many of this backend's instances refer to the mapping's volume. */
  onVolume(mapping: ManagedRunner): number;
  /** Something that is not an instance of the mapping holds its volume, and lets it go. */
  hold(mapping: ManagedRunner): void;
  release(mapping: ManagedRunner): void;
  /** Docker: the channel refuses the next create VOLUME_IN_USE (a holder that came after the manager looked). */
  raceHolder?(): void;
  /** Docker: the channel's cap on containers (`limits.maxContainers`), set after the pool was measured. */
  capContainers?(max: number): void;
  /** The volume deleted; the function puts it back as it was, identity and all. */
  loseVolume(mapping: ManagedRunner): () => void;
  /** Another volume under the mapping's volume name; the function removes it again. */
  impostor(mapping: ManagedRunner): () => void;
  volumesCreated(): number;
  instancesRemoved(): number;
  /** Compute shares (instances) reserved in this world's pool. */
  computeReserved(): Promise<number>;
}

function capture(logs: string[]) {
  return { warn: (message: string) => void logs.push(message), error: (message: string) => void logs.push(message) };
}

test('managed runner recovery: restarts, visibility, a held volume and a restored one, on both backends', {
  skip: !URL, concurrency: 1, timeout: 900_000,
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

  function kubernetes(lifecycle: Lifecycle = {}): Rig {
    const logs: string[] = [];
    const w = managedRunnerWorld(db, { lifecycle, log: capture(logs) });
    const claimOf = (mapping: ManagedRunner) => w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', mapping.pvcName)!;
    const foreign = new Map<string, string>();
    return {
      backend: 'kubernetes',
      lifecycle: w.profile.lifecycle,
      logs,
      manager: w.primary,
      service: w.service,
      now: w.now,
      advance: w.advance,
      skipTo: (at) => void (w.clock.ms = at.getTime() + 1),
      mappingOf: w.mappingOf,
      heartbeat: (runnerId) => w.heartbeat(runnerId),
      readyRunner: w.readyRunner,
      putToSleep: w.putToSleep,
      stop: (runnerId, exitCode, outOfMemory = false) => w.cluster.stopPod(managedPodName(runnerId), exitCode, outOfMemory ? 'OOMKilled' : undefined),
      vanish: (runnerId) => w.cluster.remove('pods', managedPodName(runnerId)),
      instance: (runnerId) => {
        const pod = w.cluster.object<Pod>('pods', managedPodName(runnerId));
        return pod ? { uid: pod.metadata.uid! } : null;
      },
      onVolume: (mapping) => w.cluster.all<Pod>('pods').filter((pod) => (pod.spec.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === mapping.pvcName)).length,
      // An attachment of the volume to another node, which no Pod of this mapping made.
      hold: (mapping) => {
        const pv = claimOf(mapping).spec.volumeName!;
        const name = `csi-${pv}-maintenance-node`;
        foreign.set(mapping.id, name);
        w.cluster.volumeAttachments.set(name, {
          apiVersion: 'storage.k8s.io/v1', kind: 'VolumeAttachment', metadata: { name, uid: randomUUID() },
          spec: { attacher: 'rbd.csi.ceph.com', nodeName: 'maintenance-node', source: { persistentVolumeName: pv } }, status: { attached: true },
        });
      },
      release: (mapping) => void w.cluster.volumeAttachments.delete(foreign.get(mapping.id)!),
      loseVolume: (mapping) => {
        const claim = claimOf(mapping);
        w.cluster.remove('persistentvolumeclaims', mapping.pvcName);
        return () => void w.cluster.plant('persistentvolumeclaims', claim);
      },
      impostor: (mapping) => {
        w.cluster.plant('persistentvolumeclaims', buildManagedPvc({ ownerId: mapping.ownerId, runnerId: mapping.runnerId, generation: 1, namespace: mapping.namespace }, w.profile));
        return () => w.cluster.remove('persistentvolumeclaims', mapping.pvcName);
      },
      volumesCreated: () => w.cluster.calls.filter((c) => c.op === 'create' && c.kind === 'persistentvolumeclaims').length,
      instancesRemoved: () => w.cluster.count('delete', 'pods'),
      computeReserved: async () => (await w.ledger()).pool.pods,
    };
  }

  function docker(lifecycle: Lifecycle = {}): Rig {
    const logs: string[] = [];
    const profile = testDockerRunnerProfile({ clusterKey: `recovery-${randomUUID().slice(0, 8)}`, lifecycle });
    const channel = new FakeDockerChannel(profile.docker.instanceId, profile.runner.image);
    const clock = { ms: Date.now() };
    const now = () => new Date(clock.ms);
    const manager = new ManagedRunnerManager(prisma, new DockerBackend(channel, profile), profile, { holder: 'docker-replica', now, random: () => 0.5, log: capture(logs) });
    const runtime: ManagedRunnerRuntime = { available: true, profile, manager, worker: new ManagedRunnerWorker(manager, 60_000, quiet) };
    const service = new ManagedRunnerService(prisma, ON, runtime);
    const mappingOf = async (ownerId: string) => (await db.managedRunner.findUnique({ where: { ownerId } }))!;
    const rig: Rig = {
      backend: 'docker',
      lifecycle: profile.lifecycle,
      logs,
      manager,
      service,
      now,
      advance: (ms) => void (clock.ms += ms),
      skipTo: (at) => void (clock.ms = at.getTime() + 1),
      mappingOf,
      heartbeat: async (runnerId) => {
        const mapping = (await db.managedRunner.findUnique({ where: { runnerId } }))!;
        await db.runner.update({
          where: { id: runnerId },
          data: {
            status: 'ONLINE',
            lastHeartbeatAt: now(),
            engines: [{ engine: 'codex', installed: true, auth: 'yes' }],
            capabilities: [MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY],
            managedWorkload: mapping.podUid
              ? (storedWorkloadFor(IDLE, { mappingId: mapping.id, generation: mapping.generation, podUid: mapping.podUid }, false, now()) as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
          },
        });
      },
      readyRunner: async (label) => {
        const ownerId = (await db.user.create({ data: { email: `${label}-${randomUUID()}@example.invalid`, name: label } })).id;
        await service.ensure(ownerId, `ensure-${label}`);
        const outcomes = await drive(rig, ownerId);
        assert.equal(outcomes.at(-1), 'READY', `${label}: ${outcomes.join(' → ')}`);
        return { ownerId, mapping: await mappingOf(ownerId) };
      },
      putToSleep: async (ownerId) => {
        const ready = await mappingOf(ownerId);
        rig.advance(profile.lifecycle.idleSeconds * 1000 + 1_000);
        await db.runner.update({
          where: { id: ready.runnerId },
          data: {
            lastHeartbeatAt: now(),
            managedWorkload: storedWorkloadFor({ ...IDLE, idleSeconds: profile.lifecycle.idleSeconds + 1 }, { mappingId: ready.id, generation: ready.generation, podUid: ready.podUid! }, false, now()) as unknown as Prisma.InputJsonValue,
          },
        });
        assert.equal(await manager.reconcile(ready.id), 'DRAINING', 'idle long enough: it drains');
        const draining = await mappingOf(ownerId);
        const answer = await managedRunnerHeartbeat(
          prisma,
          { mappingId: draining.id, generation: draining.generation, podUid: draining.podUid! },
          { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() },
          now(),
        );
        assert.equal(answer.sleep?.confirmed, true);
        channel.exit(draining.runnerId, 0);
        const outcomes = await settle(rig, ownerId, 'SLEEPING');
        assert.equal(outcomes.at(-1), 'SLEEPING', outcomes.join(' → '));
        return mappingOf(ownerId);
      },
      stop: (runnerId, exitCode, outOfMemory = false) => channel.exit(runnerId, exitCode, outOfMemory),
      vanish: (runnerId) => channel.vanish(runnerId),
      instance: (runnerId) => channel.containers.get(`mr-${runnerId}`) ?? null,
      onVolume: (mapping) => [...channel.containers.values()].filter((c) => c.volume === mapping.pvcName).length,
      // A container outside this instance that refers to the volume, as a backup's helper does.
      hold: (mapping) => void channel.foreignHolders.set(mapping.pvcName, 1),
      release: (mapping) => void channel.foreignHolders.delete(mapping.pvcName),
      raceHolder: () => channel.failNext('createContainer', { kind: 'refused', status: 409, code: 'VOLUME_IN_USE' }),
      capContainers: (max) => void (channel.limits = { maxContainers: max }),
      loseVolume: (mapping) => {
        const volume = channel.volumes.get(mapping.pvcName)!;
        channel.volumes.delete(mapping.pvcName);
        return () => void channel.volumes.set(mapping.pvcName, volume);
      },
      impostor: (mapping) => {
        channel.volumes.set(mapping.pvcName, {
          name: mapping.pvcName, uid: randomUUID(), ownerId: mapping.ownerId, runnerId: mapping.runnerId, limitBytes: 10 * 2 ** 30, createdAt: null, usageBytes: null,
        });
        return () => void channel.volumes.delete(mapping.pvcName);
      },
      volumesCreated: () => channel.count('ensureVolume'),
      instancesRemoved: () => channel.count('removeContainer'),
      computeReserved: async () => {
        const { rows } = await sql.query(`SELECT pods_reserved FROM managed_runner_capacity WHERE cluster_key = $1 AND namespace = $2`, [profile.clusterKey, profile.docker.instanceId]);
        return Number(rows[0]?.pods_reserved ?? 0);
      },
    };
    return rig;
  }

  /**
   * Reconcile until `until` (READY by default) or FAILED: past every backoff, the runner heartbeating
   * once its instance runs. `watch` sees the row after every pass.
   */
  async function drive(r: Rig, ownerId: string, until: ReconcileOutcome[] = ['READY'], watch?: (m: ManagedRunner) => Promise<void>): Promise<ReconcileOutcome[]> {
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < 60; i += 1) {
      const outcome = await r.manager.reconcile((await r.mappingOf(ownerId)).id);
      outcomes.push(outcome);
      const after = await r.mappingOf(ownerId);
      await watch?.(after);
      if (until.includes(outcome) || outcome === 'FAILED') return outcomes;
      if (after.podUid && after.managementState === 'STARTING') {
        r.advance(1_000);
        await r.heartbeat(after.runnerId);
      }
      if (after.nextAttemptAt && after.nextAttemptAt > r.now() && after.managementState !== 'WAITING_CAPACITY') r.skipTo(after.nextAttemptAt);
    }
    return outcomes;
  }

  async function settle(r: Rig, ownerId: string, until: ReconcileOutcome, steps = 8): Promise<ReconcileOutcome[]> {
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < steps && outcomes.at(-1) !== until; i += 1) outcomes.push(await r.manager.reconcile((await r.mappingOf(ownerId)).id));
    return outcomes;
  }

  /** Past the backoff to the next generation's instance, created and recorded, before it reports in. */
  async function untilStarted(r: Rig, ownerId: string): Promise<ManagedRunner> {
    for (let i = 0; i < 30; i += 1) {
      const mapping = await r.mappingOf(ownerId);
      if (mapping.managementState === 'STARTING' && mapping.podUid && r.instance(mapping.runnerId)?.uid === mapping.podUid) return mapping;
      if (mapping.nextAttemptAt && mapping.nextAttemptAt > r.now()) r.skipTo(mapping.nextAttemptAt);
      await r.manager.reconcile(mapping.id);
    }
    assert.fail(`no instance started: ${(await r.mappingOf(ownerId)).managementState}`);
  }

  const codeOf = (m: ManagedRunner) => (m.lastError as { code?: string } | null)?.code ?? null;
  const stops = (r: Rig) => r.logs.filter((line) => line.includes('POD_TERMINATED'));

  /** One case, run on each backend. */
  async function both(name: string, body: (r: Rig) => Promise<void>, lifecycle: Lifecycle = {}): Promise<void> {
    for (const make of [kubernetes, docker]) {
      const r = make(lifecycle);
      await t.test(`${name} [${r.backend}]`, () => body(r));
    }
  }

  await both('(1) an instance its host reports stopped is started again by itself: the next generation, the same volume and runner', async (r) => {
    const { ownerId, mapping } = await r.readyRunner('restart');
    const credential = (await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } })).tokenHash;
    assert.equal(await r.computeReserved(), 1);

    // A host or Docker restart: the host reports the instance exited (Docker after a power cut: 255, FinishedAt at its restart).
    r.stop(mapping.runnerId, 255);
    assert.equal(await r.manager.reconcile(mapping.id), 'BACKOFF');
    const restarting = await r.mappingOf(ownerId);
    assert.deepEqual(
      { state: restarting.managementState, desired: restarting.desiredState, generation: restarting.generation, podUid: restarting.podUid, attempt: restarting.attempt, code: codeOf(restarting) },
      { state: 'REQUESTED', desired: 'RUNNING', generation: 1, podUid: mapping.podUid, attempt: 1, code: 'POD_RESTARTING' },
    );
    assert.equal((restarting.fencingReceipt as { kind: string }).kind, 'OBSERVED_STOP', 'the host\'s report is the stop proof');
    assert.ok(restarting.nextAttemptAt! > r.now(), 'after the backoff of its first attempt');
    assert.equal(stops(r).length, 1, 'one warning for the stop');
    assert.match(stops(r)[0], /stopped in READY with exit code 255, not out of memory; starting generation 2 on the same volume in \d+ s \(attempt 1 of 3\)/);

    // The owner sees it coming back, and why; no retry is offered or needed.
    const status = await r.service.status(ownerId);
    const display = managedRunnerDisplay(status)!;
    assert.deepEqual({ kind: display.kind, retry: display.retry, acceptsWork: display.acceptsWork, code: status.reason?.code }, { kind: 'waking', retry: false, acceptsWork: true, code: 'POD_RESTARTING' });
    assert.equal(display.detail, 'The runner instance stopped, so it is being started again on the same data volume. Messages sent meanwhile wait for it.');

    // Within the backoff nothing is done: the stopped instance is still there, nothing new is made.
    assert.equal(await r.manager.reconcile(mapping.id), 'BACKOFF');
    assert.equal(r.instance(mapping.runnerId)?.uid, mapping.podUid);
    assert.equal(r.instancesRemoved(), 0);

    // Then, with no retry: the stopped instance removed by UID, never two instances on the volume, one compute share held throughout.
    const outcomes = await drive(r, ownerId, ['READY'], async (m) => {
      assert.ok(r.onVolume(m) <= 1, `${m.managementState}: ${r.onVolume(m)} instances on the volume`);
      assert.equal(await r.computeReserved(), 1, `${m.managementState}: compute neither released nor taken twice`);
    });
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const back = await r.mappingOf(ownerId);
    assert.deepEqual(
      { generation: back.generation, runnerId: back.runnerId, workspace: back.defaultWorkspaceId, pvcName: back.pvcName, pvcUid: back.pvcUid, volumeHandle: back.volumeHandle, lastRequestKey: back.lastRequestKey },
      { generation: 2, runnerId: mapping.runnerId, workspace: mapping.defaultWorkspaceId, pvcName: mapping.pvcName, pvcUid: mapping.pvcUid, volumeHandle: mapping.volumeHandle, lastRequestKey: mapping.lastRequestKey },
      'the same runner, workspace and volume; nobody asked',
    );
    assert.notEqual(back.podUid, mapping.podUid, 'a new instance');
    assert.equal(r.instance(mapping.runnerId)?.uid, back.podUid);
    assert.deepEqual([r.instancesRemoved(), r.volumesCreated()], [1, 1], 'the stopped instance removed once, the volume never made again');
    assert.deepEqual([back.attempt, back.lastError], [1, null], 'READY, the attempt still counted until it has stayed up');
    assert.notEqual((await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } })).tokenHash, credential, 'generation 1\'s credential is dead');
    assert.equal((await r.service.status(ownerId)).managementState, 'READY');

    // A stop nobody reported proves nothing: no restart, FENCING as before, compute kept.
    r.vanish(back.runnerId);
    assert.equal(await r.manager.reconcile(back.id), 'FENCING');
    const fenced = await r.mappingOf(ownerId);
    assert.deepEqual([codeOf(fenced), fenced.generation, r.instance(back.runnerId)], ['PREDECESSOR_STOP_UNPROVEN', 2, null]);
    assert.equal(await r.computeReserved(), 1);
    assert.equal(stops(r).length, 1, 'no POD_TERMINATED for a stop nobody reported');
  });

  await both('(2) a crash loop spends the attempt budget and ends FAILED; the retry starts afresh; a runner that stayed up starts its count again', async (r) => {
    const { ownerId, mapping } = await r.readyRunner('loop');
    // Stop 1, in READY: started again.
    r.stop(mapping.runnerId, 1);
    assert.equal(await r.manager.reconcile(mapping.id), 'BACKOFF');
    // Stop 2: the next instance dies while STARTING, before it ever reports in.
    let started = await untilStarted(r, ownerId);
    assert.equal(started.generation, 2);
    r.stop(mapping.runnerId, 1);
    assert.equal(await r.manager.reconcile(mapping.id), 'BACKOFF');
    assert.deepEqual([(await r.mappingOf(ownerId)).attempt, codeOf(await r.mappingOf(ownerId))], [2, 'POD_RESTARTING']);
    // Stop 3 spends the last attempt (maxAttempts 3): FAILED, retryable; the stopped instance and its compute are kept.
    started = await untilStarted(r, ownerId);
    assert.equal(started.generation, 3);
    r.stop(mapping.runnerId, 1);
    assert.equal(await r.manager.reconcile(mapping.id), 'FAILED');
    const failed = await r.mappingOf(ownerId);
    assert.deepEqual(
      { state: failed.managementState, code: codeOf(failed), retryable: (failed.lastError as { retryable: boolean }).retryable, attempt: failed.attempt, podUid: failed.podUid },
      { state: 'FAILED', code: 'POD_TERMINATED', retryable: true, attempt: 3, podUid: started.podUid },
    );
    assert.equal(r.instance(mapping.runnerId)?.uid, started.podUid, 'kept until the retry removes it');
    assert.equal(await r.computeReserved(), 1, 'held while a stopped instance is recorded');
    assert.equal(stops(r).length, 3, 'one warning per stop');
    assert.match(stops(r)[1], /stopped in STARTING with exit code 1, not out of memory; starting generation 3/);
    assert.match(stops(r)[2], /stopped in STARTING with exit code 1, not out of memory; FAILED: attempt 3 of 3 in a row/);
    const status = await r.service.status(ownerId);
    const display = managedRunnerDisplay(status)!;
    assert.deepEqual({ kind: display.kind, retry: display.retry, canRetry: status.actions.canRetry }, { kind: 'failed', retry: true, canRetry: true });
    assert.equal(display.detail, 'The runner instance stopped too often to be started again automatically. A retry starts it again and keeps the data volume.');

    // The owner's retry: a fresh budget, the same volume.
    await r.service.retry(ownerId, 'retry-loop', failed.revision);
    assert.equal((await drive(r, ownerId)).at(-1), 'READY');
    const retried = await r.mappingOf(ownerId);
    assert.deepEqual({ generation: retried.generation, attempt: retried.attempt, pvcUid: retried.pvcUid }, { generation: 4, attempt: 0, pvcUid: mapping.pvcUid });

    // Two quick stops leave it READY with two attempts counted; up for twice the longest backoff, the next stop counts from one.
    for (const generation of [5, 6]) {
      r.stop(mapping.runnerId, 255);
      assert.equal(await r.manager.reconcile(mapping.id), 'BACKOFF');
      assert.equal((await drive(r, ownerId)).at(-1), 'READY');
      assert.equal((await r.mappingOf(ownerId)).generation, generation);
    }
    assert.equal((await r.mappingOf(ownerId)).attempt, 2);
    r.advance(2 * r.lifecycle.backoffMaxSeconds * 1000 + 1_000);
    r.stop(mapping.runnerId, 255);
    assert.equal(await r.manager.reconcile(mapping.id), 'BACKOFF', 'started again, not FAILED');
    assert.equal((await r.mappingOf(ownerId)).attempt, 1);
  });

  await both('(3) out of memory is logged and said to the owner while it restarts and once the budget is spent', async (r) => {
    const { ownerId, mapping } = await r.readyRunner('oom');
    r.stop(mapping.runnerId, 137, true);
    assert.equal(await r.manager.reconcile(mapping.id), 'BACKOFF');
    assert.equal(codeOf(await r.mappingOf(ownerId)), 'POD_RESTARTING_OUT_OF_MEMORY');
    assert.match(stops(r)[0], /exit code 137, out of memory; starting generation 2/);
    const restarting = managedRunnerDisplay(await r.service.status(ownerId))!;
    assert.deepEqual([restarting.kind, restarting.detail], ['waking', 'The runner ran out of memory and stopped, so it is being started again on the same data volume. Messages sent meanwhile wait for it.']);

    // The reason stands through the whole restart — the backoff, admission, provisioning, the start — until READY.
    const seen = new Set<string>();
    assert.equal((await drive(r, ownerId, ['READY'], async (m) => void seen.add(`${m.managementState}:${codeOf(m)}`))).at(-1), 'READY');
    assert.deepEqual([...seen].filter((s) => !s.startsWith('READY')).map((s) => s.split(':')[1]).filter((c) => c !== 'POD_RESTARTING_OUT_OF_MEMORY'), [], [...seen].join(', '));
    assert.equal(codeOf(await r.mappingOf(ownerId)), null, 'READY says nothing more');

    // Out of memory again and again: the budget spent, FAILED with its own reason.
    r.stop(mapping.runnerId, 137, true);
    assert.equal(await r.manager.reconcile(mapping.id), 'BACKOFF');
    await untilStarted(r, ownerId);
    r.stop(mapping.runnerId, 137, true);
    assert.equal(await r.manager.reconcile(mapping.id), 'FAILED');
    const failed = await r.mappingOf(ownerId);
    assert.deepEqual([codeOf(failed), (failed.lastError as { retryable: boolean }).retryable], ['POD_OUT_OF_MEMORY', true]);
    const display = managedRunnerDisplay(await r.service.status(ownerId))!;
    assert.deepEqual({ kind: display.kind, retry: display.retry }, { kind: 'failed', retry: true });
    assert.equal(display.detail, 'The runner kept running out of memory, so it is not started again automatically. A retry starts it again and keeps the data volume; if it keeps happening, an operator can give runners more memory.');
    assert.match(stops(r).at(-1)!, /exit code 137, out of memory; FAILED: attempt 3 of 3/);

    // The host's OOM flag on a runner that was not killed (exit 255 after a restart, a child process killed earlier) is not out of memory.
    await r.service.retry(ownerId, 'retry-oom', failed.revision);
    assert.equal((await drive(r, ownerId)).at(-1), 'READY');
    r.stop(mapping.runnerId, 255, true);
    assert.equal(await r.manager.reconcile(mapping.id), 'BACKOFF');
    assert.equal(codeOf(await r.mappingOf(ownerId)), 'POD_RESTARTING');
    assert.match(stops(r).at(-1)!, /exit code 255, not out of memory/);
  });

  await both('(4) an instance that stops after its owner asked it to sleep goes to sleep', async (r) => {
    const { ownerId, mapping } = await r.readyRunner('asked');
    await r.heartbeat(mapping.runnerId);
    await r.service.sleep(ownerId, 'sleep-asked', (await r.mappingOf(ownerId)).revision);
    r.stop(mapping.runnerId, 0);
    const outcomes = await settle(r, ownerId, 'SLEEPING');
    assert.equal(outcomes.at(-1), 'SLEEPING', outcomes.join(' → '));
    const asleep = await r.mappingOf(ownerId);
    assert.deepEqual(
      { state: asleep.managementState, desired: asleep.desiredState, generation: asleep.generation, podUid: asleep.podUid, pvcUid: asleep.pvcUid },
      { state: 'SLEEPING', desired: 'SLEEPING', generation: 2, podUid: null, pvcUid: mapping.pvcUid },
    );
    assert.equal((asleep.fencingReceipt as { kind: string }).kind, 'OBSERVED_STOP');
    assert.deepEqual([r.instance(mapping.runnerId), r.instancesRemoved(), await r.computeReserved()], [null, 1, 0], 'removed by UID, then compute back');
    assert.match(stops(r)[0], /its owner asked it to sleep, so it goes to sleep/);
  });

  await both('(5) a wake while something else holds the volume waits, and completes by itself once the volume is free', async (r) => {
    const { ownerId } = await r.readyRunner('held');
    const asleep = await r.putToSleep(ownerId);
    r.hold(asleep);
    assert.ok(await recordManagedDemand(prisma, asleep.runnerId, r.now()), 'a message wakes it');
    const outcomes = await drive(r, ownerId, ['WAITING']);
    assert.equal(outcomes.at(-1), 'WAITING', outcomes.join(' → '));
    const held = await r.mappingOf(ownerId);
    assert.deepEqual(
      { state: held.managementState, code: codeOf(held), attempt: held.attempt, podUid: held.podUid, deadline: held.startupDeadlineAt, generation: held.generation },
      { state: 'STARTING', code: 'VOLUME_IN_USE', attempt: 0, podUid: null, deadline: null, generation: asleep.generation },
    );
    assert.equal(r.instance(asleep.runnerId), null, 'nothing is created on a held volume');
    const display = managedRunnerDisplay(await r.service.status(ownerId))!;
    assert.deepEqual([display.kind, display.retry, display.acceptsWork], ['waking', false, true]);
    assert.equal(display.detail, "Something else is using this runner's data volume, such as a backup, so the runner is not started on it yet. It starts once the volume is free.");

    // Past the startup deadline, pass after pass: still waiting, nothing spent, failed or written.
    r.advance((r.lifecycle.startupDeadlineSeconds + 60) * 1000);
    for (let i = 0; i < 5; i += 1) assert.equal(await r.manager.reconcile(held.id), 'WAITING');
    const still = await r.mappingOf(ownerId);
    assert.deepEqual([still.managementState, still.revision, still.attempt], ['STARTING', held.revision, 0]);
    assert.equal(r.logs.filter((line) => line.includes('VOLUME_IN_USE')).length, 1, 'said once');

    // The holder goes: the runner starts by itself, on the same volume, with a startup deadline from now.
    r.release(asleep);
    const freed = r.now();
    const awake = await drive(r, ownerId, ['READY'], async (m) => {
      assert.ok(r.onVolume(m) <= 1);
      if (m.managementState === 'STARTING' && m.startupDeadlineAt) assert.ok(m.startupDeadlineAt.getTime() >= freed.getTime() + r.lifecycle.startupDeadlineSeconds * 1000);
    });
    assert.equal(awake.at(-1), 'READY', awake.join(' → '));
    const ready = await r.mappingOf(ownerId);
    assert.deepEqual({ generation: ready.generation, pvcUid: ready.pvcUid, attempt: ready.attempt, lastError: ready.lastError }, { generation: asleep.generation, pvcUid: asleep.pvcUid, attempt: 0, lastError: null });

    if (!r.raceHolder) return;
    // Docker: a holder that comes between the manager's look and its create is refused by the channel — the same wait, the create settled.
    const again = await r.putToSleep(ownerId);
    r.raceHolder();
    assert.ok(await recordManagedDemand(prisma, again.runnerId, r.now()));
    assert.equal((await drive(r, ownerId, ['WAITING'])).at(-1), 'WAITING');
    const raced = await r.mappingOf(ownerId);
    assert.deepEqual(
      { state: raced.managementState, code: codeOf(raced), podUid: raced.podUid, operation: raced.resourceOperationState, deadline: raced.startupDeadlineAt },
      { state: 'STARTING', code: 'VOLUME_IN_USE', podUid: null, operation: 'COMPLETED', deadline: null },
    );
    assert.equal((await drive(r, ownerId)).at(-1), 'READY', 'and the next pass starts it');
  });

  await both('(6) a volume lost while asleep fails the wake; restored as recorded, it can be retried and the runner continues on it', async (r) => {
    const { ownerId } = await r.readyRunner('lost');
    const asleep = await r.putToSleep(ownerId);
    const restore = r.loseVolume(asleep);
    assert.ok(await recordManagedDemand(prisma, asleep.runnerId, r.now()));
    assert.equal((await drive(r, ownerId)).at(-1), 'FAILED');
    const failed = await r.mappingOf(ownerId);
    assert.deepEqual([codeOf(failed), (failed.lastError as { retryable: boolean }).retryable], ['PVC_MISSING', false]);
    assert.equal(await r.computeReserved(), 0, 'nothing ran: compute back');
    await assert.rejects(r.service.retry(ownerId, 'retry-missing', failed.revision), (e: { getStatus(): number }) => e.getStatus() === 409);

    // Looked for again on every pass; nothing written while it stays missing.
    assert.ok((await r.manager.dueMappings(500)).includes(failed.id));
    assert.equal(await r.manager.reconcile(failed.id), 'FAILED');
    assert.equal((await r.mappingOf(ownerId)).revision, failed.revision);

    // Another volume under its name is not it: still PVC_MISSING, with what is wrong for the operator.
    const removeImpostor = r.impostor(asleep);
    assert.equal(await r.manager.reconcile(failed.id), 'FAILED');
    const wrong = await r.mappingOf(ownerId);
    assert.equal(codeOf(wrong), 'PVC_MISSING');
    assert.match((wrong.lastError as { detail: string }).detail, /not the recorded one: PVC_CONFLICT/);
    assert.equal((await r.service.status(ownerId)).actions.canRetry, false);
    removeImpostor();

    // Restored as recorded (the runbook's restore keeps the identity), while the restore's own container still holds
    // it: not yet retryable, so no retry can start the runner on a volume still being written.
    restore();
    r.hold(asleep);
    assert.equal(await r.manager.reconcile(failed.id), 'FAILED');
    const restoring = await r.mappingOf(ownerId);
    assert.equal(codeOf(restoring), 'PVC_MISSING');
    assert.match((restoring.lastError as { detail: string }).detail, /is back as recorded, and still held by/);
    assert.equal((await r.service.status(ownerId)).actions.canRetry, false);
    // Free: retryable.
    r.release(asleep);
    assert.equal(await r.manager.reconcile(failed.id), 'FAILED');
    const restored = await r.mappingOf(ownerId);
    assert.deepEqual([codeOf(restored), (restored.lastError as { retryable: boolean }).retryable], ['PVC_RESTORED', true]);
    const display = managedRunnerDisplay(await r.service.status(ownerId))!;
    assert.deepEqual([display.kind, display.retry, display.detail], ['failed', true, "This runner's data volume is back as it was recorded. A retry starts the runner on it."]);
    assert.ok(!(await r.manager.dueMappings(500)).includes(failed.id), 'no longer looked for');
    assert.ok(r.logs.some((line) => line.includes('PVC_RESTORED')));

    // The retry: the runner continues on that very volume.
    await r.service.retry(ownerId, 'retry-restored', restored.revision);
    assert.equal((await drive(r, ownerId)).at(-1), 'READY');
    const back = await r.mappingOf(ownerId);
    assert.deepEqual({ runnerId: back.runnerId, pvcUid: back.pvcUid, volumeHandle: back.volumeHandle, generation: back.generation },
      { runnerId: asleep.runnerId, pvcUid: asleep.pvcUid, volumeHandle: asleep.volumeHandle, generation: asleep.generation });
    assert.equal(r.volumesCreated(), 1, 'never an empty volume in its place');
  });

  const capped = docker();
  await t.test(`(7) a start at the channel's cap on containers waits for room, and starts by itself once a container is removed [${capped.backend}]`, async () => {
    const r = capped;
    const a = await r.readyRunner('cap-a');
    const b = await r.readyRunner('cap-b');
    assert.equal(await r.computeReserved(), 2);
    // The operator lowers the cap to one under both; the pool, measured before, still holds two.
    r.capContainers!(1);

    // b's runner crashes. It is started again by itself, and its create meets the cap: a's container counts.
    r.stop(b.mapping.runnerId, 1);
    const outcomes = await drive(r, b.ownerId, ['WAITING']);
    assert.equal(outcomes.at(-1), 'WAITING', outcomes.join(' → '));
    const waiting = await r.mappingOf(b.ownerId);
    assert.deepEqual(
      {
        state: waiting.managementState, code: codeOf(waiting), attempt: waiting.attempt, generation: waiting.generation,
        podUid: waiting.podUid, operation: waiting.resourceOperationState, deadline: waiting.startupDeadlineAt,
      },
      { state: 'STARTING', code: 'CONTAINER_LIMIT', attempt: 1, generation: 2, podUid: null, operation: 'COMPLETED', deadline: null },
    );
    assert.equal(waiting.nextAttemptAt?.getTime(), r.now().getTime() + r.lifecycle.capacityRetrySeconds * 1000, 'asked again after capacityRetrySeconds');
    assert.equal(r.instance(b.mapping.runnerId), null, 'nothing made');
    assert.equal(r.instance(a.mapping.runnerId)?.uid, a.mapping.podUid, "a's container untouched");
    const display = managedRunnerDisplay(await r.service.status(b.ownerId))!;
    assert.deepEqual([display.kind, display.retry, display.acceptsWork], ['waking', false, true]);
    assert.equal(display.detail, 'The Docker host has as many runner containers as it allows, so this runner is not started yet. It starts by itself once one of them is removed, as when another runner goes to sleep.');

    // Asked again and again, past the attempt budget and the startup deadline: still waiting, nothing spent, said once.
    for (let i = 0; i < r.lifecycle.maxAttempts * 3; i += 1) {
      r.skipTo((await r.mappingOf(b.ownerId)).nextAttemptAt!);
      assert.equal(await r.manager.reconcile(waiting.id), 'WAITING');
    }
    r.advance((r.lifecycle.startupDeadlineSeconds + 60) * 1000);
    assert.equal(await r.manager.reconcile(waiting.id), 'WAITING');
    const still = await r.mappingOf(b.ownerId);
    assert.deepEqual([still.managementState, codeOf(still), still.attempt, still.podUid], ['STARTING', 'CONTAINER_LIMIT', 1, null]);
    assert.equal(r.logs.filter((line) => line.includes('CONTAINER_LIMIT')).length, 1, 'said once');
    assert.equal(await r.computeReserved(), 2, 'b keeps its share while it waits');

    // a goes to sleep and its container is removed: there is room, and b starts by itself, its startup deadline from then.
    await r.putToSleep(a.ownerId);
    const room = r.now();
    const awake = await drive(r, b.ownerId, ['READY'], async (m) => {
      assert.ok(r.onVolume(m) <= 1);
      if (m.managementState === 'STARTING' && m.podUid) {
        assert.ok(m.startupDeadlineAt && m.startupDeadlineAt.getTime() >= room.getTime() + r.lifecycle.startupDeadlineSeconds * 1000);
      }
    });
    assert.equal(awake.at(-1), 'READY', awake.join(' → '));
    const ready = await r.mappingOf(b.ownerId);
    assert.deepEqual(
      { generation: ready.generation, runnerId: ready.runnerId, pvcUid: ready.pvcUid, attempt: ready.attempt, lastError: ready.lastError, nextAttemptAt: ready.nextAttemptAt },
      { generation: 2, runnerId: b.mapping.runnerId, pvcUid: b.mapping.pvcUid, attempt: 1, lastError: null, nextAttemptAt: null },
      'the same runner and volume; the restart counted once, the wait not at all',
    );
  });
});
