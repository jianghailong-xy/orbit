import { createHash } from 'node:crypto';
import { sanitizeWatchdogPayload } from './outcome-payload-redaction';

export const CANARY_METRICS = [
  'falseClose',
  'missedObligation',
  'readModelDifference',
  'reconciliationLag',
  'oldestObligation',
  'expiredLease',
  'retryCost',
  'inboxAge',
  'outboxFailure',
  'checksumDrift',
] as const;

export type CanaryMetricName = (typeof CANARY_METRICS)[number];
export type OutcomeVersion = 'V1' | 'V2';
export type CanaryAggregation = 'RATIO' | 'AVERAGE' | 'P99' | 'MAX';
export type MixedClientDecision =
  | 'ACCEPT'
  | 'TRANSLATE_TO_APPEND_ONLY_FACT'
  | 'SERVE_V2_PROJECTION'
  | 'REJECT';

const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ZERO_DIGEST = '0'.repeat(64);

export interface CanaryWindow {
  kind: 'FIXED';
  seconds: number;
  logicalTicks: number;
}

export interface CanaryMetricContract {
  unit: string;
  aggregation: CanaryAggregation;
  numerator: string;
  denominator: string;
  minSampleSize: number;
  window: CanaryWindow;
  slo: { maximum: number };
  abortThreshold: { maximum: number };
}

export interface CanaryContract {
  schemaVersion: number;
  contract: string;
  collector: {
    name: string;
    version: string;
    telemetrySchemaRevision: number;
    capabilityRevision: number;
    evaluatorVersion: string;
    collectorSha: 'RUNTIME_REQUIRED';
    targetSha: 'RUNTIME_REQUIRED';
  };
  cohort: {
    population: string;
    selection: string;
    rolloutBasisPoints: number;
    minimumEligibleTasks: number;
    minSampleSize: number;
    denominator: string;
    observationWindow: CanaryWindow;
    exclusions: string[];
  };
  diffTaxonomy: string[];
  metrics: Record<CanaryMetricName, CanaryMetricContract>;
  control: {
    initialMode: 'SHADOW';
    abortEvaluationVersion: 'V2';
    automaticRollback: boolean;
    consecutiveHealthyWindowsForCutover: number;
    consecutiveHealthyWindowsForRollforward: number;
    maximumRollbackRecoverySeconds: number;
    rollback: string;
    rollforward: string;
  };
  mixedClients: {
    currentProtocol: 'V2';
    acceptedLegacyProtocols: string[];
    requiredCases: MixedClientCase[];
  };
  security: {
    tenantAuthorization: string;
    rawTenantIdentifiers: 'FORBIDDEN';
    secretRedaction: string;
    redactionReplacement: string;
    maximumPayloadBytes: number;
    maximumRawCommandOutputBytes: number;
  };
  capacity: {
    tasks: number;
    maximumCohortSelectionMilliseconds: number;
    maximumTelemetryEvents: number;
  };
}

export interface MixedClientCase {
  name: string;
  protocol: string;
  actor: 'CLIENT' | 'RECONCILER';
  operation: 'CANONICAL_FACT' | 'CLAIM' | 'READ' | 'DIRECT_DONE'
    | 'MINT_AUTHORITY' | 'RATIFY' | 'WRITE_PROJECTION';
  expectedDecision: MixedClientDecision;
}

export interface CanaryVersionObservation {
  closed: boolean;
  mandatoryObligations: number;
  readModelDigest: string;
  reconciliationLagMilliseconds: number;
  oldestObligationSeconds: number;
  expiredLeases: number;
  claimedLeases: number;
  retryCostUnits: number;
  retryAttempts: number;
  inboxAgeSeconds: number;
  pendingInboxEntries: number;
  outboxFailures: number;
  outboxAttempts: number;
  checksumDrift: number;
  checksumSubjects: number;
}

export interface CanaryTaskObservation {
  kind: 'TASK_OBSERVATION';
  windowId: string;
  taskId: string;
  subjectDigest: string;
  cohortBucket: number;
  tenantDigest: string;
  authorizationTenantDigest: string;
  expected: {
    closed: boolean;
    mandatoryObligations: number;
    readModelDigest: string;
  };
  v1: CanaryVersionObservation;
  v2: CanaryVersionObservation;
}

export interface CanaryTelemetryMetadata {
  observedAt: string;
  collectorVersion: string;
  telemetrySchemaRevision: number;
  capabilityRevision: number;
  evaluatorVersion: string;
  collectorSha: string;
  targetSha: string;
}

export type CanaryTelemetryPayload = CanaryTelemetryMetadata & Record<string, unknown> & {
  kind: string;
};

export interface CanaryTelemetryEnvelope {
  sequence: number;
  previousDigest: string;
  event: CanaryTelemetryPayload;
  eventDigest: string;
}

export interface MetricValue {
  numerator: number;
  denominator: number;
  value: number;
  sufficientSample: boolean;
  sloPass: boolean;
  abort: boolean;
}

export interface CanaryMetricReport {
  name: CanaryMetricName;
  unit: string;
  aggregation: CanaryAggregation;
  numeratorDefinition: string;
  denominatorDefinition: string;
  minSampleSize: number;
  window: CanaryWindow;
  slo: { maximum: number };
  abortThreshold: { maximum: number };
  v1: MetricValue;
  v2: MetricValue;
  diff: {
    absolute: number;
    v2Improved: boolean;
  };
}

export interface CanaryWindowReport {
  windowId: string;
  sampleSize: number;
  observedWindow: { startedAt: string; finishedAt: string; seconds: number };
  metrics: Record<CanaryMetricName, CanaryMetricReport>;
  diffTaxonomy: Record<string, number>;
  abortReasonsV1: CanaryMetricName[];
  abortReasonsV2: CanaryMetricName[];
  tenantCount: number;
  authorizationViolations: number;
}

interface MetricAccumulator {
  numerator: number;
  denominator: number;
  values: number[];
}

export function canonicalCanaryJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalCanaryJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalCanaryJson(record[key])}`
  )).join(',')}}`;
}

export function canaryDigest(value: unknown): string {
  return createHash('sha256').update(
    typeof value === 'string' ? value : canonicalCanaryJson(value),
  ).digest('hex');
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`CANARY_POSITIVE_INTEGER_REQUIRED:${label}`);
  }
}

function nonNegative(value: unknown, label: string): asserts value is number {
  if (!Number.isFinite(value) || Number(value) < 0) {
    throw new Error(`CANARY_NON_NEGATIVE_REQUIRED:${label}`);
  }
}

function validateMetricContract(metric: CanaryMetricContract, label: string): void {
  if (!metric || typeof metric !== 'object') throw new Error(`CANARY_METRIC_REQUIRED:${label}`);
  if (!['RATIO', 'AVERAGE', 'P99', 'MAX'].includes(metric.aggregation)) {
    throw new Error(`CANARY_METRIC_AGGREGATION_INVALID:${label}`);
  }
  if (!metric.numerator?.trim() || !metric.denominator?.trim()) {
    throw new Error(`CANARY_METRIC_DENOMINATOR_REQUIRED:${label}`);
  }
  positiveInteger(metric.minSampleSize, `${label}.minSampleSize`);
  positiveInteger(metric.window?.seconds, `${label}.window.seconds`);
  positiveInteger(metric.window?.logicalTicks, `${label}.window.logicalTicks`);
  nonNegative(metric.slo?.maximum, `${label}.slo.maximum`);
  nonNegative(metric.abortThreshold?.maximum, `${label}.abortThreshold.maximum`);
  if (metric.abortThreshold.maximum < metric.slo.maximum) {
    throw new Error(`CANARY_ABORT_TIGHTER_THAN_SLO:${label}`);
  }
}

export function validateCanaryContract(value: unknown): asserts value is CanaryContract {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CANARY_CONTRACT_REQUIRED');
  }
  const contract = value as CanaryContract;
  if (contract.schemaVersion !== 2
      || contract.contract !== 'orbit.outcome-reconciler.new-task-canary.v2') {
    throw new Error('CANARY_CONTRACT_VERSION_UNSUPPORTED');
  }
  if (!contract.collector?.name || !contract.collector.version
      || contract.collector.telemetrySchemaRevision !== 2
      || contract.collector.capabilityRevision < 2
      || !contract.collector.evaluatorVersion
      || contract.collector.collectorSha !== 'RUNTIME_REQUIRED'
      || contract.collector.targetSha !== 'RUNTIME_REQUIRED') {
    throw new Error('CANARY_COLLECTOR_BINDING_INVALID');
  }
  positiveInteger(contract.cohort?.minSampleSize, 'cohort.minSampleSize');
  positiveInteger(contract.cohort?.minimumEligibleTasks, 'cohort.minimumEligibleTasks');
  if (!Number.isSafeInteger(contract.cohort.rolloutBasisPoints)
      || contract.cohort.rolloutBasisPoints < 1
      || contract.cohort.rolloutBasisPoints > 10_000
      || !contract.cohort.population.trim()
      || !contract.cohort.denominator.trim()) {
    throw new Error('CANARY_COHORT_INVALID');
  }
  positiveInteger(contract.cohort.observationWindow?.seconds, 'cohort.window.seconds');
  const names = Object.keys(contract.metrics ?? {}).sort();
  const expectedNames = [...CANARY_METRICS].sort();
  if (canonicalCanaryJson(names) !== canonicalCanaryJson(expectedNames)) {
    throw new Error('CANARY_METRIC_SET_INCOMPLETE');
  }
  for (const name of CANARY_METRICS) validateMetricContract(contract.metrics[name], name);
  for (const required of [
    'MATCH', 'V1_FALSE_CLOSE', 'V2_FALSE_CLOSE', 'V1_MISSED_OBLIGATION',
    'V2_MISSED_OBLIGATION', 'V1_READ_MODEL_DRIFT', 'V2_READ_MODEL_DRIFT',
  ]) {
    if (!contract.diffTaxonomy.includes(required)) {
      throw new Error(`CANARY_DIFF_TAXONOMY_MISSING:${required}`);
    }
  }
  if (!contract.control.automaticRollback
      || contract.control.initialMode !== 'SHADOW'
      || contract.control.abortEvaluationVersion !== 'V2') {
    throw new Error('CANARY_CONTROL_NOT_FAIL_CLOSED');
  }
  positiveInteger(contract.control.consecutiveHealthyWindowsForCutover,
    'control.consecutiveHealthyWindowsForCutover');
  positiveInteger(contract.control.consecutiveHealthyWindowsForRollforward,
    'control.consecutiveHealthyWindowsForRollforward');
  positiveInteger(contract.control.maximumRollbackRecoverySeconds,
    'control.maximumRollbackRecoverySeconds');
  if (contract.mixedClients.requiredCases.length < 10
      || !contract.mixedClients.acceptedLegacyProtocols.includes('V1')
      || !contract.mixedClients.acceptedLegacyProtocols.includes('V1_HEADERLESS_N_MINUS_ONE')) {
    throw new Error('CANARY_MIXED_CLIENT_MATRIX_INCOMPLETE');
  }
  if (contract.security.rawTenantIdentifiers !== 'FORBIDDEN'
      || contract.security.redactionReplacement !== '[REDACTED]'
      || contract.capacity.tasks < 110_000
      || contract.capacity.tasks > 112_000
      || contract.capacity.maximumTelemetryEvents < contract.cohort.minSampleSize) {
    throw new Error('CANARY_SECURITY_OR_CAPACITY_INVALID');
  }
}

export function canaryCohortBucket(taskId: string, targetSha: string): number {
  if (!taskId) throw new Error('CANARY_TASK_ID_REQUIRED');
  if (!FULL_SHA.test(targetSha)) throw new Error('CANARY_TARGET_SHA_INVALID');
  return createHash('sha256').update(`${taskId}:${targetSha}`).digest().readUInt32BE(0) % 10_000;
}

export function isCanaryCohortMember(
  taskId: string,
  targetSha: string,
  rolloutBasisPoints: number,
): boolean {
  if (!Number.isSafeInteger(rolloutBasisPoints)
      || rolloutBasisPoints < 0 || rolloutBasisPoints > 10_000) {
    throw new Error('CANARY_ROLLOUT_BASIS_POINTS_INVALID');
  }
  return canaryCohortBucket(taskId, targetSha) < rolloutBasisPoints;
}

export function sealCanaryTelemetry(
  events: CanaryTelemetryPayload[],
): CanaryTelemetryEnvelope[] {
  let previousDigest = ZERO_DIGEST;
  return events.map((event, index) => {
    const sequence = index + 1;
    const material = { sequence, previousDigest, event };
    const eventDigest = canaryDigest(material);
    const envelope = { sequence, previousDigest, event, eventDigest };
    previousDigest = eventDigest;
    return envelope;
  });
}

export function verifyCanaryTelemetry(
  envelopes: CanaryTelemetryEnvelope[],
  contract: CanaryContract,
  collectorSha: string,
  targetSha: string,
): { eventCount: number; firstDigest: string; lastDigest: string } {
  validateCanaryContract(contract);
  if (!FULL_SHA.test(collectorSha) || !FULL_SHA.test(targetSha)) {
    throw new Error('CANARY_RUNTIME_SHA_INVALID');
  }
  if (envelopes.length === 0 || envelopes.length > contract.capacity.maximumTelemetryEvents) {
    throw new Error('CANARY_TELEMETRY_COUNT_INVALID');
  }
  let previousDigest = ZERO_DIGEST;
  for (const [index, envelope] of envelopes.entries()) {
    if (envelope.sequence !== index + 1 || envelope.previousDigest !== previousDigest) {
      throw new Error(`CANARY_TELEMETRY_CHAIN_BROKEN:${index + 1}`);
    }
    if (!DIGEST.test(envelope.eventDigest)
        || canaryDigest({
          sequence: envelope.sequence,
          previousDigest: envelope.previousDigest,
          event: envelope.event,
        }) !== envelope.eventDigest) {
      throw new Error(`CANARY_TELEMETRY_DIGEST_INVALID:${index + 1}`);
    }
    const event = envelope.event;
    if (event.collectorVersion !== contract.collector.version
        || event.telemetrySchemaRevision !== contract.collector.telemetrySchemaRevision
        || event.capabilityRevision !== contract.collector.capabilityRevision
        || event.evaluatorVersion !== contract.collector.evaluatorVersion
        || event.collectorSha !== collectorSha
        || event.targetSha !== targetSha
        || !Number.isFinite(Date.parse(event.observedAt))) {
      throw new Error(`CANARY_TELEMETRY_BINDING_INVALID:${index + 1}`);
    }
    previousDigest = envelope.eventDigest;
  }
  return {
    eventCount: envelopes.length,
    firstDigest: envelopes[0].eventDigest,
    lastDigest: previousDigest,
  };
}

function assertVersionObservation(value: CanaryVersionObservation, label: string): void {
  positiveInteger(value.mandatoryObligations + 1, `${label}.mandatoryObligations+1`);
  if (!DIGEST.test(value.readModelDigest)) throw new Error(`CANARY_READ_DIGEST_INVALID:${label}`);
  for (const [name, number] of Object.entries(value).filter(([, item]) => typeof item === 'number')) {
    nonNegative(number, `${label}.${name}`);
  }
  if (value.expiredLeases > value.claimedLeases
      || value.outboxFailures > value.outboxAttempts
      || value.checksumDrift > value.checksumSubjects) {
    throw new Error(`CANARY_VERSION_COUNTER_INVALID:${label}`);
  }
}

function percentile99(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)];
}

function blankMetric(): MetricAccumulator {
  return { numerator: 0, denominator: 0, values: [] };
}

function versionAccumulators(): Record<CanaryMetricName, MetricAccumulator> {
  return Object.fromEntries(CANARY_METRICS.map((name) => [name, blankMetric()])) as
    Record<CanaryMetricName, MetricAccumulator>;
}

function addVersionObservation(
  accumulators: Record<CanaryMetricName, MetricAccumulator>,
  expected: CanaryTaskObservation['expected'],
  observed: CanaryVersionObservation,
): void {
  const falseClose = accumulators.falseClose;
  falseClose.denominator += 1;
  falseClose.numerator += Number(observed.closed && !expected.closed);

  const missed = accumulators.missedObligation;
  missed.denominator += expected.mandatoryObligations;
  missed.numerator += Math.max(0, expected.mandatoryObligations - observed.mandatoryObligations);

  const read = accumulators.readModelDifference;
  read.denominator += 1;
  read.numerator += Number(observed.readModelDigest !== expected.readModelDigest);

  accumulators.reconciliationLag.denominator += 1;
  accumulators.reconciliationLag.values.push(observed.reconciliationLagMilliseconds);

  accumulators.oldestObligation.denominator += observed.mandatoryObligations;
  if (observed.mandatoryObligations > 0) {
    accumulators.oldestObligation.values.push(observed.oldestObligationSeconds);
  }

  accumulators.expiredLease.numerator += observed.expiredLeases;
  accumulators.expiredLease.denominator += observed.claimedLeases;

  accumulators.retryCost.numerator += observed.retryCostUnits;
  accumulators.retryCost.denominator += observed.retryAttempts;

  accumulators.inboxAge.denominator += observed.pendingInboxEntries;
  if (observed.pendingInboxEntries > 0) {
    accumulators.inboxAge.values.push(observed.inboxAgeSeconds);
  }

  accumulators.outboxFailure.numerator += observed.outboxFailures;
  accumulators.outboxFailure.denominator += observed.outboxAttempts;

  accumulators.checksumDrift.numerator += observed.checksumDrift;
  accumulators.checksumDrift.denominator += observed.checksumSubjects;
}

function metricValue(
  accumulator: MetricAccumulator,
  metric: CanaryMetricContract,
): MetricValue {
  const { aggregation } = metric;
  let value: number;
  if (aggregation === 'P99') value = percentile99(accumulator.values);
  else if (aggregation === 'MAX') value = accumulator.values.length
    ? Math.max(...accumulator.values) : Number.NaN;
  else value = accumulator.denominator === 0
    ? Number.NaN : accumulator.numerator / accumulator.denominator;
  const sufficientSample = accumulator.denominator >= metric.minSampleSize;
  if (!Number.isFinite(value)) throw new Error('CANARY_METRIC_EMPTY');
  return {
    numerator: aggregation === 'P99' || aggregation === 'MAX' ? value : accumulator.numerator,
    denominator: accumulator.denominator,
    value,
    sufficientSample,
    sloPass: sufficientSample && value <= metric.slo.maximum,
    abort: !sufficientSample || value > metric.abortThreshold.maximum,
  };
}

function taxonomyFor(observation: CanaryTaskObservation, counts: Record<string, number>): void {
  const categories: string[] = [];
  if (observation.v1.closed && !observation.expected.closed) categories.push('V1_FALSE_CLOSE');
  if (observation.v2.closed && !observation.expected.closed) categories.push('V2_FALSE_CLOSE');
  if (observation.v1.mandatoryObligations < observation.expected.mandatoryObligations) {
    categories.push('V1_MISSED_OBLIGATION');
  }
  if (observation.v2.mandatoryObligations < observation.expected.mandatoryObligations) {
    categories.push('V2_MISSED_OBLIGATION');
  }
  const v1ReadDrift = observation.v1.readModelDigest !== observation.expected.readModelDigest;
  const v2ReadDrift = observation.v2.readModelDigest !== observation.expected.readModelDigest;
  if (v1ReadDrift) categories.push('V1_READ_MODEL_DRIFT');
  if (v2ReadDrift) categories.push('V2_READ_MODEL_DRIFT');
  if (v1ReadDrift && v2ReadDrift
      && observation.v1.readModelDigest !== observation.v2.readModelDigest) {
    categories.push('BOTH_DIFFERENT_FROM_AUTHORITY');
  }
  if (categories.length === 0) categories.push('MATCH');
  for (const category of categories) counts[category] = (counts[category] ?? 0) + 1;
}

export function reduceCanaryWindow(
  envelopes: CanaryTelemetryEnvelope[],
  contract: CanaryContract,
  windowId: string,
): CanaryWindowReport {
  validateCanaryContract(contract);
  const taskEvents = envelopes.map(({ event }) => event)
    .filter((event) => event.kind === 'TASK_OBSERVATION' && event.windowId === windowId) as unknown as
    Array<CanaryTelemetryMetadata & CanaryTaskObservation>;
  if (taskEvents.length < contract.cohort.minSampleSize) {
    throw new Error(`CANARY_WINDOW_MIN_SAMPLE_NOT_MET:${windowId}`);
  }
  const v1 = versionAccumulators();
  const v2 = versionAccumulators();
  const seen = new Set<string>();
  const tenants = new Set<string>();
  const taxonomy = Object.fromEntries(contract.diffTaxonomy.map((name) => [name, 0]));
  let authorizationViolations = 0;
  for (const observation of taskEvents) {
    if (seen.has(observation.taskId)) throw new Error(`CANARY_DUPLICATE_TASK:${windowId}`);
    seen.add(observation.taskId);
    if (observation.subjectDigest !== canaryDigest(observation.taskId)
        || observation.cohortBucket !== canaryCohortBucket(
          observation.taskId,
          observation.targetSha,
        )
        || observation.cohortBucket >= contract.cohort.rolloutBasisPoints) {
      throw new Error(`CANARY_COHORT_MEMBERSHIP_INVALID:${observation.taskId}`);
    }
    if (!DIGEST.test(observation.tenantDigest)
        || !DIGEST.test(observation.authorizationTenantDigest)) {
      throw new Error('CANARY_TENANT_DIGEST_INVALID');
    }
    authorizationViolations += Number(
      observation.tenantDigest !== observation.authorizationTenantDigest,
    );
    tenants.add(observation.tenantDigest);
    if (!DIGEST.test(observation.expected.readModelDigest)
        || !Number.isSafeInteger(observation.expected.mandatoryObligations)
        || observation.expected.mandatoryObligations < 0) {
      throw new Error('CANARY_EXPECTED_OBSERVATION_INVALID');
    }
    assertVersionObservation(observation.v1, `${observation.taskId}.v1`);
    assertVersionObservation(observation.v2, `${observation.taskId}.v2`);
    addVersionObservation(v1, observation.expected, observation.v1);
    addVersionObservation(v2, observation.expected, observation.v2);
    taxonomyFor(observation, taxonomy);
  }
  if (authorizationViolations > 0) throw new Error('CANARY_TENANT_FORBIDDEN');

  const metrics = {} as Record<CanaryMetricName, CanaryMetricReport>;
  for (const name of CANARY_METRICS) {
    const metric = contract.metrics[name];
    const v1Value = metricValue(v1[name], metric);
    const v2Value = metricValue(v2[name], metric);
    metrics[name] = {
      name,
      unit: metric.unit,
      aggregation: metric.aggregation,
      numeratorDefinition: metric.numerator,
      denominatorDefinition: metric.denominator,
      minSampleSize: metric.minSampleSize,
      window: metric.window,
      slo: metric.slo,
      abortThreshold: metric.abortThreshold,
      v1: v1Value,
      v2: v2Value,
      diff: {
        absolute: v2Value.value - v1Value.value,
        v2Improved: v2Value.value < v1Value.value,
      },
    };
  }
  const observedTimes = taskEvents.map((event) => Date.parse(event.observedAt));
  const started = Math.min(...observedTimes);
  const finished = Math.max(...observedTimes);
  const observedSeconds = (finished - started) / 1_000;
  if (observedSeconds > contract.cohort.observationWindow.seconds) {
    throw new Error(`CANARY_WINDOW_UNBOUNDED:${windowId}`);
  }
  return {
    windowId,
    sampleSize: taskEvents.length,
    observedWindow: {
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      seconds: observedSeconds,
    },
    metrics,
    diffTaxonomy: taxonomy,
    abortReasonsV1: CANARY_METRICS.filter((name) => metrics[name].v1.abort),
    abortReasonsV2: CANARY_METRICS.filter((name) => metrics[name].v2.abort),
    tenantCount: tenants.size,
    authorizationViolations,
  };
}

export function authorizeAndSanitizeCanaryPayload(
  authenticatedTenantDigest: string,
  storedTenantDigest: string,
  payload: unknown,
  contract: CanaryContract,
): ReturnType<typeof sanitizeWatchdogPayload> {
  validateCanaryContract(contract);
  if (!DIGEST.test(authenticatedTenantDigest) || !DIGEST.test(storedTenantDigest)) {
    throw new Error('CANARY_TENANT_DIGEST_INVALID');
  }
  if (authenticatedTenantDigest !== storedTenantDigest) {
    throw new Error('CANARY_TENANT_FORBIDDEN');
  }
  return sanitizeWatchdogPayload(payload, contract.security.maximumPayloadBytes);
}

export function evaluateMixedClientRequest(
  request: Pick<MixedClientCase, 'protocol' | 'actor' | 'operation'>,
  contract: CanaryContract,
): { decision: MixedClientDecision; reason: string } {
  validateCanaryContract(contract);
  const known = request.protocol === contract.mixedClients.currentProtocol
    || contract.mixedClients.acceptedLegacyProtocols.includes(request.protocol);
  if (!known) return { decision: 'REJECT', reason: 'UNKNOWN_PROTOCOL_REVISION' };
  if (request.operation === 'READ') {
    return { decision: 'SERVE_V2_PROJECTION', reason: 'SINGLE_REBUILDABLE_READ_MODEL' };
  }
  if (request.protocol !== 'V2') {
    if (request.operation === 'CLAIM') {
      return {
        decision: 'TRANSLATE_TO_APPEND_ONLY_FACT',
        reason: 'KNOWN_LEGACY_CLAIM_ONLY',
      };
    }
    return { decision: 'REJECT', reason: 'LEGACY_AUTHORITY_OR_WRITER_REFUSED' };
  }
  if (request.operation === 'WRITE_PROJECTION') {
    return request.actor === 'RECONCILER'
      ? { decision: 'ACCEPT', reason: 'SINGLE_V2_PROJECTION_WRITER' }
      : { decision: 'REJECT', reason: 'CLIENT_PROJECTION_WRITE_REFUSED' };
  }
  if (request.operation === 'CANONICAL_FACT') {
    return { decision: 'ACCEPT', reason: 'V2_CANONICAL_FACT' };
  }
  if (['DIRECT_DONE', 'MINT_AUTHORITY', 'RATIFY'].includes(request.operation)) {
    return { decision: 'REJECT', reason: 'PRIVILEGED_SHORTCUT_REFUSED' };
  }
  return { decision: 'REJECT', reason: 'V2_OPERATION_NOT_DECLARED' };
}

export type CanaryControlMode =
  | 'SHADOW'
  | 'CANARY'
  | 'V2_ACTIVE'
  | 'ROLLING_BACK'
  | 'V1_ACTIVE';

export interface CanaryControlObservation {
  windowId: string;
  observedAt: string;
  report: CanaryWindowReport;
  recoveryVersion?: OutcomeVersion;
}

export interface CanaryControlTransition {
  from: CanaryControlMode;
  to: CanaryControlMode;
  reason: string;
  windowId: string;
  at: string;
  automatic: boolean;
  abortReasons: CanaryMetricName[];
}

export interface CanaryControlReplay {
  initialMode: 'SHADOW';
  finalMode: CanaryControlMode;
  transitions: CanaryControlTransition[];
  rollback: {
    triggered: boolean;
    triggeredAt: string | null;
    recoveredAt: string | null;
    recoverySeconds: number | null;
    maximumRecoverySeconds: number;
    recoveredWithinSlo: boolean;
    abortReasons: CanaryMetricName[];
  };
  rollforward: {
    triggered: boolean;
    completed: boolean;
  };
}

export function replayCanaryControl(
  observations: CanaryControlObservation[],
  contract: CanaryContract,
): CanaryControlReplay {
  validateCanaryContract(contract);
  let mode: CanaryControlMode = contract.control.initialMode;
  let healthyWindows = 0;
  let rollbackStarted: number | null = null;
  let recoveredAt: number | null = null;
  let rollbackReasons: CanaryMetricName[] = [];
  let rollforwardTriggered = false;
  const transitions: CanaryControlTransition[] = [];
  const move = (
    to: CanaryControlMode,
    reason: string,
    observation: CanaryControlObservation,
    automatic: boolean,
    abortReasons: CanaryMetricName[] = [],
  ) => {
    transitions.push({
      from: mode,
      to,
      reason,
      windowId: observation.windowId,
      at: observation.observedAt,
      automatic,
      abortReasons,
    });
    mode = to;
    healthyWindows = 0;
  };
  for (const observation of observations) {
    const at = Date.parse(observation.observedAt);
    if (!Number.isFinite(at)) throw new Error('CANARY_CONTROL_TIME_INVALID');
    const v1Abort = observation.report.abortReasonsV1;
    const v2Abort = observation.report.abortReasonsV2;
    if (mode === 'SHADOW') {
      if (v2Abort.length === 0) {
        move('CANARY', 'SHADOW_DIFF_WITHIN_ABORT_THRESHOLDS', observation, true);
      }
      continue;
    }
    if (mode === 'CANARY') {
      if (v2Abort.length > 0) {
        rollbackStarted = at;
        rollbackReasons = [...v2Abort];
        move('ROLLING_BACK', 'V2_ABORT_THRESHOLD_REACHED', observation, true, v2Abort);
        continue;
      }
      healthyWindows += 1;
      if (healthyWindows >= contract.control.consecutiveHealthyWindowsForCutover) {
        move('V2_ACTIVE', rollforwardTriggered
          ? 'ROLLFORWARD_HEALTHY_WINDOWS_COMPLETE'
          : 'CANARY_HEALTHY_WINDOWS_COMPLETE', observation, true);
      }
      continue;
    }
    if (mode === 'V2_ACTIVE') {
      if (v2Abort.length > 0) {
        rollbackStarted = at;
        rollbackReasons = [...v2Abort];
        move('ROLLING_BACK', 'V2_ABORT_THRESHOLD_REACHED', observation, true, v2Abort);
      }
      continue;
    }
    if (mode === 'ROLLING_BACK') {
      if (observation.recoveryVersion !== 'V1') {
        throw new Error('CANARY_ROLLBACK_REQUIRES_V1_RECOVERY_PROBE');
      }
      if (v1Abort.length === 0) {
        if (rollbackStarted == null) throw new Error('CANARY_ROLLBACK_START_MISSING');
        const recoverySeconds = (at - rollbackStarted) / 1_000;
        if (recoverySeconds < 0
            || recoverySeconds > contract.control.maximumRollbackRecoverySeconds) {
          throw new Error('CANARY_ROLLBACK_RECOVERY_SLO_MISSED');
        }
        recoveredAt = at;
        move('V1_ACTIVE', 'V1_SERVICE_RECOVERED_WITHIN_SLO', observation, true);
      }
      continue;
    }
    if (mode === 'V1_ACTIVE') {
      if (v2Abort.length > 0) {
        healthyWindows = 0;
        continue;
      }
      healthyWindows += 1;
      if (healthyWindows >= contract.control.consecutiveHealthyWindowsForRollforward) {
        rollforwardTriggered = true;
        move('CANARY', 'ROLLFORWARD_SHADOW_WINDOWS_COMPLETE', observation, true);
      }
    }
  }
  const recoverySeconds = rollbackStarted == null || recoveredAt == null
    ? null : (recoveredAt - rollbackStarted) / 1_000;
  return {
    initialMode: contract.control.initialMode,
    finalMode: mode,
    transitions,
    rollback: {
      triggered: rollbackStarted != null,
      triggeredAt: rollbackStarted == null ? null : new Date(rollbackStarted).toISOString(),
      recoveredAt: recoveredAt == null ? null : new Date(recoveredAt).toISOString(),
      recoverySeconds,
      maximumRecoverySeconds: contract.control.maximumRollbackRecoverySeconds,
      recoveredWithinSlo: recoverySeconds != null
        && recoverySeconds <= contract.control.maximumRollbackRecoverySeconds,
      abortReasons: rollbackReasons,
    },
    rollforward: {
      triggered: rollforwardTriggered,
      completed: rollforwardTriggered && (mode as CanaryControlMode) === 'V2_ACTIVE',
    },
  };
}
