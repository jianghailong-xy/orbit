import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY } from '@orbit/shared';
import { Prisma, type ManagedRunner, type PrismaClient } from '@prisma/client';

import { ManagedRunnerManager, type ReconcileOutcome } from '../managed-runners/managed-runner-manager';
import type { ManagedRunnerProfile } from '../managed-runners/managed-runner-profile';
import type { ManagedRunnerRuntime } from '../managed-runners/managed-runner-runtime';
import { managedPodName } from '../managed-runners/managed-runner-resources';
import { managedRunnerHeartbeat, storedWorkloadFor } from '../managed-runners/managed-runner-sleep';
import { ManagedRunnerWorker } from '../managed-runners/managed-runner-worker';
import { ManagedRunnerService } from '../managed-runners/managed-runner.service';
import type { PrismaService } from '../prisma/prisma.service';
import { FakeKubeCluster } from './fake-kube-client';
import { installManagedRunnerAdmission } from './managed-runner-admission.fixture';
import { testManagedRunnerProfile } from './managed-runner-profile.fixture';

/**
 * One managed runner test world for the capacity, wake and sleep specs: the in-memory Kubernetes
 * namespace with the single-Pod admission guard installed, a test clock, manager replicas over a real
 * PostgreSQL, the owner-facing service, and the runner's side played by writing what its heartbeat
 * would: a fresh beat, a signed-in runtime, the capabilities a managed instance declares and the
 * workload it reports. No cluster, kubeconfig or credential is involved.
 */

export const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const ON = { enabled: true, problem: null } as const;

/** A workload with nothing in flight, as a managed instance reports it. */
export const IDLE = { activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 0 };

export interface WorldOptions {
  lifecycle?: Partial<ManagedRunnerProfile['lifecycle']>;
  capacity?: Partial<ManagedRunnerProfile['capacity']>;
  /** Another cluster key is another capacity pool. Default: one of the world's own. */
  clusterKey?: string;
}

export function managedRunnerWorld(db: PrismaClient, options: WorldOptions = {}) {
  const prisma = db as unknown as PrismaService;
  const profile = testManagedRunnerProfile({
    lifecycle: options.lifecycle,
    capacity: options.capacity,
    clusterKey: options.clusterKey ?? `world-${randomUUID().slice(0, 8)}`,
  });
  const cluster = installManagedRunnerAdmission(new FakeKubeCluster(profile.kubernetes.namespace), prisma, profile);
  const clock = { ms: Date.now() };
  const now = () => new Date(clock.ms);
  const manager = (holder: string, delayMs = 0) =>
    new ManagedRunnerManager(prisma, cluster.client({ delayMs }), profile, { holder, now, random: () => 0.5, log: quiet });
  const primary = manager('replica-a');
  const runtime: ManagedRunnerRuntime = { available: true, profile, manager: primary, worker: new ManagedRunnerWorker(primary, 60_000, quiet) };
  const service = new ManagedRunnerService(prisma, ON, runtime);
  const advance = (ms: number) => void (clock.ms += ms);

  const mappingOf = async (ownerId: string): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId } }))!;

  /**
   * The runner's heartbeat as the route records it for its authorized instance: fresh, a runtime
   * signed in, the managed capabilities declared and `workload` reported by the instance recorded
   * now. `sleep: false` plays a runner too old to sleep (no capability, no report).
   */
  async function heartbeat(runnerId: string, workload: Partial<typeof IDLE> = {}, opts: { sleep?: boolean; draining?: boolean } = {}) {
    const mapping = (await db.managedRunner.findUnique({ where: { runnerId } }))!;
    const sleep = opts.sleep !== false;
    await db.runner.update({
      where: { id: runnerId },
      data: {
        status: 'ONLINE',
        lastHeartbeatAt: now(),
        engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
        capabilities: sleep ? [MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY] : [MANAGED_RUNNER_INSTANCE_CAPABILITY],
        managedWorkload: sleep && mapping.podUid
          ? (storedWorkloadFor({ ...IDLE, ...workload }, { mappingId: mapping.id, generation: mapping.generation, podUid: mapping.podUid }, opts.draining === true, now()) as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
    });
  }

  /** Reconcile until `until` (READY by default) or FAILED: past every backoff, heartbeating once a Pod runs. */
  async function drive(ownerId: string, until: ReconcileOutcome[] = ['READY'], m = primary, rounds = 40): Promise<ReconcileOutcome[]> {
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const mapping = await mappingOf(ownerId);
      const outcome = await m.reconcile(mapping.id);
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

  async function makeUser(label: string): Promise<string> {
    return (await db.user.create({ data: { email: `${label}-${randomUUID()}@example.invalid`, name: label } })).id;
  }

  /** A new owner whose managed runner is READY. */
  async function readyRunner(label: string): Promise<{ ownerId: string; mapping: ManagedRunner }> {
    const ownerId = await makeUser(label);
    await service.ensure(ownerId, `ensure-${label}`);
    const outcomes = await drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', `${label}: ${outcomes.join(' → ')}`);
    return { ownerId, mapping: await mappingOf(ownerId) };
  }

  /**
   * A READY runner drained to sleep through the whole handshake: idle past the profile's interval by
   * the records and by its instance's report, the drain, the instance's acceptance through the same
   * function the heartbeat route answers with, its exit as the kubelet reports it, and the passes
   * that release the Pod object and fall asleep. Returns the sleeping mapping.
   */
  async function putToSleep(ownerId: string): Promise<ManagedRunner> {
    const ready = await mappingOf(ownerId);
    assert.equal(ready.managementState, 'READY');
    advance(profile.lifecycle.idleSeconds * 1000 + 1_000);
    await heartbeat(ready.runnerId, { idleSeconds: profile.lifecycle.idleSeconds + 1 });
    assert.equal(await primary.reconcile(ready.id), 'DRAINING', 'idle long enough: it drains');
    const draining = await mappingOf(ownerId);
    const answer = await managedRunnerHeartbeat(
      prisma,
      { mappingId: draining.id, generation: draining.generation, podUid: draining.podUid! },
      { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() },
      now(),
    );
    assert.deepEqual(answer.sleep, { requestedAt: draining.stopRequestedAt!.toISOString(), confirmed: true }, 'the idle instance\'s acceptance is confirmed');
    cluster.stopPod(managedPodName(draining.runnerId));
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < 6 && outcomes.at(-1) !== 'SLEEPING'; i += 1) outcomes.push(await primary.reconcile(draining.id));
    assert.equal(outcomes.at(-1), 'SLEEPING', outcomes.join(' → '));
    return mappingOf(ownerId);
  }

  /** The pool's reserved figures against the sum of every mapping's recorded share in it. */
  async function ledger(): Promise<{ pool: Record<string, number>; shares: Record<string, number> }> {
    const [pool] = await db.$queryRaw<Array<Record<string, bigint | number>>>`
      SELECT id::text AS id, cpu_millis_reserved, memory_bytes_reserved, ephemeral_bytes_reserved, pods_reserved,
             attachments_reserved, active_users_reserved, durable_bytes_reserved
        FROM managed_runner_capacity WHERE cluster_key = ${profile.clusterKey} AND namespace = ${profile.kubernetes.namespace}`;
    const [shares] = await db.$queryRaw<Array<Record<string, bigint | number | null>>>`
      SELECT coalesce(sum((reservation->'compute'->>'cpuMillis')::bigint), 0) AS cpu,
             coalesce(sum((reservation->'compute'->>'memoryBytes')::bigint), 0) AS memory,
             coalesce(sum((reservation->'compute'->>'ephemeralBytes')::bigint), 0) AS ephemeral,
             coalesce(sum((reservation->'compute'->>'pods')::bigint), 0) AS pods,
             coalesce(sum((reservation->'compute'->>'attachments')::bigint), 0) AS attachments,
             coalesce(sum((reservation->'compute'->>'activeUsers')::bigint), 0) AS users,
             coalesce(sum((reservation->'storage'->>'durableBytes')::bigint), 0) AS durable
        FROM managed_runner WHERE reservation->>'pool' = ${pool ? String(pool.id) : ''}`;
    const n = (v: bigint | number | null | undefined) => Number(v ?? 0);
    return {
      pool: pool
        ? {
          cpu: n(pool.cpu_millis_reserved), memory: n(pool.memory_bytes_reserved), ephemeral: n(pool.ephemeral_bytes_reserved),
          pods: n(pool.pods_reserved), attachments: n(pool.attachments_reserved), users: n(pool.active_users_reserved),
          durable: n(pool.durable_bytes_reserved),
        }
        : {},
      shares: {
        cpu: n(shares.cpu), memory: n(shares.memory), ephemeral: n(shares.ephemeral), pods: n(shares.pods),
        attachments: n(shares.attachments), users: n(shares.users), durable: n(shares.durable),
      },
    };
  }

  return { db, prisma, profile, cluster, clock, now, advance, manager, primary, runtime, service, mappingOf, heartbeat, drive, makeUser, readyRunner, putToSleep, ledger };
}

export type ManagedRunnerWorld = ReturnType<typeof managedRunnerWorld>;
