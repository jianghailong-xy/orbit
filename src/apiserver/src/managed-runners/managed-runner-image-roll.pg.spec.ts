/**
 * A managed runner left on a previous image by an upgrade, on Kubernetes: the profile names a new image, and the
 * runner's Pod still runs the old one. The manager moves it once it is idle — the drain a sleep takes, then a wake at
 * once — so the next generation is made from the image the profile names now, on the same PVC and runner, and nothing
 * in flight is cut short. The manager against the in-memory Kubernetes namespace of `test-support/fake-kube-client.ts`
 * with the admission guard installed, over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty; the
 * runner's side played by what its heartbeat route records and answers; the clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-image-roll.pg.spec.ts
 *
 *   (1) idle on a previous image: it drains at once, without waiting out the idle interval, as for sleep but marked
 *       as a roll; it accepts, exits, and wakes at once as the next generation on the new image, on the same PVC;
 *   (2) busy on a previous image — work in the records or in its report — it is left READY;
 *   (3) demand before it accepts calls the roll off: READY, claims open; idle again, it rolls;
 *   (4) on the current image, idle for less than the interval, nothing happens;
 *   (5) the node pulls the new image for longer than the startup deadline (production, 2026-11-16: 48 minutes against
 *       30): the Pending Pod is waited on, not failed STARTUP_TIMEOUT, and it is READY once it reports in; a pull
 *       error still fails at the deadline;
 *   (6) a mapping an earlier version failed STARTUP_TIMEOUT while its Pod was still pulling is taken up again by
 *       itself once that instance reports in, with no owner's retry; one whose instance stays silent stays FAILED.
 *
 * Not destructive: every row belongs to a user this run creates, and each world has a pool of its own.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { ManagedRunner, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { installManagedRunnerAdmission } from '../test-support/managed-runner-admission.fixture';
import { IDLE, managedRunnerWorld, quiet, type ManagedRunnerWorld } from '../test-support/managed-runner-world';
import type { Pod } from './kube-client';
import { podImages } from './managed-runner-admission';
import { managedRunnerInstanceClaimable } from './managed-runner-instance';
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import { managedPodName, managedPvcName } from './managed-runner-resources';
import { managedRunnerHeartbeat } from './managed-runner-sleep';
import { recordManagedDemand } from './managed-runner-work';

const URL = process.env.COORDINATOR_PG_URL;
const NEW_IMAGE = `registry.invalid/orbit-cloud-runner@sha256:${'b'.repeat(64)}`;

test('a managed runner on a previous image rolls onto the new one when idle', {
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

  /**
   * The upgrade: the profile names NEW_IMAGE from now on, as the apiserver reads it when it starts again. The
   * admission guard and a manager both take the new profile; the Pod already running keeps the image it was made from.
   */
  function upgrade(w: ManagedRunnerWorld): { profile: ManagedRunnerProfile; manager: ManagedRunnerManager } {
    const profile: ManagedRunnerProfile = { ...w.profile, runner: { ...w.profile.runner, image: NEW_IMAGE } };
    installManagedRunnerAdmission(w.cluster, prisma, profile);
    const manager = new ManagedRunnerManager(prisma, w.cluster.client(), profile, {
      holder: 'replica-upgraded', now: w.now, random: () => 0.5, log: quiet, ownLocationOnly: true,
    });
    return { profile, manager };
  }

  const imagesOf = (w: ManagedRunnerWorld, m: ManagedRunner): string[] => podImages(w.cluster.object<Pod>('pods', managedPodName(m.runnerId)));
  const instanceOf = (m: ManagedRunner) => ({ mappingId: m.id, generation: m.generation, podUid: m.podUid! });

  /** A session of the runner, in `status`, as a turn queued or run there leaves one. */
  async function session(m: ManagedRunner, status: string): Promise<string> {
    const workspace = await db.workspace.create({ data: { ownerId: m.ownerId, runnerId: m.runnerId, targetRunnerId: m.runnerId, name: 'Project', workDir: '/tmp/project' } });
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "session" ("id", "owner_id", "creator_id", "workspace_id", "assigned_runner_id", "title", "prompt", "provider",
                              "turn_state", "num_turns", "runtime_session_id", "started_at", "updated_at")
       VALUES ($1, $2, $2, $3, $4, 'managed work', 'work', 'claude', (CASE ($5)::text WHEN 'PENDING' THEN 'QUEUED' WHEN 'RUNNING' THEN 'IN_FLIGHT' WHEN 'INTERRUPTED' THEN 'ABANDONED' END), 1, $6, now(), now())`,
      [id, m.ownerId, workspace.id, m.runnerId, status, randomUUID()],
    );
    return id;
  }

  /** The instance accepts the stop it was asked for, and the kubelet reports it exited. */
  async function acceptAndExit(w: ManagedRunnerWorld, m: ManagedRunner): Promise<void> {
    const answer = await managedRunnerHeartbeat(prisma, instanceOf(m), { ...IDLE, sleepReady: m.stopRequestedAt!.toISOString() }, w.now());
    assert.deepEqual(answer.sleep, { requestedAt: m.stopRequestedAt!.toISOString(), confirmed: true }, 'the idle instance\'s acceptance is confirmed');
    w.cluster.stopPod(managedPodName(m.runnerId));
  }

  /** Reconcile with `manager` until `until`, heartbeating a Pod that starts; the outcomes, in order. */
  async function driveWith(w: ManagedRunnerWorld, manager: ManagedRunnerManager, ownerId: string, until: ReconcileOutcome): Promise<ReconcileOutcome[]> {
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < 40 && outcomes.at(-1) !== until && outcomes.at(-1) !== 'FAILED'; i += 1) {
      const mapping = await w.mappingOf(ownerId);
      outcomes.push(await manager.reconcile(mapping.id));
      const after = await w.mappingOf(ownerId);
      if (after.podUid && after.managementState === 'STARTING') {
        w.advance(1_000);
        await w.heartbeat(after.runnerId);
      }
      if (after.nextAttemptAt && after.nextAttemptAt > w.now()) w.clock.ms = after.nextAttemptAt.getTime() + 1;
    }
    return outcomes;
  }

  await t.test('(1) idle on a previous image: it drains at once, and wakes as the next generation on the new image', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('roll');
    const oldImage = w.profile.runner.image;
    assert.ok(imagesOf(w, mapping).every((image) => image === oldImage), 'made from the image the profile named then');
    const pvcUid = mapping.pvcUid;
    const { manager } = upgrade(w);

    // Idle by its report, the idle interval far from over: an upgrade does not wait a day for it.
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await manager.reconcile(mapping.id), 'DRAINING', 'idle on a previous image, it drains');
    const draining = await w.mappingOf(ownerId);
    assert.equal(draining.desiredState, 'SLEEPING', 'it drains as for sleep');
    assert.equal(draining.imageRollTo, NEW_IMAGE, 'marked as a roll to the new image');
    assert.ok(draining.stopRequestedAt);
    assert.equal(managedRunnerInstanceClaimable(draining, instanceOf(draining)), false, 'a rolling instance is handed no turn');
    const asked = await managedRunnerHeartbeat(prisma, instanceOf(draining), { ...IDLE }, w.now());
    assert.deepEqual(asked, { draining: true, sleep: { requestedAt: draining.stopRequestedAt!.toISOString() } }, 'its heartbeat asks it to stop');

    // No new demand: the drain is not called off on the next pass.
    await w.heartbeat(mapping.runnerId);
    assert.equal(await manager.reconcile(mapping.id), 'DRAINING');

    await acceptAndExit(w, draining);
    const outcomes = await driveWith(w, manager, ownerId, 'READY');
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const rolled = await w.mappingOf(ownerId);
    assert.equal(rolled.generation, mapping.generation + 1, 'the next generation');
    assert.equal(rolled.imageRollTo, null, 'the roll is over');
    assert.equal(rolled.desiredState, 'RUNNING');
    assert.equal(rolled.pvcUid, pvcUid, 'on the same PVC');
    assert.equal(rolled.runnerId, mapping.runnerId, 'and the same runner');
    assert.ok(w.cluster.object('persistentvolumeclaims', managedPvcName(mapping.runnerId)), 'the PVC is never deleted');
    assert.deepEqual(new Set(imagesOf(w, rolled)), new Set([NEW_IMAGE]), 'its Pod is made from the new image');

    // On the new image, idle: nothing more happens until the idle interval.
    w.advance(1_000);
    await w.heartbeat(rolled.runnerId);
    assert.equal(await manager.reconcile(rolled.id), 'READY', 'on the current image it stays');
  });

  await t.test('(2) busy on a previous image: it is left READY', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('roll-busy');
    const { manager } = upgrade(w);
    for (const [why, workload] of [
      ['a turn in flight', { activeTurns: 1 }],
      ['a background job', { backgroundJobs: 1 }],
      ['an operation', { operations: 1 }],
      ['events not yet flushed', { unflushedEvents: 2 }],
    ] as const) {
      w.advance(1_000);
      await w.heartbeat(mapping.runnerId, workload);
      assert.equal(await manager.reconcile(mapping.id), 'READY', `${why}: it does not roll`);
    }
    const id = await session(mapping, 'RUNNING');
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await manager.reconcile(mapping.id), 'READY', 'a turn in the records: it does not roll');
    await sql.query(`DELETE FROM "session" WHERE id = $1`, [id]);
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId, {}, { sleep: false });
    assert.equal(await manager.reconcile(mapping.id), 'READY', 'a runner that cannot report or sleep: it does not roll');
    const still = await w.mappingOf(ownerId);
    assert.equal(still.imageRollTo, null);
    assert.equal(still.generation, mapping.generation);
  });

  await t.test('(3) demand before it accepts calls the roll off; idle again, it rolls', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('roll-demand');
    const { manager } = upgrade(w);
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await manager.reconcile(mapping.id), 'DRAINING');
    await recordManagedDemand(prisma, mapping.runnerId, w.now());
    await w.heartbeat(mapping.runnerId);
    assert.equal(await manager.reconcile(mapping.id), 'READY', 'demand calls the roll off');
    const called = await w.mappingOf(ownerId);
    assert.equal(called.imageRollTo, null);
    assert.equal(called.stopRequestedAt, null);
    assert.equal(called.desiredState, 'RUNNING');
    assert.equal(managedRunnerInstanceClaimable(called, instanceOf(called)), true, 'claims open again');

    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await manager.reconcile(mapping.id), 'DRAINING', 'idle again, it rolls');
    await acceptAndExit(w, await w.mappingOf(ownerId));
    const outcomes = await driveWith(w, manager, ownerId, 'READY');
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    assert.deepEqual(new Set(imagesOf(w, await w.mappingOf(ownerId))), new Set([NEW_IMAGE]));
  });

  await t.test('(4) on the current image, idle for less than the interval: nothing happens', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('roll-current');
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await w.primary.reconcile(mapping.id), 'READY');
    const still = await w.mappingOf(ownerId);
    assert.equal(still.imageRollTo, null);
    assert.equal(still.stopRequestedAt, null);
  });

  /**
   * Rolls a READY runner up to the moment its next generation's Pod has been made on the new image, with the node
   * still pulling that image: Pending, its init container waiting as the kubelet reports a pull in progress.
   */
  async function rolledOntoPullingPod(w: ManagedRunnerWorld, label: string) {
    const { ownerId, mapping } = await w.readyRunner(label);
    const { manager } = upgrade(w);
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await manager.reconcile(mapping.id), 'DRAINING');
    await acceptAndExit(w, await w.mappingOf(ownerId));
    w.cluster.podPhase = 'Pending';
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < 12; i += 1) {
      const m = await w.mappingOf(ownerId);
      if (m.managementState === 'STARTING' && m.generation > mapping.generation && m.podUid) break;
      outcomes.push(await manager.reconcile(m.id));
    }
    const starting = await w.mappingOf(ownerId);
    assert.equal(starting.managementState, 'STARTING', outcomes.join(' → '));
    assert.equal(starting.generation, mapping.generation + 1);
    const pod = managedPodName(starting.runnerId);
    pull(w, pod, 'PodInitializing');
    return { ownerId, manager, starting, pod };
  }

  const containersOf = (p: Pod, key: 'initContainers' | 'containers') => (Array.isArray(p.spec[key]) ? (p.spec[key] as Array<{ name: string }>) : []);

  /** The kubelet's report of a Pod whose init container's image is being pulled (`reason` PodInitializing), or failed to (ErrImagePull…). */
  function pull(w: ManagedRunnerWorld, pod: string, reason: string): void {
    w.cluster.mutate<Pod>('pods', pod, (p) => {
      p.status = {
        phase: 'Pending',
        initContainerStatuses: containersOf(p, 'initContainers').map((c) => ({ name: c.name, state: { waiting: { reason } } })),
        containerStatuses: containersOf(p, 'containers').map((c) => ({ name: c.name, state: { waiting: { reason: 'PodInitializing' } } })),
      };
    });
  }

  /** The pull is done: the init container ran, the runner runs. */
  function pulled(w: ManagedRunnerWorld, pod: string): void {
    w.cluster.mutate<Pod>('pods', pod, (p) => {
      p.status = {
        phase: 'Running',
        initContainerStatuses: containersOf(p, 'initContainers').map((c) => ({ name: c.name, state: { terminated: { exitCode: 0, reason: 'Completed' } } })),
        containerStatuses: containersOf(p, 'containers').map((c) => ({ name: c.name, state: { running: { startedAt: w.now().toISOString() } } })),
      };
    });
  }

  await t.test('(5) the new image\'s pull outlasts the startup deadline: the Pod is waited on, and READY once it reports in', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, manager, starting, pod } = await rolledOntoPullingPod(w, 'roll-slow-pull');
    const deadlineMs = w.profile.lifecycle.startupDeadlineSeconds * 1000;

    // Past the deadline, and past it again, with the pull still going: not a silent runner.
    for (let i = 0; i < 3; i += 1) {
      w.advance(deadlineMs + 1_000);
      assert.equal(await manager.reconcile(starting.id), 'WAITING', `pull still in progress, deadline ${i + 1} passed`);
    }
    const waiting = await w.mappingOf(ownerId);
    assert.equal(waiting.managementState, 'STARTING', 'not FAILED STARTUP_TIMEOUT');
    assert.equal(waiting.lastError, null);
    assert.ok(waiting.startupDeadlineAt! > w.now(), 'the deadline runs again from the last look at the pull');
    assert.equal(waiting.podUid, starting.podUid, 'the same Pod is waited on');

    // The pull ends, the runner starts and reports in: READY, on the same Pod.
    pulled(w, pod);
    w.advance(1_000);
    await w.heartbeat(starting.runnerId);
    assert.equal(await manager.reconcile(starting.id), 'READY');
    const ready = await w.mappingOf(ownerId);
    assert.equal(ready.podUid, starting.podUid);
    assert.equal(ready.generation, starting.generation);
    assert.equal(w.cluster.count('delete', 'pods'), 1, 'only the previous generation\'s Pod was deleted');

    // A pull that failed is not a pull in progress: the deadline fails it as before.
    const w2 = managedRunnerWorld(db);
    const failing = await rolledOntoPullingPod(w2, 'roll-pull-error');
    pull(w2, failing.pod, 'ImagePullBackOff');
    w2.advance(deadlineMs + 1_000);
    assert.equal(await failing.manager.reconcile(failing.starting.id), 'FAILED');
    assert.equal(((await w2.mappingOf(failing.ownerId)).lastError as { code: string }).code, 'STARTUP_TIMEOUT');
  });

  await t.test('(6) failed STARTUP_TIMEOUT while its Pod pulled: taken up again once that instance reports in', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, manager, starting, pod } = await rolledOntoPullingPod(w, 'roll-failed-pull');
    // What production's mappings were left in by a version that failed a pulling Pod at its deadline, after the
    // previous generation's last beat.
    w.advance(1_000);
    await db.managedRunner.update({
      where: { id: starting.id },
      data: {
        managementState: 'FAILED',
        stateEnteredAt: w.now(),
        startupDeadlineAt: w.now(),
        lastError: { code: 'STARTUP_TIMEOUT', message: 'The runner did not report in before its startup deadline. It can be retried.', retryable: true, detail: 'no fresh heartbeat' },
        revision: { increment: 1 },
      },
    });

    // Still silent: it stays FAILED, as any silent runner does.
    w.advance(60_000);
    assert.equal(await manager.reconcile(starting.id), 'FAILED');
    assert.equal((await w.mappingOf(ownerId)).managementState, 'FAILED');
    assert.ok((await manager.dueMappings(100)).includes(starting.id), 'the sweep looks at it again');

    // The pull ends and the instance of this generation reports in: back without a retry, on the same Pod.
    pulled(w, pod);
    w.advance(1_000);
    await w.heartbeat(starting.runnerId);
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < 4 && outcomes.at(-1) !== 'READY'; i += 1) {
      outcomes.push(await manager.reconcile(starting.id));
      w.advance(1_000);
      await w.heartbeat(starting.runnerId);
    }
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const ready = await w.mappingOf(ownerId);
    assert.equal(ready.podUid, starting.podUid, 'the same Pod');
    assert.equal(ready.generation, starting.generation, 'the same generation');
    assert.equal(ready.lastError, null);
    assert.equal(w.cluster.count('delete', 'pods'), 1, 'only the previous generation\'s Pod was deleted');
  });
});
