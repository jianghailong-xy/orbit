import { setTimeout as delay } from 'node:timers/promises';

import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  type ConflictFacts,
  markConflictCounted,
  recordTransactionUnit,
} from './db-conflict-metrics';

/**
 * Retrying a PostgreSQL transaction that the server itself rolled back.
 *
 * PostgreSQL answers a lost deadlock (`40P01`) or a failed serialization (`40001`) by aborting
 * one transaction whole: nothing it wrote is visible and nothing it read can be trusted, so the
 * only correct response is to run the *entire* unit of work again from a new snapshot. That is
 * the one thing this module guarantees — every attempt calls `$transaction` afresh with the same
 * closure, never a resumed or partially replayed one.
 *
 * The classifier is deliberately separate from the loop. A retry loop is only one consumer of
 * "did the database abort this?"; an error boundary that has to decide between a 503 and a 500
 * is another, and it has no transaction to re-run. Both read the same verdict from
 * `classifyTransactionError`, so the two can never disagree about what a transient failure is.
 *
 * Nothing here knows about Projects, Tasks or any other domain: the input is an unknown error
 * and something with a `$transaction` method. The one thing it reaches out to is the conflict
 * counters (`db-conflict-metrics.ts`), which every settled unit records itself into — the loop is
 * the only place that knows how many attempts a unit spent and how long the caller waited for
 * them, so a caller who forgot to wire telemetry up cannot make a retry invisible.
 */

/** Why PostgreSQL threw the transaction away. Each one is safe to re-run. */
export type TransientTransactionReason =
  /** SQLSTATE 40P01 — this backend was picked as the victim of a lock cycle. */
  | 'DEADLOCK'
  /** SQLSTATE 40001 — a concurrent write invalidated this transaction's snapshot. */
  | 'SERIALIZATION'
  /** Prisma P2034 — the same event, reported by the client rather than by the server. */
  | 'WRITE_CONFLICT';

export interface TransactionErrorClassification {
  /** Whether re-running the whole transaction is the correct response. */
  retryable: boolean;
  reason?: TransientTransactionReason;
  /** The exact thing that decided it: a SQLSTATE, a Prisma code, or `'message'`. */
  evidence?: string;
  /** Where the evidence was found: 0 is the thrown error, 1 its cause, and so on. */
  depth?: number;
}

/**
 * WHAT kind of failure this was, for a reader who needs more than "may I run it again".
 *
 * `retryable` answers one question and answers it well, but it collapses four different things
 * into one `false`: a duplicate key, a database that has run out of connections, a validation
 * refusal a service already turned into a 409, and something nobody has classified. An operator
 * watching a graph has to tell those apart — the second is an incident, the first and third are
 * Tuesday — so the same traversal that decides `retryable` also names the family it found.
 *
 * It changes no decision. `withTransactionRetry` still retries exactly `TRANSIENT`, and the error
 * boundary still answers a typed 503 for exactly `TRANSIENT`; this is the label on the counter,
 * not a second policy.
 */
export type TransactionErrorFamily =
  /** The server threw the transaction away. Safe to run again — see {@link TransientTransactionReason}. */
  | 'TRANSIENT'
  /** A decision about one statement that the data will reach again: a duplicate key, a missing parent. */
  | 'PERMANENT'
  /** The database or its resources failed: no connections left, out of memory, shutting down, disk. */
  | 'RESOURCE'
  /** Some layer already turned this into an answer for a client. */
  | 'ANSWERED'
  /** Nothing in the chain said what it was. */
  | 'UNCLASSIFIED';

/** {@link TransactionErrorClassification}, plus the family the same traversal found. */
export interface TransactionFaultClassification extends TransactionErrorClassification {
  family: TransactionErrorFamily;
}

/**
 * Codes that mean "the server already rolled this transaction back" — the two SQLSTATEs, plus
 * Prisma's own name for the same event when the client is the one that reports it.
 *
 * A Map rather than an object literal because the keys are strings from an unknown error, and
 * `{}['constructor']` answers with something truthy.
 */
const TRANSIENT_CODES = new Map<string, TransientTransactionReason>([
  ['40001', 'SERIALIZATION'],
  ['40P01', 'DEADLOCK'],
  ['P2034', 'WRITE_CONFLICT'],
]);

/**
 * Codes that are an answer about one statement rather than about the transaction.
 *
 * A duplicate key or a missing parent row is a decision the data made; the second attempt reaches
 * exactly the same decision, so retrying only spends the caller's latency budget on a failure it
 * already has.
 */
const PERMANENT_CODES = new Set(['23503', '23505', 'P2002', 'P2003', 'P2025']);

/**
 * The SQLSTATE classes that mean the database itself is in trouble: `08` (the connection),
 * `53` (out of connections, memory or disk), `57` (cancelled, shutting down, dropped) and
 * `58` (the file system under it).
 *
 * Matched by class rather than by a list of codes, because the list is PostgreSQL's to extend and
 * the class is the part that carries the meaning. None of them is retried — re-running a unit of
 * work against a server that has no connections left only spends the caller's latency on the same
 * answer — but they are the one `retryable: false` that means somebody should be woken up, so the
 * counter has to be able to say so.
 *
 * `55P03` (`lock_not_available`) is deliberately NOT here. It is what a `FOR UPDATE NOWAIT` raises
 * when it declines to wait, which two paths in this codebase do on purpose and handle themselves;
 * it is a control-flow signal, not a fault.
 */
const RESOURCE_CLASS = /^(?:08|53|57|58)[0-9A-Z]{3}$/;

/**
 * Where a code hides. `code` is Prisma's and `pg`'s field; `originalCode` is the driver adapter's,
 * which is where the SQLSTATE of a failed raw query actually survives in Prisma 7 — the error the
 * caller catches says `P2010` ("raw query failed") and keeps PostgreSQL's own verdict two objects
 * down, at `meta.driverAdapterError.cause.originalCode`.
 */
const CODE_FIELDS = ['code', 'originalCode'] as const;
/** Where the driver's words hide when the structured code did not survive the wrapping at all. */
const TEXT_FIELDS = ['message', 'originalMessage', 'cause'] as const;

/** PostgreSQL's and Prisma's wording for the same two events, for wrappers that kept only text. */
const TRANSIENT_TEXT = /could not serialize access|write conflict|deadlock/i;
/** A bare SQLSTATE quoted inside a wrapper's message — Prisma's ``Code: `40001` `` shape. */
const TRANSIENT_SQLSTATE_TEXT = /(?:^|[^0-9A-Za-z])(40001|40P01)(?:[^0-9A-Za-z]|$)/i;

/** A cause chain is data from a library; treat its depth and width as untrusted. */
const MAX_CAUSE_DEPTH = 8;
const MAX_CAUSE_NODES = 32;

/**
 * How strong a signal is, when one chain carries several.
 *
 * An explicit transient SQLSTATE outranks a permanent code because it is a statement about the
 * *transaction*: once the server has aborted it, whatever a nested code says about a single
 * statement is about a statement that no longer happened. Text is the weakest — it is what is
 * left when a wrapper kept the words and dropped the structured fields.
 *
 * An `HttpException` anywhere in the chain outranks all of these and is answered on sight, not
 * ranked: some layer already turned this into an answer for a client, and re-running the
 * transaction would re-run the decision that produced it.
 */
const Rank = {
  TransientText: 1,
  PermanentCode: 2,
  TransientCode: 3,
} as const;
type Rank = (typeof Rank)[keyof typeof Rank];

interface Signal {
  rank: Rank;
  family: TransactionErrorFamily;
  reason?: TransientTransactionReason;
  evidence: string;
  depth: number;
}

/** The two links a wrapper can hold: the standard `cause`, and whatever Prisma put in `meta`. */
interface ErrorNode {
  cause?: unknown;
  meta?: unknown;
}

function metaOf(node: unknown): Record<string, unknown> | null {
  const meta = (node as ErrorNode | null)?.meta;
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null;
}

/** The string values `fields` holds on `node`, in order, skipping everything that is not one. */
function stringsAt(node: unknown, fields: readonly string[]): string[] {
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  return fields.map((field) => record[field]).filter((value): value is string => typeof value === 'string');
}

/** The strongest signal this one error object carries, ignoring anything it wraps. */
function signalOf(node: unknown, depth: number): Signal | null {
  const meta = metaOf(node);
  const codes = [...stringsAt(node, CODE_FIELDS), ...stringsAt(meta, CODE_FIELDS)];
  for (const code of codes) {
    const reason = TRANSIENT_CODES.get(code);
    if (reason) return { rank: Rank.TransientCode, family: 'TRANSIENT', reason, evidence: code, depth };
  }
  for (const code of codes) {
    if (PERMANENT_CODES.has(code)) {
      return { rank: Rank.PermanentCode, family: 'PERMANENT', evidence: code, depth };
    }
  }
  // After the permanent codes and at the same rank: both are answers this loop will not re-run,
  // and a chain that carries a named permanent code as well as a resource class is reporting the
  // statement that failed, which is the more specific of the two.
  for (const code of codes) {
    if (RESOURCE_CLASS.test(code)) {
      return { rank: Rank.PermanentCode, family: 'RESOURCE', evidence: code, depth };
    }
  }
  for (const text of [...stringsAt(node, TEXT_FIELDS), ...stringsAt(meta, TEXT_FIELDS)]) {
    const sqlstate = TRANSIENT_SQLSTATE_TEXT.exec(text)?.[1]?.toUpperCase();
    if (sqlstate) {
      return {
        rank: Rank.TransientText,
        family: 'TRANSIENT',
        reason: TRANSIENT_CODES.get(sqlstate),
        evidence: 'message',
        depth,
      };
    }
    if (TRANSIENT_TEXT.test(text)) {
      return {
        rank: Rank.TransientText,
        family: 'TRANSIENT',
        reason: /deadlock/i.test(text) ? 'DEADLOCK' : 'SERIALIZATION',
        evidence: 'message',
        depth,
      };
    }
  }
  return null;
}

/**
 * Decide whether an error means "the database threw this transaction away, run it again".
 *
 * The whole wrapper chain is read, because by the time an error leaves Prisma the SQLSTATE is
 * routinely two or three objects down: a raw query that lost a serialization check arrives as
 * `P2010` with PostgreSQL's `40001` at `meta.driverAdapterError.cause.originalCode`, and a
 * service that added context puts another wrapper on top of that. Traversal is breadth-first
 * over `cause` and over everything `meta` holds, with an identity set, a depth cap and a node
 * cap, so a chain that points back at itself — which `new Error(..., { cause })` makes trivially
 * easy to build — terminates instead of hanging the caller.
 */
export function classifyTransactionFault(cause: unknown): TransactionFaultClassification {
  const seen = new Set<unknown>();
  let queue: Array<{ node: unknown; depth: number }> = [{ node: cause, depth: 0 }];
  let visited = 0;
  let best: Signal | null = null;

  while (queue.length > 0 && visited < MAX_CAUSE_NODES) {
    const next: Array<{ node: unknown; depth: number }> = [];
    for (const { node, depth } of queue) {
      if (visited >= MAX_CAUSE_NODES) break;
      if (!node || typeof node !== 'object' || seen.has(node) || depth > MAX_CAUSE_DEPTH) continue;
      seen.add(node);
      visited += 1;

      if (node instanceof HttpException) {
        return { retryable: false, family: 'ANSWERED', evidence: `http:${node.getStatus()}`, depth };
      }
      const signal = signalOf(node, depth);
      if (signal && (!best || signal.rank > best.rank)) best = signal;

      // `cause` is the standard link. Everything `meta` holds is followed too, without naming
      // the field: Prisma's own wrapping puts the driver's error at `meta.driverAdapterError`
      // today and there is no promise it will stay called that.
      next.push({ node: (node as ErrorNode).cause, depth: depth + 1 });
      for (const value of Object.values(metaOf(node) ?? {})) next.push({ node: value, depth: depth + 1 });
    }
    queue = next;
  }

  if (!best || best.rank === Rank.PermanentCode) {
    return {
      retryable: false,
      family: best?.family ?? 'UNCLASSIFIED',
      evidence: best?.evidence,
      depth: best?.depth,
    };
  }
  return {
    retryable: true,
    family: 'TRANSIENT',
    reason: best.reason,
    evidence: best.evidence,
    depth: best.depth,
  };
}

/**
 * The retry verdict alone, which is what every caller that has to DECIDE something reads.
 *
 * One traversal, two readings: this drops the family from {@link classifyTransactionFault} rather
 * than deciding anything a second time, so "may I run it again" and "what kind of failure was it"
 * cannot come to inconsistent answers about the same error.
 */
export function classifyTransactionError(cause: unknown): TransactionErrorClassification {
  const { family: _family, ...verdict } = classifyTransactionFault(cause);
  return verdict;
}

/** Shorthand for callers — an error boundary, a log line — that only need the verdict. */
export function isTransientTransactionError(cause: unknown): boolean {
  return classifyTransactionFault(cause).retryable;
}

/** The `$transaction` options a caller chose. Every attempt is given the same ones. */
export interface TransactionOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
}

/**
 * The one method this module needs. Structural rather than `PrismaService` so a unit test can
 * hand it a transaction that fails on demand without a database.
 */
export interface TransactionRunner<TTx = Prisma.TransactionClient> {
  $transaction<T>(work: (tx: TTx) => Promise<T>, options?: TransactionOptions): Promise<T>;
}

/** Total attempts, including the first: three retries after the original. */
export const DEFAULT_TRANSACTION_MAX_ATTEMPTS = 4;
export const DEFAULT_TRANSACTION_BASE_DELAY_MS = 25;
export const DEFAULT_TRANSACTION_MAX_DELAY_MS = 400;
export const DEFAULT_TRANSACTION_JITTER_RATIO = 0.5;

export interface TransactionRetryPolicy {
  /** Total attempts, not retries. Must be >= 1; 1 disables retrying without disabling the API. */
  maxAttempts?: number;
  baseDelayMs?: number;
  /** The ceiling the exponential is clamped to before jitter, so waits stay bounded. */
  maxDelayMs?: number;
  /** 0 waits the full exponential, 1 waits anywhere from 0 to it. */
  jitterRatio?: number;
  /** Injected so a test can pin the jitter instead of asserting on a range. */
  random?: () => number;
  /** Injected so a test can record waits instead of serving them. */
  sleep?: (ms: number) => Promise<unknown>;
}

export interface TransactionAttemptEvent {
  label?: string;
  /** 1-based. */
  attempt: number;
  maxAttempts: number;
  /** Absent on the first attempt; otherwise what aborted the previous one, and the wait paid. */
  retryOf?: { reason?: TransientTransactionReason; evidence?: string; delayMs: number };
}

export type TransactionOutcome =
  /** The closure ran and `$transaction` committed. */
  | 'COMMITTED'
  /** Transient, and attempts are left: the same closure runs again after `delayMs`. */
  | 'RETRYING'
  /** Transient, but this was the last attempt. The error is rethrown unchanged. */
  | 'EXHAUSTED'
  /** Not transient. Rethrown unchanged without a second attempt. */
  | 'FAILED';

export interface TransactionOutcomeEvent {
  label?: string;
  attempt: number;
  maxAttempts: number;
  outcome: TransactionOutcome;
  reason?: TransientTransactionReason;
  evidence?: string;
  /** Only on `RETRYING`: how long until the next attempt starts. */
  delayMs?: number;
  /** Absent on `COMMITTED`. */
  error?: unknown;
}

export interface TransactionRetryOptions extends TransactionRetryPolicy {
  /** Names this unit of work in both hooks, so one log line can say what was retried. */
  label?: string;
  /** Handed to `$transaction` verbatim on every attempt. */
  transaction?: TransactionOptions;
  onAttempt?: (event: TransactionAttemptEvent) => void;
  onOutcome?: (event: TransactionOutcomeEvent) => void;
}

/**
 * The wait before attempt `attempt + 1`, in milliseconds.
 *
 * Bounded exponential with subtractive jitter: the exponential is clamped to `maxDelayMs` first,
 * and jitter can only shorten it, so the wait is never longer than the ceiling the caller set
 * and contenders that collided still spread out instead of colliding again in lockstep.
 */
export function transactionRetryDelayMs(attempt: number, policy: TransactionRetryPolicy = {}): number {
  const base = policy.baseDelayMs ?? DEFAULT_TRANSACTION_BASE_DELAY_MS;
  const ceiling = policy.maxDelayMs ?? DEFAULT_TRANSACTION_MAX_DELAY_MS;
  const ratio = Math.min(1, Math.max(0, policy.jitterRatio ?? DEFAULT_TRANSACTION_JITTER_RATIO));
  const random = policy.random ?? Math.random;
  const exponential = Math.min(ceiling, base * 2 ** (attempt - 1));
  return Math.max(0, Math.round(exponential - exponential * ratio * random()));
}

/** Hooks are telemetry. One that throws must not fail a transaction that already committed. */
function notify<E>(hook: ((event: E) => void) | undefined, event: E): void {
  if (!hook) return;
  try {
    hook(event);
  } catch {
    // Ignored on purpose: see above.
  }
}

/** The one method this module needs of a logger, so nothing here depends on Nest. */
export interface RetryLogger {
  warn(message: string): void;
}

/**
 * The line a retried transaction writes, and the only thing any caller says about one.
 *
 * There is one of these rather than one per service because a second local answer to "what does a
 * retry log look like" is a second thing to keep in step with the loop's own vocabulary. What a
 * caller supplies is the operation name; everything else on the line comes from the closed sets
 * this module defines — the outcome, the attempt counter, and the SQLSTATE (`40001`, `40P01`,
 * `P2034`, or the literal `message` when only the driver's wording survived the wrapping). Every
 * field is low-cardinality by construction, so this is safe to aggregate on.
 *
 * The error object itself is never logged. It is the one place a task's title, a prompt, a
 * parameter value or the failing SQL can appear, and a retried write is exactly the moment
 * somebody would think to include it.
 *
 * Only the outcomes that mean the database threw the transaction away are said out loud:
 * `FAILED` is the ordinary path of every validation refusal and every duplicate key, and a
 * first-attempt `COMMITTED` is the ordinary path of every write there is.
 */
export function loggedRetry(
  logger: RetryLogger,
  operation: string,
  policy: TransactionRetryPolicy & { transaction?: TransactionOptions } = {},
): TransactionRetryOptions {
  return {
    ...policy,
    label: operation,
    onOutcome: (event) => {
      if (event.outcome === 'FAILED') return;
      if (event.outcome === 'COMMITTED' && event.attempt === 1) return;
      logger.warn(
        `operation=${event.label} outcome=${event.outcome} ` +
          `attempt=${event.attempt}/${event.maxAttempts} sqlstate=${event.evidence ?? 'none'}`,
      );
    },
  };
}

/**
 * Run `work` inside a transaction, re-running the whole of it if PostgreSQL aborts it.
 *
 * Each attempt is a new `$transaction` call given the caller's original closure and the caller's
 * original options — a retry that reused the aborted transaction's client, or that resumed the
 * closure part-way, would be reading a snapshot the server has already discarded.
 *
 * Anything the classifier does not call transient is rethrown immediately and unchanged: this is
 * not a general-purpose retry, and a `ConflictException` or a unique-violation must reach the
 * caller on the first attempt.
 */
export async function withTransactionRetry<T, TTx = Prisma.TransactionClient>(
  runner: TransactionRunner<TTx>,
  work: (tx: TTx) => Promise<T>,
  options: TransactionRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_TRANSACTION_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer');
  }
  const sleep = options.sleep ?? delay;
  const { label } = options;
  let retryOf: TransactionAttemptEvent['retryOf'];
  // Counted from before the first attempt, so what the metric reports is what the caller waited:
  // every attempt, plus every backoff between them.
  const startedAt = performance.now();
  // The conflict this unit last paid for, so a unit that eventually commits can still say what it
  // was retried FOR. A committed unit's own error is `undefined`; the interesting fact about it is
  // the one it survived.
  let lastConflict: ConflictFacts | undefined;
  // Through `notify` for its reason: counting is telemetry, and telemetry that throws must not
  // fail a transaction the database already committed.
  const settle = (
    outcome: 'committed' | 'conflict' | 'failed',
    handling: 'none' | 'absorbed' | 'exhausted',
    attempts: number,
    error?: ConflictFacts,
  ) =>
    notify(recordTransactionUnit, {
      operation: label,
      outcome,
      handling,
      attempts,
      durationMs: performance.now() - startedAt,
      error,
    });

  for (let attempt = 1; ; attempt += 1) {
    notify(options.onAttempt, { label, attempt, maxAttempts, retryOf });
    try {
      const result = await runner.$transaction(work, options.transaction);
      notify(options.onOutcome, { label, attempt, maxAttempts, outcome: 'COMMITTED' });
      settle('committed', attempt === 1 ? 'none' : 'absorbed', attempt, lastConflict);
      return result;
    } catch (cause) {
      const verdict = classifyTransactionFault(cause);
      const facts: ConflictFacts = {
        family: verdict.family,
        reason: verdict.reason,
        evidence: verdict.evidence,
      };
      const base = {
        label,
        attempt,
        maxAttempts,
        reason: verdict.reason,
        evidence: verdict.evidence,
        error: cause,
      };
      if (!verdict.retryable) {
        notify(options.onOutcome, { ...base, outcome: 'FAILED' });
        settle('failed', 'none', attempt, facts);
        throw cause;
      }
      if (attempt >= maxAttempts) {
        notify(options.onOutcome, { ...base, outcome: 'EXHAUSTED' });
        settle('conflict', 'exhausted', attempt, facts);
        // The same object reaches the global boundary next. Marked so that boundary counts it as
        // the exhaustion it is, rather than as a path that never had a retry.
        markConflictCounted(cause);
        throw cause;
      }
      const delayMs = transactionRetryDelayMs(attempt, options);
      notify(options.onOutcome, { ...base, outcome: 'RETRYING', delayMs });
      retryOf = { reason: verdict.reason, evidence: verdict.evidence, delayMs };
      lastConflict = facts;
      await sleep(delayMs);
    }
  }
}
