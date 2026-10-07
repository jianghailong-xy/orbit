import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ManagedRunner } from '@prisma/client';

import { managedRunnerReason } from './managed-runner-manager';
import { managedRunnerStatus } from './managed-runner-status';

// The status every client renders, derived from the stored mapping alone: no write, no allocation.

const NOW = new Date('2026-10-07T08:00:00.000Z');
const FRESH = 90_000;

function mapping(change: Partial<ManagedRunner> = {}): ManagedRunner {
  return {
    id: 'm',
    ownerId: 'o',
    runnerId: 'r',
    defaultWorkspaceId: 'w',
    desiredState: 'RUNNING',
    managementState: 'READY',
    generation: 1,
    revision: 7,
    clusterKey: 'c',
    namespace: 'n',
    pvcName: 'mr-data-r',
    pvcUid: 'pvc',
    pvUid: 'pv',
    volumeHandle: 'h',
    podName: 'mr-r',
    podUid: 'pod',
    nodeName: 'node-a',
    nodeUid: null,
    reservation: null,
    demandRevision: 0,
    lastDemandAt: null,
    initialProvider: null,
    resourceProfileId: 'p',
    resourceOperationId: null,
    resourceOperationKind: null,
    resourceOperationState: null,
    attempt: 0,
    nextAttemptAt: null,
    startupDeadlineAt: null,
    lastError: null,
    fencingReceipt: null,
    leaseHolder: null,
    leaseExpiresAt: null,
    lastRequestKey: null,
    stateEnteredAt: NOW,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...change,
  };
}

const beat = (msAgo: number) => ({ status: 'ONLINE' as const, lastHeartbeatAt: new Date(NOW.getTime() - msAgo) });

test('off: enabled false, nothing offered, and a stored mapping is reported as it is without being touched', () => {
  const none = managedRunnerStatus({ enabled: false, available: false, mapping: null, runner: null, now: NOW, heartbeatFreshMs: FRESH });
  assert.equal(none.enabled, false);
  assert.equal(none.managementState, 'NOT_PROVISIONED');
  assert.equal(none.revision, 0);
  assert.equal(none.reason?.code, 'MANAGED_RUNNER_DISABLED');
  assert.deepEqual(none.actions, { canEnsure: false, canWake: false, canSleep: false, canRetry: false, canDelete: false });

  const failed = mapping({ managementState: 'FAILED', lastError: { ...managedRunnerReason('RETRY_EXHAUSTED'), detail: 'x' } });
  const frozen = managedRunnerStatus({ enabled: false, available: false, mapping: failed, runner: beat(1000), now: NOW, heartbeatFreshMs: FRESH });
  assert.equal(frozen.managementState, 'FAILED');
  assert.equal(frozen.reason?.code, 'MANAGED_RUNNER_DISABLED');
  assert.equal(frozen.actions.canRetry, false, 'no action while the switch is off');
});

test('on: NOT_PROVISIONED offers ensure only when the environment is available', () => {
  assert.equal(managedRunnerStatus({ enabled: true, available: true, mapping: null, runner: null, now: NOW, heartbeatFreshMs: FRESH }).actions.canEnsure, true);
  const unavailable = managedRunnerStatus({ enabled: true, available: false, mapping: null, runner: null, now: NOW, heartbeatFreshMs: FRESH });
  assert.equal(unavailable.actions.canEnsure, false);
  assert.equal(unavailable.reason?.code, 'MANAGED_RUNNER_UNAVAILABLE');
});

test('usable is READY with a fresh, non-offline heartbeat; a stale one is unusable, not dead', () => {
  const at = (runner: ReturnType<typeof beat> | null, state: ManagedRunner['managementState'] = 'READY') =>
    managedRunnerStatus({ enabled: true, available: true, mapping: mapping({ managementState: state }), runner, now: NOW, heartbeatFreshMs: FRESH });
  assert.equal(at(beat(10_000)).usable, true);
  assert.equal(at(beat(10_000)).lastHeartbeatAt, new Date(NOW.getTime() - 10_000).toISOString());
  assert.equal(at(beat(FRESH + 1)).usable, false);
  assert.equal(at(beat(FRESH + 1)).managementState, 'READY');
  assert.equal(at({ status: 'OFFLINE' as never, lastHeartbeatAt: NOW }).usable, false);
  assert.equal(at(beat(10_000), 'STARTING').usable, false);
  assert.equal(at(null).usable, false);
});

test('FAILED offers retry only for a retryable cause, and the operator detail never reaches the client', () => {
  const failed = (code: string) =>
    managedRunnerStatus({
      enabled: true,
      available: true,
      mapping: mapping({ managementState: 'FAILED', lastError: { ...managedRunnerReason(code), detail: 'PVC uid 1234 vs 5678 on node-a' } }),
      runner: null,
      now: NOW,
      heartbeatFreshMs: FRESH,
    });
  assert.equal(failed('RETRY_EXHAUSTED').actions.canRetry, true);
  assert.equal(failed('PVC_CONFLICT').actions.canRetry, false);
  assert.deepEqual(Object.keys(failed('PVC_CONFLICT').reason!).sort(), ['code', 'message', 'retryable']);
  assert.ok(!JSON.stringify(failed('PVC_CONFLICT')).includes('5678'));
});

test('a scheduled retry is announced; a passed one is not', () => {
  const later = new Date(NOW.getTime() + 30_000);
  const backingOff = mapping({ managementState: 'PROVISIONING', nextAttemptAt: later, lastError: managedRunnerReason('TRANSIENT') as never });
  const status = managedRunnerStatus({ enabled: true, available: true, mapping: backingOff, runner: null, now: NOW, heartbeatFreshMs: FRESH });
  assert.equal(status.retryAfter, later.toISOString());
  assert.equal(status.reason?.code, 'TRANSIENT');
  const passed = managedRunnerStatus({ enabled: true, available: true, mapping: backingOff, runner: null, now: new Date(later.getTime() + 1), heartbeatFreshMs: FRESH });
  assert.equal(passed.retryAfter, null);
});

test('an account the server does not give a managed runner is told so and offered no ensure; one with a mapping is not asked', () => {
  const refused = managedRunnerStatus({ enabled: true, available: true, eligible: false, mapping: null, runner: null, now: NOW, heartbeatFreshMs: FRESH });
  assert.equal(refused.managementState, 'NOT_PROVISIONED');
  assert.equal(refused.reason?.code, 'MANAGED_RUNNER_NOT_ELIGIBLE');
  assert.equal(refused.reason?.retryable, false);
  assert.equal(refused.actions.canEnsure, false);
  // Off, the switch is the reason, whatever the decision would say.
  const off = managedRunnerStatus({ enabled: false, available: false, eligible: false, mapping: null, runner: null, now: NOW, heartbeatFreshMs: FRESH });
  assert.equal(off.reason?.code, 'MANAGED_RUNNER_DISABLED');
  const mapped = managedRunnerStatus({ enabled: true, available: true, eligible: false, mapping: mapping(), runner: beat(1000), now: NOW, heartbeatFreshMs: FRESH });
  assert.equal(mapped.managementState, 'READY');
  assert.equal(mapped.reason, null);
});

test('READY reports the runtime it was found ready with; waiting on model supply says MODEL_UNAVAILABLE and is unusable', () => {
  const ready = managedRunnerStatus({ enabled: true, available: true, mapping: mapping({ initialProvider: 'codex' }), runner: beat(1000), now: NOW, heartbeatFreshMs: FRESH });
  assert.equal(ready.initialProvider, 'codex');
  assert.equal(ready.usable, true);
  const waiting = managedRunnerStatus({
    enabled: true,
    available: true,
    mapping: mapping({ managementState: 'STARTING', lastError: managedRunnerReason('MODEL_UNAVAILABLE') as never }),
    runner: beat(1000),
    now: NOW,
    heartbeatFreshMs: FRESH,
  });
  assert.equal(waiting.managementState, 'STARTING');
  assert.equal(waiting.usable, false);
  assert.equal(waiting.initialProvider, null);
  assert.deepEqual(waiting.reason, managedRunnerReason('MODEL_UNAVAILABLE'));
  assert.equal(waiting.reason?.retryable, true);
  assert.equal(waiting.actions.canRetry, false, 'nothing to retry while it is still waiting');
});
