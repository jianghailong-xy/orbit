#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [tapPath, evidencePath, outputPath] = process.argv.slice(2);
assert.ok(tapPath && evidencePath && outputPath,
  'usage: outcome-reconciler-failure-continuation-trigger-manifest.mjs TAP EVIDENCE OUTPUT');
assert.equal(process.env.FAILURE_CONTINUATION_FIXTURE_CLEANED, 'true',
  'disposable PostgreSQL must be removed before manifest publication');

const repo = path.resolve(import.meta.dirname, '..');
const tap = readFileSync(tapPath, 'utf8');
const evidenceText = readFileSync(evidencePath, 'utf8');
const evidence = JSON.parse(evidenceText);
const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repo,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const expectedMigrationFrontier = readdirSync(
  path.join(repo, 'src/apiserver/prisma/migrations'),
  { withFileTypes: true },
).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function summaryFromTap(value) {
  const read = (name) => {
    const matches = [...value.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
    assert.ok(matches.length > 0, `TAP summary is missing ${name}`);
    return Number(matches.at(-1)[1]);
  };
  return {
    tests: read('tests'),
    passed: read('pass'),
    failed: read('fail'),
    cancelled: read('cancelled'),
    skipped: read('skipped'),
    todo: read('todo'),
  };
}

const summary = summaryFromTap(tap);
assert.ok(summary.tests >= 6, `zero/undersized test sample: ${summary.tests}`);
assert.equal(summary.failed, 0);
assert.equal(summary.cancelled, 0);
assert.equal(summary.skipped, 0);
assert.equal(summary.todo, 0);
assert.equal(summary.passed, summary.tests);
assert.equal(evidence.outcome, 'PASS');
assert.equal(evidence.targetSha, targetSha);
assert.equal(evidence.postgres.required, true);
assert.equal(evidence.postgres.connected, true);
assert.ok(evidence.postgres.migrations > 0);
assert.equal(evidence.postgres.lastMigration, expectedMigrationFrontier);
assert.equal(evidence.postgres.requiredMigrationApplied, true);
for (const [name, count] of Object.entries(evidence.samples)) {
  assert.ok(Number.isInteger(count) && count > 0, `${name} has zero samples`);
}
for (const [name, proven] of Object.entries(evidence.coverage)) {
  assert.equal(proven, name === 'productionWrites' ? false : true, `${name} was not proven`);
}
const started = Date.parse(evidence.observationWindow.startedAt);
const finished = Date.parse(evidence.observationWindow.finishedAt);
assert.ok(Number.isFinite(started) && Number.isFinite(finished) && finished >= started);
assert.equal(evidence.observationWindow.durationMilliseconds, finished - started);

const sourceFiles = [
  'package.json',
  'docs/postgres-lock-order.md',
  'src/shared/src/codec.ts',
  'src/apiserver/prisma/schema.prisma',
  'src/apiserver/prisma/migrations/0210_failure_continuation_trigger/migration.sql',
  'src/apiserver/src/common/db-write-inventory.ts',
  'src/apiserver/src/common/db-write-inventory.spec.ts',
  'src/apiserver/src/projects/coordinator-wake.ts',
  'src/apiserver/src/projects/coordinator-wake.spec.ts',
  'src/apiserver/src/projects/coordinator-judgment-opening.ts',
  'src/apiserver/src/projects/coordinator-judgment.module.ts',
  'src/apiserver/src/projects/failure-continuation.ts',
  'src/apiserver/src/projects/failure-continuation.service.ts',
  'src/apiserver/src/runner-api/runner-api.controller.ts',
  'test/outcome-reconciler-failure-continuation-trigger.test.mjs',
  'scripts/outcome-reconciler-failure-continuation-trigger.sh',
  'scripts/outcome-reconciler-failure-continuation-trigger-manifest.mjs',
];
const sourceDigests = Object.fromEntries(sourceFiles.map((relative) => [
  relative,
  sha256(readFileSync(path.join(repo, relative))),
]));
const sourceDigest = sha256(JSON.stringify(sourceDigests));
const input = {
  suite: evidence.suite,
  command: 'npm run test:outcome-reconciler:failure-continuation-trigger',
  expectedExitCode: 0,
  minimumTests: 6,
  skipCountRequired: 0,
  targetSha,
  sourceDigest,
  migrationFrontier: expectedMigrationFrontier,
  databaseIdentity: {
    database: evidence.postgres.database,
    user: evidence.postgres.user,
    systemIdentifier: evidence.postgres.systemIdentifier,
  },
};
const inputDigest = sha256(JSON.stringify(input));
const result = {
  outcome: 'PASS',
  summary,
  tapDigest: sha256(tap),
  evidenceDigest: sha256(evidenceText),
  coverage: evidence.coverage,
  samples: evidence.samples,
};
const resultDigest = sha256(JSON.stringify(result));
const manifest = {
  schemaVersion: 1,
  suite: evidence.suite,
  outcome: 'PASS',
  targetSha,
  sourceDigests,
  sourceDigest,
  input,
  inputDigest,
  result,
  resultDigest,
  summary,
  skipCount: summary.skipped,
  postgres: evidence.postgres,
  observationWindow: evidence.observationWindow,
  results: evidence.results,
  fixture: {
    disposable: true,
    cleanedBeforeManifest: true,
    productionWrites: false,
    ownerCredentialsMinted: false,
  },
  generatedAt: new Date().toISOString(),
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
