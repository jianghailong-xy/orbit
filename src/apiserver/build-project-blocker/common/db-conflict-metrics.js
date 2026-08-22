"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DURATION_BUCKETS_MS = exports.MAX_SERIES = void 0;
exports.markConflictCounted = markConflictCounted;
exports.conflictWasCounted = conflictWasCounted;
exports.classifierOf = classifierOf;
exports.recordTransactionUnit = recordTransactionUnit;
exports.recordConflictResponse = recordConflictResponse;
exports.dbConflictMetricsSnapshot = dbConflictMetricsSnapshot;
exports.resetDbConflictMetrics = resetDbConflictMetrics;
exports.renderDbConflictMetrics = renderDbConflictMetrics;
/** Past this many distinct label tuples, a metric stops growing and says so. */
exports.MAX_SERIES = 512;
/**
 * Milliseconds. A conflict clears in single digits and a retried unit pays a bounded backoff on top
 * of its own work, so the interesting range is "did this cost a caller anything": the buckets are
 * dense where that is decided and stop where every answer is already yes.
 */
exports.DURATION_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000];
const OPERATION = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/;
const OPERATION_MAX = 64;
/**
 * The highest attempt number that gets its own label value.
 *
 * Every unit in the tree declares an attempt budget of four or fewer, so this is never reached in
 * practice; it is here so the bound is a property of the metric rather than of a convention that
 * a future caller's `maxAttempts` could quietly break.
 */
const ATTEMPT_MAX = 99;
/** PostgreSQL's five characters, or Prisma's `P` and four digits. */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** What a failure some layer already answered carries instead of a code. */
const ANSWERED = /^http:[0-9]{3}$/;
/** A route TEMPLATE, never a URL: a query string carries the SSE and attachment tokens. */
const ROUTE = /^\/[A-Za-z0-9/:._-]*$/;
const ROUTE_MAX = 96;
const METHOD = /^[A-Z]{3,7}$/;
/** The literal the classifier uses when only the driver's wording survived the wrapping. */
const TEXT_EVIDENCE = 'message';
/** Where anything failing a shape test goes, so one bad value cannot become one bad series. */
const OTHER = 'other';
const units = new Map();
const responses = new Map();
const durations = new Map();
/**
 * The failures a retry loop already counted.
 *
 * A unit that spends its attempts records its own exhaustion and then throws; the same object
 * arrives at the global boundary a moment later. Without this the one conflict would be counted
 * twice and, worse, the second count would call it `boundary_only`, which is the label meaning
 * "this path has no retry at all" and is the one thing it is not.
 *
 * A WeakSet rather than a property on the error: nothing is added to an object that is about to be
 * logged, serialized or re-thrown, and an error nobody holds any more is collected as usual.
 */
const countedByRetryLoop = new WeakSet();
/** Record that a retry loop has already counted this failure. */
function markConflictCounted(error) {
    if (error && typeof error === 'object')
        countedByRetryLoop.add(error);
}
/** Whether a retry loop already counted it. See {@link markConflictCounted}. */
function conflictWasCounted(error) {
    return Boolean(error) && typeof error === 'object' && countedByRetryLoop.has(error);
}
function origin() {
    return process.env.ORBIT_DB_CONFLICT_ORIGIN === 'fault_injection' ? 'fault_injection' : 'service';
}
/** A caller-supplied operation name, or a constant when it is not the shape of one. */
function operationLabel(operation) {
    if (!operation)
        return 'unlabelled';
    return operation.length <= OPERATION_MAX && OPERATION.test(operation) ? operation : OTHER;
}
/** The code that decided the classification, reduced to one of the shapes a code comes in. */
function sqlstateLabel(evidence) {
    if (!evidence)
        return 'none';
    if (evidence === TEXT_EVIDENCE)
        return TEXT_EVIDENCE;
    return SQLSTATE.test(evidence) || ANSWERED.test(evidence) ? evidence : OTHER;
}
/** The family and, inside a transient one, which of the three events it was. */
function classifierOf(facts) {
    if (!facts)
        return 'none';
    switch (facts.family) {
        case 'TRANSIENT':
            if (facts.reason === 'DEADLOCK')
                return 'deadlock';
            if (facts.reason === 'SERIALIZATION')
                return 'serialization';
            if (facts.reason === 'WRITE_CONFLICT')
                return 'write_conflict';
            return 'unclassified';
        case 'RESOURCE':
            return 'resource';
        case 'PERMANENT':
            return 'permanent';
        case 'ANSWERED':
            return 'answered';
        default:
            return 'unclassified';
    }
}
function key(labels) {
    return Object.entries(labels)
        .map(([name, value]) => `${name}=${value}`)
        .join(' ');
}
/**
 * The series for these labels, or the one overflow series once the cap is reached.
 *
 * Overflow is a series and not a dropped sample so that a registry which hit its cap says so out
 * loud: an `overflow` counter climbing is the signal that something is putting variable text where
 * a label belongs, which is the failure the cap exists to contain.
 */
function seriesFor(store, labels, create) {
    const id = key(labels);
    const existing = store.get(id);
    if (existing)
        return existing;
    if (store.size >= exports.MAX_SERIES) {
        const overflow = {};
        for (const name of Object.keys(labels))
            overflow[name] = 'overflow';
        const overflowId = key(overflow);
        let series = store.get(overflowId);
        if (!series) {
            series = create(overflow);
            store.set(overflowId, series);
        }
        return series;
    }
    const created = create(labels);
    store.set(id, created);
    return created;
}
function count(store, labels) {
    seriesFor(store, labels, (own) => ({ labels: own, value: 0 })).value += 1;
}
function observe(labels, durationMs) {
    const series = seriesFor(durations, labels, (own) => ({
        labels: own,
        buckets: exports.DURATION_BUCKETS_MS.map(() => 0),
        sum: 0,
        count: 0,
    }));
    series.count += 1;
    series.sum += durationMs;
    for (let index = 0; index < exports.DURATION_BUCKETS_MS.length; index += 1) {
        if (durationMs <= exports.DURATION_BUCKETS_MS[index])
            series.buckets[index] += 1;
    }
}
/**
 * Count one settled unit of work: exactly one row, whatever happened inside it.
 *
 * One row per unit rather than one per attempt, because the questions this answers are about units.
 * What fraction of them paid for a conflict, what fraction failed, how long they took. `attempt`
 * carries what per-attempt counting would have said, and a total that is also the denominator of
 * every rate is worth more than a total that has to be reconstructed from one.
 */
function recordTransactionUnit(sample) {
    const shared = {
        operation: operationLabel(sample.operation),
        outcome: sample.outcome,
        handling: sample.handling,
        origin: origin(),
    };
    count(units, {
        ...shared,
        classifier: classifierOf(sample.error),
        sqlstate: sqlstateLabel(sample.error?.evidence),
        attempt: sample.attempts <= ATTEMPT_MAX ? String(sample.attempts) : `${ATTEMPT_MAX}+`,
    });
    // Without `classifier`, `sqlstate` or `attempt`: a histogram is eleven series per label tuple,
    // and what a duration is asked is "is this operation slow now", which those three do not change.
    observe(shared, sample.durationMs);
}
/**
 * Count one conflict answered at the API boundary.
 *
 * Separate from the unit counter because it answers a different question, how many CALLERS were
 * turned away, which is the number an availability alert is about; and because the boundary knows
 * the route while the retry loop knows the operation, and neither can supply the other's label.
 */
function recordConflictResponse(sample) {
    const route = sample.route;
    count(responses, {
        method: sample.method && METHOD.test(sample.method) ? sample.method : OTHER,
        route: route && route.length <= ROUTE_MAX && ROUTE.test(route) ? route : OTHER,
        handling: sample.handling,
        classifier: classifierOf(sample.error),
        sqlstate: sqlstateLabel(sample.error.evidence),
        origin: origin(),
    });
}
function dbConflictMetricsSnapshot() {
    const copy = (store) => [...store.values()].map((series) => ({ ...series, labels: { ...series.labels } }));
    return {
        units: copy(units),
        responses: copy(responses),
        durations: copy(durations).map((series) => ({ ...series, buckets: [...series.buckets] })),
    };
}
/** Empty the registry. For tests; nothing in the server calls it. */
function resetDbConflictMetrics() {
    units.clear();
    responses.clear();
    durations.clear();
}
const NAME_UNITS = 'orbit_db_transaction_units_total';
const NAME_RESPONSES = 'orbit_db_conflict_responses_total';
const NAME_DURATION = 'orbit_db_transaction_duration_ms';
/**
 * No escaping, on purpose: every value written here has already passed a shape test that admits no
 * quote, no backslash and no newline, so an escape pass would be dead code wearing the costume of a
 * safety net. If a shape ever widens, this is the line that has to widen with it.
 */
function render(labels, extra) {
    const pairs = Object.entries(labels).map(([name, value]) => `${name}="${value}"`);
    if (extra)
        pairs.push(`${extra[0]}="${extra[1]}"`);
    return `{${pairs.join(',')}}`;
}
/**
 * The registry in Prometheus text exposition format.
 *
 * Text rather than a shape of our own because every scraper, every `curl | grep` in the runbook and
 * every ad-hoc `promtool` already reads it, and a bespoke format would make the runbook's queries
 * specific to Orbit.
 */
function renderDbConflictMetrics() {
    const lines = [];
    lines.push(`# HELP ${NAME_UNITS} Database transactions that settled, by how their conflicts were handled.`, `# TYPE ${NAME_UNITS} counter`);
    for (const series of units.values()) {
        lines.push(`${NAME_UNITS}${render(series.labels)} ${series.value}`);
    }
    lines.push(`# HELP ${NAME_RESPONSES} Requests answered with the typed 503 because a conflict reached the API boundary.`, `# TYPE ${NAME_RESPONSES} counter`);
    for (const series of responses.values()) {
        lines.push(`${NAME_RESPONSES}${render(series.labels)} ${series.value}`);
    }
    lines.push(`# HELP ${NAME_DURATION} Wall time of a database transaction across every attempt and every backoff.`, `# TYPE ${NAME_DURATION} histogram`);
    for (const series of durations.values()) {
        exports.DURATION_BUCKETS_MS.forEach((bound, index) => {
            const bucket = render(series.labels, ['le', String(bound)]);
            lines.push(`${NAME_DURATION}_bucket${bucket} ${series.buckets[index]}`);
        });
        lines.push(`${NAME_DURATION}_bucket${render(series.labels, ['le', '+Inf'])} ${series.count}`);
        lines.push(`${NAME_DURATION}_sum${render(series.labels)} ${series.sum}`);
        lines.push(`${NAME_DURATION}_count${render(series.labels)} ${series.count}`);
    }
    return `${lines.join('\n')}\n`;
}
//# sourceMappingURL=db-conflict-metrics.js.map