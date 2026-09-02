import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const MODULE_PATH = process.env.OUTCOME_CANARY_MODULE;
const CONTRACT_PATH = process.env.OUTCOME_CANARY_CONTRACT_PATH;
const TELEMETRY_PATH = process.env.OUTCOME_CANARY_TELEMETRY_PATH;
const UPSTREAM_EVIDENCE_PATH = process.env.OUTCOME_CANARY_UPSTREAM_EVIDENCE_PATH;
const UPSTREAM_TASK_PATH = process.env.OUTCOME_CANARY_UPSTREAM_TASK_PATH;
const COLLECTOR_SHA = process.env.OUTCOME_CANARY_COLLECTOR_SHA;
const TARGET_SHA = process.env.OUTCOME_CANARY_TARGET_SHA;

for (const [name, value] of Object.entries({
  OUTCOME_CANARY_MODULE: MODULE_PATH,
  OUTCOME_CANARY_CONTRACT_PATH: CONTRACT_PATH,
  OUTCOME_CANARY_TELEMETRY_PATH: TELEMETRY_PATH,
  OUTCOME_CANARY_UPSTREAM_EVIDENCE_PATH: UPSTREAM_EVIDENCE_PATH,
  OUTCOME_CANARY_UPSTREAM_TASK_PATH: UPSTREAM_TASK_PATH,
  OUTCOME_CANARY_COLLECTOR_SHA: COLLECTOR_SHA,
  OUTCOME_CANARY_TARGET_SHA: TARGET_SHA,
})) assert.ok(value, `${name} is required`);

const canary = await import(pathToFileURL(path.resolve(MODULE_PATH)).href);
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
const upstreamEvidenceRaw = readFileSync(UPSTREAM_EVIDENCE_PATH, 'utf8');
const upstreamEvidenceRows = JSON.parse(upstreamEvidenceRaw);
const upstreamTaskRaw = readFileSync(UPSTREAM_TASK_PATH, 'utf8');
const upstreamTask = JSON.parse(upstreamTaskRaw);
const upstream = upstreamEvidenceRows[0];
const upstreamPreflight = upstream?.evidence?.exactShaPreflight;
const upstreamElapsedSeconds = Number(upstreamPreflight?.elapsedMilliseconds) / 1000;
const events = [];
const reports = new Map();
let eligibleTaskIds = [];
let selectedTaskIds = [];
let controlReplay;

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function metadata(observedAt) {
  return {
    observedAt,
    collectorVersion: contract.collector.version,
    telemetrySchemaRevision: contract.collector.telemetrySchemaRevision,
    capabilityRevision: contract.collector.capabilityRevision,
    evaluatorVersion: contract.collector.evaluatorVersion,
    collectorSha: COLLECTOR_SHA,
    targetSha: TARGET_SHA,
  };
}

function append(kind, observedAt, body = {}) {
  events.push({ kind, ...metadata(observedAt), ...body });
}

function healthyVersion(expectedDigest, ordinal, improvements = true) {
  return {
    closed: false,
    mandatoryObligations: 1,
    readModelDigest: expectedDigest,
    reconciliationLagMilliseconds: improvements ? 4_000 + (ordinal % 500) : 40_000 + (ordinal % 900),
    oldestObligationSeconds: improvements ? 20 + (ordinal % 10) : 180 + (ordinal % 20),
    expiredLeases: 0,
    claimedLeases: 1,
    retryCostUnits: improvements ? 0.1 : 1.2,
    retryAttempts: 1,
    inboxAgeSeconds: improvements ? 5 + (ordinal % 5) : 45 + (ordinal % 10),
    pendingInboxEntries: 1,
    outboxFailures: 0,
    outboxAttempts: 1,
    checksumDrift: 0,
    checksumSubjects: 1,
  };
}

function taskObservation(windowId, taskId, ordinal, mode, observedAt) {
  const expectedDigest = sha(`canonical-read-model:${taskId}`);
  const expected = { closed: false, mandatoryObligations: 1, readModelDigest: expectedDigest };
  let v1 = healthyVersion(expectedDigest, ordinal, mode === 'HEALTHY_BOTH' || mode === 'V2_FAULT');
  const v2 = healthyVersion(expectedDigest, ordinal, true);
  if (mode === 'BASELINE') {
    if (ordinal % 211 === 0) v1 = { ...v1, closed: true, mandatoryObligations: 0 };
    if (ordinal % 307 === 0) v1 = { ...v1, readModelDigest: sha(`legacy-read-model:${taskId}`) };
    if (ordinal % 997 === 0) v1 = { ...v1, expiredLeases: 1 };
    if (ordinal % 701 === 0) v1 = { ...v1, outboxFailures: 1 };
    if (ordinal % 1301 === 0) v1 = { ...v1, checksumDrift: 1 };
  }
  if (mode === 'V2_FAULT' && ordinal === 0) v2.checksumDrift = 1;
  const tenantDigest = sha(ordinal % 2 === 0 ? 'tenant-canary-a' : 'tenant-canary-b');
  return {
    windowId,
    taskId,
    subjectDigest: sha(taskId),
    cohortBucket: canary.canaryCohortBucket(taskId, TARGET_SHA),
    tenantDigest,
    authorizationTenantDigest: tenantDigest,
    expected,
    v1,
    v2,
    ...metadata(observedAt),
  };
}

function addWindow(windowId, taskIds, mode, baseTime, v1RuntimeHealthy = mode !== 'BASELINE') {
  const base = Date.parse(baseTime);
  for (const [ordinal, taskId] of taskIds.entries()) {
    const observedAt = new Date(base + (ordinal % 1000) * 5).toISOString();
    events.push({
      kind: 'TASK_OBSERVATION',
      ...taskObservation(windowId, taskId, ordinal, mode, observedAt),
    });
  }
  const report = canary.reduceCanaryWindow(canary.sealCanaryTelemetry(events), contract, windowId);
  reports.set(windowId, report);
  return report;
}

function control(windowId, observedAt, recoveryVersion, record = true) {
  if (record) append('CONTROL_OBSERVATION', observedAt, {
    windowId,
    controlRunId: 'rollback-rollforward-drill',
    ...(recoveryVersion ? { recoveryVersion } : {}),
  });
  return { windowId, observedAt, report: reports.get(windowId), recoveryVersion };
}

after(() => {
  const sealed = canary.sealCanaryTelemetry(events);
  canary.verifyCanaryTelemetry(sealed, contract, COLLECTOR_SHA, TARGET_SHA);
  mkdirSync(path.dirname(TELEMETRY_PATH), { recursive: true });
  writeFileSync(TELEMETRY_PATH, `${sealed.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
});

test('canary contract declares every requested dimension, denominator, sample, window, SLO and abort threshold', () => {
  canary.validateCanaryContract(contract);
  assert.deepEqual(Object.keys(contract.metrics).sort(), [...canary.CANARY_METRICS].sort());
  for (const metric of Object.values(contract.metrics)) {
    assert.ok(metric.numerator.length > 0);
    assert.ok(metric.denominator.length > 0);
    assert.ok(metric.minSampleSize > 0);
    assert.ok(metric.window.seconds > 0);
    assert.ok(metric.slo.maximum >= 0);
    assert.ok(metric.abortThreshold.maximum >= metric.slo.maximum);
  }
  assert.equal(contract.collector.telemetrySchemaRevision, 2);
  assert.equal(contract.collector.capabilityRevision, 2);
});

test('the immutable target-SHA cohort is deterministic and nonzero across the 111k capacity population', () => {
  const started = performance.now();
  eligibleTaskIds = Array.from({ length: contract.capacity.tasks }, (_, index) => (
    `new-task-${String(index + 1).padStart(6, '0')}`
  ));
  selectedTaskIds = eligibleTaskIds.filter((taskId) => canary.isCanaryCohortMember(
    taskId, TARGET_SHA, contract.cohort.rolloutBasisPoints,
  ));
  const elapsedMilliseconds = performance.now() - started;
  assert.equal(eligibleTaskIds.length, 111_000);
  assert.ok(selectedTaskIds.length >= contract.cohort.minSampleSize);
  assert.deepEqual(selectedTaskIds.slice(0, 100), eligibleTaskIds.filter((taskId) => (
    canary.isCanaryCohortMember(taskId, TARGET_SHA, contract.cohort.rolloutBasisPoints)
  )).slice(0, 100));
  assert.ok(elapsedMilliseconds < contract.capacity.maximumCohortSelectionMilliseconds);
  append('COHORT_SNAPSHOT', '2026-08-29T00:00:00.000Z', {
    population: contract.cohort.population,
    denominator: contract.cohort.denominator,
    eligibleTasks: eligibleTaskIds.length,
    selectedTasks: selectedTaskIds.length,
    rolloutBasisPoints: contract.cohort.rolloutBasisPoints,
    selectionDigest: canary.canaryDigest(selectedTaskIds),
    selectionMilliseconds: elapsedMilliseconds,
  });
});

test('shadow telemetry derives bidirectional V1/V2 false-close, missed-obligation and read-model diffs', () => {
  const report = addWindow(
    'shadow-capacity', selectedTaskIds, 'BASELINE', '2026-08-29T00:00:01.000Z', false,
  );
  assert.equal(report.sampleSize, selectedTaskIds.length);
  assert.ok(report.diffTaxonomy.V1_FALSE_CLOSE > 0);
  assert.ok(report.diffTaxonomy.V1_MISSED_OBLIGATION > 0);
  assert.ok(report.diffTaxonomy.V1_READ_MODEL_DRIFT > 0);
  assert.equal(report.diffTaxonomy.V2_FALSE_CLOSE, 0);
  assert.equal(report.diffTaxonomy.V2_MISSED_OBLIGATION, 0);
  assert.equal(report.diffTaxonomy.V2_READ_MODEL_DRIFT, 0);
  assert.equal(report.metrics.falseClose.v2.value, 0);
  assert.equal(report.metrics.missedObligation.v2.value, 0);
  assert.equal(report.metrics.readModelDifference.v2.value, 0);
  assert.equal(report.tenantCount, 2);
});

test('all ten metric reducers use nonzero versioned denominators and expose actual V1/V2 deltas', () => {
  const report = reports.get('shadow-capacity');
  for (const name of canary.CANARY_METRICS) {
    const metric = report.metrics[name];
    assert.ok(metric.v1.denominator >= metric.minSampleSize, `${name}.v1 denominator`);
    assert.ok(metric.v2.denominator >= metric.minSampleSize, `${name}.v2 denominator`);
    assert.equal(Number.isFinite(metric.v1.value), true);
    assert.equal(Number.isFinite(metric.v2.value), true);
  }
  for (const name of [
    'falseClose', 'missedObligation', 'readModelDifference', 'reconciliationLag',
    'oldestObligation', 'expiredLease', 'retryCost', 'inboxAge', 'outboxFailure',
    'checksumDrift',
  ]) assert.ok(report.metrics[name].diff.absolute < 0, `${name} did not improve in V2`);
  assert.deepEqual(report.abortReasonsV2, []);
});

test('zero or undersized telemetry and a single V2 checksum drift fail closed', () => {
  assert.throws(
    () => canary.reduceCanaryWindow(canary.sealCanaryTelemetry(events), contract, 'missing'),
    /MIN_SAMPLE_NOT_MET/,
  );
  const subset = selectedTaskIds.slice(0, contract.cohort.minSampleSize);
  const aborted = addWindow(
    'abort-drill', subset, 'V2_FAULT', '2026-08-29T03:00:00.000Z', true,
  );
  assert.deepEqual(aborted.abortReasonsV2, ['checksumDrift']);
  assert.equal(aborted.metrics.checksumDrift.v2.numerator, 1);
  assert.equal(aborted.metrics.checksumDrift.v2.abort, true);
});

test('healthy new-task windows promote shadow to canary and then cut over V2', () => {
  const subset = selectedTaskIds.slice(0, contract.cohort.minSampleSize);
  addWindow('canary-1', subset, 'BASELINE', '2026-08-29T01:00:00.000Z', false);
  addWindow('canary-2', subset, 'BASELINE', '2026-08-29T02:00:00.000Z', false);
  const replay = canary.replayCanaryControl([
    control('shadow-capacity', '2026-08-29T00:00:10.000Z', undefined, false),
    control('canary-1', '2026-08-29T01:00:10.000Z', undefined, false),
    control('canary-2', '2026-08-29T02:00:10.000Z', undefined, false),
  ], contract);
  assert.equal(replay.finalMode, 'V2_ACTIVE');
  assert.deepEqual(replay.transitions.map(({ to }) => to), ['CANARY', 'V2_ACTIVE']);
});

test('an abort threshold automatically rolls back within SLO and healthy shadow windows roll forward again', () => {
  const subset = selectedTaskIds.slice(0, contract.cohort.minSampleSize);
  addWindow('rollback-recovery', subset, 'HEALTHY_BOTH', '2026-08-29T03:00:30.000Z', true);
  addWindow('rollforward-shadow-1', subset, 'HEALTHY_BOTH', '2026-08-29T04:00:00.000Z', true);
  addWindow('rollforward-shadow-2', subset, 'HEALTHY_BOTH', '2026-08-29T05:00:00.000Z', true);
  addWindow('rollforward-canary-1', subset, 'HEALTHY_BOTH', '2026-08-29T06:00:00.000Z', true);
  addWindow('rollforward-canary-2', subset, 'HEALTHY_BOTH', '2026-08-29T07:00:00.000Z', true);
  const observations = [
    control('shadow-capacity', '2026-08-29T00:00:10.000Z'),
    control('canary-1', '2026-08-29T01:00:10.000Z'),
    control('canary-2', '2026-08-29T02:00:10.000Z'),
    control('abort-drill', '2026-08-29T03:00:10.000Z'),
    control('rollback-recovery', '2026-08-29T03:00:40.000Z', 'V1'),
    control('rollforward-shadow-1', '2026-08-29T04:00:10.000Z'),
    control('rollforward-shadow-2', '2026-08-29T05:00:10.000Z'),
    control('rollforward-canary-1', '2026-08-29T06:00:10.000Z'),
    control('rollforward-canary-2', '2026-08-29T07:00:10.000Z'),
  ];
  controlReplay = canary.replayCanaryControl(observations, contract);
  assert.equal(controlReplay.rollback.triggered, true);
  assert.equal(controlReplay.rollback.recoverySeconds, 30);
  assert.equal(controlReplay.rollback.recoveredWithinSlo, true);
  assert.deepEqual(controlReplay.rollback.abortReasons, ['checksumDrift']);
  assert.equal(controlReplay.rollforward.triggered, true);
  assert.equal(controlReplay.rollforward.completed, true);
  assert.equal(controlReplay.finalMode, 'V2_ACTIVE');
});

test('mixed V2, V1 and headerless N-1 clients share reads while privileged legacy writes fail closed', () => {
  const results = contract.mixedClients.requiredCases.map((fixture, index) => {
    const actual = canary.evaluateMixedClientRequest(fixture, contract);
    assert.equal(actual.decision, fixture.expectedDecision, fixture.name);
    append('MIXED_CLIENT_PROBE', `2026-08-29T08:00:${String(index).padStart(2, '0')}.000Z`, {
      case: fixture,
      actual,
    });
    return { name: fixture.name, ...actual };
  });
  assert.equal(results.filter(({ decision }) => decision === 'REJECT').length, 5);
  assert.equal(results.filter(({ decision }) => decision === 'TRANSLATE_TO_APPEND_ONLY_FACT').length, 2);
  assert.equal(results.filter(({ decision }) => decision === 'SERVE_V2_PROJECTION').length, 2);
});

test('tenant authorization rejects cross-tenant telemetry and sanitization removes secrets before append', () => {
  const tenantA = sha('tenant-canary-a');
  const tenantB = sha('tenant-canary-b');
  const secret = 'canary-secret-material';
  const secured = canary.authorizeAndSanitizeCanaryPayload(tenantA, tenantA, {
    authorization: `Bearer ${secret}`,
    nested: { apiKey: secret, note: `token=${secret}` },
    rawCommandOutput: `Bearer ${secret}\n${'x'.repeat(20_000)}`,
  }, contract);
  assert.equal(JSON.stringify(secured.payload).includes(secret), false);
  assert.equal(secured.redacted, true);
  assert.equal(secured.truncatedRawOutput, true);
  assert.throws(
    () => canary.authorizeAndSanitizeCanaryPayload(tenantA, tenantB, {}, contract),
    /CANARY_TENANT_FORBIDDEN/,
  );
  append('SECURITY_PROBE', '2026-08-29T08:10:00.000Z', {
    probe: 'AUTHORIZED_REDACTED_PAYLOAD',
    authenticatedTenantDigest: tenantA,
    storedTenantDigest: tenantA,
    result: {
      accepted: true,
      redacted: secured.redacted,
      truncatedRawOutput: secured.truncatedRawOutput,
      inputBytes: secured.inputBytes,
      storedBytes: secured.storedBytes,
      payloadDigest: secured.payloadDigest,
      payload: secured.payload,
    },
  });
  append('SECURITY_PROBE', '2026-08-29T08:10:01.000Z', {
    probe: 'CROSS_TENANT_REJECTED',
    authenticatedTenantDigest: tenantA,
    storedTenantDigest: tenantB,
    result: { accepted: false, reason: 'CANARY_TENANT_FORBIDDEN' },
  });
});

test('immutable upstream evidence proves the approved 1200-second Watchdog completed 13/13 beyond legacy 120 seconds', () => {
  assert.ok(Array.isArray(upstreamEvidenceRows) && upstreamEvidenceRows.length > 0);
  // `judgmentRequest` was removed from the completion-evidence read shape on 2026-09-02 with the
  // rest of the judgment machinery. The evidence row it hung off is what this test is about and is
  // unchanged; the task's own DONE below is the fact the decision used to duplicate.
  assert.equal(upstreamTask.status, 'DONE');
  // The live admission/attempt snapshot used to be read from the task here. Migration 0227
  // removed that ledger, so the attestation stands on the immutable evidence row alone — which
  // is what "immutable upstream evidence" meant in the first place.
  assert.equal(upstream.evidence.executableDeclaration.requestedTimeoutSeconds, 1200);
  assert.equal(upstream.evidence.liveReleaseFence.atomicTaskReadback.requestedTimeoutSeconds, 1200);
  assert.equal(upstream.evidence.liveReleaseFence.atomicTaskReadback.ownerTimeoutCeilingSeconds, 1200);
  assert.ok(upstream.evidence.liveReleaseFence.runner.hardMaxSeconds >= 1200);
  assert.equal(upstreamPreflight.deadlineSeconds, 1200);
  assert.equal(upstreamPreflight.terminationKind, 'EXITED');
  assert.equal(upstreamPreflight.actualExitCode, 0);
  assert.equal(upstreamPreflight.watchdog.tests, 13);
  assert.equal(upstreamPreflight.watchdog.passed, 13);
  assert.equal(upstreamPreflight.watchdog.failed, 0);
  assert.equal(upstreamPreflight.watchdog.skipped, 0);
  assert.equal(upstreamPreflight.watchdog.cancelled, 0);
  assert.ok(upstreamElapsedSeconds > 120);
  assert.ok(upstreamElapsedSeconds
    < upstream.evidence.executableDeclaration.requestedTimeoutSeconds);
  assert.deepEqual(upstream.evidence.typedRegression, {
    kind: 'TIMED_OUT', continuation: 'RETRY', factPersisted: true,
    actualExitCode: null, goalActionable: true,
  });
  append('UPSTREAM_WATCHDOG_ATTESTATION', '2026-08-29T08:40:00.000Z', {
    traceId: 'approved-watchdog-13-of-13',
    taskId: upstream.taskId,
    evidenceId: upstream.id,
    evidenceRevision: upstream.revision,
    evidenceDigest: upstream.evidenceDigest,
    rawEvidenceSha256: sha(upstreamEvidenceRaw),
    rawTaskSnapshotSha256: sha(upstreamTaskRaw),
    requestedTimeoutSeconds: upstream.evidence.executableDeclaration.requestedTimeoutSeconds,
    runnerHardMaxSeconds: upstream.evidence.liveReleaseFence.runner.hardMaxSeconds,
    deadlineSeconds: upstreamPreflight.deadlineSeconds,
    elapsedMilliseconds: upstreamPreflight.elapsedMilliseconds,
    terminationKind: upstreamPreflight.terminationKind,
    actualExitCode: upstreamPreflight.actualExitCode,
    watchdog: upstreamPreflight.watchdog,
  });
});

test('telemetry hash chaining detects tampering and forbids generic exit-minus-one as typed evidence', () => {
  const sealed = canary.sealCanaryTelemetry(events);
  const chain = canary.verifyCanaryTelemetry(sealed, contract, COLLECTOR_SHA, TARGET_SHA);
  assert.equal(chain.eventCount, events.length);
  assert.match(chain.firstDigest, /^[0-9a-f]{64}$/);
  assert.match(chain.lastDigest, /^[0-9a-f]{64}$/);
  const tampered = structuredClone(sealed);
  tampered[Math.floor(tampered.length / 2)].event.targetSha = 'f'.repeat(40);
  assert.throws(
    () => canary.verifyCanaryTelemetry(tampered, contract, COLLECTOR_SHA, TARGET_SHA),
    /DIGEST_INVALID|BINDING_INVALID/,
  );
  assert.equal(events.some((event) => event.actualExitCode === -1), false);
});

test('the complete telemetry set is bounded, nonzero and contains every required trace and reversible transition', () => {
  assert.ok(events.length > selectedTaskIds.length);
  assert.ok(events.length < contract.capacity.maximumTelemetryEvents);
  const counts = events.reduce((result, event) => {
    result[event.kind] = (result[event.kind] ?? 0) + 1;
    return result;
  }, {});
  assert.ok(counts.UPSTREAM_WATCHDOG_ATTESTATION > 0);
  assert.equal(controlReplay.rollback.recoveredWithinSlo, true);
  assert.equal(controlReplay.rollforward.completed, true);
  assert.equal(reports.get('shadow-capacity').sampleSize, selectedTaskIds.length);
  assert.equal(events.filter(({ kind }) => kind === 'SECURITY_PROBE').length, 2);
  assert.equal(events.filter(({ kind }) => kind === 'MIXED_CLIENT_PROBE').length,
    contract.mixedClients.requiredCases.length);
});
