/**
 * The owner's Update Now of an Orbit Cloud runner (docs/managed-runner-update-now-design.md, "What changes" 3), the
 * idle path and the refusals: POST /api/managed-runner/update-now as ManagedRunnerService.updateNow answers it, and the
 * manager's READY pass that performs it (ManagedRunnerManager.ownerUpdate). The manager on DockerBackend — which also
 * rolls an idle previous image by itself (`rollImage`), so each runner here is busy when the manager first finds it
 * outdated — over the channel that keeps the real one's rules in memory
 * (test-support/fake-docker-channel.ts), against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty;
 * the clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-update-now.pg.spec.ts
 *
 *   (1) idle (a fresh idle report, nothing in managedRunnerWork) on a previous image: Update Now records who asked
 *       and when and reads `updating`; the next pass drains it at once, marked `imageRollTo`, without waiting out the
 *       idle interval; it accepts, exits, and wakes at once as the next generation, made from the current image on
 *       the same volume and runner. Nothing is interrupted: no stop is forced, and the owner's open session is left
 *       as it was. Asked again meanwhile, it is answered as it stands;
 *   (2) refused: already current (409 MANAGED_RUNNER_CURRENT), a disabled account (403 ACCOUNT_DISABLED), a mapping
 *       that is not READY (409 MANAGED_RUNNER_TRANSITION_REFUSED), and another account (404: it reaches its own
 *       mapping or none) — nothing written;
 *   (3) busy — a turn running, background jobs, or no fresh report — refused 409 MANAGED_RUNNER_BUSY, listing the
 *       running turns (session, title, start) and the background-job count; nothing written, and it stays READY.
 *
 * Not destructive: every row belongs to a user this run creates, and each world has a pool of its own.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
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
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import type { ManagedRunnerRuntime } from './managed-runner-runtime';
import { managedRunnerHeartbeat, storedWorkloadFor } from './managed-runner-sleep';
import { ManagedRunnerWorker } from './managed-runner-worker';
import { ManagedRunnerService } from './managed-runner.service';

const URL = process.env.COORDINATOR_PG_URL;
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const ON = { enabled: true, problem: null } as const;
const IDLE = { activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 0 };
/** The image an upgrade builds, and the commit it was built from. */
const NEXT = `sha256:${'e'.repeat(64)}`;
const OLD_SHA = '95884b154f';
const NEW_SHA = 'a800ca3973';

/** The refusal `call` threw: its HTTP status and body. */
async function refusal(call: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof HttpException, `an HTTP refusal, not ${(error as Error).message}`);
    return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
  }
  assert.fail('accepted, not refused');
}

test('an owner\'s Update Now moves an idle Orbit Cloud runner onto the current image', {
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

  function world() {
    let profile = testDockerRunnerProfile({ clusterKey: `update-now-${randomUUID().slice(0, 8)}` });
    const channel = new FakeDockerChannel(profile.docker.instanceId, profile.runner.image);
    channel.imageRevision = OLD_SHA;
    const clock = { ms: Date.now() };
    const now = () => new Date(clock.ms);
    let manager: ManagedRunnerManager;
    let service: ManagedRunnerService;
    /** The build the runner in the container reports: the one its image was built from. */
    let runnerBuild = OLD_SHA;
    const start = () => {
      manager = new ManagedRunnerManager(prisma, new DockerBackend(channel, profile), profile, {
        holder: `update-now-${randomUUID().slice(0, 8)}`, now, random: () => 0.5, log: quiet, linkOnly: () => false,
      });
      // The worker is not started: the test runs every pass itself, so a kick passes nothing.
      const runtime: ManagedRunnerRuntime = { available: true, profile, manager, worker: new ManagedRunnerWorker(manager, 60_000, quiet) };
      service = new ManagedRunnerService(prisma, ON, runtime);
    };
    start();
    /** An upgrade: the apiserver and the channel recreated on a new image, the running container left as it is. */
    const upgrade = () => {
      profile = { ...profile, runner: { ...profile.runner, image: NEXT } };
      channel.image = NEXT;
      channel.imageRevision = NEW_SHA;
      start();
    };
    const advance = (ms: number) => void (clock.ms += ms);
    const mappingOf = async (ownerId: string): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId } }))!;

    async function heartbeat(runnerId: string, workload: Partial<typeof IDLE> = {}) {
      const mapping = (await db.managedRunner.findUnique({ where: { runnerId } }))!;
      await db.runner.update({
        where: { id: runnerId },
        data: {
          status: 'ONLINE',
          version: `managed-${runnerBuild}`,
          lastHeartbeatAt: now(),
          engines: [{ engine: 'codex', installed: true, auth: 'yes' }],
          capabilities: [MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY],
          managedWorkload: mapping.podUid
            ? (storedWorkloadFor({ ...IDLE, ...workload }, { mappingId: mapping.id, generation: mapping.generation, podUid: mapping.podUid }, false, now()) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      });
    }

    /** Reconcile until READY, heartbeating a container that starts; after each pass, `each` sees the mapping. */
    async function drive(ownerId: string, each: (m: ManagedRunner) => Promise<void> = async () => undefined): Promise<ReconcileOutcome[]> {
      const outcomes: ReconcileOutcome[] = [];
      for (let i = 0; i < 40; i += 1) {
        const outcome = await manager.reconcile((await mappingOf(ownerId)).id);
        outcomes.push(outcome);
        if (outcome === 'READY' || outcome === 'FAILED') return outcomes;
        const after = await mappingOf(ownerId);
        await each(after);
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

    /**
     * READY on the image before an upgrade, found outdated by the manager: its status offers the update. Busy when
     * the manager finds it so (a turn running, by default): an idle one would be rolled by itself (rollPreviousImage).
     */
    async function outdatedRunner(label: string, workload: Partial<typeof IDLE> = { activeTurns: 1 }) {
      const ready = await readyRunner(label);
      upgrade();
      advance(30_000);
      await heartbeat(ready.mapping.runnerId, workload);
      assert.equal(await manager.reconcile(ready.mapping.id), 'READY', 'busy on a previous image, it is not rolled');
      assert.equal((await service.status(ready.ownerId)).update?.phase, 'available');
      return { ownerId: ready.ownerId, mapping: await mappingOf(ready.ownerId) };
    }

    return {
      channel, now, advance, heartbeat, drive, readyRunner, outdatedRunner, mappingOf, upgrade,
      set runnerBuild(sha: string) { runnerBuild = sha; },
      get manager() { return manager; },
      get service() { return service; },
    };
  }

  /** A session of the owner's on the runner, in `status`, as a turn queued or run there leaves one. */
  async function session(m: ManagedRunner, status: string, title: string, bgShells: string[] = []): Promise<{ id: string; startedAt: Date }> {
    const workspace = await db.workspace.create({ data: { ownerId: m.ownerId, runnerId: m.runnerId, targetRunnerId: m.runnerId, name: 'Project', workDir: '/tmp/project' } });
    const id = randomUUID();
    const startedAt = new Date(Date.now() - 60_000);
    await sql.query(
      `INSERT INTO "session" ("id", "owner_id", "creator_id", "workspace_id", "assigned_runner_id", "title", "prompt", "provider",
                              "status", "num_turns", "runtime_session_id", "started_at", "updated_at", "running_bg_shells")
       VALUES ($1, $2, $2, $3, $4, $5, 'work', 'claude', $6::"run_status", 1, $7, $8, now(), $9::text[])`,
      [id, m.ownerId, workspace.id, m.runnerId, title, status, randomUUID(), startedAt.toISOString(), bgShells],
    );
    return { id, startedAt };
  }

  await t.test('(1) idle on a previous image: Update Now drains it at once, and it wakes as the next generation on the current image', async () => {
    const w = world();
    const { ownerId, mapping } = await w.outdatedRunner('idle');
    // An open session waiting for its owner, with nothing running: no work, and an update must leave it as it is.
    const open = await session(mapping, 'AWAITING_INPUT', 'waiting for its owner');

    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    const before = Date.now();
    const answered = await w.service.updateNow(ownerId);
    assert.equal(answered.managementState, 'READY');
    assert.deepEqual(answered.update, { running: { sha: OLD_SHA }, current: { sha: NEW_SHA }, phase: 'updating' }, 'updating from the moment it is asked');
    const asked = await w.mappingOf(ownerId);
    assert.equal(asked.updateRequestedBy, ownerId, 'who asked');
    assert.ok(asked.updateRequestedAt && asked.updateRequestedAt.getTime() >= before, 'and when');
    assert.equal(asked.updateCompletedAt, null);
    assert.equal(asked.revision, mapping.revision + 1, 'a request the manager\'s compare-and-set sees');

    // Asked again while it is in progress: answered as it stands, nothing written.
    assert.equal((await w.service.updateNow(ownerId)).update?.phase, 'updating');
    assert.equal((await w.mappingOf(ownerId)).revision, asked.revision);

    // The next pass: idle by its fresh report and the records, it drains at once — the idle interval far from over.
    assert.ok(w.now().getTime() - mapping.stateEnteredAt.getTime() < w.manager['profile'].lifecycle.idleSeconds * 1000, 'well within the idle interval');
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING');
    const draining = await w.mappingOf(ownerId);
    assert.deepEqual(
      { state: draining.managementState, desired: draining.desiredState, rollTo: draining.imageRollTo, generation: draining.generation, podUid: draining.podUid },
      { state: 'DRAINING', desired: 'SLEEPING', rollTo: NEXT, generation: mapping.generation, podUid: mapping.podUid },
      'drained as an image roll is, marked with the current image',
    );
    assert.ok(draining.stopRequestedAt, 'its heartbeat asks it to stop');
    assert.equal((await w.service.status(ownerId)).update?.phase, 'updating');

    // It accepts the stop, idle, and exits by itself: nothing forced.
    const instance = { mappingId: draining.id, generation: draining.generation, podUid: draining.podUid! };
    const answer = await managedRunnerHeartbeat(prisma, instance, { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() }, w.now());
    assert.deepEqual(answer.sleep, { requestedAt: draining.stopRequestedAt!.toISOString(), confirmed: true });
    w.channel.exit(mapping.runnerId, 0);

    // Made again from the current image, at once: no demand is needed to wake it. Until it is READY the status
    // reads updating, never available.
    w.runnerBuild = NEW_SHA;
    const outcomes = await w.drive(ownerId, async (m) => {
      const update = (await w.service.status(ownerId)).update;
      assert.ok(!update || update.phase === 'updating', `${m.managementState}: ${JSON.stringify(update)}`);
    });
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const awake = await w.mappingOf(ownerId);
    const proof = awake.fencingReceipt as { kind: string; predecessor: { podUid: string } };
    assert.deepEqual([proof.kind, proof.predecessor.podUid], ['OBSERVED_STOP', mapping.podUid], 'the old container\'s own exit is the stop proof');
    const next = w.channel.containers.get(`mr-${mapping.runnerId}`)!;
    assert.equal(next.request.image, NEXT, 'the next container is made from the current image');
    assert.deepEqual(
      { generation: awake.generation, runnerId: awake.runnerId, pvcUid: awake.pvcUid, pvcName: awake.pvcName, volumeUid: next.volumeUid },
      { generation: mapping.generation + 1, runnerId: mapping.runnerId, pvcUid: mapping.pvcUid, pvcName: mapping.pvcName, volumeUid: mapping.pvcUid },
      'the next generation, on the same volume and runner',
    );
    assert.notEqual(awake.podUid, mapping.podUid, 'a new container');
    assert.deepEqual(
      { state: awake.managementState, desired: awake.desiredState, rollTo: awake.imageRollTo },
      { state: 'READY', desired: 'RUNNING', rollTo: null },
    );
    assert.equal(w.channel.count('ensureVolume'), 1, 'the volume was never created again');
    assert.deepEqual(w.channel.stopRequests, [], 'nothing was stopped by force');
    assert.ok(awake.updateCompletedAt && awake.updateCompletedAt >= awake.updateRequestedAt!, 'the next generation READY ends the update');
    assert.equal(awake.updateRequestedBy, ownerId, 'the record of who asked is kept');
    const session_ = await db.session.findUniqueOrThrow({ where: { id: open.id } });
    assert.equal(session_.status, 'AWAITING_INPUT', 'the open session is left as it was');

    // Its runner reports the current build: no update left, and none recorded once the READY pass looks again.
    w.advance(30_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.equal((await w.service.status(ownerId)).update, undefined);
    const current = await w.mappingOf(ownerId);
    assert.deepEqual({ sha: current.currentImageSha, since: current.imageOutdatedSince }, { sha: null, since: null });
  });

  await t.test('(2) refused: already current, a disabled account, not READY, and another account', async () => {
    const w = world();

    // Already current: no update in its status.
    const current = await w.readyRunner('current');
    w.advance(1_000);
    await w.heartbeat(current.mapping.runnerId);
    assert.equal((await w.service.status(current.ownerId)).update, undefined);
    const currentRefused = await refusal(w.service.updateNow(current.ownerId));
    assert.deepEqual([currentRefused.status, currentRefused.body.code], [409, 'MANAGED_RUNNER_CURRENT']);
    assert.equal((await w.mappingOf(current.ownerId)).revision, current.mapping.revision, 'nothing written');

    // The rest are outdated and idle, each refused for its own reason.
    const { ownerId, mapping } = await w.outdatedRunner('refused');
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    const unchanged = async () => {
      const after = await w.mappingOf(ownerId);
      assert.deepEqual(
        { revision: after.revision, at: after.updateRequestedAt, by: after.updateRequestedBy, state: after.managementState, rollTo: after.imageRollTo },
        { revision: mapping.revision, at: null, by: null, state: mapping.managementState, rollTo: null },
      );
    };

    // Another account reaches its own mapping, or none: it cannot update this one.
    const stranger = (await db.user.create({ data: { email: `stranger-${randomUUID()}@example.invalid`, name: 'stranger' } })).id;
    const strangerRefused = await refusal(w.service.updateNow(stranger));
    assert.deepEqual([strangerRefused.status, strangerRefused.body.code], [404, 'MANAGED_RUNNER_NOT_FOUND']);
    await unchanged();

    // A disabled account.
    await db.user.update({ where: { id: ownerId }, data: { disabledAt: new Date() } });
    const disabledRefused = await refusal(w.service.updateNow(ownerId));
    assert.deepEqual([disabledRefused.status, disabledRefused.body.code], [403, 'ACCOUNT_DISABLED']);
    await unchanged();
    await db.user.update({ where: { id: ownerId }, data: { disabledAt: null } });

    // Not READY: draining to sleep, and asleep.
    for (const managementState of ['DRAINING', 'SLEEPING'] as const) {
      await db.managedRunner.update({ where: { id: mapping.id }, data: { managementState, desiredState: 'SLEEPING' } });
      const notReady = await refusal(w.service.updateNow(ownerId));
      assert.deepEqual([notReady.status, notReady.body.code], [409, 'MANAGED_RUNNER_TRANSITION_REFUSED'], managementState);
      const after = await w.mappingOf(ownerId);
      assert.deepEqual({ at: after.updateRequestedAt, rollTo: after.imageRollTo }, { at: null, rollTo: null }, managementState);
    }
    await db.managedRunner.update({ where: { id: mapping.id }, data: { managementState: 'READY', desiredState: 'RUNNING' } });

    // Put back, the same runner is accepted: each refusal was for its own reason.
    assert.equal((await w.service.updateNow(ownerId)).update?.phase, 'updating');
  });

  await t.test('(3) busy: refused 409 MANAGED_RUNNER_BUSY with the running turns and the background jobs, and left READY', async () => {
    const w = world();
    const { ownerId, mapping } = await w.outdatedRunner('busy', { activeTurns: 1, backgroundJobs: 2 });
    const turn = await session(mapping, 'RUNNING', 'Fix the login redirect', ['bgj_1', 'bgj_2']);
    const waiting = await session(mapping, 'AWAITING_INPUT', 'waiting', ['bgj_3']);

    w.advance(1_000);
    await w.heartbeat(mapping.runnerId, { activeTurns: 1, backgroundJobs: 2 });
    const busy = await refusal(w.service.updateNow(ownerId));
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'MANAGED_RUNNER_BUSY');
    assert.deepEqual(busy.body.turns, [{ sessionId: turn.id, title: 'Fix the login redirect', startedAt: turn.startedAt.toISOString() }], 'the running turn; not the waiting session');
    assert.equal(busy.body.backgroundJobs, 3, 'the jobs the records show alive, more than the report counts');
    assert.ok((busy.body.work as string[]).includes('ACTIVE_TURN'));

    // The manager leaves it READY: nothing was asked.
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    let after = await w.mappingOf(ownerId);
    assert.deepEqual({ revision: after.revision, at: after.updateRequestedAt, rollTo: after.imageRollTo }, { revision: mapping.revision, at: null, rollTo: null });

    // Idle by the records, but its own fresh report still counts a job: busy, with the report's count.
    await db.session.updateMany({ where: { id: { in: [turn.id, waiting.id] } }, data: { status: 'SUCCEEDED', runningBgShells: [] } });
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId, { backgroundJobs: 1 });
    const reported = await refusal(w.service.updateNow(ownerId));
    assert.deepEqual([reported.status, reported.body.code, reported.body.turns, reported.body.backgroundJobs], [409, 'MANAGED_RUNNER_BUSY', [], 1]);

    // Idle by both, but the report is stale: it cannot be shown idle, so it is not updated. The request reads the
    // server's own clock, so the report is made older than the freshness on that clock.
    await w.heartbeat(mapping.runnerId);
    const runner = await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } });
    const old = new Date(Date.now() - w.manager['profile'].lifecycle.heartbeatFreshSeconds * 1000 - 1_000);
    await db.runner.update({
      where: { id: mapping.runnerId },
      data: { managedWorkload: { ...(runner.managedWorkload as Record<string, unknown>), receivedAt: old.toISOString() } as Prisma.InputJsonValue },
    });
    const stale = await refusal(w.service.updateNow(ownerId));
    assert.deepEqual([stale.status, stale.body.code], [409, 'MANAGED_RUNNER_BUSY']);
    after = await w.mappingOf(ownerId);
    assert.deepEqual({ state: after.managementState, at: after.updateRequestedAt }, { state: 'READY', at: null });
  });
});
