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
 * A managed runner's heartbeat answer carries a max-concurrent of at most what its memory allows
 * (managed-runners/managed-runner-concurrency.ts), whatever its row holds: a row written before the ceiling, or above
 * it, is not what its daemon runs. A self-registered runner's answer is its row's value, as it always was.
 */

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const MAPPING_ID = '33333333-3333-4333-8333-333333333333';
const POD_UID = '44444444-4444-4444-8444-444444444444';
const TOKEN_HASH = 'a'.repeat(64);
const ON = { enabled: true, problem: null };

/** Every managed runner of this server is made from a profile whose runner container is limited to `memory`. */
const runtimeWith = (memory: string) => ({
  available: true,
  profile: { runner: { maxConcurrent: 2, resources: { runner: { requests: { cpu: '1', memory: '2Gi' }, limits: { cpu: '2', memory } } } } },
});

const mapping = {
  id: MAPPING_ID, runnerId: RUNNER_ID, ownerId: OWNER_ID, generation: 1, podUid: POD_UID, managementState: 'READY', desiredState: 'RUNNING',
  backend: 'kubernetes', reservation: null, volumeMeasurement: null,
};

/** The heartbeat route over one runner row holding `maxConcurrent`, managed or not, under `runtime`. */
function heartbeatWorld(options: { maxConcurrent: number; concurrencyCap?: number; runtime?: unknown; switchOn?: boolean; linkBeat?: boolean }) {
  const row = { id: RUNNER_ID, ownerId: OWNER_ID, maxConcurrent: options.maxConcurrent, burstConcurrent: 2, minFreeDiskMb: null, tokenHash: TOKEN_HASH, version: null };
  const prisma = {
    runner: {
      update: async () => ({ ...row }),
      findUnique: async () => ({ ...row, owner: { disabledAt: null } }),
    },
    runnerPresence: { upsert: async () => ({}) },
    session: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    workspace: { findMany: async () => [] },
    managedRunner: { findUnique: async () => ({ ...mapping, concurrencyCap: options.concurrencyCap ?? null }) },
    $queryRaw: async (...args: unknown[]) => {
      if (options.linkBeat && renderRawQuery(args).text.includes('INSERT INTO "runner_presence"')) {
        return [{
          credentialHeld: true, ownerDisabled: false, managed: true, landingNamed: false, maxConcurrent: row.maxConcurrent,
          burstConcurrent: row.burstConcurrent, minFreeDiskMb: null,
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
  // The constructor's arguments by position: the managed runner gate is the 20th, the runtime the last.
  const args: unknown[] = new Array(RunnerApiController.length).fill(undefined);
  args.splice(0, 7, prisma, {}, realtime, {}, {}, {}, listEvents);
  args[19] = options.switchOn === false ? undefined : ON;
  args[args.length - 1] = options.runtime;
  const controller = new (RunnerApiController as unknown as new (...a: unknown[]) => RunnerApiController)(...args);
  return { controller };
}

const runner = { id: RUNNER_ID, version: null, lastHeartbeatAt: new Date() };
const beat = { status: RunnerStatus.ONLINE, idleCapacity: 1 } as never;
const instance = { mappingId: MAPPING_ID, generation: 1, podUid: POD_UID };
const wire = (answer: unknown) => JSON.parse(JSON.stringify(answer)) as Record<string, unknown>;

test('a managed runner whose row says 8, with a 4 GiB limit, is answered 3', async () => {
  const w = heartbeatWorld({ maxConcurrent: 8, runtime: runtimeWith('4Gi') });
  const answer = wire(await w.controller.heartbeat(runner, beat, undefined, undefined, undefined, instance));
  assert.equal(answer.maxConcurrent, 3);
  assert.equal(answer.burstConcurrent, 0);
});

test('a managed runner can use spare permits within its memory ceiling', async () => {
  const w = heartbeatWorld({ maxConcurrent: 2, runtime: runtimeWith('4Gi') });
  const answer = wire(await w.controller.heartbeat(runner, beat, undefined, undefined, undefined, instance));
  assert.equal(answer.maxConcurrent, 2);
  assert.equal(answer.burstConcurrent, 1);
});

test('an OOM recovery cap of one leaves no spare permits', async () => {
  const w = heartbeatWorld({ maxConcurrent: 2, concurrencyCap: 1, runtime: runtimeWith('4Gi') });
  const answer = wire(await w.controller.heartbeat(runner, beat, undefined, undefined, undefined, instance));
  assert.equal(answer.maxConcurrent, 1);
  assert.equal(answer.burstConcurrent, 0);
});

test('over the runner link a managed runner reconciles in full, and every answer carries the clamped value', async () => {
  const w = heartbeatWorld({ maxConcurrent: 8, runtime: runtimeWith('4Gi'), linkBeat: true });
  const link = {
    leaseOwner: '55555555-5555-4555-8555-555555555555', requestId: null, afterSeq: null, gatewayId: 'orbit-link-gateway-1',
    admission: { credential: runnerLinkCredential(TOKEN_HASH), ownerId: OWNER_ID },
  };
  const headers = {
    'x-orbit-runner-capabilities': MANAGED_RUNNER_INSTANCE_CAPABILITY,
    [MANAGED_RUNNER_GENERATION_HEADER]: '1',
    [MANAGED_RUNNER_POD_UID_HEADER]: POD_UID,
  };
  for (let i = 0; i < 2; i += 1) {
    const answer = wire(await w.controller.heartbeat(
      { id: RUNNER_ID, version: null }, beat, MANAGED_RUNNER_INSTANCE_CAPABILITY, undefined, undefined, undefined, link, headers,
    ));
    assert.equal(answer.maxConcurrent, 3, `beat ${i + 1}`);
    assert.equal(answer.burstConcurrent, 0, `beat ${i + 1}`);
  }
});

test('a self-registered runner whose row says 8 is answered 8, whatever the managed profile', async () => {
  const w = heartbeatWorld({ maxConcurrent: 8, runtime: runtimeWith('4Gi') });
  const answer = wire(await w.controller.heartbeat(runner, beat));
  assert.equal(answer.maxConcurrent, 8);
  assert.equal(answer.burstConcurrent, 2);
});

test('with the managed runner switch off, or no profile, nothing is clamped', async () => {
  const off = heartbeatWorld({ maxConcurrent: 8, runtime: runtimeWith('4Gi'), switchOn: false });
  assert.equal(wire(await off.controller.heartbeat(runner, beat, undefined, undefined, undefined, instance)).maxConcurrent, 8);
  const none = heartbeatWorld({ maxConcurrent: 8, runtime: { available: false, problems: ['no profile'] } });
  assert.equal(wire(await none.controller.heartbeat(runner, beat, undefined, undefined, undefined, instance)).maxConcurrent, 8);
});
