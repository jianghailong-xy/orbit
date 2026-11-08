import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MANAGED_RUNNER_GENERATION_HEADER,
  MANAGED_RUNNER_INSTANCE_CAPABILITY,
  MANAGED_RUNNER_POD_UID_HEADER,
  RunnerStatus,
} from '@orbit/shared';

import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { RunnerApiController } from './runner-api.controller';
import { runnerLinkCredential } from './runner-link-token';

/**
 * What a managed runner's heartbeat answer says about its storage (managed-runners/managed-runner-storage.ts;
 * docs/session-checkout-storage-design.md §5, D1 and D5):
 *
 *   Docker        `storageBudget` {limitBytes, usageBytes, measuredAt, floorBytes}: the channel's latest measurement
 *                 of the data volume as the manager kept it on the mapping, and the floor, a quarter of the limit
 *                 unless the owner set one; no measurement, no budget.
 *   Kubernetes    `minFreeDiskMb` a quarter of the PVC's size unless the owner set one; no budget.
 *   any other     a self-registered runner's answer is the one it always had.
 *
 * Only while the managed runner switch is on, as for idle sleep: off, management is frozen and so is the measurement.
 */

const GiB = 2 ** 30;
const MiB = 2 ** 20;
const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const MAPPING_ID = '33333333-3333-4333-8333-333333333333';
const POD_UID = '44444444-4444-4444-8444-444444444444';
const TOKEN_HASH = 'a'.repeat(64);
const MEASURED_AT = '2026-11-06T10:00:00.000Z';
const ON = { enabled: true, problem: null };

const reservation = (durableBytes: number) => ({ version: 1, pool: 'pool', storage: { durableBytes, reservedAt: MEASURED_AT }, compute: null });

/** A mapping as the heartbeat reads it: the instance it authorizes, and its volume. */
function mappingOf(backend: 'docker' | 'kubernetes', volumeMeasurement: unknown, durableBytes = 20 * GiB) {
  return {
    id: MAPPING_ID, runnerId: RUNNER_ID, ownerId: OWNER_ID, generation: 1, podUid: POD_UID, managementState: 'READY', desiredState: 'RUNNING',
    backend, reservation: reservation(durableBytes), volumeMeasurement,
  };
}

/**
 * The heartbeat route over a database of one runner row (its owner's floor `minFreeDiskMb`) and, when given, its managed
 * mapping. Every other read finds nothing. `switchOn` is the managed runner gate.
 */
function heartbeatWorld(options: { minFreeDiskMb?: number | null; mapping?: ReturnType<typeof mappingOf>; switchOn?: boolean; linkBeat?: boolean } = {}) {
  const row = { id: RUNNER_ID, ownerId: OWNER_ID, maxConcurrent: 2, minFreeDiskMb: options.minFreeDiskMb ?? null, tokenHash: TOKEN_HASH, version: null };
  const mappingReads: Array<Record<string, unknown>> = [];
  const prisma = {
    runner: {
      update: async () => ({ ...row }),
      findUnique: async () => ({ ...row, owner: { disabledAt: null } }),
    },
    runnerPresence: { upsert: async () => ({}) },
    session: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    workspace: { findMany: async () => [] },
    managedRunner: {
      findUnique: async (args: { where: Record<string, unknown> }) => {
        mappingReads.push(args.where);
        return options.mapping ?? null;
      },
    },
    $queryRaw: async (...args: unknown[]) => {
      // The link's beat statement, which admits a managed runner and leaves it to the full reconcile.
      if (options.linkBeat && renderRawQuery(args).text.includes('INSERT INTO "runner_presence"')) {
        return [{
          credentialHeld: true, ownerDisabled: false, managed: true, landingNamed: false, maxConcurrent: 2, minFreeDiskMb: row.minFreeDiskMb,
          beaten: false, inserted: null, changes: null, factsHash: null, reconcileHash: null, reconciledMs: null, nowMs: Date.now(),
          leasesHeld: 0, planUsageRead: false, planUsage: null,
        }];
      }
      return [];
    },
  } as never;
  const realtime = {
    drainCancellations: async () => [],
    failAbandonedWorktreeOperations: async () => undefined,
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
    linkWatchersOf: () => null,
  } as never;
  const listEvents = { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never;
  // Everything optional between the list events and the managed runner gate, which is the 20th argument.
  const controller = new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never, listEvents,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    options.switchOn === false ? undefined : (ON as never));
  return { controller, mappingReads };
}

const runner = { id: RUNNER_ID, version: null, lastHeartbeatAt: new Date() };
const beat = { status: RunnerStatus.ONLINE, idleCapacity: 1 } as never;
const instance = { mappingId: MAPPING_ID, generation: 1, podUid: POD_UID };
const measured = (usageBytes: number) => ({ limitBytes: 20 * GiB, usageBytes, measuredAt: MEASURED_AT });
/** What the runner receives: the answer as JSON carries it. */
const wire = (answer: unknown) => JSON.parse(JSON.stringify(answer)) as Record<string, unknown>;

test('a Docker managed runner\'s answer carries its volume\'s budget as the channel last measured it, the floor a quarter of the limit', async () => {
  const w = heartbeatWorld({ mapping: mappingOf('docker', measured(12 * GiB)) });
  const answer = wire(await w.controller.heartbeat(runner, beat, undefined, undefined, undefined, instance));
  assert.deepEqual(answer.storageBudget, { limitBytes: 20 * GiB, usageBytes: 12 * GiB, measuredAt: MEASURED_AT, floorBytes: 5 * GiB });
  assert.equal(answer.minFreeDiskMb, null, 'the owner set no floor, and none is stored for them');
  assert.deepEqual(w.mappingReads.at(-1), { id: MAPPING_ID }, 'the mapping the instance was authorized for');
});

test('an owner-set floor wins over the default on Docker: floorBytes is minFreeDiskMb in bytes', async () => {
  const w = heartbeatWorld({ minFreeDiskMb: 2048, mapping: mappingOf('docker', measured(12 * GiB)) });
  const answer = wire(await w.controller.heartbeat(runner, beat, undefined, undefined, undefined, instance));
  assert.deepEqual(answer.storageBudget, { limitBytes: 20 * GiB, usageBytes: 12 * GiB, measuredAt: MEASURED_AT, floorBytes: 2048 * MiB });
  assert.equal(answer.minFreeDiskMb, 2048);
});

test('a Docker managed runner whose volume the channel has not measured gets no budget, and fails open as before', async () => {
  const w = heartbeatWorld({ mapping: mappingOf('docker', null) });
  const answer = wire(await w.controller.heartbeat(runner, beat, undefined, undefined, undefined, instance));
  assert.equal('storageBudget' in answer, false);
  assert.equal(answer.minFreeDiskMb, null);
});

test('a Kubernetes managed runner with no owner floor gets minFreeDiskMb of a quarter of its PVC size, and no budget', async () => {
  const w = heartbeatWorld({ mapping: mappingOf('kubernetes', null, 20 * GiB) });
  const answer = wire(await w.controller.heartbeat(runner, beat, undefined, undefined, undefined, instance));
  assert.equal(answer.minFreeDiskMb, 5120, '25% of a 20 GiB PVC, in MB as the runner reads it');
  assert.equal('storageBudget' in answer, false, 'statfs inside the pod already reports the PVC');

  const owned = heartbeatWorld({ minFreeDiskMb: 1000, mapping: mappingOf('kubernetes', null, 20 * GiB) });
  assert.equal(wire(await owned.controller.heartbeat(runner, beat, undefined, undefined, undefined, instance)).minFreeDiskMb, 1000, 'the owner\'s floor wins');
});

test('with the managed runner switch off, a managed runner is told what it was before: no budget, the owner\'s floor alone', async () => {
  for (const mapping of [mappingOf('docker', measured(12 * GiB)), mappingOf('kubernetes', null)]) {
    const w = heartbeatWorld({ mapping, switchOn: false });
    const answer = wire(await w.controller.heartbeat(runner, beat, undefined, undefined, undefined, instance));
    assert.equal('storageBudget' in answer, false, mapping.backend);
    assert.equal(answer.minFreeDiskMb, null, mapping.backend);
    assert.deepEqual(w.mappingReads, [], 'nothing about its storage is read');
  }
});

test('a self-registered runner\'s answer is unchanged: its owner\'s floor, no budget, and no managed runner read', async () => {
  for (const minFreeDiskMb of [null, 2048]) {
    const w = heartbeatWorld({ minFreeDiskMb, switchOn: true });
    const answer = wire(await w.controller.heartbeat(runner, beat));
    assert.deepEqual(answer, {
      cancelSessionIds: [],
      leaseLostSessionIds: [],
      maxConcurrent: 2,
      minFreeDiskMb,
      mergeRequests: [],
      commitRequests: [],
      artifactRequests: [],
      agentDirs: [],
    }, 'the members a runner with nothing to do has always been answered with, and no other');
    assert.deepEqual(w.mappingReads, []);
  }
});

test('over the runner link a managed runner\'s every beat reconciles in full, so every answer carries its budget', async () => {
  const w = heartbeatWorld({ mapping: mappingOf('docker', measured(12 * GiB)), linkBeat: true });
  const link = {
    leaseOwner: '55555555-5555-4555-8555-555555555555', requestId: null, afterSeq: null, gatewayId: 'orbit-link-gateway-1',
    admission: { credential: runnerLinkCredential(TOKEN_HASH), ownerId: OWNER_ID },
  };
  const headers = {
    'x-orbit-runner-capabilities': MANAGED_RUNNER_INSTANCE_CAPABILITY,
    [MANAGED_RUNNER_GENERATION_HEADER]: '1',
    [MANAGED_RUNNER_POD_UID_HEADER]: POD_UID,
  };
  for (let i = 0; i < 3; i += 1) {
    const answer = wire(await w.controller.heartbeat(
      { id: RUNNER_ID, version: null }, beat, MANAGED_RUNNER_INSTANCE_CAPABILITY, undefined, undefined, undefined, link, headers,
    ));
    assert.deepEqual(answer.storageBudget, { limitBytes: 20 * GiB, usageBytes: 12 * GiB, measuredAt: MEASURED_AT, floorBytes: 5 * GiB }, `beat ${i + 1}`);
  }
});
