/**
 * Disabled accounts (docs/managed-runner-design.md, "Implementation record: disabled accounts"): the
 * managed runner of an owner an administrator disabled (`User.disabledAt`), whose runner credential
 * every door refuses, is put to sleep and kept there. The manager against the in-memory Kubernetes
 * namespace of `test-support/fake-kube-client.ts`, with the single-Pod admission guard installed, over
 * a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty. The switch is on; the clock is
 * the test's; no cluster, kubeconfig or credential is involved.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-account-disabled.pg.spec.ts
 *
 *   (1) nothing is provisioned for a disabled owner: a mapping asked for before the account was
 *       disabled — just recorded, waiting for capacity, its volume created, or starting with no Pod —
 *       never goes on: no PVC, Secret or Pod is created and no admission dry run made; it sleeps, the
 *       compute it held given back, and its status says ACCOUNT_DISABLED. A release in the pool is
 *       not offered to it;
 *   (2) a Pod create whose answer was lost keeps its compute share and is not tried again; the Pod it
 *       committed late is found, recorded and drained like any instance;
 *   (3) a running instance drains to sleep at once — work in the records and no idle report do not
 *       hold it — and the drain is never called off. Compute stays reserved while the instance runs,
 *       once only its stop is reported, and while its volume is attached; the kubelet's report is
 *       recorded as the proof, the Pod is deleted by UID, and only then is the generation retired and
 *       compute given back. The PVC, the runner row and the default workspace stay; the old
 *       credential is dead. An instance that already stopped on its own sleeps the same way (an
 *       enabled owner's would be FAILED); one gone without the kubelet's report fences, compute kept;
 *   (4) nothing wakes it while the account is disabled: demand — the hook every session path calls —
 *       records nothing, the sweep passes over its queued work, a wake desired before the account was
 *       disabled is dropped, and ensure, retry, wake, sleep and delete are 403 ACCOUNT_DISABLED with
 *       nothing written. A disabled account without a mapping is given none, at sign-in or on ensure;
 *   (5) enabled again, the sweep finds the work that waited and the runner wakes, in its next
 *       generation, on the same PVC, runner row and workspace.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ACCOUNT_DISABLED } from '@orbit/shared';
import type { ManagedRunner, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { managedRunnerWorld, quiet, type ManagedRunnerWorld } from '../test-support/managed-runner-world';
import type { FakeKubeCall } from '../test-support/fake-kube-client';
import type { ManagedKubeClient, PersistentVolumeClaim, Pod } from './kube-client';
import { computeShare, storageShare } from './managed-runner-capacity';
import { ManagedRunnerDemandService, NOT_MANAGED } from './managed-runner-demand';
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import { buildManagedPod, managedPodName, managedSecretName } from './managed-runner-resources';
import { recordManagedDemand, sleepingRunnersWithDemand } from './managed-runner-work';

const URL = process.env.COORDINATOR_PG_URL;
const ON = { enabled: true, problem: null } as const;
const NO_ACTIONS = { canEnsure: false, canWake: false, canSleep: false, canRetry: false, canDelete: false };

test('a disabled account\'s managed runner is put to sleep and kept there, against a fake cluster', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const disable = (ownerId: string) => sql.query(`UPDATE "user" SET disabled_at = now() WHERE id = $1`, [ownerId]);
  const enable = (ownerId: string) => sql.query(`UPDATE "user" SET disabled_at = NULL WHERE id = $1`, [ownerId]);
  /** The mapping row exactly as stored, to tell that nothing at all was written to it. */
  const rowOf = async (ownerId: string): Promise<string> =>
    (await sql.query(`SELECT row_to_json(m)::text AS row FROM managed_runner m WHERE owner_id = $1`, [ownerId])).rows[0].row as string;
  /** What was asked of the cluster to make something since `mark`: creates, and admission dry runs. */
  const madeSince = (w: ManagedRunnerWorld, mark: number): FakeKubeCall[] =>
    w.cluster.calls.slice(mark).filter((call) => call.op === 'create' || call.op === 'dryRunCreate');
  const computeOf = (m: ManagedRunner) => (m.reservation as { compute?: unknown } | null)?.compute ?? null;
  const storageOf = (m: ManagedRunner) => (m.reservation as { storage?: unknown } | null)?.storage ?? null;

  /** A session of the runner, in `status`, as a turn queued or run there leaves one. */
  async function session(m: ManagedRunner, status: string): Promise<string> {
    const id = randomUUID();
    const columns: Record<string, unknown> = {
      id, owner_id: m.ownerId, creator_id: m.ownerId, workspace_id: m.defaultWorkspaceId, assigned_runner_id: m.runnerId,
      title: 'managed work', prompt: 'work', provider: 'claude', status, num_turns: 1, runtime_session_id: randomUUID(),
    };
    const names = Object.keys(columns);
    await sql.query(
      // started_at and updated_at by the database's clock: they are timestamps without a zone.
      `INSERT INTO "session" (${names.map((n) => `"${n}"`).join(', ')}, "started_at", "updated_at")
       VALUES (${names.map((n, i) => (n === 'status' ? `$${i + 1}::"run_status"` : `$${i + 1}`)).join(', ')}, now(), now())`,
      names.map((n) => columns[n]),
    );
    return id;
  }

  /** The status the owner reads: the account is the reason, and nothing is offered. */
  async function assertSaysDisabled(w: ManagedRunnerWorld, ownerId: string, state: string) {
    const status = await w.service.status(ownerId);
    assert.equal(status.managementState, state);
    assert.equal(status.reason?.code, ACCOUNT_DISABLED, `${state}: the status says why`);
    assert.equal(status.reason?.retryable, false);
    assert.equal(status.usable, false);
    assert.deepEqual(status.actions, NO_ACTIONS);
  }

  /** A pass over every due mapping, as the worker makes one. */
  async function workerPass(w: ManagedRunnerWorld) {
    for (const id of await w.primary.dueMappings(50)) await w.primary.reconcile(id);
  }

  await t.test('(1) nothing is provisioned for a disabled owner: recorded, waiting, volume created or starting, each sleeps and gives back its compute', async () => {
    // A budget of one active user: the first owner's READY runner takes it.
    const w = managedRunnerWorld(db, { capacity: { maxActiveUsers: 1 } });
    const holder = await w.readyRunner('holder');
    const requestedOwner = await w.makeUser('requested');
    await w.service.ensure(requestedOwner, 'ensure-requested');
    const waitingOwner = await w.makeUser('waiting');
    await w.service.ensure(waitingOwner, 'ensure-waiting');
    assert.equal(await w.primary.reconcile((await w.mappingOf(waitingOwner)).id), 'WAITING_CAPACITY');
    assert.equal((await w.mappingOf(requestedOwner)).managementState, 'REQUESTED');

    await disable(requestedOwner);
    await disable(waitingOwner);
    // The holder's runner sleeps: its release moves the pool, which a waiter would be offered at once.
    await w.putToSleep(holder.ownerId);
    const mark = w.cluster.calls.length;
    await workerPass(w);
    await workerPass(w);
    for (const [ownerId, was] of [[requestedOwner, 'REQUESTED'], [waitingOwner, 'WAITING_CAPACITY']] as const) {
      const m = await w.mappingOf(ownerId);
      assert.equal(m.managementState, 'SLEEPING', `${was}: asleep`);
      assert.equal(m.desiredState, 'SLEEPING', `${was}: and no longer wanted running`);
      assert.equal(m.pvcUid, null, `${was}: no volume`);
      assert.equal(m.reservation, null, `${was}: nothing reserved, the release was not offered to it`);
      assert.equal(m.lastError, null, `${was}: the capacity wait is over`);
      assert.equal(w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', m.pvcName), undefined, `${was}: no PVC`);
      await assertSaysDisabled(w, ownerId, 'SLEEPING');
    }
    assert.deepEqual(madeSince(w, mark), [], 'nothing was created or dry-run for either');
    const { pool, shares } = await w.ledger();
    assert.deepEqual(pool, shares);
    assert.equal(pool.users, 0, 'the slot the holder gave back is still free');

    // A volume created, the claim not bound yet: PROVISIONING, compute and storage reserved.
    const v = managedRunnerWorld(db);
    v.cluster.autoBind = false;
    const provisioningOwner = await v.makeUser('provisioning');
    await v.service.ensure(provisioningOwner, 'ensure-provisioning');
    assert.equal(await v.primary.reconcile((await v.mappingOf(provisioningOwner)).id), 'WAITING');
    const provisioning = await v.mappingOf(provisioningOwner);
    assert.equal(provisioning.managementState, 'PROVISIONING');
    assert.ok(provisioning.pvcUid && computeOf(provisioning) && storageOf(provisioning));
    v.cluster.autoBind = true;
    // Starting, its Pod not created yet: the step that would look for it backed off.
    const startingOwner = await v.makeUser('starting');
    await v.service.ensure(startingOwner, 'ensure-starting');
    v.cluster.inject({ op: 'get', kind: 'pods', mode: 'timeout' });
    assert.equal(await v.primary.reconcile((await v.mappingOf(startingOwner)).id), 'BACKOFF');
    const starting = await v.mappingOf(startingOwner);
    assert.equal(starting.managementState, 'STARTING');
    assert.equal(starting.podUid, null);
    assert.ok(starting.nextAttemptAt && starting.nextAttemptAt > v.now(), 'waiting for its retry time');
    assert.ok(computeOf(starting));

    await disable(provisioningOwner);
    await disable(startingOwner);
    const before = await v.ledger();
    const vMark = v.cluster.calls.length;
    // Before its retry time: a disabled owner's mapping is visited at once.
    assert.ok((await v.primary.dueMappings(50)).includes(starting.id));
    assert.equal(await v.primary.reconcile(provisioning.id), 'SLEEPING');
    assert.equal(await v.primary.reconcile(starting.id), 'SLEEPING');
    for (const [m0, was] of [[provisioning, 'PROVISIONING'], [starting, 'STARTING']] as const) {
      const m = await v.mappingOf(m0.ownerId);
      assert.equal(m.managementState, 'SLEEPING', was);
      assert.equal(m.desiredState, 'SLEEPING', was);
      assert.equal(m.podUid, null, `${was}: no Pod`);
      assert.equal(m.generation, m0.generation, `${was}: no instance ran, so no generation was retired`);
      assert.equal(computeOf(m), null, `${was}: compute given back`);
      assert.deepEqual(storageOf(m), storageOf(m0), `${was}: storage kept`);
      assert.equal(v.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', m.pvcName)?.metadata.uid, m0.pvcUid, `${was}: its PVC kept`);
      assert.equal(v.cluster.object<Pod>('pods', managedPodName(m.runnerId)), undefined, `${was}: no Pod`);
      await assertSaysDisabled(v, m.ownerId, 'SLEEPING');
    }
    assert.equal(v.cluster.object('secrets', managedSecretName(provisioning.runnerId)), undefined, 'no bootstrap Secret was issued to the PROVISIONING one');
    assert.deepEqual(madeSince(v, vMark), [], 'nothing was created or dry-run');
    const after = await v.ledger();
    assert.deepEqual(after.pool, after.shares);
    assert.equal(before.pool.cpu - after.pool.cpu, 2 * computeShare(v.profile).cpuMillis, 'both compute shares went back to the pool');
    assert.equal(after.pool.durable, before.pool.durable, 'and both storage shares stayed');

    // More passes, past every retry time and deadline: still asleep, still nothing made.
    v.advance(v.profile.lifecycle.startupDeadlineSeconds * 1000 + 1_000);
    await workerPass(v);
    assert.ok(!(await v.primary.dueMappings(50)).includes(provisioning.id), 'asleep and not wanted running: not visited');
    assert.equal((await v.mappingOf(startingOwner)).managementState, 'SLEEPING');
    assert.deepEqual(madeSince(v, vMark), []);
  });

  await t.test('(2) a Pod create whose answer was lost keeps its compute and is not tried again; the Pod it made late is drained', async () => {
    const w = managedRunnerWorld(db);
    const ownerId = await w.makeUser('lost-create');
    await w.service.ensure(ownerId, 'ensure-lost-create');
    w.cluster.inject({ op: 'create', kind: 'pods', mode: 'timeout' });
    assert.equal(await w.primary.reconcile((await w.mappingOf(ownerId)).id), 'BACKOFF');
    const pending = await w.mappingOf(ownerId);
    assert.equal(pending.managementState, 'STARTING');
    assert.equal(pending.resourceOperationKind, 'CREATE_POD');
    assert.equal(pending.resourceOperationState, 'PENDING', 'the create may still commit');

    await disable(ownerId);
    const mark = w.cluster.calls.length;
    assert.equal(await w.primary.reconcile(pending.id), 'WAITING');
    const held = await w.mappingOf(ownerId);
    assert.equal(held.managementState, 'STARTING', 'not put to sleep while a Pod may yet exist');
    assert.ok(computeOf(held), 'its compute share is kept');
    assert.deepEqual(madeSince(w, mark), [], 'and no create is tried again');
    await assertSaysDisabled(w, ownerId, 'STARTING');

    // The create committed after all: the Pod is found under its name, recorded and drained.
    const late = w.cluster.plant<Pod>('pods', buildManagedPod(
      { ownerId, runnerId: held.runnerId, generation: held.generation, namespace: held.namespace }, held.pvcUid!, w.profile,
    ));
    assert.equal(await w.primary.reconcile(held.id), 'DRAINING');
    const draining = await w.mappingOf(ownerId);
    assert.equal(draining.podUid, late.metadata.uid, 'the late Pod is the recorded instance');
    assert.equal(draining.desiredState, 'SLEEPING');
    assert.ok(computeOf(draining), 'compute still reserved while it may run');
    w.cluster.stopPod(managedPodName(held.runnerId));
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < 4 && outcomes.at(-1) !== 'SLEEPING'; i += 1) outcomes.push(await w.primary.reconcile(held.id));
    assert.equal(outcomes.at(-1), 'SLEEPING', outcomes.join(' → '));
    const asleep = await w.mappingOf(ownerId);
    assert.equal(computeOf(asleep), null, 'given back after the stop proof');
    assert.equal(asleep.generation, held.generation + 1);
    assert.deepEqual(madeSince(w, mark), [], 'nothing was created at any point');
    const { pool, shares } = await w.ledger();
    assert.deepEqual(pool, shares);
  });

  await t.test('(3) a running instance drains to sleep at once and is never called off; compute goes back only after the stop proof', async () => {
    const w = managedRunnerWorld(db);
    // The Pod deletes this replica sends, with their preconditions.
    const deletes: Array<{ name: string; uid?: string }> = [];
    const client = w.cluster.client();
    const recording: ManagedKubeClient = {
      ...client,
      pods: {
        ...client.pods,
        delete: async (name, options) => {
          deletes.push({ name, uid: options?.uid });
          return client.pods.delete(name, options);
        },
      },
    };
    const manager = new ManagedRunnerManager(w.prisma, recording, w.profile, { holder: 'disabled-replica', now: w.now, random: () => 0.5, log: quiet });
    const { ownerId, mapping: ready } = await w.readyRunner('running');
    const runnerBefore = await db.runner.findUniqueOrThrow({ where: { id: ready.runnerId } });
    const podName = managedPodName(ready.runnerId);
    const pvcBefore = w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', ready.pvcName)!;
    // A turn running on it, and no idle report: an enabled owner's runner would never drain now.
    await session(ready, 'RUNNING');
    assert.equal(await manager.reconcile(ready.id), 'READY', 'enabled, it keeps running');

    await disable(ownerId);
    const mark = w.cluster.calls.length;
    const reserved = (await w.ledger()).pool;
    assert.equal(await manager.reconcile(ready.id), 'DRAINING', 'disabled, it drains at once');
    const draining = await w.mappingOf(ownerId);
    assert.equal(draining.desiredState, 'SLEEPING');
    assert.ok(draining.stopRequestedAt);
    assert.equal(draining.stopAcknowledgedAt, null);
    await assertSaysDisabled(w, ownerId, 'DRAINING');
    // Past the drain budget, with work still recorded and no report from the instance: not called off.
    w.advance((w.profile.lifecycle.drainSeconds + w.profile.lifecycle.heartbeatFreshSeconds) * 1000 + 1_000);
    assert.equal(await manager.reconcile(ready.id), 'DRAINING', 'never called off');
    assert.equal((await w.mappingOf(ownerId)).managementState, 'DRAINING');
    assert.ok(w.cluster.object<Pod>('pods', podName), 'nothing stops the instance: it stops on its own');
    assert.deepEqual((await w.ledger()).pool, reserved, 'compute stays reserved while it runs');

    // Its claims refused, the runner drains and exits: the kubelet reports every container stopped.
    w.cluster.autoDetach = false;
    w.cluster.stopPod(podName);
    assert.equal(await manager.reconcile(ready.id), 'DRAINING', 'the volume is still attached');
    assert.deepEqual(deletes, [{ name: podName, uid: ready.podUid }], 'the Pod is deleted by its UID');
    assert.equal(w.cluster.object<Pod>('pods', podName), undefined);
    const proven = await w.mappingOf(ownerId);
    const proof = proven.fencingReceipt as { kind?: string; predecessor?: { podUid?: string; generation?: number } } | null;
    assert.equal(proof?.kind, 'OBSERVED_STOP', 'the kubelet\'s report is the recorded proof');
    assert.equal(proof?.predecessor?.podUid, ready.podUid, 'of the recorded instance');
    assert.equal(proof?.predecessor?.generation, ready.generation);
    assert.ok(computeOf(proven), 'compute stays reserved until the volume has detached');
    assert.deepEqual((await w.ledger()).pool, reserved);

    w.cluster.detach(pvcBefore.spec.volumeName!);
    assert.equal(await manager.reconcile(ready.id), 'SLEEPING');
    const asleep = await w.mappingOf(ownerId);
    assert.equal(asleep.desiredState, 'SLEEPING');
    assert.equal(asleep.generation, ready.generation + 1, 'the drained generation is retired');
    assert.equal(asleep.podUid, null);
    assert.equal(computeOf(asleep), null, 'compute given back with it');
    assert.deepEqual(storageOf(asleep), storageOf(ready), 'storage kept');
    const { pool, shares } = await w.ledger();
    assert.deepEqual(pool, shares);
    assert.equal(reserved.cpu - pool.cpu, computeShare(w.profile).cpuMillis);
    assert.equal(pool.durable, storageShare(w.profile).durableBytes);
    // What stays: the volume, the runner row and the workspace. The old credential is dead.
    assert.equal(w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', ready.pvcName)?.metadata.uid, pvcBefore.metadata.uid, 'the PVC is kept');
    assert.equal(asleep.pvcUid, ready.pvcUid);
    assert.equal(asleep.volumeHandle, ready.volumeHandle);
    const runnerAfter = await db.runner.findUniqueOrThrow({ where: { id: ready.runnerId } });
    assert.notEqual(runnerAfter.tokenHash, runnerBefore.tokenHash, 'the drained instance\'s credential is replaced');
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: ready.defaultWorkspaceId } });
    assert.equal(workspace.deletedAt, null, 'the default workspace is kept');
    assert.equal(workspace.runnerId, ready.runnerId);
    assert.deepEqual(madeSince(w, mark), [], 'nothing was created');
    await assertSaysDisabled(w, ownerId, 'SLEEPING');
    w.cluster.autoDetach = true;

    // An instance that had already stopped on its own when the manager looked: asleep the same way.
    const stopped = await w.readyRunner('stopped-first');
    w.cluster.stopPod(managedPodName(stopped.mapping.runnerId));
    await disable(stopped.ownerId);
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < 4 && outcomes.at(-1) !== 'SLEEPING'; i += 1) outcomes.push(await w.primary.reconcile(stopped.mapping.id));
    assert.equal(outcomes.at(-1), 'SLEEPING', outcomes.join(' → '));
    assert.equal(computeOf(await w.mappingOf(stopped.ownerId)), null);
    // An enabled owner's instance that stops unasked is FAILED, as ever.
    const unasked = await w.readyRunner('stopped-enabled');
    w.cluster.stopPod(managedPodName(unasked.mapping.runnerId));
    assert.equal(await w.primary.reconcile(unasked.mapping.id), 'FAILED');
    assert.equal(((await w.mappingOf(unasked.ownerId)).lastError as { code: string }).code, 'POD_TERMINATED');

    // A drained instance whose Pod vanishes without the kubelet's report is fenced, compute kept.
    const vanished = await w.readyRunner('vanished');
    await disable(vanished.ownerId);
    assert.equal(await w.primary.reconcile(vanished.mapping.id), 'DRAINING');
    w.cluster.remove('pods', managedPodName(vanished.mapping.runnerId));
    assert.equal(await w.primary.reconcile(vanished.mapping.id), 'FENCING');
    const fenced = await w.mappingOf(vanished.ownerId);
    assert.equal((fenced.lastError as { code: string }).code, 'PREDECESSOR_STOP_UNPROVEN');
    assert.ok(computeOf(fenced), 'fencing gives nothing back');
    assert.ok((await w.primary.dueMappings(50)).includes(fenced.id), 'and it is still looked at for its proof');
    const end = await w.ledger();
    assert.deepEqual(end.pool, end.shares);
  });

  await t.test('(4) nothing wakes it while the account is disabled, and every owner write is 403 ACCOUNT_DISABLED with nothing written', async () => {
    const w = managedRunnerWorld(db);
    const { ownerId, mapping: first } = await w.readyRunner('asleep');
    const asleep = await w.putToSleep(ownerId);
    // Work waiting for it, which an enabled owner's runner would be woken for.
    await session(asleep, 'PENDING');
    assert.ok((await sleepingRunnersWithDemand(w.prisma, 1000)).includes(asleep.runnerId), 'enabled, the sweep would wake it');

    await disable(ownerId);
    const stored = await rowOf(ownerId);
    const mark = w.cluster.calls.length;
    // Demand, as every session path records it — a message, a task run, a scheduled wakeup, a watch,
    // an auto retry, a revive — and the sweep that repairs a missed one.
    assert.equal(await recordManagedDemand(w.prisma, asleep.runnerId, w.now()), null, 'no demand is recorded');
    const hook = new ManagedRunnerDemandService(w.prisma, ON, w.runtime);
    for (const source of ['session', 'turn', 'resume', 'auto-retry', 'sweep', 'owner'] as const) {
      assert.deepEqual(await hook.requested(asleep.runnerId, source), NOT_MANAGED, `${source}: nothing comes back for it`);
    }
    assert.ok(!(await sleepingRunnersWithDemand(w.prisma, 1000)).includes(asleep.runnerId), 'the sweep passes over it');
    await w.primary.sweepDemand();
    await workerPass(w);
    assert.equal(await rowOf(ownerId), stored, 'not a column of the mapping moved');

    // The owner's writes, each refused before anything is read of the mapping or written.
    const refusals: Array<[string, () => Promise<unknown>]> = [
      ['ensure', () => w.service.ensure(ownerId, 'ensure-disabled')],
      ['retry', () => w.service.retry(ownerId, 'retry-disabled', asleep.revision)],
      ['wake', () => w.service.wake(ownerId, 'wake-disabled')],
      ['sleep', () => w.service.sleep(ownerId, 'sleep-disabled', asleep.revision)],
      ['delete', () => w.service.refuseUnsupported(ownerId, 'delete')],
    ];
    for (const [action, write] of refusals) {
      await assert.rejects(write, (error: { getStatus?: () => number; getResponse?: () => { code?: string } }) => {
        assert.equal(error.getStatus?.(), 403, action);
        assert.equal(error.getResponse?.().code, ACCOUNT_DISABLED, action);
        return true;
      });
    }
    assert.equal(await rowOf(ownerId), stored, 'and nothing was written');
    await assertSaysDisabled(w, ownerId, 'SLEEPING');

    // A wake desired just before the account was disabled is dropped, and nothing starts.
    await sql.query(`UPDATE managed_runner SET desired_state = 'RUNNING' WHERE owner_id = $1`, [ownerId]);
    assert.ok((await w.primary.dueMappings(50)).includes(asleep.id));
    assert.equal(await w.primary.reconcile(asleep.id), 'SLEEPING');
    const dropped = await w.mappingOf(ownerId);
    assert.equal(dropped.managementState, 'SLEEPING');
    assert.equal(dropped.desiredState, 'SLEEPING');
    assert.ok(!(await w.primary.dueMappings(50)).includes(asleep.id));
    assert.deepEqual(madeSince(w, mark), [], 'nothing was created for it');

    // A disabled account without a mapping is given none: not at sign-in, not on ensure.
    const never = await w.makeUser('never');
    await disable(never);
    await w.service.signedIn({ id: never });
    await assert.rejects(() => w.service.ensure(never, 'ensure-never'), (error: { getStatus?: () => number; getResponse?: () => { code?: string } }) =>
      error.getStatus?.() === 403 && error.getResponse?.().code === ACCOUNT_DISABLED);
    assert.equal(await db.managedRunner.count({ where: { ownerId: never } }), 0);
    assert.equal(await db.runner.count({ where: { ownerId: never } }), 0);
    assert.equal(await db.workspace.count({ where: { ownerId: never } }), 0);
    const none = await w.service.status(never);
    assert.equal(none.managementState, 'NOT_PROVISIONED');
    assert.equal(none.reason?.code, ACCOUNT_DISABLED);
    assert.equal(none.actions.canEnsure, false);

    // (5) Enabled again: the sweep finds the work that waited, and the runner wakes on its own volume.
    await enable(ownerId);
    assert.equal((await w.service.status(ownerId)).reason, null, 'an ordinary sleeping runner again');
    assert.ok((await sleepingRunnersWithDemand(w.prisma, 1000)).includes(asleep.runnerId));
    await w.primary.sweepDemand();
    assert.equal((await w.mappingOf(ownerId)).desiredState, 'RUNNING', 'woken for its queued turn');
    const outcomes = await w.drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const awake = await w.mappingOf(ownerId);
    assert.equal(awake.generation, first.generation + 1, 'its next generation, the one its sleep reserved');
    assert.equal(awake.generation, asleep.generation);
    assert.equal(awake.runnerId, asleep.runnerId, 'the same runner');
    assert.equal(awake.defaultWorkspaceId, asleep.defaultWorkspaceId, 'the same workspace');
    assert.equal(awake.pvcUid, asleep.pvcUid, 'the same PVC');
    assert.equal(awake.volumeHandle, asleep.volumeHandle, 'the same volume');
    assert.equal(w.cluster.calls.filter((c) => c.op === 'create' && c.kind === 'persistentvolumeclaims' && c.name === asleep.pvcName).length, 1, 'never created again');
    assert.equal(w.cluster.object<Pod>('pods', managedPodName(asleep.runnerId))?.metadata.annotations?.['orbit.dev/pvc-uid'], asleep.pvcUid);
    const status = await w.service.status(ownerId);
    assert.equal(status.reason, null);
    assert.equal(status.usable, true);
  });
});
