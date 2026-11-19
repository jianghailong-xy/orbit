import type { OwnerConfirmationNotReviewedReason } from '@orbit/shared';

import { conversationIsPaused, type CoordinatorConversationState } from './coordinator-evidence-queue';
import { conversationIsOver } from './project-open-item';

/** Committed facts for §16 F1–F4 of owner-confirmation-review-contract.md. */
export interface RunItemFacts {
  kind: 'CONFIRMATION' | 'QUESTION' | 'NOTIFY';
  /** Null outside a project; automatic records the setting when the item was raised. */
  project: { automatic: boolean; coordinatorEnabled: boolean } | null;
  coordinatorSessionId: string | null;
  coordinatorSession: CoordinatorConversationState | null;
  answered: boolean;
  delivery: 'PENDING' | 'DELIVERED' | 'REFUSED';
  deliveryRefusal: string | null;
  deliveredTurn: { status: string; deliveredAt: Date | null } | null;
  /** Read and stopped without a wake source, or the equivalent session_request outcome. */
  stoppedWithoutAnswer: boolean;
  /** Frozen at creation: createdAt + exceptionEscalationSeconds, never delivery time. */
  dueAt: Date;
}

export type RunItemHold =
  | { place: 'ANSWERED' }
  | { place: 'HELD'; coordinatorSessionId: string; dueAt: Date }
  | { place: 'FALLBACK'; reason: OwnerConfirmationNotReviewedReason };

/** Null means the item is outside Automatic routing (§18), rather than a fallback. */
export function runItemHold(facts: RunItemFacts, readAt: Date): RunItemHold | null {
  if (!facts.project?.automatic) return null;
  if (facts.answered) return { place: 'ANSWERED' };
  const fallback = (reason: OwnerConfirmationNotReviewedReason): RunItemHold => ({ place: 'FALLBACK', reason });
  if (facts.kind !== 'NOTIFY' && !facts.project.coordinatorEnabled) return fallback('AUTOMATIC_OFF');
  if (!facts.coordinatorSessionId) return fallback('NO_COORDINATOR');
  if (!facts.coordinatorSession || conversationIsOver(facts.coordinatorSession)) return fallback('REVIEWER_ENDED');
  if (facts.delivery === 'REFUSED') {
    const code = facts.deliveryRefusal;
    return fallback(code === 'NO_COORDINATOR' || code === 'REVIEWER_ENDED' || code === 'AUTOMATIC_OFF'
      || code === 'COORDINATOR_PAUSED' ? code : 'UNREACHABLE');
  }
  if (facts.stoppedWithoutAnswer) return fallback('REVIEWER_STOPPED');
  const paused = conversationIsPaused(facts.coordinatorSession);
  if (facts.kind !== 'CONFIRMATION' && paused) return fallback('REVIEWER_ENDED');
  if (facts.delivery === 'DELIVERED'
    && (!facts.deliveredTurn || (facts.deliveredTurn.status === 'ANSWERED' && !facts.deliveredTurn.deliveredAt))
    && !(facts.kind === 'CONFIRMATION' && paused)) return fallback('REVIEWER_STOPPED');
  if (readAt.getTime() >= facts.dueAt.getTime()) return fallback('TIMED_OUT');
  return { place: 'HELD', coordinatorSessionId: facts.coordinatorSessionId, dueAt: facts.dueAt };
}

/** F5: clients supply the displayed duration (for example, "2 hours"). */
export function runItemFallbackCopy(reason: OwnerConfirmationNotReviewedReason, window: string): {
  label: string; detail: string;
} {
  const details: Record<OwnerConfirmationNotReviewedReason, string> = {
    TIMED_OUT: `No answer within ${window}.`,
    REVIEWER_ENDED: 'The coordinator’s session ended before it answered.',
    REVIEWER_STOPPED: 'The coordinator stopped without answering.',
    COORDINATOR_PAUSED: 'This project’s coordinator is paused.',
    AUTOMATIC_OFF: 'Automatic was switched off for this project.',
    NO_COORDINATOR: 'This project has no coordinator conversation.',
    UNREACHABLE: 'The coordinator could not be reached.',
  };
  return { label: 'Not reviewed by the coordinator', detail: details[reason] };
}
