import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrismaService } from '../prisma/prisma.service';
import {
  normalizeCompletionAckObligation,
  readCompletionAckObligations,
  type CompletionAckActiveObligationRow,
} from './completion-ack-obligation';

const ROW: CompletionAckActiveObligationRow = {
  tenantId: '00000000-0000-7000-8000-000000000001',
  projectId: '00000000-0000-7000-8000-000000000002',
  taskId: '00000000-0000-7000-8000-000000000003',
  sessionId: '00000000-0000-7000-8000-000000000004',
  turnId: '00000000-0000-7000-8000-000000000005',
  errorFingerprint: 'P0001:TASK_DONE_CANONICAL_FACT_REQUIRED',
  obligationId: '00000000-0000-7000-8000-000000000006',
  obligationRevision: 'revision-1',
  obligation: {
    factKind: 'CONTROL_PLANE_COMMIT_REJECTED',
    owner: 'PROJECT_COORDINATOR',
    reason: { code: 'P0001', message: 'canonical completion commit was rejected' },
    nextAction: 'RECONCILE_ORIGINAL_COMPLETION_RECEIPT',
  },
  firstFailureAt: new Date('2026-08-28T12:00:00.000Z'),
  latestFailureAt: new Date('2026-08-28T12:01:00.000Z'),
  observationCount: 2,
};

test('one normalizer preserves the canonical identity and action on every surface', () => {
  const normalized = normalizeCompletionAckObligation(ROW);
  assert.deepEqual(
    [normalized.obligationId, normalized.obligationRevision, normalized.bindingDigest],
    [ROW.obligationId, ROW.obligationRevision, ROW.obligationRevision],
  );
  assert.equal(normalized.capability, 'completion-ack.recover');
  assert.equal(normalized.tenantId, ROW.tenantId);
  assert.equal(normalized.reasonCode, 'P0001');
  assert.equal(normalized.reason, 'canonical completion commit was rejected');
  assert.equal(normalized.owner, 'PROJECT_COORDINATOR');
  assert.equal(normalized.requiredAction, 'RECONCILE_ORIGINAL_COMPLETION_RECEIPT');
  assert.equal(normalized.observationCount, 2);
});

test('the operational overlay enriches actions without minting another obligation identity', () => {
  const delivery = {
    action: 'COORDINATOR_DELIVERY',
    outcome: 'RUNNING',
    deliveryReceiptId: '00000000-0000-7000-8000-000000000007',
  };
  const remediation = {
    action: 'TASK_CREATED',
    outcome: 'IN_PROGRESS',
    taskId: '00000000-0000-7000-8000-000000000008',
  };
  const normalized = normalizeCompletionAckObligation({
    ...ROW,
    obligation: {
      ...(ROW.obligation as Record<string, unknown>),
      attemptedActions: [delivery, remediation],
      remediationActions: [remediation],
      operationalAction: 'WAIT_FOR_REMEDIATION_TASKS',
      currentDelivery: { deliveryReceiptId: delivery.deliveryReceiptId },
      actionProtocol: {
        name: 'completion-ack-recovery',
        operationalSource: 'COMPLETION_ACK_DELIVERY_AND_REMEDIATION_LEDGER',
      },
    },
  });

  assert.deepEqual(
    [normalized.obligationId, normalized.obligationRevision, normalized.bindingDigest],
    [ROW.obligationId, ROW.obligationRevision, ROW.obligationRevision],
  );
  assert.equal(normalized.requiredAction, 'RECONCILE_ORIGINAL_COMPLETION_RECEIPT');
  assert.equal(normalized.operationalAction, 'WAIT_FOR_REMEDIATION_TASKS');
  assert.deepEqual(normalized.attemptedActions, [delivery, remediation]);
  assert.deepEqual(normalized.remediationActions, [remediation]);
  assert.equal(
    (normalized.actionProtocol as Record<string, unknown>).operationalSource,
    'COMPLETION_ACK_DELIVERY_AND_REMEDIATION_LEDGER',
  );
});

test('partial focused-unit Prisma doubles do not have to emulate the canonical SQL view', async () => {
  let queried = false;
  const partial = {
    $queryRaw: async () => {
      queried = true;
      return [ROW];
    },
  } as unknown as PrismaService;
  assert.deepEqual(await readCompletionAckObligations(partial, { tenantId: ROW.tenantId }), []);
  assert.equal(queried, false);
});

test('a complete Prisma surface never turns a broken production view into no blocker', async () => {
  const unavailable = new Error('completion_ack_active_obligation does not exist');
  const complete = {
    $queryRaw: async () => { throw unavailable; },
    $queryRawUnsafe: async () => [],
  } as unknown as PrismaService;
  await assert.rejects(
    readCompletionAckObligations(complete, { tenantId: ROW.tenantId }),
    (error) => error === unavailable,
  );
});
