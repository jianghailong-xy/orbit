import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  WATCH_ACTIONS,
  WATCH_DEAD_LETTER_CODES,
  WATCH_DELIVERY_STATES,
  WATCH_REFUSAL_CODES,
  WATCH_STATES,
  watchDeadLetterCodeOf,
  type WatchDeadLetterCode,
} from '@orbit/shared';
import {
  currentWatchRollout,
  WATCH_ROLLOUT_GATED_WRITES,
  WATCH_ROLLOUT_MODES,
  type WatchRolloutGatedWrite,
} from './watch-rollout';

/**
 * Watch counters, gauges and alerts, served at GET /api/metrics beside the database-conflict and Codex reset ones
 * (docs/watch-operations.md §3, §4).
 *
 * THREE KINDS OF NUMBER
 * - Counters are what this replica did: creates and refusals, evaluations and how long each due watch waited,
 *   delivery attempts, dead letters, effective wakes, the repeats it absorbed and the repairs reconciliation made.
 *   They start at zero with the process, and an operator sums them across replicas.
 * - Gauges are what the database holds when the endpoint is read: watches and deliveries by state, dead letters by
 *   code, how far behind the evaluator and the delivery worker are, and what was delivered in the last day. Every
 *   replica reads the same rows, so an operator takes their maximum.
 * - `orbit_watch_alert_firing` is each alert of docs/watch-operations.md §4 decided from those gauges, so an alert
 *   rule only asks whether it is 1, and the thresholds are the ones this file states.
 *
 * Every label value comes from a closed set — the contract's states, actions, refusal and dead-letter codes, or the
 * unions below — and never from a row: no watch, session, task or owner id is a label, and a value outside its set
 * is counted as `other`. Label values are therefore plain identifiers, which is why rendering escapes nothing.
 */

type Labels = Record<string, string>;

interface Counter {
  readonly name: string;
  readonly help: string;
  readonly series: Map<string, { labels: Labels; value: number }>;
}

/** Past this many label tuples, a counter folds anything new into one `overflow` series. */
export const WATCH_METRICS_MAX_SERIES = 256;
/** How far behind the evaluator or the delivery worker may fall before its alert fires. */
export const WATCH_ALERT_LAG_SECONDS = 120;
/** How long past its deadline an in-flight lease may stay untaken before its alert fires. */
export const WATCH_ALERT_STALLED_LEASE_SECONDS = 60;
/** Upper bounds, in seconds, of `orbit_watch_evaluation_delay_seconds`. */
export const WATCH_EVALUATION_DELAY_BUCKETS: readonly number[] = [0.1, 0.5, 1, 5, 15, 60, 300];

export type WatchCreateOutcome = 'created' | 'matched_at_create' | 'replayed';
export type WatchEvaluationCount = 'MATCHED' | 'EXPIRED' | 'UNRESOLVABLE' | 'REVOKED' | 'SCHEDULED' | 'SETTLED' | 'FAILED';
export type WatchDeliveryAttemptOutcome = 'DELIVERED' | 'RETRY' | 'DEAD_LETTER' | 'LEASE_LOST' | 'DEFERRED';
/**
 * create_replay: a create whose idempotency key had already made the watch, answered with that watch.
 * match: a landing that found its generation's Match already recorded, and adopted it.
 * settled_evaluation: an evaluation of a watch another landing had already settled.
 * wake_replay: a wake whose turn was already queued under its key, acknowledged without a second turn.
 * lease_lost: an attempt on a delivery another worker had taken over, which therefore wrote nothing.
 */
export type WatchDuplicateKind = 'create_replay' | 'match' | 'settled_evaluation' | 'wake_replay' | 'lease_lost';
/**
 * delivery_lease_expired: an in-flight delivery whose worker stopped before settling it, taken back by the sweep.
 * target_gone: a target whose row was deleted, recorded GONE by an evaluation, which no event announces.
 */
export type WatchRepairKind = 'delivery_lease_expired' | 'target_gone';
export type WatchRedriveOutcome = 'redriven' | 'refused';
export type WatchAlertSeverity = 'critical' | 'warning' | 'info';

const SETS = {
  create: ['created', 'matched_at_create', 'replayed'],
  evaluation: ['MATCHED', 'EXPIRED', 'UNRESOLVABLE', 'REVOKED', 'SCHEDULED', 'SETTLED', 'FAILED'],
  attempt: ['DELIVERED', 'RETRY', 'DEAD_LETTER', 'LEASE_LOST', 'DEFERRED'],
  duplicate: ['create_replay', 'match', 'settled_evaluation', 'wake_replay', 'lease_lost'],
  repair: ['delivery_lease_expired', 'target_gone'],
  redrive: ['redriven', 'refused'],
} satisfies Record<string, readonly string[]>;

function counter(name: string, help: string): Counter {
  return { name, help, series: new Map() };
}

const creates = counter(
  'orbit_watch_creates_total',
  'Watch creates that wrote or returned a watch, by outcome: a live watch, one matched at create, or an idempotency key replayed.',
);
const refusals = counter('orbit_watch_refusals_total', 'Watch creates and edits refused, by contract refusal code.');
const evaluations = counter(
  'orbit_watch_evaluations_total',
  'Watch evaluations, by outcome. FAILED: the evaluation threw, and the watch is due again when its lease lapses.',
);
const attempts = counter(
  'orbit_watch_delivery_attempts_total',
  'Delivery attempts, by outcome. DEFERRED: a continuous watch woke its observer too recently, and no attempt was counted on the row.',
);
const deadLetters = counter('orbit_watch_dead_letters_total', 'Deliveries that became dead letters, by dead-letter code.');
const effectiveWakes = counter(
  'orbit_watch_effective_wakes_total',
  'Deliveries acknowledged DELIVERED, a wake turn queued or a notification sent, by action.',
);
const duplicates = counter('orbit_watch_duplicates_suppressed_total', 'Repeats absorbed instead of acted on twice, by kind.');
const repairs = counter('orbit_watch_reconcile_repairs_total', 'What reconciliation put right that no event did, by kind.');
const redrives = counter('orbit_watch_redrives_total', 'Dead letters an owner asked to redrive, by outcome.');
const rolloutRefusals = counter(
  'orbit_watch_rollout_refusals_total',
  'Writes refused because Watch is not on for the account (ORBIT_WATCHES), by write: create, update, resume or redrive.',
);
const COUNTERS: readonly Counter[] = [
  creates,
  refusals,
  evaluations,
  attempts,
  deadLetters,
  effectiveWakes,
  duplicates,
  repairs,
  redrives,
  rolloutRefusals,
];

const evaluationDelay = { buckets: WATCH_EVALUATION_DELAY_BUCKETS.map(() => 0), count: 0, sum: 0 };

const log = new Logger('WatchMetrics');

/** `value` as a label: itself when it is in `values`, `other` otherwise. */
function label(values: readonly string[], value: string): string {
  return values.includes(value) ? value : 'other';
}

function bump(target: Counter, labels: Labels, by = 1): void {
  if (!(by > 0)) return;
  let key = JSON.stringify(labels);
  if (!target.series.has(key) && target.series.size >= WATCH_METRICS_MAX_SERIES) {
    labels = Object.fromEntries(Object.keys(labels).map((name) => [name, 'overflow']));
    key = JSON.stringify(labels);
  }
  const series = target.series.get(key) ?? { labels, value: 0 };
  series.value += by;
  target.series.set(key, series);
}

export function countWatchCreate(outcome: WatchCreateOutcome): void {
  bump(creates, { outcome: label(SETS.create, outcome) });
}

export function countWatchRolloutRefusal(write: WatchRolloutGatedWrite): void {
  bump(rolloutRefusals, { write: label(WATCH_ROLLOUT_GATED_WRITES, write) });
}

export function countWatchRefusal(code: string): void {
  bump(refusals, { code: label(WATCH_REFUSAL_CODES, code) });
}

export function countWatchEvaluation(outcome: WatchEvaluationCount): void {
  bump(evaluations, { outcome: label(SETS.evaluation, outcome) });
}

/** How long a watch had been due when its evaluation landed: the wait for a claim, and the evaluation itself. */
export function observeWatchEvaluationDelay(seconds: number): void {
  if (!Number.isFinite(seconds)) return;
  const observed = Math.max(0, seconds);
  evaluationDelay.count += 1;
  evaluationDelay.sum += observed;
  const bucket = WATCH_EVALUATION_DELAY_BUCKETS.findIndex((bound) => observed <= bound);
  if (bucket >= 0) evaluationDelay.buckets[bucket] += 1;
}

export function countWatchDeliveryAttempt(outcome: WatchDeliveryAttemptOutcome): void {
  bump(attempts, { outcome: label(SETS.attempt, outcome) });
}

export function countWatchDeadLetter(code: WatchDeadLetterCode): void {
  bump(deadLetters, { code: label(WATCH_DEAD_LETTER_CODES, code) });
}

export function countWatchEffectiveWake(action: string): void {
  bump(effectiveWakes, { action: label(WATCH_ACTIONS, action) });
}

export function countWatchDuplicateSuppressed(kind: WatchDuplicateKind): void {
  bump(duplicates, { kind: label(SETS.duplicate, kind) });
}

export function countWatchReconcileRepair(kind: WatchRepairKind, by = 1): void {
  bump(repairs, { kind: label(SETS.repair, kind) }, by);
}

export function countWatchRedrive(outcome: WatchRedriveOutcome): void {
  bump(redrives, { outcome: label(SETS.redrive, outcome) });
}

// ── gauges ──────────────────────────────────────────────────────────────────────────────────────

export interface WatchGauges {
  /** Watches on record, by state. */
  watches: Record<string, number>;
  /** Deliveries on record, by state. */
  deliveries: Record<string, number>;
  /** DEAD_LETTER deliveries by code: every one on record, and those dead-lettered in the last hour and 24 hours. */
  deadLetters: Record<'all' | '1h' | '24h', Record<WatchDeadLetterCode, number>>;
  /** Watches that ended EXPIRED, REVOKED or UNRESOLVABLE in the last 24 hours, by state. */
  endedLastDay: Record<string, number>;
  /** Deliveries DELIVERED in the last 24 hours and still standing, by action. */
  deliveredLastDay: Record<string, number>;
  /** How long the longest-due watch no evaluator has claimed has been due; 0 when none is. */
  evaluationLagSeconds: number;
  /** How long the longest-due PENDING delivery has been due; 0 when none is. */
  deliveryLagSeconds: number;
  /** In-flight deliveries whose lease ran out more than WATCH_ALERT_STALLED_LEASE_SECONDS ago. */
  stalledLeases: number;
}

type GaugeReader = Pick<PrismaClient, '$queryRaw'>;

interface GaugeRow {
  watches: Record<string, number>;
  deliveries: Record<string, number>;
  deadLetters: Array<{ code: string | null; attempts: number; lastHour: boolean; lastDay: boolean; n: number }>;
  endedLastDay: Record<string, number>;
  deliveredLastDay: Record<string, number>;
  evaluationLagSeconds: number;
  deliveryLagSeconds: number;
  stalledLeases: number;
}

/**
 * Every gauge, in one read-only statement. The lags come from the partial due indexes, so they stay cheap however
 * many watches are settled; the counts by state walk their tables, which is the scrape's cost to know.
 */
export async function readWatchGauges(db: GaugeReader): Promise<WatchGauges> {
  const [row] = await db.$queryRaw<GaugeRow[]>`
    SELECT
      (SELECT COALESCE(json_object_agg(s."state", s."n"), '{}'::json)
         FROM (SELECT "state", count(*)::int AS "n" FROM "watch" GROUP BY "state") AS s) AS "watches",
      (SELECT COALESCE(json_object_agg(s."state", s."n"), '{}'::json)
         FROM (SELECT "state", count(*)::int AS "n" FROM "watch_delivery" GROUP BY "state") AS s) AS "deliveries",
      (SELECT COALESCE(json_agg(g), '[]'::json)
         FROM (SELECT substring("last_error" FROM '^([A-Z][A-Z0-9_]*):') AS "code", "attempts",
                      "dead_lettered_at" > now() - interval '1 hour' AS "lastHour",
                      "dead_lettered_at" > now() - interval '24 hours' AS "lastDay",
                      count(*)::int AS "n"
                 FROM "watch_delivery"
                WHERE "state" = 'DEAD_LETTER'
                GROUP BY 1, 2, 3, 4) AS g) AS "deadLetters",
      (SELECT COALESCE(json_object_agg(e."state", e."n"), '{}'::json)
         FROM (SELECT "state", count(*)::int AS "n" FROM "watch"
                WHERE "state" IN ('EXPIRED', 'REVOKED', 'UNRESOLVABLE') AND "updated_at" > now() - interval '24 hours'
                GROUP BY "state") AS e) AS "endedLastDay",
      (SELECT COALESCE(json_object_agg(a."action", a."n"), '{}'::json)
         FROM (SELECT "action", count(*)::int AS "n" FROM "watch_delivery"
                WHERE "state" = 'DELIVERED' AND "delivered_at" > now() - interval '24 hours'
                GROUP BY "action") AS a) AS "deliveredLastDay",
      (SELECT COALESCE(EXTRACT(EPOCH FROM now() - min("next_evaluate_at")), 0)::float8
         FROM "watch" WHERE "next_evaluate_at" <= now()) AS "evaluationLagSeconds",
      (SELECT COALESCE(EXTRACT(EPOCH FROM now() - min("next_attempt_at")), 0)::float8
         FROM "watch_delivery" WHERE "state" = 'PENDING' AND "next_attempt_at" <= now()) AS "deliveryLagSeconds",
      (SELECT count(*)::int FROM "watch_delivery"
        WHERE "state" = 'IN_FLIGHT'
          AND "lease_deadline_at" <= now() - ${WATCH_ALERT_STALLED_LEASE_SECONDS}::int * interval '1 second') AS "stalledLeases"`;
  const zero = () => Object.fromEntries(WATCH_DEAD_LETTER_CODES.map((code) => [code, 0])) as Record<WatchDeadLetterCode, number>;
  const byCode = { all: zero(), '1h': zero(), '24h': zero() };
  for (const group of row.deadLetters) {
    const code = watchDeadLetterCodeOf(group.code === null ? null : `${group.code}:`, group.attempts);
    byCode.all[code] += group.n;
    if (group.lastHour) byCode['1h'][code] += group.n;
    if (group.lastDay) byCode['24h'][code] += group.n;
  }
  return {
    watches: row.watches,
    deliveries: row.deliveries,
    deadLetters: byCode,
    endedLastDay: row.endedLastDay,
    deliveredLastDay: row.deliveredLastDay,
    evaluationLagSeconds: Number(row.evaluationLagSeconds),
    deliveryLagSeconds: Number(row.deliveryLagSeconds),
    stalledLeases: Number(row.stalledLeases),
  };
}

// ── alerts ──────────────────────────────────────────────────────────────────────────────────────

/** Dead letters that say delivery itself is failing, rather than that a guard or the observer's own life stopped it. */
const DELIVERY_FAILURES: readonly WatchDeadLetterCode[] = [
  'ATTEMPTS_EXHAUSTED',
  'LEASE_EXPIRED',
  'TURN_REFUSED',
  'OBSERVER_SESSION_UNAVAILABLE',
  'OTHER',
];

/** The alerts of docs/watch-operations.md §4, each decided from one read of the gauges. */
export const WATCH_ALERTS: ReadonlyArray<{
  alert: string;
  severity: WatchAlertSeverity;
  firing: (gauges: WatchGauges) => boolean;
}> = [
  { alert: 'WatchEvaluationLagging', severity: 'critical', firing: (g) => g.evaluationLagSeconds > WATCH_ALERT_LAG_SECONDS },
  { alert: 'WatchDeliveryLagging', severity: 'critical', firing: (g) => g.deliveryLagSeconds > WATCH_ALERT_LAG_SECONDS },
  { alert: 'WatchDeliveryLeaseStalled', severity: 'critical', firing: (g) => g.stalledLeases > 0 },
  { alert: 'WatchWakeStorm', severity: 'critical', firing: (g) => g.deadLetters['1h'].WAKE_STORM_SUPPRESSED > 0 },
  { alert: 'WatchWakeBudgetExhausted', severity: 'warning', firing: (g) => g.deadLetters['24h'].WAKE_BUDGET_EXHAUSTED > 0 },
  { alert: 'WatchDeliveryFailing', severity: 'warning', firing: (g) => DELIVERY_FAILURES.some((code) => g.deadLetters['24h'][code] > 0) },
  {
    alert: 'WatchPermissionRevoked',
    severity: 'warning',
    firing: (g) => g.deadLetters['24h'].PERMISSION_REVOKED > 0 || (g.endedLastDay.REVOKED ?? 0) > 0,
  },
  { alert: 'WatchUnresolvable', severity: 'info', firing: (g) => (g.endedLastDay.UNRESOLVABLE ?? 0) > 0 },
];

/** The names of the alerts `gauges` fire, in the order docs/watch-operations.md §4 lists them. */
export function firingWatchAlerts(gauges: WatchGauges): string[] {
  return WATCH_ALERTS.filter(({ firing }) => firing(gauges)).map(({ alert }) => alert);
}

// ── exposition ──────────────────────────────────────────────────────────────────────────────────

/**
 * Everything, in Prometheus text exposition format: the counters and the evaluation-delay histogram always, and —
 * given a database — the gauges and the alerts. A gauge read that fails says so as `orbit_watch_gauges_up 0`
 * instead of failing the scrape, so the counters stay readable while the database is not.
 */
export async function renderWatchMetrics(db?: GaugeReader): Promise<string> {
  const lines: string[] = [];
  for (const target of COUNTERS) {
    lines.push(`# HELP ${target.name} ${target.help}`, `# TYPE ${target.name} counter`);
    for (const { labels, value } of target.series.values()) lines.push(`${target.name}${labelText(labels)} ${value}`);
  }
  const delay = 'orbit_watch_evaluation_delay_seconds';
  lines.push(
    `# HELP ${delay} How long a watch had been due when its evaluation landed: the wait for a claim, and the evaluation.`,
    `# TYPE ${delay} histogram`,
  );
  let cumulative = 0;
  WATCH_EVALUATION_DELAY_BUCKETS.forEach((bound, index) => {
    cumulative += evaluationDelay.buckets[index];
    lines.push(`${delay}_bucket{le="${bound}"} ${cumulative}`);
  });
  lines.push(`${delay}_bucket{le="+Inf"} ${evaluationDelay.count}`, `${delay}_sum ${evaluationDelay.sum}`, `${delay}_count ${evaluationDelay.count}`);
  const wakes = total(effectiveWakes);
  if (wakes > 0) {
    gauge(
      lines,
      'orbit_watch_cost_per_effective_wake',
      'Evaluations and delivery attempts this replica spent per delivery it acknowledged DELIVERED, since it started.',
      [
        [{ unit: 'evaluations' }, total(evaluations) / wakes],
        [{ unit: 'delivery_attempts' }, total(attempts) / wakes],
      ],
    );
  }
  // Read from this process's environment, not the database: replicas restarted with different flags disagree here.
  const rollout = currentWatchRollout();
  gauge(
    lines,
    'orbit_watch_rollout',
    'How far Watch is switched on in this replica (ORBIT_WATCHES): 1 for its mode, 0 for every other.',
    WATCH_ROLLOUT_MODES.map((mode): [Labels, number] => [{ mode }, mode === rollout.mode ? 1 : 0]),
  );
  gauge(
    lines,
    'orbit_watch_rollout_canary_owners',
    'Accounts ORBIT_WATCHES_CANARY_OWNERS lets watch in this replica; 0 unless the mode is canary.',
    [[{}, rollout.canaryOwners.size]],
  );
  if (db) lines.push(...(await gaugeLines(db)));
  return `${lines.join('\n')}\n`;
}

async function gaugeLines(db: GaugeReader): Promise<string[]> {
  const lines: string[] = [];
  const up = 'Whether the Watch gauges could be read from the database on this scrape.';
  let gauges: WatchGauges;
  try {
    gauges = await readWatchGauges(db);
  } catch (error) {
    log.warn(`watch gauges could not be read: ${error instanceof Error ? error.message : error}`);
    gauge(lines, 'orbit_watch_gauges_up', up, [[{}, 0]]);
    return lines;
  }
  gauge(lines, 'orbit_watch_gauges_up', up, [[{}, 1]]);
  gauge(lines, 'orbit_watch_watches', 'Watches on record, by state.', closed(WATCH_STATES, gauges.watches, 'state'));
  gauge(lines, 'orbit_watch_deliveries', 'Deliveries on record, by state.', closed(WATCH_DELIVERY_STATES, gauges.deliveries, 'state'));
  gauge(
    lines,
    'orbit_watch_dead_letter_backlog',
    'DEAD_LETTER deliveries on record, by dead-letter code.',
    WATCH_DEAD_LETTER_CODES.map((code): [Labels, number] => [{ code }, gauges.deadLetters.all[code]]),
  );
  gauge(
    lines,
    'orbit_watch_dead_letters_recent',
    'Deliveries dead-lettered in the last hour and the last 24 hours, by dead-letter code.',
    (['1h', '24h'] as const).flatMap((window) =>
      WATCH_DEAD_LETTER_CODES.map((code): [Labels, number] => [{ window, code }, gauges.deadLetters[window][code]]),
    ),
  );
  gauge(
    lines,
    'orbit_watch_ended_recent',
    'Watches that ended EXPIRED, REVOKED or UNRESOLVABLE in the last 24 hours, by state.',
    (['EXPIRED', 'REVOKED', 'UNRESOLVABLE'] as const).map((state): [Labels, number] => [{ window: '24h', state }, gauges.endedLastDay[state] ?? 0]),
  );
  gauge(
    lines,
    'orbit_watch_delivered_recent',
    'Deliveries DELIVERED in the last 24 hours and still standing, the effective wakes and notifications, by action.',
    WATCH_ACTIONS.map((action): [Labels, number] => [{ window: '24h', action }, gauges.deliveredLastDay[action] ?? 0]),
  );
  gauge(lines, 'orbit_watch_evaluation_lag_seconds', 'How long the longest-due watch no evaluator has claimed has been due; 0 when none is.', [
    [{}, gauges.evaluationLagSeconds],
  ]);
  gauge(lines, 'orbit_watch_delivery_lag_seconds', 'How long the longest-due PENDING delivery has been due; 0 when none is.', [
    [{}, gauges.deliveryLagSeconds],
  ]);
  gauge(
    lines,
    'orbit_watch_delivery_leases_stalled',
    `In-flight deliveries whose lease ran out more than ${WATCH_ALERT_STALLED_LEASE_SECONDS}s ago and that nothing took back.`,
    [[{}, gauges.stalledLeases]],
  );
  gauge(
    lines,
    'orbit_watch_alert_firing',
    'Each alert of docs/watch-operations.md section 4: 1 while its condition holds.',
    WATCH_ALERTS.map(({ alert, severity, firing }): [Labels, number] => [{ alert, severity }, firing(gauges) ? 1 : 0]),
  );
  return lines;
}

/** One series per value of a closed set, zero when absent, and whatever the rows hold outside it as `other`. */
function closed(values: readonly string[], counts: Record<string, number>, name: string): Array<[Labels, number]> {
  const series = values.map((value): [Labels, number] => [{ [name]: value }, counts[value] ?? 0]);
  const other = Object.entries(counts)
    .filter(([value]) => !values.includes(value))
    .reduce((sum, [, count]) => sum + count, 0);
  if (other > 0) series.push([{ [name]: 'other' }, other]);
  return series;
}

function gauge(lines: string[], name: string, help: string, series: ReadonlyArray<readonly [Labels, number]>): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  for (const [labels, value] of series) lines.push(`${name}${labelText(labels)} ${value}`);
}

function labelText(labels: Labels): string {
  const pairs = Object.entries(labels).map(([name, value]) => `${name}="${value}"`);
  return pairs.length > 0 ? `{${pairs.join(',')}}` : '';
}

function total(target: Counter): number {
  let sum = 0;
  for (const { value } of target.series.values()) sum += value;
  return sum;
}

/** Every counter series and the histogram, copied. For tests. */
export function watchMetricsSnapshot(): {
  counters: Record<string, Array<{ labels: Labels; value: number }>>;
  evaluationDelay: { buckets: number[]; count: number; sum: number };
} {
  return {
    counters: Object.fromEntries(
      COUNTERS.map((target) => [target.name, [...target.series.values()].map(({ labels, value }) => ({ labels: { ...labels }, value }))]),
    ),
    evaluationDelay: { buckets: [...evaluationDelay.buckets], count: evaluationDelay.count, sum: evaluationDelay.sum },
  };
}

/** Empty every counter and the histogram. For tests; nothing in the server calls it. */
export function resetWatchMetrics(): void {
  for (const target of COUNTERS) target.series.clear();
  evaluationDelay.buckets.fill(0);
  evaluationDelay.count = 0;
  evaluationDelay.sum = 0;
}
