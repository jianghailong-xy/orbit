import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ManagedRunner } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { testDockerRunnerProfile } from '../test-support/docker-runner-profile.fixture';
import { FakeDockerChannel } from '../test-support/fake-docker-channel';
import { DockerBackend } from './docker-backend';
import { KubernetesBackend } from './kubernetes-backend';
import { ManagedRunnerManager } from './managed-runner-manager';
import { managedPvcName } from './managed-runner-resources';
import { DEFAULT_FLOOR_SHARE, managedRunnerStorage, readVolumeMeasurement } from './managed-runner-storage';

/**
 * A managed runner's storage as its heartbeat states it (managed-runner-storage.ts; docs/session-checkout-storage-design.md
 * §5, decisions D1 and D5), and where the Docker measurement comes from: the channel's view of the volume, which the
 * manager reads on its passes already (verifyStorage) and keeps on the mapping when its figures change.
 */

const GiB = 2 ** 30;
const MiB = 2 ** 20;
const RUNNER = '0195c0de-0000-7000-8000-0000000000a1';
const OWNER = '0195c0de-0000-7000-8000-0000000000b1';
const MEASURED_AT = '2026-11-06T10:00:00.000Z';
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };

const recorded = (usageBytes: number, limitBytes = 20 * GiB) => ({ limitBytes, usageBytes, measuredAt: MEASURED_AT });
const reserved = (durableBytes: number) => ({
  version: 1, pool: 'pool', storage: { durableBytes, reservedAt: MEASURED_AT }, compute: null,
});

// ── The answer ───────────────────────────────────────────────────────────────────────────────────────

test('a Docker runner\'s budget is its volume as last measured, with a quarter of the limit as the floor when the owner set none', () => {
  assert.equal(DEFAULT_FLOOR_SHARE, 0.25, 'D5: the default floor is 25% of the budget');
  assert.deepEqual(managedRunnerStorage({ backend: 'docker', reservation: reserved(20 * GiB), volumeMeasurement: recorded(12 * GiB) }, null), {
    minFreeDiskMb: null,
    storageBudget: { limitBytes: 20 * GiB, usageBytes: 12 * GiB, measuredAt: MEASURED_AT, floorBytes: 5 * GiB },
  });
  // A limit that is no multiple of four rounds the floor down to whole bytes, as the runner's integers need.
  assert.equal(managedRunnerStorage({ backend: 'docker', reservation: null, volumeMeasurement: recorded(0, 1001) }, null).storageBudget?.floorBytes, 250);
});

test('an owner\'s floor wins over the default: in bytes as the runner reads minFreeDiskMb, MiB', () => {
  assert.deepEqual(managedRunnerStorage({ backend: 'docker', reservation: null, volumeMeasurement: recorded(12 * GiB) }, 2048), {
    minFreeDiskMb: 2048,
    storageBudget: { limitBytes: 20 * GiB, usageBytes: 12 * GiB, measuredAt: MEASURED_AT, floorBytes: 2048 * MiB },
  });
  // Even one above the default: the owner's setting is the floor, whatever the volume.
  assert.equal(managedRunnerStorage({ backend: 'docker', reservation: null, volumeMeasurement: recorded(1) }, 10_240).storageBudget?.floorBytes, 10 * GiB);
});

test('no measurement is no budget, and so is anything the manager does not write', () => {
  assert.deepEqual(managedRunnerStorage({ backend: 'docker', reservation: reserved(20 * GiB), volumeMeasurement: null }, null), { minFreeDiskMb: null });
  assert.deepEqual(managedRunnerStorage({ backend: 'docker', reservation: null, volumeMeasurement: null }, 512), { minFreeDiskMb: 512 });
  for (const bad of [
    undefined, 'x', [recorded(1)], {},
    { ...recorded(1), limitBytes: 0 }, { ...recorded(1), limitBytes: -1 }, { ...recorded(1), usageBytes: -1 },
    { ...recorded(1), usageBytes: 1.5 }, { ...recorded(1), usageBytes: '1' }, { ...recorded(1), limitBytes: 2 ** 53 },
    { limitBytes: GiB, usageBytes: 1 }, { ...recorded(1), measuredAt: 'yesterday' }, { ...recorded(1), measuredAt: 0 },
  ]) {
    assert.equal(readVolumeMeasurement(bad), null, JSON.stringify(bad));
    assert.equal('storageBudget' in managedRunnerStorage({ backend: 'docker', reservation: null, volumeMeasurement: bad }, null), false);
  }
  assert.deepEqual(readVolumeMeasurement(recorded(0)), recorded(0), 'an empty volume is a measurement');
});

test('a Kubernetes runner gets a quarter of its PVC size as minFreeDiskMb when the owner set none, and never a budget', () => {
  // The PVC's size as admission reserved it: the size it was created with (10Gi in the shipped profiles, 20Gi here).
  assert.deepEqual(managedRunnerStorage({ backend: 'kubernetes', reservation: reserved(20 * GiB), volumeMeasurement: null }, null), { minFreeDiskMb: 5120 });
  assert.deepEqual(managedRunnerStorage({ backend: 'kubernetes', reservation: reserved(10 * GiB), volumeMeasurement: null }, null), { minFreeDiskMb: 2560 });
  // The owner's floor wins, below the default or above it.
  assert.deepEqual(managedRunnerStorage({ backend: 'kubernetes', reservation: reserved(20 * GiB), volumeMeasurement: null }, 1024), { minFreeDiskMb: 1024 });
  assert.deepEqual(managedRunnerStorage({ backend: 'kubernetes', reservation: reserved(20 * GiB), volumeMeasurement: null }, 8192), { minFreeDiskMb: 8192 });
  // Statfs inside the pod is already right: a measurement on the row would not make a budget of it.
  assert.equal('storageBudget' in managedRunnerStorage({ backend: 'kubernetes', reservation: reserved(GiB), volumeMeasurement: recorded(1) }, null), false);
  // No size known (no reservation, or under 4 MiB): no floor rather than a made-up one.
  assert.deepEqual(managedRunnerStorage({ backend: 'kubernetes', reservation: null, volumeMeasurement: null }, null), { minFreeDiskMb: null });
  assert.deepEqual(managedRunnerStorage({ backend: 'kubernetes', reservation: reserved(3 * MiB), volumeMeasurement: null }, null), { minFreeDiskMb: null });
});

// ── Where the Docker measurement comes from ──────────────────────────────────────────────────────────

test('DockerBackend reads the measurement off the channel\'s view of the volume, and none until the channel has one', async () => {
  const profile = testDockerRunnerProfile();
  const channel = new FakeDockerChannel(profile.docker.instanceId, profile.runner.image);
  const backend = new DockerBackend(channel, profile);
  const mapping = { id: 'mapping', ownerId: OWNER, runnerId: RUNNER, generation: 1, pvcName: managedPvcName(RUNNER) } as ManagedRunner;
  const volume = await backend.createVolume(mapping);
  assert.equal(backend.volumeMeasurement(volume), null, 'the channel has not measured it yet (usageBytes null)');
  channel.volumes.get(managedPvcName(RUNNER))!.usageBytes = 3 * GiB;
  assert.deepEqual(backend.volumeMeasurement((await backend.readVolume(mapping))!), { limitBytes: 10 * GiB, usageBytes: 3 * GiB });
  channel.volumes.get(managedPvcName(RUNNER))!.limitBytes = null;
  assert.equal(backend.volumeMeasurement((await backend.readVolume(mapping))!), null, 'a volume with no limit has no budget');
  assert.equal('volumeMeasurement' in KubernetesBackend.prototype, false, 'statfs inside the pod already reports the PVC');
});

/** A manager on DockerBackend over the fake channel, its writes recorded, at a clock the test moves. */
async function dockerWorld() {
  const profile = testDockerRunnerProfile();
  const channel = new FakeDockerChannel(profile.docker.instanceId, profile.runner.image);
  const backend = new DockerBackend(channel, profile);
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const prisma = {
    managedRunner: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push(args);
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  const clock = { ms: Date.parse(MEASURED_AT) };
  const manager = new ManagedRunnerManager(prisma, backend, profile, { holder: 'replica-a', now: () => new Date(clock.ms), log: quiet });
  const base = { id: 'mapping', ownerId: OWNER, runnerId: RUNNER, generation: 1, backend: 'docker', pvcName: managedPvcName(RUNNER) } as ManagedRunner;
  const volume = await backend.createVolume(base);
  const backing = await backend.readBacking(volume);
  const mapping = (volumeMeasurement: unknown): ManagedRunner =>
    ({ ...base, pvcUid: volume.uid, pvUid: backing.uid, volumeHandle: backing.handle, volumeMeasurement }) as ManagedRunner;
  // The pass's check of the recorded volume, which every pass of a started instance makes (STARTING, READY, DRAINING).
  const verifyStorage = (m: ManagedRunner) => (manager as unknown as { verifyStorage(m: ManagedRunner): Promise<unknown> }).verifyStorage(m);
  const measure = (usageBytes: number) => void (channel.volumes.get(managedPvcName(RUNNER))!.usageBytes = usageBytes);
  return { channel, writes, clock, mapping, verifyStorage, measure };
}

test('the manager keeps the channel\'s measurement on the mapping as its pass reads it, under its lease, leaving the revision alone', async () => {
  const w = await dockerWorld();
  await w.verifyStorage(w.mapping(null));
  assert.equal(w.writes.length, 0, 'the channel has measured nothing: nothing is kept, and the heartbeat sends no budget');

  w.measure(3 * GiB);
  // The channel answers a moment after it is asked: the time kept is taken after its answer, never before.
  const read = w.channel.readVolume.bind(w.channel);
  w.channel.readVolume = async (name: string) => {
    const view = await read(name);
    w.clock.ms += 1_000;
    return view;
  };
  await w.verifyStorage(w.mapping(null));
  assert.deepEqual(w.writes, [{
    where: { id: 'mapping', leaseHolder: 'replica-a' },
    data: { volumeMeasurement: { limitBytes: 10 * GiB, usageBytes: 3 * GiB, measuredAt: '2026-11-06T10:00:01.000Z' } },
  }], 'one write of its own column: no revision, so no step\'s compare-and-set misses for it');
});

test('the same figures read again keep the time they were first read; new figures are kept with the pass\'s time', async () => {
  const w = await dockerWorld();
  w.measure(3 * GiB);
  const first = { limitBytes: 10 * GiB, usageBytes: 3 * GiB, measuredAt: MEASURED_AT };
  w.clock.ms += 30_000;
  await w.verifyStorage(w.mapping(first));
  // The runner counts the checkouts it removed after measuredAt as freed until a new measurement: moving the time on
  // for figures the channel has not taken again would make it forget them.
  assert.equal(w.writes.length, 0, 'unchanged: the first time stands');

  w.measure(4 * GiB);
  await w.verifyStorage(w.mapping(first));
  assert.deepEqual(w.writes.map((write) => write.data.volumeMeasurement), [{ limitBytes: 10 * GiB, usageBytes: 4 * GiB, measuredAt: '2026-11-06T10:00:30.000Z' }]);

  // A kept value the manager could not have written is replaced, not trusted.
  w.writes.length = 0;
  await w.verifyStorage(w.mapping({ limitBytes: 10 * GiB, usageBytes: 4 * GiB }));
  assert.equal(w.writes.length, 1);
});
