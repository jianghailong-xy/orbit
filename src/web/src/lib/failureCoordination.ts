export type FailureCoordinationStage =
  | 'AUTOMATIC_DIAGNOSIS'
  | 'AUTOMATIC_REPAIR'
  | 'AUTOMATIC_REVALIDATION'
  | 'EXTERNAL_WAIT'
  | 'NEEDS_YOU';

export interface FailureCoordinationSummary {
  total: number;
  active: number;
  automaticDiagnosis: number;
  automaticRepair: number;
  automaticRevalidation: number;
  externalWait: number;
  needsYou: number;
  attentionRequired: number;
  attentionSinceAt: string | null;
  byAttentionReason: Record<string, number | undefined>;
}

export interface CanonicalFailureCoordination {
  schemaVersion: 1;
  obligationId: string;
  obligationRevision: string;
  projectId: string;
  sourceTaskId: string;
  sourceTaskTitle: string;
  sourceTaskStatus: string;
  continuationId: string;
  continuationStatus: string;
  bindingDigest: string;
  binding: Record<string, unknown>;
  canonicalReason: Record<string, unknown>;
  canonicalReasonDigest: string;
  failureNode: string;
  failureFingerprint: string;
  evidence: Record<string, unknown>;
  evidenceDigest: string;
  evidenceSources: unknown[];
  stage: FailureCoordinationStage;
  deadlineAt: string;
  coordinator: {
    claimSlaSeconds: number;
    claimDeadlineAt: string;
    wakeupState: string;
    deliveredAt: string | null;
    sessionId: string | null;
    deliveryAttempts: number;
  };
  failedAttempt: {
    attemptId: string;
    sessionId: string;
    terminationKind: string;
    actualExitCode: number | null;
    signal: string | null;
    terminatedAt: string;
    receiptDigest: string;
    preserved: true;
  };
  successor: null | {
    taskId: string;
    title: string;
    status: string;
    bindingGeneration: string;
    bindingDigest: string;
    autoDispatchRequested: boolean;
    requiresOwner: boolean;
    dependencyRebindCount: number;
    committedAt: string;
    hasLiveRun: boolean;
  };
  attention: {
    required: boolean;
    reasonCode: string | null;
    sinceAt: string | null;
  };
  ownerOnly: boolean;
  active: boolean;
  cta: null | {
    kind: string;
    method: string;
    href: string;
    expiresAt: string;
    binding: Record<string, unknown>;
  };
  ctaUnavailableReason: string | null;
  observedAt: string;
}

export interface FailureCoordinationReadModel {
  schemaVersion: 1;
  surface: string;
  observedAt: string;
  claimSlaSeconds: number;
  summary: FailureCoordinationSummary;
  semanticIndex: Array<{
    obligationId: string;
    obligationRevision: string;
    bindingDigest: string;
    binding: Record<string, unknown>;
    reason: Record<string, unknown>;
  }>;
  items: CanonicalFailureCoordination[];
}

export const FAILURE_STAGE_LABEL: Record<FailureCoordinationStage, string> = {
  AUTOMATIC_DIAGNOSIS: '自动诊断',
  AUTOMATIC_REPAIR: '自动修复',
  AUTOMATIC_REVALIDATION: '自动重验',
  EXTERNAL_WAIT: '外部等待',
  NEEDS_YOU: 'Needs you',
};

/** Web may arrange fields, but it must not reinterpret the cross-client semantic identity. */
export function failureCoordinationSemanticTuple(item: CanonicalFailureCoordination) {
  return {
    obligationId: item.obligationId,
    obligationRevision: item.obligationRevision,
    bindingDigest: item.bindingDigest,
    binding: item.binding,
    reason: item.canonicalReason,
  };
}

export function canonicalReasonLabel(item: CanonicalFailureCoordination): string {
  const code = String(item.canonicalReason.code ?? 'FAILURE_CONTINUATION');
  const domain = String(item.canonicalReason.failureDomain ?? 'UNCLASSIFIED');
  return `${code} · ${domain}`;
}
