/**
 * The Watch API's wire vocabulary: what a client may send to `POST /api/watches` and what it reads
 * back. Transcribed from `contracts/watch.contract.json`, which stays the authority — see
 * `docs/watch-contract.md`. `src/apiserver/src/watches/watch-api.pg.spec.ts` holds every constant
 * below to that file, so a change here that the contract did not make first goes red.
 */

/** The newest predicate grammar this build serves. */
export const WATCH_PREDICATE_VERSION = 2;

/**
 * Every grammar this build serves; any other version is refused, never guessed at. Version 2 is
 * version 1 plus the two progress leaves, the `params` a leaf takes and the `AT_LEAST` quorum. A
 * predicate is decided under the version it was stored with, so a version-1 watch never meets a term
 * it did not ask for.
 */
export const WATCH_PREDICATE_VERSIONS: readonly number[] = [1, 2];

/** Every leaf, and the only target kind each one can be evaluated against. */
export const WATCH_LEAVES = {
  SESSION_TURN_SETTLED: 'SESSION',
  SESSION_RUN_TERMINAL: 'SESSION',
  SESSION_LIFECYCLE_TERMINAL: 'SESSION',
  SESSION_NEEDS_ATTENTION: 'SESSION',
  TASK_TERMINAL: 'TASK',
  TASK_FAILED: 'TASK',
  TASK_DONE: 'TASK',
  TASK_PROGRESS_AT_LEAST: 'TASK',
  TASK_NO_PROGRESS_FOR: 'TASK',
} as const;

export type WatchLeaf = keyof typeof WATCH_LEAVES;

/** The grammar version each leaf first appears in. A request under an earlier version naming it is refused. */
export const WATCH_LEAF_SINCE_VERSION: Readonly<Record<WatchLeaf, number>> = {
  SESSION_TURN_SETTLED: 1,
  SESSION_RUN_TERMINAL: 1,
  SESSION_LIFECYCLE_TERMINAL: 1,
  SESSION_NEEDS_ATTENTION: 1,
  TASK_TERMINAL: 1,
  TASK_FAILED: 1,
  TASK_DONE: 1,
  TASK_PROGRESS_AT_LEAST: 2,
  TASK_NO_PROGRESS_FOR: 2,
};

/** What a target may name. Only `SESSION` and `TASK` are watchable; the other two are refused as live sets. */
export type WatchResourceKind = 'SESSION' | 'TASK' | 'TASK_LIST' | 'PROJECT';
export type WatchTargetKind = 'SESSION' | 'TASK';
export const WATCH_RESOURCE_KINDS: readonly WatchResourceKind[] = ['SESSION', 'TASK', 'TASK_LIST', 'PROJECT'];

/**
 * What a parameterized leaf is asked (predicateVersion 2). `TASK_PROGRESS_AT_LEAST` takes exactly one of
 * `current` (the reported count reaches it) or `percent` (the count reaches that share of the reported
 * total); `TASK_NO_PROGRESS_FOR` takes `seconds`. No other leaf takes any.
 */
export type WatchLeafParams = { current: number } | { percent: number } | { seconds: number };

/** A closed grammar: no shell, no SQL, no log regex, no free-text expression. */
export type WatchPredicate =
  | { kind: 'ALL' | 'ANY'; over: 'ALL_TARGETS'; leaf: WatchLeaf; params?: WatchLeafParams }
  /** A quorum over the sealed target set: at least `count` of the targets, never more than the set holds. */
  | { kind: 'AT_LEAST'; count: number; over: 'ALL_TARGETS'; leaf: WatchLeaf; params?: WatchLeafParams }
  | { kind: 'ALL_OF' | 'ANY_OF'; operands: WatchPredicate[] };

export const WATCH_LIMITS = {
  maxTargetsPerWatch: 200,
  maxPredicateDepth: 2,
  maxOperandsPerComposite: 4,
  minTtlSeconds: 60,
  defaultTtlSeconds: 86_400,
  maxTtlSeconds: 2_592_000,
  /** A CONTINUOUS watch's coalescing window: its default, and the shortest one served. Two of its wakes are also delivered at least this far apart, and one due sooner waits until then. */
  continuousDebounceSeconds: 10,
  maxContinuousDebounceSeconds: 3_600,
  /** How many Matches a CONTINUOUS watch may record when its request names no budget, and the most it may name. */
  defaultContinuousWakeBudget: 10,
  maxContinuousWakeBudget: 100,
  /** The shortest `TASK_NO_PROGRESS_FOR` window; the longest is the longest TTL. */
  minNoProgressSeconds: 60,
  /** The failed attempt that brings a delivery's `attempts` here makes it a dead letter. */
  maxDeliveryAttempts: 8,
  /** Live (ACTIVE or PAUSED) watches one account may hold. A create that would stay live past it is `WATCH_QUOTA_EXCEEDED`. */
  maxLiveWatchesPerOwner: 500,
  /** Live watches that may name one target. A create that would stay live past it is `WATCH_QUOTA_EXCEEDED`. */
  maxLiveWatchesPerTarget: 50,
  /** Wakes one observer session is given in a rolling hour. The next one is a `WAKE_STORM_SUPPRESSED` dead letter. */
  maxWakesPerObserverPerHour: 60,
  /** Wakes one account's watches give in a rolling 24 hours. The next one is a `WAKE_BUDGET_EXHAUSTED` dead letter. */
  maxWakesPerOwnerPerDay: 1_000,
} as const;

export type WatchState = 'ACTIVE' | 'PAUSED' | 'MATCHED' | 'EXPIRED' | 'CANCELLED' | 'REVOKED' | 'UNRESOLVABLE';
export const WATCH_STATES: readonly WatchState[] = [
  'ACTIVE', 'PAUSED', 'MATCHED', 'EXPIRED', 'CANCELLED', 'REVOKED', 'UNRESOLVABLE',
];
export type WatchMode = 'ONE_SHOT' | 'CONTINUOUS';
export const WATCH_MODES: readonly WatchMode[] = ['ONE_SHOT', 'CONTINUOUS'];
export type WatchAction = 'NOTIFY_USER' | 'RESUME_SESSION';
export const WATCH_ACTIONS: readonly WatchAction[] = ['NOTIFY_USER', 'RESUME_SESSION'];
export type WatchObserverType = 'USER' | 'SESSION';
export type WatchTargetState = 'OBSERVED' | 'SATISFIED' | 'GONE';

export const WATCH_REFUSAL_CODES = [
  'EMPTY_TARGET_SET',
  'TARGET_KIND_MISMATCH',
  'TOO_MANY_TARGETS',
  'PREDICATE_TOO_DEEP',
  'UNKNOWN_PREDICATE_KIND',
  'PREDICATE_VERSION_UNSUPPORTED',
  'PREDICATE_PARAMETER_INVALID',
  'DYNAMIC_SET_UNSUPPORTED',
  'SELF_WATCH_LOOP',
  'WAKE_LOOP',
  'TTL_OUT_OF_RANGE',
  'WATCH_QUOTA_EXCEEDED',
  'CONTINUOUS_POLICY_INVALID',
  'PERMISSION_DENIED',
] as const;
export type WatchRefusalCode = (typeof WATCH_REFUSAL_CODES)[number];

/** The body of a refused create or edit: 403 for `PERMISSION_DENIED`, 400 for every other code. */
export interface WatchRefusal {
  code: WatchRefusalCode;
  kind: 'REFUSAL';
  message: string;
}

export interface WatchTargetRef {
  kind: WatchResourceKind;
  id: string;
}

export interface CreateWatchRequest {
  /** Required: one of {@link WATCH_PREDICATE_VERSIONS}. The predicate is read under that grammar. */
  predicateVersion: number;
  predicate: WatchPredicate;
  /** An explicit set, frozen at create. Duplicates collapse. */
  targets: WatchTargetRef[];
  action: WatchAction;
  /** `ONE_SHOT` (the default) matches once; `CONTINUOUS` matches at each coalesced crossing, within its wake budget. */
  mode?: WatchMode;
  /** CONTINUOUS only. Defaults to {@link WATCH_LIMITS.continuousDebounceSeconds}. */
  debounceSeconds?: number;
  /** CONTINUOUS only: how many Matches the watch may ever record. Defaults to {@link WATCH_LIMITS.defaultContinuousWakeBudget}. */
  wakeBudget?: number;
  /** Names the session to resume; absent means the account's user is the observer. */
  observerSessionId?: string;
  /** Defaults to {@link WATCH_LIMITS.defaultTtlSeconds}. */
  ttlSeconds?: number;
  /** Scoped to the account: a retried create with the same key and request returns the same watch. */
  idempotencyKey?: string;
}

/** An edit of a live (ACTIVE or PAUSED) watch. The target set, the action and the mode are not editable. */
export interface UpdateWatchRequest {
  predicateVersion?: number;
  predicate?: WatchPredicate;
  /** Counted from the edit, not from the create. */
  ttlSeconds?: number;
}

/** A Task's progress as a progress leaf read it. Only a predicate that names a progress leaf records it. */
export interface WatchObservedProgress {
  phase: string | null;
  current: number | null;
  total: number | null;
  lastProgressAt: string | null;
  epochStartedAt: string;
}

/**
 * One target as the evaluation that recorded a Match saw it: what each leaf the predicate names
 * answered, and the columns those leaves read. A GONE target carries neither.
 */
export interface WatchTargetObservation {
  kind: WatchTargetKind;
  id: string;
  /** The lifecycle epoch the target was observed in: a Task's advances each time it is reopened, a session's is 0. */
  epoch: number;
  state: WatchTargetState;
  /** Whether that evaluation moved the target's state. */
  changed: boolean;
  /** Keyed by leaf label: the leaf's name, followed by its parameters when it takes any, as in `TASK_NO_PROGRESS_FOR(600s)`. */
  leaves?: Record<string, boolean>;
  observed?:
    | { status: string; progress?: WatchObservedProgress }
    | { status: string; endReason: string | null; runState: string; lifecycleState: string; pendingApproval: boolean };
}

/** A Match's `perTargetSnapshot`, and an expiry's. */
export interface WatchSnapshot {
  evaluatedAt: string;
  targets: WatchTargetObservation[];
  /** A CONTINUOUS watch's Match: the coalescing window it closed, and the crossings seen in it. */
  window?: { openedAt: string; closedAt: string; crossings: number };
  /** A CONTINUOUS watch's Match: this is wake `wake` of the `of` its budget allows, and the last one settles the watch. */
  budget?: { wake: number; of: number };
  /** A CONTINUOUS watch's expiry: the window still open when it expired, which no Match will close. */
  openWindow?: { openedAt: string; crossings: number };
}

export interface WatchTargetView {
  targetKind: WatchTargetKind;
  targetResourceId: string;
  state: WatchTargetState;
  targetEpoch: number;
  lastEvaluatedAt: string | null;
  /**
   * The target's own title, read with the watch and under the same account. Null when this account
   * cannot read the row — deleted, or no longer its own — which is never on its own a reason to
   * call a target deleted: `state` is GONE when the row is gone, and that is what a client says
   * "Deleted" from. Absent from an older server, which leaves a client naming the target by its id.
   */
  targetTitle?: string | null;
  /**
   * Where the target itself stands, read with the watch and under the same account, so the strip
   * above a composer can say it without a read per target. Null on the same terms as `targetTitle`;
   * absent from an older server.
   */
  targetStatus?: WatchTargetStatusView | null;
}

/**
 * One target's own standing, in the words its own list uses: a task as the task list reads it — its
 * status column, with the `running`/`queued` overlays `TasksService.withRunning` derives from its
 * sessions — and a session by its run state (`SessionRunState`), `running`/`queued` saying the same
 * two things about it.
 */
export interface WatchTargetStatusView {
  /** A task's `TaskStatus`, or a session's `SessionRunState`. */
  status: string;
  /** A RUNNING session is on the task, or the session is RUNNING. */
  running: boolean;
  /** A PENDING session waits on the task with none running, or the session is QUEUED. */
  queued: boolean;
}

export type WatchDeliveryState = 'PENDING' | 'IN_FLIGHT' | 'DELIVERED' | 'DEAD_LETTER';
export const WATCH_DELIVERY_STATES: readonly WatchDeliveryState[] = ['PENDING', 'IN_FLIGHT', 'DELIVERED', 'DEAD_LETTER'];

/**
 * Why a delivery is a dead letter: the code heading its `lastError`, transcribed from the contract's
 * `deliveryGuards.deadLetterCodes`. `ATTEMPTS_EXHAUSTED` heads no `lastError` — it names retryable failures that
 * ran out of attempts, whose text is the last failure — and `OTHER` is a dead letter this build does not classify.
 */
export const WATCH_DEAD_LETTER_CODES = [
  'PERMISSION_REVOKED',
  'OBSERVER_SESSION_GONE',
  'OBSERVER_SESSION_IN_TRASH',
  'OBSERVER_SESSION_COMPLETED',
  'OBSERVER_SESSION_ENDED',
  'OBSERVER_SESSION_UNAVAILABLE',
  'OBSERVER_TURN_INTERRUPTED',
  'WAKE_WITHDRAWN',
  'WAKE_KEY_TAKEN',
  'WAKE_STORM_SUPPRESSED',
  'WAKE_BUDGET_EXHAUSTED',
  'TURN_REFUSED',
  'LEASE_EXPIRED',
  'ATTEMPTS_EXHAUSTED',
  'OTHER',
] as const;
export type WatchDeadLetterCode = (typeof WATCH_DEAD_LETTER_CODES)[number];

/**
 * The dead letters `POST /api/watches/deliveries/:id/retry` does not redrive: a wake that left its observer's queue
 * unrun is never queued a second time, a key another turn already holds is still held on the next attempt, and
 * nothing is delivered about targets its owner can no longer read.
 */
export const WATCH_UNRETRYABLE_DEAD_LETTER_CODES: readonly WatchDeadLetterCode[] = [
  'PERMISSION_REVOKED',
  'OBSERVER_SESSION_ENDED',
  'OBSERVER_TURN_INTERRUPTED',
  'WAKE_WITHDRAWN',
  'WAKE_KEY_TAKEN',
];

/** The dead-letter code of a delivery that stopped with this `lastError` after this many failed attempts. */
export function watchDeadLetterCodeOf(lastError: string | null, attempts: number): WatchDeadLetterCode {
  const heading = /^([A-Z][A-Z0-9_]*):/.exec(lastError ?? '')?.[1];
  if (heading !== undefined && heading !== 'ATTEMPTS_EXHAUSTED' && heading !== 'OTHER'
    && (WATCH_DEAD_LETTER_CODES as readonly string[]).includes(heading)) {
    return heading as WatchDeadLetterCode;
  }
  return attempts >= WATCH_LIMITS.maxDeliveryAttempts ? 'ATTEMPTS_EXHAUSTED' : 'OTHER';
}

/**
 * The dead letters nobody has to act on, transcribed from the contract's `needsAttention: false` codes
 * (`deliveryGuards.attention`): the wake was taken back on purpose before it ran, by its owner withdrawing that one
 * queued turn or by a caller that already had its answer inline. A client still shows one, as withdrawn, and files
 * its watch by state. Every other dead letter puts its watch under Needs attention.
 */
export const WATCH_QUIET_DEAD_LETTER_CODES: readonly WatchDeadLetterCode[] = ['WAKE_WITHDRAWN'];

/** Whether a delivery is a dead letter somebody has to look at: one whose code is not in {@link WATCH_QUIET_DEAD_LETTER_CODES}. */
export function watchDeadLetterNeedsAttention(
  delivery: Pick<WatchDeliveryView, 'state' | 'lastError' | 'attempts'>,
): boolean {
  return delivery.state === 'DEAD_LETTER'
    && !WATCH_QUIET_DEAD_LETTER_CODES.includes(watchDeadLetterCodeOf(delivery.lastError, delivery.attempts));
}

/**
 * The ends a watch needs attention for by its state alone, transcribed from the contract's `attention.states`: it
 * stopped because it lost a target it could no longer read, or because every target was deleted, and either way it
 * could not go on watching (contract §3). `GET /api/watches?needsAttention=true` reads by this and the two below.
 */
export const WATCH_ATTENTION_STATES: readonly WatchState[] = ['REVOKED', 'UNRESOLVABLE'];

/**
 * The actions whose watch needs attention once it EXPIRED, transcribed from the contract's `attention.expiredActions`:
 * nobody waits on a NOTIFY_USER watch, so no end of it is delivered to anyone and nothing would say it ran out.
 */
export const WATCH_ATTENTION_EXPIRED_ACTIONS: readonly WatchAction[] = ['NOTIFY_USER'];

/**
 * What a Match caused, and whether it worked. `attempts` counts the attempts that failed; the one that
 * reaches `WATCH_LIMITS.maxDeliveryAttempts` leaves a `DEAD_LETTER`, which keeps its `lastError`.
 */
export interface WatchDeliveryView {
  id: string;
  action: WatchAction;
  state: WatchDeliveryState;
  attempts: number;
  /** When the next attempt is due, or the last one was. */
  nextAttemptAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  deadLetteredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A delivery as the operations read lists it (`GET /api/watches/deliveries`): the watch it belongs to, why it is a
 * dead letter, and whether `POST /api/watches/deliveries/:id/retry` redrives it.
 */
export interface WatchDeliveryOpsView extends WatchDeliveryView {
  watchId: string;
  kind: 'MATCH' | 'EXPIRY' | 'REVOKED' | 'UNRESOLVABLE';
  /** The Match's generation, or null for the delivery a watch's end owes its observer. */
  generation: number | null;
  /** Set exactly on a `DEAD_LETTER`. */
  deadLetterCode: WatchDeadLetterCode | null;
  /** A dead letter whose code is not one of {@link WATCH_UNRETRYABLE_DEAD_LETTER_CODES}. */
  retryable: boolean;
}

export interface WatchMatchView {
  id: string;
  generation: number;
  matchedAt: string;
  reason: string;
  predicateVersion: number;
  perTargetSnapshot: WatchSnapshot;
  deliveries: WatchDeliveryView[];
}

/**
 * The turn a RESUME_SESSION watch that ended unmatched owes its observer (contract §3, §5), and whether
 * it got there. `kind` says how the watch ended. `expirySnapshot` is what the expiring evaluation saw, in
 * a Match snapshot's shape, and null on the other two kinds: a REVOKED watch reports nothing about its
 * targets (§7), and an UNRESOLVABLE watch has none left.
 */
export interface WatchExpiryDeliveryView extends WatchDeliveryView {
  kind: 'EXPIRY' | 'REVOKED' | 'UNRESOLVABLE';
  expirySnapshot: WatchSnapshot | null;
}

export interface WatchView {
  id: string;
  observerType: WatchObserverType;
  observerSessionId: string | null;
  predicateVersion: number;
  predicate: WatchPredicate;
  mode: WatchMode;
  action: WatchAction;
  state: WatchState;
  generation: number;
  /** CONTINUOUS only, null on a ONE_SHOT watch. */
  debounceSeconds: number | null;
  wakeBudget: number | null;
  /** Whether the predicate held at the last evaluation: a crossing is it holding when this was false. */
  holding: boolean;
  /** The coalescing window a crossing opened on a live CONTINUOUS watch, until the Match that closes it. */
  windowOpenedAt: string | null;
  windowClosesAt: string | null;
  windowCrossings: number;
  expiresAt: string;
  nextEvaluateAt: string | null;
  lastEvaluatedAt: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  targets: WatchTargetView[];
  matches: WatchMatchView[];
  /** At most one, and only for a RESUME_SESSION watch that expired, was revoked or became unresolvable; a cancelled watch has none. A dead letter shows here just as it does on a Match. */
  expiryDeliveries: WatchExpiryDeliveryView[];
}

/** The bounds a progress report is held to (contract `progress.limits`); the database's CHECKs hold the same. */
export const TASK_PROGRESS_LIMITS = {
  maxPhaseChars: 80,
  maxMessageChars: 500,
  /** The largest `current` or `total`: a PostgreSQL integer. */
  maxCount: 2_147_483_647,
} as const;

/**
 * A structured progress report, `POST /api/tasks/:id/progress`. Each field it names replaces that field of
 * the Task's progress, `null` clears one, and an absent field keeps what is there. What results must still
 * report a position — a `phase` or a `current` — and `current` may not pass `total`. `expectedRevision`,
 * when sent, makes the report a compare-and-set on the revision the reporter read.
 */
export interface TaskProgressReport {
  phase?: string | null;
  current?: number | null;
  total?: number | null;
  message?: string | null;
  expectedRevision?: number;
}

/**
 * A Task's progress in its current lifecycle epoch. `revision` counts every accepted change, the epoch
 * advance among them. `lastProgressAt` is when the reported position (phase, current, total) last changed
 * in this epoch: a message alone never moves it, and neither does a report repeated verbatim. A reopened
 * Task starts a new epoch with nothing reported.
 */
export interface TaskProgressView {
  taskId: string;
  lifecycleEpoch: number;
  /** When this epoch began: the Task's creation for epoch 0, the reopen for every later one. */
  epochStartedAt: string;
  phase: string | null;
  current: number | null;
  total: number | null;
  message: string | null;
  revision: number;
  lastProgressAt: string | null;
  updatedAt: string | null;
}

/** A report's answer: the progress as it now stands, whether the report changed it, and whether that was progress. */
export interface TaskProgressReportResult extends TaskProgressView {
  changed: boolean;
  progressed: boolean;
}
