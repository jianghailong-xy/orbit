import {
  WATCH_LEAF_SINCE_VERSION,
  WATCH_LEAVES,
  WATCH_LIMITS,
  watchDeadLetterNeedsAttention,
  type CreateWatchRequest,
  type UpdateWatchRequest,
  type WatchAction,
  type WatchDeliveryView,
  type WatchLeaf,
  type WatchPredicate,
  type WatchRefusalCode,
  type WatchState,
  type WatchTargetKind,
  type WatchView,
} from '@orbit/shared';
import { api } from '../api';
import { routeId } from './idCodec';

/**
 * What the web draws a Watch from, and the words it draws it with.
 *
 * A Watch is the control plane waiting on a frozen set of sessions or tasks
 * (docs/watch-contract.md). Nothing runs while it waits, so none of this reads — or borrows the
 * words of — the Background processes tray: contract §9.2 keeps the two apart on screen as well as
 * in the data. Everything here is a pure reading of `GET /api/watches` rows, so the Following page,
 * the cards and the session/task relations say the same thing about one watch.
 */

export type { WatchView };

/** Where the Following page files a watch. Exactly one per watch; a problem outranks the rest. */
export type WatchBucket = 'active' | 'attention' | 'history';

/** The two states a watch can still be paused, resumed, edited or stopped from. */
export const isLiveWatch = (w: Pick<WatchView, 'state'>): boolean =>
  w.state === 'ACTIVE' || w.state === 'PAUSED';

// The web asks for public ids, and `watchId`/`observerSessionId`/`targetResourceId` are in the
// shared PUBLIC_ID_FIELDS, so rows arrive base62. A UUID still gets normalized rather than silently
// failing to match — a pasted link or an older server spells it that way.
const normId = (id: string): string => (id.includes('-') ? (routeId(id) ?? id) : id);

/** The watches a session is waiting on: it is their observer, and what they trigger resumes it. */
export function watchesFollowing(watches: readonly WatchView[], sessionId: string): WatchView[] {
  const key = normId(sessionId);
  return watches.filter((w) => w.observerSessionId != null && normId(w.observerSessionId) === key);
}

/** Whether two ids name the same row, whichever way each is spelled. */
export const sameResourceId = (a: string, b: string): boolean => normId(a) === normId(b);

/** An id as the app's links spell it — base62 — or as it came when it is no id at all. */
export const linkId = (id: string): string => routeId(id) ?? id;

/** Where one watch is shown whole: its card on the Following page, opened. */
export const watchHref = (watchId: string): string =>
  `/following?watch=${encodeURIComponent(linkId(watchId))}`;

/** A watch target's own page. */
export const targetHref = (kind: string, id: string): string =>
  kind === 'SESSION' ? `/sessions/${linkId(id)}` : `/tasks/${linkId(id)}`;

/** The watches that name this session or task among their targets. */
export function watchesFollowedBy(
  watches: readonly WatchView[],
  kind: WatchTargetKind,
  id: string,
): WatchView[] {
  const key = normId(id);
  return watches.filter((w) =>
    w.targets.some((t) => t.targetKind === kind && normId(t.targetResourceId) === key),
  );
}

interface LeafCopy {
  /** Verb phrase for one target: "the task FINISHES". */
  one: string;
  /** Verb phrase for several: "all 3 tasks FINISH". */
  many: string;
  /** The choice in the editor. */
  option: string;
  hint: string;
  /** What a target that meets it did, after a count: "2 of 3 FINISHED". */
  met: string;
}

/** The contract's leaves in the words a person reads them in. Kept apart on purpose: settled is not
 *  ended is not filed away is not done (contract §2.2), so no two of these may read alike. */
export const LEAF_COPY: Record<WatchLeaf, LeafCopy> = {
  SESSION_TURN_SETTLED: {
    one: 'finishes its turn',
    many: 'finish their turns',
    option: 'Finishes its turn',
    hint: 'Stops working for now: waiting for a reply, interrupted, or ended.',
    met: 'finished their turn',
  },
  SESSION_RUN_TERMINAL: {
    one: 'ends',
    many: 'end',
    option: 'Ends',
    hint: 'Its run is over: succeeded, failed or ended. Waiting for a reply is not an end.',
    met: 'ended',
  },
  SESSION_LIFECYCLE_TERMINAL: {
    one: 'is moved to Completed or Trash',
    many: 'are moved to Completed or Trash',
    option: 'Is moved to Completed or Trash',
    hint: 'Filed away, whatever its run did.',
    met: 'filed away',
  },
  SESSION_NEEDS_ATTENTION: {
    one: 'asks for an approval',
    many: 'ask for an approval',
    option: 'Asks for an approval',
    hint: 'A tool call is waiting for a person to allow it.',
    met: 'asked for approval',
  },
  TASK_TERMINAL: {
    one: 'finishes',
    many: 'finish',
    option: 'Finishes',
    hint: 'Done, failed or cancelled.',
    met: 'finished',
  },
  TASK_DONE: {
    one: 'is done',
    many: 'are done',
    option: 'Is done',
    hint: 'Its completion criterion was satisfied. A failure or a cancellation never counts.',
    met: 'done',
  },
  TASK_FAILED: {
    one: 'fails',
    many: 'fail',
    option: 'Fails',
    hint: 'Marked failed.',
    met: 'failed',
  },
  // Version 2 leaves: read on watches an agent made, never offered by the editor (leavesFor).
  TASK_PROGRESS_AT_LEAST: {
    one: 'reaches its progress mark',
    many: 'reach their progress mark',
    option: 'Reaches a progress mark',
    hint: 'The progress it reports reaches a count, or a share of its total.',
    met: 'reached their mark',
  },
  TASK_NO_PROGRESS_FOR: {
    one: 'stalls',
    many: 'stall',
    option: 'Stalls',
    hint: 'Still open, and the progress it reports has not moved for a set time.',
    met: 'stalled',
  },
};

const NOUN: Record<WatchTargetKind, [one: string, many: string]> = {
  SESSION: ['session', 'sessions'],
  TASK: ['task', 'tasks'],
};

/** "When all 7 tasks finish, or any of 7 tasks fails" — the condition, counted over the targets its
 *  leaves can read. A leaf this build does not know is named rather than dropped. */
export function describeCondition(
  predicate: WatchPredicate,
  targets: readonly { targetKind: string }[],
): string {
  const phrase = (p: WatchPredicate): string => {
    if (!p || typeof p !== 'object') return 'a condition this page cannot read';
    if ('leaf' in p) {
      const kind = WATCH_LEAVES[p.leaf];
      const copy = LEAF_COPY[p.leaf];
      if (!kind || !copy) return `${p.kind} ${p.leaf}`;
      const n = targets.filter((t) => t.targetKind === kind).length;
      const [one, many] = NOUN[kind];
      if (n <= 1) return `the ${one} ${copy.one}`;
      if (p.kind === 'AT_LEAST') return `at least ${p.count} of ${n} ${many} ${copy.many}`;
      // The threshold, not the set: one of them is enough, and the sentence says so.
      if (p.kind === 'ANY') return `any 1 of these ${n} ${many} ${copy.one}`;
      return `${n === 2 ? 'both' : `all ${n}`} ${many} ${copy.many}`;
    }
    return (p.operands ?? []).map(phrase).join(p.kind === 'ALL_OF' ? ', and ' : ', or ');
  };
  return `When ${phrase(predicate)}`;
}

/**
 * A Match's `reason` in words. The server records it as `ALL TASK_TERMINAL 5/7`, composed as
 * `ANY_OF(…, …)`; this reads the counts back out — "5 of 7 finished · 1 of 7 failed". A reason in
 * any other shape is returned as it is, never guessed at.
 */
export function describeReason(reason: string): string {
  const parts = [...reason.matchAll(/\b(?:ALL|ANY) ([A-Z_]+) (\d+)\/(\d+)/g)].map(([, leaf, held, total]) => {
    const copy = LEAF_COPY[leaf as WatchLeaf];
    return copy ? `${held} of ${total} ${copy.met}` : null;
  });
  return parts.length > 0 && parts.every(Boolean) ? parts.join(' · ') : reason;
}

/** What the watch does when its condition holds. */
export function describeAction(action: WatchAction | string): string {
  return action === 'NOTIFY_USER' ? 'Notify you' : 'Resume';
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A span short enough for a card row: "45s", "12m", "3h 20m", "23h", "2d 4h", "12d". */
export function formatSpan(ms: number): string {
  const abs = Math.max(0, ms);
  if (abs < MINUTE) return `${Math.max(1, Math.floor(abs / SECOND))}s`;
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)}m`;
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MINUTE);
    return h < 6 && m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  return d < 3 && h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** "just now" / "12m ago". A time a little ahead of this clock (server skew) reads as just now. */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'unknown';
  const diff = now - at;
  return diff < 10 * SECOND ? 'just now' : `${formatSpan(diff)} ago`;
}

/**
 * The deadline, while it still means something: how long a live watch has left (pausing does not
 * stop that clock, contract §3), or when an expired one ran out. `soon` is under an hour left.
 */
export function expiryLabel(
  w: Pick<WatchView, 'state' | 'expiresAt'>,
  now: number,
): { text: string; soon: boolean } | null {
  const at = Date.parse(w.expiresAt);
  if (!Number.isFinite(at)) return null;
  if (isLiveWatch(w)) {
    const left = at - now;
    return left <= 0 ? { text: 'now', soon: true } : { text: `in ${formatSpan(left)}`, soon: left < HOUR };
  }
  return w.state === 'EXPIRED' ? { text: ago(w.expiresAt, now), soon: false } : null;
}

/**
 * How many targets a watch names before the rest fold into a "+N more": the closed card's Watching
 * row and the opened strip's both cap here, so one number reads the same on both. The macOS client's
 * `WatchProjection.shownTargets` is this number, held to it by `WatchWakeCopyParityTests`.
 */
export const SHOWN_TARGETS = 3;

/**
 * The console's Watching strip (`SessionWatchStrip`): one line above the composer, reading the same
 * words on web and macOS — the macOS client's `WatchStripCopyParityTests` holds each to its
 * declaration here. The times are composed from `formatSpan`; "earliest" prefixes the soonest
 * deadline only on the count line, since a lone watch's own deadline needs no qualifier.
 */
export const STRIP_LABEL = 'Watching';
export const STRIP_UNTIL = 'Until';
export const STRIP_THEN = 'Resume this session';
export const STRIP_MANAGE = 'Manage in Watches ›';
export const STRIP_EARLIEST = 'earliest ';

export interface WatchProgress {
  met: number;
  waiting: number;
  gone: number;
  total: number;
}

/** The current snapshot: how many targets meet a leaf the condition names, and how many are gone. */
export function progressOf(w: Pick<WatchView, 'targets'>): WatchProgress {
  const p: WatchProgress = { met: 0, waiting: 0, gone: 0, total: w.targets.length };
  for (const t of w.targets) {
    if (t.state === 'SATISFIED') p.met += 1;
    else if (t.state === 'GONE') p.gone += 1;
    else p.waiting += 1;
  }
  return p;
}

/** How many of a watch's targets its condition actually asks for. */
export interface WatchThreshold {
  /** How many of them have to meet the leaf. */
  needed: number;
  /** How many the leaf can read at all: the set the condition quantifies over. */
  of: number;
}

/**
 * The threshold the condition itself sets, over the targets its leaf can read — an ANY watch is done
 * after one target, an AT_LEAST after its count. A composite, or any shape this build cannot read, asks
 * for the whole set: the reading progress had before it looked at the predicate. Nothing here throws,
 * the way `describeCondition` says a sentence rather than failing on a condition it cannot parse.
 */
export function thresholdOf(
  predicate: WatchPredicate,
  targets: readonly { targetKind: string }[],
): WatchThreshold {
  const p: WatchPredicate | null = predicate && typeof predicate === 'object' ? predicate : null;
  const kind = p && 'leaf' in p ? WATCH_LEAVES[p.leaf] : undefined;
  const of = kind ? targets.filter((t) => t.targetKind === kind).length : targets.length;
  if (!p || !kind || of === 0) return { needed: of, of };
  if (p.kind === 'ANY') return { needed: 1, of };
  if (p.kind === 'AT_LEAST') return { needed: Math.min(p.count, of), of };
  return { needed: of, of };
}

/**
 * The snapshot in the words a card shows: how many of the targets the condition needs have met it. The
 * denominator is the threshold, not the target count — one target settles an ANY watch — so it is left
 * off when one is all it takes. The threshold defaults to every target, which is what an unqualified
 * read counted.
 */
export function describeProgress(
  p: WatchProgress,
  threshold: WatchThreshold = { needed: p.total, of: p.total },
): string {
  if (p.total === 0) return 'No targets';
  const parts = [threshold.needed > 1 ? `${p.met} of ${threshold.needed} met` : `${p.met} met`];
  if (p.gone > 0) parts.push(`${p.gone} deleted`);
  return parts.join(' · ');
}

/**
 * When what this watch sees last changed. The evaluator writes a target's `lastEvaluatedAt` only when
 * that target's observed state moves (`land` in watch-evaluator.service.ts updates the changed
 * targets alone) and at create, and a Match is the last change a one-shot watch records — so the
 * latest of those is the last change. The watch's own `lastEvaluatedAt` is the other half: when it
 * last looked, whether or not anything had moved.
 */
export function lastChangedAt(w: Pick<WatchView, 'createdAt' | 'targets' | 'matches'>): string {
  let iso = w.createdAt;
  let best = Date.parse(iso);
  const consider = (candidate: string | null | undefined) => {
    const at = candidate ? Date.parse(candidate) : Number.NaN;
    if (Number.isFinite(at) && !(at <= best)) {
      best = at;
      iso = candidate!;
    }
  };
  for (const t of w.targets) consider(t.lastEvaluatedAt);
  for (const m of w.matches) consider(m.matchedAt);
  return iso;
}

/** Every delivery the watch caused: its Matches', then the one its unmatched end owed. */
export const deliveriesOf = (w: Pick<WatchView, 'matches' | 'expiryDeliveries'>): WatchDeliveryView[] => [
  ...w.matches.flatMap((m) => m.deliveries ?? []),
  ...(w.expiryDeliveries ?? []),
];

export interface WatchProblem {
  tone: 'error' | 'warning';
  title: string;
  detail?: string;
}

// `last_error` leads with a machine code (`OBSERVER_SESSION_ENDED: …`); the prose after it is what a
// person reads.
const errorProse = (lastError: string | null): string | undefined => {
  const text = lastError?.replace(/^[A-Z][A-Z_]+:\s*/, '').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : undefined;
};

/** A dead letter nobody has to act on: the wake was withdrawn before it ran (contract `deliveryGuards.attention`). */
export const wakeWithdrawn = (d: WatchDeliveryView): boolean =>
  d.state === 'DEAD_LETTER' && !watchDeadLetterNeedsAttention(d);

/**
 * Why a watch needs somebody to look at it, or null. These are the ends nobody would otherwise
 * hear about: a watch that stopped because it lost access or every target (contract §3 — "stopping
 * quietly is the failure mode being designed out"), a delivery that dead-lettered or keeps failing
 * (§3: dead letters must be visible — all but a wake withdrawn before it ran, which the card names
 * instead), a notify watch that expired with nobody told (§3 delivers an end only to a waiting
 * session), and a live watch that is losing its targets.
 */
export function watchProblem(w: WatchView): WatchProblem | null {
  if (w.state === 'REVOKED') {
    return {
      tone: 'error',
      title: 'Stopped: this account can no longer read a target',
      detail: 'Nothing about the targets was delivered once access was lost.',
    };
  }
  if (w.state === 'UNRESOLVABLE') {
    return {
      tone: 'error',
      title: 'Stopped: every target was deleted',
      detail: 'The condition can never be decided.',
    };
  }
  const deliveries = deliveriesOf(w);
  const dead = deliveries.find(watchDeadLetterNeedsAttention);
  if (dead) {
    return {
      tone: 'error',
      title: dead.action === 'NOTIFY_USER' ? 'The notification was not delivered' : 'The session was not woken',
      detail: errorProse(dead.lastError),
    };
  }
  const retrying = deliveries.find(
    (d) => (d.state === 'PENDING' || d.state === 'IN_FLIGHT') && d.attempts > 0,
  );
  if (retrying) {
    return {
      tone: 'warning',
      title: `Delivery is retrying: ${retrying.attempts} of ${WATCH_LIMITS.maxDeliveryAttempts} attempts failed`,
      detail: errorProse(retrying.lastError),
    };
  }
  if (w.state === 'EXPIRED' && w.action === 'NOTIFY_USER') {
    return {
      tone: 'warning',
      title: 'Expired before its condition held',
      detail: 'Nothing triggered, so no notification was sent.',
    };
  }
  const gone = w.targets.filter((t) => t.state === 'GONE').length;
  if (isLiveWatch(w) && gone > 0) {
    return {
      tone: 'warning',
      title: `${gone} of ${w.targets.length} targets ${gone === 1 ? 'was' : 'were'} deleted`,
      detail: 'A deleted target no longer counts toward the condition.',
    };
  }
  return null;
}

export function watchBucket(w: WatchView): WatchBucket {
  if (watchProblem(w)) return 'attention';
  return isLiveWatch(w) ? 'active' : 'history';
}

/** When a watch stopped being live, for ordering its history. */
export function endedAt(w: WatchView): string {
  if (w.state === 'MATCHED' && w.matches.length > 0) return w.matches[w.matches.length - 1].matchedAt;
  if (w.state === 'EXPIRED') return w.expiresAt;
  return w.updatedAt;
}

export function groupWatches(watches: readonly WatchView[]): Record<WatchBucket, WatchView[]> {
  const groups: Record<WatchBucket, WatchView[]> = { active: [], attention: [], history: [] };
  for (const w of watches) groups[watchBucket(w)].push(w);
  groups.history.sort((a, b) => Date.parse(endedAt(b)) - Date.parse(endedAt(a)));
  return groups;
}

/**
 * Several reads of the owner's watches as one list: each watch once, in the order first read. Given the
 * newest 100 first (lib/queries `watchesQuery`), a live watch only its own state's read found comes after
 * them, older than all of them.
 */
export function mergeWatches(lists: readonly (readonly WatchView[])[]): WatchView[] {
  const seen = new Set<string>();
  return lists.flat().filter((w) => {
    const key = normId(w.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type WatchTone = 'live' | 'paused' | 'met' | 'ended' | 'failed';

const STATE_COPY: Record<WatchState, { label: string; tone: WatchTone }> = {
  ACTIVE: { label: 'Watching', tone: 'live' },
  PAUSED: { label: 'Paused', tone: 'paused' },
  MATCHED: { label: 'Triggered', tone: 'met' },
  EXPIRED: { label: 'Expired', tone: 'ended' },
  CANCELLED: { label: 'Stopped', tone: 'ended' },
  REVOKED: { label: 'Access lost', tone: 'failed' },
  UNRESOLVABLE: { label: 'Unresolvable', tone: 'failed' },
};

export const watchStateCopy = (state: string): { label: string; tone: WatchTone } =>
  STATE_COPY[state as WatchState] ?? { label: state, tone: 'ended' };

// ── The editor ────────────────────────────────────────────────────────────────────────────────

export type Aggregation = 'ALL' | 'ANY';

/** What the editor can say. `orAnyFails` is the one composite it offers: the agent's canonical
 *  "all of these finish, or any one fails" (contract §2.3). */
export interface ConditionChoice {
  leaf: WatchLeaf;
  aggregation: Aggregation;
  orAnyFails?: boolean;
}

/** A leaf the editor can say: one of its own grammar's (EDITOR_PREDICATE_VERSION), which takes no parameters. */
const editorLeaf = (leaf: WatchLeaf): boolean =>
  !!LEAF_COPY[leaf] && WATCH_LEAF_SINCE_VERSION[leaf] <= EDITOR_PREDICATE_VERSION;

/** The leaves a target kind can be watched for, in the order the editor offers them (LEAF_COPY's). */
export const leavesFor = (kind: WatchTargetKind): WatchLeaf[] =>
  (Object.keys(LEAF_COPY) as WatchLeaf[]).filter((leaf) => WATCH_LEAVES[leaf] === kind && editorLeaf(leaf));

export const DEFAULT_LEAF: Record<WatchTargetKind, WatchLeaf> = {
  SESSION: 'SESSION_TURN_SETTLED',
  TASK: 'TASK_TERMINAL',
};

export function predicateFor(choice: ConditionChoice): WatchPredicate {
  const base: WatchPredicate = { kind: choice.aggregation, over: 'ALL_TARGETS', leaf: choice.leaf };
  if (!choice.orAnyFails) return base;
  return { kind: 'ANY_OF', operands: [base, { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_FAILED' }] };
}

/** The editor's reading of a stored condition, or null when it says more than the editor can. */
export function choiceOf(p: WatchPredicate): ConditionChoice | null {
  if (!p || typeof p !== 'object') return null;
  // A quorum, or a leaf of a later grammar and its parameters, says more than the editor can.
  if ('leaf' in p) return p.kind !== 'AT_LEAST' && editorLeaf(p.leaf) ? { leaf: p.leaf, aggregation: p.kind } : null;
  if (p.kind !== 'ANY_OF' || p.operands?.length !== 2) return null;
  const [first, second] = p.operands;
  if (
    'leaf' in first &&
    first.kind === 'ALL' &&
    WATCH_LEAVES[first.leaf] === 'TASK' &&
    editorLeaf(first.leaf) &&
    'leaf' in second &&
    second.kind === 'ANY' &&
    second.leaf === 'TASK_FAILED'
  ) {
    return { leaf: first.leaf, aggregation: 'ALL', orAnyFails: true };
  }
  return null;
}

export const TTL_CHOICES: readonly { seconds: number; label: string }[] = [
  { seconds: HOUR / SECOND, label: '1 hour' },
  { seconds: (6 * HOUR) / SECOND, label: '6 hours' },
  { seconds: DAY / SECOND, label: '24 hours' },
  { seconds: (3 * DAY) / SECOND, label: '3 days' },
  { seconds: (7 * DAY) / SECOND, label: '7 days' },
  { seconds: (30 * DAY) / SECOND, label: '30 days' },
];

/**
 * The grammar every condition this editor offers is written in. The server serves version 1 beside the newer
 * grammars and decides a predicate under the version it was sent with, so a request names the one its terms are in.
 */
export const EDITOR_PREDICATE_VERSION = 1;

export function createWatchBody(input: {
  targets: readonly { kind: WatchTargetKind; id: string }[];
  choice: ConditionChoice;
  action: WatchAction;
  observerSessionId?: string | null;
  ttlSeconds: number;
  idempotencyKey: string;
}): CreateWatchRequest {
  return {
    predicateVersion: EDITOR_PREDICATE_VERSION,
    predicate: predicateFor(input.choice),
    targets: input.targets.map((t) => ({ kind: t.kind, id: t.id })),
    action: input.action,
    ...(input.action === 'RESUME_SESSION' && input.observerSessionId
      ? { observerSessionId: input.observerSessionId }
      : {}),
    ttlSeconds: input.ttlSeconds,
    idempotencyKey: input.idempotencyKey,
  };
}

const REFUSAL_COPY: Record<WatchRefusalCode, string> = {
  EMPTY_TARGET_SET: 'A watch needs at least one session or task to watch.',
  TARGET_KIND_MISMATCH:
    'That condition does not fit every target: session conditions watch sessions, task conditions watch tasks.',
  TOO_MANY_TARGETS: `A watch can follow at most ${WATCH_LIMITS.maxTargetsPerWatch} targets.`,
  PREDICATE_TOO_DEEP: 'That condition is nested too deeply.',
  UNKNOWN_PREDICATE_KIND: 'This server does not know that condition.',
  PREDICATE_VERSION_UNSUPPORTED: 'This server does not serve that version of watch conditions.',
  PREDICATE_PARAMETER_INVALID: 'A number in that condition is out of range.',
  DYNAMIC_SET_UNSUPPORTED: 'A task list or project cannot be watched as a live set yet. Watch its sessions or tasks.',
  SELF_WATCH_LOOP: 'A session cannot be resumed by a watch on itself.',
  WAKE_LOOP: 'That watch would close a loop of sessions waking each other.',
  TTL_OUT_OF_RANGE: 'The deadline has to be between 1 minute and 30 days away.',
  WATCH_QUOTA_EXCEEDED:
    'There are already as many live watches as allowed, for this account or for one of the targets. Stop one that is no longer needed.',
  CONTINUOUS_POLICY_INVALID: 'The window or the wake budget of a continuous watch is out of range.',
  PERMISSION_DENIED: 'This account cannot read one of the targets.',
};

/** A refused create or edit in words: the contract's refusal code when the body carried one, the
 *  server's own message otherwise (a 409 names the state that refused, which is the useful part). */
export function watchErrorMessage(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  if (typeof e.code === 'string' && e.code in REFUSAL_COPY) return REFUSAL_COPY[e.code as WatchRefusalCode];
  return typeof e.message === 'string' && e.message ? e.message : 'The request failed.';
}

export const createWatch = (body: CreateWatchRequest) =>
  api<WatchView>('/watches', { method: 'POST', body });

export const updateWatch = (id: string, body: UpdateWatchRequest) =>
  api<WatchView>(`/watches/${encodeURIComponent(id)}`, { method: 'PATCH', body });

export const pauseWatch = (id: string) =>
  api<WatchView>(`/watches/${encodeURIComponent(id)}/pause`, { method: 'POST' });

export const resumeWatch = (id: string) =>
  api<WatchView>(`/watches/${encodeURIComponent(id)}/resume`, { method: 'POST' });

export const cancelWatch = (id: string) =>
  api<WatchView>(`/watches/${encodeURIComponent(id)}/cancel`, { method: 'POST' });

// ── The turn a watch queues ───────────────────────────────────────────────────────────────────

export type WatchWakeKind = 'MATCHED' | 'EXPIRED' | 'REVOKED' | 'UNRESOLVABLE';

export interface WatchWake {
  /** As the turn spells it: the server writes the UUID into the message text. */
  watchId: string;
  kind: WatchWakeKind;
  generation: number | null;
  reason: string | null;
  changedTargets: { kind: string; id: string; state: string | null; status: string | null }[];
}

const WAKE_HEAD =
  /^Orbit Watch (\S+) (?:matched at generation (\d+): (.+)|EXPIRED at \S+ without its condition ever holding\.|ended (REVOKED|UNRESOLVABLE): .+)$/;
const WAKE_MARK = 'This turn was queued by the watch, not typed by a person.';

/**
 * The message a watch queued into its observer (watch-delivery.service.ts `watchTurnContent`,
 * `watchExpiryTurnContent`, `watchEndTurnContent`), or null for anything else. All three of its
 * parts have to be there — the head line, the sentence saying a watch queued it, and a JSON payload
 * naming the same watch — so a person who pastes one of them into the composer still gets their
 * own bubble.
 */
export function parseWatchWake(text: string): WatchWake | null {
  if (!text.startsWith('Orbit Watch ') || !text.includes(WAKE_MARK)) return null;
  const newline = text.indexOf('\n');
  const head = WAKE_HEAD.exec(newline < 0 ? text : text.slice(0, newline));
  const fence = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!head || !fence) return null;
  let payload: { watchId?: unknown; changedTargets?: unknown };
  try {
    payload = JSON.parse(fence[1]);
  } catch {
    return null;
  }
  if (!payload || payload.watchId !== head[1]) return null;
  const kind: WatchWakeKind = head[2] ? 'MATCHED' : head[4] ? (head[4] as WatchWakeKind) : 'EXPIRED';
  const changed = Array.isArray(payload.changedTargets) ? payload.changedTargets : [];
  return {
    watchId: head[1],
    kind,
    generation: head[2] ? Number(head[2]) : null,
    reason: head[3] ?? null,
    changedTargets: changed
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .filter((t) => typeof t.kind === 'string' && typeof t.id === 'string')
      .map((t) => {
        const observed = (t.observed ?? {}) as { status?: unknown };
        return {
          kind: t.kind as string,
          id: t.id as string,
          state: typeof t.state === 'string' ? t.state : null,
          status: typeof observed.status === 'string' ? observed.status : null,
        };
      }),
  };
}
