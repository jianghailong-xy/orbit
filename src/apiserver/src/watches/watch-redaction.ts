import { WATCH_LEAVES, type WatchSnapshot, type WatchTargetObservation } from '@orbit/shared';

/**
 * What a Watch lets out of the database about the rows it watches, and in what shape (contract
 * `deliveryGuards.redaction`, docs/watch-operations.md §2).
 *
 * A wake's payload is built from the snapshot stored when its Match or its expiry landed, and a notification
 * carries the Match's reason to a device through a service outside Orbit. Neither is passed on as it was stored.
 * This build's evaluator writes exactly the fields below, but a row written by another build, edited by hand, or
 * carrying a field added later would otherwise reach a model's context or a lock screen as it is. So the payload is
 * rebuilt through an allowlist: every key the contract names, in the shape it names, and nothing else. A value of
 * the wrong shape is written `[redacted]` instead of being passed or silently dropped, so whoever reads the turn can
 * see that something was withheld.
 *
 * A delivery's `lastError` is text from wherever its failure came from, and the watch's read and the dead-letter
 * list show it. Credentials that a connection string, an authorization header or a key parameter can carry are
 * replaced before it is stored.
 */

export const REDACTED = '[redacted]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A status, a run or lifecycle state, an end reason, a progress phase: one identifier, never a sentence. */
const WORD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/**
 * What the evaluator writes as a reason: `describePredicate`'s kinds, leaves, counts, parentheses and commas, a
 * leaf's parameters as `(600s)`, `(50%)` or `(5)`, and on a CONTINUOUS watch's Match the crossings its window
 * coalesced and which wake of its budget it is.
 */
const REASON =
  /^[A-Z](?:[A-Z_(), 0-9/]|(?<=\(\d+)[s%](?=\)))*(?:; \d+ crossings? since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z; wake \d+ of \d+)?$/;
/** A key of a target's `leaves`: the leaf, followed by its parameters when it takes any, as in `TASK_NO_PROGRESS_FOR(600s)`. */
const LEAF_LABEL = /^([A-Z][A-Z_]*)(?:\(\d+[s%]?\))?$/;
const REASON_MAX_CHARS = 1_000;
const ERROR_MAX_CHARS = 1_000;
const TARGET_KINDS: readonly string[] = ['SESSION', 'TASK'];
const TARGET_STATES: readonly string[] = ['OBSERVED', 'SATISFIED', 'GONE'];

/** A stored snapshot, rebuilt through the allowlist. A well-formed one comes back with the same keys and values. */
export function redactSnapshot(stored: unknown): WatchSnapshot {
  const snapshot = isRecord(stored) ? stored : {};
  const evaluatedAt = snapshot.evaluatedAt;
  const redacted: Record<string, unknown> = {
    evaluatedAt: typeof evaluatedAt === 'string' && !Number.isNaN(Date.parse(evaluatedAt)) ? evaluatedAt : REDACTED,
    targets: (Array.isArray(snapshot.targets) ? snapshot.targets : []).map(redactTarget),
  };
  // A CONTINUOUS watch's Match names the window it closed and which wake of its budget it is, and its expiry the window
  // still open. Each is copied only when every field has its shape, and is otherwise `[redacted]` whole: the wake turn
  // reads `budget` to say whether this is the last wake, and half a budget would answer that wrongly.
  if ('window' in snapshot) redacted.window = shaped(snapshot.window, { openedAt: isInstant, closedAt: isInstant, crossings: isCount });
  if ('budget' in snapshot) redacted.budget = shaped(snapshot.budget, { wake: isCount, of: isCount });
  if ('openWindow' in snapshot) redacted.openWindow = shaped(snapshot.openWindow, { openedAt: isInstant, crossings: isCount });
  return redacted as unknown as WatchSnapshot;
}

function redactTarget(stored: unknown): WatchTargetObservation {
  const target = isRecord(stored) ? stored : {};
  const observation: Record<string, unknown> = {
    kind: oneOf(target.kind, TARGET_KINDS),
    id: typeof target.id === 'string' && UUID.test(target.id) ? target.id : REDACTED,
    epoch: Number.isSafeInteger(target.epoch) ? target.epoch : REDACTED,
    state: oneOf(target.state, TARGET_STATES),
    changed: typeof target.changed === 'boolean' ? target.changed : REDACTED,
  };
  // A GONE target, or one a paused watch's expiry only listed, carries neither of these; absent stays absent.
  if (isRecord(target.leaves)) {
    observation.leaves = Object.fromEntries(
      Object.entries(target.leaves)
        .filter(([label]) => {
          const leaf = LEAF_LABEL.exec(label)?.[1];
          return leaf !== undefined && Object.prototype.hasOwnProperty.call(WATCH_LEAVES, leaf);
        })
        .map(([label, held]) => [label, typeof held === 'boolean' ? held : REDACTED]),
    );
  }
  if (isRecord(target.observed)) {
    const observed = target.observed;
    const view: Record<string, unknown> = { status: word(observed.status) };
    if ('endReason' in observed) view.endReason = observed.endReason === null ? null : word(observed.endReason);
    if ('runState' in observed) view.runState = word(observed.runState);
    if ('lifecycleState' in observed) view.lifecycleState = word(observed.lifecycleState);
    if ('pendingApproval' in observed) {
      view.pendingApproval = typeof observed.pendingApproval === 'boolean' ? observed.pendingApproval : REDACTED;
    }
    // Only a predicate that reads progress records it. The reporter's message is never part of it.
    if ('progress' in observed) {
      const progress = isRecord(observed.progress) ? observed.progress : null;
      view.progress = progress && {
        phase: progress.phase === null ? null : word(progress.phase),
        current: progress.current === null ? null : count(progress.current),
        total: progress.total === null ? null : count(progress.total),
        lastProgressAt: progress.lastProgressAt === null ? null : instant(progress.lastProgressAt),
        epochStartedAt: instant(progress.epochStartedAt),
      };
      view.progress ??= REDACTED;
    }
    observation.observed = view;
  }
  return observation as unknown as WatchTargetObservation;
}

/** A Match's reason if it is written in the predicate vocabulary, and `[redacted]` if it is not. */
export function redactReason(reason: unknown): string {
  return typeof reason === 'string' && reason.length <= REASON_MAX_CHARS && REASON.test(reason) ? reason : REDACTED;
}

/** Each secret shape, and what replaces it. Case-insensitive where the shape is. */
const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  // The userinfo of any URL: postgres://orbit:hunter2@db:5432/orbit.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, `$1${REDACTED}@`],
  // An authorization scheme and its credentials.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // A JSON web token.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  // Provider API keys (sk-…, sk-ant-…), GitHub tokens, AWS access key ids.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // password=…, token: …, api_key="…".
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(\s*["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, `$1$2${REDACTED}`],
];

/** Failure text as a delivery stores it: secrets replaced, then cut to a thousand characters. */
export function redactErrorText(text: string): string {
  const redacted = SECRETS.reduce((current, [shape, replacement]) => current.replace(shape, replacement), text);
  return redacted.length > ERROR_MAX_CHARS ? `${redacted.slice(0, ERROR_MAX_CHARS)}…` : redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInstant(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** The named fields of a small record when every one has its shape, and `[redacted]` when any does not. */
function shaped(value: unknown, fields: Record<string, (field: unknown) => boolean>): unknown {
  if (!isRecord(value) || !Object.entries(fields).every(([name, holds]) => holds(value[name]))) return REDACTED;
  return Object.fromEntries(Object.keys(fields).map((name) => [name, value[name]]));
}

function oneOf(value: unknown, allowed: readonly string[]): string {
  return typeof value === 'string' && allowed.includes(value) ? value : REDACTED;
}

function word(value: unknown): string {
  return typeof value === 'string' && WORD.test(value) ? value : REDACTED;
}

function instant(value: unknown): unknown {
  return isInstant(value) ? value : REDACTED;
}

function count(value: unknown): unknown {
  return isCount(value) ? value : REDACTED;
}
