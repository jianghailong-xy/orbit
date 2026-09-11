import {
  CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES,
  CODEX_RATE_LIMIT_RESET_ENUMS,
  type CodexRateLimitResetFailureCode,
  type CodexRateLimitResetOperationStatus,
  type CodexRateLimitResetPhase,
  type CodexRateLimitResetRefusalCode,
  type CodexRateLimitResetResultKind,
  type CodexResetDispatch,
  type CodexResetSnapshotOrder,
} from '@orbit/shared';

/**
 * Codex rate-limit reset counters, served at GET /api/metrics beside the database-conflict ones
 * (docs/codex-rate-limit-reset-runbook.md). The log lines of codex-reset-log.ts tell one operation's history;
 * these count the same events, so that "results are being refused", "operations settle UNRESOLVED" and "a runner
 * reported a spent credit no operation records" are numbers an operator can alert on.
 *
 * Every label value comes from a closed set, the contract's vocabulary or the unions below, never from a
 * caller's data: no operation, runner or owner id is a label. A value outside its set is counted as `other`, and
 * past CODEX_RESET_METRICS_MAX_SERIES tuples a counter folds anything new into one `overflow` series. Label values
 * are therefore plain identifiers, which is why rendering escapes nothing.
 */

type Labels = Record<string, string>;

interface Counter {
  readonly name: string;
  readonly help: string;
  readonly series: Map<string, { labels: Labels; value: number }>;
}

/** Past this many label tuples, a counter stops growing and says so. */
export const CODEX_RESET_METRICS_MAX_SERIES = 256;

export type CodexResetAdmission = 'created' | 'replayed' | 'refused' | 'invalid';
export type CodexResetDispatchDecision = 'claimed' | 'taken_over' | 'renewed' | 'settled' | 'none';
export type CodexResetNoneReason = Extract<CodexResetDispatch, { kind: 'NONE' }>['reason'];
export type CodexResetResultAnswer = 'APPLIED' | 'DUPLICATE' | 'REFUSED';
export type CodexResetSnapshotSource = 'heartbeat' | 'refreshed';
export type CodexResetSnapshotWrite = CodexResetSnapshotOrder | 'cas_exhausted' | 'no_codex_snapshot';
/**
 * consumed_outcome_after_settlement: a runner reports reset or alreadyRedeemed for an operation already settled
 *   without that spend (UNRESOLVED, NOT_ATTEMPTED, NOTHING_TO_RESET, NO_CREDIT) — a credit the operation does not
 *   show was spent.
 * consumed_outcome_from_stale_claim: the same from a claim that was taken over; benign when the current claim
 *   records the same key's alreadyRedeemed.
 * outcome_conflict: a result contradicting the recorded outcome.
 */
export type CodexResetAnomaly = 'consumed_outcome_after_settlement' | 'consumed_outcome_from_stale_claim' | 'outcome_conflict';

const NONE_REASONS: Readonly<Record<CodexResetNoneReason, true>> = {
  SETTLED: true,
  RUNNER_MISMATCH: true,
  NO_ACTIVE_LEASE: true,
  CAPABILITY_MISSING: true,
  RUNNER_DRAINING: true,
  SNAPSHOT_MISSING: true,
  CLAIM_HELD: true,
  DEADLINE_PASSED: true,
};

const SETS = {
  admission: ['created', 'replayed', 'refused', 'invalid'],
  decision: ['claimed', 'taken_over', 'renewed', 'settled', 'none'],
  dispatchReason: [...Object.keys(NONE_REASONS), ...CODEX_RATE_LIMIT_RESET_ENUMS.failureCode],
  answer: ['APPLIED', 'DUPLICATE', 'REFUSED'],
  resultCode: [
    ...CODEX_RATE_LIMIT_RESET_ENUMS.resultCode,
    ...CODEX_RATE_LIMIT_RESET_ENUMS.resultRejection,
    ...CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES,
  ],
  snapshotSource: ['heartbeat', 'refreshed'],
  snapshotWrite: [...CODEX_RATE_LIMIT_RESET_ENUMS.snapshotOrder, 'cas_exhausted', 'no_codex_snapshot'],
  anomaly: ['consumed_outcome_after_settlement', 'consumed_outcome_from_stale_claim', 'outcome_conflict'],
} satisfies Record<string, readonly string[]>;

function counter(name: string, help: string): Counter {
  return { name, help, series: new Map() };
}

const admissions = counter('orbit_codex_reset_admissions_total', 'Reset confirmations, by what admission made of them.');
const dispatches = counter('orbit_codex_reset_dispatch_total', 'What a heartbeat did to each active reset operation of its runner.');
const results = counter('orbit_codex_reset_results_total', 'Runner results for reset operations, by the answer each got.');
const settlements = counter('orbit_codex_reset_settlements_total', 'Reset operations that settled, by status and failure code.');
const snapshots = counter(
  'orbit_codex_reset_snapshot_writes_total',
  'Codex reset blocks offered to Runner.planUsage, by how each compared with the stored one.',
);
const anomalies = counter(
  'orbit_codex_reset_anomalies_total',
  'Refused results that report a spent credit, or that contradict the recorded outcome.',
);
const COUNTERS: readonly Counter[] = [admissions, dispatches, results, settlements, snapshots, anomalies];

/** `value` as a label: itself when it is in `values`, `none` when there is none, `other` otherwise. */
function label(values: readonly string[], value: string | null | undefined): string {
  if (value === null || value === undefined) return 'none';
  return values.includes(value) ? value : 'other';
}

function bump(target: Counter, labels: Labels): void {
  let key = JSON.stringify(labels);
  if (!target.series.has(key) && target.series.size >= CODEX_RESET_METRICS_MAX_SERIES) {
    labels = Object.fromEntries(Object.keys(labels).map((name) => [name, 'overflow']));
    key = JSON.stringify(labels);
  }
  const series = target.series.get(key) ?? { labels, value: 0 };
  series.value += 1;
  target.series.set(key, series);
}

export function countCodexResetAdmission(result: CodexResetAdmission, code: CodexRateLimitResetRefusalCode | null = null): void {
  bump(admissions, { result: label(SETS.admission, result), code: label(CODEX_RATE_LIMIT_RESET_ENUMS.refusalCode, code) });
}

export function countCodexResetDispatch(
  decision: CodexResetDispatchDecision,
  phase: CodexRateLimitResetPhase | null,
  reason: CodexResetNoneReason | CodexRateLimitResetFailureCode | null = null,
): void {
  bump(dispatches, {
    decision: label(SETS.decision, decision),
    phase: label(CODEX_RATE_LIMIT_RESET_ENUMS.phase, phase),
    reason: label(SETS.dispatchReason, reason),
  });
}

export function countCodexResetResult(kind: CodexRateLimitResetResultKind | null, answer: CodexResetResultAnswer, code: string | null = null): void {
  bump(results, {
    kind: label(CODEX_RATE_LIMIT_RESET_ENUMS.resultKind, kind),
    answer: label(SETS.answer, answer),
    code: label(SETS.resultCode, code),
  });
}

export function countCodexResetSettlement(
  status: CodexRateLimitResetOperationStatus | null,
  failureCode: CodexRateLimitResetFailureCode | null,
): void {
  bump(settlements, {
    status: label(CODEX_RATE_LIMIT_RESET_ENUMS.operationStatus, status),
    failure_code: label(CODEX_RATE_LIMIT_RESET_ENUMS.failureCode, failureCode),
  });
}

export function countCodexResetSnapshotWrite(source: CodexResetSnapshotSource, write: CodexResetSnapshotWrite): void {
  bump(snapshots, { source: label(SETS.snapshotSource, source), order: label(SETS.snapshotWrite, write) });
}

export function countCodexResetAnomaly(anomaly: CodexResetAnomaly): void {
  bump(anomalies, { anomaly: label(SETS.anomaly, anomaly) });
}

/** The counters in Prometheus text exposition format, each with its HELP and TYPE even before its first count. */
export function renderCodexResetMetrics(): string {
  const lines: string[] = [];
  for (const target of COUNTERS) {
    lines.push(`# HELP ${target.name} ${target.help}`, `# TYPE ${target.name} counter`);
    for (const { labels, value } of target.series.values()) {
      const pairs = Object.entries(labels).map(([name, text]) => `${name}="${text}"`);
      lines.push(`${target.name}{${pairs.join(',')}} ${value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Every series by counter name, copied. For tests and the fault-injection harness. */
export function codexResetMetricsSnapshot(): Record<string, Array<{ labels: Labels; value: number }>> {
  return Object.fromEntries(
    COUNTERS.map((target) => [target.name, [...target.series.values()].map(({ labels, value }) => ({ labels: { ...labels }, value }))]),
  );
}

/** Empty every counter. For tests; nothing in the server calls it. */
export function resetCodexResetMetrics(): void {
  for (const target of COUNTERS) target.series.clear();
}
