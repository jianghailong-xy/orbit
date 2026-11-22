/**
 * A managed runner left on a previous image by an upgrade, on Docker (docs/managed-runner-update-now-design.md,
 * "Docker rolls idle runners too"): the channel and the profile name a new image, and the runner's container still
 * runs the old one. Once it is idle the manager moves it as on Kubernetes — the drain a sleep takes, marked as a roll
 * (`imageRollTo`), then a wake at once — so the next generation is made from the current image, on the same volume
 * and runner. The manager on DockerBackend, over the channel that keeps the real one's rules in memory
 * (test-support/fake-docker-channel.ts), against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty;
 * the clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-docker-image-roll.pg.spec.ts
 *
 *   (1) idle on a previous image: DRAINING at once, marked as a roll to the current image; it accepts, Docker reports
 *       the exit, and the next generation is made from the current image on the same volume, never two containers;
 *   (2) demand during that drain calls the roll off: READY, claims open; idle again, it rolls;
 *   (3) busy on a previous image, or idle on the current one: it is left READY;
 *   (4) a profile that adopts the channel's image (`runner.image: "channel"`): it rolls onto the image the channel
 *       serves now.
 *
 * Not destructive: every row belongs to a user this run creates, and each world has a pool of its own.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY } from '@orbit/shared';
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
import { DockerBackend } from './docker-backend';
import { managedRunnerInstanceClaimable } from './managed-runner-instance';
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import { DOCKER_IMAGE_FROM_CHANNEL, type DockerRunnerProfile } from './managed-runner-profile';
import type { ManagedRunnerRuntime } from './managed-runner-runtime';
import { managedRunnerHeartbeat, storedWorkloadFor } from './managed-runner-sleep';
import { recordManagedDemand } from './managed-runner-work';
import { ManagedRunnerWorker } from './managed-runner-worker';
import { ManagedRunnerService } from './managed-runner.service';

const URL = process.env.COORDINATOR_PG_URL;
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const ON = { enabled: true, problem: null } as const;
const IDLE = { activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 0 };
/** The image an upgrade builds: what the profile and the channel name from then on. */
const NEXT = `sha256:${'e'.repeat(64)}`;

test('a managed runner on a previous image rolls onto the current one when idle, on Docker', {
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

  /** `adopt`: a profile that makes containers from whatever image the channel serves (`runner.image: "channel"`). */
  function world({ adopt = false } = {}) {
    const base = testDockerRunnerProfile({ clusterKey: `docker-roll-${randomUUID().slice(0, 8)}` });
    const first = base.runner.image;
    let profile: DockerRunnerProfile = adopt ? { ...base, runner: { ...base.runner, image: DOCKER_IMAGE_FROM_CHANNEL } } : base;
    const channel = new FakeDockerChannel(profile.docker.instanceId, first);
    const clock = { ms: Date.now() };
    const now = () => new Date(clock.ms);
    let manager: ManagedRunnerManager;
    let service: ManagedRunnerService;
    let starts = 0;
    const start = () => {
      starts += 1;
      // Not link-only: a runner that beats is never stopped for silence here, so what moves it is the roll alone.
      manager = new ManagedRunnerManager(prisma, new DockerBackend(channel, profile, () => clock.ms), profile, {
        holder: `docker-roll-replica-${starts}`, now, random: () => 0.5, log: quiet, linkOnly: () => false,
      });
      const runtime: ManagedRunnerRuntime = { available: true, profile, manager, worker: new ManagedRunnerWorker(manager, 60_000, quiet) };
      service = new ManagedRunnerService(prisma, ON, runtime);
    };
    start();
    /** An upgrade: the channel (and, unless it adopts the channel's, the profile) on NEXT; the running container left as it is. */
    const upgrade = () => {
      if (!adopt) profile = { ...profile, runner: { ...profile.runner, image: NEXT } };
      channel.image = NEXT;
      start();
    };
    const advance = (ms: number) => void (clock.ms += ms);
    const mappingOf = async (ownerId: string): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId } }))!;
    const onTheVolume = (volume: string) => [...channel.containers.values()].filter((c) => c.volume === volume);
    const instanceOf = (m: ManagedRunner) => ({ mappingId: m.id, generation: m.generation, podUid: m.podUid! });

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
            ? (storedWorkloadFor({ ...IDLE, ...workload }, instanceOf(mapping), false, now()) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      });
    }

    /** Passes until READY, a new instance heartbeating once it is up; never two containers on the volume after any. */
    async function drive(ownerId: string): Promise<ReconcileOutcome[]> {
      const outcomes: ReconcileOutcome[] = [];
      for (let i = 0; i < 40; i += 1) {
        const outcome = await manager.reconcile((await mappingOf(ownerId)).id);
        outcomes.push(outcome);
        const after = await mappingOf(ownerId);
        assert.ok(onTheVolume(after.pvcName).length <= 1, `two containers on ${after.pvcName} after ${outcomes.join(' → ')}`);
        if (outcome === 'READY' || outcome === 'FAILED') return outcomes;
        if (after.podUid && after.managementState === 'STARTING') {
          advance(1_000);
          await heartbeat(after.runnerId);
        }
        if (after.nextAttemptAt && after.nextAttemptAt > now()) clock.ms = after.nextAttemptAt.getTime() + 1;
      }
      return outcomes;
    }

    async function readyRunner(label: string): Promise<{ ownerId: string; mapping: ManagedRunner }> {
      const ownerId = (await db.user.create({ data: { email: `${label}-${randomUUID()}@example.invalid`, name: label } })).id;
      await service.ensure(ownerId, `ensure-${label}`);
      const outcomes = await drive(ownerId);
      assert.equal(outcomes.at(-1), 'READY', `${label}: ${outcomes.join(' → ')}`);
      return { ownerId, mapping: await mappingOf(ownerId) };
    }

    /** The draining instance accepts the stop it was asked for, and exits by itself: Docker reports it. */
    async function acceptAndExit(m: ManagedRunner): Promise<void> {
      const answer = await managedRunnerHeartbeat(prisma, instanceOf(m), { ...IDLE, sleepReady: m.stopRequestedAt!.toISOString() }, now());
      assert.deepEqual(answer.sleep, { requestedAt: m.stopRequestedAt!.toISOString(), confirmed: true }, 'the idle instance\'s acceptance is confirmed');
      channel.exit(m.runnerId, 0);
    }

    return {
      first, channel, now, advance, upgrade, mappingOf, onTheVolume, instanceOf, heartbeat, drive, readyRunner, acceptAndExit,
      get manager() { return manager; },
    };
  }

  /** (1)'s and (4)'s roll, from READY on the previous image to READY on NEXT. */
  async function rolls(w: ReturnType<typeof world>, ownerId: string, mapping: ManagedRunner): Promise<void> {
    const name = `mr-${mapping.runnerId}`;
    // Idle by its fresh report, the idle interval far from over: an upgrade does not wait a day for it.
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING', 'idle on a previous image, it drains');
    const draining = await w.mappingOf(ownerId);
    assert.deepEqual({ desired: draining.desiredState, rollTo: draining.imageRollTo, generation: draining.generation },
      { desired: 'SLEEPING', rollTo: NEXT, generation: mapping.generation }, 'drained as for sleep, marked as a roll to the current image');
    assert.ok(draining.stopRequestedAt);
    assert.equal(managedRunnerInstanceClaimable(draining, w.instanceOf(draining)), false, 'a rolling instance is handed no turn');
    assert.deepEqual(w.channel.stopRequests, [], 'asked through its heartbeat, not stopped by the host');

    // No new demand: the drain goes on.
    await w.heartbeat(mapping.runnerId);
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING');

    await w.acceptAndExit(draining);
    const outcomes = await w.drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const rolled = await w.mappingOf(ownerId);
    const made = w.channel.containers.get(name)!;
    assert.deepEqual({ generation: rolled.generation, rollTo: rolled.imageRollTo, desired: rolled.desiredState, runnerId: rolled.runnerId, pvcUid: rolled.pvcUid, podUid: rolled.podUid },
      { generation: mapping.generation + 1, rollTo: null, desired: 'RUNNING', runnerId: mapping.runnerId, pvcUid: mapping.pvcUid, podUid: made.uid },
      'the next generation, the roll over, on the same runner and volume');
    assert.deepEqual({ image: made.request.image, volumeUid: made.volumeUid }, { image: NEXT, volumeUid: mapping.pvcUid }, 'made from the current image');
    assert.equal((rolled.fencingReceipt as { kind?: string }).kind, 'OBSERVED_STOP', "Docker's report of the exit is the stop proof");
    assert.equal(w.channel.count('ensureVolume'), 1, 'the volume was never made again');
    assert.deepEqual(w.onTheVolume(mapping.pvcName).map((c) => c.uid), [made.uid]);

    // On the current image, idle: nothing more happens until the idle interval.
    w.advance(1_000);
    await w.heartbeat(rolled.runnerId);
    assert.equal(await w.manager.reconcile(rolled.id), 'READY', 'on the current image it stays');
    assert.equal((await w.mappingOf(ownerId)).generation, rolled.generation);
  }

  await t.test('(1) idle on a previous image: it drains as a roll, and wakes as the next generation on the current image', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('docker-roll');
    assert.equal(w.channel.containers.get(`mr-${mapping.runnerId}`)!.request.image, w.first);
    w.upgrade();
    await rolls(w, ownerId, mapping);
  });

  await t.test('(2) demand during the drain calls the roll off; idle again, it rolls', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('docker-roll-demand');
    w.upgrade();
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING');
    assert.equal((await w.mappingOf(ownerId)).imageRollTo, NEXT);

    assert.ok(await recordManagedDemand(prisma, mapping.runnerId, w.now()));
    await w.heartbeat(mapping.runnerId);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY', 'demand calls the roll off');
    const called = await w.mappingOf(ownerId);
    assert.deepEqual({ state: called.managementState, desired: called.desiredState, rollTo: called.imageRollTo, stop: called.stopRequestedAt, generation: called.generation, podUid: called.podUid },
      { state: 'READY', desired: 'RUNNING', rollTo: null, stop: null, generation: mapping.generation, podUid: mapping.podUid });
    assert.equal(managedRunnerInstanceClaimable(called, w.instanceOf(called)), true, 'claims open again');
    assert.equal(w.channel.containers.get(`mr-${mapping.runnerId}`)!.status, 'running', 'the same container goes on');
    assert.equal(w.channel.count('createContainer'), 1, 'nothing made');

    // Idle again: it rolls, to the end.
    await rolls(w, ownerId, called);
  });

  await t.test('(3) busy on a previous image, or idle on the current one: left READY', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('docker-roll-busy');
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY', 'idle on the current image');
    w.upgrade();
    for (const [why, workload] of [
      ['a turn in flight', { activeTurns: 1 }],
      ['a background job', { backgroundJobs: 1 }],
      ['an operation', { operations: 1 }],
      ['events not yet flushed', { unflushedEvents: 2 }],
    ] as const) {
      w.advance(1_000);
      await w.heartbeat(mapping.runnerId, workload);
      assert.equal(await w.manager.reconcile(mapping.id), 'READY', `${why}: it does not roll`);
    }
    const still = await w.mappingOf(ownerId);
    assert.deepEqual({ state: still.managementState, rollTo: still.imageRollTo, generation: still.generation, stop: still.stopRequestedAt },
      { state: 'READY', rollTo: null, generation: mapping.generation, stop: null });
    assert.equal(w.channel.count('createContainer'), 1);
  });

  await t.test('(4) a profile that adopts the channel\'s image: it rolls onto the image the channel serves now', async () => {
    const w = world({ adopt: true });
    const { ownerId, mapping } = await w.readyRunner('docker-roll-adopt');
    assert.equal(w.channel.containers.get(`mr-${mapping.runnerId}`)!.request.image, w.first);
    w.upgrade();
    await rolls(w, ownerId, mapping);
  });
});
