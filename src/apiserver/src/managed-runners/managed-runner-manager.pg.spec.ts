/**
 * "Enabled with isolated fakes" (docs/managed-runner-design.md, "Verification and implementation
 * handoff"): the managed runner service and manager over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty, against the in-memory Kubernetes namespace of
 * `test-support/fake-kube-client.ts`. The switch is on; no real cluster, kubeconfig or credential is
 * involved, and the clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-manager.pg.spec.ts
 *
 * What it holds the manager to, each in a case of its own:
 *   (1) concurrent ensures make one mapping, one runner, one default workspace; two managers racing
 *       make one PVC, one Secret and one Pod, and only the credential's hash is stored;
 *   (2) a create that commits and then times out is read back and adopted, for the PVC, the Secret
 *       and the Pod — never created twice — and one that times out without committing is retried;
 *   (3) partial failures (server errors after earlier steps succeeded) keep what succeeded;
 *   (4) a restarted manager takes over a dead replica's lease once it expires, adopts the object
 *       the dead replica created but never recorded, and finds persisted intents without help;
 *   (5) retry exhaustion leaves the mapping FAILED and retryable; an explicit retry (revision and
 *       idempotency key) resumes with the same mapping and the same PVC;
 *   (6) a PVC of another owner, another UID, another storage class, or a vanished or re-handled
 *       volume is a conflict for an operator: nothing is replaced, deleted or created in its place;
 *   (7) a manager whose lease expired mid-pass is superseded by the next, and creates nothing twice;
 *   (8) another account can neither read nor act on the mapping, its runner or its volume;
 *   (9) releasing compute (a terminated Pod, on explicit retry) never deletes the runner row, its
 *       workspace or its volume, and a replacement waits for a stop proof;
 *  (10) enrollment by runner name never takes over a managed runner, and the runner removal doors
 *       refuse it;
 *  (11) a missing environment profile leaves the feature unavailable, with nothing written;
 *  (12) the startup deadline fails a silent instance, and a retry waits on the same Pod;
 *  (13) over HTTP — the real controller, guards and main.ts's pipes, interceptors and filters — a
 *       second account is refused the first one's mapping, whatever its request body names.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Global, Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import { Prisma, type ManagedRunner, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, type Apiserver } from '../auth/pat-test-apiserver';
import { generateToken, sha256 } from '../common/crypto.util';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnersService } from '../runners/runners.service';
import { FakeKubeCluster, tripwireKubeClientFactory } from '../test-support/fake-kube-client';
import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import type { PersistentVolumeClaim, Pod, Secret } from './kube-client';
import { refuseManagedRunnerDeletion } from './managed-runner-delete';
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import {
  MANAGED_RUNNER_NAME,
  MANAGED_WORKSPACE_DIR,
  bootstrapCredentialOf,
  buildManagedPod,
  buildManagedPvc,
  managedPodName,
  managedPvcName,
  managedSecretName,
} from './managed-runner-resources';
import { MANAGED_RUNNER_GATE, ManagedRunnerEnabledGuard } from './managed-runner-gate';
import { MANAGED_RUNNER_RUNTIME, createManagedRunnerRuntime, type ManagedRunnerRuntime } from './managed-runner-runtime';
import { ManagedRunnerController } from './managed-runner.controller';
import { ManagedRunnerWorker } from './managed-runner-worker';
import { ManagedRunnerService } from './managed-runner.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const ON = { enabled: true, problem: null } as const;

test('managed runner manager: unique mapping and idempotent reconciliation against a fake cluster', {
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

  let users = 0;
  const makeUser = async (label: string): Promise<string> =>
    (await db.user.create({ data: { email: `mr-${label}-${RUN}-${(users += 1)}@example.invalid`, name: label } })).id;

  /** One test world: a fake cluster, a test clock, manager replicas and the owner-facing service. */
  function world(lifecycle: Partial<ManagedRunnerProfile['lifecycle']> = {}) {
    const profile = testManagedRunnerProfile({ lifecycle });
    const cluster = new FakeKubeCluster(profile.kubernetes.namespace);
    // Starting at the real time: the owner-facing status read judges heartbeat freshness on the real
    // clock, so a fixed start made (1)'s READY read unusable once that moment was 90 seconds past.
    const clock = { ms: Date.now() };
    const now = () => new Date(clock.ms);
    const manager = (holder: string, delayMs = 0) =>
      new ManagedRunnerManager(prisma, cluster.client({ delayMs }), profile, { holder, now, random: () => 0.5, log: quiet });
    const primary = manager('replica-a');
    const runtime: ManagedRunnerRuntime = { available: true, profile, manager: primary, worker: new ManagedRunnerWorker(primary, 60_000, quiet) };
    const service = new ManagedRunnerService(prisma, ON, runtime);
    const advance = (ms: number) => void (clock.ms += ms);
    return { profile, cluster, clock, now, manager, primary, service, advance };
  }
  type World = ReturnType<typeof world>;

  const mappingOf = async (ownerId: string): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId } }))!;
  const countsOf = async (ownerId: string) => ({
    mappings: await db.managedRunner.count({ where: { ownerId } }),
    runners: await db.runner.count({ where: { ownerId } }),
    workspaces: await db.workspace.count({ where: { ownerId } }),
  });
  /** The runner's heartbeat, as the runner-api heartbeat records it. */
  const heartbeat = (runnerId: string, at: Date) =>
    db.runner.update({ where: { id: runnerId }, data: { status: 'ONLINE', lastHeartbeatAt: at } });
  const created = (w: World, kind: 'persistentvolumeclaims' | 'secrets' | 'pods', name: string) =>
    w.cluster.calls.filter((c) => c.op === 'create' && c.kind === kind && c.name === name).length;

  /**
   * Reconcile until READY or FAILED: past every backoff, with the runner heartbeating once its Pod
   * runs. Returns every outcome on the way.
   */
  async function drive(w: World, ownerId: string, manager = w.primary, rounds = 30): Promise<ReconcileOutcome[]> {
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const mapping = await mappingOf(ownerId);
      const outcome = await manager.reconcile(mapping.id);
      outcomes.push(outcome);
      if (outcome === 'READY' || outcome === 'FAILED') return outcomes;
      const after = await mappingOf(ownerId);
      if (after.podUid) {
        w.advance(1_000);
        await heartbeat(after.runnerId, w.now());
      }
      if (after.nextAttemptAt && after.nextAttemptAt > w.now()) w.clock.ms = after.nextAttemptAt.getTime() + 1;
    }
    return outcomes;
  }

  async function ready(w: World, label: string): Promise<{ ownerId: string; mapping: ManagedRunner }> {
    const ownerId = await makeUser(label);
    await w.service.ensure(ownerId, `ensure-${label}`);
    const outcomes = await drive(w, ownerId);
    assert.equal(outcomes.at(-1), 'READY', `${label}: ${outcomes.join(' → ')}`);
    return { ownerId, mapping: await mappingOf(ownerId) };
  }

  await t.test('(1) concurrent ensures: one mapping, runner and workspace; racing managers: one PVC, Secret and Pod', async () => {
    const w = world();
    const ownerId = await makeUser('concurrent');
    const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => w.service.ensure(ownerId, `ensure-${i}`)));
    assert.equal(new Set(answers.map((a) => a.runnerId)).size, 1, 'every caller is answered with the one mapping');
    assert.equal(new Set(answers.map((a) => a.workspaceId)).size, 1);
    assert.ok(answers.every((a) => a.enabled && a.managementState === 'REQUESTED' && a.desiredState === 'RUNNING'));
    assert.deepEqual(await countsOf(ownerId), { mappings: 1, runners: 1, workspaces: 1 });

    const mapping = await mappingOf(ownerId);
    assert.equal(mapping.runnerId, answers[0].runnerId);
    assert.equal(mapping.pvcName, managedPvcName(mapping.runnerId));
    assert.equal(mapping.clusterKey, w.profile.clusterKey);
    assert.equal(mapping.namespace, w.profile.kubernetes.namespace);
    const runner = await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } });
    assert.equal(runner.name, MANAGED_RUNNER_NAME);
    assert.equal(runner.status, 'OFFLINE');
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: mapping.defaultWorkspaceId } });
    assert.equal(workspace.runnerId, mapping.runnerId);
    assert.equal(workspace.targetRunnerId, mapping.runnerId);
    assert.equal(workspace.workDir, MANAGED_WORKSPACE_DIR);
    assert.equal(workspace.autoInitGit, true);
    assert.equal(workspace.enableWorktree, true);
    assert.equal(workspace.canCreateTasks, false);
    assert.equal(workspace.canDelegate, false);

    // Two replicas, interleaved by the fake's per-call pause, racing pass for pass.
    const a = w.manager('replica-a', 2);
    const b = w.manager('replica-b', 2);
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < 8; i += 1) outcomes.push(...(await Promise.all([a.reconcile(mapping.id), b.reconcile(mapping.id)])));
    assert.ok(outcomes.includes('LEASED_ELSEWHERE'), `the lease kept them apart: ${outcomes.join(', ')}`);
    await heartbeat(mapping.runnerId, w.now());
    outcomes.push(...(await Promise.all([a.reconcile(mapping.id), b.reconcile(mapping.id)])));
    assert.ok(outcomes.includes('READY'), outcomes.join(', '));

    assert.equal(created(w, 'persistentvolumeclaims', mapping.pvcName), 1);
    assert.equal(created(w, 'secrets', managedSecretName(mapping.runnerId)), 1);
    assert.equal(created(w, 'pods', managedPodName(mapping.runnerId)), 1);
    assert.equal(w.cluster.all('persistentvolumeclaims').length, 1);
    assert.equal(w.cluster.all('pods').length, 1);

    const done = await mappingOf(ownerId);
    assert.equal(done.managementState, 'READY');
    const pvc = w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', done.pvcName)!;
    const pod = w.cluster.object<Pod>('pods', managedPodName(done.runnerId))!;
    assert.equal(done.pvcUid, pvc.metadata.uid);
    assert.equal(done.pvUid, w.cluster.persistentVolumes.get(pvc.spec.volumeName!)!.metadata.uid);
    assert.equal(done.volumeHandle, w.cluster.persistentVolumes.get(pvc.spec.volumeName!)!.spec.csi!.volumeHandle);
    assert.equal(done.podUid, pod.metadata.uid);
    assert.equal(done.podName, managedPodName(done.runnerId));
    assert.equal(done.nodeName, 'node-a');
    assert.equal(done.generation, 1);
    assert.equal(done.attempt, 0);
    assert.equal(done.lastError, null);
    assert.equal(done.leaseHolder, null, 'the lease is released after each pass');
    assert.equal(pod.metadata.annotations?.['orbit.dev/generation'], '1');
    assert.equal(pod.metadata.annotations?.['orbit.dev/pvc-uid'], done.pvcUid);

    // The credential: raw in the Secret only; its hash on the runner row; nowhere else in the database.
    const secret = w.cluster.object<Secret>('secrets', managedSecretName(done.runnerId))!;
    const credential = bootstrapCredentialOf(secret)!;
    const runnerAfter = await db.runner.findUniqueOrThrow({ where: { id: done.runnerId } });
    assert.equal(runnerAfter.tokenHash, sha256(credential));
    const rows = await sql.query(
      `SELECT row_to_json(m)::text AS m, (SELECT row_to_json(r)::text FROM runner r WHERE r.id = m.runner_id) AS r
         FROM managed_runner m WHERE m.id = $1`, [done.id]);
    assert.ok(!rows.rows[0].m.includes(credential) && !rows.rows[0].r.includes(credential), 'the raw credential is stored nowhere in the control plane');

    const status = await w.service.status(ownerId);
    assert.equal(status.managementState, 'READY');
    assert.equal(status.usable, true);
    assert.equal(status.runnerId, done.runnerId);
    assert.equal(status.workspaceId, done.defaultWorkspaceId);
  });

  await t.test('(2) a create that commits and then times out is adopted; one that never committed is retried', async () => {
    for (const kind of ['persistentvolumeclaims', 'secrets', 'pods'] as const) {
      const w = world();
      w.cluster.inject({ op: 'create', kind, mode: 'commit-then-timeout' });
      const { mapping } = await ready(w, `adopt-${kind}`);
      const name = kind === 'persistentvolumeclaims' ? mapping.pvcName : kind === 'secrets' ? managedSecretName(mapping.runnerId) : managedPodName(mapping.runnerId);
      assert.equal(created(w, kind, name), 1, `${kind}: created once, then read back`);
      assert.equal(w.cluster.all(kind).length, 1, `${kind}: one object`);
      assert.equal(mapping.attempt, 0, `${kind}: an adopted outcome spends no attempt`);
      assert.equal(mapping.resourceOperationState, 'COMPLETED');
    }
    for (const kind of ['persistentvolumeclaims', 'secrets', 'pods'] as const) {
      const w = world();
      w.cluster.inject({ op: 'create', kind, mode: 'timeout' });
      const ownerId = await makeUser(`lost-${kind}`);
      await w.service.ensure(ownerId, 'ensure');
      const outcomes = await drive(w, ownerId);
      assert.ok(outcomes.includes('BACKOFF'), `${kind}: the lost create was retried after a backoff: ${outcomes.join(' → ')}`);
      assert.equal(outcomes.at(-1), 'READY');
      const mapping = await mappingOf(ownerId);
      const name = kind === 'persistentvolumeclaims' ? mapping.pvcName : kind === 'secrets' ? managedSecretName(mapping.runnerId) : managedPodName(mapping.runnerId);
      assert.equal(created(w, kind, name), 2, `${kind}: one lost attempt and one that committed`);
      assert.equal(w.cluster.all(kind).length, 1, `${kind}: still one object`);
    }
  });

  await t.test('(3) partial failures keep what succeeded: a Secret refused, a Pod refused, then both', async () => {
    const w = world();
    w.cluster.inject({ op: 'create', kind: 'secrets', mode: 'status', status: 500 });
    w.cluster.inject({ op: 'create', kind: 'pods', mode: 'status', status: 503 });
    const ownerId = await makeUser('partial');
    await w.service.ensure(ownerId, 'ensure');
    const outcomes = await drive(w, ownerId);
    assert.equal(outcomes.filter((o) => o === 'BACKOFF').length, 2, outcomes.join(' → '));
    assert.equal(outcomes.at(-1), 'READY');
    const mapping = await mappingOf(ownerId);
    assert.equal(created(w, 'persistentvolumeclaims', mapping.pvcName), 1, 'the PVC made before the failures is kept, not made again');
    assert.equal(w.cluster.all('persistentvolumeclaims').length, 1);
    assert.equal(w.cluster.all('secrets').length, 1);
    assert.equal(w.cluster.all('pods').length, 1);
    assert.equal(mapping.attempt, 0, 'READY resets the attempt budget');
  });

  await t.test('(4) a restarted manager takes over a dead replica, adopts what it created, and finds stored intents', async () => {
    const w = world();
    const ownerId = await makeUser('takeover');
    await w.service.ensure(ownerId, 'ensure');
    const mapping = await mappingOf(ownerId);
    // What a replica leaves when it dies after the API server committed its PVC and before it
    // recorded the UID: the claim exists, the row says CREATE_PVC is PENDING, and its lease is live.
    w.cluster.plant('persistentvolumeclaims', buildManagedPvc(
      { ownerId, runnerId: mapping.runnerId, generation: 1, namespace: mapping.namespace }, w.profile,
    ));
    await db.managedRunner.update({
      where: { id: mapping.id },
      data: {
        managementState: 'PROVISIONING',
        startupDeadlineAt: new Date(w.clock.ms + 600_000),
        resourceOperationId: randomUUID(),
        resourceOperationKind: 'CREATE_PVC',
        resourceOperationState: 'PENDING',
        leaseHolder: 'replica-dead',
        leaseExpiresAt: new Date(w.clock.ms + 30_000),
        revision: { increment: 1 },
      },
    });

    const restarted = w.manager('replica-restarted');
    assert.ok((await restarted.dueMappings(500)).includes(mapping.id), 'the stored intent is the work queue');
    assert.equal(await restarted.reconcile(mapping.id), 'LEASED_ELSEWHERE', "a live lease is respected, even a dead replica's");
    assert.equal(w.cluster.calls.length, 0, 'nothing was touched under another replica’s lease');
    w.advance(31_000);
    const outcomes = await drive(w, ownerId, restarted);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    assert.equal(created(w, 'persistentvolumeclaims', mapping.pvcName), 0, 'the dead replica’s claim was adopted, not created again');
    assert.equal(w.cluster.all('persistentvolumeclaims').length, 1);
    const after = await mappingOf(ownerId);
    assert.equal(after.pvcUid, w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', mapping.pvcName)!.metadata.uid);
    assert.equal(after.id, mapping.id);
    assert.equal(after.runnerId, mapping.runnerId);

    // A second restart, mid-flight: the recorded Pod is adopted by UID, not started again.
    const again = w.manager('replica-restarted-again');
    await heartbeat(after.runnerId, w.now());
    assert.equal(await again.reconcile(after.id), 'READY');
    assert.equal(created(w, 'pods', managedPodName(after.runnerId)), 1);
  });

  await t.test('(5) retry exhaustion leaves FAILED and retryable; an explicit retry resumes the same mapping', async () => {
    const w = world({ maxAttempts: 3 });
    w.cluster.inject({ op: 'create', kind: 'persistentvolumeclaims', mode: 'status', status: 503, times: Infinity });
    const ownerId = await makeUser('exhausted');
    await w.service.ensure(ownerId, 'ensure');
    const outcomes = await drive(w, ownerId);
    assert.deepEqual(outcomes.slice(-3), ['BACKOFF', 'BACKOFF', 'FAILED'], outcomes.join(' → '));
    const failed = await mappingOf(ownerId);
    assert.equal(failed.managementState, 'FAILED');
    assert.equal(failed.attempt, 3);
    assert.deepEqual({ ...(failed.lastError as object), detail: undefined }, {
      code: 'RETRY_EXHAUSTED',
      message: 'Provisioning kept failing on transient infrastructure errors and stopped. It can be retried.',
      retryable: true,
      detail: undefined,
    });
    assert.equal(w.cluster.all('persistentvolumeclaims').length, 0);
    const status = await w.service.status(ownerId);
    assert.equal(status.actions.canRetry, true);
    assert.equal(status.reason?.code, 'RETRY_EXHAUSTED');
    assert.equal(await w.primary.reconcile(failed.id), 'FAILED', 'a FAILED mapping waits for an explicit retry');

    w.cluster.clearFaults();
    await assert.rejects(w.service.retry(ownerId, 'retry-1', failed.revision - 1), (e: any) => e.getStatus() === 409 && e.getResponse().code === 'MANAGED_RUNNER_REVISION_CONFLICT');
    await assert.rejects(w.service.retry(ownerId, 'retry-1', undefined), (e: any) => e.getStatus() === 400);
    const retried = await w.service.retry(ownerId, 'retry-1', failed.revision);
    assert.equal(retried.managementState, 'REQUESTED');
    assert.equal(retried.revision, failed.revision + 1);
    const replay = await w.service.retry(ownerId, 'retry-1', failed.revision);
    assert.equal(replay.revision, retried.revision, 'the same request again is answered, not applied again');

    assert.equal((await drive(w, ownerId)).at(-1), 'READY');
    const after = await mappingOf(ownerId);
    assert.equal(after.id, failed.id);
    assert.equal(after.runnerId, failed.runnerId);
    assert.equal(w.cluster.all('persistentvolumeclaims').length, 1);
  });

  await t.test('(6) another owner’s, another UID’s or another class’s PVC is a conflict; a vanished or re-handled volume too', async () => {
    // Owner mismatch: a claim under this runner's name, annotated for somebody else.
    {
      const w = world();
      const ownerId = await makeUser('owner-mismatch');
      const intruder = await makeUser('owner-mismatch-other');
      await w.service.ensure(ownerId, 'ensure');
      const mapping = await mappingOf(ownerId);
      const foreign = w.cluster.plant('persistentvolumeclaims', buildManagedPvc(
        { ownerId: intruder, runnerId: mapping.runnerId, generation: 1, namespace: mapping.namespace }, w.profile,
      ));
      assert.equal((await drive(w, ownerId)).at(-1), 'FAILED');
      const failed = await mappingOf(ownerId);
      assert.equal((failed.lastError as { code: string }).code, 'PVC_CONFLICT');
      assert.equal((failed.lastError as { retryable: boolean }).retryable, false);
      assert.equal(failed.pvcUid, null, 'the foreign claim was not adopted');
      assert.equal(w.cluster.object('persistentvolumeclaims', mapping.pvcName)!.metadata.uid, foreign.metadata.uid, 'nor replaced');
      assert.equal(w.cluster.count('create'), 0, 'nothing was created in its place');
      assert.equal(w.cluster.count('delete'), 0, 'and nothing deleted');
      await assert.rejects(w.service.retry(ownerId, 'retry', failed.revision), (e: any) => e.getResponse().code === 'MANAGED_RUNNER_TRANSITION_REFUSED');
    }
    // Another storage class under the right annotations.
    {
      const w = world();
      const ownerId = await makeUser('class-mismatch');
      await w.service.ensure(ownerId, 'ensure');
      const mapping = await mappingOf(ownerId);
      const pvc = buildManagedPvc({ ownerId, runnerId: mapping.runnerId, generation: 1, namespace: mapping.namespace }, w.profile);
      pvc.spec.storageClassName = 'fast-local';
      w.cluster.plant('persistentvolumeclaims', pvc);
      assert.equal((await drive(w, ownerId)).at(-1), 'FAILED');
      assert.match(((await mappingOf(ownerId)).lastError as { detail: string }).detail, /another storage class/);
    }
    // Another UID under the recorded name: the claim was recreated behind the mapping's back.
    {
      const w = world();
      const { ownerId, mapping } = await ready(w, 'uid-conflict');
      const podsBefore = w.cluster.all('pods').length;
      w.cluster.remove('persistentvolumeclaims', mapping.pvcName);
      w.cluster.plant('persistentvolumeclaims', buildManagedPvc({ ownerId, runnerId: mapping.runnerId, generation: 1, namespace: mapping.namespace }, w.profile));
      assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
      const failed = await mappingOf(ownerId);
      assert.equal((failed.lastError as { code: string }).code, 'PVC_CONFLICT');
      assert.match((failed.lastError as { detail: string }).detail, /different UID/);
      assert.equal(failed.pvcUid, mapping.pvcUid, 'the recorded identity is kept');
      assert.equal(created(w, 'persistentvolumeclaims', mapping.pvcName), 1, 'no claim was created by the manager after the first');
      assert.equal(w.cluster.count('delete'), 0, 'neither claim nor Pod was deleted');
      assert.equal(w.cluster.all('pods').length, podsBefore);
    }
    // The recorded claim gone: never an empty replacement.
    {
      const w = world();
      const { ownerId, mapping } = await ready(w, 'pvc-missing');
      w.cluster.remove('persistentvolumeclaims', mapping.pvcName);
      assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
      assert.equal(((await mappingOf(ownerId)).lastError as { code: string }).code, 'PVC_MISSING');
      assert.equal(created(w, 'persistentvolumeclaims', mapping.pvcName), 1);
      assert.equal(w.cluster.all('persistentvolumeclaims').length, 0, 'no empty disk took its place');
    }
    // The recorded claim gone before an explicit retry walks back through PROVISIONING: the retry
    // reports it, and still creates nothing in its place.
    {
      const w = world();
      const { ownerId, mapping } = await ready(w, 'pvc-missing-retry');
      w.cluster.mutate<Pod>('pods', managedPodName(mapping.runnerId), (pod) => void (pod.status = { phase: 'Failed' }));
      assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
      w.cluster.remove('persistentvolumeclaims', mapping.pvcName);
      await w.service.retry(ownerId, 'retry-after-loss', (await mappingOf(ownerId)).revision);
      assert.equal((await drive(w, ownerId)).at(-1), 'FAILED');
      assert.equal(((await mappingOf(ownerId)).lastError as { code: string }).code, 'PVC_MISSING');
      assert.equal(created(w, 'persistentvolumeclaims', mapping.pvcName), 1, 'the retry created no claim');
      assert.equal(w.cluster.all('persistentvolumeclaims').length, 0, 'no empty disk took its place');
    }
    // The PV's volume handle changed under the recorded claim.
    {
      const w = world();
      const { ownerId, mapping } = await ready(w, 'handle-conflict');
      const pvName = w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', mapping.pvcName)!.spec.volumeName!;
      w.cluster.persistentVolumes.get(pvName)!.spec.csi!.volumeHandle = 'some-other-image';
      assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
      const failed = await mappingOf(ownerId);
      assert.equal((failed.lastError as { code: string }).code, 'PV_CONFLICT');
      assert.equal(failed.volumeHandle, mapping.volumeHandle);
    }
    // A recorded volume handle cannot be adopted by a second mapping, nor a recorded PVC UID.
    {
      const w = world();
      const first = await ready(w, 'unique-handle-a');
      const second = await ready(w, 'unique-handle-b');
      await assert.rejects(
        db.managedRunner.update({ where: { id: second.mapping.id }, data: { volumeHandle: first.mapping.volumeHandle } }),
        (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002',
      );
      await assert.rejects(
        db.managedRunner.update({ where: { id: second.mapping.id }, data: { pvcUid: first.mapping.pvcUid } }),
        (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002',
      );
    }
  });

  await t.test('(7) a manager whose lease expired mid-pass is superseded, and nothing is created twice', async () => {
    const w = world();
    const ownerId = await makeUser('lease-expiry');
    await w.service.ensure(ownerId, 'ensure');
    const mapping = await mappingOf(ownerId);
    const slow = w.manager('replica-slow', 400);
    const fast = w.manager('replica-fast');
    const slowPass = slow.reconcile(mapping.id);
    // Once the slow replica has recorded PROVISIONING and is waiting on the cluster, its lease runs
    // out and the fast one takes over.
    const parked = async () => {
      const row = await mappingOf(ownerId);
      return row.leaseHolder === 'replica-slow' && row.managementState === 'PROVISIONING';
    };
    for (let i = 0; i < 200 && !(await parked()); i += 1) await new Promise((r) => setTimeout(r, 2));
    assert.ok(await parked(), 'the slow replica is inside its pass');
    w.advance(31_000);
    const fastOutcome = await fast.reconcile(mapping.id);
    assert.equal(fastOutcome, 'WAITING', 'the fast replica provisioned up to the heartbeat wait');
    assert.equal(await slowPass, 'SUPERSEDED', 'the expired replica found the row moved on and stopped');
    await heartbeat(mapping.runnerId, w.now());
    assert.equal(await fast.reconcile(mapping.id), 'READY');
    assert.equal(created(w, 'persistentvolumeclaims', mapping.pvcName), 1);
    assert.equal(created(w, 'pods', managedPodName(mapping.runnerId)), 1);
    assert.equal(w.cluster.all('pods').length, 1);
  });

  await t.test('(8) another account can neither read nor act on the mapping, its runner or its volume', async () => {
    const w = world();
    const { ownerId, mapping } = await ready(w, 'tenant-a');
    const stranger = await makeUser('tenant-b');

    const seen = await w.service.status(stranger);
    assert.equal(seen.managementState, 'NOT_PROVISIONED', 'another owner’s mapping is not visible');
    assert.equal(seen.runnerId, null);
    await assert.rejects(w.service.retry(stranger, 'k', mapping.revision), (e: any) => e.getStatus() === 404 && e.getResponse().code === 'MANAGED_RUNNER_NOT_FOUND');
    await assert.rejects(w.service.refuseUnsupported(stranger, 'delete'), (e: any) => e.getStatus() === 404);
    await assert.rejects(new RunnersService(prisma).removeRunner(stranger, mapping.runnerId), (e: any) => e.getStatus() === 404, 'nor its runner');

    // The stranger's own ensure makes the stranger's own mapping, runner, workspace and claim.
    await w.service.ensure(stranger, 'ensure');
    const theirs = await mappingOf(stranger);
    assert.notEqual(theirs.runnerId, mapping.runnerId);
    assert.notEqual(theirs.defaultWorkspaceId, mapping.defaultWorkspaceId);
    assert.notEqual(theirs.pvcName, mapping.pvcName);
    await drive(w, stranger);
    const mine = await mappingOf(ownerId);
    assert.equal(mine.revision, mapping.revision, 'the first owner’s mapping was not written by any of it');
    assert.equal(w.cluster.object('persistentvolumeclaims', mapping.pvcName)!.metadata.uid, mapping.pvcUid);
    assert.equal(w.cluster.object('pods', managedPodName(mapping.runnerId))!.metadata.uid, mapping.podUid);
    assert.equal(w.cluster.calls.filter((c) => c.op !== 'get' && c.name?.includes(mapping.runnerId)).length, 3, 'the first owner’s objects were made once each, and never touched again');

    // The database fences the pairing itself: a mapping cannot name another owner's runner or workspace.
    await assert.rejects(
      sql.query(`UPDATE managed_runner SET runner_id = $1 WHERE id = $2`, [mapping.runnerId, theirs.id]),
      (e: { code?: string }) => e.code === '23503' || e.code === '23505' || e.code === '23514',
    );
    await assert.rejects(
      sql.query(`UPDATE managed_runner SET default_workspace_id = $1 WHERE id = $2`, [mapping.defaultWorkspaceId, theirs.id]),
      (e: { code?: string }) => e.code === '23503' || e.code === '23505',
    );
  });

  await t.test('(9) releasing compute never deletes the runner row, its workspace or its volume; a replacement waits for proof', async () => {
    const w = world();
    const { ownerId, mapping } = await ready(w, 'recycle');
    const runnerBefore = await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } });

    // The instance stops; the mapping says so, and keeps everything.
    w.cluster.mutate<Pod>('pods', managedPodName(mapping.runnerId), (pod) => void (pod.status = { phase: 'Failed' }));
    assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
    const stopped = await mappingOf(ownerId);
    assert.equal((stopped.lastError as { code: string }).code, 'POD_TERMINATED');
    assert.equal(w.cluster.count('delete'), 0, 'observing a stopped instance deletes nothing');

    // An explicit retry releases the terminated Pod (by UID) — and only the Pod.
    await w.service.retry(ownerId, 'retry-recycle', stopped.revision);
    const outcomes = await drive(w, ownerId);
    assert.equal(outcomes.at(-1), 'FAILED', outcomes.join(' → '));
    assert.equal(w.cluster.count('delete', 'pods'), 1, 'compute was released');
    assert.equal(w.cluster.count('delete'), 1, 'and nothing else was deleted');
    assert.equal(w.cluster.all('pods').length, 0);

    const after = await mappingOf(ownerId);
    assert.equal((after.lastError as { code: string }).code, 'PREDECESSOR_STOP_UNPROVEN', 'a replacement waits for a stop proof or fencing receipt');
    assert.equal(after.generation, 1, 'the generation does not advance without that proof');
    assert.equal(after.pvcUid, mapping.pvcUid);
    assert.equal(after.volumeHandle, mapping.volumeHandle);
    assert.equal(created(w, 'pods', managedPodName(mapping.runnerId)), 1, 'no second instance');
    assert.ok(w.cluster.object('persistentvolumeclaims', mapping.pvcName), 'the data volume stays');
    assert.ok(w.cluster.object('secrets', managedSecretName(mapping.runnerId)), 'the bootstrap Secret stays');

    const runnerAfter = await db.runner.findUnique({ where: { id: mapping.runnerId } });
    assert.ok(runnerAfter, 'the runner row stays');
    assert.equal(runnerAfter!.tokenHash, runnerBefore.tokenHash, 'its credential is not revoked');
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: mapping.defaultWorkspaceId } });
    assert.equal(workspace.deletedAt, null, 'the default workspace stays');

    // And nothing can delete them: the database refuses, and so does every removal door.
    const references = await sql.query(
      `SELECT conname, confdeltype FROM pg_constraint WHERE conrelid = 'managed_runner'::regclass AND contype = 'f' ORDER BY conname`,
    );
    assert.deepEqual(references.rows, [
      { conname: 'managed_runner_default_workspace_fkey', confdeltype: 'r' },
      { conname: 'managed_runner_owner_id_fkey', confdeltype: 'r' },
      { conname: 'managed_runner_runner_fkey', confdeltype: 'r' },
    ], 'every reference from the mapping restricts deletion; none cascades');
    await assert.rejects(sql.query('DELETE FROM runner WHERE id = $1', [mapping.runnerId]), (e: { code?: string; constraint?: string }) =>
      e.code === '23503' && /^managed_runner_/.test(e.constraint ?? ''));
    await assert.rejects(sql.query('DELETE FROM workspace WHERE id = $1', [mapping.defaultWorkspaceId]), (e: { code?: string }) => e.code === '23503');
    await assert.rejects(sql.query('DELETE FROM "user" WHERE id = $1', [ownerId]), (e: { code?: string }) => e.code === '23503');
    await assert.rejects(refuseManagedRunnerDeletion(prisma, mapping.runnerId), (e: any) => e.getStatus() === 409 && e.getResponse().code === 'MANAGED_RUNNER_DELETE_REFUSED');
    await assert.rejects(new RunnersService(prisma).removeRunner(ownerId, mapping.runnerId), (e: any) => e.getStatus() === 409);
    const runnerApi = new RunnerApiController(prisma, {} as never, {} as never, {} as never, {} as never, {} as never);
    await assert.rejects(runnerApi.deregister({ id: mapping.runnerId }), (e: any) => e.getStatus() === 409);
    assert.ok(await db.runner.findUnique({ where: { id: mapping.runnerId } }));
  });

  await t.test('(10) enrollment by name never takes over a managed runner; a replaced Pod is not adopted', async () => {
    const w = world();
    const { ownerId, mapping } = await ready(w, 'enroll-by-name');
    const before = await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } });
    const token = generateToken(32);
    await db.enrollmentToken.create({ data: { ownerId, tokenHash: sha256(token), label: 'self-managed machine' } });
    const runnerApi = new RunnerApiController(prisma, {} as never, {} as never, {} as never, {} as never, {} as never);
    const registered = await runnerApi.register({ enrollmentToken: token, name: MANAGED_RUNNER_NAME } as never);
    assert.notEqual(registered.runnerId, mapping.runnerId, 'a machine enrolled under the same name gets a runner of its own');
    const after = await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } });
    assert.equal(after.tokenHash, before.tokenHash, 'the managed runner’s credential was not re-issued');
    // A self-managed runner of the same owner is still removable, as before.
    assert.deepEqual(await new RunnersService(prisma).removeRunner(ownerId, registered.runnerId), { ok: true });

    // Another Pod under the fixed name and generation, with another UID: not the recorded instance.
    w.cluster.remove('pods', managedPodName(mapping.runnerId));
    w.cluster.plant('pods', buildManagedPod({ ownerId, runnerId: mapping.runnerId, generation: 1, namespace: mapping.namespace }, mapping.pvcUid!, w.profile));
    assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
    assert.equal(((await mappingOf(ownerId)).lastError as { code: string }).code, 'PREDECESSOR_STOP_UNPROVEN');
    assert.equal(w.cluster.count('delete'), 0, 'the unrecorded Pod is reported, not deleted');
  });

  await t.test('(11) a missing profile leaves the feature unavailable: nothing constructed, nothing written', async () => {
    const constructed: string[] = [];
    const runtime = createManagedRunnerRuntime({ profilePath: undefined, prisma, kubeClient: tripwireKubeClientFactory(constructed), log: quiet });
    assert.deepEqual(runtime, { available: false, problems: ['ORBIT_MANAGED_RUNNERS_PROFILE names no profile file'] });
    assert.deepEqual(constructed, [], 'no client was constructed for a profile that does not exist');
    const service = new ManagedRunnerService(prisma, ON, runtime);
    const ownerId = await makeUser('unavailable');
    await assert.rejects(service.ensure(ownerId, 'k'), (e: any) => e.getStatus() === 503 && e.getResponse().code === 'MANAGED_RUNNER_UNAVAILABLE');
    assert.deepEqual(await countsOf(ownerId), { mappings: 0, runners: 0, workspaces: 0 });
    const status = await service.status(ownerId);
    assert.equal(status.enabled, true);
    assert.equal(status.reason?.code, 'MANAGED_RUNNER_UNAVAILABLE');
    assert.equal(status.actions.canEnsure, false);
  });

  await t.test('(12) the startup deadline fails a silent instance; a retry waits on the same Pod again', async () => {
    const w = world();
    const ownerId = await makeUser('deadline');
    await w.service.ensure(ownerId, 'ensure');
    const mapping = await mappingOf(ownerId);
    for (let i = 0; i < 6; i += 1) await w.primary.reconcile(mapping.id);
    assert.equal((await mappingOf(ownerId)).managementState, 'STARTING');
    w.advance(601_000);
    assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
    const late = await mappingOf(ownerId);
    assert.equal((late.lastError as { code: string }).code, 'STARTUP_TIMEOUT');
    await w.service.retry(ownerId, 'retry-deadline', late.revision);
    assert.equal((await drive(w, ownerId)).at(-1), 'READY');
    assert.equal(created(w, 'pods', managedPodName(mapping.runnerId)), 1, 'the running Pod was waited on, not replaced');
    assert.equal(w.cluster.count('delete'), 0);
  });

  await t.test('(13) over HTTP: authentication first, 202 for the owner, and another account refused whatever it names', async () => {
    const w = world();
    const alice = await makeUser('http-alice');
    const bob = await makeUser('http-bob');
    const runtime: ManagedRunnerRuntime = { available: true, profile: w.profile, manager: w.primary, worker: new ManagedRunnerWorker(w.primary, 60_000, quiet) };

    @Global()
    @Module({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: MANAGED_RUNNER_GATE, useValue: ON },
        { provide: MANAGED_RUNNER_RUNTIME, useValue: runtime },
        // The bearer is the account it names.
        { provide: JwtService, useValue: { verifyAsync: async (token: string) => ({ sub: token, email: `${token}@example.invalid` }) } },
      ],
      exports: [PrismaService, MANAGED_RUNNER_GATE, MANAGED_RUNNER_RUNTIME, JwtService],
    })
    class Doubles {}
    @Module({ imports: [Doubles], controllers: [ManagedRunnerController], providers: [ManagedRunnerService, ManagedRunnerEnabledGuard] })
    class Harness {}

    const app: INestApplication = await NestFactory.create(Harness, { logger: ['error'], abortOnError: false });
    app.use(publicIdHeaders);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
    app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
    const adapter = app.get(HttpAdapterHost).httpAdapter;
    app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(adapter), adapter));
    await app.listen(0, '127.0.0.1');
    t.after(() => app.close());
    const server = { port: Number(new globalThis.URL(await app.getUrl()).port) } as Apiserver;

    assert.equal((await call(server, 'POST', '/api/managed-runner/ensure', undefined, { idempotencyKey: 'k' })).status, 401);
    const missingKey = await call(server, 'POST', '/api/managed-runner/ensure', alice, {});
    assert.equal(missingKey.status, 400, 'an enabled write without an idempotency key is refused');
    assert.deepEqual(await countsOf(alice), { mappings: 0, runners: 0, workspaces: 0 });

    const ensured = await call(server, 'POST', '/api/managed-runner/ensure', alice, { idempotencyKey: 'alice-1' });
    assert.equal(ensured.status, 202, ensured.text);
    assert.equal(ensured.json.managementState, 'REQUESTED');
    const mine = await mappingOf(alice);
    assert.equal(toUuid(ensured.json.runnerId), mine.runnerId, 'ids leave in the public id codec');
    assert.equal(toUuid(ensured.json.workspaceId), mine.defaultWorkspaceId);
    const again = await call(server, 'POST', '/api/managed-runner/ensure', alice, { idempotencyKey: 'alice-2' });
    assert.equal(again.status, 202);
    assert.equal(again.json.runnerId, ensured.json.runnerId, 'ensure again answers the same mapping');

    // Bob names Alice's runner, workspace and revision: the body cannot address them.
    const theirs = await call(server, 'GET', '/api/managed-runner', bob);
    assert.equal(theirs.json.managementState, 'NOT_PROVISIONED');
    assert.equal(theirs.json.runnerId, null);
    for (const action of ['retry', 'wake', 'sleep', 'delete']) {
      const refused = await call(server, 'POST', `/api/managed-runner/${action}`, bob, {
        idempotencyKey: `bob-${action}`, revision: mine.revision, runnerId: mine.runnerId, workspaceId: mine.defaultWorkspaceId, ownerId: alice,
      });
      assert.equal(refused.status, 404, `${action}: ${refused.text}`);
      assert.equal(refused.json.code, 'MANAGED_RUNNER_NOT_FOUND');
    }
    assert.equal((await mappingOf(alice)).revision, mine.revision, "Alice's mapping was not touched");

    // Bob's own ensure makes Bob's own mapping, even naming Alice's ids.
    const bobs = await call(server, 'POST', '/api/managed-runner/ensure', bob, { idempotencyKey: 'bob-1', runnerId: mine.runnerId });
    assert.equal(bobs.status, 202, bobs.text);
    assert.notEqual(toUuid(bobs.json.runnerId), mine.runnerId);
    assert.equal((await mappingOf(bob)).ownerId, bob);

    // Alice's retry, on a mapping that is not FAILED, is refused as a state conflict.
    const early = await call(server, 'POST', '/api/managed-runner/retry', alice, { idempotencyKey: 'alice-retry', revision: mine.revision });
    assert.equal(early.status, 409, early.text);
    assert.equal(early.json.code, 'MANAGED_RUNNER_TRANSITION_REFUSED');
  });
});
