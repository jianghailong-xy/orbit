import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FAILURE_COORDINATOR_CLAIM_SLA_SECONDS,
  failureCoordinationSemanticTuple,
  readFailureCoordination,
} from './failure-coordination-read';

const OWNER = '00000000-0000-7000-8000-000000000001';
const PROJECT = '00000000-0000-7000-8000-000000000002';
const SOURCE = '00000000-0000-7000-8000-000000000003';
const SUCCESSOR = '00000000-0000-7000-8000-000000000004';
const NOW = new Date('2026-08-30T12:00:00.000Z');
const HEX = (value: string) => value.repeat(64).slice(0, 64);

function row(overrides: Record<string, unknown> = {}) {
  return {
    obligationId: '00000000-0000-7000-8000-000000000010',
    obligationRevision: HEX('a'),
    projectId: PROJECT,
    sourceTaskId: SOURCE,
    sourceTaskTitle: 'prepare-postgres',
    sourceTaskStatus: 'FAILED',
    continuationId: '00000000-0000-7000-8000-000000000011',
    continuationStatus: 'ACTIVE',
    bindingRevision: 1n,
    attemptGeneration: 1n,
    failureFingerprint: HEX('b'),
    reasonCode: 'EXECUTABLE_EXIT_NONZERO',
    obligationCreatedAt: new Date('2026-08-30T11:59:50.000Z'),
    attemptId: '00000000-0000-7000-8000-000000000012',
    attemptSessionId: '00000000-0000-7000-8000-000000000013',
    terminationKind: 'EXITED',
    actualExitCode: 1,
    signal: null,
    terminatedAt: new Date('2026-08-30T11:59:49.000Z'),
    receiptDigest: HEX('c'),
    outputDigest: HEX('d'),
    evaluationPlanDigest: HEX('e'),
    wakeupState: 'DELIVERED',
    wakeupCreatedAt: new Date('2026-08-30T11:59:50.000Z'),
    wakeupDeliveredAt: new Date('2026-08-30T11:59:55.000Z'),
    wakeupSessionId: '00000000-0000-7000-8000-000000000014',
    deliveryAttempts: 1,
    routeDecisionId: '00000000-0000-7000-8000-000000000015',
    routeBindingDigest: HEX('f'),
    routeDecisionDigest: HEX('1'),
    failureDomain: 'EVALUATION_HARNESS',
    failureNode: 'FIXTURE_SETUP',
    ownerReason: null,
    canonicalReason: {
      code: 'FAILURE_CONTINUATION_EVALUATION_HARNESS',
      failureDomain: 'EVALUATION_HARNESS',
      failureNode: 'FIXTURE_SETUP',
      failureFingerprint: HEX('b'),
    },
    canonicalReasonDigest: HEX('2'),
    evidence: { outputDigest: HEX('d'), fact: 'missing prisma/config' },
    evidenceDigest: HEX('3'),
    evidenceSources: [{ kind: 'FAILURE_ATTEMPT_RECEIPT', locator: 'receipt' }],
    routeDeadlineAt: new Date('2026-08-30T12:30:00.000Z'),
    projectAttention: false,
    unchangedEvidenceGenerations: 1,
    handoffId: null,
    successorTaskId: null,
    successorTitle: null,
    successorStatus: null,
    handoffBindingGeneration: null,
    handoffBindingDigest: null,
    autoDispatchRequested: null,
    requiresOwner: null,
    dependencyRebindCount: null,
    committedAt: null,
    hasLiveRun: false,
    currentBindingGeneration: null,
    currentSuccessorTaskId: null,
    ...overrides,
  };
}

function prismaWith(rows: unknown[]) {
  return { $queryRaw: async () => rows } as never;
}

test('ordinary engineering failure stays in automatic repair and out of both human surfaces', async () => {
  const prisma = prismaWith([row()]);
  const [task, project, agent, attention, inbox] = await Promise.all([
    readFailureCoordination(prisma, {
      tenantId: OWNER, taskIds: [SOURCE], surface: 'TASK_DETAIL', observedAt: NOW,
    }),
    readFailureCoordination(prisma, {
      tenantId: OWNER, projectIds: [PROJECT], surface: 'PROJECT_WORK_OVERVIEW', observedAt: NOW,
    }),
    readFailureCoordination(prisma, {
      tenantId: OWNER, projectIds: [PROJECT], surface: 'AGENT_QUEUE', observedAt: NOW,
    }),
    readFailureCoordination(prisma, {
      tenantId: OWNER, projectIds: [PROJECT], surface: 'PROJECT_ATTENTION', observedAt: NOW,
    }),
    readFailureCoordination(prisma, {
      tenantId: OWNER, projectIds: [PROJECT], surface: 'OWNER_DECISION_INBOX', observedAt: NOW,
    }),
  ]);
  assert.equal(task.items[0].stage, 'AUTOMATIC_REPAIR');
  assert.equal(task.items[0].failureNode, 'FIXTURE_SETUP');
  assert.equal(task.items[0].failedAttempt.preserved, true);
  assert.equal(task.items[0].cta?.kind, 'CREATE_REPAIR_SUCCESSOR');
  assert.deepEqual(
    failureCoordinationSemanticTuple(task.items[0]),
    failureCoordinationSemanticTuple(project.items[0]),
  );
  assert.deepEqual(
    failureCoordinationSemanticTuple(project.items[0]),
    failureCoordinationSemanticTuple(agent.items[0]),
  );
  assert.equal(attention.items.length, 0);
  assert.equal(inbox.items.length, 0);
});

test('a unique successor changes every surface to the same rebound binding and revalidation stage', async () => {
  const handoff = row({
    continuationStatus: 'RESOLVED',
    handoffId: '00000000-0000-7000-8000-000000000020',
    successorTaskId: SUCCESSOR,
    successorTitle: 'repair prisma config',
    successorStatus: 'OPEN',
    handoffBindingGeneration: 1n,
    handoffBindingDigest: HEX('4'),
    autoDispatchRequested: true,
    requiresOwner: false,
    dependencyRebindCount: 2,
    committedAt: new Date('2026-08-30T12:00:01.000Z'),
    hasLiveRun: true,
    currentBindingGeneration: 1n,
    currentSuccessorTaskId: SUCCESSOR,
  });
  const model = await readFailureCoordination(prismaWith([handoff]), {
    tenantId: OWNER,
    taskIds: [SOURCE],
    surface: 'TASK_DETAIL',
    observedAt: NOW,
  });
  assert.equal(model.items[0].stage, 'AUTOMATIC_REVALIDATION');
  assert.equal(model.items[0].bindingDigest, HEX('4'));
  assert.equal(model.items[0].successor?.taskId, SUCCESSOR);
  assert.equal(model.items[0].successor?.autoDispatchRequested, true);
  assert.equal(model.items[0].cta?.kind, 'VIEW_SUCCESSOR');
});

test('only missed claim SLA, three-generation convergence and owner-only routes need attention', async () => {
  const stale = row({
    routeDecisionId: null,
    routeBindingDigest: null,
    routeDecisionDigest: null,
    failureDomain: null,
    failureNode: null,
    canonicalReason: null,
    canonicalReasonDigest: null,
    evidence: null,
    evidenceDigest: null,
    evidenceSources: null,
    routeDeadlineAt: null,
    wakeupState: 'PENDING',
    wakeupCreatedAt: new Date(NOW.getTime() - (FAILURE_COORDINATOR_CLAIM_SLA_SECONDS + 1) * 1_000),
    wakeupDeliveredAt: null,
    wakeupSessionId: null,
  });
  const convergence = row({
    obligationId: '00000000-0000-7000-8000-000000000030',
    projectAttention: true,
    unchangedEvidenceGenerations: 3,
  });
  const ownerOnly = row({
    obligationId: '00000000-0000-7000-8000-000000000040',
    failureDomain: 'OWNER_REQUIRED',
    failureNode: 'GOAL_BOUNDARY',
    ownerReason: 'GOAL_DECISION',
    canonicalReason: {
      code: 'FAILURE_CONTINUATION_OWNER_REQUIRED',
      failureDomain: 'OWNER_REQUIRED',
      failureNode: 'GOAL_BOUNDARY',
    },
  });
  const attention = await readFailureCoordination(prismaWith([stale, convergence, ownerOnly]), {
    tenantId: OWNER,
    projectIds: [PROJECT],
    surface: 'PROJECT_ATTENTION',
    observedAt: NOW,
  });
  assert.deepEqual(
    new Set(attention.items.map((item) => item.attention.reasonCode)),
    new Set(['COORDINATOR_SLA_UNCLAIMED', 'CONVERGENCE_FAILED', 'OWNER_ONLY_DECISION']),
  );
  const inbox = await readFailureCoordination(prismaWith([stale, convergence, ownerOnly]), {
    tenantId: OWNER,
    projectIds: [PROJECT],
    surface: 'OWNER_DECISION_INBOX',
    observedAt: NOW,
  });
  assert.deepEqual(inbox.items.map((item) => item.attention.reasonCode), ['OWNER_ONLY_DECISION']);
});

test('an expired bound CTA becomes unavailable without changing its canonical tuple', async () => {
  const expired = row({ routeDeadlineAt: new Date(NOW.getTime() - 1) });
  const before = await readFailureCoordination(prismaWith([expired]), {
    tenantId: OWNER,
    projectIds: [PROJECT],
    surface: 'TASK_DETAIL',
    observedAt: NOW,
  });
  assert.equal(before.items[0].cta, null);
  assert.equal(before.items[0].ctaUnavailableReason, 'CTA_EXPIRED');
  assert.equal(before.items[0].attention.reasonCode, 'COORDINATOR_SLA_STALE');
  assert.equal(before.items[0].obligationRevision, HEX('a'));
  assert.equal(before.items[0].canonicalReasonDigest, HEX('2'));
});
