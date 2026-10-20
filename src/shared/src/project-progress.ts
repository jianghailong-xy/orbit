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
import type { IntegrationCheckResult, IntegrationJobKind, IntegrationJobOutputCheck, IntegrationJobPhase, IntegrationJobState } from './dto';
import type { ProjectStartRequest, ProjectStartSettingKey, ProjectStartSettings } from './project-start';
import type { DoneRequest } from './project-done';

/** Where this project's finished tasks land: straight onto main, or onto a branch of its own. */
export type IntegrationLine = 'MAIN' | 'PROJECT_BRANCH';

/** Who decided the line — the account owner in the settings, or the default rule at the first
 *  integration (§1.2 L1 / L2). */
export type IntegrationRefSource = 'EXPLICIT' | 'DEFAULT_RULE';

/** The check results of the latest finished task landing attempt (§1.6).
 *  `UNKNOWN` means that attempt has no complete check verdict. */
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
  /** The project's main branch, short (no `refs/heads/`); null while it has no binding. */
  upstreamRef: string | null;
  /**
   * When the account owner chose this project's main branch (§1.2 L6) — null while it is still
   * the default, or the choice a new binding carried over from this account's last one for the
   * same repository, and for a project with no binding. Absent on servers that predate it.
   */
  upstreamChosenAt?: Instant | null;
  /**
   * The main branch this account chose last for this project's repository (§1.2 L6), which is what
   * a new binding of that repository starts from — null when it has never chosen one there, or the
   * project has no repository. Absent on servers that predate it.
   */
  lastMainBranch?: ProjectLastMainBranch<Instant> | null;
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

/** An account's last choice of main branch for one repository (§1.2 L6). */
export interface ProjectLastMainBranch<Instant = string> {
  /** The branch, short (no `refs/heads/`). */
  branch: string;
  /** The repository, short: the last two segments of its canonical URL, as `repository` gives it. */
  repository: string;
  chosenAt: Instant;
}

/**
 * The branches a project's main branch can be chosen from (§1.6): the local branches the runner
 * last reported for a session of the project's coordination workspace (`session.merge_targets`),
 * without Orbit's own `orbit/*` session branches and without the account's project branches (the
 * branch each of its projects on a project branch integrates into).
 */
export interface ProjectBranchCandidates<Instant = string> {
  names: string[];
  /** The coordination workspace they were reported for. */
  workspaceName: string;
  reportedAt: Instant;
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
  /**
   * The project's repository, short — the last two segments of its canonical URL, as
   * `acme/payments-api`: its binding's, or before it has one, its coordination workspace's. Null
   * when neither names one, and then the project has no main branch to choose. Absent on servers
   * that predate it.
   */
  repository?: string | null;
  /** What its main branch can be chosen from; null when nothing has been reported. Absent on
   *  servers that predate it. */
  branches?: ProjectBranchCandidates<Instant> | null;
  /** Distance measured by the last successful `LAND_TASK` that reported it; a historical snapshot. */
  commitsAheadOfUpstream: number | null;
  commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET' | null;
  /** When upstream was last absorbed into the line (§3.1). */
  lastUpstreamSyncAt: Instant | null;
  lastUpstreamSyncAbsentReason: 'NEVER_SYNCED' | null;
  /** Jobs this project has RUNNING and QUEUED right now. */
  integratingCount: number;
  queuedCount: number;
  /** Legacy field name: checks of the last landing attempt, which may never have reached the tip. */
  mergeCheckOnTip: MergeCheckTipState;
  /**
   * The oldest RUNNING job, or oldest QUEUED job when none is running — or null when there is none,
   * which is also the answer a
   * project with no line gives.
   *
   * The two counts above say how much is in flight; a project page whose only live signal was a
   * number read as stopped (owner report, 2026-09-25: Running 0 · Ready 0 · Integrating 1 for the
   * four minutes a landing takes), so the Work overview card draws what the queue is actually
   * doing from this: which task, whether it is checking or still queued, and since when.
   *
   * Running work takes precedence over queued work so the row names what the platform is doing.
   * Within that state the oldest job keeps the clock from resetting when another job starts.
   */
  inFlight: ProjectIntegrationInFlight<Instant> | null;
  /**
   * Every job the two counts count, in `inFlight`'s order — running first, then the queue oldest
   * first — so its first entry is the job `inFlight` describes. What the landing row's job list
   * draws when "N jobs" is pressed: which task each one lands, how far it got, and whether its
   * runner stopped reporting. Absent on servers that predate it.
   */
  inFlightJobs?: ProjectIntegrationJob<Instant>[];
  /**
   * The project's current `LAND_TASK`s (§2.7a), each through the same read model the task's own
   * page reads: every task's newest generation that is queued or running, every done task whose
   * newest generation stopped at a conflict, a failed check or an error nothing has landed since,
   * and the one that landed last. Running first, then the queue in claim order, then the stops,
   * then the last landing. Absent on servers that predate it.
   */
  landTasks?: ProjectLandTask<Instant>[];
}

/** One task's current `LAND_TASK` on the project's integration view (§2.7a). */
export interface ProjectLandTask<Instant = string> {
  taskId: string;
  taskTitle: string;
  integration: TaskIntegrationView<Instant>;
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
  /** Absent on older servers, which cannot describe the operation more specifically. */
  kind?: IntegrationJobKind;
  /** The runner's reported step; null before its first report, absent on older servers. */
  phase?: IntegrationJobPhase | null;
  /** `RUNNING` while the runner performs the job; `QUEUED` while it waits its turn. */
  state: 'RUNNING' | 'QUEUED';
  /** What "for how long" counts from: the claim for a running job, the enqueue for a queued one. */
  startedAt: Instant;
  /** Last report from the runner; absent on older servers and null before a claim. */
  heartbeatAt?: Instant | null;
  /**
   * How long the job waited its turn before the claim, in ms — the same measurement the task row's
   * landing carries (`LandTaskIntegrationView.waitMs`).
   *
   * The clock counts from the claim, so the minutes a reader watches are the minutes of WORK, and a
   * job that sat in the queue for two and a half of them having run for four is a different story
   * from one that has been running for six and a half. Absent on older servers and on a job still
   * queued, whose whole elapsed time IS the wait.
   */
  waitMs?: number | null;
  /** The job this line describes. Absent on older servers. */
  jobId?: string;
  /** The landing session this job belongs to (§2.9). Absent until a server fills the slot. */
  landingSessionId?: string | null;
  /** The task it lands; null for a promotion or a merge check, which land no single task. */
  taskId?: string | null;
  /** The candidate a promotion job checks or lands; null for a task landing. */
  promotionId?: string | null;
  /** The runner holding the claim, by name; null while queued. Absent on older servers. */
  runner?: string | null;
  /** The claim generation the job is on: 0 before its first claim, one more per takeover. */
  claim?: number;
  /** The round inside the current claim, from 1, as the v2 reports name it; null before one. */
  round?: number | null;
  /** The check in flight under a v2 claim; null between checks and for a legacy claim. */
  check?: ProjectIntegrationCheck<Instant> | null;
  /** When the current step began (§7.2 V6's main clock); null on a client that never reported one. */
  stepStartedAt?: Instant | null;
  /** When the current step's output last moved; null when no report measured it. */
  outputMovedAt?: Instant | null;
  /** The protocol this job's current claim was written with: `'v2'`, or null for legacy. */
  progressProtocol?: string | null;
  /** How long this project's successful runs of the current MERGE_CHECK usually take; null for
   *  every other check, and until there is a successful run to measure. */
  typicalMs?: number | null;
  /** §7.2 V6's read-time liveness; null for a job waiting its turn, which has no claim to judge. */
  liveness?: IntegrationJobLiveness | null;
  /** Why a queued job is not claimed, or why a claimed one waits on this runner's local lock. */
  blockingReason?: IntegrationJobBlockingReason | null;
}

/** §7.2 V6's read-time liveness of an integration claim, derived from the row and never stored. */
export type IntegrationJobLiveness = 'LIVE' | 'QUIET' | 'SILENT' | 'LEASE_EXPIRED' | 'LEGACY';

/** The check a v2 claim is running, as its progress reports name it (§2.2 J-T4). The job row's
 *  `checks` holds finished results in a different shape. */
export interface ProjectIntegrationCheck<Instant = string> {
  name: 'TASK_ACCEPTANCE' | 'MERGE_CHECK';
  /** Position of this check in the run, from 1, and how many the run has in all. */
  index: number;
  count: number;
  budgetSeconds: number;
  startedAt: Instant;
}

/**
 * The most rounds one claim of a `LAND_TASK` can run: the M of "round N of M" (§7.2 V6). The first
 * round plus up to two refetches when the push loses a race (contract J5, appendix A-Q5; runner-go
 * `integrate.go` `integrationRefetchRounds + 1`). `LAND_PROMOTION` and `CHECK_PROMOTION` have one
 * round and write no M. A check's `count` is how many checks the run has, never this number.
 */
export const LAND_TASK_ROUNDS_PER_CLAIM = 3;

/**
 * One RUNNING or QUEUED job on the project's integration view (`inFlightJobs`, §1.6).
 *
 * `timedOut` is decided where the job is read, never stored: a running job whose runner has said
 * nothing for longer than `limitSeconds`. The limit is the claim lease for a git step, and the job's
 * check budgets plus the lease while it checks — the runner reports only when a step starts, so a
 * healthy check is silent for as long as it runs. A timed-out job is still RUNNING; only a retry
 * ends it (§2.2 J-T9).
 */
export interface ProjectIntegrationJob<Instant = string> {
  jobId: string;
  kind: IntegrationJobKind;
  state: 'RUNNING' | 'QUEUED';
  /** The step it last reported, or the one a claim starts at; null before its first claim. */
  phase: IntegrationJobPhase | null;
  /** The task it lands; null for a promotion or a merge check, which land no single task. */
  taskId: string | null;
  taskTitle: string | null;
  /** The candidate a promotion job checks or lands; null for a task landing. Absent on servers
   *  that predate the field. */
  promotionId?: string | null;
  /** Which landing of its subject this is, counting from 1. */
  generation: number;
  /** What "for how long" counts from, as on `inFlight`: the claim, or the enqueue. */
  startedAt: Instant;
  /** When it joined the queue — for a retried job, when the retry was asked for. */
  queuedAt: Instant;
  /** Its runner's last report; null before its first claim. */
  heartbeatAt: Instant | null;
  /** The runner holding the claim; null while queued, or when that runner is gone. */
  runnerName: string | null;
  /** Who asked for this run when it reruns a failed or timed-out one; null for an ordinary landing. */
  retriedBy: 'OWNER' | 'COORDINATOR' | null;
  timedOut: boolean;
  /** How long the current step may go without a report; null while queued. */
  limitSeconds: number | null;
  /** The protocol this job's current claim was written with (§2.2 J-T4): `'v2'` for a runner that
   *  reports periodically, null for a legacy claim that only reports at step boundaries. Absent
   *  from a server older than the field. */
  progressProtocol?: string | null;
  /** The claim generation the job is on: 0 before its first claim, one more per takeover. Absent
   *  from a server older than the field. */
  claim?: number;
  /** The round inside the current claim, from 1, as the v2 reports name it; null before one. */
  round?: number | null;
  /** The check in flight under a v2 claim; null between checks and for a legacy claim. */
  check?: ProjectIntegrationCheck<Instant> | null;
  /** When the current step began (§7.2 V6's main clock); null on a legacy claim, which reports
   *  only that a step started, and on a server that predates the column. */
  stepStartedAt?: Instant | null;
  /** When the current step's output last moved; null when no report measured it. */
  outputMovedAt?: Instant | null;
  /** How long this project's successful runs of the current MERGE_CHECK usually take; null for
   *  every other check, and until there is a successful run to measure (§7.2 V6). */
  typicalMs?: number | null;
  /** §7.2 V6's read-time liveness; null for a job waiting its turn, which has no claim to judge.
   *  `LEASE_EXPIRED` is the same fact as `timedOut`. */
  liveness?: IntegrationJobLiveness | null;
  /** Why a queued job is not claimed, or why a claimed one waits on this runner's local lock. */
  blockingReason?: IntegrationJobBlockingReason | null;
  /** The landing session this job belongs to (§2.9). Absent until a server fills the slot. */
  landingSessionId?: string | null;
  /** Whether the owner's Retry (`POST /projects/:id/integration/jobs/:jobId/retry`) takes this job
   *  now. Clients draw the button from this rather than from `timedOut`, so which timed-out jobs a
   *  retry can end is the server's to say. */
  retryable: boolean;
}

// ── The landing session's view (contract §2.9 LS1, LS6) ─────────────────────────────────────────

/** One finished check of the current attempt: `{ name, command, expectedExitCode, exitCode,
 *  timedOut, durationMs, outputTail }`, the runner's own result shape. Read as data — the landing
 *  view carries it through without re-typing what the runner reports. */
export type LandingCheckResult = Record<string, unknown>;

/** The newest attempt of a landing subject, as its session's page draws it. */
export interface SessionLandingAttempt<Instant = string> {
  jobId: string;
  kind: IntegrationJobKind;
  /** QUEUED | RUNNING | READY | CONFIRMED | MERGED | DECLINED | CANCELLED | ERROR | … */
  state: string;
  /** Which landing of its subject this attempt is, counting from 1. */
  generation: number;
  phase: IntegrationJobPhase | null;
  /** The round inside the current claim, from 1; null before one was reported. */
  round: number | null;
  step: string | null;
  /** The claim generation: 0 before the first claim, one more per takeover. */
  claim: number;
  runnerName: string | null;
  /** The work session this attempt is about, when that row still exists. NULL once it was purged:
   *  `job.session_id` is a history reference with no relation (0424), so a gone source reads null
   *  rather than failing the read. */
  sourceSessionId: string | null;
  /** The branch the attempt writes, as the job froze it. */
  targetRef: string;
  startedAt: Instant;
  heartbeatAt: Instant | null;
  outputMovedAt: Instant | null;
  progressProtocol: string | null;
  /** The check in flight under a v2 claim; null between checks and for a legacy claim. */
  check: ProjectIntegrationCheck<Instant> | null;
  /** §7.2 V6's liveness, read at the moment this view was built; null while queued. */
  liveness: IntegrationJobLiveness | null;
  /** Why it waits, or where it stopped. */
  blockingReason: IntegrationJobBlockingReason | null;
  timedOut: boolean;
  limitSeconds: number | null;
  /** Whether the owner's Retry (`POST /projects/:id/integration/jobs/:jobId/retry`) takes this
   *  attempt now — the server's answer, never inferred from `timedOut` (§7.2 V6). False for a job
   *  that is not in flight and for every kind but `LAND_TASK`, which is the only kind that door
   *  reruns. */
  retryable?: boolean;
  /** Whether the current claim is past the push boundary (§2.2 J-T4): a v2 claim's
   *  `push_reported_generation = claim_generation`, or a legacy claim whose phase is PUSH/VERIFY.
   *  A stop or cancel is refused past it; the landing page hides those doors on this fact. */
  pushBoundaryPassed?: boolean;
}

/** One entry of the landing's todo list: an OPEN integration item of its project. The item's own
 *  card is where it is answered; the landing only lists it. */
export interface SessionLandingTodo<Instant = string> {
  id: string;
  kind: string;
  state: string;
  title: string;
  waitingSince: Instant;
}

/** One generation (segment/round) of the landing subject. `sessionId` is the landing session's id —
 *  pre-generated when the subject opened, whether or not its row exists yet. */
export interface SessionLandingGeneration<Instant = string> {
  sessionId: string;
  episode: number;
  openedAt: Instant;
  settledAt: Instant | null;
  settledAs: string | null;
}

// ── the landing timeline (contract §2.9 LS2, LS4) ──────────────────────────────────────────────

/** The closed set of facts an attempt records (migration 0438's CHECK, spelled in
 *  `projects/project-integration-event.ts`). Each one is written by the door that decided it, in
 *  the same transaction as the job-gate write it describes; the two claim facts are backfilled from
 *  the committed claim right after it (LS2). */
export type IntegrationJobEventKind =
  | 'ENQUEUED'
  | 'STEP'
  | 'ROUND'
  | 'CHECK_STARTED'
  | 'CHECK_FINISHED'
  | 'CLAIMED'
  | 'TAKEN_OVER'
  | 'RELEASED'
  | 'PUSH_REFUSED'
  | 'RECHECK_ON_MOVED_MAIN'
  | 'NEXT_GENERATION'
  | 'RESULT'
  | 'REQUEUED'
  | 'HANDED_TO'
  | 'STOP_REQUESTED'
  | 'CANCELLED'
  | 'ABANDONED'
  | 'TIMED_OUT';

/** A line read-time derived from another row rather than stored as its own event (LS4): a rerun's
 *  requester and reason (`retry_*`), an item being handled (`handling_*`), the owner's
 *  confirmation, the skipped check, a timeout the job row alone cannot explain, the Nth automatic
 *  attempt, and the task a fix was filed as. */
export type DerivedTimelineKind =
  | 'RETRY'
  | 'SKIPPED_CHECK'
  | 'HANDLING'
  | 'CONFIRMATION'
  | 'RESULT_FALLBACK'
  | 'AUTOMATIC_ATTEMPT'
  | 'FIX_TASK';

/** Who caused a timeline line. */
export interface IntegrationTimelineActor {
  type: 'OWNER' | 'COORDINATOR' | 'PLATFORM' | 'RUNNER' | 'AUTOMATIC';
  /** The conversation that acted, when a coordinator did. */
  sessionId?: string | null;
  /** The person that acted, when the owner did. */
  userId?: string | null;
}

/**
 * One line of the landing timeline, as `GET /sessions/:id` and the runner read serve it.
 *
 * `text` is the whole sentence, written by the server (mockup v4 §05's wording); `data` carries the
 * structured fields the same line is drawn with. A client lays the line out and never composes one
 * from the fields — which is what keeps the three clients saying the same thing. `id` is the event
 * row's id, and null for a line derived at read time from another row whose decision this ledger
 * does not copy (LS4).
 */
export interface IntegrationTimelineEntry<Instant = string> {
  id: string | null;
  /** The ledger's own order, for a stored fact; absent on a derived line. Two facts one transaction
   *  appends share the same `at`, and this is what orders them. */
  seq?: number;
  /** An `IntegrationJobEventKind`, or one of `DerivedTimelineKind`. */
  kind: IntegrationJobEventKind | DerivedTimelineKind;
  at: Instant;
  /** The claim the fact happened under; 0 before the first claim. */
  claim: number;
  round: number | null;
  check: { name: 'TASK_ACCEPTANCE' | 'MERGE_CHECK'; index: number } | null;
  phase: IntegrationJobPhase | null;
  step: string | null;
  actor: IntegrationTimelineActor | null;
  reason: string | null;
  /** Structured fields the line is drawn with: the moved commits, the item handed to, a timeout's
   *  limit, the job a rerun repeats, the automatic attempt's count. */
  data: Record<string, unknown> | null;
  text: string;
  /** True for a line derived from another row at read time; absent for a stored fact. */
  derived?: boolean;
}

/** One section of the timeline: a task landing's generation, or one merge round's attempt.
 *  `title` is the server-written heading (`Generation 1`, `Merge check · 2`, `Merge to main · 1`);
 *  `generation` is the section's number among the subject's attempts of its kind, which is the
 *  number the title carries — not the job's own per-candidate generation. */
export interface IntegrationTimelineSection<Instant = string> {
  title: string;
  jobId: string;
  kind: IntegrationJobKind;
  generation: number;
  state: string;
  /** Oldest first: by claim, then by round, then by the instant the fact happened. */
  entries: IntegrationTimelineEntry<Instant>[];
}

/** A subject-level derived fact that belongs to no one attempt (a fix task, the promotion state). */
export interface IntegrationTimelineFact {
  kind: DerivedTimelineKind | 'PROMOTION_STATE';
  text: string;
  data: Record<string, unknown> | null;
}

/** The landing subject's whole timeline: one section per attempt, oldest first. */
export interface SessionLandingTimeline<Instant = string> {
  sections: IntegrationTimelineSection<Instant>[];
  facts: IntegrationTimelineFact[];
  /** True when the subject had more attempts or entries than the read returns. */
  truncated: boolean;
}

/** One page of one attempt's timeline, as the runner read's `timeline` slot serves it. */
export interface IntegrationTimelinePage<Instant = string> {
  jobId: string;
  entries: IntegrationTimelineEntry<Instant>[];
  nextCursor: string | null;
}

/**
 * The landing view `GET /sessions/:id` and `session_get` answer for a LANDING session (contract
 * §2.9 LS1, LS6; errata E4): the subject, its newest attempt, the phase/round/checks/activity the
 * attempt reports, why it is blocked, its OPEN todos, and every generation of the subject.
 *
 * The session row may not exist yet — the row is inserted after the first claim commits — so the
 * same view is reachable through `project_landing.session_id` from the moment the subject opens.
 * The timeline and the per-check output are later readers on top of this one, which is why neither
 * is part of it yet.
 */
export interface SessionLandingView<Instant = string> {
  /** The LANDING session's id: `project_landing.session_id`, pre-generated. */
  sessionId: string;
  projectId: string;
  subject: 'TASK' | 'PROMOTION';
  taskId: string | null;
  promotionId: string | null;
  episode: number;
  openedAt: Instant;
  settledAt: Instant | null;
  /** LANDED | ALREADY_LANDED | NOTHING_TO_LAND | MERGED | HANDLED | DECLINED | CANCELLED | DELETED,
   *  or null while the subject is open. */
  settledAs: string | null;
  /** The newest attempt's phase and round, lifted so a card can draw them without reaching into it. */
  phase: IntegrationJobPhase | null;
  round: number | null;
  /** The newest attempt's finished check results (runner shape), `[]` when it has none. */
  checks: LandingCheckResult[];
  liveness: IntegrationJobLiveness | null;
  blockingReason: IntegrationJobBlockingReason | null;
  /** The newest attempt of the subject, whatever its state; null for a subject no attempt claimed. */
  currentAttempt: SessionLandingAttempt<Instant> | null;
  /** The subject's integration items still OPEN, oldest first. */
  todos: SessionLandingTodo<Instant>[];
  /** Every generation of the subject, oldest first. */
  generations: SessionLandingGeneration<Instant>[];
  /** The ordered timeline the landing page draws (§2.9 LS2/LS4): one section per attempt, with
   *  the stored facts each one recorded and the lines derived from the rows that kept the
   *  decisions. Read-only, and bounded — `truncated` says the read returned less than the subject
   *  holds. Absent on servers that predate the timeline (contract §2.9: a new field is optional). */
  timeline?: SessionLandingTimeline<Instant>;
}

/**
 * One generation of an integration job, as the agent read port lists it (contract §2.2 J-T3, §2.9
 * LS6): the queue's entry for an attempt still in flight, each task's newest `LAND_TASK`, and each
 * merge candidate's newest check and merge. It is the job row's own facts — never a conclusion drawn
 * from the task's status or from whether an exception card exists.
 *
 * A generation is what the coordinator needs to answer "which attempt is this, how far did it get,
 * and what stopped it": `generation` is the attempt's number, `round` the round inside its current
 * claim, and `check` the check that was running when it last reported. `blockingReason` is present
 * where the row is in a state a reason is read for — a queued attempt, or a `LAND_TASK` that stopped.
 */
export interface IntegrationJobGeneration<Instant = string> {
  jobId: string;
  kind: IntegrationJobKind;
  generation: number;
  state: IntegrationJobState;
  /** The landing session of this attempt's subject (§2.9), as `landTasks` and the queue carry it;
   *  null for a job written before 0436. Absent from a server that predates the field. */
  landingSessionId?: string | null;
  /** The step it last reported, or stopped at; null before its first claim. */
  phase: IntegrationJobPhase | null;
  /** Why it ended as an error (contract J12); null unless `state` is `ERROR`. */
  errorCode: string | null;
  /** The task it lands; null for a promotion job, which lands no single task. */
  taskId: string | null;
  /** The task's title as the row can still name it; null for a promotion or a task since deleted. */
  taskTitle: string | null;
  /** The merge candidate it checks or lands; null for a task landing. */
  promotionId: string | null;
  /** The round inside the current claim, from 1; null before a v2 report named one. */
  round: number | null;
  /** The check in flight, or the one it stopped at; null between checks and for a legacy claim. */
  check: ProjectIntegrationCheck<Instant> | null;
  /** Why it waits or where it stopped, in the one shape every reader uses. */
  blockingReason: IntegrationJobBlockingReason | null;
  /** Enqueue, first claim, the claimer's latest report, and the terminal write. */
  queuedAt: Instant;
  startedAt: Instant | null;
  heartbeatAt: Instant | null;
  finishedAt: Instant | null;
}

/**
 * One merge candidate as the agent read port lists it (§3.2, §3.6): the candidate's own state and
 * recorded checks, the newest `CHECK_PROMOTION` and `LAND_PROMOTION` generations, and the merge when
 * there was one.
 *
 * Which candidates appear is bounded like `landTasks`: the live ones (a card or a check in flight),
 * the blocked ones, and the one merged last — never the project's merge history.
 */
export interface ProjectPromotionIntegrationRead<Instant = string> {
  promotionId: string;
  sourceKind: PromotionSourceKind;
  sourceRef: string;
  upstreamRef: string;
  state: PromotionState;
  /** Why the candidate is blocked, when it is; null otherwise. */
  blockedReason: PromotionBlockedReason | null;
  /** The checks the candidate's last attempt recorded (§3.6). */
  checks: IntegrationCheckResult[];
  /** The merge, once it happened; null on every candidate that did not land. */
  merged: {
    sha: string;
    at: Instant;
    /** Nobody pressed Merge: the project's Automatic setting confirmed it (M-T11). */
    automatic: boolean;
    /** The account owner who pressed Merge, or null when it was Automatic. */
    byUserId: string | null;
  } | null;
  /** The newest `CHECK_PROMOTION` generation, or null when the candidate never had one. */
  check: IntegrationJobGeneration<Instant> | null;
  /** The newest `LAND_PROMOTION` generation, or null when the merge has not been attempted. */
  land: IntegrationJobGeneration<Instant> | null;
}

/**
 * The slots the integration read pages its timeline and check log by (contract §2.2 J-T4, §2.9
 * LS6). Revision 12 reserves them on the read now, before the timeline and log rows exist, so a
 * caller that learns to pass them does not have to change when those reads are added: `jobId`
 * names the attempt, `claim` its claim generation, `round` the round inside it, `check` the check's
 * position, and `cursor` continues a page. Each is null when the request did not name it.
 */
export interface ProjectIntegrationReadPagination {
  jobId: string | null;
  claim: number | null;
  round: number | null;
  check: number | null;
  cursor: string | null;
  /** The attempt timeline's own continuation, when the request passed one (`timelineCursor`); the
   *  log and the timeline are paged independently. Absent on servers that predate the timeline. */
  timelineCursor?: string | null;
}

/**
 * One stored chunk of a check's output (contract §2.2 J-T4's output route, §2.9 LS2), as the log
 * reads return it. `truncatedBytes` is non-zero only where the server dropped a middle: the reader
 * draws one "N bytes omitted" line immediately before this chunk and nothing else.
 */
export interface ProjectIntegrationLogEntry<Instant = string> {
  jobId: string;
  /** The claim generation the chunk was uploaded under. */
  claim: number;
  /** The round inside that claim. */
  round: number;
  check: IntegrationJobOutputCheck;
  /** The chunk's number within this check, from 0. */
  seq: number;
  /** The chunk's text, already redacted by the runner. */
  text: string;
  /** Bytes dropped from the middle immediately before this chunk; 0 elsewhere. */
  truncatedBytes: number;
  at: Instant;
}

/**
 * One page of a check's output, as `GET /sessions/:id/landing/log` and the runner read's `log` slot
 * serve it. Entries are in production order — claim, then round, then check position, then seq — and
 * `nextCursor` continues the same narrowed read.
 */
export interface ProjectIntegrationLogPage<Instant = string> {
  /** The job the page is about; null when the landing has no attempt yet. */
  jobId: string | null;
  entries: ProjectIntegrationLogEntry<Instant>[];
  nextCursor: string | null;
}

/**
 * `GET /runner/projects/:id/integration` — the agent's read of a project's integration line
 * (`project_integration_get`, contract §2.2 J-T4, §2.9 LS6).
 *
 * Read only, and the one door an agent has onto the queue itself: before it, a coordinator that
 * needed to know why a landing was stuck either read the project summary, which says nothing about
 * generations, or queried the production database directly, which is not an interface. Every part
 * is bounded by the queue and by what failed rather than by the project's history.
 *
 * `queue` is every QUEUED and RUNNING job — all three kinds — in `inFlightJobs`' order (running
 * first, then the queue oldest first). `generations` says where each current attempt stands.
 * `landTasks` is each task's newest `LAND_TASK` through the same read model the task page uses, and
 * `promotions` is each live, blocked or last-merged candidate's newest check and merge.
 */
export interface ProjectIntegrationRead<Instant = string> {
  projectId: string;
  projectTitle: string;
  /** The line's settings: where work lands, the merge check, and how long a wait is a person's. */
  line: ProjectIntegrationSettings<Instant>;
  /** Every QUEUED and RUNNING job, in `inFlightJobs`' order. */
  queue: ProjectIntegrationJob<Instant>[];
  /** Where each current attempt stands: the queue, each task's newest landing, each candidate's jobs. */
  generations: IntegrationJobGeneration<Instant>[];
  /** Each task's newest `LAND_TASK`, bounded by the queue and by what stopped. */
  landTasks: ProjectLandTask<Instant>[];
  /** Each live, blocked or last-merged candidate, with its newest check and merge. */
  promotions: ProjectPromotionIntegrationRead<Instant>[];
  /** The timeline and log page slots, echoed as the read resolved them. */
  pagination: ProjectIntegrationReadPagination;
  /** The check output of the job the request named by `jobId`; absent when it named none, so a
   *  caller that only wants the line reads the shape it always did. */
  log?: ProjectIntegrationLogPage<Instant> | null;
  /** One attempt's timeline, paged by the selectors a caller already passes (`jobId` names the
   *  attempt, `claim` and `round` narrow it, `timelineCursor` continues it — its own cursor, so the
   *  log and the timeline of one attempt are paged independently). Absent when the request named
   *  no `jobId`, like the log. */
  timeline?: IntegrationTimelinePage<Instant> | null;
}

/** The integration claim's existing lease window, also used to stop stale activity indicators. */
export const INTEGRATION_CLAIM_STALE_MS = 10 * 60 * 1_000;

/** All ready OPEN tasks with neither automatic dispatch nor a schedule, and one task to open. */
export interface ProjectManualReady {
  count: number;
  taskId: string;
  title: string;
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

/**
 * Why a task's current `LAND_TASK` is waiting, or why it stopped (§2.7a). The server reads it from
 * the same conditions the claim reads, in the claim's order; a client renders it and never derives
 * one from the task's status or from whether an exception card exists.
 *
 *  - `CANCELLING`: a historical QUEUED row still carrying a stop request, which no claim takes.
 *    J-T8 ends a queued job CANCELLED in the transaction that asks, so rows written since then
 *    never read this way.
 *  - `WAITING_TASK_WORK`: the task's work session has not finished, so its branch can still move.
 *  - `WAITING_MAIN_SYNC`: another task's landing could not absorb upstream into this target, and
 *    its item is still open (M2) — the project line has to be synced first.
 *  - `WAITING_RUNNER`: the runner of the work's workspace is offline, silent, draining, has no
 *    heartbeat lease or does not take integration jobs.
 *  - `WAITING_AUTOMATIC_RUNNER`: the merge was confirmed by the Automatic setting, and the runner
 *    that would claim it does not declare `promotion-automatic-land/v1` (M-T12).
 *  - `WAITING_SERIAL_SLOT`: another job is running on the same repository and target branch.
 *  - `WAITING_DISPATCH`: nothing holds it; the next heartbeat of that runner claims it.
 *  - `WAITING_LOCAL_LOCK`: a claimed job is waiting for this runner's own repository lock — a v2
 *    claim reporting `step = WAITING_LOCAL_LOCK`, or a legacy claim whose runner already has an
 *    earlier job on the same repository and target branch.
 *  - `CONFLICT` / `CHECK_FAILED` / `ERROR`: where a finished attempt stopped.
 *
 * A stopped attempt is not named here: a QUEUED job somebody cancels is ended CANCELLED in the
 * transaction that asks (J-T8), so no queued row waits on a cancellation.
 */
export type LandTaskBlockingReasonCode =
  | 'CANCELLING' | 'WAITING_TASK_WORK' | 'WAITING_MAIN_SYNC' | 'WAITING_RUNNER'
  | 'WAITING_AUTOMATIC_RUNNER' | 'WAITING_SERIAL_SLOT' | 'WAITING_DISPATCH'
  | 'WAITING_LOCAL_LOCK' | 'CONFLICT' | 'CHECK_FAILED' | 'ERROR';

/** Why any integration job — of any of the three kinds — waits or where it stopped. The shape
 *  `landTask.blockingReason` has always used, carried on `inFlightJobs` entries as well (§7.2 V6). */
export type IntegrationJobBlockingReason = LandTaskBlockingReason;

/**
 * A task's newest `LAND_TASK` generation, as its own job row says it (§2.7a). Kept apart from the
 * receipt-first `TaskIntegrationView.state`: a receipt still says where the work IS, and this says
 * what the platform is doing with the newest attempt — which is how a task can read "on main" and
 * "generation 3 queued" at once without either overwriting the other.
 */
export interface LandTaskIntegrationView<Instant = string> {
  jobId: string;
  state: IntegrationJobState;
  /**
   * The landing session this generation belongs to (§2.9): `project_landing.session_id`, which is
   * pre-generated when the subject opens, so it is present even before the session row is inserted
   * and even when the job's own source session has since been deleted (0424: `session_id` is a
   * history reference). `session_get` serves that session's landing view by this id. Null when the
   * attempt has no subject (a job written before 0436); absent from a server that predates the field.
   */
  landingSessionId?: string | null;
  /** The runner's step, or the one the attempt stopped at; null before its first report. */
  phase: IntegrationJobPhase | null;
  /** Why the attempt ended as an error (contract J12), null unless `state` is `ERROR`. Absent from a
   *  server that predates it. */
  errorCode?: string | null;
  /** A decimal string, as every 64-bit counter crosses this API. */
  generation: string;
  /** Enqueue, first claim, the claimer's latest heartbeat, and the terminal write. */
  queuedAt: Instant;
  startedAt: Instant | null;
  heartbeatAt: Instant | null;
  finishedAt: Instant | null;
  /** The full ref the job froze at enqueue, e.g. `refs/heads/project/<id>`. */
  targetRef: string;
  /** Time in the queue: up to the first claim, or to the terminal write of one never claimed;
   *  still counting while it is queued. */
  waitMs: number;
  blockingReason: LandTaskBlockingReason | null;
}

export interface LandTaskBlockingReason {
  code: LandTaskBlockingReasonCode;
  /** One sentence a page prints as it is. */
  summary: string;
  /** The job holding it: the running one for a serial wait, the conflicted one for a sync wait. */
  jobId?: string;
  /** The open MAIN_SYNC conflict item a sync wait is waiting on. */
  openItemId?: string;
}

/** One task's integration, as the project page's task rows read it (§2.7, §7.3 V10). */
export interface TaskIntegrationView<Instant = string> {
  state: TaskIntegrationState;
  /** When the task entered this state. */
  since: Instant | null;
  handler: TaskIntegrationHandler | null;
  openItemId: string | null;
  jobId: string | null;
  /** Elapsed job time while it is in CHECK; not the duration of the check phase itself. */
  checksRunningForMs: number | null;
  /** Null when no LAND_TASK exists; absent only on servers predating the unified read model. */
  landTask?: LandTaskIntegrationView<Instant> | null;
  /**
   * The project's main branch by name — `project_codebase.upstream_ref` without `refs/heads/` — that
   * `ON_UPSTREAM` is on. Null when the task is in no project or its project has no repository
   * bound. Absent from an older server.
   */
  mainBranch?: string | null;
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

/**
 * What opened an exception item, as §4.2's closed set spells it — and `START_REQUEST`, a
 * coordinator asking its owner to start the project (`project_request_start`, `project-start.ts`),
 * and `DONE_REQUEST`, one asking its owner to record the project done (`project-done.ts`), plus
 * `DELIVERY_REVIEW`, a finished delivery whose landing needs a bounded decision, and
 * `LANDING_LEASE_EXPIRED`, the owner's item about a landing attempt whose runner stopped reporting
 * (§4.6 X-E5).
 * The set is closed in the database too (`project_open_item_kind_chk`): a new kind is a migration.
 */
export type OpenItemKind =
  | 'INTEGRATION_CONFLICT'
  | 'INTEGRATION_CHECK_FAILED'
  | 'INTEGRATION_ERROR'
  | 'TASK_FAILED'
  | 'PROMOTION_APPROVAL'
  | 'COORDINATOR_QUESTION'
  | 'FUSE_PAUSED'
  | 'START_REQUEST'
  | 'DONE_REQUEST'
  | 'DELIVERY_REVIEW'
  | 'LANDING_LEASE_EXPIRED';

/**
 * The kinds a project's coordinator can be handling (§7.1 V1/V2): `OpenItemKind` minus the owner-only
 * that are the owner's from birth.
 *
 * A merge approval, a question to the owner, a pause and a request to start are asked OF the owner
 * and never worked BY the coordinator, so an item whose assignee is the coordinator is one of these
 * four — which is what lets the list row's blue chip be a `Record` over this type rather than a
 * switch with a branch for a state that cannot happen. A kind that later becomes returnable to the coordinator
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
  'DELIVERY_REVIEW',
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
  | 'ANSWER'
  | 'OPEN_LANDING'
  /** §4.7 J-T10: end a landing attempt whose runner stopped reporting. Owner-only. */
  | 'ABANDON';

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
  /** The paths a conflicting merge could not reconcile, or a delivery review is about. */
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
  /** The landing question and the declaration used for a DELIVERY_REVIEW item. */
  review?: {
    reason: 'CRITERION_EXEMPTION_ARGUED' | 'OUTSIDE_DECLARED_SCOPE' | 'MERGE_REFUSED_BY_GIT';
    declaredPaths: string[];
    /** The task's written reason for keeping its completion criterion (CRITERION_EXEMPTION_ARGUED). */
    argument?: string;
  } | null;
}

/**
 * The coordinator's rerun of the failure an item is about, while that rerun is still in flight
 * (§4.7 H1): the item is being handled, not closed. It stays OPEN until the job the rerun queued
 * reaches a terminal state, because the rerun can still fail — and a card that said "handled" before
 * then would be saying something nobody knows yet.
 */
export interface OpenItemHandling<Instant = string> {
  /** The coordinator conversation that asked for the rerun, or null when the owner did. */
  sessionId: string | null;
  /** The account owner that asked for the rerun, or null when the coordinator did. */
  userId: string | null;
  /** Why it said the rerun would come out differently, as it said it. */
  reason: string;
  startedAt: Instant;
  /** The job the rerun queued: a task's next landing, or a blocked candidate's next check. */
  jobId: string;
  jobKind: 'LAND_TASK' | 'CHECK_PROMOTION';
  generation: number;
  /** Where that job is: waiting for its turn, or running on a runner. */
  state: 'QUEUED' | 'RUNNING';
}

/**
 * How an item the coordinator handled ended (§4.7 H2–H4) — the audit a closed card is drawn from.
 *
 * `HANDLED` is the coordinator's rerun landing (a task's) or passing its check (a candidate's), or
 * the coordinator closing the item with a reason; `RETRIED` is its rerun failing again, which closes
 * this item SUPERSEDED and opens a new one for the new failure — so a failure is never closed without
 * another item saying it happened.
 */
export interface OpenItemOutcome<Instant = string> {
  state: 'RESOLVED' | 'SUPERSEDED';
  resolution: 'HANDLED' | 'RETRIED';
  resolvedBy: 'COORDINATOR' | 'USER';
  /** The coordinator conversation it is attributed to, when a coordinator asked. */
  resolvedBySessionId: string | null;
  /** The account owner it is attributed to, when the owner asked. */
  resolvedByUserId: string | null;
  resolvedAt: Instant;
  /** The reason the coordinator gave — for its rerun, or for closing the item by hand. */
  note: string | null;
  /** The job whose terminal state ended the item; null when the coordinator closed it by hand. */
  jobId: string | null;
  /** The item that took this one's place, when the rerun failed again. */
  supersededByItemId: string | null;
}

/**
 * Where an item's handling stands right now, in one word (§4.7): what a card says beside its
 * "Chat about this", and what the coordinator is told along with the message that press carries.
 *
 * `HANDLING` while the coordinator's rerun of it is queued or running (H1); `WITH_COORDINATOR` while
 * it waits for the coordinator to act on it; `WITH_OWNER` while it is the account owner's — from
 * birth, or because it became theirs (§4.1); `HANDLED` and `SUPERSEDED` once the coordinator's
 * handling ended it (H2, H3).
 */
export type OpenItemStage =
  | 'HANDLING'
  | 'WITH_COORDINATOR'
  | 'WITH_OWNER'
  | 'HANDLED'
  | 'SUPERSEDED';

/**
 * Why "Chat about this" cannot be had for an item, when it cannot.
 *
 * `NO_COORDINATOR`: the project has no coordinator conversation to hold it. `COORDINATOR_UNAVAILABLE`:
 * it has one, and that conversation cannot take a message now — in Trash, ending, or ended with
 * nothing to resume (the same answer every session payload publishes as `canSend`).
 * `SUPERSEDED`: a failed rerun replaced the item with a new one, and that one is what a chat about
 * the failure is about.
 */
export type OpenItemChatRefusal = 'NO_COORDINATOR' | 'COORDINATOR_UNAVAILABLE' | 'SUPERSEDED';

/**
 * "Chat about this" for one item, as the server decides it (§4.8).
 *
 * A message to the project's coordinator conversation and nothing else: it presses no door, so it is
 * offered whoever holds the item, and refused only where there is nowhere for the message to go or
 * where it would be about the wrong item. What the doors on the same card may do is still `actions`,
 * decided as before.
 */
export interface OpenItemChat {
  /** The project's coordinator conversation — where the chat is held. Null when there is none. */
  sessionId: string | null;
  stage: OpenItemStage;
  /** Null when the chat can be had; otherwise why it cannot. */
  refusal: OpenItemChatRefusal | null;
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
  /** Tasks filed as concrete fixes for this item, newest task state included. */
  handledBy?: Array<{ taskId: string; title: string; state: string }>;
  /** The attempt this item is about, when there is one: the run whose failure opened it. */
  sessionId: string | null;
  /**
   * The landing session of the attempt this item is about (§2.9 LS1), when the row recorded one:
   * the conversation that owns the landing whose failure opened it. `OPEN_LANDING` opens it, and
   * the transcript card links to it. Null for a row an older build opened, and for a kind that
   * lands nothing (a question, a pause, a start request).
   */
  landingSessionId?: string | null;
  /**
   * The landing attempt an X-E5 item is about (§4.6): the integration job whose claim stopped
   * reporting, as the job row's UUID (the response body carries the base62 twin beside it as
   * `integrationJobPublicId`, common/public-id-body.ts). `ABANDON` names that job in its route,
   * which takes either spelling, so a client drawing this row's doors needs it. Null for every
   * other kind, and absent from a server that predates it.
   */
  integrationJobId?: string | null;
  /**
   * The claim an X-E5 item is about, as the card's heading and its Abandon consequence read it
   * (§4.6, revision 23): the last report the runner made — the heading's "<N>m" counts from it —
   * and J12's two facts, the claim's protocol and whether it ever recorded a push. Null on every
   * other kind, and absent from a server that predates it. A card that does not know them says the
   * cautious half of J12 ("it may have been pushed") and leaves the heading's number out — never
   * that nothing was pushed.
   */
  lease?: {
    lastReportAt: Instant | null;
    /** When the claim's lease ran out — the last report plus the step's limit (§7.2 V6). */
    leaseExpiredAt?: Instant | null;
    /** `LAND_TASK`, `CHECK_PROMOTION` or `LAND_PROMOTION`: J12's verdict branches on it. */
    jobKind: string | null;
    /** Which generation of the work the claim was on. */
    generation?: number | null;
    /** The step the runner last reported, and its sub-step. */
    phase?: string | null;
    step?: string | null;
    /** The claim the job is on, the round inside it, and how many checks the run has (`checkCount`
     *  is not the M of "round N of M", which comes from `jobKind`: §7.2 V6). */
    claimGeneration?: number | null;
    round?: number | null;
    checkCount?: number | null;
    /** The runner holding the claim, by name. */
    runner?: string | null;
    progressProtocol: string | null;
    pushReported: boolean;
  } | null;
  promotionId: string | null;
  fuseEpisodeId: string | null;
  delivery: { state: OpenItemDeliveryState; sessionId: string | null; at: Instant | null };
  actions: OpenItemAction[];
  /** The server's one-sentence answer to "what must happen next". Optional for rolling deploys. */
  requiredAction?: string;
  /** The first executable door for the item, when the server can name one. */
  primaryAction?: OpenItemAction;
  /** Present for a `COORDINATOR_QUESTION` and null for every other kind. */
  question: CoordinatorQuestion | null;
  /** The request a `START_REQUEST` carries — what the "Start this project?" card is drawn from —
   *  and null for every other kind. Absent from a server that predates start requests. */
  startRequest?: ProjectStartRequest | null;
  /** The request a `DONE_REQUEST` carries — what the "Is this project done?" card is drawn from —
   *  and null for every other kind. Absent from a server that predates done requests. */
  doneRequest?: DoneRequest | null;
  /** What the item's payload holds, as the rows its card draws; null when the payload is not a
   *  shape this build reads — an item an older build opened, a pause, a question — and the card
   *  then draws what it drew before this existed. */
  facts: OpenItemFacts | null;
  /** The coordinator's rerun of it while that rerun is in flight, or null. Absent from a server
   *  that predates it. */
  handling?: OpenItemHandling<Instant> | null;
  /** How it ended — only on a row of `settled`, and null on every open one. */
  outcome?: OpenItemOutcome<Instant> | null;
  /** The coordinator's explanation when it deliberately handed the item to the owner. */
  handoverNote?: string | null;
  /** "Chat about this": where the item's handling stands, and whether a message about it can reach
   *  the project's coordinator conversation. Absent from a server that predates it. */
  chat?: OpenItemChat | null;
}

/**
 * A question the coordinator put to the owner that has ended (§5.2 R10, R12): the owner answered
 * it, or it was withdrawn. The card the conversation drew for it is drawn as this record — the
 * question as it was asked, every option, what the owner chose and wrote, and where the answer went —
 * so it survives a relaunch and reads the same on a device that never saw the question open.
 */
export interface ProjectClosedQuestion<Instant = string> {
  itemId: string;
  /** The question as it was asked: the same shape as an open row's `question`. */
  question: CoordinatorQuestion;
  /** When the coordinator asked it. */
  askedAt: Instant;
  resolution: 'ANSWERED' | 'WITHDRAWN';
  /** Who ended it: the owner (`USER`), or the conversation that asked it (`COORDINATOR`). */
  resolvedBy: 'USER' | 'COORDINATOR';
  /** When it was answered or withdrawn — the moment the record is drawn at. */
  resolvedAt: Instant;
  /** What the owner answered: an option's index, their own words, or both. Null when withdrawn. */
  answer: { option: number | null; text: string | null } | null;
  /** The first coordinator conversation the answer was delivered to, and when. Null while none has
   *  had it — no conversation was coordinating the project — and for a withdrawn question. */
  delivery: { sessionId: string; at: Instant } | null;
  /** The reason it was withdrawn with; null for an answered question. */
  withdrawReason: string | null;
}

/** The project's open exceptions, split by who is expected to act (§4.8). */
export interface ProjectOpenItemsView<Instant = string> {
  needsYou: Array<ProjectOpenItemRow<Instant>>;
  withCoordinator: Array<ProjectOpenItemRow<Instant>>;
  /**
   * The coordinator's questions that have ended — answered or withdrawn — newest first, at most 50
   * (§4.8, §5.2 R10, R12). Kept out of `needsYou`: nobody owes anything about them, and a
   * conversation draws each at the moment it ended, as the record its card became. Absent from a
   * server that predates it.
   */
  closedQuestions?: Array<ProjectClosedQuestion<Instant>>;
  /**
   * Exceptions the coordinator closed in the last day, newest first (§4.7 H5): handled — its rerun
   * landed or passed, or it closed the item with a reason — or superseded by the new item its failed
   * rerun opened. Each carries its `outcome`. Kept out of the two groups above because nobody owes
   * anything about them; a conversation draws them as the closed cards they became. Absent from a
   * server that predates it.
   */
  settled?: Array<ProjectOpenItemRow<Instant>>;
  /**
   * The coordinator's open request to start the project (`START_REQUEST`), or null — a project holds
   * at most one. Kept out of `needsYou` on purpose: a client that predates the kind draws every
   * `needsYou` row it cannot name as an exception that escalated to the owner, with nothing to press.
   * Absent from a server that predates start requests.
   */
  startRequest?: ProjectOpenItemRow<Instant> | null;
  /**
   * The coordinator's open request to record the project done (`DONE_REQUEST`), or null — a project
   * holds at most one, and it is drawn only while it still describes the project: one whose criteria,
   * tasks or landings have moved since is superseded before this is read. Kept out of `needsYou` for
   * the reason `startRequest` is. Absent from a server that predates done requests.
   */
  doneRequest?: ProjectOpenItemRow<Instant> | null;
  /**
   * The project's main branch by name — `project_codebase.upstream_ref` without `refs/heads/` — which
   * a row's merge into main is a merge into. Null when the project has no repository bound.
   */
  mainBranch?: string | null;
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
  /** The same server-derived next-step sentence served on the project row. */
  requiredAction?: string;
  /** The first executable door for the item, when one is available. */
  primaryAction?: OpenItemAction;
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
  /**
   * The landing session of the attempt this item is about (§2.9 LS1), or null for a delivery whose
   * item recorded none (a promotion's item, a kind that lands nothing, a row an older build
   * opened). The card's "Open the landing ↗" is drawn from it.
   */
  landingSessionId: string | null;
}

/**
 * What the turn telling a coordinator the owner's answer carries beside its words (§5.2 R10): the
 * answer to a question it asked (`ask_owner`), or the owner's Not yet… to its request to record the
 * project done.
 *
 * The words are written for the AGENT — `From Orbit · owner answer: you asked "…"`, the question
 * replayed in full and the answer with its ISO moment — and they stay exactly what they were: a
 * coordinator rotated in after the answer learns from them what was asked. Without this a client
 * had nothing else to draw the turn from, and drew the platform's message as a bubble the owner had
 * typed. Recorded beside the runner's echo like `OpenItemDeliveryCard`, so a client draws the turn as
 * one line — `Sent to the coordinator · 08:29`, opening to those words.
 */
export interface OwnerAnswerCard {
  /** The item answered, in the uuid spelling every other read of one uses. */
  itemId: string;
  /** What was answered: a coordinator's question, or its request to record the project done. */
  kind: Extract<OpenItemKind, 'COORDINATOR_QUESTION' | 'DONE_REQUEST'>;
  /** The conversation the answer was delivered to: the one this turn is on. */
  sessionId: string;
  /**
   * When this conversation was handed the answer — its own delivery row's moment, which for a
   * coordinator rotated in after the answer is when IT was told, not when the owner answered.
   */
  deliveredAt: string;
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
  /**
   * The settings the start left the project running with (`project-start.ts`), as it recorded
   * them. Absent for a start that recorded none — the Automatic switch, and every confirmation made
   * before starts carried their settings.
   */
  settings?: ProjectStartSettings;
  /** Which of `settings` are not what the start was asked for, in card order — empty when all of
   *  them are. Present exactly when `settings` is. */
  differsFromRequest?: ProjectStartSettingKey[];
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
 * Why a candidate is `BLOCKED`, as the job that blocked it answered (migration 0409): the source was
 * already on the upstream, so there is nothing to merge; a check on the combined tree failed; the
 * merge conflicted; or the job stopped before any check could answer.
 */
export type PromotionBlockedReason = 'ALREADY_LANDED' | 'CHECK_FAILED' | 'CONFLICT' | 'ERROR';

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
  /**
   * Why a BLOCKED candidate is blocked, stored with the block rather than read off `checks` and
   * `conflicts`: both are empty when there was nothing to merge, and when the job errored before a
   * check ran. Null on a candidate blocked before the reason was recorded, and on one that is not
   * blocked.
   */
  blockedReason: PromotionBlockedReason | null;
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
   * The landing session of this round of merging into main (§2.9 LS1), while there is one to open:
   * `CHECKING`, `CONFIRMED` and `RECHECKING` (the check line opens it), and `MERGED` (the receipt's
   * "Open landing ›"). Null on every other state — a candidate asking its owner, a blocked one, one
   * that was declined or retracted — and on a candidate whose round recorded no session. Absent
   * from a server that predates the field.
   */
  landingSessionId?: string | null;
  /**
   * What the check in flight leads to when it passes (§3.6): `MERGE` when the project's Automatic
   * setting will merge it into main by itself (§3.3 M-T11), `ASK` when the owner will get the card.
   * Read as the project stands now, so a project whose Automatic is switched while the check runs
   * reads the other answer on its next poll. Null on every state but `CHECKING`; absent from a server
   * older than the field.
   */
  onPass?: 'MERGE' | 'ASK' | null;
  /** The active job for this candidate's own confirmed merge, never another project job.
   * Confirmation authorizes a merge; it does not mean a runner has started it. */
  execution?: {
    state: 'QUEUED' | 'RUNNING';
    phase: IntegrationJobPhase | null;
    startedAt: Instant;
  } | null;
  /**
   * That job has been asked to stop and has not ended yet: the card draws it as "cancelling"
   * (§3.3 M-T10). The promotion keeps the state it was in until the job's own result settles
   * whether it landed; absent from a server older than the field.
   */
  cancelRequested?: boolean;
  /**
   * That job's current claim has passed the push boundary (§2.2 J-T4) — a v2 claim that reported
   * `PUSH` under this `claim_generation`, or a legacy claim at `PUSH` / `VERIFY`. Cancel is no
   * longer accepted past it; the result is the fact. Absent from a server older than the field.
   */
  pushBoundaryPassed?: boolean;
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
  /** Null when every held item is currently making progress (there is no expiry to count down to). */
  nextEscalationAt: Instant | null;
}

/**
 * Where a project's finished work lands, as one list row states it (§7.1 V1).
 *
 * Absent when nobody has decided a line and nothing has integrated yet: a project with no line has
 * no line to draw, and printing the default rule's guess there would state a decision nobody made.
 */
export interface ProjectListIntegration<Instant = string> {
  line: IntegrationLine;
  /** The branch's name, spelled as a merge receipt spells it (no `refs/heads/`). */
  ref: string;
  /** QUEUED or RUNNING jobs, including project merges and checks. Exceptions are not activity. */
  activeJobCount?: number;
  /** The job the project page's landing line would describe, chosen by the same rule; absent when
   *  nothing is in flight and on older servers. The session list's project row states it. */
  inFlight?: ProjectIntegrationInFlight<Instant>;
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

/** Stored task statuses from `project_task_status_count`, as `GET /projects/sidebar` serves them. */
export interface ProjectSidebarTaskCounts {
  done: number;
  failed: number;
  /** Every task except CANCELLED, including DONE and FAILED. */
  total: number;
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
  /**
   * The coordinator's open request to start this project (`START_REQUEST`, `project_request_start`)
   * while nobody has started it — since when it has been asking — or null. The fifth thing the row
   * names as waiting on the owner ("Needs you · Ready to start"), and kept out of `ownerItems`
   * because it is none of those four: nothing escalated, and nothing pushes. Optional for the same
   * reason the two fields above are.
   */
  startRequest?: { waitingSince: Instant } | null;
  /**
   * The coordinator's open request to record this project done (`DONE_REQUEST`,
   * `project_request_done`) while the project is OPEN — since when it has been asking — or null. The
   * row names it as waiting on the owner ("Needs you · Ready to close"), apart from `ownerItems` for
   * the reason `startRequest` is. Optional for the same reason the fields above are.
   */
  doneRequest?: { waitingSince: Instant } | null;
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
  /** The short reason for an escalated item, derived from its raw kind. */
  need?: string;
  /**
   * The item's project's main branch by name — `project_codebase.upstream_ref` without
   * `refs/heads/` — which a merge approval asks to merge into. Null when the project has no
   * repository bound.
   */
  mainBranch?: string | null;
}

/**
 * What a session row says its `pendingApprovals` is counting, when one word says it better than
 * "approval" — the kinds whose count is not an approval at all.
 *
 * `OWNER_CONFIRMATION` is an OWNER_CONFIRMED task's run waiting for its owner to confirm it done.
 * `OWNER_ITEM` is one of the four above: the row says the oldest item's own word (`Escalated to
 * you`, `Paused`, …) — the same words the Needs-you banner and the card in the conversation use —
 * because on a project whose coordinator is switched off the item is the owner's precisely when
 * nobody else will take it. `START_REQUEST` is a project not started yet whose coordinator has asked
 * to start it: the row says "Ready to start", over the "Start this project?" card. `DONE_REQUEST` is
 * an OPEN project whose coordinator has asked its owner to record it done: the row says "Ready to
 * close", over the "Is this project done?" card. `RECORD_AS_DONE` is a project that looks finished
 * and that its coordinator did not ask to have recorded done within the project's escalation window:
 * the row says "Record as done…". A row counting anything else (a blocked tool call, a proposal)
 * keeps the generic approval wording, and so does one counting two kinds at once.
 */
export type SessionWaitingKind =
  | 'OWNER_CONFIRMATION'
  | 'OWNER_ITEM'
  | 'START_REQUEST'
  | 'DONE_REQUEST'
  | 'RECORD_AS_DONE';
