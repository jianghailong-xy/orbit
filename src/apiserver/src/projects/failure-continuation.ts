import { createHash } from 'node:crypto';

import type { WakeFact } from './coordinator-wake';

export const FAILURE_CONTINUATION_WAKE_EVENT = 'FAILURE_CONTINUATION_ACTIONABLE' as const;
export const FAILURE_CONTINUATION_CAPABILITY = 'failure-continuation.diagnose' as const;

export interface FailureContinuationIdentity {
  goalId: string;
  taskId: string;
  bindingRevision: bigint | number | string;
  attemptGeneration: bigint | number | string;
  failureFingerprint: string;
}

export interface FailureContinuationWakeClaim extends FailureContinuationIdentity {
  outboxId: string;
  obligationId: string;
  tenantId: string;
  continuationId: string;
  idempotencyKey: string;
  plannedSessionId: string;
  leaseOwner: string;
  leaseToken: string;
  leaseGeneration: bigint;
  leasedUntil: Date;
  deliveryAttempts: number;
  reasonCode: string;
  terminationKind: string;
  actualExitCode: number | null;
  signal: string | null;
  receiptDigest: string;
}

/** Keep byte-for-byte aligned with failure_continuation_idempotency_key() in migration 0210. */
export function failureContinuationIdempotencyKey(
  identity: FailureContinuationIdentity,
): string {
  return createHash('sha256').update([
    'failure-continuation:v1',
    `goalId=${identity.goalId.toLowerCase()}`,
    `taskId=${identity.taskId.toLowerCase()}`,
    `bindingRevision=${String(identity.bindingRevision)}`,
    `attemptGeneration=${String(identity.attemptGeneration)}`,
    `failureFingerprint=${identity.failureFingerprint.toLowerCase()}`,
  ].join('\n')).digest('hex');
}

/** One immutable obligation always replays as the same project-coordinator wake fact. */
export function failureContinuationWakeFact(
  claim: FailureContinuationWakeClaim,
): WakeFact {
  return {
    event: FAILURE_CONTINUATION_WAKE_EVENT,
    projectId: claim.goalId,
    subjectType: 'TASK',
    subjectId: claim.taskId,
    subjectVersion: claim.idempotencyKey,
    detail: {
      obligationId: claim.obligationId,
      obligationRevision: claim.idempotencyKey,
      continuationId: claim.continuationId,
      capability: FAILURE_CONTINUATION_CAPABILITY,
      binding: {
        goalId: claim.goalId,
        taskId: claim.taskId,
        bindingRevision: String(claim.bindingRevision),
        attemptGeneration: String(claim.attemptGeneration),
        failureFingerprint: claim.failureFingerprint,
        receiptDigest: claim.receiptDigest,
      },
      reason: {
        code: claim.reasonCode,
        terminationKind: claim.terminationKind,
        actualExitCode: claim.actualExitCode,
        signal: claim.signal,
      },
      nextAction: 'DIAGNOSE_FAILURE_AND_CREATE_A_DISTINCT_SUCCESSOR_IF_NEEDED',
      prohibitedActions: [
        'REWRITE_FAILED_TASK',
        'RETRY_ORIGINAL_COMMAND_VERBATIM',
        'CREATE_OWNER_DECISION_WITHOUT_OWNER_ONLY_REASON',
      ],
    },
  };
}
