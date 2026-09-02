import type { WakeFact } from './coordinator-wake';

/**
 * The durable consumer named by a completion-criterion input.
 *
 * All five are still spelled here because `project_coordinator_wake.consumer_type`'s CHECK
 * accepts exactly these and rows already carry them; `coordinator-wake.spec.ts` holds the two
 * spellings together. Only `JUDGMENT_REQUEST_DERIVER` is still written, and only by the evidence
 * ledger below — the four evaluator/inbox consumers lost their producers with the judgment
 * machinery on 2026-09-02 and are, like the retired wake events, a record of what happened rather
 * than a promise about what will.
 */
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
    },
  };
}
