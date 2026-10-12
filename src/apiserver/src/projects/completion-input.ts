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

/**
 * The revision's own three columns — and, for the hand-over a confirmed move makes, the project the
 * task was moved into. The key names no project (`wakeIdempotencyKey`), which was sound while a
 * task never left one; a revision that moves undecided has to be handed to its new project under a
 * key the delivery made before the move cannot have taken.
 */
function completionEvidenceVersion(input: CompletionEvidenceRevision, movedInto?: string | null): string {
  const version = [input.revision, input.criterionRevision, input.evidenceDigest].join(':');
  return movedInto ? `${version}:moved-into:${movedInto}` : version;
}

/**
 * Every version below is made only from the immutable fact that changed. Session lifecycle,
 * project task-set membership and timestamps are deliberately absent.
 *
 * `movedFromProjectId` marks the hand-over a confirmed MOVE_TASK makes of a revision still waiting
 * for its decision (`TasksService.handOverMovedEvidence`): the same revision, now to be decided in
 * `projectId`, keyed with that project so the delivery made before the move does not dedupe it.
 */
export function completionEvidenceRevisedFact(input: CompletionEvidenceRevision & {
  projectId: string;
  taskId: string;
  movedFromProjectId?: string;
}): WakeFact {
  return {
    event: 'COMPLETION_EVIDENCE_REVISED',
    projectId: input.projectId,
    subjectType: 'TASK',
    subjectId: input.taskId,
    subjectVersion: completionEvidenceVersion(input, input.movedFromProjectId ? input.projectId : null),
    detail: {
      evidenceRevision: input.revision,
      criterionRevision: input.criterionRevision,
      evidenceDigest: input.evidenceDigest,
      ...(input.movedFromProjectId ? { movedFromProjectId: input.movedFromProjectId } : {}),
    },
  };
}

/**
 * The key the wake of one evidence revision is claimed under: the key of the fact above, computed
 * without building it — for a READ that looks a revision's delivery back up
 * (`tasks/pending-evidence-judgments.ts`), which is not a producer of the fact and should not be
 * counted as one by the census of producers (`coordinator-disabled-negatives.spec.ts`).
 * `completion-input.spec.ts` holds the two spellings to one key. `movedInto` is the project a moved
 * task's revision was handed over to, as the fact's `projectId` is when `movedFromProjectId` is set.
 */
export function completionEvidenceWakeKey(
  taskId: string,
  input: CompletionEvidenceRevision,
  movedInto?: string,
): string {
  return wakeIdempotencyKey({
    event: COMPLETION_EVIDENCE_EVENT,
    subjectType: 'TASK',
    subjectId: taskId,
    subjectVersion: completionEvidenceVersion(input, movedInto),
  });
}
