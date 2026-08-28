#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const [tapArg, evidenceArg, contractArg, outputArg, capacityArg] = process.argv.slice(2);
assert.ok(tapArg && evidenceArg && contractArg && outputArg && capacityArg,
  'usage: outcome-reconciler-watchdog-manifest.mjs TAP EVIDENCE CONTRACT OUTPUT CAPACITY');
const tap = readFileSync(path.resolve(tapArg), 'utf8');
const evidence = JSON.parse(readFileSync(path.resolve(evidenceArg), 'utf8'));
const contract = JSON.parse(readFileSync(path.resolve(contractArg), 'utf8'));
const outputPath = path.resolve(outputArg);
const capacityPath = path.resolve(capacityArg);

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
assert.ok(summary.tests >= 13, 'the watchdog suite is unexpectedly empty or truncated');
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
validateMetric(contract.operationalSlo, 'operationalSlo');
for (const [name, metric] of Object.entries(contract.metrics)) validateMetric(metric, name);
for (const [name, metric] of Object.entries(contract.canary.metrics)) {
  validateMetric(metric, `canary.${name}`);
}

const capacity = evidence.capacity;
assert.ok(capacity.taskScale >= 110_000 && capacity.taskScale <= 112_000,
  'capacity fixture is not approximately 111k tasks');
assert.equal(capacity.queryRowLimit, contract.capacity.queryRowLimit);
assert.equal(capacity.checksumSampleLimit, contract.capacity.checksumSampleLimit);
assert.deepEqual(capacity.indexesPresent, [...contract.capacity.requiredIndexes].sort());
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

const sourceFiles = [
  '.agents/skills/upgrade/scripts/upgrade.sh',
  '.env.example',
  'contracts/outcome-reconciler-v2-watchdog-slo.json',
  'docker-compose.yml',
  'package.json',
  'scripts/outcome-reconciler-watchdog.sh',
  'scripts/outcome-reconciler-watchdog-manifest.mjs',
  'src/apiserver/Dockerfile',
  'src/apiserver/package.json',
  'src/apiserver/prisma/migrations/0199_outcome_independent_watchdog_slo_security/migration.sql',
  'src/apiserver/src/app.module.ts',
  'src/apiserver/src/common/db-write-inventory.ts',
  'src/apiserver/src/outcome-watchdog/main.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.module.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.runner.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.service.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.worker.module.ts',
  'test/outcome-reconciler-v2.watchdog.test.mjs',
];
const sources = Object.fromEntries(sourceFiles.map((relative) => [relative, fileDigest(relative)]));
const startedAt = process.env.OUTCOME_WATCHDOG_STARTED_AT;
assert.match(startedAt ?? '', /^\d{4}-\d\d-\d\dT/, 'OUTCOME_WATCHDOG_STARTED_AT is required');
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
  postgres: evidence.postgres,
  proofs: {
    independence: evidence.independence,
    faults: evidence.faults,
    security: evidence.security,
    sloCanary: evidence.sloCanary,
  },
  slo: bindMetric(contract.operationalSlo),
  operationalMetrics: boundOperationalMetrics,
  canary: boundCanary,
  samples: evidence.samples,
  capacityManifest: path.basename(capacityPath),
  sourceDigest: canonicalDigest(sources),
  sources,
  window: { startedAt, finishedAt: new Date().toISOString() },
  inputDigest: canonicalDigest({
    tap: createHash('sha256').update(tap).digest('hex'),
    evidence: canonicalDigest(evidence),
    contract: canonicalDigest(contract),
    sources,
  }),
  resultDigest: canonicalDigest({ summary, evidence }),
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
