import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { ManagedRunner, RunnerStatus } from '@prisma/client';
import { MANAGED_RUNNER_CAPACITY_UNAVAILABLE } from '@orbit/shared';

import { AuthController } from '../auth/auth.controller';
import { addTwins } from '../common/public-id-body';
import { capacityShortMessage, type CapacityDimension } from './managed-runner-capacity';
import { managedRunnerReason } from './managed-runner-manager';
import { managedRunnerStatus } from './managed-runner-status';

/**
 * `managed-runner-states.fixture.json` is the server state the Web, macOS and iOS clients are all
 * rendered from. This holds every `status` in it to what this server actually answers: each one is
 * derived from its stored `server` inputs by managedRunnerStatus, passed through the public id
 * mapping the HTTP layer applies, and compared whole — so the clients are never proved against a
 * state the server cannot produce, and a change to the status answer fails here before it reaches them.
 */

interface ServerInput {
  enabled: boolean;
  available: boolean;
  eligible?: boolean;
  mapping: (Partial<Record<keyof ManagedRunner, unknown>> & { lastErrorCode?: string; capacityShort?: CapacityDimension[] }) | null;
  runner: { status: RunnerStatus; lastHeartbeatAt: string | null } | null;
}

interface Fixture {
  now: string;
  heartbeatFreshMs: number;
  ids: { runner: string; workspace: string };
  capabilities: { name: string; httpStatus: number; body: unknown; offered: boolean }[];
  states: { name: string; server: ServerInput; status: unknown }[];
}

const fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../shared/src/managed-runner-states.fixture.json'), 'utf8'),
) as Fixture;
const NOW = new Date(fixture.now);

/** A stored row: a blank mapping of the fixture's runner and workspace, with the case's fields. */
function row(input: NonNullable<ServerInput['mapping']>): ManagedRunner {
  const { lastErrorCode, capacityShort, nextAttemptAt, deletedAt, ...fields } = input;
  // As the manager stores a cause: the client-safe sentence beside the operator's detail.
  const lastError = capacityShort
    ? {
        code: MANAGED_RUNNER_CAPACITY_UNAVAILABLE,
        message: capacityShortMessage(capacityShort),
        retryable: true,
        detail: capacityShort.length ? `short of ${capacityShort.join(', ')}` : 'the pool moved while admitting',
        short: capacityShort,
      }
    : lastErrorCode
      ? { ...managedRunnerReason(lastErrorCode), detail: 'an operator detail no client may see' }
      : null;
  return {
    id: '0195c0de-0000-7000-8000-00000000e0f0',
    ownerId: '0195c0de-0000-7000-8000-00000000e0f1',
    runnerId: fixture.ids.runner,
    defaultWorkspaceId: fixture.ids.workspace,
    desiredState: 'RUNNING',
    managementState: 'REQUESTED',
    generation: 0,
    revision: 0,
    clusterKey: 'test-cluster',
    namespace: 'orbit-managed',
    pvcName: `mr-data-${fixture.ids.runner}`,
    pvcUid: null,
    pvUid: null,
    volumeHandle: null,
    podName: `mr-${fixture.ids.runner}`,
    podUid: null,
    nodeName: null,
    nodeUid: null,
    reservation: null,
    demandRevision: 0,
    lastDemandAt: null,
    capacityRevision: null,
    drainDemandRevision: null,
    stopRequestedAt: null,
    stopAcknowledgedAt: null,
    initialProvider: null,
    resourceProfileId: 'test-profile',
    resourceOperationId: null,
    resourceOperationKind: null,
    resourceOperationState: null,
    attempt: 0,
    nextAttemptAt: typeof nextAttemptAt === 'string' ? new Date(nextAttemptAt) : null,
    startupDeadlineAt: null,
    lastError,
    fencingReceipt: null,
    leaseHolder: null,
    leaseExpiresAt: null,
    lastRequestKey: null,
    stateEnteredAt: NOW,
    deletedAt: typeof deletedAt === 'string' ? new Date(deletedAt) : null,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  } as ManagedRunner;
}

/** The body as it leaves the server: JSON, with every public id in both spellings. */
function served(status: unknown): unknown {
  return addTwins(JSON.parse(JSON.stringify(status)), true);
}

test('every state in the fixture is the body GET /api/managed-runner answers for its stored inputs', () => {
  assert.ok(fixture.states.length > 0);
  for (const { name, server, status } of fixture.states) {
    const derived = managedRunnerStatus({
      enabled: server.enabled,
      available: server.available,
      eligible: server.eligible,
      mapping: server.mapping ? row(server.mapping) : null,
      runner: server.runner
        ? { status: server.runner.status, lastHeartbeatAt: server.runner.lastHeartbeatAt ? new Date(server.runner.lastHeartbeatAt) : null }
        : null,
      now: NOW,
      heartbeatFreshMs: fixture.heartbeatFreshMs,
    });
    assert.deepEqual(status, served(derived), name);
  }
});

test('the fixture covers every state a client renders, and no operator detail reaches one', () => {
  const states = new Set(fixture.states.map(({ status }) => (status as { managementState: string }).managementState));
  for (const state of ['NOT_PROVISIONED', 'REQUESTED', 'WAITING_CAPACITY', 'PROVISIONING', 'STARTING', 'READY', 'DRAINING', 'SLEEPING', 'FENCING', 'FAILED', 'DELETING', 'DELETED']) {
    assert.ok(states.has(state), `a case in ${state}`);
  }
  assert.ok(!JSON.stringify(fixture.states.map(({ status }) => status)).includes('operator detail'));
});

test('the switch answers in the fixture are what the capability route says', () => {
  const route = (enabled: boolean) =>
    new AuthController({} as never, {} as never, { enabled } as never).capabilities();
  const answers = new Map(fixture.capabilities.map(({ name, body }) => [name, body]));
  assert.deepEqual(answers.get('switched off'), route(false));
  assert.deepEqual(answers.get('switched on'), route(true));
});
