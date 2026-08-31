#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const [
  tapArg, evidenceArg, contractArg, outputArg, capacityArg,
  runtimeEvidenceArg, runtimeManifestArg,
] = process.argv.slice(2);
assert.ok(
  tapArg && evidenceArg && contractArg && outputArg && capacityArg
    && runtimeEvidenceArg && runtimeManifestArg,
  'usage: outcome-reconciler-watchdog-manifest.mjs TAP EVIDENCE CONTRACT OUTPUT CAPACITY '
    + 'RUNTIME_EVIDENCE RUNTIME_MANIFEST',
);
const tap = readFileSync(path.resolve(tapArg), 'utf8');
const evidence = JSON.parse(readFileSync(path.resolve(evidenceArg), 'utf8'));
const contract = JSON.parse(readFileSync(path.resolve(contractArg), 'utf8'));
const runtimeEvidence = JSON.parse(readFileSync(path.resolve(runtimeEvidenceArg), 'utf8'));
const runtimeManifest = JSON.parse(readFileSync(path.resolve(runtimeManifestArg), 'utf8'));
const outputPath = path.resolve(outputArg);
const capacityPath = path.resolve(capacityArg);
const liveReleaseFenceRequired = process.env.OUTCOME_WATCHDOG_LIVE_RELEASE_FENCE !== 'offline';

function counter(name) {
  const match = tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
  assert.ok(match, `TAP summary is missing ${name}`);
  return Number(match[1]);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function canonicalDigest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function fileDigest(relative) {
  return createHash('sha256').update(readFileSync(path.join(ROOT, relative))).digest('hex');
}

function fullSha(value, label) {
  assert.match(value ?? '', /^[0-9a-f]{40}$/, `${label} is not an exact build SHA`);
  return value;
}

function inspectRuntimeContainer(name) {
  const inspected = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }))[0];
  const environment = Object.fromEntries((inspected.Config.Env ?? []).map((entry) => {
    const separator = entry.indexOf('=');
    return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  return {
    name,
    imageId: inspected.Image,
    startedAt: inspected.State.StartedAt,
    collectorSha: environment.OUTCOME_WATCHDOG_COLLECTOR_SHA ?? null,
    targetSha: environment.OUTCOME_WATCHDOG_TARGET_SHA ?? null,
    deadManSourceSha: environment.EXECUTABLE_DEAD_MAN_SOURCE_SHA ?? null,
  };
}

function taskSnapshot(taskId) {
  const orbit = process.env.OUTCOME_WATCHDOG_ORBIT_CLI ?? '/usr/local/bin/orbit';
  return JSON.parse(execFileSync(orbit, ['task', 'get', taskId, '--json'], { encoding: 'utf8' }));
}

const successor = taskSnapshot('34Ex0SFCY6DpfvW2I4ydE');
const legacy = taskSnapshot('34Elz5t7HAZZRf6ruE73y');
const replay = taskSnapshot('34EVtJuwMDJkbocbCPllX');
const canary = taskSnapshot('34EVtJyRwtCxw0Dv9yE6N');

function assertAllTrue(object, label) {
  for (const [key, value] of Object.entries(object)) {
    assert.equal(value, true, `${label}.${key} was not proven`);
  }
}

function validateMetric(metric, label) {
  assert.ok(metric.window.seconds > 0 && metric.window.logicalTicks > 0,
    `${label} has no bounded window`);
  assert.ok(metric.denominator.trim().length > 0, `${label} has no denominator`);
  assert.ok(metric.minSampleSize > 0, `${label} has no minimum sample`);
  assert.equal(metric.collectorSha, 'RUNTIME_REQUIRED', `${label} collector SHA is not bound`);
  assert.equal(metric.targetSha, 'RUNTIME_REQUIRED', `${label} target SHA is not bound`);
  assert.ok(Object.keys(metric.abortThreshold).length > 0, `${label} has no abort threshold`);
}

const summary = {
  tests: counter('tests'),
  passed: counter('pass'),
  failed: counter('fail'),
  skipped: counter('skipped'),
  cancelled: counter('cancelled'),
  todo: counter('todo'),
};
assert.ok(summary.tests >= 22, 'the watchdog suite is unexpectedly empty or truncated');
assert.equal(summary.passed, summary.tests, 'not every watchdog test passed');
assert.equal(summary.failed, 0, 'watchdog suite contains failures');
assert.equal(summary.skipped, 0, 'skipped watchdog tests are forbidden');
assert.equal(summary.cancelled, 0, 'cancelled watchdog tests are forbidden');
assert.equal(summary.todo, 0, 'todo watchdog tests are forbidden');
assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.suite, 'outcome-reconciler-v2-watchdog');
assert.equal(evidence.postgres.required, true);
assert.equal(evidence.postgres.connected, true, 'PostgreSQL was not exercised');
assert.match(evidence.postgres.version, /^1[6-9]\./, 'PostgreSQL 16+ is required');
assert.match(evidence.postgres.systemIdentifier, /^[0-9]+$/);
assert.match(evidence.collectorSha, /^[0-9a-f]{40}$/);
assert.match(evidence.targetSha, /^[0-9a-f]{40}$/);
for (const label of ['independence', 'faults', 'security', 'sloCanary']) {
  assertAllTrue(evidence[label], label);
}

// The progress dimension is a separate proof obligation from liveness, and it is the one that was
// missing while a stalled goal reported healthy for three days. A run that proves only liveness
// does not publish a manifest.
const progress = evidence.progress;
assert.equal(progress.stalledWhileLivenessGreen, true,
  'no run proved a liveness-green, progress-flat tenant is reported stalled');
assert.equal(progress.advancingNotReported, true,
  'no run proved an advancing goal is left alone');
assert.equal(progress.independentOfSelfCorrection, true,
  'no run proved the stall survives the self-correction channel being dead');
assert.equal(progress.alertConstancyDiagnosed, true,
  'no run proved a permanently constant alert count is itself diagnosed');
assert.deepEqual(progress.realCurve, [10, 25, 31, 36, 36],
  "the collector did not reproduce this project's own success-node curve");
assert.deepEqual(progress.realCurveTransitions, ['ADVANCED', 'ADVANCED', 'ADVANCED', 'FLAT'],
  'the first three transitions must be progress and the fourth must not');
assert.ok(progress.disabledSignalSources.length >= 8,
  'the independence proof disabled too little of the self-correction channel');
for (const source of contract.progressIndependence.forbiddenSignalSources) {
  assert.ok(progress.disabledSignalSources.includes(source),
    `${source} is declared forbidden but was never taken away during the independence proof`);
}
assert.equal(progress.livenessHeartbeatStopped, true, 'heartbeat detection regressed');
assert.equal(progress.livenessProjectionStale, true, 'projection staleness detection regressed');
assert.ok(progress.livenessStaleAttempts > 0, 'stale-attempt detection regressed');
assert.equal(progress.livenessDeadManMissing, true, 'dead-man detection regressed');
assert.ok(contract.progressIndependence.permittedSignalSources.every(
  (source) => !contract.progressIndependence.forbiddenSignalSources.includes(source),
), 'the two signal channels overlap in the contract that declares them separate');
validateMetric(contract.operationalSlo, 'operationalSlo');
for (const [name, metric] of Object.entries(contract.metrics)) validateMetric(metric, name);
for (const [name, metric] of Object.entries(contract.canary.metrics)) {
  validateMetric(metric, `canary.${name}`);
}

const capacity = evidence.capacity;
assert.ok(capacity.taskScale >= 110_000 && capacity.taskScale <= 112_000,
  'capacity fixture is not approximately 111k tasks');
assert.equal(contract.capacity.requiredIndexes.length, 9,
  'the Watchdog capacity contract must retain its declared 9/9 index surface');
assert.equal(capacity.queryRowLimit, contract.capacity.queryRowLimit);
assert.equal(capacity.checksumSampleLimit, contract.capacity.checksumSampleLimit);
assert.deepEqual(capacity.indexesPresent, [...contract.capacity.requiredIndexes].sort());
assert.deepEqual(
  contract.capacity.requiredIndexes.filter((index) => capacity.indexesUsed.includes(index)).sort(),
  [...contract.capacity.requiredIndexes].sort(),
  'not every one of the 9 required indexes was actually hit',
);
assert.ok(Object.keys(capacity.plans).length >= 7);
for (const [name, plan] of Object.entries(capacity.plans)) {
  assert.equal(plan.hasLimit, true, `${name} is unbounded`);
  assert.ok(plan.returnedRows <= contract.capacity.queryRowLimit, `${name} exceeded row limit`);
}
assert.ok(capacity.maximumQueryMilliseconds <= contract.capacity.maximumQueryP99Milliseconds);
assert.equal(capacity.replaySampleCount, capacity.taskScale);
assert.ok(capacity.replayDurationMilliseconds > 0);
assert.ok(capacity.storageGrowthBytes > 0);
assert.ok(capacity.storageBytesPerTask <= contract.capacity.maximumStorageBytesPerTask);
assert.match(capacity.replayDigest, /^[0-9a-f]{64}$/);

assert.equal(runtimeManifest.outcome, 'PASS');
assert.equal(runtimeManifest.sourceSha, evidence.targetSha,
  'runtime closure was not rerun on the Watchdog target SHA');
assert.equal(runtimeManifest.summary.skipped, 0);
assert.equal(runtimeEvidence.negotiation.rejected.spawnCount, 0);
assert.equal(runtimeEvidence.negotiation.admitted.effectiveTimeoutSeconds, 1200);
const persistedTimeout = runtimeEvidence.persistedTypedAttempts
  .find(({ kind }) => kind === 'TIMED_OUT');
assert.deepEqual(persistedTimeout, {
  kind: 'TIMED_OUT', factPersisted: true, actualExitCode: null,
  goalActionable: true, continuation: 'RETRY',
});
assert.equal(runtimeEvidence.legacy.legacyTermination, 'UNTYPED');
assert.equal(runtimeEvidence.legacy.legacyExitCode, -1);
assert.equal(runtimeEvidence.legacy.diagnosis, 'TIMEOUT');
assert.equal(runtimeEvidence.legacy.evidence.typedTerminationClaimed, false);
assert.equal(runtimeEvidence.watchdog.workerTerminated, true);
assert.equal(runtimeEvidence.watchdog.staleEvent, true);
assert.equal(runtimeEvidence.watchdog.allSixSurfacesStale, true);
assert.equal(runtimeEvidence.watchdog.allSixSurfacesRecovered, true);
assert.equal(runtimeEvidence.watchdog.recoveryCleared, true);
assert.equal(runtimeEvidence.watchdog.deadmanReadsWorkerProjection, false);
assert.equal(runtimeEvidence.watchdog.neverHeartbeatedGenerationDetected, true);
assert.equal(runtimeEvidence.watchdog.missingEventExactlyOnce, true);

assert.equal(successor.id, '34Ex0SFCY6DpfvW2I4ydE');
assert.equal(successor.acceptanceTimeoutSeconds, 1200);
assert.equal(successor.acceptanceOwnerTimeoutCeilingSeconds, 1200);
assert.equal(successor.acceptanceSchemaRevision, 2);
assert.equal(successor.acceptanceCapabilityRevision, 2);
assert.ok(successor.supersedes.some(({ id }) => id === '34Elz5t7HAZZRf6ruE73y'));
assert.equal(legacy.id, '34Elz5t7HAZZRf6ruE73y');
assert.equal(legacy.status, 'FAILED');
assert.equal(legacy.outcome, 'SUPERSEDED');
assert.equal(legacy.supersededByTaskId, successor.id);
const legacyAttempt = legacy.executableAcceptanceAttempts.find(
  ({ sessionId }) => sessionId === '3RIgJAt2GsNCTVoKKfOvK',
);
assert.equal(legacyAttempt.legacyTermination, 'UNTYPED');
assert.equal(legacyAttempt.legacyExitCode, -1);
assert.equal(legacyAttempt.terminationKind, null);
const legacyDiagnosis = legacy.executableAcceptanceDiagnoses.find(
  ({ sessionId, kind }) => sessionId === '3RIgJAt2GsNCTVoKKfOvK' && kind === 'TIMEOUT',
);
assert.equal(legacyDiagnosis.source, 'LEGACY_DEADLINE_EVIDENCE');
assert.equal(legacyDiagnosis.evidence.typedTerminationClaimed, false);
for (const [name, downstream] of [['replay', replay], ['canary', canary]]) {
  assert.notEqual(downstream.dependencyState, 'BLOCKED_FAILED',
    `${name} remained pinned to the superseded FAILED attempt`);
  assert.ok(downstream.dependsOn.some(({ dependsOnTaskId }) => dependsOnTaskId === successor.id),
    `${name} is not owned by the current successor goal`);
}

let liveReleaseFence = { mode: 'OFFLINE_DEV_ONLY' };
if (liveReleaseFenceRequired) {
  assert.equal(successor.autoRunWhenReady, true,
    'successor was not released after the live readback');
  const admission = successor.executableAcceptanceAdmissions[0];
  assert.ok(admission, 'the live v2 admission is missing');
  assert.equal(admission.decision, 'ADMITTED');
  assert.equal(admission.requestedTimeoutSeconds, 1200);
  assert.equal(admission.effectiveTimeoutSeconds, 1200);
  assert.equal(admission.runnerSchemaRevision, successor.acceptanceSchemaRevision);
  assert.ok(admission.runnerCapabilityRevision >= successor.acceptanceCapabilityRevision);
  assert.ok(admission.runnerHardMaxSeconds >= 1200);
  assert.equal(admission.spawnCount, 1,
    'the admitted command did not cross exactly one start boundary');
  const runnerSha = fullSha(admission.runnerSha, 'live runner');
  const server = inspectRuntimeContainer('orbit-apiserver');
  const watchdogRuntime = inspectRuntimeContainer('orbit-watchdog');
  const deadMan = inspectRuntimeContainer('orbit-executable-dead-man');
  assert.equal(server.imageId, watchdogRuntime.imageId,
    'server and SHA-declaring watchdog do not use the same exact image');
  assert.equal(server.imageId, deadMan.imageId,
    'server and external dead-man do not use the same exact image');
  assert.equal(fullSha(watchdogRuntime.collectorSha, 'live watchdog collector'), evidence.targetSha);
  assert.equal(fullSha(watchdogRuntime.targetSha, 'live watchdog target'), evidence.targetSha);
  assert.equal(fullSha(deadMan.deadManSourceSha, 'live external dead-man'), evidence.targetSha);
  liveReleaseFence = {
    mode: 'REQUIRED_AND_SATISFIED',
    serverBuildSha: watchdogRuntime.targetSha,
    serverImageId: server.imageId,
    watchdogCollectorSha: watchdogRuntime.collectorSha,
    deadManSourceSha: deadMan.deadManSourceSha,
    runnerBuildSha: runnerSha,
    runnerSchemaRevision: admission.runnerSchemaRevision,
    runnerCapabilityRevision: admission.runnerCapabilityRevision,
    runnerHardMaxSeconds: admission.runnerHardMaxSeconds,
    requestedTimeoutSeconds: admission.requestedTimeoutSeconds,
    effectiveTimeoutSeconds: admission.effectiveTimeoutSeconds,
    spawnCount: admission.spawnCount,
  };
}

const sourceFiles = [
  '.agents/skills/upgrade/scripts/upgrade.sh',
  '.env.example',
  'contracts/outcome-reconciler-v2-watchdog-slo.json',
  'docker-compose.yml',
  'package.json',
  'scripts/outcome-reconciler-watchdog.sh',
  'scripts/outcome-reconciler-watchdog-manifest.mjs',
  'scripts/executable-acceptance-dead-man.mjs',
  'scripts/executable-acceptance-runtime.sh',
  'scripts/executable-acceptance-runtime-manifest.mjs',
  'src/apiserver/Dockerfile',
  'src/apiserver/package.json',
  'src/apiserver/prisma/migrations/0199_outcome_independent_watchdog_slo_security/migration.sql',
  'src/apiserver/prisma/migrations/0214_watchdog_goal_progress_channel/migration.sql',
  'src/apiserver/src/app.module.ts',
  'src/apiserver/src/common/db-write-inventory.ts',
  'src/apiserver/src/outcome-watchdog/main.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.module.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.runner.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.service.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.worker.module.ts',
  'src/apiserver/src/tasks/tasks.service.ts',
  'test/executable-acceptance-runtime.test.mjs',
  'test/outcome-reconciler-v2.watchdog.test.mjs',
];
const sources = Object.fromEntries(sourceFiles.map((relative) => [relative, fileDigest(relative)]));
const startedAt = process.env.OUTCOME_WATCHDOG_STARTED_AT;
assert.match(startedAt ?? '', /^\d{4}-\d\d-\d\dT/, 'OUTCOME_WATCHDOG_STARTED_AT is required');
const finishedAt = new Date().toISOString();
const elapsedMilliseconds = Date.parse(finishedAt) - Date.parse(startedAt);
const deadlineSeconds = Number(process.env.OUTCOME_WATCHDOG_DEADLINE_SECONDS);
assert.equal(deadlineSeconds, 1200, 'Watchdog acceptance did not retain the negotiated deadline');
const migrationCount = Number(process.env.OUTCOME_WATCHDOG_MIGRATIONS);
assert.ok(Number.isInteger(migrationCount) && migrationCount > 0,
  'OUTCOME_WATCHDOG_MIGRATIONS is required');
const lastMigration = process.env.OUTCOME_WATCHDOG_LAST_MIGRATION;
assert.match(lastMigration ?? '', /^\d{4}_[a-z0-9_]+$/u,
  'OUTCOME_WATCHDOG_LAST_MIGRATION is required');
assert.ok(elapsedMilliseconds > 0 && elapsedMilliseconds < deadlineSeconds * 1_000,
  'Watchdog acceptance elapsed time is outside its admitted deadline');
assert.equal(process.env.OUTCOME_WATCHDOG_FIXTURE_CLEANED, 'true',
  'the disposable PostgreSQL fixture was not cleaned before manifest publication');
const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
assert.equal(evidence.targetSha, targetSha, 'runtime target SHA differs from tested checkout');
const bindMetric = (metric) => ({
  ...metric,
  collectorSha: evidence.collectorSha,
  targetSha: evidence.targetSha,
});
const boundOperationalMetrics = Object.fromEntries(Object.entries(contract.metrics)
  .map(([name, metric]) => [name, bindMetric(metric)]));
const boundCanary = {
  ...contract.canary,
  collectorSha: evidence.collectorSha,
  targetSha: evidence.targetSha,
  metrics: Object.fromEntries(Object.entries(contract.canary.metrics)
    .map(([name, metric]) => [name, bindMetric(metric)])),
};
const body = {
  schemaVersion: 1,
  suite: evidence.suite,
  outcome: 'PASS',
  targetSha,
  collectorSha: evidence.collectorSha,
  targetBranch: execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  ...summary,
  postgres: {
    ...evidence.postgres,
    migrations: migrationCount,
    lastMigration,
  },
  proofs: {
    independence: evidence.independence,
    faults: evidence.faults,
    security: evidence.security,
    sloCanary: evidence.sloCanary,
    progress,
  },
  progressIndependence: contract.progressIndependence,
  slo: bindMetric(contract.operationalSlo),
  operationalMetrics: boundOperationalMetrics,
  canary: boundCanary,
  samples: evidence.samples,
  capacityManifest: path.basename(capacityPath),
  execution: {
    elapsedMilliseconds,
    deadlineSeconds,
    terminationKind: 'EXITED',
    actualExitCode: 0,
    fixtureCleaned: true,
  },
  runtimeClosure: {
    manifestDigest: runtimeManifest.manifestDigest,
    sourceSha: runtimeManifest.sourceSha,
    typedTimedOutFact: persistedTimeout,
    legacy: {
      sessionId: runtimeEvidence.legacy.sessionId,
      legacyTermination: runtimeEvidence.legacy.legacyTermination,
      legacyExitCode: runtimeEvidence.legacy.legacyExitCode,
      diagnosis: runtimeEvidence.legacy.diagnosis,
      typedTerminationClaimed: runtimeEvidence.legacy.evidence.typedTerminationClaimed,
    },
    externalDeadMan: {
      workerTerminated: runtimeEvidence.watchdog.workerTerminated,
      maximumDeltaSeconds: runtimeEvidence.watchdog.maximumDeltaSeconds,
      staleEvent: runtimeEvidence.watchdog.staleEvent,
      allSixSurfacesStale: runtimeEvidence.watchdog.allSixSurfacesStale,
      allSixSurfacesRecovered: runtimeEvidence.watchdog.allSixSurfacesRecovered,
      recoveryCleared: runtimeEvidence.watchdog.recoveryCleared,
      neverHeartbeatedGenerationDetected:
        runtimeEvidence.watchdog.neverHeartbeatedGenerationDetected,
      missingEventExactlyOnce: runtimeEvidence.watchdog.missingEventExactlyOnce,
      readsWorkerProjection: runtimeEvidence.watchdog.deadmanReadsWorkerProjection,
    },
  },
  successorClosure: {
    taskId: successor.id,
    legacyTaskId: legacy.id,
    legacyStatus: legacy.status,
    legacyOutcome: legacy.outcome,
    goalOwner: successor.id,
    downstream: {
      replay: { taskId: replay.id, dependencyState: replay.dependencyState },
      canary: { taskId: canary.id, dependencyState: canary.dependencyState },
    },
  },
  liveReleaseFence,
  sourceDigest: canonicalDigest(sources),
  sources,
  window: { startedAt, finishedAt },
  inputDigest: canonicalDigest({
    tap: createHash('sha256').update(tap).digest('hex'),
    evidence: canonicalDigest(evidence),
    contract: canonicalDigest(contract),
    runtimeEvidence: canonicalDigest(runtimeEvidence),
    runtimeManifest: canonicalDigest(runtimeManifest),
    successor: canonicalDigest(successor),
    legacy: canonicalDigest(legacy),
    replay: canonicalDigest(replay),
    canary: canonicalDigest(canary),
    sources,
  }),
  resultDigest: canonicalDigest({ summary, evidence, runtimeManifest, liveReleaseFence }),
};
const manifest = { ...body, manifestDigest: canonicalDigest(body) };
const capacityBody = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-watchdog-capacity',
  outcome: 'PASS',
  targetSha,
  collectorSha: evidence.collectorSha,
  targetBranch: body.targetBranch,
  scale: { tasks: capacity.taskScale, description: 'synthetic canonical task obligations' },
  queryBounds: capacity.plans,
  queryRowLimit: capacity.queryRowLimit,
  checksumSampleLimit: capacity.checksumSampleLimit,
  indexes: {
    required: capacity.indexesRequired,
    present: capacity.indexesPresent,
    used: capacity.indexesUsed,
    requiredCount: contract.capacity.requiredIndexes.length,
    actualHitCount: contract.capacity.requiredIndexes
      .filter((index) => capacity.indexesUsed.includes(index)).length,
  },
  replay: {
    samples: capacity.replaySampleCount,
    durationMilliseconds: capacity.replayDurationMilliseconds,
    digest: capacity.replayDigest,
  },
  storage: {
    beforeBytes: capacity.storageBytesBefore,
    afterBytes: capacity.storageBytesAfter,
    growthBytes: capacity.storageGrowthBytes,
    bytesPerTask: capacity.storageBytesPerTask,
    maximumBytesPerTask: contract.capacity.maximumStorageBytesPerTask,
  },
  seedDurationMilliseconds: capacity.seedDurationMilliseconds,
  maximumQueryMilliseconds: capacity.maximumQueryMilliseconds,
  window: body.window,
  sourceDigest: body.sourceDigest,
};
const capacityManifest = {
  ...capacityBody,
  manifestDigest: canonicalDigest(capacityBody),
};
mkdirSync(path.dirname(outputPath), { recursive: true });
mkdirSync(path.dirname(capacityPath), { recursive: true });
writeFileSync(outputPath, `${canonical(manifest)}\n`);
writeFileSync(capacityPath, `${canonical(capacityManifest)}\n`);
console.log(canonical(manifest));
console.log(canonical(capacityManifest));
console.log(`outcome-watchdog manifest: ${outputPath}`);
console.log(`outcome-watchdog capacity manifest: ${capacityPath}`);
