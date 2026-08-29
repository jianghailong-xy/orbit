#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalJson, sha256Canonical } from './lib/outcome-reconciler-v2.mjs';
import { REPLAY_SURFACES } from './lib/outcome-reconciler-replay.mjs';
import {
  REPLAY_CATEGORIES,
  REPLAY_CATEGORY_MINIMUMS,
  REPLAY_FIXTURES,
} from '../test/fixtures/outcome-reconciler-v2-replay-fixtures.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const [tapArg, evidenceArg, outputArg] = process.argv.slice(2);
assert.ok(tapArg && evidenceArg && outputArg,
  'usage: outcome-reconciler-replay-manifest.mjs TAP EVIDENCE OUTPUT');
const tap = readFileSync(path.resolve(tapArg), 'utf8');
const evidence = JSON.parse(readFileSync(path.resolve(evidenceArg), 'utf8'));
const outputPath = path.resolve(outputArg);

function counter(name) {
  const match = tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
  assert.ok(match, `TAP summary is missing ${name}`);
  return Number(match[1]);
}

function fileDigest(relative) {
  return createHash('sha256').update(readFileSync(path.join(ROOT, relative))).digest('hex');
}

function assertAllTrue(object, label) {
  assert.ok(object && typeof object === 'object', `${label} is missing`);
  for (const [key, value] of Object.entries(object)) {
    assert.equal(value, true, `${label}.${key} was not proven`);
  }
}

const summary = {
  tests: counter('tests'),
  passed: counter('pass'),
  failed: counter('fail'),
  skipped: counter('skipped'),
  cancelled: counter('cancelled'),
  todo: counter('todo'),
};
assert.ok(summary.tests >= 37, 'the replay suite is unexpectedly empty or truncated');
assert.equal(summary.passed, summary.tests, 'not every replay test passed');
assert.equal(summary.failed, 0, 'replay suite contains failures');
assert.equal(summary.skipped, 0, 'skipped replay tests are forbidden');
assert.equal(summary.cancelled, 0, 'cancelled replay tests are forbidden');
assert.equal(summary.todo, 0, 'todo replay tests are forbidden');

assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.suite, 'outcome-reconciler-v2-trace-replay');
assert.equal(evidence.postgres.required, true);
assert.equal(evidence.postgres.connected, true, 'PostgreSQL was not exercised');
assert.match(evidence.postgres.version, /^1[6-9]\./, 'PostgreSQL 16+ is required');
assert.match(evidence.postgres.systemIdentifier, /^[0-9]+$/);
assertAllTrue(evidence.invariants, 'invariants');
assert.equal(process.env.OUTCOME_REPLAY_FIXTURE_CLEANED, 'true',
  'the disposable PostgreSQL fixture was not cleaned before manifest generation');
const migrationCount = Number(process.env.OUTCOME_REPLAY_MIGRATION_COUNT);
assert.ok(Number.isSafeInteger(migrationCount) && migrationCount > 0,
  'a positive applied migration count is required');

const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: ROOT, encoding: 'utf8',
}).trim();
assert.match(targetSha, /^[0-9a-f]{40}$/);
const fixturesById = new Map(REPLAY_FIXTURES.map((fixture) => [fixture.id, fixture]));
assert.equal(new Set(fixturesById.keys()).size, REPLAY_FIXTURES.length);
assert.equal(evidence.traces.length, REPLAY_FIXTURES.length,
  'the evidence did not emit exactly one trace per fixture');

const categoryCounts = Object.fromEntries(Object.values(REPLAY_CATEGORIES).map((category) => [
  category,
  evidence.traces.filter((trace) => trace.category === category).length,
]));
for (const [category, minimum] of Object.entries(REPLAY_CATEGORY_MINIMUMS)) {
  assert.ok(categoryCounts[category] >= minimum, `${category} has fewer than ${minimum} traces`);
}
assert.equal(categoryCounts.ENTRY_WITHOUT_EXIT, 7);
assert.equal(categoryCounts.DONE_NOT_MERGED, 7);
assert.equal(categoryCounts.READ_MODEL_GAP, 3);

const manifestFixtures = evidence.traces.map((trace) => {
  const fixture = fixturesById.get(trace.fixtureId);
  assert.ok(fixture, `undeclared fixture trace: ${trace.fixtureId}`);
  assert.equal(trace.category, fixture.category, `${trace.fixtureId}: category drift`);
  assert.equal(trace.scenario, fixture.scenario, `${trace.fixtureId}: scenario drift`);
  assert.equal(trace.sourceRef, fixture.source.ref, `${trace.fixtureId}: source ref drift`);
  assert.equal(trace.sourceHash, fixture.sourceHash, `${trace.fixtureId}: source hash drift`);
  assert.equal(trace.sourceHash, sha256Canonical(fixture.source),
    `${trace.fixtureId}: source hash is not reproducible`);
  assert.equal(trace.targetSha, targetSha, `${trace.fixtureId}: target SHA drift`);
  assert.ok(trace.inputBinding && typeof trace.inputBinding === 'object',
    `${trace.fixtureId}: input binding missing`);
  assert.equal(trace.bindingDigest, sha256Canonical(trace.inputBinding),
    `${trace.fixtureId}: input binding digest mismatch`);
  assert.ok(trace.inputCut && typeof trace.inputCut === 'object',
    `${trace.fixtureId}: input cut missing`);
  assert.equal(trace.inputCut.bindingDigest, trace.bindingDigest,
    `${trace.fixtureId}: input cut is not bound to the input`);
  assert.equal(trace.inputCut.complete, true, `${trace.fixtureId}: incomplete input cut`);
  assert.equal(trace.inputCut.linearizable, true, `${trace.fixtureId}: non-linearizable input cut`);
  assert.equal(trace.requestedDeadlineSeconds, fixture.requestedDeadlineSeconds,
    `${trace.fixtureId}: requested deadline drift`);
  assert.equal(trace.effectiveDeadlineSeconds, fixture.effectiveDeadlineSeconds,
    `${trace.fixtureId}: effective deadline drift`);
  assert.equal(trace.terminationKind, fixture.terminationKind,
    `${trace.fixtureId}: termination kind drift`);
  assert.deepEqual(trace.expectedTransition, fixture.expectedTransition,
    `${trace.fixtureId}: expected transition drift`);
  assert.deepEqual(trace.actualTransition, trace.expectedTransition,
    `${trace.fixtureId}: actual transition differs from expected`);
  assert.ok(Array.isArray(trace.proofLeaves) && trace.proofLeaves.length > 0,
    `${trace.fixtureId}: proof leaves missing`);
  for (const leaf of trace.proofLeaves) {
    assert.ok(typeof leaf.claim === 'string' && leaf.claim.length > 0,
      `${trace.fixtureId}: proof claim missing`);
    assert.match(leaf.evidenceDigest, /^[0-9a-f]{64}$/,
      `${trace.fixtureId}: proof leaf digest missing`);
  }
  assert.equal(trace.proofDigest, sha256Canonical(trace.proofLeaves),
    `${trace.fixtureId}: proof digest mismatch`);
  assert.ok(trace.finalObligation && typeof trace.finalObligation === 'object',
    `${trace.fixtureId}: final obligation missing`);
  assert.equal(trace.finalObligation.kind, fixture.expectedFinalObligation.kind,
    `${trace.fixtureId}: final obligation kind drift`);
  assert.equal(trace.finalObligation.state, fixture.expectedFinalObligation.state,
    `${trace.fixtureId}: final obligation state drift`);
  assert.equal(trace.finalObligation.reasonCode, fixture.expectedFinalObligation.reasonCode,
    `${trace.fixtureId}: final obligation reason drift`);
  return { ...trace, source: fixture.source };
});

const historical = manifestFixtures.filter(({ category }) => [
  REPLAY_CATEGORIES.ENTRY_WITHOUT_EXIT,
  REPLAY_CATEGORIES.DONE_NOT_MERGED,
  REPLAY_CATEGORIES.READ_MODEL_GAP,
].includes(category));
assert.equal(historical.length, 17);
assert.ok(historical.every(({ actualTransition }) => actualTransition.closed === false),
  'a historical gap was falsely closed');
assert.ok(historical.every(({ finalObligation }) => (
  finalObligation.state === 'ACTIVE' && finalObligation.kind !== 'NONE'
)), 'a historical obligation was lost');
const readGaps = historical.filter(({ category }) => category === REPLAY_CATEGORIES.READ_MODEL_GAP);
assert.ok(readGaps.every(({ detail }) => (
  detail?.projections
  && Object.keys(detail.projections).length === REPLAY_SURFACES.length
)), 'a read-model gate remained invisible');

function traceById(id) {
  const trace = manifestFixtures.find(({ fixtureId }) => fixtureId === id);
  assert.ok(trace, `critical trace is missing: ${id}`);
  return trace;
}

const rejection = traceById('timeout-v2-rejects-1200-on-hardmax-120');
assert.equal(rejection.requestedDeadlineSeconds, 1200);
assert.equal(rejection.effectiveDeadlineSeconds, null);
assert.equal(rejection.detail.admission.runnerHardMaxSeconds, 120);
assert.equal(rejection.actualTransition.spawnCount, 0);
const admission = traceById('timeout-v2-admits-exact-1200');
assert.equal(admission.requestedDeadlineSeconds, 1200);
assert.equal(admission.effectiveDeadlineSeconds, 1200);
assert.equal(admission.detail.admission.effectiveTimeoutSeconds, 1200);
const timedOut = traceById('goal-attempt-typed-timeout-continuation');
assert.equal(timedOut.requestedDeadlineSeconds, 1200);
assert.equal(timedOut.effectiveDeadlineSeconds, 120);
assert.equal(timedOut.terminationKind, 'TIMED_OUT');
assert.equal(timedOut.detail.reconstructed.historicalAuditMutation, 'NONE');
assert.equal(timedOut.actualTransition.obligationKind, 'START_SUCCESSOR_ATTEMPT');
const recovery = traceById('timeout-legacy-reconstruction-successor-recovery');
assert.equal(recovery.terminationKind, 'TIMED_OUT');
assert.equal(recovery.actualTransition.legacyAuditPreserved, true);
assert.equal(recovery.actualTransition.successorCount, 1);
assert.equal(recovery.actualTransition.downstreamState, 'READY');

assert.equal(evidence.runtime.legacyTaskId, '34Elz5t7HAZZRf6ruE73y');
assert.equal(evidence.runtime.legacySessionId, '3RIgJAt2GsNCTVoKKfOvK');
assert.equal(evidence.runtime.legacyStatus, 'FAILED');
assert.equal(evidence.runtime.legacyTermination, 'UNTYPED');
assert.equal(evidence.runtime.legacyExitCode, -1);
assert.equal(evidence.runtime.legacyTypedColumn, null);
assert.equal(evidence.runtime.reconstructedTerminationKind, 'TIMED_OUT');
assert.match(evidence.runtime.reconstructedEvidenceDigest, /^[0-9a-f]{64}$/);
assert.equal(evidence.runtime.successorTaskId, '34Ex0SFCY6DpfvW2I4ydE');
assert.equal(evidence.runtime.currentGoalOwnerInternalId, '01a0480d-7aba-7281-9b84-aefcba1e75b0');
assert.equal(evidence.runtime.downstreamState, 'READY');
assert.equal(evidence.runtime.downstreamDispatchCommitted, true);

const repositoryFixtureSources = REPLAY_FIXTURES
  .map(({ source }) => source)
  .filter(({ kind }) => kind === 'REPOSITORY_SOURCE')
  .map(({ path: sourcePath }) => sourcePath);
const sourceFiles = [...new Set([
  'package.json',
  'contracts/outcome-reconciler-v2.contract.json',
  'contracts/outcome-reconciler-v2.schema.json',
  'scripts/lib/outcome-reconciler-v2.mjs',
  'scripts/lib/outcome-reconciler-replay.mjs',
  'scripts/outcome-reconciler-replay.sh',
  'scripts/outcome-reconciler-replay-manifest.mjs',
  'src/apiserver/prisma/migrations/0193_task_done_writer_fence/migration.sql',
  'src/apiserver/prisma/migrations/0194_outcome_canonical_fact_ingress/migration.sql',
  'src/apiserver/prisma/migrations/0195_outcome_evaluator_obligation_reduction/migration.sql',
  'src/apiserver/prisma/migrations/0196_outcome_constrained_action_executor/migration.sql',
  'src/apiserver/prisma/migrations/0200_executable_acceptance_runtime_contract/migration.sql',
  'src/apiserver/src/tasks/executable-acceptance-runtime.ts',
  'test/fixtures/outcome-reconciler-v2-replay-fixtures.mjs',
  'test/outcome-reconciler-v2.replay.test.mjs',
  ...repositoryFixtureSources,
])].sort();
const sources = Object.fromEntries(sourceFiles.map((relative) => [relative, fileDigest(relative)]));
const startedAt = process.env.OUTCOME_REPLAY_STARTED_AT;
assert.match(startedAt ?? '', /^\d{4}-\d\d-\d\dT/, 'OUTCOME_REPLAY_STARTED_AT is required');
const body = {
  schemaVersion: 1,
  suite: evidence.suite,
  outcome: 'PASS',
  targetSha,
  targetBranch: execFileSync('git', ['branch', '--show-current'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim(),
  ...summary,
  postgres: {
    ...evidence.postgres,
    migrationCount,
    fixtureCleanedBeforeManifest: true,
  },
  coverage: {
    fixtureCount: manifestFixtures.length,
    categoryCounts,
    historicalFixtureCount: historical.length,
    readSurfaceCount: REPLAY_SURFACES.length,
  },
  proofs: {
    ...evidence.invariants,
    legacyWatchdogAudit: {
      taskStatus: evidence.runtime.legacyStatus,
      sourceTermination: evidence.runtime.legacyTermination,
      sourceExitCode: evidence.runtime.legacyExitCode,
      typedSourceColumn: evidence.runtime.legacyTypedColumn,
      replayTerminationKind: evidence.runtime.reconstructedTerminationKind,
      historicalAuditMutation: 'NONE',
    },
    goalRecovery: {
      successorTaskId: evidence.runtime.successorTaskId,
      currentGoalOwnerInternalId: evidence.runtime.currentGoalOwnerInternalId,
      downstreamState: evidence.runtime.downstreamState,
      downstreamDispatchCommitted: evidence.runtime.downstreamDispatchCommitted,
    },
  },
  fixtures: manifestFixtures,
  sourceDigest: sha256Canonical(sources),
  sources,
  window: { startedAt, finishedAt: new Date().toISOString() },
  inputDigest: sha256Canonical({
    tap: createHash('sha256').update(tap).digest('hex'),
    evidence: sha256Canonical(evidence),
    sources,
  }),
  resultDigest: sha256Canonical({ summary, evidence }),
};
const manifest = { ...body, manifestDigest: sha256Canonical(body) };
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${canonicalJson(manifest)}\n`);
console.log(`trace-replay manifest: ${outputPath}`);
console.log(`trace-replay fixtures=${manifestFixtures.length} historical=7+7+3 skip=0 digest=${manifest.manifestDigest}`);
