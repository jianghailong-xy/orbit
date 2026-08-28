#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const [tapArg, evidenceArg, outputArg] = process.argv.slice(2);
assert.ok(tapArg && evidenceArg && outputArg,
  'usage: outcome-reconciler-coordinator-manifest.mjs TAP EVIDENCE OUTPUT');
const tap = readFileSync(path.resolve(tapArg), 'utf8');
const evidence = JSON.parse(readFileSync(path.resolve(evidenceArg), 'utf8'));
const outputPath = path.resolve(outputArg);

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

const summary = {
  tests: counter('tests'),
  passed: counter('pass'),
  failed: counter('fail'),
  skipped: counter('skipped'),
  cancelled: counter('cancelled'),
  todo: counter('todo'),
};
assert.ok(summary.tests >= 18, 'the coordinator suite is unexpectedly empty or truncated');
assert.equal(summary.passed, summary.tests, 'not every coordinator test passed');
assert.equal(summary.failed, 0, 'coordinator suite contains failures');
assert.equal(summary.skipped, 0, 'skipped coordinator tests are forbidden');
assert.equal(summary.cancelled, 0, 'cancelled coordinator tests are forbidden');
assert.equal(summary.todo, 0, 'todo coordinator tests are forbidden');
assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.suite, 'outcome-reconciler-v2-coordinator');
assert.equal(evidence.postgres.required, true);
assert.equal(evidence.postgres.connected, true, 'PostgreSQL was not exercised');
assert.match(evidence.postgres.version, /^1[6-9]\./, 'PostgreSQL 16+ is required');
assert.match(evidence.postgres.systemIdentifier, /^[0-9]+$/);
for (const label of ['persistence', 'recovery', 'bounded', 'scheduling', 'decisions', 'executor']) {
  assertAllTrue(evidence[label], label);
}
for (const field of ['discoveryCoordinationId', 'ownerRequestId', 'actionIntentId']) {
  assert.match(evidence.samples[field], /^[0-9a-f-]{36}$/, `${field} is missing`);
}
assert.equal(evidence.samples.takeoverWorkers.length, 2);
assert.equal(new Set(evidence.samples.fairProjects).size, 2);

const sourceFiles = [
  'package.json',
  'scripts/outcome-reconciler-coordinator.sh',
  'scripts/outcome-reconciler-coordinator-manifest.mjs',
  'src/apiserver/prisma/migrations/0198_outcome_persistent_coordinator/migration.sql',
  'src/apiserver/prisma/schema.prisma',
  'src/apiserver/src/common/db-write-inventory.ts',
  'src/apiserver/src/outcome-reconciler/action-executor.service.ts',
  'src/apiserver/src/outcome-reconciler/outcome-coordinator.ts',
  'src/apiserver/src/outcome-reconciler/outcome-coordinator.service.ts',
  'src/apiserver/src/outcome-reconciler/outcome-reconciler.module.ts',
  'test/outcome-reconciler-v2.coordinator.test.mjs',
];
const sources = Object.fromEntries(sourceFiles.map((relative) => [relative, fileDigest(relative)]));
const startedAt = process.env.OUTCOME_COORDINATOR_STARTED_AT;
assert.match(startedAt ?? '', /^\d{4}-\d\d-\d\dT/, 'OUTCOME_COORDINATOR_STARTED_AT is required');
const body = {
  schemaVersion: 1,
  suite: evidence.suite,
  outcome: 'PASS',
  targetSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  targetBranch: execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  ...summary,
  postgres: evidence.postgres,
  proofs: {
    persistence: evidence.persistence,
    recovery: evidence.recovery,
    bounded: evidence.bounded,
    scheduling: evidence.scheduling,
    decisions: evidence.decisions,
    executor: evidence.executor,
  },
  samples: evidence.samples,
  sourceDigest: canonicalDigest(sources),
  sources,
  window: { startedAt, finishedAt: new Date().toISOString() },
  inputDigest: canonicalDigest({
    tap: createHash('sha256').update(tap).digest('hex'),
    evidence: canonicalDigest(evidence),
    sources,
  }),
  resultDigest: canonicalDigest({ summary, evidence }),
};
const manifest = { ...body, manifestDigest: canonicalDigest(body) };
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${canonical(manifest)}\n`);
console.log(canonical(manifest));
console.log(`outcome-coordinator manifest: ${outputPath}`);
