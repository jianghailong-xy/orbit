#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalJson, sha256Canonical } from './lib/outcome-reconciler-v2.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const [tapArg, evidenceArg, outputArg] = process.argv.slice(2);
assert.ok(tapArg && evidenceArg && outputArg,
  'usage: outcome-reconciler-done-gate-manifest.mjs TAP EVIDENCE OUTPUT');
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

const summary = {
  tests: counter('tests'),
  passed: counter('pass'),
  failed: counter('fail'),
  skipped: counter('skipped'),
  cancelled: counter('cancelled'),
  todo: counter('todo'),
};
assert.ok(summary.tests >= 12, 'the canonical DONE-gate matrix is incomplete or truncated');
assert.equal(summary.passed, summary.tests, 'not every canonical DONE-gate test passed');
assert.equal(summary.failed, 0, 'canonical DONE-gate suite contains failures');
assert.equal(summary.skipped, 0, 'skipped canonical DONE-gate tests are forbidden');
assert.equal(summary.cancelled, 0, 'cancelled canonical DONE-gate tests are forbidden');
assert.equal(summary.todo, 0, 'todo canonical DONE-gate tests are forbidden');
assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.suite, 'outcome-reconciler-v2-done-gate');
assert.equal(evidence.postgres.required, true);
assert.equal(evidence.postgres.connected, true, 'PostgreSQL was not exercised');
assert.match(evidence.postgres.version, /^1[6-9]\./, 'PostgreSQL 16+ is required');
assert.match(evidence.postgres.systemIdentifier, /^[0-9]+$/);
for (const [name, value] of Object.entries(evidence.invariants)) {
  assert.equal(value, true, `invariants.${name} was not proven`);
}
for (const [name, value] of Object.entries(evidence.samples)) {
  assert.match(value, /^[0-9a-f]{64}$/, `samples.${name} must be a digest`);
}

const sourceFiles = [
  'contracts/outcome-reconciler-v2.contract.json',
  'contracts/outcome-reconciler-v2-source-audit.json',
  'package.json',
  'scripts/outcome-reconciler-done-gate.sh',
  'scripts/outcome-reconciler-done-gate-manifest.mjs',
  'src/apiserver/prisma/migrations/0197_canonical_obligation_done_gate/migration.sql',
  'src/apiserver/src/outcome-reconciler/outcome-evaluator.ts',
  'src/apiserver/src/outcome-reconciler/outcome-projection.service.ts',
  'src/apiserver/src/projects/project-acceptance.service.ts',
  'src/apiserver/src/projects/project-acceptance.ts',
  'test/outcome-reconciler-v2.done-gate.test.mjs',
];
const sources = Object.fromEntries(sourceFiles.map((relative) => [relative, fileDigest(relative)]));
const startedAt = process.env.OUTCOME_DONE_GATE_STARTED_AT;
assert.match(startedAt ?? '', /^\d{4}-\d\d-\d\dT/, 'OUTCOME_DONE_GATE_STARTED_AT is required');
const body = {
  schemaVersion: 1,
  suite: evidence.suite,
  outcome: 'PASS',
  targetSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  targetBranch: execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  ...summary,
  postgres: evidence.postgres,
  proofs: evidence.invariants,
  samples: evidence.samples,
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
console.log(canonicalJson(manifest));
console.log(`done-gate manifest: ${outputPath}`);
