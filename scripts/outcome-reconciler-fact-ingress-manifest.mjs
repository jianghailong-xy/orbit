#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { canonicalJson, sha256Canonical } from './lib/outcome-reconciler-v2.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const [tapArg, evidenceArg, outputArg] = process.argv.slice(2);
assert.ok(tapArg && evidenceArg && outputArg,
  'usage: outcome-reconciler-fact-ingress-manifest.mjs TAP EVIDENCE OUTPUT');
const tapPath = path.resolve(tapArg);
const evidencePath = path.resolve(evidenceArg);
const outputPath = path.resolve(outputArg);
const tap = readFileSync(tapPath, 'utf8');
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));

function counter(name) {
  const match = tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
  assert.ok(match, `TAP summary is missing ${name}`);
  return Number(match[1]);
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
assert.ok(summary.tests > 0, 'an empty suite is not evidence');
assert.equal(summary.passed, summary.tests, 'not every fact-ingress test passed');
assert.equal(summary.failed, 0, 'fact-ingress suite contains failures');
assert.equal(summary.skipped, 0, 'skipped fact-ingress tests are forbidden');
assert.equal(summary.cancelled, 0, 'cancelled fact-ingress tests are forbidden');
assert.equal(summary.todo, 0, 'todo fact-ingress tests are forbidden');
assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.suite, 'outcome-reconciler-v2-fact-ingress');
assert.equal(evidence.postgres.required, true);
assert.equal(evidence.postgres.connected, true, 'PostgreSQL was not exercised');
assert.match(evidence.postgres.version, /^1[6-9]\./, 'PostgreSQL 16+ is required');
assert.match(evidence.postgres.systemIdentifier, /^[0-9]+$/);
assertAllTrue(evidence.invariants, 'invariants');
assertAllTrue(evidence.attacks, 'attacks');
assertAllTrue(evidence.races, 'races');
for (const [key, value] of Object.entries(evidence.replay)) {
  if (key === 'source') continue;
  assert.equal(value, true, `replay.${key} was not proven`);
}
assert.equal(evidence.replay.source, 'outcome_canonical_fact+outcome_evaluation_cut_fact');
assert.equal(evidence.authority.databaseLanes, evidence.authority.declaredFactKinds);
assert.equal(evidence.authority.declaredFactKinds, 24);
assert.deepEqual(evidence.authority.uncoveredFactKinds, []);
assert.equal(BigInt(evidence.samples.lateFactLogicalTime), BigInt(evidence.samples.firstWatermark) + 1n);
for (const key of ['firstFactSetDigest', 'currentFactSetDigest']) {
  assert.match(evidence.samples[key], /^[0-9a-f]{64}$/);
}

const sourceFiles = [
  'contracts/outcome-reconciler-v2-authority-matrix.json',
  'contracts/outcome-reconciler-v2.contract.json',
  'contracts/outcome-reconciler-v2.schema.json',
  'package.json',
  'scripts/lib/outcome-reconciler-v2.mjs',
  'scripts/outcome-reconciler-fact-ingress-manifest.mjs',
  'scripts/outcome-reconciler-fact-ingress.sh',
  'src/apiserver/prisma/migrations/0194_outcome_canonical_fact_ingress/migration.sql',
  'src/apiserver/prisma/schema.prisma',
  'src/apiserver/src/app.module.ts',
  'src/apiserver/src/outcome-reconciler/outcome-fact-ingress.service.ts',
  'src/apiserver/src/outcome-reconciler/outcome-reconciler.module.ts',
  'test/outcome-reconciler-v2.fact-ingress.test.mjs',
];
const sources = Object.fromEntries(sourceFiles.map((relative) => [relative, fileDigest(relative)]));
const startedAt = process.env.OUTCOME_FACT_STARTED_AT;
assert.match(startedAt ?? '', /^\d{4}-\d\d-\d\dT/, 'OUTCOME_FACT_STARTED_AT is required');
const finishedAt = new Date().toISOString();
const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const targetBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim();
const body = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-fact-ingress',
  outcome: 'PASS',
  targetSha,
  targetBranch,
  ...summary,
  postgres: evidence.postgres,
  authority: evidence.authority,
  proofs: {
    invariants: evidence.invariants,
    attacks: evidence.attacks,
    races: evidence.races,
    replay: evidence.replay,
  },
  samples: evidence.samples,
  authorityMatrixDigest: sources['contracts/outcome-reconciler-v2-authority-matrix.json'],
  migrationDigest: sources['src/apiserver/prisma/migrations/0194_outcome_canonical_fact_ingress/migration.sql'],
  sourceDigest: sha256Canonical(sources),
  sources,
  window: { startedAt, finishedAt },
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
console.log(canonicalJson(manifest));
console.log(`outcome-fact-ingress manifest: ${outputPath}`);
