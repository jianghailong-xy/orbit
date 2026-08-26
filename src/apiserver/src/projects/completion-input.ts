import type { WakeFact } from './coordinator-wake';

/** The durable consumer named by a completion-criterion input. */
export const COMPLETION_INPUT_CONSUMERS = [
  'JUDGMENT_REQUEST_DERIVER',
  'DERIVED_COMPLETION_EVALUATOR',
  'SYSTEM_EXECUTABLE_EVALUATOR',
  'VERIFIER_TASK',
  'HUMAN_INBOX',
] as const;

export type CompletionInputConsumer = (typeof COMPLETION_INPUT_CONSUMERS)[number];

/**
 * Every version below is made only from the immutable fact that changed. Session lifecycle,
 * project task-set membership and timestamps are deliberately absent.
 */
export function completionEvidenceRevisedFact(input: {
  projectId: string;
  taskId: string;
  revision: string;
  criterionRevision: string;
  evidenceDigest: string;
  requestId: string;
  requestKind: string;
}): WakeFact {
  return {
    event: 'COMPLETION_EVIDENCE_REVISED',
    projectId: input.projectId,
    subjectType: 'TASK',
    subjectId: input.taskId,
    subjectVersion: [input.revision, input.criterionRevision, input.evidenceDigest].join(':'),
    detail: {
      evidenceRevision: input.revision,
      criterionRevision: input.criterionRevision,
      evidenceDigest: input.evidenceDigest,
      requestId: input.requestId,
      requestKind: input.requestKind,
    },
  };
}

export function executableResultRecordedFact(input: {
  projectId: string;
  taskId: string;
  requestId: string;
  resultId: string;
  evidenceDigest: string;
  actualExitCode: number;
}): WakeFact {
  return {
    event: 'EXECUTABLE_RESULT_RECORDED',
    projectId: input.projectId,
    subjectType: 'JUDGMENT_REQUEST',
    subjectId: input.requestId,
    subjectVersion: `${input.resultId}:${input.evidenceDigest}`,
    detail: {
      taskId: input.taskId,
      resultId: input.resultId,
      evidenceDigest: input.evidenceDigest,
      actualExitCode: input.actualExitCode,
    },
  };
}

export function verificationVerdictRecordedFact(input: {
  projectId: string;
  taskId: string;
  requestId: string;
  verifierTaskId: string;
  verdictRevision: string;
  evidenceDigest: string;
  verdict: string;
}): WakeFact {
  return {
    event: 'VERIFICATION_VERDICT_RECORDED',
    projectId: input.projectId,
    subjectType: 'JUDGMENT_REQUEST',
    subjectId: input.requestId,
    subjectVersion: `${input.verdictRevision}:${input.evidenceDigest}:${input.verdict}`,
    detail: {
      taskId: input.taskId,
      verifierTaskId: input.verifierTaskId,
      evidenceDigest: input.evidenceDigest,
      verdict: input.verdict,
    },
  };
}

export function humanSignoffRequestedFact(input: {
  projectId: string;
  taskId: string;
  requestId: string;
  criterionRevision: string;
  evidenceDigest: string;
  recipientId: string;
}): WakeFact {
  return {
    event: 'HUMAN_SIGNOFF_REQUESTED',
    projectId: input.projectId,
    subjectType: 'JUDGMENT_REQUEST',
    subjectId: input.requestId,
    subjectVersion: `${input.criterionRevision}:${input.evidenceDigest}`,
    detail: {
      taskId: input.taskId,
      evidenceDigest: input.evidenceDigest,
      recipientId: input.recipientId,
    },
  };
}

export function humanSignoffDecidedFact(input: {
  projectId: string;
  taskId: string;
  requestId: string;
  signoffId: string;
  evidenceDigest: string;
  decision: string;
}): WakeFact {
  return {
    event: 'HUMAN_SIGNOFF_DECIDED',
    projectId: input.projectId,
    subjectType: 'JUDGMENT_REQUEST',
    subjectId: input.requestId,
    subjectVersion: `${input.signoffId}:${input.evidenceDigest}:${input.decision}`,
    detail: {
      taskId: input.taskId,
      signoffId: input.signoffId,
      evidenceDigest: input.evidenceDigest,
      decision: input.decision,
    },
  };
}

export function humanSignoffRequestSupersededFact(input: {
  projectId: string;
  taskId: string;
  requestId: string;
  evidenceDigest: string;
  supersededById: string;
  replacementEvidenceDigest: string;
}): WakeFact {
  return {
    event: 'HUMAN_SIGNOFF_REQUEST_SUPERSEDED',
    projectId: input.projectId,
    subjectType: 'JUDGMENT_REQUEST',
    subjectId: input.requestId,
    subjectVersion: `${input.supersededById}:${input.replacementEvidenceDigest}`,
    detail: {
      taskId: input.taskId,
      evidenceDigest: input.evidenceDigest,
      supersededById: input.supersededById,
      replacementEvidenceDigest: input.replacementEvidenceDigest,
    },
  };
}
