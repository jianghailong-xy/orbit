/**
 * How a project's work reaches its integration line, as every client reads it
 * (`docs/project-integration-line-contract.md` §7.0).
 *
 * One declaration rather than one per client. The web has always re-declared the project shapes it
 * renders in `ProjectsPage.tsx`, and that was affordable while the fields were a title and a count;
 * the states below are not — `TaskIntegrationState` is a closed set the server writes and the row
 * COLOURS by, so a client carrying its own copy of it renders a row the server never described.
 *
 * `Instant` is the one thing that legitimately differs across the wire: the apiserver holds these
 * as `Date`, everything downstream of JSON holds them as ISO strings. Parameterising it is what
 * lets both sides name the same interface instead of keeping two that drift.
 */
import type { IntegrationCheckResult } from './dto';

/** Where this project's finished tasks land: straight onto main, or onto a branch of its own. */
export type IntegrationLine = 'MAIN' | 'PROJECT_BRANCH';

/** Who decided the line — the account owner in the settings, or the default rule at the first
 *  integration (§1.2 L1 / L2). */
export type IntegrationRefSource = 'EXPLICIT' | 'DEFAULT_RULE';

/** Whether the merge check passed the last time the platform ran it on the line's tip (§1.6).
 *  `UNKNOWN` is the absence of a finished job, never a failure it forgot about. */
export type MergeCheckTipState = 'PASSING' | 'FAILING' | 'UNKNOWN';

/**
 * The line itself, as `GET /projects/:id/integration` answers and the project document's settings
 * half repeats (§1.6).
 *
 * Every absence names its reason rather than arriving as a bare null: "nobody chose a line and
 * nothing has integrated yet" and "there is no merge check" are different states, and a client that
 * had to guess between them would print one of them as the other.
 */
export interface ProjectIntegrationSettings<Instant = string> {
  line: IntegrationLine | null;
  lineAbsentReason: 'NOT_DECIDED' | null;
  /** The integration line's branch, spelled as a merge receipt spells it (no `refs/heads/`). */
  ref: string | null;
  upstreamRef: string | null;
  source: IntegrationRefSource | null;
  /** Integration started, so the line can no longer change (§1.2 L4). */
  locked: boolean;
  startedAt: Instant | null;
  mergeCheckCommand: string | null;
  mergeCheckCommandAbsentReason: 'NOT_CONFIGURED' | null;
  mergeCheckTimeoutSeconds: number | null;
  /** How long an exception item may wait on the coordinator before it becomes the owner's (§4.6). */
  escalationSeconds: number;
}

/**
 * The settings plus what the integration queue has done with them (§1.6): the five facts the
 * project page's line row is drawn from.
 *
 * The two counts are plain numbers because zero is the ordinary answer and says something true —
 * nothing in flight. The two instants are not: a project that has never synced with main is not one
 * that synced at the epoch.
 */
export interface ProjectIntegrationView<Instant = string> extends ProjectIntegrationSettings<Instant> {
  /** How far the line is ahead of upstream, from the newest finished `LAND_TASK`. */
  commitsAheadOfUpstream: number | null;
  commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET' | null;
  /** When upstream was last absorbed into the line (§3.1). */
  lastUpstreamSyncAt: Instant | null;
  lastUpstreamSyncAbsentReason: 'NEVER_SYNCED' | null;
  /** Jobs this project has RUNNING and QUEUED right now. */
  integratingCount: number;
  queuedCount: number;
  mergeCheckOnTip: MergeCheckTipState;
}

/**
 * Where one task stands between "done" and "on main" (§2.7).
 *
 * `NOT_APPLICABLE` is the state of most rows in most projects and is not a gap: a codeless task, or
 * one in a project that has not started integrating, has nothing to land, and a row that said
 * "queued" about it would be describing work nobody is going to do.
 */
export type TaskIntegrationState =
  | 'NOT_APPLICABLE'
  | 'QUEUED'
  | 'RUNNING'
  | 'CONFLICT'
  | 'CHECK_FAILED'
  | 'ERROR'
  | 'AWAITING_OWNER'
  | 'ON_INTEGRATION_LINE'
  | 'ON_UPSTREAM';

/** Who is expected to act on this task's integration, while somebody has to (§4.2). */
export type TaskIntegrationHandler = 'COORDINATOR' | 'OWNER';

/** One task's integration, as the project page's task rows read it (§2.7, §7.3 V10). */
export interface TaskIntegrationView<Instant = string> {
  state: TaskIntegrationState;
  /** When the task entered this state. */
  since: Instant | null;
  handler: TaskIntegrationHandler | null;
  openItemId: string | null;
  jobId: string | null;
  /** How long the combined-tree checks have been running, for the row that says so. */
  checksRunningForMs: number | null;
}

/**
 * The three lanes a project's `done` count splits across once it has an integration line, plus the
 * two numbers that make the split readable (§7.2 V6).
 *
 * `done = integrating + onIntegrationLine + onUpstream + doneNotIntegrated` is the invariant the
 * card is drawn from: a project page that showed four lanes summing to something other than its own
 * done count would be inviting the reader to find the missing task.
 *
 * Optional as a set: a server that does not report them is a project page that draws the single
 * Done lane it always drew, rather than one showing three zeroes.
 */
export interface ProjectIntegrationBuckets {
  /** DONE code work the platform still has in hand: queued, checking, or stopped on an exception. */
  integrating: number;
  /** Landed on the project's own branch and not yet on main. Always 0 on a `MAIN` line. */
  onIntegrationLine: number;
  onUpstream: number;
  /** DONE work with nothing to land: codeless tasks, and every task of a project that has no line. */
  doneNotIntegrated: number;
  /** Blocked tasks held by nothing but a prerequisite that is finished and not yet landed (§2.5 J9). */
  waitingForLanding: number;
}

/** What opened an exception item, as §4.2's closed set spells it. */
export type OpenItemKind =
  | 'INTEGRATION_CONFLICT'
  | 'INTEGRATION_CHECK_FAILED'
  | 'INTEGRATION_ERROR'
  | 'TASK_FAILED'
  | 'PROMOTION_APPROVAL'
  | 'COORDINATOR_QUESTION'
  | 'FUSE_PAUSED';

/** Who is expected to act on an item: the project's coordinator, or its owner in person (§4.1). */
export type OpenItemAssignee = 'COORDINATOR' | 'OWNER';

/**
 * Why it is theirs. `DEFAULT` is the ordinary answer; the other five are each a story the card has
 * to tell, because an item that BECAME the owner's says something a plain assignment does not —
 * nobody acted, the conversation ended, the chain ran out, somebody handed it over, or there was
 * never a coordinator to hand it to (§4.1, §4.4 X-D6, §4.5 X-C3, §4.6 X-E1).
 */
export type OpenItemAssigneeReason =
  | 'DEFAULT'
  | 'NO_COORDINATOR'
  | 'COORDINATOR_ENDED'
  | 'CHAIN_LIMIT'
  | 'ESCALATED'
  | 'HANDED_OVER';

/** Where an item owed to a coordinator is on its way there (§4.4). `NOT_REQUIRED` is the owner's
 *  own items: nothing is delivered to a person, they are shown the card. */
export type OpenItemDeliveryState =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'QUEUED'
  | 'DELIVERED'
  | 'RETURNED';

/**
 * The presses an item offers, as the server decides they exist — never as a client guesses.
 *
 * §4.8 names a longer list; this is the part of it with a door on the other side today. A button
 * for a door nobody built is a button that answers a press with nothing, so the server omits it and
 * the card draws what it is given.
 */
export type OpenItemAction =
  | 'REVIEW'
  | 'OPEN_COORDINATOR'
  | 'OPEN_TASK_SESSION'
  | 'RETRY'
  | 'CANCEL_TASK'
  | 'RESUME'
  | 'ANSWER';

/** What a coordinator asked its owner to decide (§5.2 R7). */
export interface CoordinatorQuestion {
  question: string;
  options: Array<{ label: string; description?: string }>;
  /** Index into `options`; null when the coordinator recommended nothing. */
  recommendedOption: number | null;
  blocksTaskIds: string[];
  ifUnanswered: string | null;
}

/**
 * One open exception, as `GET /projects/:id/open-items` serves it (§4.8).
 *
 * `detailLine` is the server's own sentence about what happened, in the words of the fact that
 * opened the item — the client never re-derives it from a payload, because two renderings of one
 * fact are two things free to disagree.
 */
export interface ProjectOpenItemRow<Instant = string> {
  itemId: string;
  kind: OpenItemKind;
  title: string;
  detailLine: string;
  assignee: OpenItemAssignee;
  assigneeReason: OpenItemAssigneeReason;
  /** When the wait began. Reset when the owner sends an item back to the coordinator (§4.7). */
  waitingSince: Instant;
  /** When it stops being the coordinator's, frozen at creation; null once it is the owner's. */
  escalateAt: Instant | null;
  escalatedAt: Instant | null;
  taskId: string | null;
  /** The attempt this item is about, when there is one: the run whose failure opened it. */
  sessionId: string | null;
  promotionId: string | null;
  fuseEpisodeId: string | null;
  delivery: { state: OpenItemDeliveryState; sessionId: string | null; at: Instant | null };
  actions: OpenItemAction[];
  /** Present for a `COORDINATOR_QUESTION` and null for every other kind. */
  question: CoordinatorQuestion | null;
}

/** The project's open exceptions, split by who is expected to act (§4.8). */
export interface ProjectOpenItemsView<Instant = string> {
  needsYou: Array<ProjectOpenItemRow<Instant>>;
  withCoordinator: Array<ProjectOpenItemRow<Instant>>;
}

/**
 * Whether the platform's last word to this project's coordinator reached it (§7.2 V7, V9).
 *
 * The one thing the coordinator card could never say before: a conversation that looks idle because
 * nothing was delivered reads exactly like one that is idle because it has nothing to do, and this
 * project exists because the first was happening and nobody could see it.
 */
export interface CoordinatorWakeups<Instant = string> {
  state: 'DELIVERED' | 'QUEUED' | 'RETURNED' | 'NONE';
  at: Instant | null;
}

/**
 * What the coordinator has spent on its own today, against what it may (§6.1, §7.2 V9).
 *
 * `limit` is null when the project authorised an unbounded one: a card that drew that as a full
 * meter would be reporting a limit nobody set.
 */
export interface CoordinatorFuseUsage {
  selfStartedToday: number;
  limit: number | null;
  paused: boolean;
  /** The open pause, for the card that resumes it; null while nothing is paused. */
  episodeId: string | null;
}

/**
 * Where a candidate for merging into the upstream stands (§3.3, the four states mock 4 draws).
 *
 * `CHECKING` asks nobody anything — the checks are running — and the four terminal-ish states at
 * the end are candidates nothing is waiting on. The card draws `READY`, `CONFIRMED` / `RECHECKING`,
 * `MERGED` and `BLOCKED`, which are exactly states A, B, C and D.
 */
export type PromotionState =
  | 'CHECKING'
  | 'READY'
  | 'CONFIRMED'
  | 'RECHECKING'
  | 'MERGED'
  | 'BLOCKED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'SUPERSEDED';

/** What is being merged: the project's own branch, or one task's branch on a `MAIN` line (§3.2). */
export type PromotionSourceKind = 'PROJECT_BRANCH' | 'TASK_BRANCH';

/**
 * What the confirmation card is drawn from, as `GET /projects/:id/promotions/current` serves it
 * (§3.6).
 *
 * One declaration for the server that writes it and the clients that draw it, for the reason at the
 * top of this file: every field here is a fact about a merge that has not happened yet, and a client
 * holding its own copy of the shape would be free to describe that merge differently from the row
 * the owner is actually confirming.
 */
export interface ProjectPromotionView<Instant = string> {
  promotionId: string;
  state: PromotionState;
  sourceKind: PromotionSourceKind;
  sourceRef: string;
  /** The tip being offered. Travels back with the confirmation, so a card drawn from a candidate
   *  the branch has since moved past is refused rather than merging something else (M-F3). */
  sourceSha: string;
  upstreamRef: string;
  commitsAhead: number | null;
  filesChanged: number | null;
  taskIds: string[];
  checks: IntegrationCheckResult[];
  conflicts: string[];
  /** Null until a check has passed; after that, the upstream tip that check ran against. */
  upstreamShaChecked: string | null;
  /** The tree the checks passed on, which is the tree that lands (M6). Null before they have. */
  landsTreeSha: string | null;
  landsAs: 'MERGE_COMMIT' | 'FAST_FORWARD';
  askedAt: Instant | null;
  /** When the re-check after a moved upstream began (M5, state B); null while none has. */
  recheckedAt: Instant | null;
  merged: { sha: string; byUserId: string | null; at: Instant } | null;
}

/**
 * The four things a project can be waiting on its OWNER for (§7.1 V1, §7.6 V12/V13).
 *
 * Not the same list as `OpenItemKind`, and deliberately: the three kinds that are the owner's from
 * birth keep their own names, and every exception that BECAME theirs — because nobody acted, the
 * conversation ended, the chain ran out, somebody handed it over, or there was never a coordinator
 * — collapses into `ESCALATED`, because what the owner has to know about those is that they are now
 * theirs and not which door they came through. An exception still with the coordinator is not here
 * at all: it is the coordinator's to handle, and the owner is not told about it (owner decision 10).
 */
export type OwnerItemKind =
  | 'PROMOTION_APPROVAL'
  | 'COORDINATOR_QUESTION'
  | 'ESCALATED'
  | 'FUSE_PAUSED';

/**
 * What a "needs you" push says it is about (§7.6 V12) — the same four reasons the project list
 * draws its chips from (§7.1 V2), in the same words, so the phone and the page name one thing once.
 */
export type OwnerItemPushKind =
  | 'approve-merge-to-main'
  | 'coordinator-question'
  | 'escalated-to-you'
  | 'fuse-paused';

/** The push slug for an owner item's kind. One direction only: the slug is what leaves the server. */
export const OWNER_ITEM_PUSH_KINDS: Record<OwnerItemKind, OwnerItemPushKind> = {
  PROMOTION_APPROVAL: 'approve-merge-to-main',
  COORDINATOR_QUESTION: 'coordinator-question',
  ESCALATED: 'escalated-to-you',
  FUSE_PAUSED: 'fuse-paused',
};

/**
 * One owner item on a conversation's summary (§7.6 V13).
 *
 * It rides on the session row the clients already hold, so the Needs-you banner can say WHICH of
 * the four is waiting and open the card without a request of its own — the count alone could only
 * say that something was. `itemId` is what makes the second half of that true: it is the address
 * the banner's tap and the push payload's `openItemID` both carry.
 */
export interface SessionOwnerItem<Instant = string> {
  itemId: string;
  kind: OwnerItemKind;
  /** The item's own title, as the server wrote it when the item was opened. */
  title: string;
  /** Since when it has been waiting on the owner. The banner shows the oldest. */
  since: Instant;
}
