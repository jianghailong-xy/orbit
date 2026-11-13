/**
 * Several Docker channel hosts (docs/managed-runner-remote-host-design.md, "Several channel hosts", D5):
 * the runtime built from a `docker.hosts` profile — two remote channels, the channel's image adopted —
 * with one backend and manager per host over channels that keep the real one's rules in memory
 * (test-support/fake-docker-channel.ts), against a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty. The loop is the runtime's own worker.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-hosts.pg.spec.ts
 *
 *   (1) two hosts, two pools: one `managed_runner_capacity` row per host, each with its own budget;
 *   (2) placement: each new runner goes to the host with the most free room (a tie to the earlier
 *       host), its container made on that host only, from the image that host's channel reports;
 *   (3) each manager drives only its own location's mappings: never listed, leased or touched by the other;
 *   (4) draining: after a restart with a host marked draining, a new runner goes elsewhere although the
 *       draining host has more room, and the draining host's runners are still driven;
 *   (5) one host unreachable: the other host's new runner comes up meanwhile, the unreachable host's
 *       READY runners stay as they were with nothing spent, and its next pass after it is back drives them;
 *   (6) single host, as before: today's one-channel profile drives every Docker mapping, whatever its
 *       recorded location, while a two-host one leaves a mapping of no listed host alone.
 *
 * Not destructive: every row belongs to a user this run creates, and every pool to a cluster key of its own.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY } from '@orbit/shared';
import { Prisma, type ManagedRunner, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { testDockerRunnerProfile } from '../test-support/docker-runner-profile.fixture';
import { FakeDockerChannel } from '../test-support/fake-docker-channel';
import { tripwireKubeClientFactory } from '../test-support/fake-kube-client';
import { managedPodName } from './managed-runner-resources';
import { createManagedRunnerRuntime, type ManagedRunnerRuntime } from './managed-runner-runtime';
import { storedWorkloadFor } from './managed-runner-sleep';
import { ManagedRunnerService } from './managed-runner.service';

const URL = process.env.COORDINATOR_PG_URL;
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const ON = { enabled: true, problem: null } as const;
const IDLE = { activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 0 };
const IMAGE_A = `sha256:${'a'.repeat(64)}`;
const IMAGE_B = `sha256:${'b'.repeat(64)}`;

type Available = Extract<ManagedRunnerRuntime, { available: true }>;

test('several Docker channel hosts: one manager per host, separate pools, placement, draining, an unreachable host', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-docker-hosts-pg-'));
  t.after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const clusterKey = `docker-hosts-${randomUUID().slice(0, 8)}`;
  // The channel hosts outlive any one apiserver process: a restart builds new managers over the same channels.
  const channels = new Map<string, FakeDockerChannel>([
    ['orbit-host-a', new FakeDockerChannel('orbit-host-a', IMAGE_A)],
    ['orbit-host-b', new FakeDockerChannel('orbit-host-b', IMAGE_B)],
  ]);
  const channelA = channels.get('orbit-host-a')!;
  const channelB = channels.get('orbit-host-b')!;

  /** The apiserver started on a profile file: its runtime, built as production builds it, and its service. */
  function start(profile: Record<string, unknown>): { runtime: Available; service: ManagedRunnerService } {
    const file = path.join(dir, `profile-${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify(profile));
    const runtime = createManagedRunnerRuntime({
      profilePath: file,
      prisma,
      kubeClient: tripwireKubeClientFactory([]),
      dockerChannel: (hostProfile) => channels.get(hostProfile.docker.instanceId) ?? new FakeDockerChannel(hostProfile.docker.instanceId, hostProfile.runner.image),
      log: quiet,
    });
    assert.ok(runtime.available, JSON.stringify(!runtime.available && runtime.problems));
    return { runtime, service: new ManagedRunnerService(prisma, ON, runtime) };
  }

  /** Two remote hosts on wg1 (A with room for 2 runners, B for 4), runners on https, each channel's own image. */
  function twoHosts(drainingB = false): Record<string, unknown> {
    const p = structuredClone(testDockerRunnerProfile({ clusterKey })) as unknown as Record<string, any>;
    p.docker = {
      hosts: [
        { instanceId: 'orbit-host-a', channel: { url: 'http://10.66.0.3:7781' }, tokenFile: '/etc/orbit/a.token', capacity: { compute: { pods: 2 } } },
        { instanceId: 'orbit-host-b', channel: { url: 'http://10.66.0.4:7781' }, tokenFile: '/etc/orbit/b.token', capacity: { compute: { pods: 4 } }, draining: drainingB },
      ],
    };
    p.runner.serverUrl = 'https://orbitd.io';
    p.runner.image = 'channel';
    return p;
  }

  const mappingOf = async (ownerId: string): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId } }))!;
  async function owner(label: string): Promise<string> {
    return (await db.user.create({ data: { email: `${label}-${randomUUID()}@example.invalid`, name: label } })).id;
  }
  async function heartbeat(mapping: ManagedRunner) {
    await db.runner.update({
      where: { id: mapping.runnerId },
      data: {
        status: 'ONLINE',
        lastHeartbeatAt: new Date(),
        engines: [{ engine: 'codex', installed: true, auth: 'yes' }],
        capabilities: [MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY],
        managedWorkload: mapping.podUid
          ? (storedWorkloadFor(IDLE, { mappingId: mapping.id, generation: mapping.generation, podUid: mapping.podUid }, false, new Date()) as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
    });
  }
  /** Worker passes, each runner beating as it would, until every one of `owners` is READY. */
  async function untilReady(runtime: Available, owners: string[], also: string[] = []): Promise<void> {
    for (let pass = 0; pass < 30; pass += 1) {
      await runtime.worker.drain();
      let ready = true;
      for (const ownerId of [...owners, ...also]) {
        const mapping = await mappingOf(ownerId);
        if (mapping.podUid) await heartbeat(mapping);
        if (owners.includes(ownerId) && mapping.managementState !== 'READY') ready = false;
      }
      if (ready) return;
    }
    const states = await Promise.all(owners.map(async (o) => { const m = await mappingOf(o); return `${m.namespace}:${m.managementState}:${JSON.stringify(m.lastError)}`; }));
    assert.fail(`not READY after 30 passes: ${states.join(', ')}`);
  }
  async function pool(namespace: string): Promise<{ pods: number; pods_reserved: number } | undefined> {
    const { rows } = await sql.query('SELECT pods, pods_reserved FROM managed_runner_capacity WHERE cluster_key = $1 AND namespace = $2', [clusterKey, namespace]);
    return rows[0];
  }
  /** A new account's runner, through the owner's explicit ensure, and where it was placed. */
  async function placed(service: ManagedRunnerService, label: string): Promise<{ ownerId: string; namespace: string }> {
    const ownerId = await owner(label);
    await service.ensure(ownerId, `ensure-${label}`);
    return { ownerId, namespace: (await mappingOf(ownerId)).namespace };
  }

  let first = start(twoHosts());
  const [managerA, managerB] = first.runtime.hosts!.map((h) => h.manager);
  const owners: Record<string, string> = {};

  await t.test('(1) two hosts, two pools, each with its own budget', async () => {
    await first.runtime.worker.drain();
    assert.deepEqual(await pool('orbit-host-a'), { pods: 2, pods_reserved: 0 });
    assert.deepEqual(await pool('orbit-host-b'), { pods: 4, pods_reserved: 0 });
  });

  await t.test('(2) each new runner goes to the host with the most free room, made there from that host\'s image', async () => {
    const one = await placed(first.service, 'one');
    assert.equal(one.namespace, 'orbit-host-b', 'B has 4 free, A 2');
    await untilReady(first.runtime, [one.ownerId]);
    const two = await placed(first.service, 'two');
    assert.equal(two.namespace, 'orbit-host-b', 'B has 3 free, A 2');
    await untilReady(first.runtime, [two.ownerId], [one.ownerId]);
    const three = await placed(first.service, 'three');
    assert.equal(three.namespace, 'orbit-host-a', '2 free on each: the earlier host');
    await untilReady(first.runtime, [three.ownerId], [one.ownerId, two.ownerId]);
    Object.assign(owners, { one: one.ownerId, two: two.ownerId, three: three.ownerId });

    assert.deepEqual(await pool('orbit-host-a'), { pods: 2, pods_reserved: 1 });
    assert.deepEqual(await pool('orbit-host-b'), { pods: 4, pods_reserved: 2 });
    for (const [label, channel, other, image] of [['one', channelB, channelA, IMAGE_B], ['two', channelB, channelA, IMAGE_B], ['three', channelA, channelB, IMAGE_A]] as const) {
      const mapping = await mappingOf(owners[label]);
      const name = managedPodName(mapping.runnerId);
      assert.equal(channel.containers.get(name)?.request.image, image, `${label}: made on its host from the image that channel reports`);
      assert.equal(channel.containers.get(name)?.uid, mapping.podUid);
      assert.equal(other.containers.has(name), false, `${label}: nothing on the other host`);
      assert.equal(other.volumes.has(mapping.pvcName), false, `${label}: no volume on the other host`);
      assert.match(mapping.volumeHandle ?? '', new RegExp(`^docker:${mapping.namespace}/`), `${label}: the handle names its host's instance`);
      assert.equal(mapping.clusterKey, clusterKey);
    }
  });

  await t.test('(3) each manager drives only its own location\'s mappings', async () => {
    const one = await mappingOf(owners.one);
    const three = await mappingOf(owners.three);
    const dueA = await managerA.dueMappings(50);
    const dueB = await managerB.dueMappings(50);
    assert.ok(dueA.includes(three.id) && !dueA.includes(one.id), `A lists its own only: ${dueA}`);
    assert.ok(dueB.includes(one.id) && !dueB.includes(three.id), `B lists its own only: ${dueB}`);
    const callsA = channelA.calls.length;
    assert.equal(await managerA.reconcile(one.id), 'IDLE', 'another host\'s mapping is not driven');
    assert.equal(channelA.calls.length, callsA, 'nor is anything asked of A\'s channel for it');
    const after = await mappingOf(owners.one);
    assert.equal(after.leaseHolder, null, 'nor leased');
    assert.equal(after.revision, one.revision);
  });

  await t.test('(4) after a restart with B draining, a new runner goes to A although B has more room; B\'s runners are still driven', async () => {
    first = start(twoHosts(true));
    assert.deepEqual(first.runtime.hosts!.map((h) => [h.instanceId, h.draining]), [['orbit-host-a', false], ['orbit-host-b', true]]);
    await first.runtime.worker.drain();
    const four = await placed(first.service, 'four');
    assert.equal(four.namespace, 'orbit-host-a', 'B has 2 free and A 1, but B is draining');
    owners.four = four.ownerId;
    const one = await mappingOf(owners.one);
    assert.ok((await first.runtime.hosts![1].manager.dueMappings(50)).includes(one.id), 'the draining host\'s manager still lists its runners');
    assert.equal(await first.runtime.hosts![1].manager.reconcile(one.id), 'READY');
  });

  await t.test('(5) B unreachable: A\'s new runner comes up, B\'s stay READY with nothing spent, and are driven again once B is back', async () => {
    const before = await Promise.all(['one', 'two'].map((label) => mappingOf(owners[label])));
    channelB.down = true;
    await untilReady(first.runtime, [owners.four], [owners.one, owners.two, owners.three]);
    const four = await mappingOf(owners.four);
    assert.equal(channelA.containers.get(managedPodName(four.runnerId))?.request.image, IMAGE_A);
    assert.deepEqual(await pool('orbit-host-a'), { pods: 2, pods_reserved: 2 });
    for (const was of before) {
      const now = await mappingOf(was.ownerId);
      assert.deepEqual(
        { state: now.managementState, attempt: now.attempt, generation: now.generation, podUid: now.podUid },
        { state: 'READY', attempt: was.attempt, generation: was.generation, podUid: was.podUid },
        'unanswered: nothing spent, nothing failed',
      );
    }
    assert.deepEqual(await pool('orbit-host-b'), { pods: 4, pods_reserved: 2 });

    channelB.down = false;
    const readsB = channelB.count('readContainer');
    await untilReady(first.runtime, [owners.one, owners.two, owners.three, owners.four]);
    assert.ok(channelB.count('readContainer') > readsB, 'B\'s runners are looked at again');
  });

  await t.test('(6) single host, as before: one manager drives every Docker mapping; two hosts leave an unlisted location alone', async () => {
    const single = start(testDockerRunnerProfile({ clusterKey: `${clusterKey}-single`, instanceId: 'orbit-single' }) as unknown as Record<string, unknown>);
    assert.equal(single.runtime.hosts!.length, 1);
    assert.deepEqual(single.runtime.manager.scope, { backend: 'docker' });
    const five = await placed(single.service, 'five');
    const mapping = await mappingOf(five.ownerId);
    assert.deepEqual([mapping.clusterKey, mapping.namespace], [`${clusterKey}-single`, 'orbit-single'], 'the one host\'s location, as before');
    // A Docker mapping recorded under a location no host lists any more (an edited instance id).
    await db.managedRunner.update({ where: { id: mapping.id }, data: { namespace: 'orbit-retired-instance' } });
    assert.ok((await single.runtime.manager.dueMappings(50)).includes(mapping.id), 'the single host\'s manager still drives it, as it did');
    for (const host of first.runtime.hosts!) {
      assert.ok(!(await host.manager.dueMappings(50)).includes(mapping.id), `${host.instanceId} leaves it alone`);
      assert.equal(await host.manager.reconcile(mapping.id), 'IDLE');
    }
  });
});
