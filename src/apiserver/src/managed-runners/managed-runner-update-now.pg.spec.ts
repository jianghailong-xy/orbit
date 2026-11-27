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
 *       running turns (session, title, start) and the background-job count; nothing written, and it stays READY;
 *   (4) busy, with `interruptTurns: true`: the request and an activity row naming the sessions whose turns it
 *       interrupts are recorded together; the manager asks the backend to stop the container (`stopInstance`) and
 *       creates nothing while the container is in its stop grace, however many passes, and demand meanwhile changes
 *       nothing; Docker's report of the exit is the stop proof, and only then is the next generation made from the
 *       current image, on the same volume and runner, with no attempt spent; a crash of that next generation before it
 *       is READY is counted as any crash (4b); a manager pass that bumps the revision while the press is decided does
 *       not refuse it, a concurrent press is answered with the status and records nothing twice, and a mapping that left
 *       READY meanwhile is still refused (4c);
 *   (5) idle, then demand before the drain is accepted: the owner's Update Now is not called off — the instance
 *       accepts on its own idle report and wakes on the current image — while an automatic roll still is;
 *   (6) on Kubernetes, as on Docker: a busy runner's Update Now with `interruptTurns` records no `waitsForIdle`; the
 *       manager deletes the Pod by UID with its termination grace (`stopInstance`), makes no Pod while the old one
 *       runs in its grace, however many passes, and demand meanwhile changes nothing; the kubelet's report of the stop
 *       is the proof, and only once the old Pod is gone is the next one made from the profile's image, on the same
 *       claim and runner, with no attempt spent. (6b) a request an earlier server recorded with `waitsForIdle: true`
 *       is taken up by that stop on the next pass.
 *   Elsewhere on Kubernetes nothing is forced: an overdue sleep is only said (managed-runner-sleep.pg.spec.ts).
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
import { installManagedRunnerAdmission } from '../test-support/managed-runner-admission.fixture';
import { managedRunnerWorld } from '../test-support/managed-runner-world';
import { DockerBackend } from './docker-backend';
import type { Pod } from './kube-client';
import { podImages } from './managed-runner-admission';
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import { MANAGED_POD_TERMINATION_GRACE_SECONDS, managedPodName } from './managed-runner-resources';
import type { ManagedRunnerRuntime } from './managed-runner-runtime';
import { managedRunnerHeartbeat, storedWorkloadFor } from './managed-runner-sleep';
import { recordManagedDemand } from './managed-runner-work';
import { ManagedRunnerWorker } from './managed-runner-worker';
import { MANAGED_RUNNER_UPDATE_NOW_ACTIVITY, ManagedRunnerService } from './managed-runner.service';
import { WORD_SELECT, wordOf } from '../test-support/session-word';

const URL = process.env.COORDINATOR_PG_URL;
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const ON = { enabled: true, problem: null } as const;
const IDLE = { activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 0 };
/** The image an upgrade builds, and the commit it was built from. */
const NEXT = `sha256:${'e'.repeat(64)}`;
const OLD_SHA = '95884b154f';
const NEW_SHA = 'a800ca3973';
/** The release NEW_SHA's image was published for (its org.opencontainers.image.version label). */
const NEW_VERSION = '0.1.261-beta.84';

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

  /** A session of the owner's on the runner, in `status`, as a turn queued or run there leaves one, started `agoMs` ago. */
  async function session(m: ManagedRunner, status: string, title: string, bgShells: string[] = [], agoMs = 60_000): Promise<{ id: string; startedAt: Date }> {
    const workspace = await db.workspace.create({ data: { ownerId: m.ownerId, runnerId: m.runnerId, targetRunnerId: m.runnerId, name: 'Project', workDir: '/tmp/project' } });
    const id = randomUUID();
    const startedAt = new Date(Date.now() - agoMs);
    await sql.query(
      `INSERT INTO "session" ("id", "owner_id", "creator_id", "workspace_id", "assigned_runner_id", "title", "prompt", "provider",
                              "turn_state", "num_turns", "runtime_session_id", "started_at", "updated_at", "running_bg_shells")
       VALUES ($1, $2, $2, $3, $4, $5, 'work', 'claude', (CASE ($6)::text WHEN 'PENDING' THEN 'QUEUED' WHEN 'RUNNING' THEN 'IN_FLIGHT' WHEN 'INTERRUPTED' THEN 'ABANDONED' END), 1, $7, $8, now(), $9::text[])`,
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
    assert.equal(wordOf(session_), 'AWAITING_INPUT', 'the open session is left as it was');

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
    // Ended as the server ends one: a terminal status with its release column (session_release_fact_chk, 1401).
    await db.session.updateMany({
      where: { id: { in: [turn.id, waiting.id] } },
      data: { turnState: null, finishedAt: w.now(), runningBgShells: [] },
    });
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

  await t.test('(4) busy, with interruptTurns: recorded with the sessions it interrupts, stopped through the backend, and made again only after Docker reports the exit', async () => {
    const w = world();
    const { ownerId, mapping } = await w.outdatedRunner('interrupt', { activeTurns: 2, backgroundJobs: 1 });
    const first = await session(mapping, 'RUNNING', 'Fix the login redirect', ['bgj_1'], 120_000);
    const second = await session(mapping, 'RUNNING', 'Write the release notes', [], 60_000);
    const name = `mr-${mapping.runnerId}`;
    // The channel takes the stop in, and the container goes on running in its stop grace until Docker reports it exited.
    w.channel.stopsAtOnce = false;

    w.advance(1_000);
    await w.heartbeat(mapping.runnerId, { activeTurns: 2, backgroundJobs: 1 });
    // Without the owner's word it is refused, as in (3), and nothing is recorded.
    const refused = await refusal(w.service.updateNow(ownerId));
    assert.deepEqual([refused.status, refused.body.code], [409, 'MANAGED_RUNNER_BUSY']);
    assert.equal(await db.activity.count({ where: { actorId: ownerId, type: MANAGED_RUNNER_UPDATE_NOW_ACTIVITY } }), 0);

    // With it: recorded, with the activity naming the sessions whose turns it interrupts.
    const before = Date.now();
    const answered = await w.service.updateNow(ownerId, true);
    assert.deepEqual(answered.update, { running: { sha: OLD_SHA }, current: { sha: NEW_SHA }, phase: 'updating' }, 'updating, and not waiting for idle: Docker can stop it');
    const asked = await w.mappingOf(ownerId);
    assert.deepEqual(
      { state: asked.managementState, by: asked.updateRequestedBy, interrupts: asked.updateInterruptTurns, completed: asked.updateCompletedAt, revision: asked.revision },
      { state: 'READY', by: ownerId, interrupts: true, completed: null, revision: mapping.revision + 1 },
    );
    assert.ok(asked.updateRequestedAt && asked.updateRequestedAt.getTime() >= before);
    const activities = await db.activity.findMany({ where: { actorId: ownerId, type: MANAGED_RUNNER_UPDATE_NOW_ACTIVITY } });
    assert.equal(activities.length, 1, 'one activity row for the request');
    assert.deepEqual(activities[0].payload, {
      mappingId: mapping.id,
      runnerId: mapping.runnerId,
      interruptTurns: true,
      waitsForIdle: false,
      running: OLD_SHA,
      current: NEW_SHA,
      sessionIds: [first.id, second.id],
      backgroundJobs: 1,
    }, 'the interrupted sessions, oldest turn first, and the jobs a new container ends');
    assert.equal(activities[0].credentialKind, 'LOGIN');
    // Asked again meanwhile: answered as it stands, with no second record.
    assert.equal((await w.service.updateNow(ownerId, true)).update?.phase, 'updating');
    assert.equal(await db.activity.count({ where: { actorId: ownerId, type: MANAGED_RUNNER_UPDATE_NOW_ACTIVITY } }), 1);

    // The next pass asks the backend to stop the container, by its UID, and stays READY: asking proves nothing.
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.deepEqual(w.channel.stopRequests, [{ name, uid: mapping.podUid }], 'stopInstance, for the recorded container');
    const requested = await w.mappingOf(ownerId);
    assert.ok(requested.stopRequestedAt && requested.stopRequestedAt >= asked.updateRequestedAt!, 'the stop request is recorded');
    assert.equal(requested.stopAcknowledgedAt, null, 'and not acknowledged while the container runs');

    // Demand while it stops — a message queued for the runner, and the demand hook's write — changes nothing, and no
    // pass creates anything while the container is in its grace, still running.
    const queued = await session(mapping, 'PENDING', 'a message sent meanwhile');
    await recordManagedDemand(prisma, mapping.runnerId, w.now());
    for (let pass = 0; pass < 3; pass += 1) {
      w.advance(5_000);
      await w.heartbeat(mapping.runnerId, { activeTurns: 2, backgroundJobs: 1 });
      assert.equal(await w.manager.reconcile(mapping.id), 'READY', `pass ${pass} while it stops`);
      assert.equal((await w.service.status(ownerId)).update?.phase, 'updating');
    }
    const stopping = await w.mappingOf(ownerId);
    assert.deepEqual(
      { state: stopping.managementState, generation: stopping.generation, podUid: stopping.podUid, attempt: stopping.attempt, interrupts: stopping.updateInterruptTurns, completed: stopping.updateCompletedAt },
      { state: 'READY', generation: mapping.generation, podUid: mapping.podUid, attempt: 0, interrupts: true, completed: null },
      'demand did not call it off, and nothing advanced',
    );
    assert.deepEqual([stopping.stopRequestedAt, stopping.stopAcknowledgedAt], [requested.stopRequestedAt, null], 'asked again, the first request stands');
    assert.ok(stopping.demandRevision > mapping.demandRevision, 'the demand was recorded');
    assert.equal(w.channel.count('createContainer'), 1, 'no container is created before Docker reports the old one stopped');
    assert.equal(w.channel.containers.get(name)?.uid, mapping.podUid, 'the one container is still the old one');
    assert.ok(w.channel.stopRequests.length >= 2 && w.channel.stopRequests.every((r) => r.uid === mapping.podUid), 'asked again on each pass, always that container');

    // Docker's report of the exit (SIGTERM's 143) is the stop proof: only now is the next generation made — from the
    // current image, on the same volume and runner, and with no attempt spent: the owner asked for this stop.
    w.channel.exit(mapping.runnerId, 143);
    w.runnerBuild = NEW_SHA;
    const outcomes = await w.drive(ownerId, async (m) => {
      const update = (await w.service.status(ownerId)).update;
      assert.ok(!update || update.phase === 'updating', `${m.managementState}: ${JSON.stringify(update)}`);
      assert.equal(m.attempt, 0, `${m.managementState}: no attempt spent`);
      assert.equal((m.lastError as { code?: string } | null)?.code ?? null, null, `${m.managementState}: no restart reason`);
    });
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    assert.ok(!outcomes.includes('BACKOFF') && !outcomes.includes('FENCING'), outcomes.join(' → '));
    const awake = await w.mappingOf(ownerId);
    const proof = awake.fencingReceipt as { kind: string; predecessor: { podUid: string; generation: number }; observation: { containers: Array<{ exitCode?: number }> } };
    assert.deepEqual(
      [proof.kind, proof.predecessor.podUid, proof.predecessor.generation, proof.observation.containers[0].exitCode],
      ['OBSERVED_STOP', mapping.podUid, mapping.generation, 143],
      'Docker\'s report of the old container\'s exit is the stop proof',
    );
    const next = w.channel.containers.get(name)!;
    assert.equal(next.request.image, NEXT, 'the next container is made from the current image');
    assert.deepEqual(
      { generation: awake.generation, runnerId: awake.runnerId, pvcUid: awake.pvcUid, pvcName: awake.pvcName, volumeUid: next.volumeUid, runnerOfContainer: next.runnerId },
      { generation: mapping.generation + 1, runnerId: mapping.runnerId, pvcUid: mapping.pvcUid, pvcName: mapping.pvcName, volumeUid: mapping.pvcUid, runnerOfContainer: mapping.runnerId },
      'the next generation, on the same volume and runner',
    );
    assert.notEqual(awake.podUid, mapping.podUid);
    assert.equal(w.channel.count('createContainer'), 2, 'one container created, after the report');
    assert.equal(w.channel.count('ensureVolume'), 1, 'the volume was never created again');
    assert.deepEqual(
      { state: awake.managementState, desired: awake.desiredState, rollTo: awake.imageRollTo, attempt: awake.attempt },
      { state: 'READY', desired: 'RUNNING', rollTo: null, attempt: 0 },
    );
    assert.ok(awake.updateCompletedAt && awake.updateCompletedAt >= awake.updateRequestedAt!, 'the next generation READY ends the update');
    assert.equal(awake.stopRequestedAt?.getTime(), requested.stopRequestedAt!.getTime(), 'the next generation keeps the stop request');
    assert.ok(awake.stopAcknowledgedAt && awake.stopAcknowledgedAt >= awake.stopRequestedAt!, 'and Docker\'s report of the exit as its acknowledgement');
    // The sessions are the runner's to stop and resume: the server changed none of them.
    const sessions = await db.session.findMany({ where: { id: { in: [first.id, second.id, queued.id] } }, select: { id: true, ...WORD_SELECT } });
    assert.deepEqual(
      Object.fromEntries(sessions.map((s) => [s.id, wordOf(s)])),
      { [first.id]: 'RUNNING', [second.id]: 'RUNNING', [queued.id]: 'PENDING' },
    );
  });

  await t.test('(4b) busy, with interruptTurns: a crash of the next generation before it is READY is counted as any crash', async () => {
    const w = world();
    const { ownerId, mapping } = await w.outdatedRunner('next-crash', { activeTurns: 1 });
    await session(mapping, 'RUNNING', 'A long build');
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId, { activeTurns: 1 });
    await w.service.updateNow(ownerId, true);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.equal(w.channel.stopRequests.length, 1, 'asked to stop');
    // The old container's stop is the owner's: no attempt. The new one starts, and crashes before it reports in (the
    // clock moved past the old one's last beat, so nothing has reported since it started).
    w.advance(5_000);
    let starting = await w.mappingOf(ownerId);
    for (let i = 0; i < 6 && !(starting.managementState === 'STARTING' && starting.podUid); i += 1) {
      await w.manager.reconcile(mapping.id);
      starting = await w.mappingOf(ownerId);
    }
    assert.deepEqual({ state: starting.managementState, generation: starting.generation, attempt: starting.attempt }, { state: 'STARTING', generation: mapping.generation + 1, attempt: 0 });
    assert.equal(w.channel.containers.get(`mr-${mapping.runnerId}`)!.request.image, NEXT);
    w.channel.exit(mapping.runnerId, 1);
    assert.equal(await w.manager.reconcile(mapping.id), 'BACKOFF', 'a crash of the new generation backs off');
    const crashed = await w.mappingOf(ownerId);
    assert.deepEqual(
      { state: crashed.managementState, attempt: crashed.attempt, code: (crashed.lastError as { code?: string } | null)?.code, completed: crashed.updateCompletedAt },
      { state: 'REQUESTED', attempt: 1, code: 'POD_RESTARTING', completed: null },
      'an attempt spent and the restart said, as for any crash',
    );
    assert.ok(crashed.nextAttemptAt && crashed.nextAttemptAt > w.now(), 'with its backoff');
    // Started again, it reports in: READY on the current image, which ends the update.
    w.runnerBuild = NEW_SHA;
    const outcomes = await w.drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const awake = await w.mappingOf(ownerId);
    assert.deepEqual({ generation: awake.generation, pvcUid: awake.pvcUid }, { generation: mapping.generation + 2, pvcUid: mapping.pvcUid });
    assert.ok(awake.updateCompletedAt && awake.updateCompletedAt >= awake.updateRequestedAt!);
  });

  await t.test('(4c) busy, with interruptTurns: a manager pass that bumps the revision while the press is decided does not refuse it (production, 2026-11-23)', async () => {
    const w = world();
    const { ownerId, mapping } = await w.outdatedRunner('revision-race', { activeTurns: 1 });
    const turn = await session(mapping, 'RUNNING', 'A hung turn');
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId, { activeTurns: 1 });
    // What a manager pass writes between the press's read and its write: the revision alone, as every commit bumps it
    // (the production runner was at revision 1172).
    const service = w.service as unknown as { busyWith: (...args: unknown[]) => Promise<unknown> };
    const busyWith = service.busyWith.bind(w.service);
    let passes = 0;
    service.busyWith = async (...args: unknown[]) => {
      passes += 1;
      await db.managedRunner.update({ where: { id: mapping.id }, data: { revision: { increment: 1 } } });
      return busyWith(...args);
    };
    const read = await w.mappingOf(ownerId);
    const answered = await w.service.updateNow(ownerId, true);
    assert.equal(passes, 1, 'the manager wrote between the read and the write');
    assert.equal(answered.update?.phase, 'updating', 'accepted, not refused as a revision conflict');
    const asked = await w.mappingOf(ownerId);
    assert.deepEqual(
      { by: asked.updateRequestedBy, interrupts: asked.updateInterruptTurns, revision: asked.revision },
      { by: ownerId, interrupts: true, revision: read.revision + 2 },
      'recorded over the manager\'s write, and the revision bumped so a pass that read before it is Superseded',
    );
    const activities = await db.activity.findMany({ where: { actorId: ownerId, type: MANAGED_RUNNER_UPDATE_NOW_ACTIVITY } });
    assert.equal(activities.length, 1);
    assert.deepEqual((activities[0].payload as { sessionIds: string[] }).sessionIds, [turn.id]);

    // A second press that read before the first was recorded loses to it: answered with the status, nothing written twice.
    await db.managedRunner.update({ where: { id: mapping.id }, data: { updateRequestedAt: null, updateRequestedBy: null, updateInterruptTurns: false } });
    await db.activity.deleteMany({ where: { actorId: ownerId, type: MANAGED_RUNNER_UPDATE_NOW_ACTIVITY } });
    service.busyWith = async (...args: unknown[]) => {
      // The other press lands first.
      await db.managedRunner.update({ where: { id: mapping.id }, data: { updateRequestedAt: w.now(), updateRequestedBy: ownerId, updateInterruptTurns: true, revision: { increment: 1 } } });
      return busyWith(...args);
    };
    const second = await w.service.updateNow(ownerId, true);
    assert.equal(second.update?.phase, 'updating', 'answered as it stands');
    assert.equal(await db.activity.count({ where: { actorId: ownerId, type: MANAGED_RUNNER_UPDATE_NOW_ACTIVITY } }), 0, 'the losing press records nothing');

    // A mapping that left READY meanwhile still refuses: the condition is the decision's, not the revision's.
    await db.managedRunner.update({ where: { id: mapping.id }, data: { updateRequestedAt: null, updateRequestedBy: null, updateInterruptTurns: false } });
    service.busyWith = async (...args: unknown[]) => {
      await db.managedRunner.update({ where: { id: mapping.id }, data: { managementState: 'DRAINING', revision: { increment: 1 } } });
      return busyWith(...args);
    };
    const moved = await refusal(w.service.updateNow(ownerId, true));
    assert.equal(moved.status, 409);
    assert.equal((await w.mappingOf(ownerId)).updateRequestedAt, null, 'nothing written');
  });

  await t.test('(5) idle, then demand before the drain is accepted: the owner\'s Update Now goes on, an automatic roll is called off', async () => {
    const w = world();
    const { ownerId, mapping } = await w.outdatedRunner('idle-demand');
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    await w.service.updateNow(ownerId);
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING');
    const draining = await w.mappingOf(ownerId);
    assert.equal(draining.updateInterruptTurns, false, 'an idle runner\'s request interrupts nothing');

    // Demand before the instance accepts: a message queued for the runner, and the demand hook's write.
    const queued = await session(draining, 'PENDING', 'a message sent meanwhile');
    await recordManagedDemand(prisma, mapping.runnerId, w.now());
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await w.manager.reconcile(mapping.id), 'DRAINING', 'not called off by demand, nor by the work it queued');
    const demanded = await w.mappingOf(ownerId);
    assert.deepEqual(
      { state: demanded.managementState, rollTo: demanded.imageRollTo, stopRequestedAt: demanded.stopRequestedAt, acked: demanded.stopAcknowledgedAt },
      { state: 'DRAINING', rollTo: NEXT, stopRequestedAt: draining.stopRequestedAt, acked: null },
    );
    assert.ok(demanded.demandRevision > demanded.drainDemandRevision!, 'demand came after the drain began');

    // The instance, idle by its own account, accepts all the same, and exits.
    const instance = { mappingId: draining.id, generation: draining.generation, podUid: draining.podUid! };
    const answer = await managedRunnerHeartbeat(prisma, instance, { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() }, w.now());
    assert.deepEqual(answer.sleep, { requestedAt: draining.stopRequestedAt!.toISOString(), confirmed: true });
    w.channel.exit(mapping.runnerId, 0);
    w.runnerBuild = NEW_SHA;
    const outcomes = await w.drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const awake = await w.mappingOf(ownerId);
    assert.equal(w.channel.containers.get(`mr-${mapping.runnerId}`)!.request.image, NEXT, 'the current image');
    assert.deepEqual(
      { generation: awake.generation, runnerId: awake.runnerId, pvcUid: awake.pvcUid, desired: awake.desiredState },
      { generation: mapping.generation + 1, runnerId: mapping.runnerId, pvcUid: mapping.pvcUid, desired: 'RUNNING' },
    );
    assert.ok(awake.updateCompletedAt && awake.updateCompletedAt >= awake.updateRequestedAt!);
    assert.deepEqual(w.channel.stopRequests, [], 'nothing was stopped by force');
    assert.equal(wordOf((await db.session.findUniqueOrThrow({ where: { id: queued.id } }))), 'PENDING', 'the message waits for the next generation');

    // An automatic roll — the same drain, nobody having asked — is still called off by demand.
    const v = world();
    const auto = await v.outdatedRunner('auto-roll');
    v.advance(1_000);
    await v.heartbeat(auto.mapping.runnerId);
    assert.equal(await v.manager.reconcile(auto.mapping.id), 'DRAINING', 'idle on a previous image, it rolls by itself');
    const rolling = await v.mappingOf(auto.ownerId);
    assert.deepEqual({ rollTo: rolling.imageRollTo, asked: rolling.updateRequestedAt }, { rollTo: NEXT, asked: null });
    await recordManagedDemand(prisma, auto.mapping.runnerId, v.now());
    v.advance(1_000);
    await v.heartbeat(auto.mapping.runnerId);
    assert.equal(await v.manager.reconcile(auto.mapping.id), 'READY', 'demand calls the automatic roll off');
    const calledOff = await v.mappingOf(auto.ownerId);
    assert.deepEqual({ state: calledOff.managementState, rollTo: calledOff.imageRollTo, generation: calledOff.generation }, { state: 'READY', rollTo: null, generation: auto.mapping.generation });
  });

  /** A Kubernetes world whose profile has moved on to NEXT (built from NEW_SHA), with a READY runner made before it. */
  async function kubernetesOutdated(label: string) {
    const k = managedRunnerWorld(db);
    const { ownerId, mapping } = await k.readyRunner(label);
    // The upgrade: the profile names a new image built from NEW_SHA for a release, as a two-stage deploy writes it
    // (runner.imageVersion); the Pod keeps the one it was made from.
    const profile: ManagedRunnerProfile = {
      ...k.profile, runner: { ...k.profile.runner, image: `registry.invalid/orbit-cloud-runner@${NEXT}`, imageRevision: NEW_SHA, imageVersion: NEW_VERSION },
    };
    installManagedRunnerAdmission(k.cluster, prisma, profile);
    const manager = new ManagedRunnerManager(prisma, k.cluster.client(), profile, {
      holder: `${label}-${randomUUID().slice(0, 8)}`, now: k.now, random: () => 0.5, log: quiet, ownLocationOnly: true,
    });
    const service = new ManagedRunnerService(prisma, ON, { available: true, profile, manager, worker: new ManagedRunnerWorker(manager, 60_000, quiet) });
    const name = managedPodName(mapping.runnerId);
    const pod = () => k.cluster.object<Pod>('pods', name);
    await db.runner.update({ where: { id: mapping.runnerId }, data: { version: `managed-${OLD_SHA}` } });
    const turn = await session(mapping, 'RUNNING', 'A long refactor');
    k.advance(30_000);
    await k.heartbeat(mapping.runnerId, { activeTurns: 1 });
    assert.equal(await manager.reconcile(mapping.id), 'READY', 'busy on a previous image, it is not rolled');
    // An old image's runner (managed-<sha>) against the release image: by commit, the current side with its version.
    const { running, current, phase } = (await service.status(ownerId)).update!;
    assert.deepEqual({ running, current, phase }, { running: { sha: OLD_SHA }, current: { sha: NEW_SHA, version: NEW_VERSION }, phase: 'available' });
    const recorded = await k.mappingOf(ownerId);
    assert.deepEqual({ sha: recorded.currentImageSha, version: recorded.currentImageVersion }, { sha: NEW_SHA, version: NEW_VERSION });
    // From here the kubelet does not report a deleted Pod stopped by itself: the runner drains in its grace, and the
    // test says when it has exited.
    k.cluster.kubeletReportsDeletions = false;
    // Every Pod event under the runner's name, in order: what was made, and what went, when.
    const events: Array<{ type: string; uid: string }> = [];
    const watch = k.cluster.client().pods.watch({}, (event) => {
      if (event.object.metadata.name === name) events.push({ type: event.type, uid: event.object.metadata.uid! });
    });
    return { k, profile, manager, service, ownerId, mapping, name, pod, turn, events, watch };
  }

  /** Reconcile until READY, heartbeating the next Pod as it starts. */
  async function kubernetesDrive(k: ReturnType<typeof managedRunnerWorld>, manager: ManagedRunnerManager, ownerId: string): Promise<ReconcileOutcome[]> {
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < 40 && outcomes.at(-1) !== 'READY' && outcomes.at(-1) !== 'FAILED'; i += 1) {
      outcomes.push(await manager.reconcile((await k.mappingOf(ownerId)).id));
      const after = await k.mappingOf(ownerId);
      if (after.podUid && after.managementState === 'STARTING') {
        k.advance(1_000);
        await k.heartbeat(after.runnerId);
      }
      if (after.nextAttemptAt && after.nextAttemptAt > k.now()) k.advance(after.nextAttemptAt.getTime() - k.now().getTime() + 1);
    }
    return outcomes;
  }

  await t.test('(6) on Kubernetes: a busy runner\'s Update Now with interruptTurns deletes the Pod with its grace, makes nothing until the kubelet reports it stopped, and restarts on the current image', async () => {
    const { k, profile, manager, service, ownerId, mapping, name, pod, turn, events, watch } = await kubernetesOutdated('k8s-update');
    t.after(() => watch.stop());
    assert.equal(typeof manager.backend.stopInstance, 'function', 'Kubernetes can stop an instance');
    const podUid = pod()!.metadata.uid!;
    const podsMade = k.cluster.count('create', 'pods');

    const answered = await service.updateNow(ownerId, true);
    assert.deepEqual(
      answered.update,
      { running: { sha: OLD_SHA }, current: { sha: NEW_SHA, version: NEW_VERSION }, phase: 'updating' },
      'updating, and not waiting for idle: Kubernetes can stop it',
    );
    const [activity] = await db.activity.findMany({ where: { actorId: ownerId, type: MANAGED_RUNNER_UPDATE_NOW_ACTIVITY } });
    assert.deepEqual(
      activity.payload,
      { mappingId: mapping.id, runnerId: mapping.runnerId, interruptTurns: true, waitsForIdle: false, running: OLD_SHA, current: NEW_SHA, sessionIds: [turn.id], backgroundJobs: 0 },
    );

    // The next pass deletes the Pod by its UID with the grace it was made with, and stays READY: asking proves nothing.
    const mark = k.cluster.calls.length;
    const since = () => k.cluster.calls.slice(mark);
    k.advance(1_000);
    await k.heartbeat(mapping.runnerId, { activeTurns: 1 });
    assert.equal(await manager.reconcile(mapping.id), 'READY');
    assert.deepEqual(
      since().filter((call) => call.op === 'delete'),
      [{ op: 'delete', kind: 'pods', name, gracePeriodSeconds: MANAGED_POD_TERMINATION_GRACE_SECONDS }],
      'stopInstance: the recorded Pod deleted with its grace, never a force delete',
    );
    assert.deepEqual({ uid: pod()!.metadata.uid, deleting: !!pod()!.metadata.deletionTimestamp }, { uid: podUid, deleting: true });
    const requested = await k.mappingOf(ownerId);
    assert.ok(requested.stopRequestedAt && requested.stopRequestedAt >= requested.updateRequestedAt!, 'the stop request is recorded');
    assert.equal(requested.stopAcknowledgedAt, null, 'and not acknowledged while the Pod runs');

    // Demand while the runner drains in its grace — a message queued for it, and the demand hook's write — changes
    // nothing, and no pass makes a Pod while the old one runs.
    const queued = await session(mapping, 'PENDING', 'a message sent meanwhile');
    await recordManagedDemand(prisma, mapping.runnerId, k.now());
    for (let pass = 0; pass < 3; pass += 1) {
      k.advance(5_000);
      await k.heartbeat(mapping.runnerId, { activeTurns: 1 });
      assert.equal(await manager.reconcile(mapping.id), 'READY', `pass ${pass} while it stops`);
      const update = (await service.status(ownerId)).update;
      assert.deepEqual({ phase: update?.phase, waits: update?.waitsForIdle }, { phase: 'updating', waits: undefined });
    }
    const stopping = await k.mappingOf(ownerId);
    assert.deepEqual(
      { state: stopping.managementState, generation: stopping.generation, podUid: stopping.podUid, attempt: stopping.attempt, interrupts: stopping.updateInterruptTurns, completed: stopping.updateCompletedAt },
      { state: 'READY', generation: mapping.generation, podUid, attempt: 0, interrupts: true, completed: null },
      'demand did not call it off, and nothing advanced',
    );
    assert.deepEqual([stopping.stopRequestedAt, stopping.stopAcknowledgedAt], [requested.stopRequestedAt, null], 'asked again, the first request stands');
    assert.ok(stopping.demandRevision > mapping.demandRevision, 'the demand was recorded');
    assert.equal(k.cluster.count('create', 'pods'), podsMade, 'no Pod is made before the kubelet reports the old one stopped');
    assert.equal(pod()!.metadata.uid, podUid, 'the one Pod is still the old one');
    assert.ok(since().filter((call) => call.op === 'delete').every((call) => call.gracePeriodSeconds === MANAGED_POD_TERMINATION_GRACE_SECONDS), 'asked again on each pass, always with the grace');

    // The runner's shutdown ends (SIGTERM's 143): the kubelet's report is the stop proof, and only once the old Pod is
    // gone is the next one made — from the profile's image, on the same claim and runner, with no attempt spent.
    k.cluster.stopPod(name, 143);
    const outcomes = await kubernetesDrive(k, manager, ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    assert.ok(!outcomes.includes('BACKOFF') && !outcomes.includes('FENCING'), outcomes.join(' → '));
    const awake = await k.mappingOf(ownerId);
    const proof = awake.fencingReceipt as { kind: string; predecessor: { podUid: string; generation: number } };
    assert.deepEqual([proof.kind, proof.predecessor.podUid, proof.predecessor.generation], ['OBSERVED_STOP', podUid, mapping.generation], 'the kubelet\'s report is the proof');
    const gone = events.findIndex((event) => event.type === 'DELETED' && event.uid === podUid);
    const made = events.findIndex((event) => event.type === 'ADDED' && event.uid === awake.podUid);
    assert.ok(gone >= 0 && made > gone, `the old Pod went before the next was made: ${JSON.stringify(events)}`);
    assert.equal(k.cluster.count('create', 'pods'), podsMade + 1, 'one Pod made, after the report');
    const next = pod()!;
    assert.equal(next.metadata.uid, awake.podUid);
    assert.deepEqual(
      podImages(next),
      [profile.runner.image, profile.runner.image],
      'the next Pod is made from the image the profile names now',
    );
    assert.deepEqual(
      (next.spec.volumes ?? []).flatMap((v) => (v.persistentVolumeClaim ? [v.persistentVolumeClaim.claimName] : [])),
      [mapping.pvcName],
      'on the same claim',
    );
    assert.deepEqual(
      { generation: awake.generation, runnerId: awake.runnerId, pvcName: awake.pvcName, pvcUid: awake.pvcUid, pvUid: awake.pvUid, attempt: awake.attempt, desired: awake.desiredState },
      { generation: mapping.generation + 1, runnerId: mapping.runnerId, pvcName: mapping.pvcName, pvcUid: mapping.pvcUid, pvUid: mapping.pvUid, attempt: 0, desired: 'RUNNING' },
      'the next generation, on the same volume and runner',
    );
    assert.equal(k.cluster.count('create', 'persistentvolumeclaims'), 1, 'the claim was never made again');
    assert.ok(awake.updateCompletedAt && awake.updateCompletedAt >= awake.updateRequestedAt!, 'the next generation READY ends the update');
    assert.equal(awake.stopRequestedAt?.getTime(), requested.stopRequestedAt!.getTime(), 'the next generation keeps the stop request');
    assert.ok(awake.stopAcknowledgedAt && awake.stopAcknowledgedAt >= awake.stopRequestedAt!, 'and the kubelet\'s report of the exit as its acknowledgement');
    // The sessions are the runner's to stop and resume: the server changed none of them.
    const sessions = await db.session.findMany({ where: { id: { in: [turn.id, queued.id] } }, select: { id: true, ...WORD_SELECT } });
    assert.deepEqual(Object.fromEntries(sessions.map((s) => [s.id, wordOf(s)])), { [turn.id]: 'RUNNING', [queued.id]: 'PENDING' });
  });

  await t.test('(6b) on Kubernetes: a request recorded before it could stop a Pod (waitsForIdle: true) is taken up by the stop on the next pass', async () => {
    const { k, manager, service, ownerId, mapping, name, pod, turn, watch } = await kubernetesOutdated('k8s-recorded');
    t.after(() => watch.stop());
    const podUid = pod()!.metadata.uid!;
    // What the earlier server wrote for a busy runner's interrupting request (the same columns), its activity saying
    // that it waits for idle. The manager reads the columns, never the activity.
    const before = await k.mappingOf(ownerId);
    const at = k.now();
    await db.managedRunner.update({
      where: { id: before.id },
      data: { updateRequestedAt: at, updateRequestedBy: ownerId, updateInterruptTurns: true, revision: { increment: 1 } },
    });
    await db.activity.create({
      data: {
        actorId: ownerId,
        type: MANAGED_RUNNER_UPDATE_NOW_ACTIVITY,
        payload: { mappingId: mapping.id, runnerId: mapping.runnerId, interruptTurns: true, waitsForIdle: true, running: OLD_SHA, current: NEW_SHA, sessionIds: [turn.id], backgroundJobs: 0 },
        credentialKind: 'LOGIN',
        createdAt: at,
      },
    });
    assert.equal((await service.status(ownerId)).update?.waitsForIdle, undefined, 'the status no longer says it waits');

    k.cluster.calls.length = 0;
    k.advance(1_000);
    await k.heartbeat(mapping.runnerId, { activeTurns: 1 });
    assert.equal(await manager.reconcile(mapping.id), 'READY');
    assert.deepEqual(
      k.cluster.calls.filter((call) => call.op === 'delete'),
      [{ op: 'delete', kind: 'pods', name, gracePeriodSeconds: MANAGED_POD_TERMINATION_GRACE_SECONDS }],
      'busy as it still is, the recorded request stops the Pod',
    );
    k.cluster.stopPod(name, 143);
    const outcomes = await kubernetesDrive(k, manager, ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const awake = await k.mappingOf(ownerId);
    assert.notEqual(awake.podUid, podUid);
    assert.deepEqual({ generation: awake.generation, pvcUid: awake.pvcUid, attempt: awake.attempt }, { generation: mapping.generation + 1, pvcUid: mapping.pvcUid, attempt: 0 });
    assert.ok(awake.updateCompletedAt && awake.updateCompletedAt >= at);
  });
});
