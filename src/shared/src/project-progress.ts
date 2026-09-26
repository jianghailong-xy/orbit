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
  /**
   * The OLDEST of those jobs, described — or null when there is none, which is also the answer a
   * project with no line gives.
   *
   * The two counts above say how much is in flight; a project page whose only live signal was a
   * number read as stopped (owner report, 2026-09-25: Running 0 · Ready 0 · Integrating 1 for the
   * four minutes a landing takes), so the Work overview card draws what the queue is actually
   * doing from this: which task, whether it is checking or still queued, and since when.
   *
   * The OLDEST rather than the newest, because that is the one the counts are waiting on: a row
   * that named the job that just started would reset its own clock every time another landed.
   */
  inFlight: ProjectIntegrationInFlight<Instant> | null;
}

/**
 * One integration job in flight, as the Work overview card's live line reads it.
 *
 * `taskTitle` is null for the kinds that land no single task — a promotion of the project's own
 * branch, a merge check — because the title is a fact only the task's row has and inventing one for
 * those would name work that is not what is being pushed. The row draws what it is given.
 */
export interface ProjectIntegrationInFlight<Instant = string> {
  taskTitle: string | null;
  /** `RUNNING` while the combined-tree checks are running; `QUEUED` while it waits its turn. */
  state: 'RUNNING' | 'QUEUED';
  /** What "for how long" counts from: the claim for a running job, the enqueue for a queued one. */
  startedAt: Instant;
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

/**
 * The kinds a project's coordinator can be handling (§7.1 V1/V2): `OpenItemKind` minus the three
 * that are the owner's from birth.
 *
 * A merge approval, a question to the owner and a pause are asked OF the owner and never worked BY
 * the coordinator, so an item whose assignee is the coordinator is one of these four — which is
 * what lets the list row's blue chip be a `Record` over this type rather than a switch with a
 * branch for a state that cannot happen. A kind that later becomes returnable to the coordinator
 * (the one §4.7 lists and has no door for yet) adds itself here, and every reader fails to compile
 * until it has a phrase.
 *
 * The array is the runtime half: the server builds its read's `IN` list from it, so the phrase a
 * client prints and the rows a server counts cannot be about different sets.
 */
export const COORDINATOR_LEAD_KINDS = [
  'INTEGRATION_CONFLICT',
  'INTEGRATION_CHECK_FAILED',
  'INTEGRATION_ERROR',
  'TASK_FAILED',
] as const;
export type CoordinatorLeadKind = (typeof COORDINATOR_LEAD_KINDS)[number];

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
  | 'ASK_COORDINATOR_AGAIN'
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
 * What an exception item's payload holds, as the rows its card draws (§7.5, mock 5).
 *
 * The payload is a column of the item's own row — the runner's report of the job that did not land,
 * or the failure the platform recorded — and until this shape it was read once, turned into the
 * item's one sentence, and served to nobody. A card could say a check had failed but not which
 * command failed, with what exit code, or whether the branch it failed on had moved; every one of
 * those facts was in the row the whole time (`project_open_item.payload`).
 *
 * Every field is a key of that payload, typed, and every absent key is null or false rather than
 * missing: a payload an older build wrote leaves a row the card can skip, never a hole it falls
 * into. The card's own words for them are the card's — this is the data, not the copy.
 */
export interface OpenItemFacts {
  /** The task the item is about, when it names one. Null for a promotion's item: a job that lands
   *  the project's own branch is about no single task, and the item's title says what it was about
   *  instead. */
  task: { id: string; title: string } | null;
  /** The branch an integration was moving work into, and the tip it was moving (INTEGRATION_*). */
  targetRef: string | null;
  targetSha: string | null;
  /** The paths a conflicting merge could not reconcile (INTEGRATION_CONFLICT). */
  files: string[];
  /** Whether the target branch is where it was — the first thing a reader asks a conflict. */
  nothingLanded: boolean;
  /** The check that disagreed on the combined tree, whole: its command, verdict, how long it took
   *  and the tail of what it printed (INTEGRATION_CHECK_FAILED). */
  check: IntegrationCheckResult | null;
  /** Whether the task's own branch passed — the check failed only combined with it. */
  branchUnchanged: boolean;
  /** The code an integration job ended with (INTEGRATION_ERROR). */
  errorCode: string | null;
  /** Why an attempt failed, and where its chain stands (TASK_FAILED). */
  failure: {
    how: string | null;
    exitCode: number | null;
    expectedExitCode: number | null;
    /** How many failures this replace-chain has now had, this one included, and where it gives up
     *  (§4.5): the last one is the owner's rather than the coordinator's. */
    attempt: number;
    limit: number;
  } | null;
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
  /** When it stops being the coordinator's: the deadline frozen at creation, moved on while the
   *  coordinator conversation is still carrying it (§4.6); null once it is the owner's. */
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
  /** What the item's payload holds, as the rows its card draws; null when the payload is not a
   *  shape this build reads — an item an older build opened, a pause, a question — and the card
   *  then draws what it drew before this existed. */
  facts: OpenItemFacts | null;
}

/** The project's open exceptions, split by who is expected to act (§4.8). */
export interface ProjectOpenItemsView<Instant = string> {
  needsYou: Array<ProjectOpenItemRow<Instant>>;
  withCoordinator: Array<ProjectOpenItemRow<Instant>>;
}

/**
 * Where the work an item is about has landed, as merge receipts answer it — the three-valued fold
 * of §2.7, spelled here for the wire. `NOT_KNOWN` rather than a denial, for the reason the fold
 * itself gives: work lands by paths that leave no receipt, so no receipt is no EVIDENCE.
 */
export type OpenItemDeliveryLanding = 'ON_UPSTREAM' | 'ON_INTEGRATION_LINE' | 'NOT_KNOWN';

/**
 * What one exception item's DELIVERY to the coordinator carries beside its text (§4.4 X-D2).
 *
 * The turn the coordinator is handed is a paragraph of prose and, until this existed, the paragraph
 * was all the record held: the fields the item was opened with — its kind, its title, the files a
 * merge conflicted on, the doors that exist for it — were read once, rendered into the words, and
 * dropped. A client drawing that turn therefore had nothing to draw it from but the words, and drew
 * them as a message the reader had typed.
 *
 * This is the same reading, kept: recorded beside the runner's echo of that turn, out of the item's
 * own columns at the moment the delivery reached the conversation. A SNAPSHOT, deliberately — what
 * the platform knew when it handed the item over — and every field is either a column of the item's
 * row or `landing`, read once from the merge receipts of the task it is about, because a
 * coordinator that has to check the same receipt every time is spending a turn on what the platform
 * already knew.
 */
export interface OpenItemDeliveryCard {
  /** The item, in the uuid spelling every other read of one uses. */
  itemId: string;
  kind: OpenItemKind;
  title: string;
  /** The task the item is about and the attempt that opened it; null for a promotion's item. */
  task: { id: string; title: string; sessionId: string | null } | null;
  /** The files a conflicting merge reported. Empty for every other kind. */
  files: string[];
  /** The branch an integration was moving work into, when the item recorded one. */
  targetRef: string | null;
  /** The check that disagreed on the combined tree (INTEGRATION_CHECK_FAILED). */
  check: { name: string; exitCode: number | null; expectedExitCode: number | null } | null;
  /** The code an integration job ended with (INTEGRATION_ERROR). */
  errorCode: string | null;
  /** Why an attempt failed, and where its chain stands (TASK_FAILED). */
  failure: {
    how: string | null;
    exitCode: number | null;
    expectedExitCode: number | null;
    attempt: number;
    limit: number;
  } | null;
  /** The doors that exist for this item today, as the server decides them (§4.8). */
  actions: OpenItemAction[];
  /**
   * What the platform knew about the landing when it handed the item over, or null when it is not
   * answerable — an item about no task at all, which is what a promotion's is.
   */
  landing: {
    /** Merge receipts the task has, of any result. Zero is "no evidence", never "not landed". */
    receipts: number;
    state: OpenItemDeliveryLanding;
    /** The branch "on main" means for this project, and the line its tasks land on (§1.4). */
    upstream: string;
    integration: string;
  } | null;
}

/**
 * What the message telling a coordinator its project was started carries beside its words
 * (apiserver `project-started.ts`), so a client draws it as a card rather than as a bubble the
 * reader typed.
 *
 * The turn is prose written for the AGENT — tool names, ids, `autoRunWhenReady` — and a person
 * watching the conversation needs three facts from it: how the project was started, which project,
 * and which of its tasks now wait on the coordinator. Recorded beside the runner's echo of that
 * turn, like `OpenItemDeliveryCard`: a snapshot of what the platform knew when the message reached
 * the conversation.
 */
export interface ProjectStartedCard {
  /** `CONFIRMATION` is "Start the project" (the owner confirming the criteria); `SWITCH` is the
   *  project page's Automatic switch. */
  by: 'CONFIRMATION' | 'SWITCH';
  /** The project, in the uuid spelling every other read of one uses. */
  projectId: string;
  projectTitle: string;
  /** How many criteria the confirmation named; null for the switch, which confirmed nothing. */
  criteriaCount: number | null;
  /** Open tasks set to be started by hand (`autoRunWhenReady=false`), oldest first — at most as
   *  many as the message lists. */
  held: Array<{ id: string; title: string }>;
  /** How many such tasks there are in all. */
  heldCount: number;
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

/** One task a candidate would carry onto the upstream, as the card's Tasks row lists it (§3.6). */
export interface PromotionTask {
  taskId: string;
  title: string;
}

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
   *  the branch has since moved past is refused rather than merging something else (M-F3).
   *
   *  Null only while a `TASK_BRANCH` candidate is still `CHECKING`: a MAIN-line project offers a
   *  task's branch, and where that branch points is a fact only the repository has — the runner
   *  that fetches the ref is what resolves it, and the check that reports it writes it here
   *  (migration 0293). Every state a check produced carries one, and those are the states the card
   *  is drawn from, so a card never renders a null. */
  sourceSha: string | null;
  upstreamRef: string;
  commitsAhead: number | null;
  filesChanged: number | null;
  /** What this merge would carry, in `included_task_ids` order. The ids alone were not enough for
   *  the card: the owner is deciding about tasks, and a count of them is not a name. */
  tasks: PromotionTask[];
  /** The same ids without their titles, kept because the native mirror in OrbitKit counts what it
   *  would merge from this field; a wire shape does not change because a client is behind. */
  taskIds: string[];
  checks: IntegrationCheckResult[];
  /** The paths the merge could not reconcile, empty unless the candidate is BLOCKED. */
  conflicts: string[];
  /** Null until a check has passed; after that, the upstream tip that check ran against. */
  upstreamShaChecked: string | null;
  /** The tree the checks passed on, which is the tree that lands (M6). Null before they have. */
  landsTreeSha: string | null;
  landsAs: 'MERGE_COMMIT' | 'FAST_FORWARD';
  askedAt: Instant | null;
  /**
   * The upstream side of this candidate: when the project branch last took main in (§3.1 M1), and
   * whether anything conflicted. `syncedAt` is null for a branch that has never absorbed one — a
   * project whose first landing is still on its own line — and the card says what it knows instead.
   */
  upstream: { syncedAt: Instant | null; conflicts: boolean };
  /** When the re-check after a moved upstream began (M5, state B); null while none has. */
  recheckedAt: Instant | null;
  /**
   * The re-check a landing is in the middle of (state B), or null when none is.
   *
   * The two numbers are nullable on purpose: `upstreamMovedBy` is what the runner counted main
   * moving, and `typicalMs` is how long this project's checks usually take, and a reader must be
   * able to say "2m so far" when the platform has neither rather than print a zero it made up.
   */
  recheck: { upstreamMovedBy: number | null; startedAt: Instant; typicalMs: number | null } | null;
  /**
   * The merge, once it happened (state C). `byUserId` is who pressed Merge; `automatic` is true when
   * nobody did — the project's Automatic setting merged its own branch because the check was clean
   * (§3.3 M-T11), and `byUserId` is then null. `revert` is the one command that takes the merge
   * back out of the upstream (`git revert -m 1 <sha>` for a merge commit), null for a fast-forward,
   * which has no single commit that undoes it.
   */
  merged: {
    sha: string;
    byUserId: string | null;
    at: Instant;
    automatic: boolean;
    revert: string | null;
  } | null;
  /**
   * When this candidate stopped being live: the instant a check blocked it (state D), the owner's
   * decline, the cancel or the supersede that ended it — and, on a row that merged, the merge's own
   * instant, which is also in `merged.at`.
   *
   * Null while it is still asking (CHECKING, READY, CONFIRMED, RECHECKING), and every reader treats
   * the absence as "no moment" rather than as an error. The conversation draws a candidate that has
   * one at that moment in its transcript instead of at the tail of the pane
   * (`promotionRecordMoment`): a card that says what already happened, pinned under every later
   * message, reads as though it happened now — the owner's report of 2026-09-24.
   */
  decidedAt: Instant | null;
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
 * One of the four things a project is waiting on its owner for, as the projects index aggregates it
 * (§7.1 V1): how many items of this kind are open, and how long the oldest has been waiting.
 *
 * The count and the instant, not the items: the list row names ONE action, and which item is behind
 * it belongs to the project page's Open items card.
 */
export interface ProjectListOwnerItem<Instant = string> {
  kind: OwnerItemKind;
  count: number;
  /** The oldest `waiting_since` among this kind's open items — how long the owner has been asked. */
  oldestWaitingSince: Instant;
}

/**
 * What the project's coordinator is holding, as the projects index aggregates it (§7.1 V1).
 *
 * `leadKind` is the kind of the item that has waited longest, which is the one the row's chip names:
 * a row that listed every kind would be a second Open items card, and the list is read to find the
 * project that is stuck, not to read its inbox. `nextEscalationAt` is when the first of them stops
 * being the coordinator's — the instant the project page's own Open items row counts down to, and
 * carried here so both readings answer from one row.
 */
export interface ProjectListCoordinatorItems<Instant = string> {
  count: number;
  leadKind: CoordinatorLeadKind;
  oldestWaitingSince: Instant;
  nextEscalationAt: Instant;
}

/**
 * Where a project's finished work lands, as one list row states it (§7.1 V1).
 *
 * Absent when nobody has decided a line and nothing has integrated yet: a project with no line has
 * no line to draw, and printing the default rule's guess there would state a decision nobody made.
 */
export interface ProjectListIntegration {
  line: IntegrationLine;
  /** The branch's name, spelled as a merge receipt spells it (no `refs/heads/`). */
  ref: string;
}

/**
 * What a project's coordinator conversation is doing, as one list row states it.
 *
 * The task rollup cannot say this: a coordinator reading, planning or answering writes no task, so
 * a project whose only motion is its coordinator reads as idle and sorts by a task write from days
 * ago. The iPhone drawer lays the live session list over its rows for this; a client holding no
 * such list reads it here. Null on a project with no coordinator bound.
 */
export interface ProjectListCoordinatorActivity<Instant = string> {
  /** The conversation is working right now — exactly when the session list draws its spinner. */
  working: boolean;
  /** Its newest turn, or null before its first one. */
  lastTurnAt: Instant | null;
}

/**
 * What `GET /projects` says about who must act on a project, and how long they have had to — the
 * blockers the list has always aggregated plus the items behind them (§7.1 V1).
 *
 * The two item fields are optional for the reason `attention` itself is: a web bundle can outlive
 * the apiserver that served it through a rolling deploy, and a server that predates this read sends
 * neither, in which case the row draws exactly the chips it drew before.
 */
export interface ProjectListAttention<Instant = string> {
  userBlockers: number;
  coordinatorBlockers: number;
  systemBlockers: number;
  /** Loudest still-open USER-owned blocker; other actors never inflate human priority. */
  maxSeverity: 'INFO' | 'WARNING' | 'CRITICAL' | null;
  /** Oldest instant a still-open blocker became USER-owned, or null when none needs a person. */
  attentionSinceAt: Instant | null;
  /** Earliest active durable check; escalated blockers no longer tick. */
  nextCheckAt: Instant | null;
  ownerItems?: Array<ProjectListOwnerItem<Instant>>;
  coordinatorItems?: ProjectListCoordinatorItems<Instant> | null;
}

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

/**
 * What a session row says its `pendingApprovals` is counting, when one word says it better than
 * "approval" — the two kinds whose count is not an approval at all.
 *
 * `OWNER_CONFIRMATION` is an OWNER_CONFIRMED task's run waiting for its owner to confirm it done.
 * `OWNER_ITEM` is one of the four above: the row says the oldest item's own word (`Escalated to
 * you`, `Paused`, …) — the same words the Needs-you banner and the card in the conversation use —
 * because on a project whose coordinator is switched off the item is the owner's precisely when
 * nobody else will take it. A row counting anything else (a blocked tool call, a proposal) keeps the
 * generic approval wording, and so does one counting two kinds at once.
 */
export type SessionWaitingKind = 'OWNER_CONFIRMATION' | 'OWNER_ITEM';
