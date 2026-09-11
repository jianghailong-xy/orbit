import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CODEX_RATE_LIMIT_RESET_ENUMS } from '@orbit/shared';

import { CODEX_RESET_LOG_REDACTED, codexResetErrorName, codexResetLogLine, type CodexResetLogFields } from './codex-reset-log';
import {
  CODEX_RESET_METRICS_MAX_SERIES,
  codexResetMetricsSnapshot,
  countCodexResetAdmission,
  countCodexResetAnomaly,
  countCodexResetDispatch,
  countCodexResetResult,
  countCodexResetSettlement,
  countCodexResetSnapshotWrite,
  renderCodexResetMetrics,
  resetCodexResetMetrics,
} from './codex-reset-metrics';

/**
 * The control plane's Codex rate-limit reset telemetry (codex-reset-log.ts, codex-reset-metrics.ts): a log line
 * carries an operation's history and nothing secret, and a counter's labels come from closed sets only. The
 * fault-injection harness (runner-api/codex-reset-fault-injection.pg.spec.ts) reads the same lines off a real
 * relay; this is what each line and counter may hold at all.
 */

const OPERATION = '018f6d2a-7c3e-7a41-9b2d-5e6f7a8b9c0d';
const RUNNER = '018f6d29-1111-7222-8333-944455566677';
const LEASE_OWNER = '6f1c2b7e-4d3a-4b8e-9c21-7a5e0d3f9b12';
const PROVIDER_KEY = '3d4e5f60-7182-4a93-8b04-c1d2e3f4a5b6';

const decode = (line: string): Record<string, unknown> => {
  assert.match(line, /^codex-reset \{/);
  return JSON.parse(line.slice('codex-reset '.length)) as Record<string, unknown>;
};

test('a line carries the operation, its process and the contract vocabulary, and the process as eight hex digits', () => {
  const line = decode(
    codexResetLogLine(
      'receipt',
      {
        event: 'answered',
        operationId: OPERATION,
        runnerId: RUNNER,
        process: LEASE_OWNER,
        phase: 'CONSUME',
        claimGeneration: 2,
        kind: 'CONSUME_OUTCOME',
        outcome: 'reset',
        disposition: 'APPLIED',
        from: 'CONSUMING',
        status: 'REFRESHING',
        next: 'REFRESH',
        replayed: false,
      },
      [PROVIDER_KEY],
    ),
  );
  assert.deepEqual(line, {
    stage: 'receipt',
    event: 'answered',
    operationId: OPERATION,
    runnerId: RUNNER,
    process: '6f1c2b7e',
    phase: 'CONSUME',
    claimGeneration: 2,
    kind: 'CONSUME_OUTCOME',
    outcome: 'reset',
    disposition: 'APPLIED',
    from: 'CONSUMING',
    status: 'REFRESHING',
    next: 'REFRESH',
    replayed: false,
  });
});

test('a value outside its field, or holding a named secret, is redacted, and a key that is no field is dropped', () => {
  const secrets = [PROVIDER_KEY, 'acct_fixture_primary', 'fixture@example.test', 'sk-live-orbit-test-token', 'orbit-runner-token-test'];
  const fields = {
    event: 'Bearer sk-live-orbit-test-token',
    operationId: PROVIDER_KEY,
    runnerId: 'acct_fixture_primary',
    process: 'fixture@example.test',
    phase: 'CONSUME\n',
    claimGeneration: -1,
    kind: 'consume',
    outcome: 'reset"}{"forged":true',
    code: 'orbit-runner-token-test',
    disposition: 'OK',
    from: 'CONSUMING',
    status: 'SUCCEEDED',
    next: 'NEVER',
    order: 'ACCEPT_ALL',
    reason: `token=${PROVIDER_KEY}`,
    error: 'connect ECONNREFUSED 10.0.0.1:5432',
    replayed: true,
    // Not fields: a message, a body, an account id, a fingerprint.
    message: 'sk-live-orbit-test-token',
    body: { providerIdempotencyKey: PROVIDER_KEY },
    accountId: 'acct_fixture_primary',
    accountFingerprint: 'cxa1_92381c922ad04574cc61964161fd5687',
  } as unknown as CodexResetLogFields;
  const text = codexResetLogLine('consume', fields, [PROVIDER_KEY]);
  for (const secret of [...secrets, 'cxa1_92381c922ad04574cc61964161fd5687']) {
    assert.equal(text.includes(secret), false, `${secret} reached ${text}`);
  }
  const line = decode(text);
  assert.deepEqual(Object.keys(line).sort(), [
    'claimGeneration', 'code', 'disposition', 'error', 'event', 'from', 'kind', 'next', 'operationId', 'order', 'outcome',
    'phase', 'process', 'reason', 'replayed', 'runnerId', 'stage', 'status',
  ]);
  for (const [field, value] of Object.entries(line)) {
    if (field === 'stage' || field === 'from' || field === 'status' || field === 'replayed') continue;
    assert.equal(value, CODEX_RESET_LOG_REDACTED, `${field} kept ${JSON.stringify(value)}`);
  }
  // A value any other line could carry is redacted where it holds the secret the caller named.
  assert.equal(decode(codexResetLogLine('delivery', { event: 'claimed', operationId: PROVIDER_KEY }, [PROVIDER_KEY])).operationId, CODEX_RESET_LOG_REDACTED);
  assert.equal(decode(codexResetLogLine('delivery', { event: 'claimed', operationId: PROVIDER_KEY })).operationId, PROVIDER_KEY);
});

test('an error is named by its code or class, never its message', () => {
  assert.equal(codexResetErrorName(Object.assign(new Error(`duplicate key ${PROVIDER_KEY}`), { code: 'P2002' })), 'P2002');
  assert.equal(codexResetErrorName(new TypeError(`fetch failed ${PROVIDER_KEY}`)), 'TypeError');
});

test('counters take labels from closed sets only, and render as Prometheus text', () => {
  resetCodexResetMetrics();
  countCodexResetAdmission('created');
  countCodexResetAdmission('refused', 'SNAPSHOT_STALE');
  countCodexResetDispatch('none', 'CONSUME', 'CLAIM_HELD');
  countCodexResetDispatch('renewed', 'CONSUME');
  countCodexResetDispatch('settled', 'REFRESH', 'REFRESH_EXPIRED');
  countCodexResetResult('CONSUME_OUTCOME', 'APPLIED', 'reset');
  countCodexResetResult('CONSUME_OUTCOME', 'APPLIED', 'reset');
  countCodexResetResult(null, 'REFUSED', 'INVALID_RESULT');
  countCodexResetSettlement('UNRESOLVED', 'ACCOUNT_CHANGED');
  countCodexResetSnapshotWrite('heartbeat', 'REJECT_OLDER');
  countCodexResetAnomaly('consumed_outcome_after_settlement');
  // A caller's data cast past the types lands in `other`, never in a label of its own.
  countCodexResetResult(OPERATION as never, 'APPLIED', PROVIDER_KEY);
  countCodexResetAdmission('refused', `${RUNNER}` as never);

  const body = renderCodexResetMetrics();
  for (const name of [
    'orbit_codex_reset_admissions_total',
    'orbit_codex_reset_dispatch_total',
    'orbit_codex_reset_results_total',
    'orbit_codex_reset_settlements_total',
    'orbit_codex_reset_snapshot_writes_total',
    'orbit_codex_reset_anomalies_total',
  ]) {
    assert.match(body, new RegExp(`^# HELP ${name} `, 'm'));
    assert.match(body, new RegExp(`^# TYPE ${name} counter$`, 'm'));
  }
  assert.ok(body.includes('orbit_codex_reset_results_total{kind="CONSUME_OUTCOME",answer="APPLIED",code="reset"} 2'), body);
  assert.ok(body.includes('orbit_codex_reset_dispatch_total{decision="none",phase="CONSUME",reason="CLAIM_HELD"} 1'), body);
  assert.ok(body.includes('orbit_codex_reset_results_total{kind="other",answer="APPLIED",code="other"} 1'), body);
  assert.ok(body.includes('orbit_codex_reset_admissions_total{result="refused",code="other"} 1'), body);
  for (const id of [OPERATION, RUNNER, PROVIDER_KEY]) assert.equal(body.includes(id), false, `${id} became a label`);

  const vocabulary = new Set<string>([
    'none', 'other', 'overflow', 'created', 'replayed', 'refused', 'invalid', 'claimed', 'taken_over', 'renewed', 'settled',
    'APPLIED', 'DUPLICATE', 'REFUSED', 'heartbeat', 'refreshed', 'cas_exhausted', 'no_codex_snapshot',
    'consumed_outcome_after_settlement', 'consumed_outcome_from_stale_claim', 'outcome_conflict', 'reset', 'nothingToReset',
    'noCredit', 'alreadyRedeemed', 'SETTLED', 'RUNNER_MISMATCH', 'NO_ACTIVE_LEASE', 'CAPABILITY_MISSING', 'RUNNER_DRAINING',
    'SNAPSHOT_MISSING', 'CLAIM_HELD', 'DEADLINE_PASSED',
    ...Object.values(CODEX_RATE_LIMIT_RESET_ENUMS).flat(),
  ]);
  for (const series of Object.values(codexResetMetricsSnapshot()).flat()) {
    for (const value of Object.values(series.labels)) assert.ok(vocabulary.has(value), `label value ${value} is not in a closed set`);
  }
});

test('a counter past its series cap folds anything new into one overflow series', () => {
  resetCodexResetMetrics();
  const kinds = CODEX_RATE_LIMIT_RESET_ENUMS.resultKind;
  // ACCOUNT_MISMATCH is both a result code and a rejection: count each tuple once, so every one is new.
  const codes = [...new Set([...CODEX_RATE_LIMIT_RESET_ENUMS.resultCode, ...CODEX_RATE_LIMIT_RESET_ENUMS.resultRejection])];
  let distinct = 0;
  for (const answer of ['APPLIED', 'DUPLICATE', 'REFUSED'] as const) {
    for (const kind of [null, ...kinds]) {
      for (const code of [null, ...codes, 'reset', 'noCredit']) {
        countCodexResetResult(kind, answer, code);
        distinct += 1;
      }
    }
  }
  assert.ok(distinct > CODEX_RESET_METRICS_MAX_SERIES, `${distinct} tuples do not reach the cap`);
  const series = codexResetMetricsSnapshot().orbit_codex_reset_results_total;
  assert.equal(series.length, CODEX_RESET_METRICS_MAX_SERIES + 1);
  const overflow = series.find((entry) => entry.labels.kind === 'overflow');
  assert.deepEqual(overflow?.labels, { kind: 'overflow', answer: 'overflow', code: 'overflow' });
  assert.equal(overflow?.value, distinct - CODEX_RESET_METRICS_MAX_SERIES);
  resetCodexResetMetrics();
});
