import type {
  ConfirmationReturnCard,
  ConfirmationReviewItem,
  ConfirmationReviewRequestCard,
} from '@orbit/shared';

/**
 * The two readings the control plane records beside a confirmation review's turns
 * (docs/owner-confirmation-review-contract.md §2 D7, §8 B3): `confirmationReviewRequest` on the turn
 * that asks a reviewer to review a run's report, and `confirmationReturn` on the turn that hands the
 * reviewer's return to the run. Both turns are Orbit's — their words are a block written for the
 * agent — so a client draws the card these describe rather than a bubble in the reader's name.
 *
 * Read the way `parseProjectStarted` reads its card: the shape is checked, and a payload that is not
 * one parses as NOTHING rather than as half a card.
 */
export function parseConfirmationReviewRequest(payload: unknown): ConfirmationReviewRequestCard | null {
  const raw = (payload as { confirmationReviewRequest?: unknown } | null)?.confirmationReviewRequest;
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  if (
    typeof card.requestId !== 'string'
    || typeof card.taskId !== 'string' || card.taskId === ''
    || typeof card.title !== 'string'
    || typeof card.runSessionId !== 'string'
    || typeof card.dueAt !== 'string'
  ) {
    return null;
  }
  return {
    requestId: card.requestId,
    reviewId: typeof card.reviewId === 'string' ? card.reviewId : '',
    taskId: card.taskId,
    title: card.title,
    runSessionId: card.runSessionId,
    branch: typeof card.branch === 'string' ? card.branch : null,
    sha: typeof card.sha === 'string' ? card.sha : null,
    dueAt: card.dueAt,
  };
}

export function parseConfirmationReturn(payload: unknown): ConfirmationReturnCard | null {
  const raw = (payload as { confirmationReturn?: unknown } | null)?.confirmationReturn;
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  if (typeof card.requestId !== 'string' || typeof card.reason !== 'string') return null;
  return {
    requestId: card.requestId,
    recordId: typeof card.recordId === 'string' ? card.recordId : '',
    reviewerSessionId: typeof card.reviewerSessionId === 'string' ? card.reviewerSessionId : null,
    reviewerTitle: typeof card.reviewerTitle === 'string' ? card.reviewerTitle : null,
    reason: card.reason,
    problems: Array.isArray(card.problems) ? card.problems.flatMap(itemOf) : [],
  };
}

function itemOf(value: unknown): ConfirmationReviewItem[] {
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  if (typeof item.text !== 'string') return [];
  return [{
    key: typeof item.key === 'string' ? item.key : '',
    text: item.text,
    ...(Array.isArray(item.evidenceRefs)
      ? { evidenceRefs: item.evidenceRefs.filter((ref): ref is string => typeof ref === 'string') }
      : {}),
  }];
}
