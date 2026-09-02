#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [manifestArg, telemetryArg, upstreamEvidenceArg, upstreamTaskArg] = process.argv.slice(2);
assert.ok(manifestArg && telemetryArg && upstreamEvidenceArg && upstreamTaskArg,
  'usage: outcome-reconciler-canary-verify.mjs MANIFEST TELEMETRY UPSTREAM_EVIDENCE UPSTREAM_TASK');
const manifest = JSON.parse(readFileSync(path.resolve(manifestArg), 'utf8'));
const telemetryRaw = readFileSync(path.resolve(telemetryArg), 'utf8');
const upstreamEvidenceRaw = readFileSync(path.resolve(upstreamEvidenceArg), 'utf8');
const upstreamTaskRaw = readFileSync(path.resolve(upstreamTaskArg), 'utf8');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

const { manifestDigest, manifestHash, signature, ...body } = manifest;
assert.match(manifestDigest, /^[0-9a-f]{64}$/);
assert.equal(manifestHash, manifestDigest);
assert.equal(digest(canonical(body)), manifestDigest, 'manifest body hash does not match');
assert.equal(signature.algorithm, 'Ed25519');
assert.equal(signature.signedDigest, manifestDigest);
const publicKeyBytes = Buffer.from(signature.publicKey, 'base64');
assert.equal(digest(publicKeyBytes), signature.publicKeySha256);
const publicKey = createPublicKey({ key: publicKeyBytes, type: 'spki', format: 'der' });
assert.equal(verify(
  null,
  Buffer.from(manifestDigest, 'hex'),
  publicKey,
  Buffer.from(signature.value, 'base64'),
), true, 'manifest Ed25519 signature is invalid');

assert.equal(manifest.outcome, 'PASS');
assert.equal(manifest.expectedExitCode, 0);
assert.equal(manifest.summary.passed, manifest.summary.tests);
assert.equal(manifest.summary.failed, 0);
assert.equal(manifest.summary.skipped, 0);
assert.equal(manifest.summary.cancelled, 0);
assert.equal(manifest.summary.todo, 0);
assert.ok(manifest.cohort.eligibleTasks >= 110_000 && manifest.cohort.eligibleTasks <= 112_000);
assert.ok(manifest.cohort.selectedTasks >= manifest.cohort.minimumSampleSize);
assert.ok(manifest.cohort.denominator.length > 0);
assert.ok(manifest.cohort.observationWindow.seconds > 0);
assert.equal(Object.keys(manifest.metricDimensions).length, 11);
for (const [name, metric] of Object.entries(manifest.metricDimensions)) {
  assert.ok(metric.denominator.length > 0, `${name} denominator absent`);
  assert.ok(metric.minSampleSize > 0, `${name} minimum sample absent`);
  assert.ok(metric.observationWindow.seconds > 0, `${name} window absent`);
  assert.ok(metric.v1.denominator >= metric.minSampleSize, `${name}.v1 sample insufficient`);
  assert.ok(metric.v2.denominator >= metric.minSampleSize, `${name}.v2 sample insufficient`);
  assert.equal(metric.v2.sloPass, true, `${name}.v2 SLO failed`);
  assert.equal(metric.v2.abort, false, `${name}.v2 abort threshold reached`);
}
assert.ok(manifest.v1V2DiffTaxonomy.V1_FALSE_CLOSE > 0);
assert.ok(manifest.v1V2DiffTaxonomy.V1_MISSED_OBLIGATION > 0);
assert.ok(manifest.v1V2DiffTaxonomy.V1_READ_MODEL_DRIFT > 0);
assert.equal(manifest.v1V2DiffTaxonomy.V2_FALSE_CLOSE, 0);
assert.equal(manifest.v1V2DiffTaxonomy.V2_MISSED_OBLIGATION, 0);
assert.equal(manifest.v1V2DiffTaxonomy.V2_READ_MODEL_DRIFT, 0);
assert.equal(manifest.rollback.triggered, true);
assert.equal(manifest.rollback.automatic, true);
assert.equal(manifest.rollback.recoveredWithinSlo, true);
assert.ok(manifest.rollback.recoverySeconds <= manifest.rollback.maximumRecoverySeconds);
assert.equal(manifest.rollforward.triggered, true);
assert.equal(manifest.rollforward.completed, true);
assert.equal(manifest.rollforward.finalMode, 'V2_ACTIVE');
assert.ok(manifest.mixedClientMatrix.length >= 10);
for (const count of Object.values(manifest.traces.counts)) assert.ok(count > 0);
assert.equal(manifest.traces.WATCHDOG_13_OF_13.requestedTimeoutSeconds, 1200);
assert.equal(manifest.traces.WATCHDOG_13_OF_13.tests, 13);
assert.equal(manifest.traces.WATCHDOG_13_OF_13.passed, 13);
assert.equal(manifest.traces.WATCHDOG_13_OF_13.failed, 0);
assert.equal(manifest.traces.WATCHDOG_13_OF_13.skipped, 0);
assert.equal(manifest.traces.WATCHDOG_13_OF_13.crossedLegacyCutoff, true);
assert.equal(manifest.traces.WATCHDOG_13_OF_13.terminationKind, 'EXITED');
assert.equal(manifest.traces.WATCHDOG_13_OF_13.actualExitCode, 0);
assert.equal(manifest.security.authorizationViolations, 0);
assert.equal(manifest.security.currentTelemetry.tenantIsolation, true);
assert.equal(manifest.security.currentTelemetry.secretRedaction, true);
assert.equal(manifest.security.currentTelemetry.rawTenantIdentifiersStored, 0);
assert.equal(digest(telemetryRaw), manifest.telemetry.sha256);
assert.equal(digest(upstreamEvidenceRaw), manifest.upstreamEvidence.evidenceFileSha256);
assert.equal(digest(upstreamTaskRaw), manifest.upstreamEvidence.taskSnapshotSha256);
assert.equal(manifest.telemetry.appendOnlyHashChainVerified, true);
assert.equal(JSON.stringify(manifest).includes('"actualExitCode":-1'), false,
  'generic exit -1 appeared as manifest evidence');
if (process.env.OUTCOME_CANARY_REQUIRE_COMMITTED_SOURCE !== 'false') {
  assert.equal(manifest.targetBinding.sourceFilesCommittedAtGeneration, true,
    'manifest source files are not committed in targetSha');
}

console.log(JSON.stringify({
  outcome: manifest.outcome,
  manifestDigest,
  signatureVerified: true,
  telemetryEvents: manifest.telemetry.events,
  cohortSelected: manifest.cohort.selectedTasks,
  skip: manifest.summary.skipped,
  traces: manifest.traces.counts,
}, null, 2));
