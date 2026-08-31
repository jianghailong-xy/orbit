#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { canonical, sha256 } from './outcome-reconciler-release-dag-lib.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const [runRootArgument, outputArgument] = process.argv.slice(2);
assert.ok(runRootArgument && outputArgument,
  'usage: outcome-reconciler-release-dag-pcc-focus.mjs RUN_ROOT OUTPUT');
const runRoot = path.resolve(runRootArgument);
const output = path.resolve(outputArgument);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const bindingDocument = readJson(path.join(runRoot, 'binding.json'));
const postgres = readJson(path.join(runRoot, 'postgres-context.json'));
const plan = readJson(path.join(repo, 'contracts/outcome-reconciler-release-dag.json'));
const caseRoot = path.join(runRoot, 'pcc-focused-cases');
const logRoot = path.join(runRoot, 'pcc-focused-logs');
mkdirSync(caseRoot, { recursive: true });
mkdirSync(logRoot, { recursive: true });

assert.equal(process.env.OUTCOME_RELEASE_DAG_BINDING_DIGEST, bindingDocument.bindingDigest);
assert.equal(process.env.OUTCOME_RELEASE_DAG_ATTEMPT_DIGEST,
  bindingDocument.releaseAttempt.digest);
assert.equal(process.env.OUTCOME_RELEASE_DAG_ATTEMPT_TOKEN,
  bindingDocument.releaseAttempt.token);

const focusedSuiteIds = [
  'suite-bootstrap',
  'suite-evaluator',
  'suite-projection',
  'suite-fact-ingress',
  'suite-auto-dispatch',
  'suite-work-overview-readiness',
  'suite-watchdog-111k',
];
const suiteReceipts = focusedSuiteIds.map((nodeId) => {
  const receipt = readJson(path.join(runRoot, 'nodes', `${nodeId}.json`));
  assert.equal(receipt.state, 'SUCCESS', `${nodeId} did not pass its focused run`);
  assert.ok(receipt.testCount > 0, `${nodeId} reported no focused tests`);
  assert.equal(receipt.failCount, 0, `${nodeId} reported failed focused tests`);
  assert.equal(receipt.skipCount, 0, `${nodeId} reported skipped focused tests`);
  assert.equal(receipt.binding.bindingDigest, bindingDocument.bindingDigest);
  assert.equal(receipt.releaseAttempt.digest, bindingDocument.releaseAttempt.digest);
  assert.equal(receipt.postgresIsolation.cleanup.resourcesRemaining, 0);
  assert.equal(receipt.postgresIsolation.identityVerifiedBeforeMutation, true);
  const policy = plan.postgresIsolation.nodes[nodeId];
  assert.equal(receipt.postgresIsolation.databasePrefix, policy.postgresDatabasePrefix);
  assert.equal(receipt.postgresIsolation.rolePrefix, policy.postgresRolePrefix);
  if (policy.destructiveCoordinatorSpecs) {
    assert.match(receipt.postgresIsolation.database, /^pcc[0-9a-z]*_/u);
    assert.match(receipt.postgresIsolation.role, /^pcc[0-9a-z]*_/u);
  }
  return receipt;
});
const watchdogManifest = readJson(path.join(repo, 'build',
  'outcome-reconciler-v2-watchdog-manifest.json'));
assert.equal(watchdogManifest.targetSha, bindingDocument.targetSha);
assert.equal(watchdogManifest.outcome, 'PASS');
assert.equal(watchdogManifest.liveReleaseFence.mode, 'OFFLINE_DEV_ONLY',
  'focused pcc regression touched or depended on the live production deployment');
assert.equal(new Set(suiteReceipts.map((receipt) => receipt.postgresIsolation.database)).size,
  suiteReceipts.length, 'focused affected suites shared a database');
assert.equal(new Set(suiteReceipts.map((receipt) => receipt.postgresIsolation.role)).size,
  suiteReceipts.length, 'focused affected suites shared a role');

const cases = [
  { index: 1, shard: 0, spec: 'src/apiserver/build/agents/agent-identity-migration.pg.spec.js' },
  { index: 2, shard: 1, spec: 'src/apiserver/build/agents/agent-persistence.pg.spec.js' },
  { index: 31, shard: 2, spec: 'src/apiserver/build/common/transaction-retry.pg.spec.js' },
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
  OUTCOME_API_CASE_BINDING_DIGEST: bindingDocument.bindingDigest,
  OUTCOME_API_CASE_ATTEMPT_TOKEN: bindingDocument.releaseAttempt.token,
  OUTCOME_API_CASE_REPO: repo,
  OUTCOME_API_CASE_API: path.join(repo, 'src', 'apiserver'),
  OUTCOME_API_CASE_DIR: caseRoot,
  OUTCOME_API_CASE_TOTAL: String(cases.length),
};

function runCase(entry, { expectedFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const spec = path.join(repo, entry.spec);
    const child = spawn('bash', [
      path.join(repo, 'scripts', 'outcome-reconciler-full-api-case.sh'),
      String(entry.index), spec,
    ], {
      cwd: repo,
      env: {
        ...commonEnvironment,
        OUTCOME_API_CASE_PARTITION_CLASS: entry.partitionClass ?? 'parallel',
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
      if (signal || (!expectedFailure && code !== 0) || (expectedFailure && code === 0)) {
        reject(new Error(`focused case ${entry.spec} exited code=${code} signal=${signal ?? 'none'}\n${raw.toString('utf8')}`));
        return;
      }
      resolve({ ...entry, exitCode: code, log });
    });
  });
}

const positiveRuns = await Promise.all(cases.map((entry) => runCase(entry)));
const failureCase = {
  index: 9001,
  shard: 0,
  partitionClass: 'serial',
  spec: 'test/fixtures/outcome-reconciler-release-dag-pcc-forced-failure.test.mjs',
};
const failureRun = await runCase(failureCase, { expectedFailure: true });
assert.notEqual(failureRun.exitCode, 0, 'focused failure did not propagate');

const positiveReceipts = positiveRuns.map((entry) => {
  const receipt = readJson(path.join(caseRoot, `${String(entry.index).padStart(4, '0')}.json`));
  assert.equal(receipt.outcome, 'PASS');
  assert.ok(receipt.summary.tests > 0);
  assert.equal(receipt.summary.failed, 0);
  assert.equal(receipt.summary.skipped, 0);
  assert.equal(receipt.summary.passed, receipt.summary.tests);
  assert.equal(receipt.cleanup.resourcesRemaining, 0);
  assert.match(receipt.database, /^pcc[0-9a-z]*_/u);
  assert.match(receipt.role, /^pcc[0-9a-z]*_/u);
  assert.equal(receipt.releaseAttempt.digest, bindingDocument.releaseAttempt.digest);
  return receipt;
});
const failureReceipt = readJson(path.join(caseRoot, '9001.json'));
assert.equal(failureReceipt.outcome, 'EXPECTED_FAILURE_PROPAGATED');
assert.ok(failureReceipt.summary.tests > 0);
assert.ok(failureReceipt.summary.failed > 0);
assert.equal(failureReceipt.summary.skipped, 0);
assert.equal(failureReceipt.cleanup.resourcesRemaining, 0);

const allCaseReceipts = [...positiveReceipts, failureReceipt];
assert.equal(new Set(allCaseReceipts.map((receipt) => receipt.database)).size,
  allCaseReceipts.length, 'focused concurrent cases shared a database');
assert.equal(new Set(allCaseReceipts.map((receipt) => receipt.emptyDatabase)).size,
  allCaseReceipts.length, 'focused concurrent cases shared an empty database');
assert.equal(new Set(allCaseReceipts.map((receipt) => receipt.role)).size,
  allCaseReceipts.length, 'focused concurrent cases shared a role');

const quoted = (value) => `'${value.replaceAll("'", "''")}'`;
const databases = allCaseReceipts.flatMap((receipt) => [receipt.database, receipt.emptyDatabase]);
const roles = allCaseReceipts.map((receipt) => receipt.role);
const query = `SELECT (SELECT count(*) FROM pg_database WHERE datname IN (${databases.map(quoted).join(',')})) + (SELECT count(*) FROM pg_roles WHERE rolname IN (${roles.map(quoted).join(',')}))`;
const remaining = execFileSync('docker', [
  'exec', postgres.container, 'psql', '-U', postgres.admin, '-d', 'postgres',
  '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query,
], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(remaining, '0', 'focused case resources survived cleanup');

const totals = positiveReceipts.reduce((summary, receipt) => ({
  tests: summary.tests + receipt.summary.tests,
  passed: summary.passed + receipt.summary.passed,
  failed: summary.failed + receipt.summary.failed,
  skipped: summary.skipped + receipt.summary.skipped,
}), { tests: 0, passed: 0, failed: 0, skipped: 0 });
assert.ok(totals.tests > 0);
assert.equal(totals.passed, totals.tests);
assert.equal(totals.failed, 0);
assert.equal(totals.skipped, 0);

const body = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-dag-pcc-focused-regression',
  suite: 'release-dag-pcc-focused-regression-v1',
  outcome: 'PASS',
  targetSha: bindingDocument.targetSha,
  bindingDigest: bindingDocument.bindingDigest,
  releaseAttempt: bindingDocument.releaseAttempt,
  allocator: plan.postgresIsolation.allocator,
  shardPolicy: plan.postgresIsolation.concurrentShardPolicy,
  affectedSuites: suiteReceipts.map((receipt) => ({
    nodeId: receipt.nodeId,
    tests: receipt.testCount,
    passed: receipt.passCount,
    failed: receipt.failCount,
    skipped: receipt.skipCount,
    databaseIsolation: receipt.postgresIsolation,
  })),
  representativeSpecs: positiveReceipts.map((receipt) => ({
    path: receipt.spec.path,
    caseIndex: receipt.caseIndex,
    partition: receipt.partition,
    tests: receipt.summary.tests,
    passed: receipt.summary.passed,
    failed: receipt.summary.failed,
    skipped: receipt.summary.skipped,
    database: receipt.database,
    emptyDatabase: receipt.emptyDatabase,
    role: receipt.role,
    cleanup: receipt.cleanup,
    receiptDigest: receipt.artifactDigest,
  })),
  representativeSummary: totals,
  concurrency: {
    positiveCasesStartedTogether: true,
    uniqueDatabases: true,
    uniqueEmptyDatabases: true,
    uniqueRoles: true,
    crossTenantAccess: false,
    productionAccess: false,
  },
  productionFence: {
    mode: watchdogManifest.liveReleaseFence.mode,
    liveDeploymentRead: false,
    formalReleaseFenceChanged: false,
  },
  failurePropagation: {
    spec: failureReceipt.spec.path,
    exitCode: failureReceipt.exitCode,
    failedTests: failureReceipt.summary.failed,
    outcome: failureReceipt.outcome,
    cleanup: failureReceipt.cleanup,
    receiptDigest: failureReceipt.artifactDigest,
  },
  cleanup: {
    resourcesRemaining: Number(remaining),
    allSuiteResourcesRemoved: true,
    allCaseResourcesRemoved: true,
  },
};
writeFileSync(output, `${JSON.stringify({
  ...body,
  artifactDigest: sha256(canonical(body)),
}, null, 2)}\n`, { mode: 0o600 });
console.log(`focused pcc regression PASS: suites=${suiteReceipts.length} representativeTests=${totals.tests} failurePropagation=verified`);
