/**
 * A managed runner left on a previous image by an upgrade, on a server that takes the runner daemon's calls over the
 * runner link alone (docs/runner-link-design.md §11.3, §13): a runner from before the link client is answered 426 on
 * every call there, so it never beats again, cannot be used and cannot be put to sleep. The manager on DockerBackend,
 * over the channel that keeps the real one's rules in memory (test-support/fake-docker-channel.ts), against a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty; the clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-previous-image.pg.spec.ts
 *
 *   (1) both conditions: READY on a previous image and silent past PREVIOUS_IMAGE_SILENCE_MS — its container is asked
 *       to stop through the channel, and nothing is made while it runs; Docker's report of the exit is the stop proof,
 *       the container is removed by UID, and the next generation is made from the current image on the same volume
 *       and runner, never two containers on the volume;
 *   (2) a previous image alone: a runner still beating is left as it is, however long;
 *   (3) silence alone: on the current image, a silent runner is left READY and nothing is written, as before;
 *   (4) a stop that is not confirmed: the container ending without Docker's report, or gone, fences, and nothing is
 *       made;
 *   (5) the silence a previous image needs: a missed beat, or an outage up to the reaper's hold, is not enough;
 *   (6) a server that still takes the daemon over HTTPS (the cut-over's switch off): nothing is stopped;
 *   (7) asked to sleep while silent on a previous image: the stop ends in sleep, not a new generation;
 *   (8) a channel too old to say which image a container was made from: an unknown image is never a reason to stop;
 *   (9) the channel not reached when the stop is asked: nothing is written or made, and the next pass asks again;
 *  (10) a manager given no link-only answer, as on a build without the cut-over's switch: link-only, though the
 *       switch's table has no row.
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
import { MASS_DISCONNECT_HOLD_MS } from '../realtime/reaper.service';
import { testDockerRunnerProfile } from '../test-support/docker-runner-profile.fixture';
import { FakeDockerChannel } from '../test-support/fake-docker-channel';
import { DockerBackend } from './docker-backend';
import { ManagedRunnerManager, PREVIOUS_IMAGE_SILENCE_MS, type ReconcileOutcome } from './managed-runner-manager';
import type { ManagedRunnerRuntime } from './managed-runner-runtime';
import { storedWorkloadFor } from './managed-runner-sleep';
import { ManagedRunnerWorker } from './managed-runner-worker';
import { ManagedRunnerService } from './managed-runner.service';

const URL = process.env.COORDINATOR_PG_URL;
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const ON = { enabled: true, problem: null } as const;
const IDLE = { activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 0 };
const BUSY = { activeTurns: 1 };
/** The image an upgrade builds: what the profile and the channel name from then on. */
const NEXT = `sha256:${'e'.repeat(64)}`;

test('a managed runner on a previous image that a link-only server no longer hears is replaced', {
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

  /** `withSwitch` false: the manager is given no link-only answer, as on a build without the cut-over's switch. */
  function world({ withSwitch = true } = {}) {
    let profile = testDockerRunnerProfile({ clusterKey: `previous-${randomUUID().slice(0, 8)}` });
    const channel = new FakeDockerChannel(profile.docker.instanceId, profile.runner.image);
    const clock = { ms: Date.now() };
    const now = () => new Date(clock.ms);
    const switchOn = { linkOnly: true };
    let manager: ManagedRunnerManager;
    let service: ManagedRunnerService;
    let starts = 0;
    /** The apiserver started on `profile`: a process of its own. */
    const start = () => {
      starts += 1;
      manager = new ManagedRunnerManager(prisma, new DockerBackend(channel, profile), profile, {
        holder: `previous-replica-${starts}`, now, random: () => 0.5, log: quiet,
        ...(withSwitch ? { linkOnly: () => switchOn.linkOnly } : {}),
      });
      const runtime: ManagedRunnerRuntime = { available: true, profile, manager, worker: new ManagedRunnerWorker(manager, 60_000, quiet) };
      service = new ManagedRunnerService(prisma, ON, runtime);
    };
    start();
    /** An upgrade: the apiserver and the channel recreated on a new image, the running container left as it is. */
    const upgrade = () => {
      profile = { ...profile, runner: { ...profile.runner, image: NEXT } };
      channel.image = NEXT;
      start();
    };
    const advance = (ms: number) => void (clock.ms += ms);
    const mappingOf = async (ownerId: string): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId } }))!;
    const tokenOf = async (runnerId: string) => (await db.runner.findUnique({ where: { id: runnerId }, select: { tokenHash: true } }))!.tokenHash;
    const onTheVolume = (volume: string) => [...channel.containers.values()].filter((c) => c.volume === volume);

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

    /** Passes until `until`, a new instance heartbeating once it is up; never two containers on the volume after any. */
    async function drive(ownerId: string, until: ReconcileOutcome[] = ['READY']): Promise<ReconcileOutcome[]> {
      const outcomes: ReconcileOutcome[] = [];
      for (let i = 0; i < 40; i += 1) {
        const outcome = await manager.reconcile((await mappingOf(ownerId)).id);
        outcomes.push(outcome);
        const after = await mappingOf(ownerId);
        assert.ok(onTheVolume(after.pvcName).length <= 1, `two containers on ${after.pvcName} after ${outcomes.join(' → ')}`);
        if (until.includes(outcome) || outcome === 'FAILED') return outcomes;
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

    return {
      get profile() { return profile; },
      channel,
      switchOn,
      now,
      advance,
      get manager() { return manager; },
      get service() { return service; },
      upgrade, mappingOf, tokenOf, onTheVolume, heartbeat, drive, readyRunner,
    };
  }

  await t.test('(1) both: asked to stop through the channel, the stop seen, then the next generation from the current image', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('both');
    const previous = w.profile.runner.image;
    const name = `mr-${mapping.runnerId}`;
    w.upgrade();
    w.channel.stopsAtOnce = false;

    // Silent past the bound since its last beat, on the image the upgrade left it on: asked to stop, by its UID.
    w.advance(PREVIOUS_IMAGE_SILENCE_MS + 1_000);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.deepEqual(w.channel.stopRequests, [{ name, uid: mapping.podUid }]);

    // Asked is not stopped: while Docker has not reported the exit, nothing is made and the generation stays.
    for (let i = 0; i < 3; i += 1) {
      w.advance(5_000);
      assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    }
    const asked = await w.mappingOf(ownerId);
    assert.deepEqual({ state: asked.managementState, generation: asked.generation, podUid: asked.podUid },
      { state: 'READY', generation: 1, podUid: mapping.podUid });
    assert.equal(w.channel.count('createContainer'), 1, 'generation 1 only');
    assert.deepEqual(w.onTheVolume(mapping.pvcName).map((c) => [c.uid, c.status, c.request.image]), [[mapping.podUid, 'running', previous]]);

    // Docker's report of the exit: recorded as the stop proof, and the restart a crash gets.
    w.channel.exit(mapping.runnerId, 143);
    assert.equal(await w.manager.reconcile(mapping.id), 'BACKOFF');
    const restarting = await w.mappingOf(ownerId);
    assert.deepEqual({ state: restarting.managementState, code: (restarting.lastError as { code?: string }).code, proof: (restarting.fencingReceipt as { kind?: string }).kind },
      { state: 'REQUESTED', code: 'POD_RESTARTING', proof: 'OBSERVED_STOP' });

    const outcomes = await w.drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const replaced = await w.mappingOf(ownerId);
    const made = w.channel.containers.get(name)!;
    assert.deepEqual({ image: made.request.image, generation: made.generation, volumeUid: made.volumeUid, runnerId: made.runnerId },
      { image: NEXT, generation: 2, volumeUid: mapping.pvcUid, runnerId: mapping.runnerId });
    assert.deepEqual({ runnerId: replaced.runnerId, pvcUid: replaced.pvcUid, podUid: replaced.podUid, generation: replaced.generation },
      { runnerId: mapping.runnerId, pvcUid: mapping.pvcUid, podUid: made.uid, generation: 2 });
    const retired = replaced.fencingReceipt as { kind: string; predecessor: { podUid: string; generation: number } };
    assert.deepEqual([retired.kind, retired.predecessor.podUid, retired.predecessor.generation], ['OBSERVED_STOP', mapping.podUid, 1]);
    assert.equal(w.channel.count('ensureVolume'), 1, 'the volume was never made again');

    // In that order: the stop asked, the old container removed by UID once stopped, then generation 2 made.
    const calls = w.channel.calls;
    const removed = calls.lastIndexOf('removeContainer');
    assert.ok(calls.indexOf('stopContainer') < removed && removed < calls.lastIndexOf('createContainer'), calls.join(' '));
    assert.equal(w.channel.stopRequests.every((s) => s.uid === mapping.podUid), true, 'only generation 1 was ever asked to stop');

    // On the current image now: silent again, it is left as any runner is.
    const stops = w.channel.stopRequests.length;
    w.advance(PREVIOUS_IMAGE_SILENCE_MS + 1_000);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.equal(w.channel.stopRequests.length, stops);
  });

  await t.test('(2) a previous image alone: a runner that still beats is left on it', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('previous-alone');
    w.upgrade();
    for (let elapsed = 0; elapsed <= PREVIOUS_IMAGE_SILENCE_MS * 2; elapsed += 60_000) {
      w.advance(60_000);
      await w.heartbeat(mapping.runnerId, BUSY);
      assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    }
    const after = await w.mappingOf(ownerId);
    assert.deepEqual({ state: after.managementState, podUid: after.podUid, generation: after.generation, lastError: after.lastError },
      { state: 'READY', podUid: mapping.podUid, generation: 1, lastError: null });
    assert.deepEqual(w.channel.stopRequests, []);
    assert.equal(w.channel.containers.get(`mr-${mapping.runnerId}`)!.status, 'running');
  });

  await t.test('(3) silence alone: on the current image a silent runner is left READY, and nothing is written', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('silent-current');
    w.advance(PREVIOUS_IMAGE_SILENCE_MS * 3);
    for (let i = 0; i < 3; i += 1) assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    const after = await w.mappingOf(ownerId);
    assert.deepEqual({ state: after.managementState, podUid: after.podUid, revision: after.revision },
      { state: 'READY', podUid: mapping.podUid, revision: mapping.revision });
    assert.deepEqual(w.channel.stopRequests, []);
    assert.equal(w.channel.count('createContainer'), 1);
  });

  await t.test('(4) a stop that is not confirmed fences, and nothing is made', async (st) => {
    const stopped = async (label: string) => {
      const w = world();
      const { ownerId, mapping } = await w.readyRunner(label);
      w.upgrade();
      w.channel.stopsAtOnce = false;
      w.advance(PREVIOUS_IMAGE_SILENCE_MS + 1_000);
      assert.equal(await w.manager.reconcile(mapping.id), 'READY');
      assert.equal(w.channel.stopRequests.length, 1);
      return { w, ownerId, mapping, token: await w.tokenOf(mapping.runnerId) };
    };
    const fenced = async (w: ReturnType<typeof world>, ownerId: string, mapping: ManagedRunner, token: string) => {
      for (let i = 0; i < 3; i += 1) {
        w.advance(60_000);
        assert.equal(await w.manager.reconcile(mapping.id), 'FENCING');
      }
      const after = await w.mappingOf(ownerId);
      assert.deepEqual({ state: after.managementState, code: (after.lastError as { code?: string }).code, generation: after.generation, podUid: after.podUid },
        { state: 'FENCING', code: 'PREDECESSOR_STOP_UNPROVEN', generation: 1, podUid: mapping.podUid });
      assert.notEqual(await w.tokenOf(mapping.runnerId), token, "the predecessor's credential stops working");
      assert.equal(w.channel.count('createContainer'), 1, 'no successor');
    };

    await st.test('ended without Docker\'s report of the exit', async () => {
      const { w, ownerId, mapping, token } = await stopped('unconfirmed');
      Object.assign(w.channel.containers.get(`mr-${mapping.runnerId}`)!, { status: 'dead', running: false, stopping: false, exitCode: null, finishedAt: null });
      await fenced(w, ownerId, mapping, token);
    });

    await st.test('gone, with no report of how', async () => {
      const { w, ownerId, mapping, token } = await stopped('vanished');
      w.channel.vanish(mapping.runnerId);
      await fenced(w, ownerId, mapping, token);
      assert.deepEqual(w.onTheVolume(mapping.pvcName), []);
    });
  });

  await t.test('(5) the silence it needs: a missed beat or an outage up to the reaper\'s hold is not enough', async () => {
    assert.equal(PREVIOUS_IMAGE_SILENCE_MS, MASS_DISCONNECT_HOLD_MS, "the reaper's hold on a mass disconnection's runners");
    const w = world();
    const { mapping } = await w.readyRunner('outage');
    w.upgrade();
    // Past the profile's freshness: the status says the runner is not usable, and that is all.
    w.advance(w.profile.lifecycle.heartbeatFreshSeconds * 1000 + 1_000);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    w.advance(PREVIOUS_IMAGE_SILENCE_MS - w.profile.lifecycle.heartbeatFreshSeconds * 1000 - 2_000);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.deepEqual(w.channel.stopRequests, [], 'silent for the whole hold, not past it');
    // Back before the hold ran out (the outage over): left as it is.
    await w.heartbeat(mapping.runnerId, BUSY);
    w.advance(5_000);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.deepEqual(w.channel.stopRequests, []);
    // Silent past the hold from that beat on: asked to stop.
    w.advance(PREVIOUS_IMAGE_SILENCE_MS);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.deepEqual(w.channel.stopRequests, [{ name: `mr-${mapping.runnerId}`, uid: mapping.podUid }]);
  });

  await t.test('(6) a server that still takes the daemon over HTTPS stops nothing for its image', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('switch-off');
    w.upgrade();
    w.switchOn.linkOnly = false;
    w.advance(PREVIOUS_IMAGE_SILENCE_MS * 3);
    for (let i = 0; i < 3; i += 1) assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    const after = await w.mappingOf(ownerId);
    assert.deepEqual({ state: after.managementState, podUid: after.podUid, revision: after.revision },
      { state: 'READY', podUid: mapping.podUid, revision: mapping.revision });
    assert.deepEqual(w.channel.stopRequests, []);
    // The switch on: the same runner is asked to stop at the next pass.
    w.switchOn.linkOnly = true;
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.equal(w.channel.stopRequests.length, 1);
  });

  await t.test('(7) asked to sleep while silent on a previous image: the stop ends in sleep', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('asleep');
    w.upgrade();
    w.advance(PREVIOUS_IMAGE_SILENCE_MS + 1_000);
    await w.service.sleep(ownerId, 'sleep-silent', mapping.revision);
    const outcomes = await w.drive(ownerId, ['SLEEPING']);
    assert.equal(outcomes.at(-1), 'SLEEPING', outcomes.join(' → '));
    const asleep = await w.mappingOf(ownerId);
    assert.deepEqual({ state: asleep.managementState, generation: asleep.generation, podUid: asleep.podUid, proof: (asleep.fencingReceipt as { kind?: string }).kind },
      { state: 'SLEEPING', generation: 2, podUid: null, proof: 'OBSERVED_STOP' });
    assert.deepEqual(w.onTheVolume(mapping.pvcName), []);
    assert.deepEqual(w.channel.stopRequests, [{ name: `mr-${mapping.runnerId}`, uid: mapping.podUid }]);
  });

  await t.test('(8) a channel too old to say which image a container was made from: nothing is stopped for its image', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('old-channel');
    w.upgrade();
    // A channel from before the container view carried `image` answers without it.
    delete (w.channel.containers.get(`mr-${mapping.runnerId}`) as { image?: string | null }).image;
    w.advance(PREVIOUS_IMAGE_SILENCE_MS * 3);
    for (let i = 0; i < 3; i += 1) assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    const after = await w.mappingOf(ownerId);
    assert.deepEqual({ state: after.managementState, podUid: after.podUid, revision: after.revision },
      { state: 'READY', podUid: mapping.podUid, revision: mapping.revision });
    assert.deepEqual(w.channel.stopRequests, []);
  });

  await t.test('(9) the channel not reached when the stop is asked: nothing is written or made, and the next pass asks again', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('unreached');
    const name = `mr-${mapping.runnerId}`;
    w.upgrade();
    w.advance(PREVIOUS_IMAGE_SILENCE_MS + 1_000);
    const unchanged = async (label: string) => {
      const now = await w.mappingOf(ownerId);
      assert.deepEqual({ state: now.managementState, podUid: now.podUid, generation: now.generation, revision: now.revision, lastError: now.lastError },
        { state: 'READY', podUid: mapping.podUid, generation: 1, revision: mapping.revision, lastError: null }, label);
      assert.equal(w.channel.count('createContainer'), 1, `${label}: nothing made`);
    };
    // Never reached: no stop was asked.
    w.channel.failNext('stopContainer', { kind: 'unreachable-before' });
    assert.equal(await w.manager.reconcile(mapping.id), 'BACKOFF');
    await unchanged('not reached');
    assert.deepEqual([w.channel.stopRequests, w.channel.containers.get(name)!.status], [[], 'running']);
    // Reached and its answer lost: the container stops, and nothing is read into the lost answer.
    w.channel.failNext('stopContainer', { kind: 'unreachable-after' });
    assert.equal(await w.manager.reconcile(mapping.id), 'BACKOFF');
    await unchanged('answer lost');
    assert.equal(w.channel.stopRequests.length, 1);
    // The next pass reads Docker's report of the exit, as for any stop, and the next generation follows.
    const outcomes = await w.drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const made = w.channel.containers.get(name)!;
    assert.deepEqual([made.request.image, made.generation], [NEXT, 2]);
  });

  await t.test('(10) a manager given no link-only answer, as on a build without the cut-over\'s switch: link-only, with no switch row', async () => {
    const { rows } = await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM runner_link_switch');
    assert.equal(rows[0].n, 0, 'the switch was never switched here: no row, which reads as off where a build still reads it');
    const w = world({ withSwitch: false });
    const { mapping } = await w.readyRunner('no-switch');
    w.upgrade();
    w.advance(PREVIOUS_IMAGE_SILENCE_MS + 1_000);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.deepEqual(w.channel.stopRequests, [{ name: `mr-${mapping.runnerId}`, uid: mapping.podUid }]);
  });
});
