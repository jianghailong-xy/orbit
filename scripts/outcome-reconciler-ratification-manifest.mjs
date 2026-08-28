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
  'usage: outcome-reconciler-ratification-manifest.mjs TAP EVIDENCE OUTPUT');
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
assert.equal(summary.passed, summary.tests, 'not every Owner Ratification test passed');
assert.equal(summary.failed, 0, 'Owner Ratification suite contains failures');
assert.equal(summary.skipped, 0, 'skipped Owner Ratification tests are forbidden');
assert.equal(summary.cancelled, 0, 'cancelled Owner Ratification tests are forbidden');
assert.equal(summary.todo, 0, 'todo Owner Ratification tests are forbidden');
assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.suite, 'outcome-reconciler-v2-owner-ratification');
assert.equal(evidence.postgres.required, true);
assert.equal(evidence.postgres.connected, true, 'PostgreSQL was not exercised');
assert.match(evidence.postgres.version, /^1[6-9]\./, 'PostgreSQL 16+ is required');
assert.match(evidence.postgres.systemIdentifier, /^[0-9]+$/);
assertAllTrue(evidence.invariants, 'invariants');
assertAllTrue(evidence.races, 'races');
assertAllTrue(evidence.cta, 'cta');
for (const value of Object.values(evidence.samples)) assert.match(value, /^[0-9a-f]{64}$/);

const sourceFiles = [
  'package.json',
  'scripts/outcome-reconciler-ratification-manifest.mjs',
  'scripts/outcome-reconciler-ratification.sh',
  'src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql',
  'src/apiserver/prisma/schema.prisma',
  'src/apiserver/src/common/db-write-inventory.ts',
  'src/apiserver/src/projects/dto.ts',
  'src/apiserver/src/projects/project-acceptance.service.ts',
  'src/apiserver/src/projects/project-acceptance.ts',
  'src/apiserver/src/projects/projects.controller.ts',
  'src/apiserver/src/projects/projects.service.ts',
  'src/apiserver/src/runner-api/runner-projects.controller.ts',
  'src/apiserver/src/tasks/tasks.service.ts',
  'src/shared/src/codec.ts',
  'test/outcome-reconciler-v2.ratification.test.mjs',
];
const sources = Object.fromEntries(sourceFiles.map((relative) => [relative, fileDigest(relative)]));
const startedAt = process.env.OWNER_RATIFICATION_STARTED_AT;
assert.match(startedAt ?? '', /^\d{4}-\d\d-\d\dT/, 'OWNER_RATIFICATION_STARTED_AT is required');
const finishedAt = new Date().toISOString();
const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const targetBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim();
const body = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-owner-ratification',
  outcome: 'PASS',
  targetSha,
  targetBranch,
  ...summary,
  postgres: evidence.postgres,
  proofs: { invariants: evidence.invariants, races: evidence.races, cta: evidence.cta },
  samples: evidence.samples,
  migrationDigest: sources['src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql'],
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
console.log(`owner-ratification manifest: ${outputPath}`);
