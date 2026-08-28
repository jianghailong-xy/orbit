import { createHash } from 'node:crypto';

export const WATCHDOG_SIGNAL_CODES = [
  'RECONCILER_STOPPED',
  'PROJECTION_STALE',
  'OLDEST_ACTIVE_OBLIGATION',
  'LEASE_EXPIRED',
  'DEAD_LETTER_BACKLOG',
  'OUTBOX_BLOCKED',
  'SCHEDULER_STARVATION',
  'RETRY_STORM',
  'INBOX_STALE',
  'CHECKSUM_DRIFT',
] as const;

export type WatchdogSignalCode = (typeof WATCHDOG_SIGNAL_CODES)[number];

export const WATCHDOG_MAX_PAYLOAD_BYTES = 65_536;
export const WATCHDOG_MAX_RAW_COMMAND_OUTPUT_BYTES = 16_384;
export const WATCHDOG_REDACTION = '[REDACTED]';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const SECRET_KEY = /authorization|cookie|token|secret|password|private[_-]?key|api[_-]?key|credential/i;
const RAW_OUTPUT_KEY = /^(rawCommandOutput|commandOutput|stdout|stderr)$/i;
const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
  /([a-z][a-z0-9+.-]*:\/\/[^\s:/]+:)[^@\s/]+@/gi,
];

export interface WatchdogWindow {
  kind: 'ROLLING' | 'FIXED';
  seconds: number;
  logicalTicks: number;
}

export interface WatchdogMetricContract {
  window: WatchdogWindow;
  denominator: string;
  minSampleSize: number;
  threshold?: Record<string, number>;
  abortThreshold: Record<string, number>;
  collectorSha: 'RUNTIME_REQUIRED';
  targetSha: 'RUNTIME_REQUIRED';
}

export interface WatchdogContract {
  schemaVersion: number;
  collector: {
    pollIntervalSeconds: number;
    maximumDetectionDeltaSeconds: number;
    maximumDetectionDeltaLogicalTicks: number;
    maximumRowsPerProbe: number;
    checksumSubjectsPerProbe: number;
  };
  operationalSlo: WatchdogMetricContract & {
    name: string;
    objective: number;
    numerator: string;
  };
  metrics: Record<string, WatchdogMetricContract>;
  canary: {
    cohort: { rolloutBasisPoints: number; [key: string]: unknown };
    denominator: string;
    minSampleSize: number;
    observationWindow: WatchdogWindow;
    abortThreshold: Record<string, number>;
    collectorSha: 'RUNTIME_REQUIRED';
    targetSha: 'RUNTIME_REQUIRED';
    metrics: Record<string, WatchdogMetricContract>;
  };
  security: {
    maximumPayloadBytes: number;
    maximumRawCommandOutputBytes: number;
  };
  capacity: {
    taskScale: number;
    queryRowLimit: number;
    checksumSampleLimit: number;
    maximumQueryP99Milliseconds: number;
    maximumStorageBytesPerTask: number;
    maximumCompletionAckEvidenceBytes: number;
    maximumCompletionAckActiveActions: number;
    requiredIndexes: string[];
    runtimeSchemaIndexes: string[];
  };
}

export interface SanitizedWatchdogPayload {
  payload: unknown;
  inputBytes: number;
  storedBytes: number;
  redacted: boolean;
  truncatedRawOutput: boolean;
  payloadDigest: string;
}

export interface WatchdogSnapshot {
  watermarkLagLogicalTicks: number;
  oldestActiveObligationLogicalTicks: number;
  expiredLeaseCount: number;
  deadLetterCount: number;
  outboxBacklogCount: number;
  oldestOutboxAgeSeconds: number;
  schedulerStarvationCount: number;
  retryAttempts: number;
  totalAttempts: number;
  retryCostUnits: number;
  pendingInboxCount: number;
  oldestInboxAgeSeconds: number;
  checksumMismatchCount: number;
  [key: string]: unknown;
}

export interface WatchdogAlert {
  code: WatchdogSignalCode;
  observed: number;
  threshold: number;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(record[key])}`
  )).join(',')}}`;
}

export function watchdogDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function assertFullGitSha(value: string, label: string): void {
  if (!FULL_GIT_SHA.test(value)) throw new Error(`WATCHDOG_${label}_SHA_INVALID`);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (byteLength(value) <= maximumBytes) return { value, truncated: false };
  const suffix = '\n[TRUNCATED]';
  const suffixBytes = byteLength(suffix);
  const source = Buffer.from(value, 'utf8');
  let end = Math.max(0, maximumBytes - suffixBytes);
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: `${source.subarray(0, end).toString('utf8')}${suffix}`,
    truncated: true,
  };
}

function redactString(value: string): { value: string; redacted: boolean } {
  let output = value;
  for (const pattern of INLINE_SECRET_PATTERNS) {
    const prior = output;
    output = output.replace(pattern, (match, prefix?: string) => (
      typeof prefix === 'string' && match.startsWith(prefix)
        ? `${prefix}${WATCHDOG_REDACTION}@`
        : WATCHDOG_REDACTION
    ));
    if (output !== prior) return {
      value: INLINE_SECRET_PATTERNS.slice(INLINE_SECRET_PATTERNS.indexOf(pattern) + 1)
        .reduce((current, next) => current.replace(next, WATCHDOG_REDACTION), output),
      redacted: true,
    };
  }
  return { value: output, redacted: false };
}

function sanitizeValue(
  value: unknown,
  key: string | null,
  state: { redacted: boolean; truncatedRawOutput: boolean },
): unknown {
  if (key && SECRET_KEY.test(key)) {
    state.redacted = true;
    return WATCHDOG_REDACTION;
  }
  if (typeof value === 'string') {
    const redacted = redactString(value);
    state.redacted ||= redacted.redacted;
    if (key && RAW_OUTPUT_KEY.test(key)) {
      const truncated = truncateUtf8(redacted.value, WATCHDOG_MAX_RAW_COMMAND_OUTPUT_BYTES);
      state.truncatedRawOutput ||= truncated.truncated;
      return {
        content: truncated.value,
        originalBytes: byteLength(value),
        storedBytes: byteLength(truncated.value),
        truncated: truncated.truncated,
        redacted: redacted.redacted,
        originalSha256: createHash('sha256').update(value).digest('hex'),
      };
    }
    return redacted.value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, null, state));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([childKey, child]) => [childKey, sanitizeValue(child, childKey, state)]));
  }
  return value;
}

/**
 * The caller never receives a partially accepted payload. The original serialized body is bounded
 * first, secrets are removed second, raw command fields receive their tighter byte cap, and the
 * exact stored representation is bounded once more. Only the sanitized representation leaves this
 * function; the original command output is deliberately not retained.
 */
export function sanitizeWatchdogPayload(
  input: unknown,
  maximumPayloadBytes = WATCHDOG_MAX_PAYLOAD_BYTES,
): SanitizedWatchdogPayload {
  if (!Number.isInteger(maximumPayloadBytes) || maximumPayloadBytes < 1) {
    throw new Error('WATCHDOG_PAYLOAD_LIMIT_INVALID');
  }
  const inputJson = JSON.stringify(input);
  if (inputJson === undefined) throw new Error('WATCHDOG_PAYLOAD_NOT_JSON');
  const inputBytes = byteLength(inputJson);
  if (inputBytes > maximumPayloadBytes) throw new Error('WATCHDOG_PAYLOAD_TOO_LARGE');
  const state = { redacted: false, truncatedRawOutput: false };
  const payload = sanitizeValue(input, null, state);
  const storedJson = JSON.stringify(payload);
  const storedBytes = byteLength(storedJson);
  if (storedBytes > maximumPayloadBytes) throw new Error('WATCHDOG_SANITIZED_PAYLOAD_TOO_LARGE');
  return {
    payload,
    inputBytes,
    storedBytes,
    redacted: state.redacted,
    truncatedRawOutput: state.truncatedRawOutput,
    payloadDigest: createHash('sha256').update(storedJson).digest('hex'),
  };
}

function metricShape(metric: WatchdogMetricContract, label: string): void {
  if (!metric || typeof metric !== 'object') throw new Error(`WATCHDOG_METRIC_INVALID:${label}`);
  if (!metric.window || !Number.isFinite(metric.window.seconds) || metric.window.seconds <= 0
      || !Number.isFinite(metric.window.logicalTicks) || metric.window.logicalTicks <= 0) {
    throw new Error(`WATCHDOG_METRIC_WINDOW_INVALID:${label}`);
  }
  if (typeof metric.denominator !== 'string' || metric.denominator.trim() === '') {
    throw new Error(`WATCHDOG_METRIC_DENOMINATOR_REQUIRED:${label}`);
  }
  if (!Number.isInteger(metric.minSampleSize) || metric.minSampleSize < 1) {
    throw new Error(`WATCHDOG_METRIC_MIN_SAMPLE_INVALID:${label}`);
  }
  if (metric.collectorSha !== 'RUNTIME_REQUIRED' || metric.targetSha !== 'RUNTIME_REQUIRED') {
    throw new Error(`WATCHDOG_METRIC_SHA_BINDING_REQUIRED:${label}`);
  }
  if (!metric.abortThreshold || Object.keys(metric.abortThreshold).length === 0) {
    throw new Error(`WATCHDOG_METRIC_ABORT_THRESHOLD_REQUIRED:${label}`);
  }
}

export function validateWatchdogContract(value: unknown): asserts value is WatchdogContract {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('WATCHDOG_CONTRACT_REQUIRED');
  }
  const contract = value as WatchdogContract;
  if (contract.schemaVersion !== 1) throw new Error('WATCHDOG_CONTRACT_VERSION_UNSUPPORTED');
  if (!contract.collector || contract.collector.pollIntervalSeconds <= 0
      || contract.collector.maximumDetectionDeltaSeconds
        < contract.collector.pollIntervalSeconds
      || contract.collector.maximumRowsPerProbe < 2
      || contract.collector.checksumSubjectsPerProbe < 1) {
    throw new Error('WATCHDOG_COLLECTOR_BOUND_INVALID');
  }
  metricShape(contract.operationalSlo, 'operationalSlo');
  for (const [name, metric] of Object.entries(contract.metrics ?? {})) metricShape(metric, name);
  if (Object.keys(contract.metrics ?? {}).length < 9) throw new Error('WATCHDOG_METRIC_SET_INCOMPLETE');
  if (!contract.canary || typeof contract.canary.denominator !== 'string'
      || contract.canary.denominator.trim() === '' || contract.canary.minSampleSize < 1
      || contract.canary.collectorSha !== 'RUNTIME_REQUIRED'
      || contract.canary.targetSha !== 'RUNTIME_REQUIRED') {
    throw new Error('WATCHDOG_CANARY_CONTRACT_INVALID');
  }
  for (const [name, metric] of Object.entries(contract.canary.metrics ?? {})) {
    metricShape(metric, `canary.${name}`);
  }
  if (Object.keys(contract.canary.metrics ?? {}).length < 4) {
    throw new Error('WATCHDOG_CANARY_METRIC_SET_INCOMPLETE');
  }
  if (contract.security.maximumPayloadBytes !== WATCHDOG_MAX_PAYLOAD_BYTES
      || contract.security.maximumRawCommandOutputBytes !== WATCHDOG_MAX_RAW_COMMAND_OUTPUT_BYTES) {
    throw new Error('WATCHDOG_SECURITY_LIMIT_DRIFT');
  }
  if (contract.capacity.taskScale < 100_000
      || contract.capacity.queryRowLimit !== contract.collector.maximumRowsPerProbe
      || contract.capacity.checksumSampleLimit !== contract.collector.checksumSubjectsPerProbe
      || contract.capacity.maximumCompletionAckEvidenceBytes !== 16_384
      || contract.capacity.maximumCompletionAckActiveActions !== 16
      || !['completion_ack_fact_turn_idx', 'completion_ack_event_latest_idx']
        .every((name) => contract.capacity.runtimeSchemaIndexes?.includes(name))) {
    throw new Error('WATCHDOG_CAPACITY_CONTRACT_INVALID');
  }
}

function threshold(contract: WatchdogContract, metric: string, name: string): number {
  const value = contract.metrics[metric]?.threshold?.[name];
  if (!Number.isFinite(value)) throw new Error(`WATCHDOG_THRESHOLD_MISSING:${metric}.${name}`);
  return value as number;
}

export function evaluateWatchdogSnapshot(
  snapshot: WatchdogSnapshot,
  contract: WatchdogContract,
): WatchdogAlert[] {
  validateWatchdogContract(contract);
  const alerts: WatchdogAlert[] = [];
  const add = (condition: boolean, code: WatchdogSignalCode, observed: number, limit: number) => {
    if (condition) alerts.push({ code, observed, threshold: limit });
  };
  const watermarkLimit = threshold(contract, 'evaluatedThroughWatermarkLag', 'maximumLogicalTicks');
  add(snapshot.watermarkLagLogicalTicks > watermarkLimit,
    'RECONCILER_STOPPED', snapshot.watermarkLagLogicalTicks, watermarkLimit);
  add(snapshot.watermarkLagLogicalTicks > watermarkLimit,
    'PROJECTION_STALE', snapshot.watermarkLagLogicalTicks, watermarkLimit);
  const activeLimit = threshold(contract, 'oldestActiveObligation', 'maximumLogicalTicksWithoutProgress');
  add(snapshot.oldestActiveObligationLogicalTicks > activeLimit,
    'OLDEST_ACTIVE_OBLIGATION', snapshot.oldestActiveObligationLogicalTicks, activeLimit);
  add(snapshot.expiredLeaseCount > threshold(contract, 'expiredLease', 'expiredLeases'),
    'LEASE_EXPIRED', snapshot.expiredLeaseCount, 0);
  add(snapshot.deadLetterCount > threshold(contract, 'deadLetter', 'deadLetters'),
    'DEAD_LETTER_BACKLOG', snapshot.deadLetterCount, 0);
  const outboxLimit = threshold(contract, 'outboxBacklog', 'maximumOldestAgeSeconds');
  add(snapshot.outboxBacklogCount > 0 && snapshot.oldestOutboxAgeSeconds > outboxLimit,
    'OUTBOX_BLOCKED', snapshot.oldestOutboxAgeSeconds, outboxLimit);
  add(snapshot.schedulerStarvationCount > 0,
    'SCHEDULER_STARVATION', snapshot.schedulerStarvationCount, 0);
  const retryRatio = snapshot.totalAttempts === 0 ? 0 : snapshot.retryAttempts / snapshot.totalAttempts;
  const retryRatioLimit = threshold(contract, 'retryCost', 'maximumRetryRatio');
  const retryCostLimit = threshold(contract, 'retryCost', 'maximumRetryCostUnits');
  add(retryRatio > retryRatioLimit || snapshot.retryCostUnits > retryCostLimit,
    'RETRY_STORM', Math.max(retryRatio, snapshot.retryCostUnits),
    snapshot.retryCostUnits > retryCostLimit ? retryCostLimit : retryRatioLimit);
  const inboxLimit = threshold(contract, 'inboxAge', 'maximumOldestAgeSeconds');
  add(snapshot.pendingInboxCount > 0 && snapshot.oldestInboxAgeSeconds > inboxLimit,
    'INBOX_STALE', snapshot.oldestInboxAgeSeconds, inboxLimit);
  add(snapshot.checksumMismatchCount > threshold(contract, 'checksumDrift', 'mismatches'),
    'CHECKSUM_DRIFT', snapshot.checksumMismatchCount, 0);
  return alerts.sort((left, right) => left.code.localeCompare(right.code));
}

export function watchdogCanaryMember(
  taskId: string,
  targetSha: string,
  rolloutBasisPoints: number,
): boolean {
  assertFullGitSha(targetSha, 'TARGET');
  if (!Number.isInteger(rolloutBasisPoints) || rolloutBasisPoints < 0 || rolloutBasisPoints > 10_000) {
    throw new Error('WATCHDOG_CANARY_BASIS_POINTS_INVALID');
  }
  const hash = createHash('sha256').update(`${taskId}:${targetSha}`).digest();
  return hash.readUInt32BE(0) % 10_000 < rolloutBasisPoints;
}

export interface WatchdogCanaryObservation {
  eligibleTasks: number;
  selectedTasks: number;
  detectedFaults: number;
  faultDenominator: number;
  boundedProgress: number;
  progressDenominator: number;
  staleMisreportedEmpty: number;
  securityBoundaryViolations: number;
  queryP99Milliseconds: number;
}

export function evaluateWatchdogCanary(
  observation: WatchdogCanaryObservation,
  contract: WatchdogContract,
  collectorSha: string,
  targetSha: string,
): { verdict: 'PASS' | 'ABORT' | 'INSUFFICIENT_SAMPLE'; reasons: string[] } {
  validateWatchdogContract(contract);
  assertFullGitSha(collectorSha, 'COLLECTOR');
  assertFullGitSha(targetSha, 'TARGET');
  if (observation.selectedTasks < contract.canary.minSampleSize) {
    return { verdict: 'INSUFFICIENT_SAMPLE', reasons: ['CANARY_MIN_SAMPLE_NOT_MET'] };
  }
  const reasons: string[] = [];
  const limits = contract.canary.abortThreshold;
  const detectionMissRatio = observation.faultDenominator === 0 ? 0
    : 1 - observation.detectedFaults / observation.faultDenominator;
  const progressRatio = observation.progressDenominator === 0 ? 0
    : observation.boundedProgress / observation.progressDenominator;
  if (observation.staleMisreportedEmpty > limits.reconcilerStaleMisreportedEmpty) {
    reasons.push('STALE_MISREPORTED_EMPTY');
  }
  if (observation.securityBoundaryViolations > limits.securityBoundaryViolations) {
    reasons.push('SECURITY_BOUNDARY_VIOLATION');
  }
  if (detectionMissRatio > limits.watchdogDetectionMissRatio) reasons.push('DETECTION_MISS_RATIO');
  if (progressRatio < limits.boundedProgressRatioBelow) reasons.push('BOUNDED_PROGRESS_RATIO');
  if (observation.queryP99Milliseconds > limits.queryP99Milliseconds) reasons.push('QUERY_P99');
  return { verdict: reasons.length === 0 ? 'PASS' : 'ABORT', reasons };
}
