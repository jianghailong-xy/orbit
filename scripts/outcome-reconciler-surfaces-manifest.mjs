#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const [tapArg, evidenceArg, outputArg] = process.argv.slice(2);
assert.ok(tapArg && evidenceArg && outputArg, 'usage: outcome-reconciler-surfaces-manifest.mjs TAP EVIDENCE OUTPUT');
const tap = readFileSync(path.resolve(tapArg), 'utf8');
const evidence = JSON.parse(readFileSync(path.resolve(evidenceArg), 'utf8'));

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

const sha = (value) => createHash('sha256').update(value).digest('hex');
const fileDigest = (relative) => sha(readFileSync(path.join(ROOT, relative)));
const summary = {
  tests: counter('tests'),
  passed: counter('pass'),
  failed: counter('fail'),
  skipped: counter('skipped'),
  cancelled: counter('cancelled'),
  todo: counter('todo'),
};
assert.ok(summary.tests >= 8, 'surface suite is empty or truncated');
assert.equal(summary.passed, summary.tests);
assert.equal(summary.failed, 0);
assert.equal(summary.skipped, 0, 'skip=0 is mandatory');
assert.equal(summary.cancelled, 0);
assert.equal(summary.todo, 0);
assert.equal(evidence.schemaVersion, 2);
assert.equal(evidence.suite, 'outcome-reconciler-v2-surfaces');
for (const [name, proven] of Object.entries(evidence.invariants)) {
  assert.equal(proven, true, `invariant not proven: ${name}`);
}
assert.ok(Object.keys(evidence.invariants).length >= 14, 'surface failure matrix is incomplete');
assert.match(evidence.samples.requestRevision, /^[0-9a-f]{64}$/);

const sourceFiles = [
  'package.json',
  'contracts/outcome-reconciler-v2.surfaces.fixture.json',
  'scripts/outcome-reconciler-surfaces.sh',
  'scripts/outcome-reconciler-surfaces-manifest.mjs',
  'src/apiserver/prisma/migrations/0199_outcome_actor_surfaces/migration.sql',
  'src/apiserver/src/outcome-reconciler/outcome-surfaces.ts',
  'src/apiserver/src/outcome-reconciler/outcome-surface.service.ts',
  'src/apiserver/src/outcome-reconciler/outcome-surfaces.controller.ts',
  'src/runner-go/outcome_surface_test.go',
  'src/web/src/lib/outcomeSurfaces.ts',
  'src/web/src/lib/outcomeSurfaces.contract.test.ts',
  'src/web/src/pages/JudgmentInboxPage.tsx',
  'src/web/src/pages/OwnerRatificationReviewPage.tsx',
  'test/outcome-reconciler-v2.surfaces.test.mjs',
];
const sources = Object.fromEntries(sourceFiles.map((file) => [file, fileDigest(file)]));
const body = {
  schemaVersion: 2,
  suite: evidence.suite,
  outcome: 'PASS',
  targetSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  targetBranch: execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  ...summary,
  proofs: evidence.invariants,
  samples: evidence.samples,
  sources,
  sourceDigest: sha(canonical(sources)),
  inputDigest: sha(canonical({ tap: sha(tap), evidence, sources })),
};
const manifest = { ...body, manifestDigest: sha(canonical(body)) };
const output = path.resolve(outputArg);
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${canonical(manifest)}\n`);
console.log(canonical(manifest));
console.log(`outcome-surfaces: tests=${summary.tests} pass=${summary.passed} skip=${summary.skipped}`);
