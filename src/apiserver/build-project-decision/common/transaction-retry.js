"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TRANSACTION_JITTER_RATIO = exports.DEFAULT_TRANSACTION_MAX_DELAY_MS = exports.DEFAULT_TRANSACTION_BASE_DELAY_MS = exports.DEFAULT_TRANSACTION_MAX_ATTEMPTS = void 0;
exports.classifyTransactionFault = classifyTransactionFault;
exports.classifyTransactionError = classifyTransactionError;
exports.isTransientTransactionError = isTransientTransactionError;
exports.transactionRetryDelayMs = transactionRetryDelayMs;
exports.loggedRetry = loggedRetry;
exports.withTransactionRetry = withTransactionRetry;
const promises_1 = require("node:timers/promises");
const common_1 = require("@nestjs/common");
const db_conflict_metrics_1 = require("./db-conflict-metrics");
/**
 * Codes that mean "the server already rolled this transaction back" — the two SQLSTATEs, plus
 * Prisma's own name for the same event when the client is the one that reports it.
 *
 * A Map rather than an object literal because the keys are strings from an unknown error, and
 * `{}['constructor']` answers with something truthy.
 */
const TRANSIENT_CODES = new Map([
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
const CODE_FIELDS = ['code', 'originalCode'];
/** Where the driver's words hide when the structured code did not survive the wrapping at all. */
const TEXT_FIELDS = ['message', 'originalMessage', 'cause'];
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
};
function metaOf(node) {
    const meta = node?.meta;
    return meta && typeof meta === 'object' ? meta : null;
}
/** The string values `fields` holds on `node`, in order, skipping everything that is not one. */
function stringsAt(node, fields) {
    if (!node || typeof node !== 'object')
        return [];
    const record = node;
    return fields.map((field) => record[field]).filter((value) => typeof value === 'string');
}
/** The strongest signal this one error object carries, ignoring anything it wraps. */
function signalOf(node, depth) {
    const meta = metaOf(node);
    const codes = [...stringsAt(node, CODE_FIELDS), ...stringsAt(meta, CODE_FIELDS)];
    for (const code of codes) {
        const reason = TRANSIENT_CODES.get(code);
        if (reason)
            return { rank: Rank.TransientCode, family: 'TRANSIENT', reason, evidence: code, depth };
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
function classifyTransactionFault(cause) {
    const seen = new Set();
    let queue = [{ node: cause, depth: 0 }];
    let visited = 0;
    let best = null;
    while (queue.length > 0 && visited < MAX_CAUSE_NODES) {
        const next = [];
        for (const { node, depth } of queue) {
            if (visited >= MAX_CAUSE_NODES)
                break;
            if (!node || typeof node !== 'object' || seen.has(node) || depth > MAX_CAUSE_DEPTH)
                continue;
            seen.add(node);
            visited += 1;
            if (node instanceof common_1.HttpException) {
                return { retryable: false, family: 'ANSWERED', evidence: `http:${node.getStatus()}`, depth };
            }
            const signal = signalOf(node, depth);
            if (signal && (!best || signal.rank > best.rank))
                best = signal;
            // `cause` is the standard link. Everything `meta` holds is followed too, without naming
            // the field: Prisma's own wrapping puts the driver's error at `meta.driverAdapterError`
            // today and there is no promise it will stay called that.
            next.push({ node: node.cause, depth: depth + 1 });
            for (const value of Object.values(metaOf(node) ?? {}))
                next.push({ node: value, depth: depth + 1 });
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
function classifyTransactionError(cause) {
    const { family: _family, ...verdict } = classifyTransactionFault(cause);
    return verdict;
}
/** Shorthand for callers — an error boundary, a log line — that only need the verdict. */
function isTransientTransactionError(cause) {
    return classifyTransactionFault(cause).retryable;
}
/** Total attempts, including the first: three retries after the original. */
exports.DEFAULT_TRANSACTION_MAX_ATTEMPTS = 4;
exports.DEFAULT_TRANSACTION_BASE_DELAY_MS = 25;
exports.DEFAULT_TRANSACTION_MAX_DELAY_MS = 400;
exports.DEFAULT_TRANSACTION_JITTER_RATIO = 0.5;
/**
 * The wait before attempt `attempt + 1`, in milliseconds.
 *
 * Bounded exponential with subtractive jitter: the exponential is clamped to `maxDelayMs` first,
 * and jitter can only shorten it, so the wait is never longer than the ceiling the caller set
 * and contenders that collided still spread out instead of colliding again in lockstep.
 */
function transactionRetryDelayMs(attempt, policy = {}) {
    const base = policy.baseDelayMs ?? exports.DEFAULT_TRANSACTION_BASE_DELAY_MS;
    const ceiling = policy.maxDelayMs ?? exports.DEFAULT_TRANSACTION_MAX_DELAY_MS;
    const ratio = Math.min(1, Math.max(0, policy.jitterRatio ?? exports.DEFAULT_TRANSACTION_JITTER_RATIO));
    const random = policy.random ?? Math.random;
    const exponential = Math.min(ceiling, base * 2 ** (attempt - 1));
    return Math.max(0, Math.round(exponential - exponential * ratio * random()));
}
/** Hooks are telemetry. One that throws must not fail a transaction that already committed. */
function notify(hook, event) {
    if (!hook)
        return;
    try {
        hook(event);
    }
    catch {
        // Ignored on purpose: see above.
    }
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
function loggedRetry(logger, operation, policy = {}) {
    return {
        ...policy,
        label: operation,
        onOutcome: (event) => {
            if (event.outcome === 'FAILED')
                return;
            if (event.outcome === 'COMMITTED' && event.attempt === 1)
                return;
            logger.warn(`operation=${event.label} outcome=${event.outcome} ` +
                `attempt=${event.attempt}/${event.maxAttempts} sqlstate=${event.evidence ?? 'none'}`);
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
async function withTransactionRetry(runner, work, options = {}) {
    const maxAttempts = options.maxAttempts ?? exports.DEFAULT_TRANSACTION_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new RangeError('maxAttempts must be a positive integer');
    }
    const sleep = options.sleep ?? promises_1.setTimeout;
    const { label } = options;
    let retryOf;
    // Counted from before the first attempt, so what the metric reports is what the caller waited:
    // every attempt, plus every backoff between them.
    const startedAt = performance.now();
    // The conflict this unit last paid for, so a unit that eventually commits can still say what it
    // was retried FOR. A committed unit's own error is `undefined`; the interesting fact about it is
    // the one it survived.
    let lastConflict;
    // Through `notify` for its reason: counting is telemetry, and telemetry that throws must not
    // fail a transaction the database already committed.
    const settle = (outcome, handling, attempts, error) => notify(db_conflict_metrics_1.recordTransactionUnit, {
        operation: label,
        outcome,
        handling,
        attempts,
        durationMs: performance.now() - startedAt,
        error,
    });
    for (let attempt = 1;; attempt += 1) {
        notify(options.onAttempt, { label, attempt, maxAttempts, retryOf });
        try {
            const result = await runner.$transaction(work, options.transaction);
            notify(options.onOutcome, { label, attempt, maxAttempts, outcome: 'COMMITTED' });
            settle('committed', attempt === 1 ? 'none' : 'absorbed', attempt, lastConflict);
            return result;
        }
        catch (cause) {
            const verdict = classifyTransactionFault(cause);
            const facts = {
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
                (0, db_conflict_metrics_1.markConflictCounted)(cause);
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
//# sourceMappingURL=transaction-retry.js.map