/**
 * An administrator's switch of a managed runner's data volume to a restored one (managed-runner-volume-switch.ts;
 * docs/managed-runner-kubernetes-operations.md, "Put a restored volume back under its runner"), on the in-memory
 * Kubernetes namespace of test-support/fake-kube-client.ts with the single-Pod admission guard installed, against a
 * real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty. The route is the real controller behind its real
 * guards (JwtAuthGuard, the managed switch, AdminRoleGuard), validation and id codec, over HTTP; the manager and the
 * owner's service are the test world's (test-support/managed-runner-world.ts), whose clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-volume-switch.pg.spec.ts
 *
 *   (1) a runner whose volume was lost while it slept fails its wake, PVC_MISSING. Every switch that cannot be
 *       verified is refused with the check that failed, and nothing is switched or recorded, in the database or the
 *       cluster: no volume under its name; one marked as another account's runner's; one bound to storage another
 *       mapping records; one bound to a PV made before it; one not bound; one attached to a node; one a Pod admitted
 *       before the guard uses; a Pod under the runner's name; the recorded PV still attached; another UID than the
 *       one verified; a revision that moved; the guard missing; another manager's lease. A stranger is refused 401,
 *       a member 403, an unknown runner 404 and a malformed request 400. Restored into a new claim under the
 *       runner's name, the administrator's switch is answered with the new identity, leaves the mapping SLEEPING and
 *       writes one audit row; the wake that was waiting starts the reserved generation on the new claim: the same
 *       runner, a Pod admitted for the new claim's UID, no claim created and the old PV untouched. The same request
 *       again, even while a manager pass holds the mapping, is answered as it was, with no second audit row;
 *   (2) the single writer, unchanged after a switch: another Pod on the new claim is refused by the guard, the next
 *       sleep's stop proof names the new claim and handle, a Pod gone without a report still fences, and a fenced
 *       runner is not switched;
 *   (3) an account disabled, its runner asleep, whose volume an operator replaces as damaged: refused while the claim
 *       under its name is the recorded one, and without the confirmation; switched with it, the runner stays asleep
 *       while work waits for it, until the account is enabled, and then wakes on the new claim;
 *   (4) a runner that failed PVC_MISSING with its stopped Pod still recorded (its claim deleted while it ran): the
 *       switch retires that generation on its recorded stop proof — the credential replaced, the compute given back
 *       — and the next generation starts on the new claim. One that failed with its Pod still running is refused:
 *       nothing proves it stopped;
 *   (5) a READY runner is refused NOT_SWITCHABLE, and a server running managed runners on Docker NOT_APPLICABLE.
 *
 * Not destructive: every row belongs to a user this run creates, and the world has a pool of its own.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';
import type { ManagedRunner, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { testDockerRunnerProfile } from '../test-support/docker-runner-profile.fixture';
import { FakeDockerChannel } from '../test-support/fake-docker-channel';
import { managedRunnerWorld, quiet } from '../test-support/managed-runner-world';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { DockerBackend } from './docker-backend';
import type { ManagedRunnerVolumeSwitchDto } from './dto';
import type { PersistentVolume, PersistentVolumeClaim, Pod } from './kube-client';
import { ManagedRunnerAdminController } from './managed-runner-admin.controller';
import { MANAGED_RUNNER_GATE, ManagedRunnerEnabledGuard } from './managed-runner-gate';
import { ManagedRunnerManager } from './managed-runner-manager';
import {
  GENERATION_ANNOTATION,
  OWNER_ANNOTATION,
  PVC_UID_ANNOTATION,
  RUNNER_ANNOTATION,
  buildManagedPod,
  buildManagedPvc,
  managedPodName,
} from './managed-runner-resources';
import type { ManagedRunnerRuntime } from './managed-runner-runtime';
import { MANAGED_RUNNER_VOLUME_SWITCHED_ACTIVITY } from './managed-runner-volume-switch';
import { recordManagedDemand } from './managed-runner-work';
import { ManagedRunnerWorker } from './managed-runner-worker';
import { ManagedRunnerService } from './managed-runner.service';

const URL = process.env.COORDINATOR_PG_URL;
const ON = { enabled: true, problem: null } as const;
const REASON = 'restored from the independent backup of 2026-10-18';

const codeOf = (m: ManagedRunner) => (m.lastError as { code?: string } | null)?.code ?? null;
/** What a refused switch must leave as it was. */
const state = (m: ManagedRunner) => ({
  revision: m.revision,
  managementState: m.managementState,
  desiredState: m.desiredState,
  generation: m.generation,
  pvcUid: m.pvcUid,
  pvUid: m.pvUid,
  volumeHandle: m.volumeHandle,
  podUid: m.podUid,
  lastError: m.lastError,
  lastRequestKey: m.lastRequestKey,
  leaseHolder: m.leaseHolder,
});

test('managed runner volume switch: an administrator puts a restored volume back under its runner, verified and recorded', {
  skip: !URL, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const logs: string[] = [];
  const w = managedRunnerWorld(db, { log: { warn: (line: string) => void logs.push(line), error: (line: string) => void logs.push(line) } });

  // The administrator's route, with its own guards, validation and id codec, over the world's service and database.
  const jwt = new JwtService({ secret: `volume-switch-${randomUUID()}` });
  @Module({
    controllers: [ManagedRunnerAdminController],
    providers: [
      { provide: PrismaService, useValue: w.prisma },
      { provide: JwtService, useValue: jwt },
      { provide: MANAGED_RUNNER_GATE, useValue: ON },
      { provide: ManagedRunnerService, useValue: w.service },
      ManagedRunnerEnabledGuard,
      AdminRoleGuard,
    ],
  })
  class AdminRoute {}
  const app = await NestFactory.create(AdminRoute, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const server = { port: Number(new globalThis.URL((await app.getUrl()).replace('[::1]', '127.0.0.1')).port) } as Apiserver;
  t.after(async () => {
    await app.close().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const admin = (await db.user.create({ data: { email: `admin-${randomUUID()}@example.invalid`, name: 'admin', role: 'ADMIN' } })).id;
  const member = await w.makeUser('member');
  const bearer = (userId: string) => jwt.signAsync({ sub: userId, email: `${userId}@example.invalid` });
  const asAdmin = await bearer(admin);
  const asMember = await bearer(member);

  const send = (who: string | undefined, runnerId: string, body: unknown): Promise<Reply> =>
    call(server, 'POST', `/api/admin/managed-runners/${uuidToBase62(runnerId)}/volume-switch`, who, body);
  const request = (m: ManagedRunner, volumeUid: string, extra: Partial<ManagedRunnerVolumeSwitchDto> = {}) =>
    ({ idempotencyKey: `switch-${randomUUID()}`, revision: m.revision, volumeUid, reason: REASON, ...extra });
  const audits = (m: ManagedRunner) =>
    db.activity.findMany({ where: { type: MANAGED_RUNNER_VOLUME_SWITCHED_ACTIVITY, payload: { path: ['mappingId'], equals: m.id } }, orderBy: { createdAt: 'asc' } });
  /** Writes the manager sent the cluster: a refused switch sends none (its admission probe is a dry run). */
  const clusterWrites = () => w.cluster.calls.filter((c) => c.op === 'create' || c.op === 'delete' || c.op === 'patch').length;
  const pvcName = (m: ManagedRunner) => m.pvcName;
  /** An operator's restored claim under the runner's name: what the manager itself makes, with the cluster's new UID and PV. */
  const restoreClaim = (m: ManagedRunner, change: (pvc: PersistentVolumeClaim) => void = () => undefined): PersistentVolumeClaim => {
    const pvc = buildManagedPvc({ ownerId: m.ownerId, runnerId: m.runnerId, generation: m.generation, namespace: m.namespace }, w.profile);
    change(pvc);
    return w.cluster.plant('persistentvolumeclaims', pvc);
  };
  const claimOf = (m: ManagedRunner) => w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', m.pvcName);
  const attachment = (name: string, pv: string, node = 'node-b') => w.cluster.volumeAttachments.set(name, {
    apiVersion: 'storage.k8s.io/v1', kind: 'VolumeAttachment', metadata: { name, uid: randomUUID() },
    spec: { attacher: 'rbd.csi.ceph.com', nodeName: node, source: { persistentVolumeName: pv } }, status: { attached: true },
  });

  /** A switch refused by `check`: answered 409 with its sentence and detail, and the mapping, the audit and the cluster as they were. */
  async function refused(label: string, m: ManagedRunner, body: unknown, check: string, detail?: RegExp): Promise<void> {
    const before = state(await w.mappingOf(m.ownerId));
    const auditsBefore = (await audits(m)).length;
    const writes = clusterWrites();
    const reply = await send(asAdmin, m.runnerId, body);
    assert.equal(reply.status, 409, `${label}: ${reply.text}`);
    assert.equal(reply.json.code, 'MANAGED_RUNNER_VOLUME_SWITCH_REFUSED', label);
    assert.equal(reply.json.check, check, `${label}: ${reply.text}`);
    assert.ok(typeof reply.json.message === 'string' && reply.json.message.length > 20, `${label}: a sentence for the administrator`);
    if (detail) assert.match(reply.json.detail, detail, label);
    assert.deepEqual(state(await w.mappingOf(m.ownerId)), before, `${label}: the mapping as it was, its lease given back`);
    assert.equal((await audits(m)).length, auditsBefore, `${label}: no audit row`);
    assert.equal(clusterWrites(), writes, `${label}: nothing written to the cluster`);
  }

  /** A switch answered 200, and the audit row it wrote. */
  async function switched(m: ManagedRunner, body: ReturnType<typeof request>) {
    const reply = await send(asAdmin, m.runnerId, body);
    assert.equal(reply.status, 200, reply.text);
    const rows = await audits(m);
    return { answer: reply.json, audit: rows.at(-1)! };
  }

  // ── (1) ─────────────────────────────────────────────────────────────────────────────────────

  const other = await w.readyRunner('other');
  const otherClaim = claimOf(other.mapping)!;

  await t.test('(1) a volume lost while asleep: every switch it cannot verify is refused; the restored one is switched to, recorded and woken on', async (st) => {
    const { ownerId } = await w.readyRunner('lost');
    const asleep = await w.putToSleep(ownerId);
    const lostClaim = claimOf(asleep)!;
    const oldPv = structuredClone(w.cluster.persistentVolumes.get(lostClaim.spec.volumeName!)!);
    // Lost while asleep: the claim is gone, and its Retain PV is left behind, as Kubernetes leaves it.
    w.cluster.remove('persistentvolumeclaims', asleep.pvcName);
    w.advance(1_000);
    assert.ok(await recordManagedDemand(w.prisma, asleep.runnerId, w.now()));
    assert.equal((await w.drive(ownerId)).at(-1), 'FAILED');
    let failed = await w.mappingOf(ownerId);
    assert.deepEqual([failed.managementState, codeOf(failed), failed.desiredState, failed.podUid, failed.generation],
      ['FAILED', 'PVC_MISSING', 'RUNNING', null, asleep.generation], 'the wake fails: no empty volume in its place');
    const claimsCreated = w.cluster.count('create', 'persistentvolumeclaims');

    // Nobody but an administrator; an unknown runner; a malformed request. Nothing written.
    const before = state(failed);
    assert.equal((await send(undefined, failed.runnerId, request(failed, randomUUID()))).status, 401);
    const memberReply = await send(asMember, failed.runnerId, request(failed, randomUUID()));
    assert.equal(memberReply.status, 403, memberReply.text);
    const unknown = await send(asAdmin, randomUUID(), request(failed, randomUUID()));
    assert.deepEqual([unknown.status, unknown.json.code], [404, 'MANAGED_RUNNER_NOT_FOUND']);
    for (const malformed of [
      request(failed, 'not-a-uid'),
      request(failed, randomUUID(), { reason: '' }),
      { revision: failed.revision, volumeUid: randomUUID(), reason: REASON },
      request(failed, randomUUID(), { revision: 0 }),
      request(failed, randomUUID(), { confirmReplacement: 'yes' as unknown as boolean }),
    ]) {
      assert.equal((await send(asAdmin, failed.runnerId, malformed)).status, 400, JSON.stringify(malformed));
    }
    assert.deepEqual(state(await w.mappingOf(ownerId)), before);
    assert.equal((await audits(failed)).length, 0);

    await refused('nothing under its name', failed, request(failed, randomUUID()), 'VOLUME_NOT_FOUND', /^no PVC mr-data-/);

    // Another account's: marked as its runner's, bound to storage its mapping records, bound to a PV made before it.
    let wrong = restoreClaim(failed, (pvc) => {
      pvc.metadata.annotations![OWNER_ANNOTATION] = other.ownerId;
      pvc.metadata.annotations![RUNNER_ANNOTATION] = other.mapping.runnerId;
    });
    await refused("another account's runner's marks", failed, request(failed, wrong.metadata.uid!), 'VOLUME_NOT_THIS_RUNNERS', /names another owner/);
    w.cluster.remove('persistentvolumeclaims', pvcName(failed));
    w.cluster.autoBind = false;
    const bindByHand = (claim: PersistentVolumeClaim, name: string, pv: { uid: string; creationTimestamp: string; spec: PersistentVolume['spec'] }) => {
      w.cluster.persistentVolumes.set(name, { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name, uid: pv.uid, creationTimestamp: pv.creationTimestamp }, spec: pv.spec });
      w.cluster.mutate<PersistentVolumeClaim>('persistentvolumeclaims', claim.metadata.name, (pvc) => {
        pvc.spec.volumeName = name;
        pvc.status = { phase: 'Bound' };
      });
    };
    wrong = restoreClaim(failed);
    const otherPv = w.cluster.persistentVolumes.get(otherClaim.spec.volumeName!)!;
    // A second PV naming the other account's RBD image, as a static alias would.
    bindByHand(wrong, `pv-alias-${randomUUID().slice(0, 8)}`, {
      uid: randomUUID(),
      creationTimestamp: new Date().toISOString(),
      spec: { ...structuredClone(otherPv.spec), claimRef: { namespace: w.profile.kubernetes.namespace, name: pvcName(failed), uid: wrong.metadata.uid } },
    });
    await refused("storage another runner's mapping records", failed, request(failed, wrong.metadata.uid!), 'VOLUME_OF_ANOTHER_ACCOUNT',
      /another managed runner's mapping records/);
    w.cluster.remove('persistentvolumeclaims', pvcName(failed));
    wrong = restoreClaim(failed);
    // A retained PV of somebody's, rebound to the new claim by hand: made an hour before it.
    bindByHand(wrong, `pv-retained-${randomUUID().slice(0, 8)}`, {
      uid: randomUUID(),
      creationTimestamp: new Date(Date.now() - 3_600_000).toISOString(),
      spec: {
        storageClassName: w.profile.storage.className,
        claimRef: { namespace: w.profile.kubernetes.namespace, name: pvcName(failed), uid: wrong.metadata.uid },
        csi: { driver: 'rbd.csi.ceph.com', volumeHandle: `0001-0009-test-0000000000000001-${randomUUID()}` },
        persistentVolumeReclaimPolicy: 'Retain',
      },
    });
    await refused('a PV made before the claim', failed, request(failed, wrong.metadata.uid!), 'VOLUME_OF_ANOTHER_ACCOUNT', /made for another claim first/);
    w.cluster.remove('persistentvolumeclaims', pvcName(failed));

    // Not bound yet.
    wrong = restoreClaim(failed);
    await refused('not bound', failed, request(failed, wrong.metadata.uid!), 'VOLUME_NOT_BOUND', /is not bound$/);
    w.cluster.remove('persistentvolumeclaims', pvcName(failed));
    w.cluster.autoBind = true;

    // The restored claim, as the runbook makes it: under the runner's name, the manager's marks, its own new PV.
    const restored = restoreClaim(failed);
    const restoredPv = w.cluster.persistentVolumes.get(restored.spec.volumeName!)!;
    // The manager looks at a failed PVC_MISSING runner each pass: the claim under its name is not the recorded one, so it
    // is still PVC_MISSING, and nothing is adopted. Its revision moves with the operator's detail.
    assert.equal(await w.primary.reconcile(failed.id), 'FAILED');
    const looked = await w.mappingOf(ownerId);
    assert.equal(codeOf(looked), 'PVC_MISSING');
    assert.match((looked.lastError as { detail: string }).detail, /not the recorded one: PVC_CONFLICT/);
    assert.equal(looked.pvcUid, failed.pvcUid);
    const moved = await send(asAdmin, failed.runnerId, request(failed, restored.metadata.uid!));
    assert.deepEqual([moved.status, moved.json.code, moved.json.revision], [409, 'MANAGED_RUNNER_REVISION_CONFLICT', looked.revision], 'read again and decide again');
    failed = looked;

    // In use: attached to a node; a Pod admitted before the guard on it; a Pod under the runner's name; the recorded PV attached.
    attachment('csi-restored-elsewhere', restored.spec.volumeName!);
    await refused('attached to a node', failed, request(failed, restored.metadata.uid!), 'VOLUME_IN_USE', /is held by csi-restored-elsewhere$/);
    w.cluster.volumeAttachments.delete('csi-restored-elsewhere');
    const early: Pod = {
      apiVersion: 'v1', kind: 'Pod', metadata: { name: 'debug-before-the-guard' },
      spec: { containers: [], volumes: [{ name: 'data', persistentVolumeClaim: { claimName: pvcName(failed) } }] },
    };
    w.cluster.plant('pods', early);
    await refused('a Pod on it', failed, request(failed, restored.metadata.uid!), 'VOLUME_IN_USE', /is held by csi-/);
    w.cluster.remove('pods', early.metadata.name);
    w.cluster.plant('pods', { apiVersion: 'v1', kind: 'Pod', metadata: { name: managedPodName(failed.runnerId) }, spec: { containers: [] } });
    await refused("a Pod under the runner's name", failed, request(failed, restored.metadata.uid!), 'RECORDED_VOLUME_IN_USE', /^Pod mr-.* still exists$/);
    w.cluster.remove('pods', managedPodName(failed.runnerId));
    attachment('csi-recorded-still-there', oldPv.metadata.name);
    await refused('the recorded PV still attached', failed, request(failed, restored.metadata.uid!), 'RECORDED_VOLUME_IN_USE',
      /^the recorded PV .* is held by csi-recorded-still-there on node node-b/);
    w.cluster.volumeAttachments.delete('csi-recorded-still-there');

    // Another UID than the one verified; the guard missing; another manager at work on it.
    await refused('another UID', failed, request(failed, randomUUID()), 'VOLUME_NOT_VERIFIED', new RegExp(`is ${restored.metadata.uid}, not `));
    const webhook = w.cluster.admission;
    w.cluster.admission = undefined;
    await refused('no admission guard', failed, request(failed, restored.metadata.uid!), 'ADMISSION_GUARD_MISSING', /^ADMISSION_GUARD_MISSING: /);
    w.cluster.admission = webhook;
    await db.managedRunner.update({ where: { id: failed.id }, data: { leaseHolder: 'another-replica', leaseExpiresAt: new Date(w.now().getTime() + 60_000) } });
    await refused("another manager's lease", (await w.mappingOf(ownerId)), request(failed, restored.metadata.uid!), 'MAPPING_BUSY', /lease/);
    await db.managedRunner.update({ where: { id: failed.id }, data: { leaseHolder: null, leaseExpiresAt: null } });
    assert.equal(w.cluster.count('create', 'persistentvolumeclaims'), claimsCreated, 'no claim created by the manager');

    // Verified: switched.
    const body = request(failed, restored.metadata.uid!);
    const { answer, audit } = await switched(failed, body);
    const from = { pvcName: failed.pvcName, pvcUid: failed.pvcUid, pvUid: failed.pvUid, volumeHandle: failed.volumeHandle };
    const to = { pvcName: failed.pvcName, pvcUid: restored.metadata.uid, pvName: restored.spec.volumeName, pvUid: restoredPv.metadata.uid, volumeHandle: restoredPv.spec.csi!.volumeHandle };
    assert.deepEqual(answer, {
      // The wire codec's spelling of an id, and its public twin.
      runnerId: uuidToBase62(failed.runnerId),
      runnerPublicId: uuidToBase62(failed.runnerId),
      replayed: false,
      managementState: 'SLEEPING',
      desiredState: 'RUNNING',
      revision: failed.revision + 1,
      generation: failed.generation,
      from,
      to,
      switchedAt: w.now().toISOString(),
    });
    const asleepOnIt = await w.mappingOf(ownerId);
    assert.deepEqual(
      { state: asleepOnIt.managementState, pvcUid: asleepOnIt.pvcUid, pvUid: asleepOnIt.pvUid, volumeHandle: asleepOnIt.volumeHandle, lastError: asleepOnIt.lastError, podUid: asleepOnIt.podUid, generation: asleepOnIt.generation },
      { state: 'SLEEPING', pvcUid: to.pvcUid, pvUid: to.pvUid, volumeHandle: to.volumeHandle, lastError: null, podUid: null, generation: failed.generation },
    );
    assert.deepEqual(
      { actorId: audit.actorId, credentialKind: audit.credentialKind, createdAt: audit.createdAt.toISOString(), payload: audit.payload },
      {
        actorId: admin,
        credentialKind: 'LOGIN',
        createdAt: w.now().toISOString(),
        payload: {
          mappingId: failed.id,
          ownerId,
          runnerId: failed.runnerId,
          backend: 'kubernetes',
          clusterKey: failed.clusterKey,
          namespace: failed.namespace,
          generation: failed.generation,
          before: { managementState: 'FAILED', desiredState: 'RUNNING', code: 'PVC_MISSING' },
          from,
          to,
          retired: null,
          confirmedReplacement: false,
          reason: REASON,
          idempotencyKey: body.idempotencyKey,
        },
      },
      'who, when, which mapping, from which volume to which',
    );
    assert.ok(logs.some((line) => line.includes(`data volume switched by administrator ${admin} from PVC ${failed.pvcUid}`)));

    // The same request again, while a manager pass holds the mapping (as the wake its switch kicked does): answered as
    // it stands, nothing written.
    await db.managedRunner.update({ where: { id: failed.id }, data: { leaseHolder: 'the-wake-it-kicked', leaseExpiresAt: new Date(w.now().getTime() + 60_000) } });
    const again = await send(asAdmin, failed.runnerId, body);
    assert.equal(again.status, 200, again.text);
    assert.deepEqual([again.json.replayed, again.json.revision, again.json.to.pvcUid, again.json.from], [true, failed.revision + 1, to.pvcUid, null]);
    assert.equal((await audits(failed)).length, 1, 'one audit row');
    await db.managedRunner.update({ where: { id: failed.id }, data: { leaseHolder: null, leaseExpiresAt: null } });

    // The wake that was waiting: the reserved generation on the new claim, the same runner.
    assert.equal((await w.drive(ownerId)).at(-1), 'READY');
    const woken = await w.mappingOf(ownerId);
    assert.deepEqual(
      { runnerId: woken.runnerId, workspace: woken.defaultWorkspaceId, generation: woken.generation, pvcUid: woken.pvcUid, volumeHandle: woken.volumeHandle },
      { runnerId: asleep.runnerId, workspace: asleep.defaultWorkspaceId, generation: failed.generation, pvcUid: to.pvcUid, volumeHandle: to.volumeHandle },
    );
    const pod = w.cluster.object<Pod>('pods', managedPodName(woken.runnerId))!;
    assert.equal(pod.metadata.uid, woken.podUid);
    assert.deepEqual(
      [pod.metadata.annotations![PVC_UID_ANNOTATION], pod.metadata.annotations![GENERATION_ANNOTATION], pod.spec.volumes!.find((v) => v.persistentVolumeClaim)!.persistentVolumeClaim!.claimName],
      [to.pvcUid, String(failed.generation), failed.pvcName],
      'admitted for the new claim',
    );
    assert.deepEqual([...w.cluster.volumeAttachments.values()].filter((va) => va.spec.source.persistentVolumeName === to.pvName).map((va) => va.spec.nodeName), ['node-a']);
    assert.equal(w.cluster.all<Pod>('pods').filter((p) => (p.spec.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === failed.pvcName)).length, 1);
    assert.equal(w.cluster.count('create', 'persistentvolumeclaims'), claimsCreated, 'the restored claim adopted, none created');
    assert.deepEqual(w.cluster.persistentVolumes.get(oldPv.metadata.name), oldPv, 'the old PV untouched');
    const ledger = await w.ledger();
    assert.deepEqual(ledger.pool, ledger.shares, 'the pool holds exactly what the mappings record');

    // ── (2) the single writer, on the new claim ─────────────────────────────────────────────
    await st.test('(2) the single writer after the switch: the guard, the stop proof and fencing are the new claim\'s', async () => {
      const intruder = buildManagedPod({ ownerId, runnerId: woken.runnerId, generation: woken.generation, namespace: woken.namespace }, woken.pvcUid!, w.profile);
      intruder.metadata.name = 'a-second-pod';
      await assert.rejects(w.cluster.submitPod(intruder, { username: 'operator' }), /orbit-managed-runner-admission: NOT_THE_MANAGER/);
      const slept = await w.putToSleep(ownerId);
      const proof = slept.fencingReceipt as { kind: string; predecessor: { pvcUid: string; volumeHandle: string; generation: number }; retiredAt?: string };
      assert.deepEqual([proof.kind, proof.predecessor.pvcUid, proof.predecessor.volumeHandle, proof.predecessor.generation, typeof proof.retiredAt],
        ['OBSERVED_STOP', to.pvcUid, to.volumeHandle, woken.generation, 'string'], 'the stop proof names the new claim');
      assert.equal(slept.generation, woken.generation + 1);
      w.advance(1_000);
      assert.ok(await recordManagedDemand(w.prisma, slept.runnerId, w.now()));
      assert.equal((await w.drive(ownerId)).at(-1), 'READY');
      w.cluster.remove('pods', managedPodName(slept.runnerId));
      assert.equal(await w.primary.reconcile(slept.id), 'FENCING', 'a Pod gone without a report fences, as before');
      const fenced = await w.mappingOf(ownerId);
      assert.equal(codeOf(fenced), 'PREDECESSOR_STOP_UNPROVEN');
      await refused('a fenced runner', fenced, request(fenced, randomUUID(), { confirmReplacement: true }), 'NOT_SWITCHABLE', /^it is FENCING$/);
    });
  });

  // ── (3) ─────────────────────────────────────────────────────────────────────────────────────

  await t.test('(3) a disabled account\'s runner, asleep, its volume replaced as damaged: confirmed, switched, asleep until the account is enabled', async () => {
    const { ownerId } = await w.readyRunner('damaged');
    const asleep = await w.putToSleep(ownerId);
    await db.user.update({ where: { id: ownerId }, data: { disabledAt: w.now() } });
    await refused('the claim under its name is the recorded one', asleep, request(asleep, asleep.pvcUid!, { confirmReplacement: true }), 'VOLUME_ALREADY_RECORDED',
      /the recorded one$/);
    // The operator deletes the damaged claim (Retain keeps its PV and image) and restores into a new one under the name.
    w.cluster.remove('persistentvolumeclaims', asleep.pvcName);
    const restored = restoreClaim(asleep);
    await refused('not confirmed', asleep, request(asleep, restored.metadata.uid!), 'CONFIRMATION_REQUIRED', /^it is SLEEPING, not FAILED PVC_MISSING$/);
    const body = request(asleep, restored.metadata.uid!, { confirmReplacement: true });
    const { answer, audit } = await switched(asleep, body);
    assert.deepEqual([answer.managementState, answer.desiredState, answer.generation, answer.to.pvcUid], ['SLEEPING', 'SLEEPING', asleep.generation, restored.metadata.uid]);
    assert.deepEqual((audit.payload as { before: unknown; confirmedReplacement: boolean }).before, { managementState: 'SLEEPING', desiredState: 'SLEEPING', code: null });
    assert.equal((audit.payload as { confirmedReplacement: boolean }).confirmedReplacement, true);
    // Disabled: work for it records nothing and wakes nothing.
    assert.equal(await recordManagedDemand(w.prisma, asleep.runnerId, w.now()), null);
    assert.equal(await w.primary.reconcile(asleep.id), 'SLEEPING');
    assert.equal(w.cluster.object<Pod>('pods', managedPodName(asleep.runnerId)), undefined);
    // Enabled again: the next demand wakes it on the new claim.
    await db.user.update({ where: { id: ownerId }, data: { disabledAt: null } });
    w.advance(1_000);
    assert.ok(await recordManagedDemand(w.prisma, asleep.runnerId, w.now()));
    assert.equal((await w.drive(ownerId)).at(-1), 'READY');
    const woken = await w.mappingOf(ownerId);
    assert.deepEqual([woken.runnerId, woken.generation, woken.pvcUid], [asleep.runnerId, asleep.generation, restored.metadata.uid]);
    assert.equal(w.cluster.object<Pod>('pods', managedPodName(asleep.runnerId))!.metadata.annotations![PVC_UID_ANNOTATION], restored.metadata.uid);
  });

  // ── (4) ─────────────────────────────────────────────────────────────────────────────────────

  await t.test('(4) failed PVC_MISSING with its stopped Pod recorded: retired on its proof, switched, the next generation on the new claim', async () => {
    const { ownerId, mapping: ready } = await w.readyRunner('crashed');
    const runnerBefore = (await db.runner.findUnique({ where: { id: ready.runnerId } }))!;
    // It crashes, and its kubelet reports it: the manager records the stop and will start it again after the backoff.
    w.cluster.stopPod(managedPodName(ready.runnerId), 1);
    assert.equal(await w.primary.reconcile(ready.id), 'BACKOFF');
    const restarting = await w.mappingOf(ownerId);
    assert.equal(codeOf(restarting), 'POD_RESTARTING');
    // Its claim was deleted meanwhile; the gate removes the stopped Pod by UID, and then finds no volume.
    w.cluster.remove('persistentvolumeclaims', ready.pvcName);
    w.clock.ms = restarting.nextAttemptAt!.getTime() + 1;
    assert.equal(await w.primary.reconcile(ready.id), 'FAILED');
    const failed = await w.mappingOf(ownerId);
    assert.deepEqual([failed.managementState, codeOf(failed), failed.podUid, (failed.fencingReceipt as { kind: string; retiredAt?: string }).kind,
      (failed.fencingReceipt as { retiredAt?: string }).retiredAt], ['FAILED', 'PVC_MISSING', ready.podUid, 'OBSERVED_STOP', undefined]);
    assert.equal(w.cluster.object<Pod>('pods', managedPodName(ready.runnerId)), undefined, 'the stopped Pod is gone');
    const computeBefore = (await w.ledger()).pool.pods;

    const restored = restoreClaim(failed);
    const { answer, audit } = await switched(failed, request(failed, restored.metadata.uid!));
    assert.deepEqual([answer.managementState, answer.generation, answer.to.pvcUid], ['SLEEPING', failed.generation + 1, restored.metadata.uid]);
    assert.deepEqual((audit.payload as { retired: unknown }).retired, { generation: failed.generation, podUid: ready.podUid, proof: 'OBSERVED_STOP' });
    const asleepOnIt = await w.mappingOf(ownerId);
    assert.deepEqual([asleepOnIt.podUid, asleepOnIt.podName, typeof (asleepOnIt.fencingReceipt as { retiredAt?: string }).retiredAt], [null, null, 'string']);
    assert.notEqual((await db.runner.findUnique({ where: { id: ready.runnerId } }))!.tokenHash, runnerBefore.tokenHash, 'the retired credential replaced');
    assert.equal((await w.ledger()).pool.pods, computeBefore - 1, 'its compute given back, as a sleep gives it back');

    assert.equal((await w.drive(ownerId)).at(-1), 'READY');
    const woken = await w.mappingOf(ownerId);
    assert.deepEqual([woken.runnerId, woken.generation, woken.pvcUid], [ready.runnerId, failed.generation + 1, restored.metadata.uid]);
    const ledger = await w.ledger();
    assert.deepEqual(ledger.pool, ledger.shares);

    // One that failed with its Pod still running (no heartbeat by its startup deadline): its stop is not proven.
    const stuckOwner = await w.makeUser('stuck');
    await w.service.ensure(stuckOwner, 'ensure-stuck');
    let stuck = await w.mappingOf(stuckOwner);
    for (let i = 0; i < 4 && !(stuck.managementState === 'STARTING' && stuck.podUid); i += 1) {
      await w.primary.reconcile(stuck.id);
      stuck = await w.mappingOf(stuckOwner);
    }
    assert.ok(stuck.podUid, `started: ${stuck.managementState}`);
    w.clock.ms = stuck.startupDeadlineAt!.getTime() + 1;
    assert.equal(await w.primary.reconcile(stuck.id), 'FAILED');
    stuck = await w.mappingOf(stuckOwner);
    assert.deepEqual([codeOf(stuck), w.cluster.object<Pod>('pods', managedPodName(stuck.runnerId))!.status!.phase], ['STARTUP_TIMEOUT', 'Running']);
    await refused('its Pod still running', stuck, request(stuck, randomUUID(), { confirmReplacement: true }), 'RECORDED_VOLUME_IN_USE', /^nothing proves Pod .* stopped$/);
  });

  // ── (5) ─────────────────────────────────────────────────────────────────────────────────────

  await t.test('(5) a READY runner is not switched, and a server on Docker has no switch', async () => {
    const ready = await w.mappingOf(other.ownerId);
    await refused('READY', ready, request(ready, randomUUID(), { confirmReplacement: true }), 'NOT_SWITCHABLE', /^it is READY$/);

    const profile = testDockerRunnerProfile({ clusterKey: `switch-docker-${randomUUID().slice(0, 8)}` });
    const channel = new FakeDockerChannel(profile.docker.instanceId, profile.runner.image);
    const manager = new ManagedRunnerManager(w.prisma, new DockerBackend(channel, profile), profile, { holder: 'docker-replica', log: quiet });
    const runtime: ManagedRunnerRuntime = { available: true, profile, manager, worker: new ManagedRunnerWorker(manager, 60_000, quiet) };
    const docker = new ManagedRunnerService(w.prisma, ON, runtime);
    const dockerOwner = await w.makeUser('docker');
    await docker.ensure(dockerOwner, 'ensure-docker');
    const mapping = await w.mappingOf(dockerOwner);
    assert.equal(mapping.backend, 'docker');
    await assert.rejects(
      docker.switchVolume(admin, mapping.runnerId, request(mapping, randomUUID(), { confirmReplacement: true }) as ManagedRunnerVolumeSwitchDto),
      (error: { getStatus(): number; getResponse(): { check: string } }) => error.getStatus() === 409 && error.getResponse().check === 'NOT_APPLICABLE',
    );
    assert.deepEqual(state(await w.mappingOf(dockerOwner)), state(mapping));
  });
});
