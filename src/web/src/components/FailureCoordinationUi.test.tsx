import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { attentionChipOf, attentionReasonOf, attentionSectionOf } from '../lib/projectAttention';
import type {
  CanonicalFailureCoordination,
  FailureCoordinationReadModel,
  FailureCoordinationSummary,
} from '../lib/failureCoordination';
import { FailureCoordinationCard } from './FailureCoordinationCard';
import { FailureCoordinationOverview } from './ProjectPanoramaHeader';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');
const HEX = (value: string) => value.repeat(64).slice(0, 64);

function summary(overrides: Partial<FailureCoordinationSummary> = {}): FailureCoordinationSummary {
  return {
    total: 1,
    active: 1,
    automaticDiagnosis: 0,
    automaticRepair: 1,
    automaticRevalidation: 0,
    externalWait: 0,
    needsYou: 0,
    attentionRequired: 0,
    attentionSinceAt: null,
    byAttentionReason: {},
    ...overrides,
  };
}

function project(failureCoordination: FailureCoordinationSummary) {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    title: 'Isolated PostgreSQL fixture',
    status: 'OPEN' as const,
    createdAt: '2026-08-30T11:00:00.000Z',
    _count: { tasks: 1 },
    buckets: {
      running: 0,
      ready: 0,
      blocked: 0,
      awaitingVerification: 0,
      done: 0,
      failed: 1,
      cancelled: 0,
    },
    lastActivityAt: '2026-08-30T11:59:00.000Z',
    failureCoordination,
  };
}

function item(): CanonicalFailureCoordination {
  return {
    schemaVersion: 1,
    obligationId: '00000000-0000-7000-8000-000000000010',
    obligationRevision: HEX('a'),
    projectId: '00000000-0000-7000-8000-000000000001',
    sourceTaskId: '00000000-0000-7000-8000-000000000002',
    sourceTaskTitle: 'prepare-postgres',
    sourceTaskStatus: 'FAILED',
    continuationId: '00000000-0000-7000-8000-000000000011',
    continuationStatus: 'ACTIVE',
    bindingDigest: HEX('b'),
    binding: { sourceTaskId: '00000000-0000-7000-8000-000000000002' },
    canonicalReason: {
      code: 'FAILURE_CONTINUATION_EVALUATION_HARNESS',
      failureDomain: 'EVALUATION_HARNESS',
      failureNode: 'FIXTURE_SETUP',
    },
    canonicalReasonDigest: HEX('c'),
    failureNode: 'FIXTURE_SETUP',
    failureFingerprint: HEX('d'),
    evidence: { fact: 'Cannot find module prisma/config' },
    evidenceDigest: HEX('e'),
    evidenceSources: [{ kind: 'FAILURE_ATTEMPT_RECEIPT', locator: 'receipt' }],
    stage: 'AUTOMATIC_REPAIR',
    deadlineAt: '2026-08-30T12:30:00.000Z',
    coordinator: {
      claimSlaSeconds: 60,
      claimDeadlineAt: '2026-08-30T12:01:00.000Z',
      wakeupState: 'DELIVERED',
      deliveredAt: '2026-08-30T12:00:02.000Z',
      sessionId: '00000000-0000-7000-8000-000000000012',
      deliveryAttempts: 1,
    },
    failedAttempt: {
      attemptId: '00000000-0000-7000-8000-000000000013',
      sessionId: '00000000-0000-7000-8000-000000000014',
      terminationKind: 'EXITED',
      actualExitCode: 1,
      signal: null,
      terminatedAt: '2026-08-30T11:59:59.000Z',
      receiptDigest: HEX('f'),
      preserved: true,
    },
    successor: null,
    attention: { required: false, reasonCode: null, sinceAt: null },
    ownerOnly: false,
    active: true,
    cta: null,
    ctaUnavailableReason: null,
    observedAt: '2026-08-30T12:00:03.000Z',
  };
}

describe('Failure Coordination UI routing', () => {
  it('keeps an ordinary FAILED engineering task out of Needs attention', () => {
    const row = project(summary());
    expect(attentionReasonOf(row, NOW)).toBeNull();
    expect(attentionSectionOf(row, NOW)).toBe('waiting');
    expect(attentionChipOf(row, NOW)).toBeNull();
  });

  it('routes only a canonical failure escalation to Needs you', () => {
    const row = project(summary({
      automaticRepair: 0,
      needsYou: 1,
      attentionRequired: 1,
      attentionSinceAt: '2026-08-30T11:58:00.000Z',
      byAttentionReason: { COORDINATOR_SLA_UNCLAIMED: 1 },
    }));
    expect(attentionReasonOf(row, NOW)).toBe('failure-needs-you');
    expect(attentionSectionOf(row, NOW)).toBe('attention');
    expect(attentionChipOf(row, NOW)?.text).toContain('COORDINATOR_SLA_UNCLAIMED 1');
  });

  it('renders reason, node, fingerprint, evidence, stage, deadline and successor binding', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><FailureCoordinationCard item={item()} /></MemoryRouter>,
    );
    expect(html).toContain('data-obligation-id="00000000-0000-7000-8000-000000000010"');
    expect(html).toContain('FAILURE_CONTINUATION_EVALUATION_HARNESS');
    expect(html).toContain('FIXTURE_SETUP');
    expect(html).toContain('Cannot find module prisma/config');
    expect(html).toContain('自动修复');
    expect(html).toContain('Coordinator has not rebound this obligation yet');
    expect(html).toContain('preserved');
  });

  it('shows all five project coordination states in Work Overview', () => {
    const model: FailureCoordinationReadModel = {
      schemaVersion: 1,
      surface: 'PROJECT_WORK_OVERVIEW',
      observedAt: '2026-08-30T12:00:00.000Z',
      claimSlaSeconds: 60,
      summary: summary({
        total: 5,
        active: 5,
        automaticDiagnosis: 1,
        automaticRepair: 1,
        automaticRevalidation: 1,
        externalWait: 1,
        needsYou: 1,
        attentionRequired: 1,
      }),
      semanticIndex: [],
      items: [],
    };
    const html = renderToStaticMarkup(<FailureCoordinationOverview model={model} />);
    for (const label of ['自动诊断', '自动修复', '自动重验', '外部等待', 'Needs you']) {
      expect(html).toContain(label);
    }
  });
});
