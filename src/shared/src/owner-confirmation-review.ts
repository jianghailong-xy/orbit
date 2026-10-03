/**
 * The review an OWNER_CONFIRMED confirmation request gets before its owner is asked
 * (docs/owner-confirmation-review-contract.md §3.4). One declaration for the server, the web and
 * OrbitKit: the reviewer's input as its two tools take it, the records as the reads serve them, and
 * the readings the session rows and turn cards carry.
 */

/**
 * One line of a review. criterionKey / whyNotProven / coordinatorChecked / evidenceRefs are
 * AcceptedGap's fields (project-done.ts), with the same names and meanings: a notChecked line that
 * names a criterionKey IS an AcceptedGap, plus a key and a text.
 */
export interface ConfirmationReviewItem {
  /** Given by the server when the record is written: c1… checked, x1… notChecked, n1… needsYou,
   *  o1… leftOpen, p1… problems. Answers name items by it. */
  key: string;
  /** The line as the reviewer wrote it. 1–300 characters. */
  text: string;
  /** The project criterion the line is about, when the task serves one (the key project_get returns). */
  criterionKey?: string;
  /** notChecked only: why it could not be checked. At most 500 characters. */
  whyNotProven?: string;
  /** notChecked only: what was checked instead. At most 500 characters. */
  coordinatorChecked?: string;
  /** Where the evidence is: a commit, a CI run URL, an Orbit id, a command and its result.
   *  At most 10, each at most 500 characters. */
  evidenceRefs?: string[];
}

/** A line only the owner can decide: a question, its options, and the default the card preselects. */
export interface ConfirmationNeedsYouItem extends ConfirmationReviewItem {
  /** Each option has ask_owner's shape (label 1–200, description at most 500). Unlike ask_owner,
   *  which allows none, a needsYou line has 2–4: it is a choice, so it is answerable in one tap. */
  options: Array<{ label: string; description?: string }>;
  /** Index into options. Required: the card preselects it and tags it Recommended. */
  recommendedOption: number;
}

export interface ConfirmationReviewLists {
  checked: ConfirmationReviewItem[];        // at most 20
  notChecked: ConfirmationReviewItem[];     // at most 20
  needsYou: ConfirmationNeedsYouItem[];     // at most 10
  leftOpen: ConfirmationReviewItem[];       // at most 20
}

type WithoutKey<T> = Omit<T, 'key'>;

/** task_confirmation_review's input (§3.5). Items arrive without keys. */
export interface ConfirmationReviewInput {
  taskId: string;
  requestId: string;
  /** 40 lowercase hex; required when the request has a branch_sha, absent when it has none. */
  reviewedSha?: string | null;
  /** The reviewer's call, in a sentence or two. 1–500 characters. */
  judgment: string;
  checked: WithoutKey<ConfirmationReviewItem>[];
  notChecked: WithoutKey<ConfirmationReviewItem>[];
  needsYou: WithoutKey<ConfirmationNeedsYouItem>[];
  leftOpen: WithoutKey<ConfirmationReviewItem>[];
}

/** task_confirmation_return's input (§8). */
export interface ConfirmationReturnInput {
  taskId: string;
  requestId: string;
  reviewedSha?: string | null;
  /** Delivered to the run as its next message. 1–4000 characters. */
  reason: string;
  /** 1–10 lines: what is wrong, each with its evidence. */
  problems: Array<Pick<ConfirmationReviewItem, 'text' | 'criterionKey' | 'evidenceRefs'>>;
}

// ── What the reads serve (§4–§9). Instants are ISO strings on the wire. ──

export type OwnerConfirmationReviewState =
  'UNDER_REVIEW' | 'REVIEWED' | 'NOT_REVIEWED' | 'OUTDATED' | 'RETURNED';
export type OwnerConfirmationNotReviewedReason =
  | 'TIMED_OUT' | 'REVIEWER_ENDED' | 'REVIEWER_STOPPED' | 'NO_COORDINATOR'
  | 'AUTOMATIC_OFF' | 'COORDINATOR_PAUSED' | 'UNREACHABLE';

/** The review of one confirmation request, as the card and its receipts draw it. */
export interface OwnerConfirmationReviewView<Instant = string> {
  reviewId: string;
  state: OwnerConfirmationReviewState;
  /** Set exactly when state is NOT_REVIEWED (T2). */
  notReviewedReason: OwnerConfirmationNotReviewedReason | null;
  /** Set exactly when state is OUTDATED (T3); branchSha is the run's tip now, for BRANCH_MOVED. */
  outdated: { cause: 'NEWER_REPORT' | 'BRANCH_MOVED'; branchSha: string | null } | null;
  reviewer: {
    kind: 'PROJECT_COORDINATOR' | 'TASK_CREATOR';
    sessionId: string | null;
    /** The reviewer session's title now (S5); null when it cannot be read. */
    title: string | null;
  };
  /** The request's requestedAt: "Reviewing since". */
  since: Instant;
  dueAt: Instant;
  windowSeconds: number;
  /** H2, computed by the server from the record shown: PROBLEMS when there is one, else REVIEW. */
  headline: ConfirmationReviewHeadline | null;
  review: ({
    recordId: string;
    recordedAt: Instant;
    reviewedSha: string | null;
    judgment: string;
  } & ConfirmationReviewLists) | null;
  returned: ConfirmationReturnRecordView<Instant> | null;  // the RETURN record (§8)
  problems: ConfirmationReturnRecordView<Instant> | null;  // the PROBLEMS record (§9)
}

export interface ConfirmationReturnRecordView<Instant = string> {
  recordId: string;
  recordedAt: Instant;
  reviewedSha: string | null;
  reason: string;
  problems: ConfirmationReviewItem[];
}

export type ConfirmationReviewHeadline =
  | { kind: 'NEEDS_YOU'; text: string; more: number }
  | { kind: 'NOTHING_NEEDS_YOU'; notChecked: number }
  | { kind: 'PROBLEMS_AFTER_CONFIRM'; problems: number };

/** One answer, as the decision row stores it (Q4). */
export interface OwnerConfirmationAnswer {
  key: string;
  option: number | null;
  text: string | null;
  /** OWNER: the owner chose it on the card. NOT_SHOWN: the client did not know about reviews, so
   *  the recommended option was recorded for them (Q3). */
  source: 'OWNER' | 'NOT_SHOWN';
}

/**
 * The OWNER_CONFIRMED request on a run's session that is still with its reviewer (N3): the row says
 * "Under review" and is not counted. Sent as null when there is none; absent from an older server.
 */
export interface ConfirmationUnderReview<Instant = string> {
  requestId: string;
  taskId: string;
  reviewerSessionId: string | null;
  reviewerTitle: string | null;
  /** The request's requestedAt. */
  since: Instant;
  dueAt: Instant;
}

/**
 * The reading the reviewer's `owner-confirmation-review:v1:` turn carries on its `user` event (D7):
 * drawn as a read-only "Review requested" card rather than as the owner's own message.
 */
export interface ConfirmationReviewRequestCard {
  requestId: string;
  reviewId: string;
  taskId: string;
  title: string;
  runSessionId: string;
  branch: string | null;
  sha: string | null;
  dueAt: string;
}

/**
 * The reading the run's `confirmation-return:v1:` turn carries on its `user` event (§8 B3): drawn
 * as "Sent back by the reviewer", never as the owner's own message.
 */
export interface ConfirmationReturnCard {
  requestId: string;
  recordId: string;
  reviewerSessionId: string | null;
  reviewerTitle: string | null;
  reason: string;
  problems: ConfirmationReviewItem[];
}
