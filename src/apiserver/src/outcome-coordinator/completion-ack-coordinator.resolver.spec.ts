import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunStatus } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { OutcomeCoordinatorContext } from '../outcome-reconciler/outcome-coordinator.service';
import type { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import { CompletionAckCoordinatorResolver } from './completion-ack-coordinator.resolver';

const DIGEST = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);

function context(): OutcomeCoordinatorContext {
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const affectedSessionId = randomUUID();
  return {
    claim: {
      coordinationId: randomUUID(),
      tenantId,
      projectId,
      obligationId: DIGEST,
      obligationRevision: REVISION,
      capability: 'completion-ack.recover',
      attemptNumber: 1,
      attemptBudgetRemaining: 99,
      diagnosticPath: 'PRIMARY_RECOVERY',
      leaseId: randomUUID(),
      leaseToken: randomUUID(),
      leaseExpiresLogicalTime: '1000',
      sourceObligation: {
        obligationId: DIGEST,
        obligationRevision: REVISION,
        bindingDigest: REVISION,
        kind: 'COMPLETION_ACK_STALE',
        owner: 'PROJECT_COORDINATOR',
        capability: 'completion-ack.recover',
        binding: { tenantId, projectId, taskId, sessionId: affectedSessionId },
      },
      workerId: 'worker-1',
    } as OutcomeCoordinatorContext['claim'],
    logicalNow: '900',
    signal: new AbortController().signal,
  };
}

function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceActive: true,
    sourceClosed: false,
    latestDeliveryRevoked: false,
    latestPlan: null,
    latestDelivery: null,
    remediationActions: [],
    activeTaskCount: 0,
    settledTaskCount: 0,
    ...over,
  };
}

function harness(responses: unknown[], forcedWakeId = randomUUID()) {
  const calls: unknown[] = [];
  const prisma = {
    $queryRaw: async (query: unknown) => {
      calls.push(query);
      const response = responses.shift();
      if (response === undefined) throw new Error('unexpected SQL call');
      return response;
    },
  } as unknown as PrismaService;
  const wakes: unknown[][] = [];
  const judgments = {
    wakePlanned: async (...args: unknown[]) => {
      wakes.push(args);
      return {
        outcome: 'OPENED',
        wakeId: forcedWakeId,
        idempotencyKey: 'key',
        sessionId: args[2] as string,
      };
    },
  } as unknown as CoordinatorJudgmentService;
  const published: string[] = [];
  const realtime = {
    publishSessionUpdated: (id: string) => published.push(id),
  } as unknown as RealtimeService;
  return {
    resolver: new CompletionAckCoordinatorResolver(prisma, judgments, realtime),
    calls,
    wakes,
    published,
  };
}

function planned() {
  return {
    planId: randomUUID(),
    targetSessionId: randomUUID(),
    subjectVersion: `delivery:${randomUUID()}`,
    replayed: false,
  };
}

function receipt(plan: ReturnType<typeof planned>, wakeId = randomUUID()) {
  return {
    deliveryReceiptId: randomUUID(),
    planId: plan.planId,
    sessionId: plan.targetSessionId,
    wakeId,
    replayed: false,
    adopted: false,
  };
}

test('an ACTIVE source is delivered through a pre-planned id and remains non-terminal', async () => {
  const plan = planned();
  const wakeId = randomUUID();
  const delivery = receipt(plan, wakeId);
  const h = harness([
    [{ state: state() }],
    [{ plan }],
    [{ receipt: delivery }],
  ], wakeId);

  const answer = await h.resolver.resolve(context());
  assert.equal(answer.kind, 'DELIVERED');
  assert.equal(h.wakes.length, 1);
  assert.equal(h.wakes[0][2], plan.targetSessionId);
  assert.deepEqual(h.published.length, 1);
  assert.equal(h.calls.length, 3);
});

test('an incomplete delivery plan is adopted instead of creating a second plan', async () => {
  const plan = planned();
  const wakeId = randomUUID();
  const h = harness([
    [{ state: state({ latestPlan: plan }) }],
    [{ receipt: receipt(plan, wakeId) }],
  ], wakeId);

  assert.equal((await h.resolver.resolve(context())).kind, 'DELIVERED');
  assert.equal(h.calls.length, 2, 'state + receipt: no second plan was minted');
  assert.equal(h.wakes[0][2], plan.targetSessionId);
});

test('an active remediation task suppresses duplicate coordinator delivery', async () => {
  const prior = {
    deliveryReceiptId: randomUUID(), planId: randomUUID(), wakeId: randomUUID(),
    sessionId: randomUUID(), sessionStatus: RunStatus.AWAITING_INPUT,
    engineTurnActive: false, retryAt: null,
  };
  const h = harness([[{ state: state({ latestDelivery: prior, activeTaskCount: 1 }) }]]);

  const answer = await h.resolver.resolve(context());
  assert.equal(answer.kind, 'EXTERNAL_WAIT');
  assert.equal(h.wakes.length, 0);
  assert.equal(h.calls.length, 1);
});

test('AWAITING_INPUT with no action is not accepted as progress and is re-delivered', async () => {
  const prior = {
    deliveryReceiptId: randomUUID(), planId: randomUUID(), wakeId: randomUUID(),
    sessionId: randomUUID(), sessionStatus: RunStatus.AWAITING_INPUT,
    engineTurnActive: false, retryAt: null,
  };
  const plan = planned();
  const wakeId = randomUUID();
  const h = harness([
    [{ state: state({ latestDelivery: prior }) }],
    [{ plan }],
    [{ receipt: receipt(plan, wakeId) }],
  ], wakeId);

  assert.equal((await h.resolver.resolve(context())).kind, 'DELIVERED');
  assert.equal(h.wakes.length, 1);
});

test('a revoked receipt is never reused as delivery authority', async () => {
  const revokedPlan = planned();
  const revokedDelivery = {
    ...receipt(revokedPlan),
    sessionStatus: RunStatus.RUNNING,
    engineTurnActive: true,
    retryAt: null,
  };
  const replacementPlan = planned();
  const wakeId = randomUUID();
  const h = harness([
    [{ state: state({
      latestPlan: revokedPlan,
      latestDelivery: revokedDelivery,
      latestDeliveryRevoked: true,
    }) }],
    [{ plan: replacementPlan }],
    [{ receipt: receipt(replacementPlan, wakeId) }],
  ], wakeId);

  assert.equal((await h.resolver.resolve(context())).kind, 'DELIVERED');
  assert.equal(h.wakes.length, 1);
  assert.equal(h.wakes[0][2], replacementPlan.targetSessionId);
  assert.notEqual(h.wakes[0][2], revokedPlan.targetSessionId);
});

test('settled actions while ACK remains ACTIVE route the next recovery step', async () => {
  const prior = {
    deliveryReceiptId: randomUUID(), planId: randomUUID(), wakeId: randomUUID(),
    sessionId: randomUUID(), sessionStatus: RunStatus.AWAITING_INPUT,
    engineTurnActive: false, retryAt: null,
  };
  const plan = planned();
  const wakeId = randomUUID();
  const h = harness([
    [{ state: state({ latestDelivery: prior, settledTaskCount: 1 }) }],
    [{ plan }],
    [{ receipt: receipt(plan, wakeId) }],
  ], wakeId);

  assert.equal((await h.resolver.resolve(context())).kind, 'DELIVERED');
  assert.equal(h.wakes.length, 1);
});

test('the exact canonical CLOSED source, not a Session outcome, resolves the claim', async () => {
  const h = harness([[{
    state: state({ sourceActive: false, sourceClosed: true }),
  }]]);

  const answer = await h.resolver.resolve(context());
  assert.equal(answer.kind, 'RESOLVED');
  assert.equal(h.wakes.length, 0);
  assert.equal(h.calls.length, 1);
});
