#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [tapPath, evidencePath, outputPath] = process.argv.slice(2);
assert.ok(tapPath && evidencePath && outputPath,
  'usage: outcome-reconciler-watchdog-current-binding-manifest.mjs TAP EVIDENCE OUTPUT');
assert.equal(process.env.WATCHDOG_CURRENT_BINDING_FIXTURE_CLEANED, 'true',
  'disposable PostgreSQL must be removed before manifest publication');

const repo = path.resolve(import.meta.dirname, '..');
const tap = readFileSync(tapPath, 'utf8');
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const expectedMigrationFrontier = readdirSync(path.join(repo, 'src/apiserver/prisma/migrations'), {
  withFileTypes: true,
}).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1);

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
assert.ok(summary.tests >= 5, `zero/undersized test sample: ${summary.tests}`);
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
  assert.equal(proven, name === 'productionProjectionWrites' ? false : true,
    `${name} was not proven`);
}
const started = Date.parse(evidence.observationWindow.startedAt);
const finished = Date.parse(evidence.observationWindow.finishedAt);
assert.ok(Number.isFinite(started) && Number.isFinite(finished) && finished >= started);
assert.equal(evidence.observationWindow.durationMilliseconds, finished - started);
assert.ok(evidence.observationWindow.startupRegistrationMilliseconds <= 2_000);

const sourceFiles = [
  'package.json',
  'docker-compose.yml',
  '.agents/skills/upgrade/scripts/upgrade.sh',
  'src/apiserver/prisma/schema.prisma',
  'src/apiserver/prisma/migrations/0206_watchdog_current_binding/migration.sql',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.runner.ts',
  'src/apiserver/src/outcome-watchdog/outcome-watchdog.service.ts',
  'test/executable-acceptance-runtime.test.mjs',
  'test/outcome-reconciler-watchdog-current-binding.test.mjs',
  'scripts/outcome-reconciler-watchdog-current-binding-regression.sh',
  'scripts/outcome-reconciler-watchdog-current-binding-manifest.mjs',
  'scripts/outcome-reconciler-watchdog-current-binding-integration.mjs',
  'scripts/outcome-reconciler-deployment-attestation.mjs',
  'scripts/outcome-reconciler-watchdog-current-binding.sh',
];
const sourceDigests = Object.fromEntries(sourceFiles.map((relative) => [
  relative,
  sha256(readFileSync(path.join(repo, relative))),
]));
const manifest = {
  schemaVersion: 1,
  suite: evidence.suite,
  outcome: 'PASS',
  targetSha,
  sourceDigests,
  sourceDigest: sha256(JSON.stringify(sourceDigests)),
  summary,
  skipCount: summary.skipped,
  postgres: evidence.postgres,
  observationWindow: evidence.observationWindow,
  samples: evidence.samples,
  coverage: evidence.coverage,
  results: evidence.results,
  fixture: {
    disposable: true,
    cleanedBeforeManifest: true,
    productionWrites: false,
    productionProjectionWrites: false,
  },
  generatedAt: new Date().toISOString(),
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
