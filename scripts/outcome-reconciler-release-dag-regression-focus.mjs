#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { canonical, sha256 } from './outcome-reconciler-release-dag-lib.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const [runRootArgument, outputArgument] = process.argv.slice(2);
assert.ok(runRootArgument && outputArgument,
  'usage: outcome-reconciler-release-dag-regression-focus.mjs RUN_ROOT OUTPUT');
const runRoot = path.resolve(runRootArgument);
const output = path.resolve(outputArgument);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const binding = readJson(path.join(runRoot, 'binding.json'));
const postgres = readJson(path.join(runRoot, 'postgres-context.json'));
const webReportPath = path.join(repo, 'build', 'outcome-reconciler-full-web.json');
const watchdogManifestPath = path.join(repo, 'build',
  'outcome-reconciler-v2-watchdog-manifest.json');
const webReport = readJson(webReportPath);
const watchdog = readJson(watchdogManifestPath);
const caseRoot = path.join(runRoot, 'regression-focused-cases');
const logRoot = path.join(runRoot, 'regression-focused-logs');
mkdirSync(caseRoot, { recursive: true });
mkdirSync(logRoot, { recursive: true });

for (const nodeId of ['full-web', 'suite-watchdog-111k']) {
  const receipt = readJson(path.join(runRoot, 'nodes', `${nodeId}.json`));
  assert.equal(receipt.state, 'SUCCESS', `${nodeId} did not pass its focused run`);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.skipCount, 0);
  assert.equal(receipt.binding.targetSha, binding.targetSha);
  assert.equal(receipt.binding.bindingDigest, binding.bindingDigest);
}

assert.equal(webReport.success, true, 'full-web JSON report did not pass');
assert.ok(webReport.numTotalTests > 0, 'full-web JSON report contains no tests');
assert.equal(webReport.numFailedTests, 0);
assert.equal(webReport.numPendingTests, 0);
assert.equal(webReport.numFailedTestSuites, 0);
assert.equal(webReport.numPendingTestSuites, 0);
assert.equal(webReport.numPassedTests, webReport.numTotalTests);
assert.equal(webReport.numPassedTestSuites, webReport.numTotalTestSuites);
assert.ok(webReport.testResults.every((result) => result.status === 'passed'));
const readySuite = webReport.testResults.find((result) =>
  result.name.endsWith('/src/web/src/components/ProjectReadyToRun.test.tsx'));
assert.ok(readySuite, 'full-web report omitted the old failing ProjectReadyToRun suite');
const oldFailingAssertion = readySuite.assertionResults.find((result) =>
  result.title === 'shows an actionable ready queue without the old chart/table control');
assert.equal(oldFailingAssertion?.status, 'passed',
  'the old full-web timeout fingerprint was not cleared');

assert.equal(watchdog.outcome, 'PASS');
assert.equal(watchdog.tests, 13);
assert.equal(watchdog.passed, 13);
assert.equal(watchdog.failed, 0);
assert.equal(watchdog.skipped, 0);
assert.equal(watchdog.cancelled, 0);
assert.equal(watchdog.targetSha, binding.targetSha);
assert.equal(watchdog.collectorSha, binding.targetSha);
assert.equal(watchdog.liveReleaseFence.mode, 'OFFLINE_DEV_ONLY',
  'predeploy Watchdog read or required the live production deployment');

const cases = [
  {
    index: 181,
    shard: 0,
    spec: 'src/apiserver/build/runner-api/runner-write-lease-owner.spec.js',
    oldFingerprint: 'tx.conversationTurn.findMany is not a function',
  },
  {
    index: 154,
    shard: 1,
    spec: 'src/apiserver/build/runner-api/inbox-lease-generation.spec.js',
    oldFingerprint: 'args[0].join is not a function',
  },
  {
    index: 79,
    shard: 2,
    spec: 'src/apiserver/build/projects/project-list-rollup.audit.pg.spec.js',
    oldFingerprint: '9 !== 7',
  },
  {
    index: 80,
    shard: 3,
    spec: 'src/apiserver/build/projects/project-list-rollup.pg.spec.js',
    oldFingerprint: '9 !== 7',
  },
];
const commonEnvironment = {
  ...process.env,
  OUTCOME_API_CASE_CONTAINER: postgres.container,
  OUTCOME_API_CASE_PROVISIONER: postgres.admin,
  OUTCOME_API_CASE_PASSWORD: 'pccrd_disposable_password',
  OUTCOME_API_CASE_HOST: postgres.host,
  OUTCOME_API_CASE_PORT: String(postgres.port),
  OUTCOME_API_CASE_SYSTEM_ID: postgres.systemIdentifier,
  OUTCOME_API_CASE_TEMPLATE: postgres.currentTemplate,
  OUTCOME_API_CASE_BINDING_DIGEST: binding.bindingDigest,
  OUTCOME_API_CASE_ATTEMPT_TOKEN: binding.releaseAttempt.token,
  OUTCOME_API_CASE_PARTITION_CLASS: 'parallel',
  OUTCOME_API_CASE_REPO: repo,
  OUTCOME_API_CASE_API: path.join(repo, 'src', 'apiserver'),
  OUTCOME_API_CASE_DIR: caseRoot,
  OUTCOME_API_CASE_TOTAL: String(cases.length),
};

function runCase(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [
      path.join(repo, 'scripts', 'outcome-reconciler-full-api-case.sh'),
      String(entry.index), path.join(repo, entry.spec),
    ], {
      cwd: repo,
      env: {
        ...commonEnvironment,
        OUTCOME_API_CASE_PARTITION_INDEX: String(entry.shard),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const raw = Buffer.concat(chunks);
      const log = path.join(logRoot, `${String(entry.index).padStart(4, '0')}.log`);
      writeFileSync(log, raw);
      if (signal || code !== 0) {
        reject(new Error(`focused API case ${entry.spec} exited code=${code} signal=${signal ?? 'none'}\n${raw.toString('utf8')}`));
        return;
      }
      resolve({ ...entry, log });
    });
  });
}

// Launch all four before awaiting any one of them. The two PostgreSQL rollup suites therefore
// prove the case allocator's isolation under actual overlap, not merely by comparing names.
const completedCases = await Promise.all(cases.map((entry) => runCase(entry)));
const receipts = completedCases.map((entry) => {
  const receipt = readJson(path.join(caseRoot, `${String(entry.index).padStart(4, '0')}.json`));
  const launcherRaw = readFileSync(entry.log, 'utf8');
  const tapPath = path.join(caseRoot, `${String(entry.index).padStart(4, '0')}.tap`);
  const tapRaw = readFileSync(tapPath, 'utf8');
  assert.equal(receipt.outcome, 'PASS');
  assert.ok(receipt.summary.tests > 0);
  assert.equal(receipt.summary.passed, receipt.summary.tests);
  assert.equal(receipt.summary.failed, 0);
  assert.equal(receipt.summary.cancelled, 0);
  assert.equal(receipt.summary.skipped, 0);
  assert.equal(receipt.summary.todo, 0);
  assert.equal(receipt.cleanup.resourcesRemaining, 0);
  assert.equal(receipt.identity.verifiedBeforeMutation, true);
  assert.equal(receipt.bindingDigest, binding.bindingDigest);
  assert.match(receipt.database, /^pcc[0-9a-z]*_/u);
  assert.match(receipt.emptyDatabase, /^pcc[0-9a-z]*_/u);
  assert.match(receipt.role, /^pcc[0-9a-z]*_/u);
  assert.equal(receipt.tap.bytes, Buffer.byteLength(tapRaw));
  assert.equal(receipt.tap.sha256, sha256(tapRaw));
  assert.doesNotMatch(tapRaw,
    new RegExp(entry.oldFingerprint.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  return {
    entry,
    receipt,
    tap: { bytes: Buffer.byteLength(tapRaw), sha256: sha256(tapRaw) },
    launcherLog: { bytes: Buffer.byteLength(launcherRaw), sha256: sha256(launcherRaw) },
  };
});

const rollups = receipts.filter(({ entry }) => entry.spec.includes('project-list-rollup'));
assert.equal(rollups.length, 2);
for (const { entry, tap } of rollups) {
  const raw = readFileSync(path.join(
    caseRoot, `${String(entry.index).padStart(4, '0')}.tap`,
  ), 'utf8');
  assert.match(raw, /index and the project page report the same seven numbers|every bucket equals what the project page computes/u);
  assert.match(raw, /# fail 0/u);
  assert.match(raw, /# skipped 0/u);
  assert.ok(tap.bytes > 0);
}

for (const field of ['database', 'emptyDatabase', 'role']) {
  assert.equal(new Set(receipts.map(({ receipt }) => receipt[field])).size, receipts.length,
    `focused API cases shared ${field}`);
}
const quoted = (value) => `'${value.replaceAll("'", "''")}'`;
const databases = receipts.flatMap(({ receipt }) => [receipt.database, receipt.emptyDatabase]);
const roles = receipts.map(({ receipt }) => receipt.role);
const cleanupQuery = `SELECT (SELECT count(*) FROM pg_database WHERE datname IN (${databases.map(quoted).join(',')})) + (SELECT count(*) FROM pg_roles WHERE rolname IN (${roles.map(quoted).join(',')}))`;
const remaining = execFileSync('docker', [
  'exec', postgres.container, 'psql', '-U', postgres.admin, '-d', 'postgres',
  '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', cleanupQuery,
], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(remaining, '0', 'focused pcc_* databases or roles survived cleanup');

const apiSummary = receipts.reduce((summary, { receipt }) => ({
  tests: summary.tests + receipt.summary.tests,
  passed: summary.passed + receipt.summary.passed,
  failed: summary.failed + receipt.summary.failed,
  skipped: summary.skipped + receipt.summary.skipped,
}), { tests: 0, passed: 0, failed: 0, skipped: 0 });
assert.ok(apiSummary.tests > 0);
assert.equal(apiSummary.passed, apiSummary.tests);
assert.equal(apiSummary.failed, 0);
assert.equal(apiSummary.skipped, 0);

const body = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-dag-regression-focused-run',
  suite: 'release-dag-regression-focused-run-v1',
  outcome: 'PASS',
  targetSha: binding.targetSha,
  bindingDigest: binding.bindingDigest,
  releaseAttempt: binding.releaseAttempt,
  watchdog: {
    tests: watchdog.tests,
    passed: watchdog.passed,
    failed: watchdog.failed,
    skipped: watchdog.skipped,
    targetSha: watchdog.targetSha,
    collectorSha: watchdog.collectorSha,
    liveReleaseFence: watchdog.liveReleaseFence,
    manifest: {
      path: path.relative(repo, watchdogManifestPath),
      bytes: readFileSync(watchdogManifestPath).byteLength,
      sha256: sha256(readFileSync(watchdogManifestPath)),
    },
  },
  fullWeb: {
    success: webReport.success,
    testSuites: webReport.numTotalTestSuites,
    passedTestSuites: webReport.numPassedTestSuites,
    failedTestSuites: webReport.numFailedTestSuites,
    tests: webReport.numTotalTests,
    passed: webReport.numPassedTests,
    failed: webReport.numFailedTests,
    skipped: webReport.numPendingTests,
    oldFailingAssertionCleared: true,
    report: {
      path: path.relative(repo, webReportPath),
      bytes: readFileSync(webReportPath).byteLength,
      sha256: sha256(readFileSync(webReportPath)),
    },
  },
  api: {
    summary: apiSummary,
    cases: receipts.map(({ entry, receipt, tap, launcherLog }) => ({
      path: receipt.spec.path,
      caseIndex: receipt.caseIndex,
      partition: receipt.partition,
      summary: receipt.summary,
      database: receipt.database,
      emptyDatabase: receipt.emptyDatabase,
      role: receipt.role,
      cleanup: receipt.cleanup,
      receiptDigest: receipt.artifactDigest,
      tap,
      launcherLog,
      oldFingerprintCleared: entry.oldFingerprint,
    })),
  },
  rollup: {
    suites: rollups.map(({ receipt }) => receipt.spec.path),
    bucketFields: [
      'running', 'ready', 'blocked', 'awaitingVerification', 'done', 'failed', 'cancelled',
    ],
    indexPageParity: true,
    concurrentlyIsolated: true,
  },
  isolation: {
    allCasesStartedBeforeAwait: true,
    uniqueDatabases: true,
    uniqueEmptyDatabases: true,
    uniqueRoles: true,
    productionAccess: false,
    resourcesRemaining: Number(remaining),
  },
};
writeFileSync(output, `${JSON.stringify({
  ...body,
  artifactDigest: sha256(canonical(body)),
}, null, 2)}\n`, { mode: 0o600 });

rmSync(caseRoot, { recursive: true, force: true });
rmSync(logRoot, { recursive: true, force: true });
assert.equal(Number(remaining), 0);
console.log(`release-dag regression focus PASS: api=${apiSummary.tests} web=${webReport.numTotalTests} watchdog=${watchdog.tests} target=${binding.targetSha}`);
