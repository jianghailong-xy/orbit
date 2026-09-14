/**
 * The Watch API's wire vocabulary: what a client may send to `POST /api/watches` and what it reads
 * back. Transcribed from `contracts/watch.contract.json`, which stays the authority — see
 * `docs/watch-contract.md`. `src/apiserver/src/watches/watch-api.pg.spec.ts` holds every constant
 * below to that file, so a change here that the contract did not make first goes red.
 */

/** The one predicate grammar this build serves. Any other version is refused, never guessed at. */
export const WATCH_PREDICATE_VERSION = 1;

/** Every leaf of the v1 grammar, and the only target kind each one can be evaluated against. */
export const WATCH_LEAVES = {
  SESSION_TURN_SETTLED: 'SESSION',
  SESSION_RUN_TERMINAL: 'SESSION',
  SESSION_LIFECYCLE_TERMINAL: 'SESSION',
  SESSION_NEEDS_ATTENTION: 'SESSION',
  TASK_TERMINAL: 'TASK',
  TASK_FAILED: 'TASK',
  TASK_DONE: 'TASK',
} as const;

export type WatchLeaf = keyof typeof WATCH_LEAVES;

/** What a target may name. Only `SESSION` and `TASK` are watchable; the other two are refused as live sets. */
export type WatchResourceKind = 'SESSION' | 'TASK' | 'TASK_LIST' | 'PROJECT';
export type WatchTargetKind = 'SESSION' | 'TASK';
export const WATCH_RESOURCE_KINDS: readonly WatchResourceKind[] = ['SESSION', 'TASK', 'TASK_LIST', 'PROJECT'];

/** A closed grammar: no shell, no SQL, no log regex, no free-text expression. */
export type WatchPredicate =
  | { kind: 'ALL' | 'ANY'; over: 'ALL_TARGETS'; leaf: WatchLeaf }
  | { kind: 'ALL_OF' | 'ANY_OF'; operands: WatchPredicate[] };

export const WATCH_LIMITS = {
  maxTargetsPerWatch: 200,
  maxPredicateDepth: 2,
  maxOperandsPerComposite: 4,
  minTtlSeconds: 60,
  defaultTtlSeconds: 86_400,
  maxTtlSeconds: 2_592_000,
  /** A continuous watch's window: two of its wakes are at least this far apart, and one due sooner waits until then. */
  continuousDebounceSeconds: 10,
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
  'DYNAMIC_SET_UNSUPPORTED',
  'SELF_WATCH_LOOP',
  'WAKE_LOOP',
  'TTL_OUT_OF_RANGE',
  'WATCH_QUOTA_EXCEEDED',
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
  /** Required. Must be {@link WATCH_PREDICATE_VERSION}. */
  predicateVersion: number;
  predicate: WatchPredicate;
  /** An explicit set, frozen at create. Duplicates collapse. */
  targets: WatchTargetRef[];
  action: WatchAction;
  /** Only `ONE_SHOT` is served in v1. */
  mode?: 'ONE_SHOT';
  /** Names the session to resume; absent means the account's user is the observer. */
  observerSessionId?: string;
  /** Defaults to {@link WATCH_LIMITS.defaultTtlSeconds}. */
  ttlSeconds?: number;
  /** Scoped to the account: a retried create with the same key and request returns the same watch. */
  idempotencyKey?: string;
}

/** An edit of a live (ACTIVE or PAUSED) watch. The target set and the action are not editable. */
export interface UpdateWatchRequest {
  predicateVersion?: number;
  predicate?: WatchPredicate;
  /** Counted from the edit, not from the create. */
  ttlSeconds?: number;
}

/**
 * One target as the evaluation that recorded a Match saw it: what each leaf the predicate names
 * answered, and the columns those leaves read. A GONE target carries neither.
 */
export interface WatchTargetObservation {
  kind: WatchTargetKind;
  id: string;
  epoch: number;
  state: WatchTargetState;
  /** Whether that evaluation moved the target's state. */
  changed: boolean;
  leaves?: Partial<Record<WatchLeaf, boolean>>;
  observed?:
    | { status: string }
    | { status: string; endReason: string | null; runState: string; lifecycleState: string; pendingApproval: boolean };
}

/** A Match's `perTargetSnapshot`. */
export interface WatchSnapshot {
  evaluatedAt: string;
  targets: WatchTargetObservation[];
}

export interface WatchTargetView {
  targetKind: WatchTargetKind;
  targetResourceId: string;
  state: WatchTargetState;
  targetEpoch: number;
  lastEvaluatedAt: string | null;
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
 * unrun is never queued a second time, and nothing is delivered about targets its owner can no longer read.
 */
export const WATCH_UNRETRYABLE_DEAD_LETTER_CODES: readonly WatchDeadLetterCode[] = [
  'PERMISSION_REVOKED',
  'OBSERVER_SESSION_ENDED',
  'OBSERVER_TURN_INTERRUPTED',
  'WAKE_WITHDRAWN',
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
