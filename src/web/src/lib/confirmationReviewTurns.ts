import type {
  ConfirmationAnswersCard,
  ConfirmationReturnCard,
  ConfirmationReviewItem,
  ConfirmationReviewRequestCard,
} from '@orbit/shared';

/**
 * The three readings the control plane records beside a confirmation review's turns
 * (docs/owner-confirmation-review-contract.md §2 D7, §8 B3, §7 Q5): `confirmationReviewRequest` on
 * the turn that asks a reviewer to review a run's report, `confirmationReturn` on the turn that hands
 * the reviewer's return to the run, and `confirmationAnswers` on the turn that hands the owner's
 * answers to the reviewer. Both turns are Orbit's — their words are a block written for the
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
    || (card.dueAt !== null && typeof card.dueAt !== 'string')
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

/** The owner's answers handed to the reviewer (§7 Q5): `confirmationAnswers` on its turn. */
export function parseConfirmationAnswers(payload: unknown): ConfirmationAnswersCard | null {
  const raw = (payload as { confirmationAnswers?: unknown } | null)?.confirmationAnswers;
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  if (
    typeof card.taskId !== 'string' || card.taskId === ''
    || typeof card.title !== 'string'
    || typeof card.decidedAt !== 'string'
    || !Array.isArray(card.answers)
  ) {
    return null;
  }
  return {
    decisionId: typeof card.decisionId === 'string' ? card.decisionId : '',
    taskId: card.taskId,
    title: card.title,
    decidedAt: card.decidedAt,
    answers: card.answers.flatMap(answerOf),
  };
}

function answerOf(value: unknown): ConfirmationAnswersCard['answers'] {
  if (!value || typeof value !== 'object') return [];
  const answer = value as Record<string, unknown>;
  if (typeof answer.question !== 'string') return [];
  const choice = typeof answer.choice === 'string' ? answer.choice : null;
  const text = typeof answer.text === 'string' ? answer.text : null;
  if (choice === null && text === null) return [];
  return [{
    key: typeof answer.key === 'string' ? answer.key : '',
    question: answer.question,
    choice,
    text: choice === null ? text : null,
    notShown: answer.notShown === true,
  }];
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
