import { CreatorType, Prisma } from '@prisma/client';
import {
  uuidToBase62,
  type ConfirmationReturnCard,
  type ConfirmationReviewItem,
  type ConfirmationReviewRequestCard,
  type OwnerConfirmationAnswer,
  type ConfirmationNeedsYouItem,
} from '@orbit/shared';
import { derivedUuid } from '../projects/project-dispatch-identity';
import { attribute } from '../sessions/session-message';
import {
  CONFIRMATION_RETURN_TURN_KEY_PREFIX,
  OWNER_CONFIRMATION_ANSWERS_TURN_KEY_PREFIX,
  OWNER_CONFIRMATION_REVIEW_TURN_KEY_PREFIX,
} from '../sessions/watch-turn-key';
import { latestOwnerConfirmationRequest, ownerConfirmationReport } from './owner-confirmation-read';

/**
 * The turns a confirmation request's review travels on (docs/owner-confirmation-review-contract.md
 * §2, §7 Q5, §8 B3), and what each says.
 *
 * Two of them carry nobody's words, like a background job's wake (runner-api/background-job-wake.ts)
 * and a request's reply (sessions/session-request.ts): their content is empty, and what they say is
 * rendered from the rows at the moment the turn is handed out, so all of it is recorded as the
 * control plane's note and none of it is re-sent or previewed as somebody's message —
 *
 *   `owner-confirmation-review:v1:<reviewId>` hands the request to its reviewer (D2, D6);
 *   `confirmation-return:v1:<recordId>`       hands the reviewer's return to the run (B3).
 *
 * The third, `owner-confirmation-answers:v1:<decisionId>`, tells the reviewer what the owner answered
 * (Q5). Its content is rendered once from two immutable rows, so a replay compares equal.
 *
 * Every key is derived from the row it carries, which is what makes each delivery happen once. A
 * failed review turn is re-sent as itself (auto-retry.service.ts), under the same prefix and review
 * with a `:retry:` suffix, so its block is rendered again rather than an older message being re-sent.
 */

const UUID_AT_START = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::|$)/i;

/** How much of the criteria and of the run's report the reviewer is quoted (D6). */
const QUOTE_CHARS = 2_000;

export function ownerConfirmationReviewTurnId(reviewId: string): string {
  return `${OWNER_CONFIRMATION_REVIEW_TURN_KEY_PREFIX}${reviewId}`;
}

/** The review a review turn carries — its own, or the one a re-send of it carries again. */
export function reviewIdOfTurn(clientTurnId: string | null | undefined): string | null {
  if (!clientTurnId?.startsWith(OWNER_CONFIRMATION_REVIEW_TURN_KEY_PREFIX)) return null;
  return UUID_AT_START.exec(clientTurnId.slice(OWNER_CONFIRMATION_REVIEW_TURN_KEY_PREFIX.length))?.[1] ?? null;
}

export function isOwnerConfirmationReviewTurn(clientTurnId: string | null | undefined): boolean {
  return reviewIdOfTurn(clientTurnId) !== null;
}

/**
 * The key a failed review or return turn is re-sent under (auto-retry.service.ts): the same row, a
 * new turn, so its block is rendered again — never the message the session answered before it.
 * Null for any other turn.
 */
export function confirmationReviewRetryTurnId(clientTurnId: string | null | undefined, nonce: string): string | null {
  const reviewId = reviewIdOfTurn(clientTurnId);
  if (reviewId) return `${ownerConfirmationReviewTurnId(reviewId)}:retry:${nonce}`;
  const recordId = returnRecordIdOfTurn(clientTurnId);
  if (recordId) return `${confirmationReturnTurnId(recordId)}:retry:${nonce}`;
  return null;
}

export function confirmationReturnTurnId(recordId: string): string {
  return `${CONFIRMATION_RETURN_TURN_KEY_PREFIX}${recordId}`;
}

export function returnRecordIdOfTurn(clientTurnId: string | null | undefined): string | null {
  if (!clientTurnId?.startsWith(CONFIRMATION_RETURN_TURN_KEY_PREFIX)) return null;
  return UUID_AT_START.exec(clientTurnId.slice(CONFIRMATION_RETURN_TURN_KEY_PREFIX.length))?.[1] ?? null;
}

export function isConfirmationReturnTurn(clientTurnId: string | null | undefined): boolean {
  return returnRecordIdOfTurn(clientTurnId) !== null;
}

export function ownerConfirmationAnswersTurnId(decisionId: string): string {
  return `${OWNER_CONFIRMATION_ANSWERS_TURN_KEY_PREFIX}${decisionId}`;
}

/** The two turns whose words are rendered at delivery rather than stored (see the header). */
export function isConfirmationReviewContentTurn(clientTurnId: string | null | undefined): boolean {
  return isOwnerConfirmationReviewTurn(clientTurnId) || isConfirmationReturnTurn(clientTurnId);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isoSeconds(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

type Db = Prisma.TransactionClient;

/** Everything a review block and card are rendered from, read at once. */
async function readReviewForTurn(db: Db, reviewId: string) {
  return db.taskOwnerConfirmationReview.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      taskId: true,
      dueAt: true,
      records: { select: { kind: true } },
      task: { select: { title: true, acceptanceCriteria: true } },
      request: {
        select: {
          id: true,
          sessionId: true,
          turnId: true,
          branchSha: true,
          claim: { select: { turnId: true } },
          decisions: { select: { decision: true, decidedAt: true }, take: 1 },
        },
      },
    },
  });
}

/**
 * D6: the block a review turn is handed to its reviewer with, rendered from the rows as they stand
 * when it is handed out — so a request that moved on while the turn waited says so instead of
 * asking for a review nobody needs. Null when the review row is gone (its task was deleted).
 */
export async function ownerConfirmationReviewBlock(db: Db, reviewId: string): Promise<string | null> {
  const review = await readReviewForTurn(db, reviewId);
  if (!review) return null;
  const request = review.request;
  const run = await db.session.findUnique({
    where: { id: request.sessionId },
    select: { branch: true, worktreeDirty: true },
  });
  const branch = run?.branch ?? null;
  const attributes = [
    `task="${uuidToBase62(review.taskId)}"`,
    `request-id="${request.id}"`,
    `run-session="${uuidToBase62(request.sessionId)}"`,
    `branch="${attribute(branch ?? '')}"`,
    `sha="${request.branchSha ?? ''}"`,
    `due-at="${isoSeconds(review.dueAt)}"`,
  ];
  const open = `<orbit-confirmation-review ${attributes.join(' ')}>`;
  const close = '</orbit-confirmation-review>';
  const title = review.task.title;

  const latest = await latestOwnerConfirmationRequest(db, review.taskId);
  if (latest && latest.id !== request.id) {
    return [
      open,
      `A run of the task “${title}” has reported again since this request was made, so the owner is asked about that report instead.`,
      'Nothing to review; end your turn.',
      close,
    ].join('\n');
  }
  if (review.records.some((record) => record.kind === 'RETURN')) {
    return [
      open,
      `This request about the task “${title}” has already been returned to its run, which will declare the work finished again.`,
      'Nothing to review; end your turn.',
      close,
    ].join('\n');
  }

  const [decided] = request.decisions;
  const situation = decided?.decision === 'CONFIRM'
    ? [
      `A run of the task “${title}” declared its work finished. The owner confirmed this at ${isoSeconds(decided.decidedAt)}.`,
      'A review now is shown under their receipt; if you find a problem, task_confirmation_return tells the owner, who can reopen the task.',
    ]
    : decided?.decision === 'SEND_BACK'
      ? [
        `A run of the task “${title}” declared its work finished.`,
        `The owner sent this back to the run at ${isoSeconds(decided.decidedAt)}, so nobody is waiting on a review. You may still record one (it is shown under their receipt); otherwise end your turn.`,
      ]
      : [
        `A run of the task “${title}” declared its work finished and is waiting for the account owner to`,
        'confirm it (OWNER_CONFIRMED). You are its reviewer. Until due-at the owner is not asked; after that,',
        'or as soon as you record a review, the owner\'s card asks them.',
      ];
  const report = await ownerConfirmationReport(db, request);
  const where = branch
    ? `${branch}${request.branchSha ? ` at ${request.branchSha}` : ''}`
    : 'the run\'s checkout (it reported no branch)';
  const lines = [
    open,
    ...situation,
    '',
    `What settles it (the task's acceptance criteria, first ${QUOTE_CHARS} characters): ${clip(review.task.acceptanceCriteria?.trim() || '(none stated)', QUOTE_CHARS)}`,
    `What the run reported (the report the owner's card shows, first ${QUOTE_CHARS} characters): ${clip(report?.text ?? '(nothing)', QUOTE_CHARS)}`,
    '',
    `Check the work on ${where}. Then do exactly one of:`,
    '- task_confirmation_review: record what you checked, what you could not check and why, what only',
    '  the owner can decide (each with options and the one you recommend), and what is left open, each',
    '  line with the evidence it rests on. Orbit writes the card\'s first line from these lists; your',
    '  one-sentence judgment is shown last, quoted.',
    '- task_confirmation_return: send it back to the run with the reason, when something must change',
    '  before the owner looks. The reason becomes the run\'s next message; the owner is not asked.',
    'You cannot confirm or send back for the owner. If you end your turn without doing either and nothing',
    'is going to wake you, Orbit treats the request as not reviewed and asks the owner.',
  ];
  if (run?.worktreeDirty === true && branch) {
    lines.push(`The run has uncommitted changes that are not on ${branch}; list what you could not see under notChecked.`);
  }
  lines.push(
    `If you cannot read ${branch ?? 'the run\'s branch'} from where you are (another runner or another clone), say so under notChecked rather than guessing.`,
    close,
  );
  return lines.join('\n');
}

/**
 * Write a review turn's block into what it is handed (D6). Called at delivery for every message
 * turn, outside the first-delivery branch, like the wake and the replies: a review turn handed out
 * again after its runner died still has to say what it is for. Not best-effort: this block IS the
 * turn, so a failure rolls the claim back and leaves the turn queued.
 */
export async function appendOwnerConfirmationReviewContext(
  db: Db,
  clientTurnId: string,
  content: string | null | undefined,
): Promise<string | null | undefined> {
  const reviewId = reviewIdOfTurn(clientTurnId);
  if (!reviewId) return content;
  const block = await ownerConfirmationReviewBlock(db, reviewId);
  if (!block) return content;
  return content ? `${content}\n\n${block}` : block;
}

/** D7: the "Review requested" card a review turn's echo and its queued row carry. */
export async function readConfirmationReviewRequestCard(
  db: Db,
  clientTurnId: string | null | undefined,
): Promise<ConfirmationReviewRequestCard | null> {
  const reviewId = reviewIdOfTurn(clientTurnId);
  if (!reviewId) return null;
  const review = await readReviewForTurn(db, reviewId);
  if (!review) return null;
  const run = await db.session.findUnique({
    where: { id: review.request.sessionId },
    select: { branch: true },
  });
  return {
    requestId: review.request.id,
    reviewId: review.id,
    taskId: review.taskId,
    title: review.task.title,
    runSessionId: review.request.sessionId,
    branch: run?.branch ?? null,
    sha: review.request.branchSha,
    dueAt: review.dueAt.toISOString(),
  };
}

/** The return a `confirmation-return:` turn carries, with who reviewed it — the block's and the card's one read. */
async function readReturnForTurn(db: Db, recordId: string) {
  const record = await db.taskOwnerConfirmationReviewRecord.findUnique({
    where: { id: recordId },
    select: {
      id: true,
      kind: true,
      taskId: true,
      requestId: true,
      reason: true,
      body: true,
      review: { select: { reviewerSessionId: true } },
    },
  });
  if (!record || record.kind !== 'RETURN') return null;
  const reviewerSessionId = record.review.reviewerSessionId;
  const reviewer = reviewerSessionId
    ? await db.session.findUnique({ where: { id: reviewerSessionId }, select: { title: true } })
    : null;
  return {
    ...record,
    reviewerSessionId,
    reviewerTitle: reviewer?.title ?? null,
    problems: ((record.body ?? {}) as { problems?: ConfirmationReviewItem[] }).problems ?? [],
  };
}

/**
 * B3: the block the run is handed its reviewer's return with. Who the reviewer is comes from the
 * review row — the session the request was put to (S1) — and not from anything the caller sent, so
 * the signature is the platform's.
 */
export async function appendConfirmationReturnContext(
  db: Db,
  clientTurnId: string,
  content: string | null | undefined,
): Promise<string | null | undefined> {
  const recordId = returnRecordIdOfTurn(clientTurnId);
  if (!recordId) return content;
  const returned = await readReturnForTurn(db, recordId);
  if (!returned) return content;
  const attributes = [
    `task="${uuidToBase62(returned.taskId)}"`,
    `request-id="${returned.requestId}"`,
    `reviewer-session="${returned.reviewerSessionId ? uuidToBase62(returned.reviewerSessionId) : ''}"`,
    `reviewer-title="${attribute(returned.reviewerTitle ?? '')}"`,
  ];
  const block = [
    `<orbit-confirmation-return ${attributes.join(' ')}>`,
    'Your report for this task was sent back by its reviewer, not by the account owner. The owner was not asked.',
    `Reason: ${returned.reason ?? ''}`,
    'Problems:',
    ...returned.problems.map((problem) => `- ${problem.text}${problem.evidenceRefs?.length ? ` (${problem.evidenceRefs.join('; ')})` : ''}`),
    'When this is fixed, declare the work finished again with task_request_confirmation.',
    '</orbit-confirmation-return>',
  ].join('\n');
  return content ? `${content}\n\n${block}` : block;
}

/** B3: the "Sent back by the reviewer" card a return turn's echo and its queued row carry. */
export async function readConfirmationReturnCard(
  db: Db,
  clientTurnId: string | null | undefined,
): Promise<ConfirmationReturnCard | null> {
  const recordId = returnRecordIdOfTurn(clientTurnId);
  if (!recordId) return null;
  const returned = await readReturnForTurn(db, recordId);
  if (!returned) return null;
  return {
    requestId: returned.requestId,
    recordId: returned.id,
    reviewerSessionId: returned.reviewerSessionId,
    reviewerTitle: returned.reviewerTitle,
    reason: returned.reason ?? '',
    problems: returned.problems,
  };
}

/** What the queued row of either content turn shows before it is handed out: the block itself. */
export async function queuedConfirmationReviewContent(db: Db, clientTurnId: string): Promise<string> {
  if (isOwnerConfirmationReviewTurn(clientTurnId)) {
    return (await appendOwnerConfirmationReviewContext(db, clientTurnId, '')) ?? '';
  }
  if (isConfirmationReturnTurn(clientTurnId)) {
    return (await appendConfirmationReturnContext(db, clientTurnId, '')) ?? '';
  }
  return '';
}

/** How one answer reads to the reviewer and on the task (Q5): the option's label, or the owner's words. */
export function answerInWords(answer: OwnerConfirmationAnswer, question: ConfirmationNeedsYouItem | undefined): string {
  if (answer.option !== null) {
    const label = question?.options[answer.option]?.label ?? `option ${answer.option}`;
    return `${answer.option}. ${label}`;
  }
  return `“${answer.text ?? ''}”`;
}

/**
 * Q5 2: the message that tells the reviewer what the owner answered, rendered from the record and
 * the decision — two rows that never change, so a replay of the turn compares equal.
 */
export function ownerAnswersMessage(input: {
  taskId: string;
  title: string;
  decidedAt: Date;
  answers: readonly OwnerConfirmationAnswer[];
  needsYou: readonly ConfirmationNeedsYouItem[];
}): string {
  const questions = new Map(input.needsYou.map((item) => [item.key, item]));
  const lines = input.answers.map((answer) => {
    const question = questions.get(answer.key);
    const shown = answer.source === 'NOT_SHOWN'
      ? ' (the owner\'s app did not show this question; your recommended option was recorded)'
      : '';
    return `- ${question?.text ?? answer.key} → ${answerInWords(answer, question)}${shown}`;
  });
  return [
    `<orbit-confirmation-answers task="${uuidToBase62(input.taskId)}">`,
    `The task “${input.title}” you reviewed: the owner confirmed it at ${isoSeconds(input.decidedAt)}.`,
    'Their answers to your questions:',
    ...lines,
    '</orbit-confirmation-answers>',
  ].join('\n');
}

/** Q5 1: the comment an owner's answers are recorded as on the task, keyed by the decision. */
export function ownerAnswersCommentId(decisionId: string): string {
  return derivedUuid(`owner-confirmation-answers:v1:comment:${decisionId}`);
}

/**
 * Q5 1: the owner's answers, written on the task in the transaction that records the decision — so
 * any agent that reads the task later (`task_get` carries its comments) reads them, which is the link
 * that was missing when a card with seven questions was confirmed in one press (2026-09-29). Keyed
 * by the decision and written with `skipDuplicates`, and attributed the way every comment Orbit
 * writes on a task is (`postRunFailureComment`); the words say it is Orbit's record.
 */
export async function writeOwnerAnswersComment(
  tx: Prisma.TransactionClient,
  input: {
    decisionId: string;
    taskId: string;
    answers: readonly OwnerConfirmationAnswer[];
    needsYou: readonly ConfirmationNeedsYouItem[];
  },
): Promise<void> {
  if (input.answers.length === 0) return;
  const task = await tx.task.findUnique({
    where: { id: input.taskId },
    select: { assigneeId: true, creatorType: true, creatorId: true },
  });
  if (!task) return;
  const questions = new Map(input.needsYou.map((item) => [item.key, item]));
  const lines = input.answers.map((answer) => {
    const question = questions.get(answer.key);
    const notShown = answer.source === 'NOT_SHOWN'
      ? '（owner 的 app 没有显示这个问题，记下的是审查方推荐的选项）'
      : '';
    return `- ${question?.text ?? answer.key} — ${answerInWords(answer, question)}${notShown}`;
  });
  await tx.taskComment.createMany({
    data: [{
      id: ownerAnswersCommentId(input.decisionId),
      taskId: input.taskId,
      authorType: task.assigneeId ? CreatorType.AGENT : task.creatorType,
      authorId: task.assigneeId ?? task.creatorId,
      body: [
        '**owner 对审查问题的回答（系统自动记录）**',
        '',
        'owner 确认本任务完成时，对审查方提出的「要你判断」的问题作了如下回答：',
        '',
        ...lines,
      ].join('\n'),
    }],
    skipDuplicates: true,
  });
}
