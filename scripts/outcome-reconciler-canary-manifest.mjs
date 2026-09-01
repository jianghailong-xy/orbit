#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const [
  tapArg,
  telemetryArg,
  contractArg,
  upstreamEvidenceArg,
  upstreamTaskArg,
  outputArg,
] = process.argv.slice(2);
assert.ok(
  tapArg && telemetryArg && contractArg && upstreamEvidenceArg && upstreamTaskArg && outputArg,
  'usage: outcome-reconciler-canary-manifest.mjs TAP TELEMETRY CONTRACT '
    + 'UPSTREAM_EVIDENCE UPSTREAM_TASK OUTPUT',
);
const modulePath = process.env.OUTCOME_CANARY_MODULE;
assert.ok(modulePath, 'OUTCOME_CANARY_MODULE is required');
const canary = await import(pathToFileURL(path.resolve(modulePath)).href);
const tap = readFileSync(path.resolve(tapArg), 'utf8');
const telemetryRaw = readFileSync(path.resolve(telemetryArg), 'utf8');
const contractRaw = readFileSync(path.resolve(contractArg), 'utf8');
const upstreamEvidenceRaw = readFileSync(path.resolve(upstreamEvidenceArg), 'utf8');
const upstreamTaskRaw = readFileSync(path.resolve(upstreamTaskArg), 'utf8');
const contract = JSON.parse(contractRaw);
const upstreamEvidenceRows = JSON.parse(upstreamEvidenceRaw);
const upstream = upstreamEvidenceRows[0];
const upstreamTask = JSON.parse(upstreamTaskRaw);
const outputPath = path.resolve(outputArg);
const envelopes = telemetryRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const events = envelopes.map(({ event }) => event);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileDigest(relative) {
  return digest(readFileSync(path.join(ROOT, relative)));
}

function counter(name) {
  const match = tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
  assert.ok(match, `TAP summary is missing ${name}`);
  return Number(match[1]);
}

function onlyEvent(kind) {
  const matches = events.filter((event) => event.kind === kind);
  assert.equal(matches.length, 1, `${kind} must have exactly one telemetry event`);
  return matches[0];
}

const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim();
const collectorSha = process.env.OUTCOME_CANARY_COLLECTOR_SHA;
assert.match(targetSha, /^[0-9a-f]{40}$/);
assert.match(collectorSha ?? '', /^[0-9a-f]{40}$/);
canary.validateCanaryContract(contract);
const chain = canary.verifyCanaryTelemetry(envelopes, contract, collectorSha, targetSha);

const summary = {
  tests: counter('tests'),
  passed: counter('pass'),
  failed: counter('fail'),
  skipped: counter('skipped'),
  cancelled: counter('cancelled'),
  todo: counter('todo'),
};
assert.ok(summary.tests >= 14, 'canary suite was truncated');
assert.equal(summary.passed, summary.tests, 'not every canary test passed');
assert.equal(summary.failed, 0, 'canary test failures are forbidden');
assert.equal(summary.skipped, 0, 'canary test skips are forbidden');
assert.equal(summary.cancelled, 0, 'canary test cancellation is forbidden');
assert.equal(summary.todo, 0, 'canary TODO tests are forbidden');

const cohort = onlyEvent('COHORT_SNAPSHOT');
assert.equal(cohort.eligibleTasks, contract.capacity.tasks);
assert.ok(cohort.selectedTasks >= contract.cohort.minSampleSize);
assert.equal(cohort.rolloutBasisPoints, contract.cohort.rolloutBasisPoints);
assert.ok(cohort.selectionMilliseconds < contract.capacity.maximumCohortSelectionMilliseconds);
const selectedTaskEvents = events.filter((event) => (
  event.kind === 'TASK_OBSERVATION' && event.windowId === 'shadow-capacity'
));
assert.equal(selectedTaskEvents.length, cohort.selectedTasks,
  'the declared cohort contains missing task observations');
assert.equal(new Set(selectedTaskEvents.map(({ taskId }) => taskId)).size, cohort.selectedTasks);
assert.equal(canary.canaryDigest(selectedTaskEvents.map(({ taskId }) => taskId)),
  cohort.selectionDigest);

const controlEvents = events.filter((event) => (
  event.kind === 'CONTROL_OBSERVATION'
  && event.controlRunId === 'rollback-rollforward-drill'
));
assert.equal(controlEvents.length, 9, 'the rollback/rollforward control trace is incomplete');
const reports = new Map();
for (const windowId of new Set([
  'shadow-capacity',
  ...controlEvents.map((event) => event.windowId),
])) {
  reports.set(windowId, canary.reduceCanaryWindow(envelopes, contract, windowId));
}
const shadow = reports.get('shadow-capacity');
assert.equal(shadow.sampleSize, cohort.selectedTasks);
assert.equal(shadow.authorizationViolations, 0);
assert.ok(shadow.tenantCount >= 2);
assert.deepEqual(shadow.abortReasonsV2, []);
for (const [name, metric] of Object.entries(shadow.metrics)) {
  assert.ok(metric.denominatorDefinition.length > 0, `${name} denominator missing`);
  assert.ok(metric.window.seconds > 0, `${name} window missing`);
  assert.ok(metric.minSampleSize > 0, `${name} minimum sample missing`);
  assert.ok(metric.v1.denominator >= metric.minSampleSize, `${name}.v1 sample insufficient`);
  assert.ok(metric.v2.denominator >= metric.minSampleSize, `${name}.v2 sample insufficient`);
  assert.equal(metric.v2.sloPass, true, `${name}.v2 missed SLO`);
  assert.equal(metric.v2.abort, false, `${name}.v2 reached abort threshold`);
}
for (const name of [
  'falseClose', 'missedObligation', 'readModelDifference', 'reconciliationLag',
  'oldestObligation', 'expiredLease', 'retryCost', 'inboxAge', 'outboxFailure',
  'checksumDrift', 'acceptanceRuntimeDeadline',
]) assert.ok(shadow.metrics[name].diff.absolute < 0, `${name} has no measured V1/V2 delta`);

const control = canary.replayCanaryControl(controlEvents.map((event) => ({
  windowId: event.windowId,
  observedAt: event.observedAt,
  report: reports.get(event.windowId),
  recoveryVersion: event.recoveryVersion,
})), contract);
assert.equal(control.rollback.triggered, true);
assert.equal(control.rollback.recoveredWithinSlo, true);
assert.ok(control.rollback.recoverySeconds > 0);
assert.ok(control.rollback.recoverySeconds <= contract.control.maximumRollbackRecoverySeconds);
assert.ok(control.rollback.abortReasons.length > 0);
assert.equal(control.rollforward.triggered, true);
assert.equal(control.rollforward.completed, true);
assert.equal(control.finalMode, 'V2_ACTIVE');
assert.ok(control.transitions.some(({ to, automatic }) => to === 'ROLLING_BACK' && automatic));

const mixedClientEvents = events.filter(({ kind }) => kind === 'MIXED_CLIENT_PROBE');
assert.equal(mixedClientEvents.length, contract.mixedClients.requiredCases.length);
const mixedClientMatrix = mixedClientEvents.map((event) => {
  const replayed = canary.evaluateMixedClientRequest(event.case, contract);
  assert.deepEqual(replayed, event.actual, `mixed-client replay drift: ${event.case.name}`);
  assert.equal(replayed.decision, event.case.expectedDecision);
  return { ...event.case, decision: replayed.decision, reason: replayed.reason };
});
assert.ok(mixedClientMatrix.some(({ protocol, decision }) => protocol === 'V1'
  && decision === 'TRANSLATE_TO_APPEND_ONLY_FACT'));
assert.ok(mixedClientMatrix.some(({ protocol, decision }) => protocol === 'V0'
  && decision === 'REJECT'));

const securityEvents = events.filter(({ kind }) => kind === 'SECURITY_PROBE');
assert.equal(securityEvents.length, 2);
const acceptedSecurity = securityEvents.find(({ probe }) => probe === 'AUTHORIZED_REDACTED_PAYLOAD');
const rejectedSecurity = securityEvents.find(({ probe }) => probe === 'CROSS_TENANT_REJECTED');
assert.equal(acceptedSecurity.result.accepted, true);
assert.equal(acceptedSecurity.result.redacted, true);
assert.equal(acceptedSecurity.result.truncatedRawOutput, true);
assert.equal(rejectedSecurity.result.accepted, false);
assert.equal(rejectedSecurity.result.reason, 'CANARY_TENANT_FORBIDDEN');
assert.equal(telemetryRaw.includes('canary-secret-material'), false,
  'a raw secret landed in telemetry');
assert.equal(telemetryRaw.includes('tenant-canary-a'), false,
  'a raw tenant identifier landed in telemetry');
assert.equal(telemetryRaw.includes('tenant-canary-b'), false,
  'a raw tenant identifier landed in telemetry');

const matrixEvent = onlyEvent('ACCEPTANCE_CAPABILITY_MATRIX');
const acceptanceMatrix = canary.acceptanceCapabilityMatrix(contract, targetSha);
assert.deepEqual(matrixEvent.matrix, acceptanceMatrix);
for (const row of acceptanceMatrix.filter(({ decision }) => decision === 'REJECTED')) {
  assert.equal(row.spawnCount, 0);
  assert.equal(row.effectiveTimeoutSeconds, null);
}
for (const row of acceptanceMatrix.filter(({ decision }) => decision === 'ADMITTED')) {
  assert.equal(row.effectiveTimeoutSeconds, 1200);
}
const rejectedAdmission = onlyEvent('ADMISSION_REJECTED');
assert.equal(rejectedAdmission.rejectionCode, 'RUNNER_HARD_MAX_INSUFFICIENT');
assert.equal(rejectedAdmission.spawnCount, 0);
assert.equal(rejectedAdmission.attemptCount, 0);

const timeoutEvents = events.filter(({ kind }) => kind === 'TIMED_OUT_CONTINUATION');
const expectedTimeoutTrace = canary.timeoutContinuationTrace(contract);
assert.equal(timeoutEvents.length, expectedTimeoutTrace.length);
assert.deepEqual(timeoutEvents.map(({ attempt, terminationKind, actualExitCode,
  continuation, reasonCode }) => ({
  attempt, terminationKind, actualExitCode, continuation, reasonCode,
})), expectedTimeoutTrace);
assert.deepEqual(timeoutEvents.map(({ continuation }) => continuation),
  ['RETRY', 'DIAGNOSIS', 'SUCCESSOR']);
assert.ok(timeoutEvents.every(({ goalActionable, actualExitCode }) => (
  goalActionable === true && actualExitCode === null
)));

assert.ok(Array.isArray(upstreamEvidenceRows) && upstreamEvidenceRows.length > 0);
assert.equal(upstream.taskId, '34Ex0SFCY6DpfvW2I4ydE');
assert.equal(upstream.judgmentRequest.decision, 'PASS');
const preflight = upstream.evidence.exactShaPreflight;
const liveAdmission = upstreamTask.executableAcceptanceAdmissions.find(
  ({ decision }) => decision === 'ADMITTED',
);
assert.ok(liveAdmission, 'upstream Watchdog ADMITTED record is missing');
assert.equal(liveAdmission.requestedTimeoutSeconds, 1200);
assert.equal(liveAdmission.effectiveTimeoutSeconds, 1200);
assert.equal(liveAdmission.spawnCount, 1);
assert.equal(liveAdmission.attempt.terminationKind, 'EXITED');
assert.equal(liveAdmission.attempt.actualExitCode, 0);
assert.equal(preflight.deadlineSeconds, 1200);
assert.equal(preflight.watchdog.tests, 13);
assert.equal(preflight.watchdog.passed, 13);
assert.equal(preflight.watchdog.failed, 0);
assert.equal(preflight.watchdog.skipped, 0);
assert.ok(preflight.elapsedMilliseconds > contract.acceptanceRuntime.legacyCutoffSeconds * 1_000);
assert.ok(preflight.elapsedMilliseconds < contract.acceptanceRuntime.requestedTimeoutSeconds * 1_000);
assert.deepEqual(upstream.evidence.typedRegression, {
  kind: 'TIMED_OUT', continuation: 'RETRY', factPersisted: true,
  actualExitCode: null, goalActionable: true,
});
const upstreamTrace = onlyEvent('UPSTREAM_WATCHDOG_ATTESTATION');
assert.equal(upstreamTrace.rawEvidenceSha256, digest(upstreamEvidenceRaw));
assert.equal(upstreamTrace.rawTaskSnapshotSha256, digest(upstreamTaskRaw));
assert.equal(upstreamTrace.evidenceDigest, upstream.evidenceDigest);
assert.equal(upstreamTrace.admissionId, liveAdmission.id);
assert.equal(upstreamTrace.attemptId, liveAdmission.attempt.id);
assert.equal(upstreamTrace.watchdog.tests, 13);
assert.equal(upstreamTrace.watchdog.passed, 13);

const traceCounts = {
  ADMISSION_REJECTED: events.filter(({ kind }) => kind === 'ADMISSION_REJECTED').length,
  TIMED_OUT_RETRY_DIAGNOSIS_SUCCESSOR: timeoutEvents.length > 0 ? 1 : 0,
  WATCHDOG_13_OF_13: events.filter(({ kind }) => kind === 'UPSTREAM_WATCHDOG_ATTESTATION').length,
};
for (const kind of contract.acceptanceRuntime.requiredTraceKinds) {
  assert.ok(traceCounts[kind] > 0, `${kind} trace is zero`);
}
assert.equal(events.some(({ actualExitCode }) => actualExitCode === -1), false,
  'generic exit -1 cannot satisfy the canary');

const sourceFiles = [
  'contracts/outcome-reconciler-v2-canary.json',
  'contracts/outcome-reconciler-v2.contract.json',
  'package.json',
  'scripts/outcome-reconciler-canary.sh',
  'scripts/outcome-reconciler-canary-manifest.mjs',
  'scripts/outcome-reconciler-canary-verify.mjs',
  'src/apiserver/src/outcome-reconciler/outcome-canary.ts',
  'src/apiserver/src/outcome-reconciler/outcome-payload-redaction.ts',
  'src/apiserver/src/tasks/executable-acceptance-runtime.ts',
  'test/outcome-reconciler-v2.canary.test.mjs',
];
const sourceDigests = Object.fromEntries(sourceFiles.map((relative) => [
  relative,
  fileDigest(relative),
]));
const sourceStatus = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', ...sourceFiles], {
  cwd: ROOT,
});
assert.ok([0, 1].includes(sourceStatus.status), 'unable to inspect source binding');
const startedAt = process.env.OUTCOME_CANARY_STARTED_AT;
assert.match(startedAt ?? '', /^\d{4}-\d\d-\d\dT/, 'OUTCOME_CANARY_STARTED_AT is required');
const metricDimensions = Object.fromEntries(Object.entries(shadow.metrics).map(([name, metric]) => [
  name,
  {
    numerator: metric.numeratorDefinition,
    denominator: metric.denominatorDefinition,
    minSampleSize: metric.minSampleSize,
    observationWindow: metric.window,
    v1: metric.v1,
    v2: metric.v2,
    diff: metric.diff,
    slo: metric.slo,
    abortThreshold: metric.abortThreshold,
  },
]));
const body = {
  schemaVersion: 2,
  suite: 'outcome-reconciler-v2-canary',
  command: 'npm run test:outcome-reconciler:canary',
  expectedExitCode: 0,
  outcome: 'PASS',
  targetSha,
  collectorSha,
  targetBranch: execFileSync('git', ['branch', '--show-current'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim(),
  summary,
  versions: {
    collector: {
      name: contract.collector.name,
      version: contract.collector.version,
      sha: collectorSha,
    },
    telemetrySchemaRevision: contract.collector.telemetrySchemaRevision,
    capabilityRevision: contract.collector.capabilityRevision,
    evaluatorVersion: contract.collector.evaluatorVersion,
    targetSha,
  },
  cohort: {
    population: cohort.population,
    selection: contract.cohort.selection,
    rolloutBasisPoints: cohort.rolloutBasisPoints,
    denominator: cohort.denominator,
    minimumSampleSize: contract.cohort.minSampleSize,
    eligibleTasks: cohort.eligibleTasks,
    selectedTasks: cohort.selectedTasks,
    selectionDigest: cohort.selectionDigest,
    selectionMilliseconds: cohort.selectionMilliseconds,
    observationWindow: contract.cohort.observationWindow,
    missingObservationPolicy: 'COUNT_AS_V2_FAILURE_AFTER_WINDOW',
  },
  v1V2DiffTaxonomy: shadow.diffTaxonomy,
  metricDimensions,
  slo: Object.fromEntries(Object.entries(metricDimensions).map(([name, metric]) => [
    name,
    { objective: metric.slo, v1Pass: metric.v1.sloPass, v2Pass: metric.v2.sloPass },
  ])),
  abortCriteria: Object.fromEntries(Object.entries(metricDimensions).map(([name, metric]) => [
    name,
    { threshold: metric.abortThreshold, v2Aborted: metric.v2.abort },
  ])),
  control: {
    policy: contract.control,
    replay: control,
  },
  rollback: {
    automatic: contract.control.automaticRollback,
    strategy: contract.control.rollback,
    ...control.rollback,
  },
  rollforward: {
    strategy: contract.control.rollforward,
    ...control.rollforward,
    finalMode: control.finalMode,
  },
  mixedClientMatrix,
  acceptanceCapabilityMatrix: acceptanceMatrix,
  traces: {
    counts: traceCounts,
    ADMISSION_REJECTED: {
      requestedTimeoutSeconds: rejectedAdmission.requestedTimeoutSeconds,
      runnerHardMaxSeconds: rejectedAdmission.runnerHardMaxSeconds,
      rejectionCode: rejectedAdmission.rejectionCode,
      spawnCount: rejectedAdmission.spawnCount,
      attemptCount: rejectedAdmission.attemptCount,
    },
    TIMED_OUT_RETRY_DIAGNOSIS_SUCCESSOR: {
      terminationKind: 'TIMED_OUT',
      actualExitCode: null,
      goalActionable: true,
      path: timeoutEvents.map(({ continuation }) => continuation),
      events: timeoutEvents.length,
    },
    WATCHDOG_13_OF_13: {
      upstreamTaskId: upstream.taskId,
      upstreamEvidenceId: upstream.id,
      upstreamEvidenceDigest: upstream.evidenceDigest,
      judgmentDecision: upstream.judgmentRequest.decision,
      admissionId: liveAdmission.id,
      attemptId: liveAdmission.attempt.id,
      requestedTimeoutSeconds: liveAdmission.requestedTimeoutSeconds,
      effectiveTimeoutSeconds: liveAdmission.effectiveTimeoutSeconds,
      runnerHardMaxSeconds: liveAdmission.runnerHardMaxSeconds,
      spawnCount: liveAdmission.spawnCount,
      deadlineSeconds: preflight.deadlineSeconds,
      elapsedMilliseconds: preflight.elapsedMilliseconds,
      legacyCutoffSeconds: contract.acceptanceRuntime.legacyCutoffSeconds,
      crossedLegacyCutoff: preflight.elapsedMilliseconds
        > contract.acceptanceRuntime.legacyCutoffSeconds * 1_000,
      terminationKind: liveAdmission.attempt.terminationKind,
      actualExitCode: liveAdmission.attempt.actualExitCode,
      tests: preflight.watchdog.tests,
      passed: preflight.watchdog.passed,
      failed: preflight.watchdog.failed,
      skipped: preflight.watchdog.skipped,
      manifestDigest: preflight.watchdog.manifestDigest,
    },
  },
  capacity: {
    eligibleTasks: cohort.eligibleTasks,
    selectedTasks: cohort.selectedTasks,
    telemetryEvents: chain.eventCount,
    selectionMilliseconds: cohort.selectionMilliseconds,
    maximumSelectionMilliseconds: contract.capacity.maximumCohortSelectionMilliseconds,
    upstreamWatchdog: upstream.evidence.capacity,
  },
  security: {
    tenantCount: shadow.tenantCount,
    authorizationViolations: shadow.authorizationViolations,
    currentTelemetry: {
      tenantIsolation: true,
      crossTenantRejected: true,
      secretRedaction: true,
      rawOutputBounded: true,
      rawTenantIdentifiersStored: 0,
    },
    upstreamWatchdog: upstream.evidence.security,
  },
  telemetry: {
    schemaRevision: contract.collector.telemetrySchemaRevision,
    events: chain.eventCount,
    firstEventDigest: chain.firstDigest,
    lastEventDigest: chain.lastDigest,
    sha256: digest(telemetryRaw),
    appendOnlyHashChainVerified: true,
  },
  upstreamEvidence: {
    taskId: upstream.taskId,
    evidenceId: upstream.id,
    revision: upstream.revision,
    evidenceDigest: upstream.evidenceDigest,
    evidenceFileSha256: digest(upstreamEvidenceRaw),
    taskSnapshotSha256: digest(upstreamTaskRaw),
    judgmentDecision: upstream.judgmentRequest.decision,
  },
  sources: sourceDigests,
  sourceDigest: canary.canaryDigest(sourceDigests),
  targetBinding: {
    targetSha,
    sourceContentDigest: canary.canaryDigest(sourceDigests),
    sourceFilesCommittedAtGeneration: sourceStatus.status === 0,
  },
  window: {
    startedAt,
    finishedAt: new Date().toISOString(),
    declared: contract.cohort.observationWindow,
    observed: shadow.observedWindow,
  },
  inputDigests: {
    tap: digest(tap),
    telemetry: digest(telemetryRaw),
    contract: digest(contractRaw),
    upstreamEvidence: digest(upstreamEvidenceRaw),
    upstreamTask: digest(upstreamTaskRaw),
  },
};

const manifestDigest = canary.canaryDigest(body);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const signedBytes = Buffer.from(manifestDigest, 'hex');
const signature = sign(null, signedBytes, privateKey);
assert.equal(verify(null, signedBytes, publicKey, signature), true,
  'generated manifest signature did not verify');
const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
const manifest = {
  ...body,
  manifestDigest,
  manifestHash: manifestDigest,
  signature: {
    algorithm: 'Ed25519',
    signedField: 'manifestDigest',
    signedDigest: manifestDigest,
    publicKeyFormat: 'SPKI_DER_BASE64',
    publicKey: publicKeyDer.toString('base64'),
    publicKeySha256: digest(publicKeyDer),
    value: signature.toString('base64'),
    verifiedAtGeneration: true,
  },
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  outcome: manifest.outcome,
  targetSha: manifest.targetSha,
  tests: summary.tests,
  skipped: summary.skipped,
  cohort: { eligible: cohort.eligibleTasks, selected: cohort.selectedTasks },
  rollbackRecoverySeconds: control.rollback.recoverySeconds,
  rollforwardCompleted: control.rollforward.completed,
  traceCounts,
  manifestDigest,
  signature: 'Ed25519:verified',
}, null, 2));
console.log(`outcome-canary manifest: ${outputPath}`);
