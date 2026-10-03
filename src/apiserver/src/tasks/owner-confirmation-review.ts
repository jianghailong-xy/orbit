import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ConfirmationNeedsYouItem,
  ConfirmationReturnRecordView,
  ConfirmationReviewHeadline,
  ConfirmationReviewItem,
  ConfirmationReviewLists,
  OwnerConfirmationAnswer,
  OwnerConfirmationNotReviewedReason,
  OwnerConfirmationReviewState,
  OwnerConfirmationReviewView,
} from '@orbit/shared';
import { hasPendingWakeSource } from '../sessions/session-request';
import { STALE_ACTION } from './task-owner-confirmation';

/**
 * The review an OWNER_CONFIRMED confirmation request gets before its owner is asked
 * (docs/owner-confirmation-review-contract.md). The rows, and every rule read off them, with a
 * transaction client and nothing else — the same reason `owner-confirmation-read.ts` gives: the
 * runner's completion records the review, the session list and the task list count it, the card
 * draws it, and the two reviewer tools and the owner's door decide by it, and none of them may hold
 * a second opinion about what state a review is in.
 *
 * WHO REVIEWS (§1). Decided once, in the transaction that records the request, and written on the
 * review row: the project's coordinator conversation for a task in an Automatic project, the
 * conversation the task was filed from outside a project, and nobody when the task was filed from
 * no conversation at all (the owner's own, in the app) or its project is not Automatic. A request
 * with no review row has no review bar, exactly as every request recorded before 0370.
 *
 * WHAT STATE IT IS IN (§4). Read, never stored and never swept: `confirmationReviewStates` is the
 * one definition, asked by the card, the counts, the session rows and the doors alike — the way
 * `pending-evidence-judgments.ts#coordinatorHolds` is asked by both the queue and its badge. The
 * clock appears once, as `readAt >= due_at`; every other fact it reads only ever moves one way, so a
 * request that left "under review" never comes back to it and out of the owner's count.
 */

/** N4: the window outside a project. Not a setting. */
export const OWNER_CONFIRMATION_REVIEW_WINDOW_SECONDS_OUTSIDE_PROJECTS = 1_800;

/** B5: returns a reviewer may make between two decisions of the owner's, as ILC X-C3's chain cap. */
export const CONFIRMATION_RETURNS_BEFORE_OWNER = 3;

/** §3.1: the closed set a refused delivery is written down with. */
export const REVIEW_DELIVERY_REFUSALS = [
  'NO_COORDINATOR',
  'REVIEWER_ENDED',
  'REVIEWER_IS_THE_RUN',
  'SUPERSEDED',
  'SENT_BACK',
  'AUTOMATIC_OFF',
  'COORDINATOR_PAUSED',
  'SESSION_UNAVAILABLE',
] as const;
export type ReviewDeliveryRefusalCode = (typeof REVIEW_DELIVERY_REFUSALS)[number];

/**
 * D2: a delivery the reviewer's turn hook refused, with the code it is written down under. Thrown
 * inside `createTurn`'s transaction so the turn rolls back with it; a Conflict, so a caller that only
 * knows `createTurn`'s ordinary refusals still reads it as one.
 */
export class ReviewDeliveryRefused extends ConflictException {
  constructor(readonly refusalCode: ReviewDeliveryRefusalCode, message: string) {
    super({ code: `REVIEW_DELIVERY_${refusalCode}`, message });
  }
}

/** The review state a decision row may record (`task_owner_decision_review_state_chk`). */
export type ReviewStateAtDecision = 'NONE' | Exclude<OwnerConfirmationReviewState, 'RETURNED'>;

// ── Who reviews (§1) ──────────────────────────────────────────────────────────────────────────────

export interface ResolvedReviewer {
  kind: 'PROJECT_COORDINATOR' | 'TASK_CREATOR';
  /** Null for an Automatic project with no coordinator conversation (S4: NO_COORDINATOR). */
  sessionId: string | null;
  projectId: string | null;
  windowSeconds: number;
}

/**
 * S2, in its order. A task filed from no conversation has nobody to ask, in a project or not — the
 * user API never writes `creator_session_id`, and `creator_type` is not read, because the runner
 * door files a task created inside a session as USER when its call carries no agent header. A task
 * in a project is its coordinator's to review while the project is Automatic, and the owner's own
 * otherwise; outside a project it is the conversation that filed it.
 */
export async function resolveReviewer(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<ResolvedReviewer | null> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: {
      creatorSessionId: true,
      projectId: true,
      project: {
        select: { coordinatorEnabled: true, coordinatorSessionId: true, exceptionEscalationSeconds: true },
      },
    },
  });
  if (!task?.creatorSessionId) return null;
  if (task.projectId) {
    if (!task.project?.coordinatorEnabled) return null;
    return {
      kind: 'PROJECT_COORDINATOR',
      sessionId: task.project.coordinatorSessionId,
      projectId: task.projectId,
      windowSeconds: task.project.exceptionEscalationSeconds,
    };
  }
  return {
    kind: 'TASK_CREATOR',
    sessionId: task.creatorSessionId,
    projectId: null,
    windowSeconds: OWNER_CONFIRMATION_REVIEW_WINDOW_SECONDS_OUTSIDE_PROJECTS,
  };
}

/**
 * D1: the review row, written in the transaction that records its request, so the first read after
 * that turn already says "under review" and the owner's count never lights for a moment first. The
 * window is frozen here (N4) and counted from the request, not from the delivery. An Automatic
 * project with no coordinator conversation is refused at once (S4); every other row starts PENDING
 * for `OwnerConfirmationReviewService.deliver` to take after the commit.
 *
 * Null when the request has no reviewer (S2), and then nothing is written.
 */
export async function recordOwnerConfirmationReview(
  tx: Prisma.TransactionClient,
  request: { id: string; taskId: string; ownerId: string; requestedAt: Date },
): Promise<{ reviewId: string; delivery: 'PENDING' | 'REFUSED' } | null> {
  const reviewer = await resolveReviewer(tx, request.taskId);
  if (!reviewer) return null;
  const refused = reviewer.kind === 'PROJECT_COORDINATOR' && reviewer.sessionId == null;
  const row = await tx.taskOwnerConfirmationReview.create({
    data: {
      requestId: request.id,
      taskId: request.taskId,
      ownerId: request.ownerId,
      reviewerKind: reviewer.kind,
      reviewerSessionId: reviewer.sessionId,
      projectId: reviewer.projectId,
      windowSeconds: reviewer.windowSeconds,
      dueAt: new Date(request.requestedAt.getTime() + reviewer.windowSeconds * 1_000),
      ...(refused ? { delivery: 'REFUSED' as const, deliveryRefusal: 'NO_COORDINATOR' } : {}),
    },
    select: { id: true, delivery: true },
  });
  return { reviewId: row.id, delivery: row.delivery === 'REFUSED' ? 'REFUSED' : 'PENDING' };
}

// ── What state a review is in (§4) ────────────────────────────────────────────────────────────────

/** A request the states are read for: the row's identity and the run it came from. */
export interface ReviewedRequest {
  id: string;
  taskId: string;
  sessionId: string;
  requestedAt: Date;
}

/** The facts T1–T3 are a function of, gathered for one review. */
export interface ReviewStateFacts {
  delivery: 'PENDING' | 'DELIVERED' | 'REFUSED';
  deliveryRefusal: string | null;
  /** False when the review names a reviewer session whose row is gone (§3.1: read as ended). */
  reviewerSessionExists: boolean;
  reviewerEndedAt: Date | null;
  abandonedAt: Date | null;
  /** DELIVERED only: the delivered turn as it stands, or null when no row has its key any more. */
  deliveredTurn: { status: string; deliveredAt: Date | null } | null;
  dueAt: Date;
  hasReturn: boolean;
  /** The REVIEW record's commit, when there is a REVIEW record. */
  review: { reviewedSha: string | null } | null;
  requestIsNewest: boolean;
  /** The run's branch tip now (`session.branch_sha`), or null when it cannot be read. */
  runBranchSha: string | null;
}

export interface ReviewStateReading {
  state: OwnerConfirmationReviewState;
  notReviewedReason: OwnerConfirmationNotReviewedReason | null;
  outdated: { cause: 'NEWER_REPORT' | 'BRANCH_MOVED'; branchSha: string | null } | null;
}

/**
 * T1–T3 over one review's facts, top to bottom, first hit wins. Pure, so the table can be read as
 * code: every NOT_REVIEWED condition is one that no later write undoes, which is what keeps a
 * request out of "under review" for good once it has left it — only a record the reviewer hands in
 * afterwards (rows 1–3) changes it again.
 */
export function reviewStateOf(facts: ReviewStateFacts, readAt: Date): ReviewStateReading {
  if (facts.hasReturn) return { state: 'RETURNED', notReviewedReason: null, outdated: null };
  if (facts.review) {
    if (!facts.requestIsNewest) {
      return { state: 'OUTDATED', notReviewedReason: null, outdated: { cause: 'NEWER_REPORT', branchSha: null } };
    }
    const reviewed = facts.review.reviewedSha;
    if (reviewed && facts.runBranchSha && reviewed !== facts.runBranchSha) {
      return {
        state: 'OUTDATED',
        notReviewedReason: null,
        outdated: { cause: 'BRANCH_MOVED', branchSha: facts.runBranchSha },
      };
    }
    return { state: 'REVIEWED', notReviewedReason: null, outdated: null };
  }
  const reason = notReviewedReasonOf(facts, readAt);
  return reason
    ? { state: 'NOT_REVIEWED', notReviewedReason: reason, outdated: null }
    : { state: 'UNDER_REVIEW', notReviewedReason: null, outdated: null };
}

/** T2: the first of the NOT_REVIEWED conditions that holds, or null while none does. */
function notReviewedReasonOf(
  facts: ReviewStateFacts,
  readAt: Date,
): OwnerConfirmationNotReviewedReason | null {
  if (facts.delivery === 'REFUSED') {
    const code = facts.deliveryRefusal;
    return code === 'NO_COORDINATOR' || code === 'REVIEWER_ENDED' || code === 'AUTOMATIC_OFF'
      || code === 'COORDINATOR_PAUSED'
      ? code
      : 'UNREACHABLE';
  }
  if (facts.reviewerEndedAt != null || !facts.reviewerSessionExists) return 'REVIEWER_ENDED';
  if (facts.abandonedAt != null) return 'REVIEWER_STOPPED';
  // The delivered turn was taken away before an engine read it: an interrupt or a withdrawal deletes
  // it, and a drain answers it without its ever having been handed out.
  if (
    facts.delivery === 'DELIVERED'
    && (facts.deliveredTurn == null
      || (facts.deliveredTurn.status === 'ANSWERED' && facts.deliveredTurn.deliveredAt == null))
  ) {
    return 'REVIEWER_STOPPED';
  }
  if (readAt.getTime() >= facts.dueAt.getTime()) return 'TIMED_OUT';
  return null;
}

/**
 * H2: the line Orbit writes at the top of the review, from the counts of the record shown and from
 * nothing the reviewer chose — its judgment never reaches it. PROBLEMS, when there is such a record,
 * else the REVIEW's needsYou, else how much it did not check.
 */
export function reviewHeadline(
  review: Pick<ConfirmationReviewLists, 'needsYou' | 'notChecked'> | null,
  problems: { problems: readonly unknown[] } | null,
): ConfirmationReviewHeadline | null {
  if (problems) return { kind: 'PROBLEMS_AFTER_CONFIRM', problems: problems.problems.length };
  if (!review) return null;
  const [first] = review.needsYou;
  if (first) return { kind: 'NEEDS_YOU', text: first.text, more: review.needsYou.length - 1 };
  return { kind: 'NOTHING_NEEDS_YOU', notChecked: review.notChecked.length };
}

const REVIEW_SELECT = {
  id: true,
  requestId: true,
  reviewerKind: true,
  reviewerSessionId: true,
  windowSeconds: true,
  dueAt: true,
  delivery: true,
  deliveryRefusal: true,
  deliveryTurnClientId: true,
  abandonedAt: true,
  reviewerEndedAt: true,
  records: {
    select: { id: true, kind: true, reviewedSha: true, judgment: true, reason: true, body: true, recordedAt: true },
  },
} as const;

type StoredRecord = {
  id: string;
  kind: 'REVIEW' | 'RETURN' | 'PROBLEMS';
  reviewedSha: string | null;
  judgment: string | null;
  reason: string | null;
  body: Prisma.JsonValue;
  recordedAt: Date;
};

/**
 * The review of each of these requests, read now — the one definition of a review's state (T6).
 * Requests with no review row are absent from the answer: they draw no review bar.
 *
 * Batch on purpose: the session list asks it for a page of rows and the card for one request and
 * every decision's, so the reads below are one query per kind of fact, whatever the number of
 * requests.
 */
export async function confirmationReviewStates(
  tx: Prisma.TransactionClient,
  requests: readonly ReviewedRequest[],
  readAt: Date,
): Promise<Map<string, OwnerConfirmationReviewView<Date>>> {
  const views = new Map<string, OwnerConfirmationReviewView<Date>>();
  if (requests.length === 0) return views;
  const reviews = await tx.taskOwnerConfirmationReview.findMany({
    where: { requestId: { in: requests.map((request) => request.id) } },
    select: REVIEW_SELECT,
  });
  if (reviews.length === 0) return views;
  const byRequest = new Map(requests.map((request) => [request.id, request]));
  const reviewed = reviews.filter((review) => review.records.some((record) => record.kind === 'REVIEW'));

  // Which request is each task's newest, and where each run's branch is now — read only for a
  // review that has a REVIEW record, the one state either fact can move (T1 row 2).
  const newest = new Map<string, string>();
  const branchOf = new Map<string, string | null>();
  if (reviewed.length > 0) {
    const taskIds = [...new Set(reviewed.map((review) => byRequest.get(review.requestId)!.taskId))];
    const latest = await tx.taskOwnerConfirmationRequest.findMany({
      where: { taskId: { in: taskIds } },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, taskId: true },
    });
    for (const row of latest) if (!newest.has(row.taskId)) newest.set(row.taskId, row.id);
    const runs = await tx.session.findMany({
      where: { id: { in: [...new Set(reviewed.map((review) => byRequest.get(review.requestId)!.sessionId))] } },
      select: { id: true, branchSha: true },
    });
    for (const run of runs) branchOf.set(run.id, run.branchSha);
  }

  const reviewerIds = [...new Set(reviews.flatMap((review) => (review.reviewerSessionId ? [review.reviewerSessionId] : [])))];
  const reviewers = new Map((reviewerIds.length === 0 ? [] : await tx.session.findMany({
    where: { id: { in: reviewerIds } },
    select: { id: true, title: true },
  })).map((session) => [session.id, session.title]));

  const delivered = reviews.filter((review) => review.delivery === 'DELIVERED'
    && review.reviewerSessionId && review.deliveryTurnClientId);
  const turns = new Map((delivered.length === 0 ? [] : await tx.conversationTurn.findMany({
    where: {
      OR: delivered.map((review) => ({
        sessionId: review.reviewerSessionId!,
        clientTurnId: review.deliveryTurnClientId!,
      })),
    },
    select: { sessionId: true, clientTurnId: true, status: true, deliveredAt: true },
  })).map((turn) => [`${turn.sessionId}:${turn.clientTurnId}`, turn]));

  for (const review of reviews) {
    const request = byRequest.get(review.requestId)!;
    const records = review.records as StoredRecord[];
    const reviewRecord = records.find((record) => record.kind === 'REVIEW') ?? null;
    const returnRecord = records.find((record) => record.kind === 'RETURN') ?? null;
    const problemsRecord = records.find((record) => record.kind === 'PROBLEMS') ?? null;
    const lists = reviewRecord ? reviewListsOf(reviewRecord.body) : null;
    const problems = problemsRecord ? returnRecordView(problemsRecord) : null;
    const reading = reviewStateOf({
      delivery: review.delivery,
      deliveryRefusal: review.deliveryRefusal,
      reviewerSessionExists: review.reviewerSessionId == null || reviewers.has(review.reviewerSessionId),
      reviewerEndedAt: review.reviewerEndedAt,
      abandonedAt: review.abandonedAt,
      deliveredTurn: review.delivery === 'DELIVERED' && review.reviewerSessionId && review.deliveryTurnClientId
        ? turns.get(`${review.reviewerSessionId}:${review.deliveryTurnClientId}`) ?? null
        : null,
      dueAt: review.dueAt,
      hasReturn: returnRecord != null,
      review: reviewRecord ? { reviewedSha: reviewRecord.reviewedSha } : null,
      requestIsNewest: (newest.get(request.taskId) ?? request.id) === request.id,
      runBranchSha: branchOf.get(request.sessionId) ?? null,
    }, readAt);
    views.set(request.id, {
      reviewId: review.id,
      ...reading,
      reviewer: {
        kind: review.reviewerKind,
        sessionId: review.reviewerSessionId,
        title: review.reviewerSessionId ? reviewers.get(review.reviewerSessionId) ?? null : null,
      },
      since: request.requestedAt,
      dueAt: review.dueAt,
      windowSeconds: review.windowSeconds,
      headline: reviewHeadline(lists, problems),
      review: reviewRecord && lists
        ? {
          recordId: reviewRecord.id,
          recordedAt: reviewRecord.recordedAt,
          reviewedSha: reviewRecord.reviewedSha,
          judgment: reviewRecord.judgment ?? '',
          ...lists,
        }
        : null,
      returned: returnRecord ? returnRecordView(returnRecord) : null,
      problems,
    });
  }
  return views;
}

function reviewListsOf(body: Prisma.JsonValue): ConfirmationReviewLists {
  const stored = (body ?? {}) as Partial<ConfirmationReviewLists>;
  return {
    checked: stored.checked ?? [],
    notChecked: stored.notChecked ?? [],
    needsYou: stored.needsYou ?? [],
    leftOpen: stored.leftOpen ?? [],
  };
}

function returnRecordView(record: StoredRecord): ConfirmationReturnRecordView<Date> {
  return {
    recordId: record.id,
    recordedAt: record.recordedAt,
    reviewedSha: record.reviewedSha,
    reason: record.reason ?? '',
    problems: ((record.body ?? {}) as { problems?: ConfirmationReviewItem[] }).problems ?? [],
  };
}

/** The state a decision row records (Q4): NONE for a request with no review row. */
export function reviewStateAtDecision(view: OwnerConfirmationReviewView<Date> | undefined): ReviewStateAtDecision {
  if (!view) return 'NONE';
  // A returned request is answered and cannot be decided; the door refuses it before this is read.
  return view.state === 'RETURNED' ? 'NOT_REVIEWED' : view.state;
}

// ── T5: read, stopped, and nothing will wake it ───────────────────────────────────────────────────

/**
 * T5, judged where SRR §4.1 judges NO_REPLY: in the transaction that parks the reviewer's session
 * idle (runnerApi.turnComplete), under its row lock. A review it was handed — the turn carrying it
 * reached an engine — that it has neither recorded nor returned is abandoned now, unless something
 * will still wake the session by itself (`hasPendingWakeSource`). Waiting out the window instead
 * would hold the owner's card for two hours in a project because a model forgot to call the tool.
 *
 * Answers the tasks and runs whose card this moved, for the clients to be told after the commit.
 */
export async function abandonUnansweredReviews(
  tx: Prisma.TransactionClient,
  session: { id: string; runningBgJobs: readonly string[]; retryAt: Date | null },
): Promise<Array<{ taskId: string; runSessionId: string }>> {
  const open = await tx.taskOwnerConfirmationReview.findMany({
    where: {
      reviewerSessionId: session.id,
      delivery: 'DELIVERED',
      abandonedAt: null,
      records: { none: { kind: { in: ['REVIEW', 'RETURN'] } } },
    },
    select: { id: true, taskId: true, deliveryTurnClientId: true, request: { select: { sessionId: true } } },
  });
  if (open.length === 0) return [];
  const received = new Set((await tx.conversationTurn.findMany({
    where: {
      sessionId: session.id,
      clientTurnId: { in: open.flatMap((review) => (review.deliveryTurnClientId ? [review.deliveryTurnClientId] : [])) },
      deliveredAt: { not: null },
    },
    select: { clientTurnId: true },
  })).map((turn) => turn.clientTurnId));
  const due = open.filter((review) => review.deliveryTurnClientId && received.has(review.deliveryTurnClientId));
  if (due.length === 0) return [];
  if (await hasPendingWakeSource(tx, session)) return [];
  await tx.taskOwnerConfirmationReview.updateMany({
    where: { id: { in: due.map((review) => review.id) }, abandonedAt: null },
    data: { abandonedAt: new Date() },
  });
  return due.map((review) => ({ taskId: review.taskId, runSessionId: review.request.sessionId }));
}

// ── What a reviewer may hand in (§3.4, §3.5 row 7, §8 B1) ─────────────────────────────────────────

const SHA_RE = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A reported branch tip in the one spelling the char(40) columns hold, or undefined. */
export function storableBranchSha(value: unknown): string | undefined {
  return typeof value === 'string' && SHA_RE.test(value) ? value : undefined;
}

const LIMITS = {
  judgment: 500,
  text: 300,
  criterionKey: 64,
  note: 500,
  evidenceRefs: 10,
  evidenceRef: 500,
  optionLabel: 200,
  optionDescription: 500,
  reason: 4_000,
  answerText: 2_000,
} as const;
const LIST_LIMITS = { checked: 20, notChecked: 20, needsYou: 10, leftOpen: 20, problems: 10 } as const;
const KEY_PREFIX = { checked: 'c', notChecked: 'x', needsYou: 'n', leftOpen: 'o', problems: 'p' } as const;
type ListName = keyof typeof LIST_LIMITS;

const ITEM_FIELDS: Record<ListName, ReadonlySet<string>> = {
  checked: new Set(['text', 'criterionKey', 'evidenceRefs']),
  notChecked: new Set(['text', 'criterionKey', 'evidenceRefs', 'whyNotProven', 'coordinatorChecked']),
  needsYou: new Set(['text', 'criterionKey', 'evidenceRefs', 'options', 'recommendedOption']),
  leftOpen: new Set(['text', 'criterionKey', 'evidenceRefs']),
  problems: new Set(['text', 'criterionKey', 'evidenceRefs']),
};

/**
 * A 400 for an input that is wrong in itself, saying which field and why. Nothing is written. No
 * code of its own: the contract gives row 7 a status and nothing else (§3.5), as the owner's door
 * answers its own malformed bodies.
 */
function invalid(message: string): never {
  throw new BadRequestException(`${message}; nothing was written.`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid(`${where} has unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`);
}

function boundedText(value: unknown, max: number, where: string, min = 1): string {
  if (typeof value !== 'string') invalid(`${where} must be a string`);
  const text = value.replace(/\r\n?/g, '\n').trim().normalize('NFC');
  if (text.length < min) invalid(`${where} must not be empty`);
  if (text.length > max) invalid(`${where} must contain at most ${max} characters`);
  return text;
}

function optionalText(value: unknown, max: number, where: string): string | undefined {
  return value === undefined ? undefined : boundedText(value, max, where);
}

function readItem(name: ListName, raw: unknown, index: number): ConfirmationReviewItem | ConfirmationNeedsYouItem {
  const where = `${name}[${index}]`;
  if (!isObject(raw)) invalid(`${where} must be an object`);
  onlyKnownKeys(raw, ITEM_FIELDS[name], where);
  const item: ConfirmationReviewItem = {
    key: `${KEY_PREFIX[name]}${index + 1}`,
    text: boundedText(raw.text, LIMITS.text, `${where}.text`),
  };
  const criterionKey = optionalText(raw.criterionKey, LIMITS.criterionKey, `${where}.criterionKey`);
  if (criterionKey !== undefined) item.criterionKey = criterionKey;
  const whyNotProven = optionalText(raw.whyNotProven, LIMITS.note, `${where}.whyNotProven`);
  if (whyNotProven !== undefined) item.whyNotProven = whyNotProven;
  const coordinatorChecked = optionalText(raw.coordinatorChecked, LIMITS.note, `${where}.coordinatorChecked`);
  if (coordinatorChecked !== undefined) item.coordinatorChecked = coordinatorChecked;
  if (raw.evidenceRefs !== undefined) {
    if (!Array.isArray(raw.evidenceRefs)) invalid(`${where}.evidenceRefs must be an array of strings`);
    if (raw.evidenceRefs.length > LIMITS.evidenceRefs) {
      invalid(`${where}.evidenceRefs holds at most ${LIMITS.evidenceRefs} references`);
    }
    item.evidenceRefs = raw.evidenceRefs.map((ref, i) => boundedText(ref, LIMITS.evidenceRef, `${where}.evidenceRefs[${i}]`));
  }
  if (name !== 'needsYou') return item;
  if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 4) {
    invalid(`${where}.options must hold 2 to 4 options: a needsYou line is a choice the owner answers in one tap`);
  }
  const options = raw.options.map((option, i) => {
    const at = `${where}.options[${i}]`;
    if (!isObject(option)) invalid(`${at} must be an object`);
    onlyKnownKeys(option, new Set(['label', 'description']), at);
    const label = boundedText(option.label, LIMITS.optionLabel, `${at}.label`);
    const description = optionalText(option.description, LIMITS.optionDescription, `${at}.description`);
    return description === undefined ? { label } : { label, description };
  });
  const recommended = raw.recommendedOption;
  if (typeof recommended !== 'number' || !Number.isInteger(recommended) || recommended < 0 || recommended >= options.length) {
    invalid(`${where}.recommendedOption must be the index of one of its options (0 to ${options.length - 1})`);
  }
  return { ...item, options, recommendedOption: recommended };
}

function readList(name: ListName, raw: unknown): ConfirmationReviewItem[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) invalid(`${name} must be an array`);
  if (raw.length > LIST_LIMITS[name]) invalid(`${name} holds at most ${LIST_LIMITS[name]} lines`);
  return raw.map((item, index) => readItem(name, item, index));
}

function readRequestId(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    invalid('requestId must be the confirmation request\'s id, the UUID the review block names as request-id');
  }
  return raw.toLowerCase();
}

/**
 * §3.5 row 7 for `reviewedSha`: required, 40 lowercase hex, when the request has a branch tip;
 * not given when it has none. It is not compared with the request's or the branch's commit here —
 * a review of another commit is accepted and reads as OUTDATED (§4).
 */
export function readReviewedSha(raw: unknown, requestBranchSha: string | null): string | null {
  const given = raw !== undefined && raw !== null;
  if (requestBranchSha == null) {
    if (given) invalid('reviewedSha must not be given: the run reported no commit for this request');
    return null;
  }
  if (!given) invalid(`reviewedSha is required: say which commit you reviewed (the request is at ${requestBranchSha})`);
  if (typeof raw !== 'string' || !SHA_RE.test(raw)) invalid('reviewedSha must be a full commit id: 40 lowercase hex characters');
  return raw;
}

/** The parts of the input the door reads before the request row (§3.5 rows 2–6). */
export function readReviewRequestId(raw: unknown): string {
  if (!isObject(raw)) invalid('the input must be one JSON object');
  return readRequestId(raw.requestId);
}

export interface ReadConfirmationReview {
  requestId: string;
  reviewedSha: string | null;
  judgment: string;
  lists: ConfirmationReviewLists;
}

/** task_confirmation_review's input (§3.4, §3.5 row 7), with its items keyed. Unknown keys are 400. */
export function readConfirmationReviewInput(raw: unknown, requestBranchSha: string | null): ReadConfirmationReview {
  if (!isObject(raw)) invalid('the input must be one JSON object');
  onlyKnownKeys(raw, new Set(['requestId', 'reviewedSha', 'judgment', 'checked', 'notChecked', 'needsYou', 'leftOpen']), 'the input');
  return {
    requestId: readRequestId(raw.requestId),
    reviewedSha: readReviewedSha(raw.reviewedSha, requestBranchSha),
    judgment: boundedText(raw.judgment, LIMITS.judgment, 'judgment'),
    lists: {
      checked: readList('checked', raw.checked),
      notChecked: readList('notChecked', raw.notChecked),
      needsYou: readList('needsYou', raw.needsYou) as ConfirmationNeedsYouItem[],
      leftOpen: readList('leftOpen', raw.leftOpen),
    },
  };
}

export interface ReadConfirmationReturn {
  requestId: string;
  reviewedSha: string | null;
  reason: string;
  problems: ConfirmationReviewItem[];
}

/** task_confirmation_return's input (§8 B1), with its problems keyed. Unknown keys are 400. */
export function readConfirmationReturnInput(raw: unknown, requestBranchSha: string | null): ReadConfirmationReturn {
  if (!isObject(raw)) invalid('the input must be one JSON object');
  onlyKnownKeys(raw, new Set(['requestId', 'reviewedSha', 'reason', 'problems']), 'the input');
  const problems = readList('problems', raw.problems);
  if (problems.length === 0) invalid('problems must hold 1 to 10 lines: say what is wrong, each with its evidence');
  return {
    requestId: readRequestId(raw.requestId),
    reviewedSha: readReviewedSha(raw.reviewedSha, requestBranchSha),
    reason: boundedText(raw.reason, LIMITS.reason, 'reason'),
    problems,
  };
}

// ── The owner's answers (§7 Q3–Q4) ────────────────────────────────────────────────────────────────

/** A 400 for answers that are wrong in themselves (Q3: "400 only means the answers are malformed"). */
function invalidAnswers(message: string): never {
  throw new BadRequestException(`${message}; nothing was written.`);
}

/**
 * The answers a confirmation carries, checked against the questions they answer: each names an
 * existing needsYou key once, and gives exactly one of an option index or the owner's own words.
 * Missing keys are not this function's to refuse — that is the door's 409 (`missingAnswerKeys`).
 */
export function readOwnerAnswers(
  raw: unknown,
  needsYou: readonly ConfirmationNeedsYouItem[],
): OwnerConfirmationAnswer[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) invalidAnswers('answers must be an array');
  const questions = new Map(needsYou.map((item) => [item.key, item]));
  const seen = new Set<string>();
  return raw.map((answer, index) => {
    const where = `answers[${index}]`;
    if (!isObject(answer)) invalidAnswers(`${where} must be an object`);
    const unknown = Object.keys(answer).filter((key) => !['key', 'option', 'text'].includes(key));
    if (unknown.length > 0) invalidAnswers(`${where} has unknown field ${unknown.join(', ')}`);
    const key = answer.key;
    if (typeof key !== 'string' || !questions.has(key)) {
      invalidAnswers(`${where}.key names no question of this review`);
    }
    if (seen.has(key)) invalidAnswers(`${where} answers ${key} a second time`);
    seen.add(key);
    const option = answer.option ?? null;
    const text = answer.text ?? null;
    if ((option === null) === (text === null)) {
      invalidAnswers(`${where} must give exactly one of option or text`);
    }
    if (option !== null) {
      const count = questions.get(key)!.options.length;
      if (typeof option !== 'number' || !Number.isInteger(option) || option < 0 || option >= count) {
        invalidAnswers(`${where}.option must be one of ${key}'s options (0 to ${count - 1})`);
      }
      return { key, option, text: null, source: 'OWNER' as const };
    }
    const words = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim().normalize('NFC') : '';
    if (words.length === 0 || words.length > LIMITS.answerText) {
      invalidAnswers(`${where}.text must be the owner's own words, 1 to ${LIMITS.answerText} characters`);
    }
    return { key, option: null, text: words, source: 'OWNER' as const };
  });
}

/** The needsYou keys these answers leave unanswered (Q3's 409). */
export function missingAnswerKeys(
  answers: readonly OwnerConfirmationAnswer[],
  needsYou: readonly ConfirmationNeedsYouItem[],
): string[] {
  const answered = new Set(answers.map((answer) => answer.key));
  return needsYou.filter((item) => !answered.has(item.key)).map((item) => item.key);
}

/**
 * Q3 case 1: a client that predates reviews confirmed while the review asks questions. It is not
 * refused (an agent's review never blocks the owner); the recommended option is recorded for each
 * question, and says the owner was not shown it.
 */
export function recommendedAnswers(needsYou: readonly ConfirmationNeedsYouItem[]): OwnerConfirmationAnswer[] {
  return needsYou.map((item) => ({
    key: item.key,
    option: item.recommendedOption,
    text: null,
    source: 'NOT_SHOWN' as const,
  }));
}

export const OWNER_CONFIRMATION_REVIEW_STALE_CODE = 'OWNER_CONFIRMATION_REVIEW_STALE';
export const OWNER_CONFIRMATION_ANSWERS_REQUIRED_CODE = 'OWNER_CONFIRMATION_ANSWERS_REQUIRED';
export const OWNER_CONFIRMATION_ANSWERS_REQUIRED_ACTION = 'ANSWER_EACH_REVIEW_QUESTION';

/** What a decision records about the review of the request it answers (§7 Q4). */
export interface DecisionReview {
  /** Null for a panel confirmation, which answers no request. */
  reviewState: ReviewStateAtDecision | null;
  reviewRecordId: string | null;
  /** Null when no answers are recorded. */
  answers: OwnerConfirmationAnswer[] | null;
  /** The questions those answers answer, for the comment and the reviewer's turn (Q5). */
  needsYou: ConfirmationNeedsYouItem[];
}

function reviewStale(message: string): never {
  throw new ConflictException({
    code: OWNER_CONFIRMATION_REVIEW_STALE_CODE,
    kind: 'REFUSAL',
    requiredAction: STALE_ACTION,
    message: `${message}; nothing was written. Read the task again: the card will show the review as it is now.`,
  });
}

function answersRequired(missing: readonly string[]): never {
  throw new ConflictException({
    code: OWNER_CONFIRMATION_ANSWERS_REQUIRED_CODE,
    kind: 'REFUSAL',
    requiredAction: OWNER_CONFIRMATION_ANSWERS_REQUIRED_ACTION,
    message: `the review asks you ${missing.length === 1 ? 'a question' : `${missing.length} questions`} this `
      + `confirmation does not answer (${missing.join(', ')}); nothing was written. Answer each one — `
      + 'the recommended option is already selected — and confirm again.',
    missingKeys: [...missing],
  });
}

/**
 * Q3's table, and Q4's record of it: what a decision says about the review of the request it answers,
 * or the refusal that sends the card back to be read again. `review` is that request's review read
 * now, under the task's row lock (undefined: it has none).
 *
 * The key `reviewRecordId` being ABSENT is a client older than reviews, and it is never refused for
 * one — that is what keeps an agent's review from ever blocking the owner (§0.2 G2). With questions
 * waiting, their recommended options are recorded for it and say the owner was not shown them. A
 * client that knows about reviews always sends the key, as null when its card drew no review, and is
 * held to the table: a 409 only means the card was out of date, and the card it reads next answers
 * it. A send-back is never refused on account of a review, and carries no answers.
 */
export function decisionReview(input: {
  decision: 'CONFIRM' | 'SEND_BACK';
  /** The request the card was drawn for; null for a panel confirmation. */
  answering: string | null;
  review: OwnerConfirmationReviewView<Date> | undefined;
  /** Undefined when the client sent no such key. */
  reviewRecordId: string | null | undefined;
  answers: unknown;
}): DecisionReview {
  if (input.answers !== undefined && input.answers !== null && !Array.isArray(input.answers)) {
    invalidAnswers('answers must be an array');
  }
  const answered = Array.isArray(input.answers) && input.answers.length > 0;
  const view = input.review;
  const current = view?.review?.recordId ?? null;
  const none: DecisionReview = { reviewState: null, reviewRecordId: null, answers: null, needsYou: [] };
  if (input.decision === 'SEND_BACK') {
    if (answered) invalidAnswers('a send-back carries no answers: your reason is what the run is told');
    return { ...none, reviewState: input.answering ? reviewStateAtDecision(view) : null, reviewRecordId: current };
  }
  if (input.answering === null) {
    if (input.reviewRecordId != null || answered) {
      reviewStale('no run is waiting on this task, so there is no review to answer');
    }
    return none;
  }
  const state = reviewStateAtDecision(view);
  const needsYou = state === 'REVIEWED' ? view!.review!.needsYou : [];
  if (input.reviewRecordId === undefined) {
    if (answered) invalidAnswers('answers name the review they answer: send reviewRecordId beside them');
    return needsYou.length > 0
      ? { reviewState: state, reviewRecordId: current, answers: recommendedAnswers(needsYou), needsYou }
      : { ...none, reviewState: state };
  }
  const given = input.reviewRecordId;
  if (state === 'NONE' || state === 'UNDER_REVIEW' || state === 'NOT_REVIEWED') {
    if (given !== null || answered) reviewStale('the review your card showed is not the one this request has now');
    return { ...none, reviewState: state };
  }
  if (state === 'OUTDATED' || needsYou.length === 0) {
    if ((given !== null && given !== current) || answered) {
      reviewStale('the review your card showed is not the one this request has now');
    }
    return { ...none, reviewState: state, reviewRecordId: given };
  }
  if (given === null) answersRequired(needsYou.map((item) => item.key));
  if (given !== current) reviewStale('a newer review of this request has been recorded since your card was drawn');
  const answers = readOwnerAnswers(input.answers, needsYou);
  const missing = missingAnswerKeys(answers, needsYou);
  if (missing.length > 0) answersRequired(missing);
  return { reviewState: state, reviewRecordId: current, answers, needsYou };
}
