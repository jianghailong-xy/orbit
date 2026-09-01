#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [tapPath, evidencePath, outputPath] = process.argv.slice(2);
assert.ok(tapPath && evidencePath && outputPath,
  'usage: outcome-reconciler-failure-routing-manifest.mjs TAP EVIDENCE OUTPUT');
assert.equal(process.env.FAILURE_ROUTING_FIXTURE_CLEANED, 'true',
  'disposable PostgreSQL must be removed before manifest publication');
const resourcesRemaining = Number(process.env.FAILURE_ROUTING_RESOURCES_REMAINING);
assert.equal(resourcesRemaining, 0, 'a disposable fixture resource survived cleanup');

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
assert.ok(summary.tests >= 7, `zero/undersized test sample: ${summary.tests}`);
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
// The destructive-fixture safety gate every disposable coordinator suite shares: a run that is not
// on its own pcc_* role and database cannot prove it never touched a deployed one.
for (const identity of [evidence.postgres.user, evidence.postgres.database]) {
  assert.match(identity, /^pcc[0-9a-z]*[_-]/, `${identity} is not a disposable pcc_* identity`);
}
assert.equal(`${evidence.postgres.user}/${evidence.postgres.database}`,
  process.env.FAILURE_ROUTING_PG_IDENTITY);
for (const [name, count] of Object.entries(evidence.samples)) {
  assert.ok(Number.isInteger(count) && count > 0, `${name} has zero samples`);
}
for (const [name, proven] of Object.entries(evidence.coverage)) {
  assert.equal(proven, name === 'productionWrites' ? false : true, `${name} was not proven`);
}
assert.deepEqual(
  evidence.results.domainRoutes.map(({ domain }) => domain),
  [
    'TRANSIENT_EXTERNAL',
    'EVALUATION_HARNESS',
    'PRODUCT_ARTIFACT',
    'CAPABILITY/ENVIRONMENT',
    'OWNER_REQUIRED',
  ],
);
assert.deepEqual(
  evidence.results.convergence.map(({ path }) => path),
  ['PRIMARY_RECOVERY', 'ALTERNATE_DIAGNOSIS', 'PROJECT_ATTENTION'],
);
assert.equal(evidence.results.evaluationPlan.routedNode, 'PRODUCT_BEHAVIOR');
assert.equal(evidence.results.evaluationPlan.routedDomain, 'PRODUCT_ARTIFACT');
assert.equal(evidence.results.evaluationPlan.ownerReason, null);
assert.equal(evidence.results.evaluationPlan.routedOwnerInboxRows, 0);
assert.notEqual(
  evidence.results.evaluationPlan.beforeEvaluationPlanDigest,
  evidence.results.evaluationPlan.afterEvaluationPlanDigest,
);
const started = Date.parse(evidence.observationWindow.startedAt);
const finished = Date.parse(evidence.observationWindow.finishedAt);
assert.ok(Number.isFinite(started) && Number.isFinite(finished) && finished >= started);
assert.equal(evidence.observationWindow.durationMilliseconds, finished - started);

const sourceFiles = [
  'package.json',
  'docs/postgres-lock-order.md',
  'src/apiserver/prisma/migrations/0210_failure_continuation_trigger/migration.sql',
  'src/apiserver/prisma/migrations/0211_failure_continuation_routing/migration.sql',
  'src/apiserver/prisma/migrations/0213_failure_site_fingerprint/migration.sql',
  'src/apiserver/prisma/schema.prisma',
  'src/apiserver/src/runner-api/runner-api.controller.ts',
  'src/apiserver/src/tasks/executable-acceptance-runtime.ts',
  'scripts/outcome-reconciler-release-dag.mjs',
  'src/apiserver/src/common/db-write-inventory.ts',
  'src/apiserver/src/common/db-write-inventory.spec.ts',
  'src/apiserver/src/projects/coordinator-judgment-opening.ts',
  'src/apiserver/src/projects/coordinator-judgment.module.ts',
  'src/apiserver/src/projects/failure-continuation.ts',
  'src/apiserver/src/projects/failure-continuation.service.ts',
  'src/apiserver/src/projects/failure-continuation-controller.ts',
  'src/apiserver/src/projects/failure-continuation-controller.service.ts',
  'test/outcome-reconciler-failure-routing.test.mjs',
  'scripts/outcome-reconciler-failure-routing.sh',
  'scripts/outcome-reconciler-failure-routing-manifest.mjs',
];
const sourceDigests = Object.fromEntries(sourceFiles.map((relative) => [
  relative,
  sha256(readFileSync(path.join(repo, relative))),
]));
const sourceDigest = sha256(JSON.stringify(sourceDigests));
const input = {
  suite: evidence.suite,
  command: 'npm run test:outcome-reconciler:failure-routing',
  expectedExitCode: 0,
  minimumTests: 7,
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
    resourcesRemaining,
    productionWrites: false,
    ownerCredentialsMinted: false,
    dailyAutomationBudgetRequired: false,
  },
  generatedAt: new Date().toISOString(),
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
