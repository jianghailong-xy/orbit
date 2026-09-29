import { type CoordinatorWakeEvent, type WakeFact, wakeIdempotencyKey } from './coordinator-wake';

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

/** The three immutable columns one evidence revision is identified by. */
export interface CompletionEvidenceRevision {
  revision: string;
  criterionRevision: string;
  evidenceDigest: string;
}

/** The event an evidence revision is recorded under — and in an Automatic project delivered as. */
const COMPLETION_EVIDENCE_EVENT: CoordinatorWakeEvent = 'COMPLETION_EVIDENCE_REVISED';

function completionEvidenceVersion(input: CompletionEvidenceRevision): string {
  return [input.revision, input.criterionRevision, input.evidenceDigest].join(':');
}

/**
 * Every version below is made only from the immutable fact that changed. Session lifecycle,
 * project task-set membership and timestamps are deliberately absent.
 */
export function completionEvidenceRevisedFact(input: CompletionEvidenceRevision & {
  projectId: string;
  taskId: string;
}): WakeFact {
  return {
    event: 'COMPLETION_EVIDENCE_REVISED',
    projectId: input.projectId,
    subjectType: 'TASK',
    subjectId: input.taskId,
    subjectVersion: completionEvidenceVersion(input),
    detail: {
      evidenceRevision: input.revision,
      criterionRevision: input.criterionRevision,
      evidenceDigest: input.evidenceDigest,
    },
  };
}

/**
 * The key the wake of one evidence revision is claimed under: the key of the fact above, computed
 * without building it — for a READ that looks a revision's delivery back up
 * (`tasks/pending-evidence-judgments.ts`), which is not a producer of the fact and should not be
 * counted as one by the census of producers (`coordinator-disabled-negatives.spec.ts`).
 * `completion-input.spec.ts` holds the two spellings to one key.
 */
export function completionEvidenceWakeKey(
  taskId: string,
  input: CompletionEvidenceRevision,
): string {
  return wakeIdempotencyKey({
    event: COMPLETION_EVIDENCE_EVENT,
    subjectType: 'TASK',
    subjectId: taskId,
    subjectVersion: completionEvidenceVersion(input),
  });
}
