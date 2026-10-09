/**
 * The single-writer gate (docs/managed-runner-design.md, "Single Pod and single writer protection"):
 * the manager against the in-memory Kubernetes namespace of `test-support/fake-kube-client.ts`, with
 * the single-Pod admission webhook's own decision installed in it, over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty. The switch is on; no cluster, kubeconfig or Ceph
 * credential is involved, and the clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-fencing.pg.spec.ts
 *
 * The first test holds the manager to the gate, each case on its own mapping:
 *   (1) a recorded Pod that vanished unobserved fences the mapping: no new generation, credential,
 *       Secret or Pod, the disk kept, the predecessor's credential revoked; more passes, more time,
 *       another replica and an owner's retry change none of it;
 *   (2) a terminal phase the kubelet did not report (PodGC's) proves nothing either;
 *   (3) a stale heartbeat, an OFFLINE runner and an expired manager lease authorize nothing;
 *   (4) the kubelet's report of the stop, the Pod deleted and the volume detached do: generation 2,
 *       a new Secret and credential, a new Pod — and not one step before the volume detaches;
 *   (5) a fencing receipt opens the gate only bound to the predecessor and its volume, and complete;
 *       even then the volume must detach first; the manager never writes a receipt;
 *   (6) two managers racing the advance make one generation, one Secret and one Pod;
 *   (7) no Pod at all without the admission guard; a failing guard admits nothing; unauthorized
 *       Pods racing the manager's — other names, no labels, the same node or another, the fixed name
 *       by someone else, a stale generation — are all refused, and only the manager's Pod exists.
 *
 * The second test runs the instance binding over HTTP through the real application (main.ts's
 * pipes, interceptors and filters): heartbeat, claim, inbox, events and the session lease routes
 * from the authorized instance only; a predecessor refused on every one; a disabled account refused
 * 403 ACCOUNT_DISABLED before any instance is considered, and served again once enabled; a
 * self-managed runner and an older managed runner as the compatibility matrix says.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Global, Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import {
  MANAGED_RUNNER_GENERATION_HEADER,
  MANAGED_RUNNER_INSTANCE_CAPABILITY,
  MANAGED_RUNNER_POD_UID_HEADER,
  toUuid,
} from '@orbit/shared';
import type { ManagedRunner, PrismaClient } from '@prisma/client';
import { json, urlencoded } from 'express';
import { Client } from 'pg';

import { DisabledAccounts } from '../auth/disabled-accounts';
import { call, type Apiserver } from '../auth/pat-test-apiserver';
import { generateToken, hashPassword, sha256 } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { outsideThePoolGateway } from '../providers/pool-gateway.controller';
import { FakeKubeCluster } from '../test-support/fake-kube-client';
import { installManagedRunnerAdmission } from '../test-support/managed-runner-admission.fixture';
import { TEST_MANAGER_USERNAME, testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import type { ConfigMap, PersistentVolume, PersistentVolumeClaim, Pod, Secret } from './kube-client';
import { MANAGED_ADMISSION_DENIAL_MARKER } from './managed-runner-admission';
import { FENCING_RECEIPT_KIND } from './managed-runner-fencing';
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import {
  GENERATION_ANNOTATION,
  bootstrapCredentialOf,
  buildManagedPod,
  managedFencingReceiptName,
  managedPodName,
  managedPvcName,
  managedSecretName,
} from './managed-runner-resources';
import { MANAGED_RUNNER_KUBE_CLIENT_FACTORY, MANAGED_RUNNER_RUNTIME, type ManagedRunnerRuntime } from './managed-runner-runtime';
import { ManagedRunnerWorker } from './managed-runner-worker';
import { ManagedRunnerService } from './managed-runner.service';

declare global {
  interface BigInt { toJSON(): string; }
}
// main.ts installs this before it creates the app; session rows carry BIGINT columns.
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const ON = { enabled: true, problem: null } as const;
const TENANT = 'system:serviceaccount:orbit-managed-test:default';

test('managed runner single-writer gate: no new generation without a stop proof or a fencing receipt', {
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
    (await db.user.create({ data: { email: `fence-${label}-${RUN}-${(users += 1)}@example.invalid`, name: label } })).id;

  /** One world: a fake cluster with the admission guard installed, a test clock, managers and the owner's service. */
  function world(lifecycle: Partial<ManagedRunnerProfile['lifecycle']> = {}) {
    const profile = testManagedRunnerProfile({ lifecycle });
    const cluster = installManagedRunnerAdmission(new FakeKubeCluster(profile.kubernetes.namespace), prisma, profile);
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
  const runnerOf = (runnerId: string) => db.runner.findUniqueOrThrow({ where: { id: runnerId } });
  /** The runner's heartbeat as the runner door records it, reporting a runtime ready (READY needs supply). */
  const heartbeat = (runnerId: string, at: Date) =>
    db.runner.update({ where: { id: runnerId }, data: { status: 'ONLINE', lastHeartbeatAt: at, engines: [{ engine: 'claude', installed: true, auth: 'yes' }] } });
  const created = (w: World, kind: 'secrets' | 'pods' | 'persistentvolumeclaims' | 'configmaps', name?: string) =>
    w.cluster.calls.filter((c) => c.op === 'create' && c.kind === kind && (name === undefined || c.name === name)).length;
  const deleted = (w: World, kind?: 'secrets' | 'pods' | 'persistentvolumeclaims' | 'configmaps') =>
    w.cluster.calls.filter((c) => c.op === 'delete' && (kind === undefined || c.kind === kind)).length;
  const credentialOf = (w: World, runnerId: string) => bootstrapCredentialOf(w.cluster.object<Secret>('secrets', managedSecretName(runnerId))!)!;
  const codeOf = (m: ManagedRunner) => (m.lastError as { code?: string } | null)?.code;

  /** Reconcile until READY, FAILED or FENCING, past every backoff, heartbeating once the Pod is recorded. */
  async function drive(w: World, ownerId: string, manager = w.primary, rounds = 40): Promise<ReconcileOutcome[]> {
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const outcome = await manager.reconcile((await mappingOf(ownerId)).id);
      outcomes.push(outcome);
      if (outcome === 'READY' || outcome === 'FAILED' || outcome === 'FENCING') return outcomes;
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

  /** What must hold of a mapping the gate refused: same generation, disk and Secret, no new instance. */
  async function assertHeld(w: World, before: ManagedRunner, credential: string, label: string) {
    const after = await mappingOf(before.ownerId);
    assert.equal(after.managementState, 'FENCING', `${label}: FENCING`);
    assert.equal(after.generation, before.generation, `${label}: no new generation`);
    assert.equal(after.pvcUid, before.pvcUid, `${label}: the same disk recorded`);
    assert.ok(w.cluster.object('persistentvolumeclaims', before.pvcName), `${label}: the disk is kept`);
    assert.equal(deleted(w, 'persistentvolumeclaims'), 0, `${label}: nothing deleted the disk`);
    const secret = w.cluster.object<Secret>('secrets', managedSecretName(before.runnerId))!;
    assert.equal(secret.metadata.annotations![GENERATION_ANNOTATION], String(before.generation), `${label}: no Secret for a new generation`);
    assert.equal(bootstrapCredentialOf(secret), credential, `${label}: no new credential issued`);
    assert.equal(created(w, 'secrets'), 1, `${label}: one Secret ever`);
    assert.equal(created(w, 'pods', managedPodName(before.runnerId)), 1, `${label}: one Pod ever`);
    return after;
  }

  /** A complete NODE_POWER_OFF receipt for the mapping's recorded instance. */
  function receipt(w: World, m: ManagedRunner, change: (r: any) => void = () => undefined) {
    const pvc = w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', m.pvcName)!;
    const pv = w.cluster.persistentVolumes.get(pvc.spec.volumeName!)! as PersistentVolume;
    const r: any = {
      schemaVersion: 1,
      kind: FENCING_RECEIPT_KIND,
      method: 'NODE_POWER_OFF',
      predecessor: {
        runnerId: m.runnerId,
        generation: m.generation,
        podName: m.podName,
        podUid: m.podUid,
        nodeName: m.nodeName,
        nodeUid: 'node-a-uid',
        pvcUid: m.pvcUid,
        volumeHandle: m.volumeHandle,
        rbdImage: { pool: pv.spec.csi!.volumeAttributes!.pool, image: pv.spec.csi!.volumeAttributes!.imageName },
      },
      action: {
        performedBy: 'storage-operator@example.invalid',
        performedAt: new Date(w.clock.ms - 120_000).toISOString(),
        description: 'node-a powered off through its BMC',
        reference: 'CHG-0001',
      },
      verification: {
        observedBy: 'infrastructure-on-call@example.invalid',
        observedAt: new Date(w.clock.ms - 60_000).toISOString(),
        result: 'POWERED_OFF',
        evidenceReference: 'BMC power state record PWR-0001',
      },
      nodePowerOff: { mechanism: 'BMC', quarantined: true, quarantineReference: 'node-a cordoned and tainted out-of-service' },
    };
    change(r);
    return r;
  }
  function leaveReceipt(w: World, m: ManagedRunner, r: unknown) {
    const name = managedFencingReceiptName(m.runnerId);
    w.cluster.remove('configmaps', name);
    w.cluster.plant<ConfigMap>('configmaps', { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name }, data: { 'receipt.json': JSON.stringify(r) } });
  }

  await t.test('(1) a Pod that vanished unobserved fences: no new generation, credential, Secret or Pod; the disk kept; nothing moves it', async () => {
    const w = world();
    const { ownerId, mapping } = await ready(w, 'vanished');
    const credential = credentialOf(w, mapping.runnerId);
    assert.equal((await runnerOf(mapping.runnerId)).tokenHash, sha256(credential));

    // An operator force-deletes the Pod object; nobody saw its containers stop.
    w.cluster.remove('pods', managedPodName(mapping.runnerId));
    assert.equal(await w.primary.reconcile(mapping.id), 'FENCING');
    const fenced = await assertHeld(w, mapping, credential, 'vanished');
    assert.equal(codeOf(fenced), 'PREDECESSOR_STOP_UNPROVEN');
    assert.equal(fenced.podUid, mapping.podUid, 'the predecessor stays recorded until its stop is proven');
    assert.notEqual((await runnerOf(mapping.runnerId)).tokenHash, sha256(credential), 'the predecessor’s credential stopped working');
    assert.equal(w.cluster.count('dryRunCreate'), 1, 'and no admission probe for a new Pod either (only the first one’s)');

    // Time, heartbeats gone stale, another replica after the lease expired: still nothing.
    await db.runner.update({ where: { id: mapping.runnerId }, data: { status: 'OFFLINE' } });
    w.advance(3 * 3600_000);
    assert.equal(await w.manager('replica-b').reconcile(mapping.id), 'FENCING');
    for (let i = 0; i < 3; i += 1) {
      w.advance(600_000);
      assert.equal(await w.primary.reconcile(mapping.id), 'FENCING');
    }
    await assertHeld(w, mapping, credential, 'after time and another replica');

    // The owner cannot retry past it.
    const status = await w.service.status(ownerId);
    assert.equal(status.managementState, 'FENCING');
    assert.equal(status.reason?.code, 'PREDECESSOR_STOP_UNPROVEN');
    assert.equal(status.actions.canRetry, false);
    await assert.rejects(w.service.retry(ownerId, 'retry-fenced', (await mappingOf(ownerId)).revision),
      (e: any) => e.getStatus() === 409 && e.getResponse().code === 'MANAGED_RUNNER_TRANSITION_REFUSED');
    await assertHeld(w, mapping, credential, 'after an owner’s retry');
  });

  await t.test('(2) a terminal phase the control plane wrote (PodGC) is not the kubelet’s report: FENCING', async () => {
    const w = world();
    const { mapping } = await ready(w, 'podgc');
    const credential = credentialOf(w, mapping.runnerId);
    w.cluster.markFailedByControlPlane(managedPodName(mapping.runnerId));
    assert.equal(await w.primary.reconcile(mapping.id), 'FENCING');
    const fenced = await assertHeld(w, mapping, credential, 'podgc');
    assert.equal(codeOf(fenced), 'PREDECESSOR_STOP_UNPROVEN');
    assert.equal(fenced.fencingReceipt, null, 'no stop proof recorded');
    // PodGC then removes the object: still no proof.
    w.cluster.remove('pods', managedPodName(mapping.runnerId));
    assert.equal(await w.primary.reconcile(mapping.id), 'FENCING');
    await assertHeld(w, mapping, credential, 'podgc, removed');
  });

  await t.test('(3) a stale heartbeat, an OFFLINE runner and an expired lease authorize nothing', async () => {
    const w = world();
    const { ownerId, mapping } = await ready(w, 'silent');
    const credential = credentialOf(w, mapping.runnerId);
    // The reaper's view of a runner silent for an hour; this replica's lease long expired.
    await db.runner.update({ where: { id: mapping.runnerId }, data: { status: 'OFFLINE', lastHeartbeatAt: new Date(w.clock.ms - 3600_000) } });
    await db.managedRunner.update({ where: { id: mapping.id }, data: { leaseHolder: 'replica-gone', leaseExpiresAt: new Date(w.clock.ms - 1) } });
    w.advance(3600_000);
    for (const replica of [w.manager('replica-b'), w.primary, w.manager('replica-c')]) {
      assert.equal(await replica.reconcile(mapping.id), 'READY', 'READY and unusable: not proof the instance died');
    }
    const after = await mappingOf(ownerId);
    assert.equal(after.generation, 1);
    assert.equal(after.podUid, mapping.podUid);
    assert.equal(credentialOf(w, mapping.runnerId), credential);
    assert.equal((await runnerOf(mapping.runnerId)).tokenHash, sha256(credential), 'the instance keeps its credential');
    assert.equal(created(w, 'pods'), 1);
    assert.equal(deleted(w), 0, 'nothing was deleted');
    assert.equal((await w.service.status(ownerId)).usable, false);
    await assert.rejects(w.service.retry(ownerId, 'retry-silent', after.revision), (e: any) => e.getStatus() === 409);
  });

  await t.test('(4) the kubelet’s report, the Pod deleted and the volume detached authorize generation 2 — not one step before the volume detaches', async () => {
    const w = world();
    const { ownerId, mapping } = await ready(w, 'replace');
    const credential = credentialOf(w, mapping.runnerId);
    const pvName = w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', mapping.pvcName)!.spec.volumeName!;
    assert.equal(w.cluster.all('pods').length, 1);
    assert.equal([...w.cluster.volumeAttachments.values()].filter((va) => va.spec.source.persistentVolumeName === pvName).length, 1);

    w.cluster.stopPod(managedPodName(mapping.runnerId), 1);
    assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
    const stopped = await mappingOf(ownerId);
    assert.equal(codeOf(stopped), 'POD_TERMINATED');
    assert.equal((stopped.fencingReceipt as { kind: string }).kind, 'OBSERVED_STOP');

    // The volume does not detach: the retry releases the Pod and then waits.
    w.cluster.autoDetach = false;
    await w.service.retry(ownerId, 'retry-replace', stopped.revision);
    const waiting = await drive(w, ownerId, w.primary, 6);
    assert.equal(waiting.at(-1), 'WAITING', waiting.join(' → '));
    const held = await mappingOf(ownerId);
    assert.equal(held.managementState, 'REQUESTED');
    assert.equal(codeOf(held), 'VOLUME_STILL_ATTACHED');
    assert.equal(held.generation, 1, 'no generation while the volume is attached');
    assert.equal(w.cluster.all('pods').length, 0, 'the stopped Pod was deleted');
    assert.equal(deleted(w, 'pods'), 1);
    assert.equal(credentialOf(w, mapping.runnerId), credential, 'no new credential yet');
    assert.equal(created(w, 'pods'), 1, 'no new Pod yet');

    w.cluster.detach(pvName);
    const outcomes = await drive(w, ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const replaced = await mappingOf(ownerId);
    assert.equal(replaced.generation, 2);
    assert.notEqual(replaced.podUid, mapping.podUid);
    assert.equal(replaced.pvcUid, mapping.pvcUid, 'the same data volume');
    const proof = replaced.fencingReceipt as { kind: string; retiredAt: string; predecessor: { generation: number; podUid: string } };
    assert.equal(proof.kind, 'OBSERVED_STOP');
    assert.ok(proof.retiredAt);
    assert.deepEqual([proof.predecessor.generation, proof.predecessor.podUid], [1, mapping.podUid]);
    const secret = w.cluster.object<Secret>('secrets', managedSecretName(mapping.runnerId))!;
    assert.equal(secret.metadata.annotations![GENERATION_ANNOTATION], '2');
    assert.notEqual(bootstrapCredentialOf(secret), credential);
    assert.equal((await runnerOf(mapping.runnerId)).tokenHash, sha256(bootstrapCredentialOf(secret)!));
    assert.equal(w.cluster.object<Pod>('pods', managedPodName(mapping.runnerId))!.metadata.annotations![GENERATION_ANNOTATION], '2');
    assert.deepEqual([deleted(w, 'pods'), deleted(w, 'secrets'), deleted(w, 'persistentvolumeclaims')], [1, 1, 0]);

    // A stale manager re-creating generation 1's Pod is refused by the guard, against the live reservation.
    await assert.rejects(
      w.cluster.submitPod(buildManagedPod({ ownerId, runnerId: mapping.runnerId, generation: 1, namespace: mapping.namespace }, mapping.pvcUid!, w.profile), { username: TEST_MANAGER_USERNAME }),
      (e: Error) => e.message.includes(MANAGED_ADMISSION_DENIAL_MARKER) && /NOT_THE_RESERVED_GENERATION|NOT_RESERVED/.test(e.message),
    );
  });

  await t.test('(5) a fencing receipt opens the gate only bound to the predecessor and its volume, and complete; the volume must still detach', async () => {
    const w = world();
    const { ownerId, mapping } = await ready(w, 'receipt');
    const credential = credentialOf(w, mapping.runnerId);
    const pvName = w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', mapping.pvcName)!.spec.volumeName!;
    // The node is lost: the Pod object goes (PodGC after the out-of-service taint), the attachment stays.
    w.cluster.autoDetach = false;
    w.cluster.remove('pods', managedPodName(mapping.runnerId));
    assert.equal(await w.primary.reconcile(mapping.id), 'FENCING');
    assert.equal(await w.primary.reconcile(mapping.id), 'FENCING', 'no receipt yet');

    const rejected: Array<[string, (r: any) => void, RegExp]> = [
      ['another Pod', (r) => void (r.predecessor.podUid = randomUUID()), /predecessor\.podUid/],
      ['another generation', (r) => void (r.predecessor.generation = 2), /predecessor\.generation/],
      ['another volume', (r) => void (r.predecessor.volumeHandle = 'other-handle'), /predecessor\.volumeHandle/],
      ['another RBD image', (r) => void (r.predecessor.rbdImage.image = 'csi-vol-other'), /rbdImage\.image/],
      ['another node', (r) => void (r.predecessor.nodeName = 'node-b'), /predecessor\.nodeName/],
      ['no independent observation', (r) => void delete r.verification, /verification\./],
      ['observed before it was done', (r) => void (r.verification.observedAt = new Date(w.clock.ms - 600_000).toISOString()), /before action\.performedAt/],
      ['not quarantined', (r) => void (r.nodePowerOff.quarantined = false), /quarantined/],
      ['a temporary blocklist', (r) => {
        r.method = 'STORAGE_FENCE';
        r.verification.result = 'CLIENTS_BLOCKLISTED';
        delete r.nodePowerOff;
        r.storageFence = {
          procedureReference: 'storage-fence-procedure-v1',
          blocklistedClients: [{ address: '10.0.0.10:0', nonce: '1234' }],
          osdMapEpoch: 812,
          propagationVerifiedAt: new Date(w.clock.ms - 30_000).toISOString(),
          persistent: false,
          expiresAt: new Date(w.clock.ms + 3600_000).toISOString(),
          rejoinPolicy: 'node rejoins only after reinstall',
        };
      }, /storageFence\.(persistent|expiresAt)/],
      ['from the future', (r) => void (r.action.performedAt = new Date(w.clock.ms + 3600_000).toISOString()), /in the future/],
    ];
    for (const [label, change, why] of rejected) {
      leaveReceipt(w, mapping, receipt(w, mapping, change));
      assert.equal(await w.primary.reconcile(mapping.id), 'FENCING', label);
      const after = await assertHeld(w, mapping, credential, label);
      assert.equal(codeOf(after), 'FENCING_RECEIPT_INVALID', label);
      assert.match((after.lastError as { detail: string }).detail, why, label);
      assert.equal(after.fencingReceipt, null, `${label}: nothing recorded`);
    }

    // A complete receipt for this instance and volume: recorded, and the gate still waits for the volume.
    leaveReceipt(w, mapping, receipt(w, mapping));
    assert.equal(await w.primary.reconcile(mapping.id), 'FENCING');
    const recorded = await assertHeld(w, mapping, credential, 'valid receipt, volume attached');
    assert.equal(codeOf(recorded), 'VOLUME_STILL_ATTACHED');
    assert.equal((recorded.fencingReceipt as { kind: string }).kind, 'FENCING_RECEIPT');

    w.cluster.detach(pvName);
    const outcomes = await drive(w, ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const replaced = await mappingOf(ownerId);
    assert.equal(replaced.generation, 2);
    const proof = replaced.fencingReceipt as { kind: string; retiredAt: string; receipt: { method: string }; source: { configMap: string } };
    assert.equal(proof.kind, 'FENCING_RECEIPT');
    assert.equal(proof.receipt.method, 'NODE_POWER_OFF');
    assert.equal(proof.source.configMap, managedFencingReceiptName(mapping.runnerId));
    assert.ok(proof.retiredAt);
    assert.notEqual(credentialOf(w, mapping.runnerId), credential);
    assert.equal(created(w, 'configmaps') + deleted(w, 'configmaps'), 0, 'the manager neither writes nor removes a receipt');
    // The receipt still lying there is generation 1's: it opens nothing for generation 2.
    w.cluster.remove('pods', managedPodName(mapping.runnerId));
    assert.equal(await w.primary.reconcile(mapping.id), 'FENCING');
    assert.equal((await mappingOf(ownerId)).generation, 2, 'a used receipt is not a receipt for the next generation');
  });

  await t.test('(6) two managers racing the advance make one generation, one Secret and one Pod', async () => {
    const w = world();
    const { ownerId, mapping } = await ready(w, 'race');
    w.cluster.stopPod(managedPodName(mapping.runnerId), 0);
    assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
    await w.service.retry(ownerId, 'retry-race', (await mappingOf(ownerId)).revision);
    const a = w.manager('replica-a', 3);
    const b = w.manager('replica-b', 5);
    await Promise.all([drive(w, ownerId, a), drive(w, ownerId, b)]);
    await drive(w, ownerId, a);
    const after = await mappingOf(ownerId);
    assert.equal(after.managementState, 'READY');
    assert.equal(after.generation, 2, 'advanced exactly once');
    assert.equal(created(w, 'secrets'), 2, 'one Secret per generation');
    assert.equal(created(w, 'pods', managedPodName(mapping.runnerId)), 2, 'one Pod per generation');
    assert.deepEqual([deleted(w, 'pods'), deleted(w, 'secrets')], [1, 1]);
  });

  await t.test('(7) no Pod without the admission guard; a failing guard admits nothing; unauthorized Pods racing the manager are all refused', async () => {
    // No guard installed: the dry run is admitted, so nothing is created.
    {
      const w = world();
      w.cluster.admission = undefined;
      const ownerId = await makeUser('no-guard');
      await w.service.ensure(ownerId, 'ensure');
      assert.equal((await drive(w, ownerId)).at(-1), 'FAILED');
      const failed = await mappingOf(ownerId);
      assert.equal(codeOf(failed), 'ADMISSION_GUARD_MISSING');
      assert.equal(created(w, 'pods'), 0, 'no Pod where the guard is not in force');
      assert.equal((failed.lastError as { retryable: boolean }).retryable, true);
      // The operator installs it; a retry starts the instance.
      installManagedRunnerAdmission(w.cluster, prisma, w.profile);
      await w.service.retry(ownerId, 'retry-guard', failed.revision);
      assert.equal((await drive(w, ownerId)).at(-1), 'READY');
      assert.equal(created(w, 'pods'), 1);
    }
    // A guard that cannot answer (its database is down): the probe and every Pod fail closed.
    {
      const w = world({ maxAttempts: 2 });
      w.cluster.admission = async () => {
        throw new Error('the admission database is unavailable');
      };
      const ownerId = await makeUser('failing-guard');
      await w.service.ensure(ownerId, 'ensure');
      const outcomes = await drive(w, ownerId);
      assert.ok(outcomes.includes('BACKOFF'), outcomes.join(' → '));
      assert.equal(codeOf(await mappingOf(ownerId)), 'RETRY_EXHAUSTED');
      assert.equal(created(w, 'pods'), 0);
      const mapping = await mappingOf(ownerId);
      await assert.rejects(w.cluster.submitPod(buildManagedPod({ ownerId, runnerId: mapping.runnerId, generation: 1, namespace: mapping.namespace }, mapping.pvcUid!, w.profile), { username: TEST_MANAGER_USERNAME }),
        (e: any) => e.status === 500);
      assert.equal(w.cluster.all('pods').length, 0);
    }
    // Unauthorized Pods racing the manager's own create: names, labels, nodes and identities.
    {
      const w = world();
      const ownerId = await makeUser('race-admission');
      await w.service.ensure(ownerId, 'ensure');
      const mapping = await mappingOf(ownerId);
      const claim = managedPvcName(mapping.runnerId);
      const intruder = (name: string, nodeName?: string, labels?: Record<string, string>): Pod => ({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name, ...(labels ? { labels } : {}) },
        spec: {
          ...(nodeName ? { nodeName } : {}),
          containers: [{ name: 'c', image: 'busybox' }],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: claim } }],
        },
      });
      const attempts: Array<[string, () => Promise<Pod>]> = [
        ['another name', () => w.cluster.submitPod(intruder('copy-data'), { username: TENANT })],
        ['unlabelled', () => w.cluster.submitPod(intruder('bare'), { username: TENANT })],
        ['same node', () => w.cluster.submitPod(intruder('same-node', 'node-a'), { username: TENANT })],
        ['another node', () => w.cluster.submitPod(intruder('other-node', 'node-b'), { username: TENANT })],
        ['labelled like a runner', () => w.cluster.submitPod(intruder('impostor', undefined, { 'app.kubernetes.io/name': 'orbit-managed-runner' }), { username: TENANT })],
        ['the fixed name, by someone else', () => w.cluster.submitPod(intruder(managedPodName(mapping.runnerId)), { username: TENANT })],
        ['a Job’s Pod', () => w.cluster.submitPod(intruder('restore-job-abc12'), { username: 'system:serviceaccount:kube-system:job-controller' })],
        ['a stale generation, as the manager', () => w.cluster.submitPod(buildManagedPod({ ownerId, runnerId: mapping.runnerId, generation: 2, namespace: mapping.namespace }, 'pvc-uid-not-yet-known', w.profile), { username: TEST_MANAGER_USERNAME })],
      ];
      const [driven, ...settled] = await Promise.all([
        drive(w, ownerId),
        ...attempts.map(async ([label, attempt]) => {
          try {
            await attempt();
            return `${label}: admitted`;
          } catch (error) {
            return (error as Error).message.includes(MANAGED_ADMISSION_DENIAL_MARKER) ? null : `${label}: ${(error as Error).message}`;
          }
        }),
      ]);
      assert.equal((driven as ReconcileOutcome[]).at(-1), 'READY');
      assert.deepEqual(settled.filter(Boolean), [], 'every unauthorized Pod was refused by the guard');
      const pods = w.cluster.all<Pod>('pods');
      assert.equal(pods.length, 1, 'one Pod uses the volume');
      assert.equal(pods[0].metadata.uid, (await mappingOf(ownerId)).podUid, 'the manager’s');
      // Once it is recorded, even the manager cannot create another under the fixed name and generation.
      await assert.rejects(
        w.cluster.submitPod(buildManagedPod({ ownerId, runnerId: mapping.runnerId, generation: 1, namespace: mapping.namespace }, (await mappingOf(ownerId)).pvcUid!, w.profile), { username: TEST_MANAGER_USERNAME }),
        (e: Error) => e.message.includes('NOT_RESERVED'),
      );
      // Nor attach a debug container to it.
      await assert.rejects(
        w.cluster.updatePod(managedPodName(mapping.runnerId), (pod) => void (pod.spec.ephemeralContainers = [{ name: 'debug', image: 'busybox' }]), { username: TENANT, subResource: 'ephemeralcontainers' }),
        (e: Error) => e.message.includes('EPHEMERAL_CONTAINER'),
      );
    }
  });
});

test('managed runner instance binding over HTTP: the authorized instance only, a predecessor refused, self-managed runners unchanged', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-managed-fencing-'));
  const JWT_SECRET = randomBytes(32).toString('hex');
  const PASSWORD = 'correct horse battery staple';
  // Passes run when this test says, never on a timer: the worker is stopped right after boot.
  const profile = testManagedRunnerProfile({ lifecycle: { pollIntervalSeconds: 3600 } });
  const cluster = installManagedRunnerAdmission(new FakeKubeCluster(profile.kubernetes.namespace), prisma, profile);
  const realClient: string[] = [];
  const savedEnv = process.env;
  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close().catch(() => undefined);
    process.env = savedEnv;
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  });

  const home = path.join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  const profilePath = path.join(scratch, 'profile.json');
  writeFileSync(profilePath, JSON.stringify(profile));
  process.env = {
    PATH: savedEnv.PATH,
    NO_COLOR: '1',
    TMPDIR: scratch,
    HOME: home,
    ORBIT_HOME: path.join(home, '.orbit'),
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    DATABASE_URL: url,
    JWT_SECRET,
    ORBIT_MANAGED_RUNNERS_ENABLED: 'true',
    ORBIT_MANAGED_RUNNERS_PROFILE: profilePath,
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const kubeHttp = require('./kube-http-client') as { kubeClientFromProfile: unknown };
  kubeHttp.kubeClientFromProfile = () => {
    realClient.push('kubeClientFromProfile');
    throw new Error('tripwire: the real Kubernetes client was constructed');
  };
  const { AppModule } = await import('../app.module.js');
  @Global()
  @Module({ providers: [{ provide: MANAGED_RUNNER_KUBE_CLIENT_FACTORY, useValue: () => cluster.client() }], exports: [MANAGED_RUNNER_KUBE_CLIENT_FACTORY] })
  class FakeEnvironment {}
  @Module({ imports: [FakeEnvironment, AppModule] })
  class Harness {}
  // main.ts, step for step.
  app = await NestFactory.create(Harness, { bodyParser: false, logger: ['error'], abortOnError: false });
  app.use(outsideThePoolGateway(json({ limit: '10mb' })));
  app.use(outsideThePoolGateway(urlencoded({ extended: true, limit: '10mb' })));
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const adapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(adapter), adapter));
  await app.listen(0, '127.0.0.1');
  const server = { port: Number(new globalThis.URL((await app.getUrl()).replace('[::1]', '127.0.0.1')).port) } as Apiserver;
  const runtime = app.get<ManagedRunnerRuntime | null>(MANAGED_RUNNER_RUNTIME);
  assert.equal(runtime?.available, true);
  if (!runtime?.available) return;
  await runtime.worker.stop();
  const manager = runtime.manager;

  const mappingOf = async (ownerId: string): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId } }))!;
  const credentialOf = (runnerId: string) => bootstrapCredentialOf(cluster.object<Secret>('secrets', managedSecretName(runnerId))!)!;
  /** What a managed runner sends: the instance its Pod is (runner-go managed_instance.go). */
  const instance = (generation: string, podUid: string): Record<string, string> => ({
    'x-orbit-runner-capabilities': `session-worktree-ops-v1,${MANAGED_RUNNER_INSTANCE_CAPABILITY}`,
    [MANAGED_RUNNER_GENERATION_HEADER]: generation,
    [MANAGED_RUNNER_POD_UID_HEADER]: podUid,
  });
  const podInstance = (runnerId: string) => {
    const pod = cluster.object<Pod>('pods', managedPodName(runnerId))!;
    return instance(pod.metadata.annotations![GENERATION_ANNOTATION], pod.metadata.uid!);
  };
  const engines = [{ engine: 'codex', installed: true, auth: 'yes' }];
  async function reconcileUntil(ownerId: string, done: (m: ManagedRunner) => boolean, label: string, onPod?: () => Promise<void>): Promise<ManagedRunner> {
    for (let i = 0; i < 40; i += 1) {
      const m = await mappingOf(ownerId);
      if (done(m)) return m;
      await manager.reconcile(m.id);
      const after = await mappingOf(ownerId);
      if (after.podUid && after.managementState === 'STARTING' && onPod) await onPod();
    }
    assert.fail(`${label}: ${JSON.stringify(await mappingOf(ownerId))}`);
  }

  /** The runner-door calls a managed runner makes all the time, each with `credential` and `headers`. */
  function runnerCalls(sessionId: string): Array<[string, string, string, unknown]> {
    return [
      ['heartbeat', 'POST', '/api/runner/heartbeat', { engines, version: '0.1.0' }],
      ['claim', 'GET', '/api/runner/sessions/claim', undefined],
      ['inbox', 'GET', `/api/runner/sessions/${sessionId}/inbox`, undefined],
      ['events', 'POST', `/api/runner/sessions/${sessionId}/events`, { events: [] }],
      ['takeover leases', 'POST', `/api/runner/sessions/${sessionId}/takeover-leases`, {}],
      ['activate leases', 'POST', `/api/runner/sessions/${sessionId}/activate-leases`, {}],
      ['release leases', 'POST', `/api/runner/sessions/${sessionId}/release-leases`, {}],
      ['turn complete', 'POST', `/api/runner/sessions/${sessionId}/turn-complete`, {}],
      ['finalize', 'POST', `/api/runner/sessions/${sessionId}/finalize`, {}],
      ['session read (session guard)', 'GET', `/api/runner/sessions/${sessionId}/meta`, undefined],
    ];
  }
  const refusalCode = (reply: { status: number; json: any }) => (reply.status === 401 ? 'UNAUTHENTICATED' : reply.json?.code);

  // A managed runner brought up to READY by the manager, heartbeating over HTTP as its Pod.
  const owner = await db.user.create({ data: { email: `fence-http-${RUN}@example.invalid`, name: 'owner', passwordHash: hashPassword(PASSWORD) } });
  const signedIn = await call(server, 'POST', '/api/auth/login', undefined, { email: owner.email, password: PASSWORD });
  assert.equal(signedIn.status, 201, signedIn.text);
  const token = signedIn.json.accessToken as string;
  const first = await reconcileUntil(owner.id, (m) => m.managementState === 'READY', 'READY', async () => {
    const m = await mappingOf(owner.id);
    const beat = await call(server, 'POST', '/api/runner/heartbeat', credentialOf(m.runnerId), { engines, version: '0.1.0' }, podInstance(m.runnerId));
    assert.equal(beat.status, 201, `the authorized instance’s heartbeat: ${beat.text}`);
  });
  const generation1 = { credential: credentialOf(first.runnerId), headers: podInstance(first.runnerId) };
  const workspaceId = (await call(server, 'GET', '/api/workspaces', token)).json.find((w: { id: string }) => toUuid(w.id) === first.defaultWorkspaceId).id;
  const session = await call(server, 'POST', '/api/sessions', token, { workspaceId, prompt: 'hello', title: 'fence' });
  assert.equal(session.status, 201, session.text);
  const sessionId = toUuid(session.json.id);

  await t.test('(H1) the authorized instance: heartbeat, claim, inbox, events and lease calls pass the guard', async () => {
    const claim = await call(server, 'GET', '/api/runner/sessions/claim', generation1.credential, undefined, generation1.headers);
    assert.equal(claim.status, 200, claim.text);
    assert.equal(toUuid(claim.json.sessionId), sessionId, 'the managed runner claimed its session');
    for (const [label, method, route, body] of runnerCalls(sessionId)) {
      if (label === 'claim' || label === 'inbox') continue; // long polls; the claim was just made
      const reply = await call(server, method, route, generation1.credential, body, generation1.headers);
      assert.ok(![401, 403, 503].includes(reply.status) || !/MANAGED_RUNNER_INSTANCE/.test(reply.text), `${label}: ${reply.status} ${reply.text}`);
    }
    // An instance with no declaration — an older runner image, or the credential copied elsewhere.
    const old = await call(server, 'POST', '/api/runner/heartbeat', generation1.credential, { engines });
    assert.equal(old.status, 403);
    assert.equal(old.json.code, 'MANAGED_RUNNER_INSTANCE_REQUIRED');
    // Another Pod presenting the right generation.
    const other = await call(server, 'POST', '/api/runner/heartbeat', generation1.credential, { engines }, instance('1', randomUUID()));
    assert.equal(other.status, 403);
    assert.equal(other.json.code, 'MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED');
  });

  await t.test('(H1b) a disabled account’s managed runner is refused 403 ACCOUNT_DISABLED even from its authorized instance; enabled again, it is served', async () => {
    // As an administrator's change does (X1), the account state is written and the JWT door's view
    // of disabled accounts read again; the runner doors read the owner's state with every request.
    const setDisabled = async (disabledAt: Date | null) => {
      await db.user.update({ where: { id: owner.id }, data: { disabledAt } });
      await app!.get(DisabledAccounts, { strict: false }).reload();
    };
    await setDisabled(new Date());
    // RunnerAuthGuard (heartbeat, claim) and RunnerSessionAuthGuard (a session read), with the
    // authorized instance's own credential, generation and Pod UID: the account answers first.
    for (const [label, method, route, body] of [
      ['heartbeat', 'POST', '/api/runner/heartbeat', { engines, version: '0.1.0' }],
      ['claim', 'GET', '/api/runner/sessions/claim', undefined],
      ['session read (session guard)', 'GET', `/api/runner/sessions/${sessionId}/meta`, undefined],
    ] as const) {
      const refused = await call(server, method, route, generation1.credential, body, generation1.headers);
      assert.equal(refused.status, 403, `${label}: ${refused.text}`);
      assert.equal(refused.json.code, 'ACCOUNT_DISABLED', label);
    }
    // Enabled again: the same instance is served, and the instance check still applies after it.
    await setDisabled(null);
    const beat = await call(server, 'POST', '/api/runner/heartbeat', generation1.credential, { engines, version: '0.1.0' }, generation1.headers);
    assert.equal(beat.status, 201, beat.text);
    const meta = await call(server, 'GET', `/api/runner/sessions/${sessionId}/meta`, generation1.credential, undefined, generation1.headers);
    assert.ok(meta.status !== 401 && meta.status !== 403, `session read: ${meta.status} ${meta.text}`);
    const other = await call(server, 'POST', '/api/runner/heartbeat', generation1.credential, { engines }, instance('1', randomUUID()));
    assert.equal(other.status, 403);
    assert.equal(other.json.code, 'MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED');
  });

  await t.test('(H2) after its stop is proven and generation 2 starts, every call of generation 1 is refused', async () => {
    cluster.stopPod(managedPodName(first.runnerId), 0);
    await manager.reconcile(first.id);
    const failed = await mappingOf(owner.id);
    assert.equal(failed.managementState, 'FAILED');
    const retried = await call(server, 'POST', '/api/managed-runner/retry', token, { idempotencyKey: 'retry-h2', revision: failed.revision });
    assert.equal(retried.status, 202, retried.text);
    const second = await reconcileUntil(owner.id, (m) => m.managementState === 'READY', 'generation 2 READY', async () => {
      const m = await mappingOf(owner.id);
      const beat = await call(server, 'POST', '/api/runner/heartbeat', credentialOf(m.runnerId), { engines, version: '0.1.0' }, podInstance(m.runnerId));
      assert.equal(beat.status, 201, beat.text);
    });
    assert.equal(second.generation, 2);
    const generation2 = { credential: credentialOf(second.runnerId), headers: podInstance(second.runnerId) };
    assert.notEqual(generation2.credential, generation1.credential);

    for (const [label, method, route, body] of runnerCalls(sessionId)) {
      // The late predecessor itself: its credential was replaced when its generation was retired.
      const late = await call(server, method, route, generation1.credential, body, generation1.headers);
      assert.equal(refusalCode(late), 'UNAUTHENTICATED', `${label}: the retired credential`);
      // Generation 2's credential in generation 1's hands still names generation 1.
      const replayed = await call(server, method, route, generation2.credential, body, generation1.headers);
      assert.equal(replayed.status, 403, `${label}: ${replayed.text}`);
      assert.equal(replayed.json.code, 'MANAGED_RUNNER_INSTANCE_SUPERSEDED', label);
    }
    const beat = await call(server, 'POST', '/api/runner/heartbeat', generation2.credential, { engines }, generation2.headers);
    assert.equal(beat.status, 201, 'generation 2 itself is served');
  });

  await t.test('(H3) a fenced instance’s credential stops working at once', async () => {
    const m = await mappingOf(owner.id);
    const live = { credential: credentialOf(m.runnerId), headers: podInstance(m.runnerId) };
    cluster.remove('pods', managedPodName(m.runnerId));
    assert.equal(await manager.reconcile(m.id), 'FENCING');
    for (const [label, method, route, body] of runnerCalls(sessionId)) {
      const reply = await call(server, method, route, live.credential, body, live.headers);
      assert.equal(reply.status, 401, `${label}: ${reply.text}`);
    }
  });

  await t.test('(H4) a self-managed runner keeps its protocol: no instance needed, and any instance it sends is ignored', async () => {
    const runnerToken = generateToken(32);
    await db.runner.create({ data: { ownerId: owner.id, name: 'laptop', tokenHash: sha256(runnerToken), status: 'ONLINE', maxConcurrent: 1 } });
    for (const headers of [{}, instance('1', randomUUID()), instance('9', randomUUID())]) {
      const beat = await call(server, 'POST', '/api/runner/heartbeat', runnerToken, { version: '0.1.0' }, headers);
      assert.equal(beat.status, 201, beat.text);
      const rotated = await call(server, 'GET', '/api/runner/me', runnerToken, undefined, headers);
      assert.equal(rotated.status, 200, rotated.text);
    }
    // And the owner rotates its credential as before — never the managed runner's.
    const me = await db.runner.findFirstOrThrow({ where: { tokenHash: sha256(runnerToken) } });
    assert.equal((await call(server, 'POST', `/api/runners/${me.id}/rotate-token`, token)).status, 201);
    const managed = await mappingOf(owner.id);
    const refused = await call(server, 'POST', `/api/runners/${managed.runnerId}/rotate-token`, token);
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'MANAGED_RUNNER_ROTATE_REFUSED');
  });

  await t.test('(H5) the admission webhook over HTTP: the API server’s token and a review in, a decision out', async () => {
    const review = (object: Pod, username: string) => ({
      apiVersion: 'admission.k8s.io/v1',
      kind: 'AdmissionReview',
      request: { uid: randomUUID(), resource: { group: '', version: 'v1', resource: 'pods' }, operation: 'CREATE', namespace: profile.kubernetes.namespace, name: object.metadata.name, userInfo: { username }, object },
    });
    const m = await mappingOf(owner.id);
    const intruder = buildManagedPod({ ownerId: owner.id, runnerId: m.runnerId, generation: m.generation, namespace: m.namespace }, m.pvcUid!, profile);
    intruder.metadata.name = 'copy-of-the-runner';
    assert.equal((await call(server, 'POST', '/api/managed-runner/admission', undefined, review(intruder, TENANT))).status, 401, 'no token: the API server refuses the Pod');
    const decided = await call(server, 'POST', '/api/managed-runner/admission', 'test-admission-webhook-token', review(intruder, TENANT));
    assert.equal(decided.status, 200, decided.text);
    assert.equal(decided.json.response.allowed, false);
    assert.match(decided.json.response.status.message, /^orbit-managed-runner-admission: NOT_THE_MANAGER: /);
  });

  await t.test('(H6) shutdown: the real Kubernetes client was never built', async () => {
    await app!.close();
    app = undefined;
    assert.deepEqual(realClient, []);
  });
});
