/**
 * The drive's wiring on the manager's side (docs/drive-technical-design.md §4.3, §6.1, §8.2):
 * with a profile that gives runners the drive, the manager issues each generation's mount credential with its runner
 * credential and writes it into Secret `mrf-<runner uuid>` of the files namespace before it creates the Pod; the Pod
 * carries the one drive volume and the admission guard admits it; retiring the generation (sleep) revokes the
 * credential, and the next generation's replaces the Secret. The manager against the in-memory Kubernetes namespace of
 * `test-support/fake-kube-client.ts`, with the single-Pod admission guard installed, over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-drive-mount.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { managedRunnerWorld } from '../test-support/managed-runner-world';
import type { Pod, Secret } from './kube-client';
import { bootstrapCredentialOf, driveMountSecretName, managedPodName, managedSecretName, secretGeneration } from './managed-runner-resources';
import { recordManagedDemand } from './managed-runner-work';

const URL = process.env.COORDINATOR_PG_URL;

test('the manager delivers each generation its mount credential, for the CSI plugin only', {
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

  const liveCredentials = (runnerId: string) =>
    db.driveMountCredential.findMany({ where: { runnerId, revokedAt: null }, orderBy: { createdAt: 'asc' } });

  await t.test('a generation gets its Secret before its Pod, and the Pod gets the drive', async () => {
    const w = managedRunnerWorld(db, { files: true });
    const { mapping } = await w.readyRunner('drive-owner');
    const secret = w.cluster.object<Secret>('drivesecrets', driveMountSecretName(mapping.runnerId))!;
    assert.ok(secret, 'Secret mrf-<runner uuid> is written');
    assert.equal(secret.metadata.namespace, 'orbit-drive-test', 'in the files namespace');
    assert.equal(w.cluster.object<Secret>('secrets', driveMountSecretName(mapping.runnerId)), undefined, 'never in the runner namespace');
    assert.equal(secretGeneration(secret), mapping.generation);
    const token = bootstrapCredentialOf(secret)!;
    assert.match(token, /^orbit_drive_mount_/);
    const live = await liveCredentials(mapping.runnerId);
    assert.equal(live.length, 1, 'one live mount credential');
    assert.equal(live[0].tokenHash, sha256(token));
    assert.equal(live[0].generation, mapping.generation);
    assert.equal(live[0].ownerId, mapping.ownerId);
    // Written before the Pod was created: the plugin reads it when the kubelet publishes the drive.
    const order = w.cluster.calls.filter((c) => c.op === 'create').map((c) => c.kind);
    assert.ok(order.indexOf('drivesecrets') >= 0 && order.indexOf('drivesecrets') < order.indexOf('pods'), order.join(' → '));
    // The Pod has the drive, admitted by the guard; the runner's bootstrap Secret is not the mount credential.
    const pod = w.cluster.object<Pod>('pods', managedPodName(mapping.runnerId))!;
    assert.deepEqual(pod.spec.volumes!.find((v) => v.name === 'orbit-drive'), {
      name: 'orbit-drive', csi: { driver: 'drive.orbit.dev', volumeAttributes: { runnerId: mapping.runnerId } },
    });
    const boot = w.cluster.object<Secret>('secrets', managedSecretName(mapping.runnerId))!;
    assert.notEqual(bootstrapCredentialOf(boot), token);
    assert.ok(!JSON.stringify(pod).includes(token));
  });

  await t.test('sleep revokes it; the next generation replaces the Secret with its own', async () => {
    const w = managedRunnerWorld(db, { files: true });
    const { ownerId, mapping } = await w.readyRunner('drive-sleeper');
    const first = bootstrapCredentialOf(w.cluster.object<Secret>('drivesecrets', driveMountSecretName(mapping.runnerId))!)!;
    const asleep = await w.putToSleep(ownerId);
    assert.equal(asleep.generation, mapping.generation + 1);
    assert.deepEqual(await liveCredentials(mapping.runnerId), [], "the retired generation's mount credential is revoked with its runner credential");

    await recordManagedDemand(w.prisma, mapping.runnerId, w.now());
    const outcomes = await w.drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    const woken = await w.mappingOf(ownerId);
    const secret = w.cluster.object<Secret>('drivesecrets', driveMountSecretName(mapping.runnerId))!;
    assert.equal(secretGeneration(secret), woken.generation);
    const second = bootstrapCredentialOf(secret)!;
    assert.notEqual(second, first);
    const live = await liveCredentials(mapping.runnerId);
    assert.deepEqual(live.map((c) => [c.generation, c.tokenHash]), [[woken.generation, sha256(second)]]);
  });

  await t.test('a Secret create whose answer was lost is adopted; one that failed is issued again, the first credential revoked', async () => {
    const w = managedRunnerWorld(db, { files: true });
    w.cluster.inject({ op: 'create', kind: 'drivesecrets', mode: 'commit-then-timeout' });
    const { mapping } = await w.readyRunner('drive-lost-answer');
    const token = bootstrapCredentialOf(w.cluster.object<Secret>('drivesecrets', driveMountSecretName(mapping.runnerId))!)!;
    assert.deepEqual((await liveCredentials(mapping.runnerId)).map((c) => c.tokenHash), [sha256(token)]);

    const v = managedRunnerWorld(db, { files: true });
    v.cluster.inject({ op: 'create', kind: 'drivesecrets', mode: 'status', status: 500 });
    const failed = await v.readyRunner('drive-failed-create');
    const delivered = bootstrapCredentialOf(v.cluster.object<Secret>('drivesecrets', driveMountSecretName(failed.mapping.runnerId))!)!;
    const all = await db.driveMountCredential.findMany({ where: { runnerId: failed.mapping.runnerId } });
    assert.equal(all.length, 2, 'issued twice');
    assert.deepEqual(all.filter((c) => !c.revokedAt).map((c) => c.tokenHash), [sha256(delivered)], 'only the delivered one is live');
  });

  await t.test('without the drive in the profile, nothing of it is made', async () => {
    const w = managedRunnerWorld(db);
    const { mapping } = await w.readyRunner('no-drive');
    assert.equal(w.cluster.count('create', 'drivesecrets'), 0);
    assert.deepEqual(await liveCredentials(mapping.runnerId), []);
    const pod = w.cluster.object<Pod>('pods', managedPodName(mapping.runnerId))!;
    assert.ok(!pod.spec.volumes!.some((v) => v.name === 'orbit-drive'));
  });
});
