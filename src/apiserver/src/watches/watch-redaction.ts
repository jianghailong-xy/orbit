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
/** A status, a run or lifecycle state, an end reason: one identifier, never a sentence. */
const WORD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** What `describePredicate` writes: kinds, leaves, counts, parentheses and commas. */
const REASON = /^[A-Z][A-Z_(), 0-9/]*$/;
const REASON_MAX_CHARS = 1_000;
const ERROR_MAX_CHARS = 1_000;
const TARGET_KINDS: readonly string[] = ['SESSION', 'TASK'];
const TARGET_STATES: readonly string[] = ['OBSERVED', 'SATISFIED', 'GONE'];

/** A stored snapshot, rebuilt through the allowlist. A well-formed one comes back with the same keys and values. */
export function redactSnapshot(stored: unknown): WatchSnapshot {
  const snapshot = isRecord(stored) ? stored : {};
  const evaluatedAt = snapshot.evaluatedAt;
  return {
    evaluatedAt: typeof evaluatedAt === 'string' && !Number.isNaN(Date.parse(evaluatedAt)) ? evaluatedAt : REDACTED,
    targets: (Array.isArray(snapshot.targets) ? snapshot.targets : []).map(redactTarget),
  };
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
        .filter(([leaf]) => Object.prototype.hasOwnProperty.call(WATCH_LEAVES, leaf))
        .map(([leaf, held]) => [leaf, typeof held === 'boolean' ? held : REDACTED]),
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

function oneOf(value: unknown, allowed: readonly string[]): string {
  return typeof value === 'string' && allowed.includes(value) ? value : REDACTED;
}

function word(value: unknown): string {
  return typeof value === 'string' && WORD.test(value) ? value : REDACTED;
}
