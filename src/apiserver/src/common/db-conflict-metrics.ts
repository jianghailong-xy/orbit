import type { TransactionErrorFamily, TransientTransactionReason } from './transaction-retry';

/**
 * What database conflicts cost, in numbers an operator can alert on.
 *
 * The log line `loggedRetry` writes says what happened to ONE transaction. That is the right shape
 * for reading an incident afterwards and the wrong shape for noticing one: nobody watches a log for
 * the moment a rate changes. These are the same events counted, so that "conflicts are up", "the
 * retries stopped absorbing them" and "callers are being answered 503" are three different numbers
 * rather than three readings of the same wall of text.
 *
 * WHAT THE LABELS MAY BE
 * ----------------------
 * Every label value here comes from a closed set or a shape test, never from a caller's data. That
 * is not a style rule: a label carrying a task id, a session id or a request id multiplies the
 * series count by the number of rows in the database, and the first thing that breaks is the
 * monitoring, at exactly the moment it is needed. So
 *
 *  - `operation`, the only caller-supplied value, is matched against a dotted-identifier shape and
 *    a length limit, and anything else becomes `other`;
 *  - `sqlstate` is matched against PostgreSQL's five-character shape, Prisma's `P` and four digits,
 *    the literal the classifier uses when only the driver's wording survived the wrapping, and the
 *    `http:<status>` an already-answered failure carries. Anything else becomes `other`;
 *  - `classifier`, `outcome`, `handling` and `origin` are TypeScript unions, so a new value cannot
 *    appear without this file changing;
 *  - and the registry is capped: past {@link MAX_SERIES} distinct label tuples a metric folds
 *    everything new into one `overflow` series rather than growing without a bound. A cap that is
 *    hit is itself visible, which is the point, because silently dropping would look like quiet.
 *
 * THE FIVE THINGS THIS HAS TO KEEP APART
 * --------------------------------------
 *  - a fault injected on purpose: `origin="fault_injection"`, set by a harness, never by a server;
 *  - contention a retry absorbed: `outcome="committed"`, `handling="absorbed"`, `attempt` above 1;
 *  - a lock-order defect: `handling="exhausted"` with `classifier="deadlock"`, repeatedly, on one
 *    operation, which is the shape backoff cannot fix because the cycle is in the code;
 *  - the database itself in trouble: `classifier="resource"`, which is never retried and is the
 *    one of these that means somebody should be woken up;
 *  - a path with no retry at all: `handling="boundary_only"`, where the 503 boundary is the only
 *    thing that saw the conflict.
 *
 * NOTHING HERE IS A DECISION. The retry loop retries what it retries and the boundary answers what
 * it answers; this counts. A number that changed the server's behaviour would be a second policy
 * hiding in the telemetry.
 */

/** What kind of failure a counter is about. */
export type ConflictClassifier =
  | 'none'
  | 'deadlock'
  | 'serialization'
  | 'write_conflict'
  | 'resource'
  | 'permanent'
  | 'answered'
  | 'unclassified';

/** How a unit of work ended. */
export type UnitOutcome =
  /** The closure ran and the transaction committed, with or without conflicts on the way. */
  | 'committed'
  /** A conflict outlived the attempts. */
  | 'conflict'
  /** Something that is not a conflict ended it. */
  | 'failed';

/** Who dealt with the conflict, and how far it got. */
export type ConflictHandling =
  /** There was no conflict. */
  | 'none'
  /** The retry loop re-ran the unit and it committed. The caller never saw it. */
  | 'absorbed'
  /** The retry loop ran out of attempts. The caller sees the typed 503. */
  | 'exhausted'
  /** No retry loop was involved; the global boundary is the only thing that saw it. */
  | 'boundary_only';

/**
 * Whether these numbers come from a server doing its job or from a test making conflicts on purpose.
 *
 * The barrier fixtures and the fault-injection suites produce real deadlocks, which is what they are
 * for, and a run of them against a process somebody is scraping looks exactly like an incident.
 * `ORBIT_DB_CONFLICT_ORIGIN=fault_injection` is how a harness says so. It is read from the
 * environment rather than threaded through every call because it is a property of the PROCESS: no
 * production code path can set it, so no production code path can label a real conflict expected.
 */
export type MetricsOrigin = 'service' | 'fault_injection';

/** What the traversal in `transaction-retry.ts` found, for the labels derived from it. */
export interface ConflictFacts {
  family: TransactionErrorFamily;
  reason?: TransientTransactionReason;
  /** A SQLSTATE, a Prisma code, or one of the classifier's own literals. */
  evidence?: string;
}

/** Past this many distinct label tuples, a metric stops growing and says so. */
export const MAX_SERIES = 512;

/**
 * Milliseconds. A conflict clears in single digits and a retried unit pays a bounded backoff on top
 * of its own work, so the interesting range is "did this cost a caller anything": the buckets are
 * dense where that is decided and stop where every answer is already yes.
 */
export const DURATION_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000] as const;

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

type Labels = Record<string, string>;

interface CounterSeries {
  labels: Labels;
  value: number;
}

interface HistogramSeries {
  labels: Labels;
  /** Cumulative, in `DURATION_BUCKETS_MS` order. The unbounded bucket is `count`. */
  buckets: number[];
  sum: number;
  count: number;
}

const units = new Map<string, CounterSeries>();
const responses = new Map<string, CounterSeries>();
const durations = new Map<string, HistogramSeries>();

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
const countedByRetryLoop = new WeakSet<object>();

/** Record that a retry loop has already counted this failure. */
export function markConflictCounted(error: unknown): void {
  if (error && typeof error === 'object') countedByRetryLoop.add(error);
}

/** Whether a retry loop already counted it. See {@link markConflictCounted}. */
export function conflictWasCounted(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && countedByRetryLoop.has(error as object);
}

function origin(): MetricsOrigin {
  return process.env.ORBIT_DB_CONFLICT_ORIGIN === 'fault_injection' ? 'fault_injection' : 'service';
}

/** A caller-supplied operation name, or a constant when it is not the shape of one. */
function operationLabel(operation: string | undefined): string {
  if (!operation) return 'unlabelled';
  return operation.length <= OPERATION_MAX && OPERATION.test(operation) ? operation : OTHER;
}

/** The code that decided the classification, reduced to one of the shapes a code comes in. */
function sqlstateLabel(evidence: string | undefined): string {
  if (!evidence) return 'none';
  if (evidence === TEXT_EVIDENCE) return TEXT_EVIDENCE;
  return SQLSTATE.test(evidence) || ANSWERED.test(evidence) ? evidence : OTHER;
}

/** The family and, inside a transient one, which of the three events it was. */
export function classifierOf(facts: ConflictFacts | undefined): ConflictClassifier {
  if (!facts) return 'none';
  switch (facts.family) {
    case 'TRANSIENT':
      if (facts.reason === 'DEADLOCK') return 'deadlock';
      if (facts.reason === 'SERIALIZATION') return 'serialization';
      if (facts.reason === 'WRITE_CONFLICT') return 'write_conflict';
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

function key(labels: Labels): string {
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
function seriesFor<T extends { labels: Labels }>(
  store: Map<string, T>,
  labels: Labels,
  create: (labels: Labels) => T,
): T {
  const id = key(labels);
  const existing = store.get(id);
  if (existing) return existing;
  if (store.size >= MAX_SERIES) {
    const overflow: Labels = {};
    for (const name of Object.keys(labels)) overflow[name] = 'overflow';
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

function count(store: Map<string, CounterSeries>, labels: Labels): void {
  seriesFor(store, labels, (own) => ({ labels: own, value: 0 })).value += 1;
}

function observe(labels: Labels, durationMs: number): void {
  const series = seriesFor(durations, labels, (own) => ({
    labels: own,
    buckets: DURATION_BUCKETS_MS.map(() => 0),
    sum: 0,
    count: 0,
  }));
  series.count += 1;
  series.sum += durationMs;
  for (let index = 0; index < DURATION_BUCKETS_MS.length; index += 1) {
    if (durationMs <= DURATION_BUCKETS_MS[index]) series.buckets[index] += 1;
  }
}

/** One unit of work, settled. */
export interface TransactionUnitSample {
  operation?: string;
  outcome: UnitOutcome;
  handling: ConflictHandling;
  /** Attempts spent, including the first. Bounded by the unit's own attempt budget. */
  attempts: number;
  /** Wall time across every attempt and every backoff between them. */
  durationMs: number;
  /** The last thing that went wrong, when something did. */
  error?: ConflictFacts;
}

/**
 * Count one settled unit of work: exactly one row, whatever happened inside it.
 *
 * One row per unit rather than one per attempt, because the questions this answers are about units.
 * What fraction of them paid for a conflict, what fraction failed, how long they took. `attempt`
 * carries what per-attempt counting would have said, and a total that is also the denominator of
 * every rate is worth more than a total that has to be reconstructed from one.
 */
export function recordTransactionUnit(sample: TransactionUnitSample): void {
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

/** One typed 503, served. */
export interface ConflictResponseSample {
  method?: string;
  /** The route TEMPLATE. */
  route?: string;
  handling: Extract<ConflictHandling, 'exhausted' | 'boundary_only'>;
  error: ConflictFacts;
}

/**
 * Count one conflict answered at the API boundary.
 *
 * Separate from the unit counter because it answers a different question, how many CALLERS were
 * turned away, which is the number an availability alert is about; and because the boundary knows
 * the route while the retry loop knows the operation, and neither can supply the other's label.
 */
export function recordConflictResponse(sample: ConflictResponseSample): void {
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

/** Everything the registry holds, for a test that has to assert on one number. */
export interface DbConflictMetricsSnapshot {
  units: CounterSeries[];
  responses: CounterSeries[];
  durations: HistogramSeries[];
}

export function dbConflictMetricsSnapshot(): DbConflictMetricsSnapshot {
  const copy = <T extends { labels: Labels }>(store: Map<string, T>): T[] =>
    [...store.values()].map((series) => ({ ...series, labels: { ...series.labels } }));
  return {
    units: copy(units),
    responses: copy(responses),
    durations: copy(durations).map((series) => ({ ...series, buckets: [...series.buckets] })),
  };
}

/** Empty the registry. For tests; nothing in the server calls it. */
export function resetDbConflictMetrics(): void {
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
function render(labels: Labels, extra?: [string, string]): string {
  const pairs = Object.entries(labels).map(([name, value]) => `${name}="${value}"`);
  if (extra) pairs.push(`${extra[0]}="${extra[1]}"`);
  return `{${pairs.join(',')}}`;
}

/**
 * The registry in Prometheus text exposition format.
 *
 * Text rather than a shape of our own because every scraper, every `curl | grep` in the runbook and
 * every ad-hoc `promtool` already reads it, and a bespoke format would make the runbook's queries
 * specific to Orbit.
 */
export function renderDbConflictMetrics(): string {
  const lines: string[] = [];

  lines.push(
    `# HELP ${NAME_UNITS} Database transactions that settled, by how their conflicts were handled.`,
    `# TYPE ${NAME_UNITS} counter`,
  );
  for (const series of units.values()) {
    lines.push(`${NAME_UNITS}${render(series.labels)} ${series.value}`);
  }

  lines.push(
    `# HELP ${NAME_RESPONSES} Requests answered with the typed 503 because a conflict reached the API boundary.`,
    `# TYPE ${NAME_RESPONSES} counter`,
  );
  for (const series of responses.values()) {
    lines.push(`${NAME_RESPONSES}${render(series.labels)} ${series.value}`);
  }

  lines.push(
    `# HELP ${NAME_DURATION} Wall time of a database transaction across every attempt and every backoff.`,
    `# TYPE ${NAME_DURATION} histogram`,
  );
  for (const series of durations.values()) {
    DURATION_BUCKETS_MS.forEach((bound, index) => {
      const bucket = render(series.labels, ['le', String(bound)]);
      lines.push(`${NAME_DURATION}_bucket${bucket} ${series.buckets[index]}`);
    });
    lines.push(`${NAME_DURATION}_bucket${render(series.labels, ['le', '+Inf'])} ${series.count}`);
    lines.push(`${NAME_DURATION}_sum${render(series.labels)} ${series.sum}`);
    lines.push(`${NAME_DURATION}_count${render(series.labels)} ${series.count}`);
  }

  return `${lines.join('\n')}\n`;
}
