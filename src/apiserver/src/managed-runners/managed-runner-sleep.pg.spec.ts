/**
 * Idle sleep and wake (docs/managed-runner-design.md, "Provisioning retry wake and sleep" 5 to 8): the
 * manager against the in-memory Kubernetes namespace of `test-support/fake-kube-client.ts`, with the
 * single-Pod admission guard installed, over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates
 * from empty; the runner's side played by what its heartbeat route records and answers
 * (managed-runner-sleep.ts). The switch is on; no cluster, kubeconfig or credential is involved, and
 * the clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-sleep.pg.spec.ts
 *
 *   (1) nothing sleeps while there is work: a turn running or queued, a background job, an engine
 *       turn or subagent in the records; a turn, a job, an operation (a landing) or unflushed events
 *       in the instance's report; a report that is missing, stale, from another instance, or idle for
 *       less than the interval; a runner that cannot sleep. An owner's sleep of a busy runner is 409;
 *   (2) idle, it drains and sleeps: claims stop, the instance accepts, exits, and only the kubelet's
 *       report of that stop — with the Pod object released by UID and the volume detached — ends the
 *       generation and gives compute back. The runner row, its workspace, the PVC and the storage
 *       share stay; the old credential is dead;
 *   (3) demand wakes it on the same PVC and runner: the next generation's Secret, credential and Pod,
 *       the volume adopted by its recorded identity and never created again;
 *   (4) demand before the instance accepts calls the drain off: READY, claims open, and an
 *       acceptance arriving after is refused — so the runner never stops for an abandoned drain;
 *   (5) demand after it accepted is kept: the stop finishes, and the runner wakes at once to serve it;
 *       the queued turn is still there for the next instance;
 *   (6) an instance that does not accept within the drain budget, or reports work instead, keeps
 *       running: the drain is called off;
 *   (7) a draining instance whose Pod vanishes without the kubelet's report is fenced, as anywhere;
 *   (8) the sweep wakes a sleeping runner whose work no hook announced;
 *   (9) the owner's explicit sleep and wake;
 *  (10) a runner up with no runtime signed in waits for a login past its startup deadline, never
 *       FAILED; idle, it drains and sleeps like a READY runner, compute given back and the reason
 *       kept; demand before it accepts sends it back to waiting; a wake brings it up again, and once
 *       a runtime is signed in it is READY by itself, with no retry;
 *  (11) a runner an earlier version FAILED for want of a login is taken up again by itself: it waits
 *       on the same instance, and is READY once a runtime is signed in;
 *  (12) an owner's sleep drains only on a report the instance sent after the request: an idle report
 *       from before it (the walk's, sent just before a drive write began) keeps the runner READY, and
 *       so does a busy one after it; the first idle one after it drains.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { MANAGED_RUNNER_BUSY } from '@orbit/shared';
import type { ManagedRunner, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { IDLE, managedRunnerWorld, type ManagedRunnerWorld } from '../test-support/managed-runner-world';
import type { PersistentVolumeClaim, Pod, Secret } from './kube-client';
import { managedRunnerInstanceClaimable } from './managed-runner-instance';
import { bootstrapCredentialOf, managedPodName, managedSecretName } from './managed-runner-resources';
import { managedRunnerHeartbeat } from './managed-runner-sleep';
import { recordManagedDemand } from './managed-runner-work';
import { wordOf } from '../test-support/session-word';
import { turnStateOfWord } from '../sessions/session-turn-state';

const URL = process.env.COORDINATOR_PG_URL;

test('managed runner idle sleep and wake against a fake cluster', {
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

  /** A session of the runner, in `status`, as a turn queued or run there leaves one. */
  async function session(m: ManagedRunner, status: string, extra: Record<string, unknown> = {}): Promise<string> {
    const workspace = await db.workspace.create({ data: { ownerId: m.ownerId, runnerId: m.runnerId, targetRunnerId: m.runnerId, name: 'Project', workDir: '/tmp/project' } });
    const id = randomUUID();
    const columns: Record<string, unknown> = {
      id, owner_id: m.ownerId, creator_id: m.ownerId, workspace_id: workspace.id, assigned_runner_id: m.runnerId,
      title: 'managed work', prompt: 'work', provider: 'claude', status, num_turns: 1,
      runtime_session_id: randomUUID(), ...extra,
    };
    // The word as its facts (deploy D3): the turn state of a held word; the release beside a released one is set above.
    if ('status' in columns) {
      columns.turn_state = turnStateOfWord(String(columns.status));
      delete columns.status;
    }
    const names = Object.keys(columns);
    await sql.query(
      // started_at and updated_at by the database's clock: they are timestamps without a zone.
      `INSERT INTO "session" (${names.map((n) => `"${n}"`).join(', ')}, "started_at", "updated_at")
       VALUES (${names.map((n, i) => (n === 'status' ? `$${i + 1}::"run_status"` : `$${i + 1}`)).join(', ')}, now(), now())`,
      names.map((n) => columns[n]),
    );
    return id;
  }

  /** The idle interval passed, by the clock and by the instance's report. */
  async function idleLongEnough(w: ManagedRunnerWorld, m: ManagedRunner, workload: Partial<typeof IDLE> = {}, opts: { sleep?: boolean; receivedAgoMs?: number } = {}) {
    w.advance(w.profile.lifecycle.idleSeconds * 1000 + 1_000);
    if (opts.receivedAgoMs) w.advance(-opts.receivedAgoMs);
    await w.heartbeat(m.runnerId, { idleSeconds: w.profile.lifecycle.idleSeconds + 1, ...workload }, { sleep: opts.sleep });
    if (opts.receivedAgoMs) w.advance(opts.receivedAgoMs);
  }

  const instanceOf = (m: ManagedRunner) => ({ mappingId: m.id, generation: m.generation, podUid: m.podUid! });

  await t.test('(1) nothing sleeps while there is work, or while the instance cannot vouch for itself', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('busy');
    const stillReady = async (why: string) => {
      const outcome = await w.primary.reconcile(mapping.id);
      assert.equal(outcome, 'READY', `${why}: it does not drain`);
      assert.equal((await w.mappingOf(ownerId)).managementState, 'READY', why);
    };
    // In the records.
    for (const [why, status, extra] of [
      ['a turn running', 'RUNNING', {}],
      ['a turn queued', 'PENDING', {}],
      ['a background job of a parked session', 'AWAITING_INPUT', { running_bg_jobs: ['bgj_build'] }],
      ['an engine turn of its own', 'AWAITING_INPUT', { engine_turn_active: true }],
      ['a subagent', 'AWAITING_INPUT', { running_subagents: ['agent-1'] }],
      ['a merge asked for', 'AWAITING_INPUT', { merge_status: 'pending' }],
    ] as const) {
      const id = await session(mapping, status, extra);
      await idleLongEnough(w, mapping);
      await stillReady(why);
      await sql.query(`DELETE FROM "session" WHERE id = $1`, [id]);
    }
    const owner = await w.mappingOf(ownerId);
    await assert.rejects(
      () => (async () => {
        const id = await session(owner, 'RUNNING');
        try {
          await w.service.sleep(ownerId, 'sleep-while-running', owner.revision);
        } finally {
          await sql.query(`DELETE FROM "session" WHERE id = $1`, [id]);
        }
      })(),
      (error: { getResponse?: () => { code?: string } }) => error.getResponse?.().code === MANAGED_RUNNER_BUSY,
      'an owner cannot put a running runner to sleep',
    );
    // In the instance's own report.
    for (const [why, workload] of [
      ['a turn in flight', { activeTurns: 1 }],
      ['a background job (a watch, a build)', { backgroundJobs: 1 }],
      ['a landing or another heartbeat-delivered operation', { operations: 1 }],
      ['events not yet flushed', { unflushedEvents: 4 }],
      ['idle for less than the interval', { idleSeconds: 30 }],
    ] as const) {
      await idleLongEnough(w, mapping, workload);
      await stillReady(why);
    }
    // A report it cannot be trusted with.
    await idleLongEnough(w, mapping, {}, { sleep: false });
    await stillReady('a runner that does not report, and cannot sleep');
    await idleLongEnough(w, mapping, {}, { receivedAgoMs: (w.profile.lifecycle.heartbeatFreshSeconds + 30) * 1000 });
    await stillReady('a stale report');
    await idleLongEnough(w, mapping);
    await db.runner.update({
      where: { id: mapping.runnerId },
      data: { managedWorkload: { ...IDLE, idleSeconds: 99_999, generation: mapping.generation, podUid: randomUUID(), receivedAt: w.now().toISOString(), draining: false } },
    });
    await stillReady('a report from another Pod');
    // Then, with nothing left, it drains.
    await idleLongEnough(w, mapping);
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
  });

  await t.test('(2) idle: it drains, the instance accepts and exits, and only the kubelet\'s report of that stop puts it to sleep', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('sleeper');
    const workspace = await db.workspace.create({ data: { ownerId, runnerId: mapping.runnerId, name: 'Project', workDir: '/tmp/project' } });
    const credentialBefore = bootstrapCredentialOf(w.cluster.object<Secret>('secrets', managedSecretName(mapping.runnerId))!)!;
    const before = await w.ledger();

    await idleLongEnough(w, mapping);
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
    const draining = await w.mappingOf(ownerId);
    assert.equal(draining.desiredState, 'SLEEPING');
    assert.equal(draining.drainDemandRevision, draining.demandRevision);
    assert.ok(draining.stopRequestedAt);
    assert.equal(draining.stopAcknowledgedAt, null);
    // Claims stop at once.
    assert.equal(managedRunnerInstanceClaimable(draining, instanceOf(draining)), false, 'a draining instance is handed no turn');
    // Its heartbeat is told so, and asked to stop; an acceptance it sends while busy is not taken.
    const asked = await managedRunnerHeartbeat(prisma, instanceOf(draining), { ...IDLE }, w.now());
    assert.deepEqual(asked, { draining: true, sleep: { requestedAt: draining.stopRequestedAt!.toISOString() } });
    const busy = await managedRunnerHeartbeat(prisma, instanceOf(draining), { ...IDLE, operations: 1, sleepReady: draining.stopRequestedAt!.toISOString() }, w.now());
    assert.equal(busy.sleep?.confirmed, undefined, 'busy, its acceptance is not taken');
    // Another Pod's acceptance changes nothing.
    const stranger = await managedRunnerHeartbeat(prisma, { ...instanceOf(draining), podUid: randomUUID() }, { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() }, w.now());
    assert.equal(stranger.sleep, undefined);
    assert.equal((await w.mappingOf(ownerId)).stopAcknowledgedAt, null);
    // Idle, it is.
    const accepted = await managedRunnerHeartbeat(prisma, instanceOf(draining), { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() }, w.now());
    assert.deepEqual(accepted.sleep, { requestedAt: draining.stopRequestedAt!.toISOString(), confirmed: true });
    assert.ok((await w.mappingOf(ownerId)).stopAcknowledgedAt);

    // Until the kubelet reports the stop, nothing is released, whatever the time.
    w.advance((w.profile.lifecycle.drainSeconds + 60) * 1000);
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
    const overdue = await w.mappingOf(ownerId);
    assert.equal((overdue.lastError as { code: string }).code, 'SLEEP_STOP_OVERDUE', 'a late stop is said, never forced');
    assert.equal(w.cluster.count('delete', 'pods'), 0, 'and the Pod is not deleted under it');
    assert.equal(overdue.generation, 1);
    assert.deepEqual(await w.ledger(), before, 'compute is held until the stop is proven');

    // It exits: the kubelet reports every container stopped. The proof is recorded, the Pod object
    // released by UID, and once the volume detaches the generation ends and compute is given back.
    w.cluster.stopPod(managedPodName(mapping.runnerId));
    const outcomes = [];
    for (let i = 0; i < 6 && outcomes.at(-1) !== 'SLEEPING'; i += 1) outcomes.push(await w.primary.reconcile(mapping.id));
    assert.equal(outcomes.at(-1), 'SLEEPING', outcomes.join(' → '));
    const asleep = await w.mappingOf(ownerId);
    assert.equal(asleep.generation, 2, 'the stopped generation is retired');
    assert.equal(asleep.podUid, null);
    assert.equal(asleep.stopRequestedAt, null);
    assert.equal(asleep.stopAcknowledgedAt, null);
    assert.equal((asleep.fencingReceipt as { kind: string; retiredAt?: string }).kind, 'OBSERVED_STOP');
    assert.ok((asleep.fencingReceipt as { retiredAt?: string }).retiredAt);
    assert.deepEqual(w.cluster.calls.filter((c) => c.op === 'delete').map((c) => `${c.kind}/${c.name}`), [`pods/${managedPodName(mapping.runnerId)}`], 'only the stopped Pod was deleted');
    assert.equal(w.cluster.all('pods').length, 0);
    assert.equal(w.cluster.all('persistentvolumeclaims').length, 1, 'the PVC stays');
    assert.equal(w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', asleep.pvcName)!.metadata.uid, mapping.pvcUid);
    assert.ok(await db.runner.findUnique({ where: { id: mapping.runnerId } }), 'the runner row stays');
    assert.ok(await db.workspace.findFirst({ where: { id: workspace.id, deletedAt: null } }), 'its workspace stays');
    assert.notEqual((await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } })).tokenHash, sha256(credentialBefore), 'the old credential is dead');
    const reservation = asleep.reservation as { storage: unknown; compute: unknown };
    assert.ok(reservation.storage);
    assert.equal(reservation.compute, null);
    const after = await w.ledger();
    assert.deepEqual(after.pool, after.shares);
    assert.equal(after.pool.users, before.pool.users - 1);
    assert.equal(after.pool.durable, before.pool.durable, 'storage stays reserved');
    const status = await w.service.status(ownerId);
    assert.equal(status.managementState, 'SLEEPING');
    assert.equal(status.actions.canWake, true);
  });

  await t.test('(3) demand wakes it on the same volume and runner, as the next generation', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('waker');
    const asleep = await w.putToSleep(ownerId);
    const recorded = await recordManagedDemand(prisma, mapping.runnerId, w.now());
    assert.equal(recorded?.desiredState, 'RUNNING');
    assert.equal(recorded?.demandRevision, asleep.demandRevision + 1);
    const outcomes = await w.drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const awake = await w.mappingOf(ownerId);
    assert.equal(awake.runnerId, mapping.runnerId, 'the same runner');
    assert.equal(awake.defaultWorkspaceId, mapping.defaultWorkspaceId);
    assert.equal(awake.pvcUid, mapping.pvcUid, 'the same PVC');
    assert.equal(awake.volumeHandle, mapping.volumeHandle, 'the same volume');
    assert.equal(awake.generation, 2);
    assert.equal(w.cluster.count('create', 'persistentvolumeclaims'), 1, 'the volume was never created again');
    const pod = w.cluster.object<Pod>('pods', managedPodName(mapping.runnerId))!;
    assert.equal(pod.metadata.annotations?.['orbit.dev/generation'], '2');
    assert.equal(pod.metadata.annotations?.['orbit.dev/pvc-uid'], mapping.pvcUid);
    assert.deepEqual(pod.spec.volumes?.flatMap((v) => (v.persistentVolumeClaim ? [v.persistentVolumeClaim.claimName] : [])), [mapping.pvcName]);
    const secret = w.cluster.object<Secret>('secrets', managedSecretName(mapping.runnerId))!;
    assert.equal(secret.metadata.annotations?.['orbit.dev/generation'], '2', 'the retired Secret was replaced');
    assert.equal((await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } })).tokenHash, sha256(bootstrapCredentialOf(secret)!));
    const ledger = await w.ledger();
    assert.deepEqual(ledger.pool, ledger.shares);
  });

  await t.test('(4) demand before the instance accepts calls the drain off; an acceptance after it is refused', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('called-off');
    await idleLongEnough(w, mapping);
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
    const draining = await w.mappingOf(ownerId);
    await recordManagedDemand(prisma, mapping.runnerId, w.now());
    // The acceptance races the demand and loses: the drain it names has demand past it.
    const late = await managedRunnerHeartbeat(prisma, instanceOf(draining), { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() }, w.now());
    assert.equal(late.sleep?.confirmed, undefined, 'no confirmation: the runner keeps running');
    assert.equal(await w.primary.reconcile(mapping.id), 'READY');
    const back = await w.mappingOf(ownerId);
    assert.equal(back.desiredState, 'RUNNING');
    assert.equal(back.stopRequestedAt, null);
    assert.equal(back.generation, 1, 'nothing stopped');
    assert.equal(managedRunnerInstanceClaimable(back, instanceOf(back)), true, 'claims are open again');
    const heartbeat = await managedRunnerHeartbeat(prisma, instanceOf(back), { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() }, w.now());
    assert.deepEqual(heartbeat, { draining: false }, 'nothing is asked of it any more');
    assert.equal(w.cluster.count('delete', 'pods'), 0);
  });

  await t.test('(5) demand after it accepted is kept: the stop finishes and the runner wakes at once to serve it', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('kept');
    await idleLongEnough(w, mapping);
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
    const draining = await w.mappingOf(ownerId);
    const accepted = await managedRunnerHeartbeat(prisma, instanceOf(draining), { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() }, w.now());
    assert.equal(accepted.sleep?.confirmed, true);
    // A message arrives during the drain: its turn is queued and its demand recorded.
    const queued = await session(draining, 'PENDING');
    await recordManagedDemand(prisma, mapping.runnerId, w.now());
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING', 'an accepted drain is not called off');
    w.cluster.stopPod(managedPodName(mapping.runnerId));
    const outcomes = await w.drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', `it stopped and started again for the demand: ${outcomes.join(' → ')}`);
    const awake = await w.mappingOf(ownerId);
    assert.equal(awake.generation, 2, 'a new generation serves it');
    assert.equal(awake.pvcUid, mapping.pvcUid);
    const turn = await db.session.findUniqueOrThrow({ where: { id: queued } });
    assert.equal(wordOf(turn), 'PENDING', 'the turn that arrived during the drain is still queued for the new instance');
    assert.equal(managedRunnerInstanceClaimable(awake, instanceOf(awake)), true);
  });

  await t.test('(6) an instance that does not accept in time, or reports work, keeps running: the drain is called off', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('declines');
    await idleLongEnough(w, mapping);
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
    // It reports work instead of accepting.
    await w.heartbeat(mapping.runnerId, { activeTurns: 1 });
    assert.equal(await w.primary.reconcile(mapping.id), 'READY');
    assert.equal((await w.mappingOf(ownerId)).managementState, 'READY');

    // Silent past the drain budget.
    await idleLongEnough(w, mapping);
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
    w.advance((w.profile.lifecycle.drainSeconds + 1) * 1000);
    await w.heartbeat(mapping.runnerId, { idleSeconds: 10_000 });
    assert.equal(await w.primary.reconcile(mapping.id), 'READY');
    const back = await w.mappingOf(ownerId);
    assert.equal(back.generation, 1);
    assert.equal(w.cluster.count('delete', 'pods'), 0);
  });

  await t.test('(7) a draining instance whose Pod vanishes without the kubelet\'s report is fenced', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('vanishes');
    await idleLongEnough(w, mapping);
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
    w.cluster.remove('pods', managedPodName(mapping.runnerId));
    assert.equal(await w.primary.reconcile(mapping.id), 'FENCING');
    const fenced = await w.mappingOf(ownerId);
    assert.equal((fenced.lastError as { code: string }).code, 'PREDECESSOR_STOP_UNPROVEN');
    assert.equal(fenced.generation, 1, 'no new generation');
    assert.ok(((fenced.reservation as { compute: unknown }).compute), 'compute stays reserved while the predecessor is unproven');
  });

  await t.test('(8) the sweep wakes a sleeping runner whose work no hook announced', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('swept');
    const asleep = await w.putToSleep(ownerId);
    assert.equal(await w.primary.sweepDemand(), 0, 'nothing waiting: nothing woken');
    await session(asleep, 'PENDING');
    assert.equal(await w.primary.sweepDemand(), 1);
    const woken = await w.mappingOf(ownerId);
    assert.equal(woken.desiredState, 'RUNNING');
    assert.ok((await w.primary.dueMappings(50)).includes(mapping.id));
    assert.equal((await w.drive(ownerId)).at(-1), 'READY');
  });

  await t.test('(9) the owner\'s explicit sleep and wake', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('owner');
    const asked = await w.service.sleep(ownerId, 'sleep-1', (await w.mappingOf(ownerId)).revision);
    assert.equal(asked.desiredState, 'SLEEPING');
    assert.equal(asked.actions.canSleep, false);
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId, { idleSeconds: 5 });
    // Asked, it drains without waiting out the idle interval — but only with nothing in flight.
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
    const draining = await w.mappingOf(ownerId);
    await managedRunnerHeartbeat(prisma, instanceOf(draining), { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() }, w.now());
    w.cluster.stopPod(managedPodName(mapping.runnerId));
    for (let i = 0; i < 6 && (await w.mappingOf(ownerId)).managementState !== 'SLEEPING'; i += 1) await w.primary.reconcile(mapping.id);
    assert.equal((await w.mappingOf(ownerId)).managementState, 'SLEEPING');
    const woken = await w.service.wake(ownerId, 'wake-1');
    assert.equal(woken.desiredState, 'RUNNING');
    assert.equal((await w.service.wake(ownerId, 'wake-1')).revision, woken.revision, 'the same request again is answered as it was');
    assert.equal((await w.drive(ownerId)).at(-1), 'READY');
  });

  const SIGNED_OUT = [{ engine: 'claude', installed: true, auth: 'no' }];
  const SIGNED_IN = [{ engine: 'claude', installed: true, auth: 'yes' }];

  /** A new owner's runner brought up with no runtime signed in: STARTING, waiting for a login. */
  async function waitingForLogin(w: ManagedRunnerWorld, label: string): Promise<{ ownerId: string; mapping: ManagedRunner }> {
    w.runnerSide.engines = SIGNED_OUT;
    const ownerId = await w.makeUser(label);
    await w.service.ensure(ownerId, `ensure-${label}`);
    await upToLoginWait(w, ownerId);
    return { ownerId, mapping: await w.mappingOf(ownerId) };
  }

  /** Reconcile, heartbeating signed out once an instance runs, until the mapping waits for a login. */
  async function upToLoginWait(w: ManagedRunnerWorld, ownerId: string): Promise<void> {
    const seen: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const m = await w.mappingOf(ownerId);
      if (m.managementState === 'STARTING' && (m.lastError as { code?: string } | null)?.code === 'MODEL_UNAVAILABLE') return;
      if (m.podUid && m.managementState === 'STARTING') {
        w.advance(1_000);
        await w.heartbeat(m.runnerId);
      }
      if (m.nextAttemptAt && m.nextAttemptAt > w.now()) w.clock.ms = m.nextAttemptAt.getTime() + 1;
      seen.push(await w.primary.reconcile(m.id));
    }
    assert.fail(`never waited for a login: ${seen.join(' → ')}`);
  }

  await t.test('(10) no runtime signed in: it waits past the startup deadline, sleeps when idle, wakes, and is READY once one is signed in', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await waitingForLogin(w, 'nologin');
    const podUid = mapping.podUid;
    assert.ok(podUid);

    // Past the startup deadline, still heartbeating: waiting, not FAILED; the deadline is moved on.
    w.advance(w.profile.lifecycle.startupDeadlineSeconds * 1000 + 1_000);
    await w.heartbeat(mapping.runnerId, { idleSeconds: 5 });
    assert.equal(await w.primary.reconcile(mapping.id), 'WAITING');
    const waiting = await w.mappingOf(ownerId);
    assert.equal(waiting.managementState, 'STARTING');
    assert.equal((waiting.lastError as { code: string }).code, 'MODEL_UNAVAILABLE');
    assert.ok(waiting.startupDeadlineAt! > w.now(), 'a deadline still stands for an instance that stops reporting');
    assert.equal(await w.primary.reconcile(mapping.id), 'WAITING');
    assert.equal((await w.mappingOf(ownerId)).revision, waiting.revision, 'nothing rewritten while it waits');
    const status = await w.service.status(ownerId);
    assert.equal(status.reason?.code, 'MODEL_UNAVAILABLE');
    assert.doesNotMatch(status.reason!.message, /retried/);
    assert.equal(status.actions.canRetry, false);

    // Idle the profile's interval: it drains, the reason kept. Demand before it accepts calls that off.
    w.advance(w.profile.lifecycle.idleSeconds * 1000);
    await w.heartbeat(mapping.runnerId, { idleSeconds: w.profile.lifecycle.idleSeconds + 1 });
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
    let draining = await w.mappingOf(ownerId);
    assert.equal((draining.lastError as { code: string }).code, 'MODEL_UNAVAILABLE');
    await recordManagedDemand(prisma, mapping.runnerId, w.now());
    await w.primary.reconcile(mapping.id);
    const back = await w.mappingOf(ownerId);
    assert.equal(back.managementState, 'STARTING', 'called off, it waits for a login again — never READY without one');
    assert.equal((back.lastError as { code: string }).code, 'MODEL_UNAVAILABLE');
    assert.equal(back.podUid, podUid);

    // Idle again: drains, accepts, exits; asleep, compute back in the pool, the reason still said.
    w.advance(w.profile.lifecycle.idleSeconds * 1000 + 1_000);
    await w.heartbeat(mapping.runnerId, { idleSeconds: w.profile.lifecycle.idleSeconds + 1 });
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
    draining = await w.mappingOf(ownerId);
    const answer = await managedRunnerHeartbeat(prisma, instanceOf(draining), { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() }, w.now());
    assert.equal(answer.sleep?.confirmed, true);
    w.cluster.stopPod(managedPodName(mapping.runnerId));
    for (let i = 0; i < 6 && (await w.mappingOf(ownerId)).managementState !== 'SLEEPING'; i += 1) await w.primary.reconcile(mapping.id);
    const asleep = await w.mappingOf(ownerId);
    assert.equal(asleep.managementState, 'SLEEPING');
    assert.equal((asleep.reservation as { compute: unknown }).compute, null, 'compute given back');
    const ledger = await w.ledger();
    assert.deepEqual(ledger.pool, ledger.shares);
    assert.equal(ledger.pool.pods, 0);
    const sleepingStatus = await w.service.status(ownerId);
    assert.equal(sleepingStatus.reason?.code, 'MODEL_UNAVAILABLE', 'asleep, it still says what it needs');
    assert.equal(sleepingStatus.actions.canWake, true);

    // A wake (opening Machines & models to sign in) brings it up again, still waiting for a login.
    await w.service.wake(ownerId, 'wake-to-sign-in');
    await upToLoginWait(w, ownerId);
    const woken = await w.mappingOf(ownerId);
    assert.equal(woken.generation, asleep.generation);
    assert.notEqual(woken.podUid, podUid);

    // A runtime signed in: READY at the next pass, with no retry.
    w.runnerSide.engines = SIGNED_IN;
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await w.primary.reconcile(mapping.id), 'READY');
    const ready = await w.mappingOf(ownerId);
    assert.equal(ready.initialProvider, 'claude');
    assert.equal(ready.lastError, null);
  });

  await t.test('(11) a runner FAILED for want of a login by an earlier version waits for one again, by itself', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await waitingForLogin(w, 'oldfail');
    // As the previous version left it once the startup deadline had passed.
    await db.managedRunner.update({
      where: { id: mapping.id },
      data: {
        managementState: 'FAILED',
        lastError: { code: 'MODEL_UNAVAILABLE', message: 'old words', retryable: true, detail: 'no runtime signed in' },
        revision: { increment: 1 },
      },
    });
    assert.ok((await w.primary.dueMappings(50)).includes(mapping.id), 'the manager picks it up');
    await upToLoginWait(w, ownerId);
    const waiting = await w.mappingOf(ownerId);
    assert.equal(waiting.podUid, mapping.podUid, 'the same instance, waited on again');
    w.runnerSide.engines = SIGNED_IN;
    w.advance(1_000);
    await w.heartbeat(mapping.runnerId);
    assert.equal(await w.primary.reconcile(mapping.id), 'READY');
  });

  await t.test('(12) an owner\'s sleep drains only on a report sent after the request; a busy one keeps it READY', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping } = await w.readyRunner('fresh-report');
    // Idle by its last report, which is fresh — and then a write begins, which the next report will say.
    await w.heartbeat(mapping.runnerId, { idleSeconds: 5 });
    w.advance(1_000);
    await w.service.sleep(ownerId, 'sleep-fresh', (await w.mappingOf(ownerId)).revision);
    const state = async () => {
      const m = await w.mappingOf(ownerId);
      return { state: m.managementState, desired: m.desiredState, stopRequestedAt: m.stopRequestedAt };
    };
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await w.primary.reconcile(mapping.id), 'READY', 'a report from before the request is no answer to it');
      w.advance(1_000);
    }
    assert.deepEqual(await state(), { state: 'READY', desired: 'SLEEPING', stopRequestedAt: null });
    // The next report: a drive write holds bytes no commit has taken.
    await w.heartbeat(mapping.runnerId, { driveWrites: 1 });
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await w.primary.reconcile(mapping.id), 'READY', 'busy: never DRAINING');
      w.advance(1_000);
    }
    assert.deepEqual(await state(), { state: 'READY', desired: 'SLEEPING', stopRequestedAt: null });
    // Idle again, in a report after the request: now it drains.
    await w.heartbeat(mapping.runnerId, { idleSeconds: 1 });
    assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
    assert.equal((await state()).state, 'DRAINING');
  });
});
