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
const inventoryPath = path.join(runRoot, 'full-api-inventory.json');
const inventory = readJson(inventoryPath);
const caseRoot = path.join(runRoot, 'regression-focused-cases');
const logRoot = path.join(runRoot, 'regression-focused-logs');
mkdirSync(caseRoot, { recursive: true });
mkdirSync(logRoot, { recursive: true });

const inventoryReceipt = readJson(path.join(runRoot, 'nodes', 'full-api-inventory.json'));
assert.equal(inventoryReceipt.state, 'SUCCESS');
assert.equal(inventoryReceipt.exitCode, 0);
assert.equal(inventoryReceipt.binding.targetSha, binding.targetSha);
assert.equal(inventoryReceipt.binding.bindingDigest, binding.bindingDigest);
assert.equal(inventory.outcome, 'PASS');
assert.equal(inventory.targetSha, binding.targetSha);
assert.equal(inventory.bindingDigest, binding.bindingDigest);
assert.equal(inventory.totalSpecs, 338,
  'the focused audit must resolve cases from the complete 338-spec API inventory');
assert.equal(inventory.specs.length, inventory.totalSpecs);
assert.ok(inventory.parallelSpecs > 0);
assert.ok(inventory.serialSpecs > 0);

// This is the complete transaction-double surface that directly exercises dequeueTurn,
// turnComplete, finalize, interrupt/end, or terminalizeUndeliveredCurrentWork. PostgreSQL specs
// use real Prisma delegates and remain in the formal 338-case matrix instead of this fixture audit.
const requiredSpecs = [
  { surface: 'turnComplete', path: 'src/apiserver/build/runner-api/attempt-budget-turn-complete.spec.js' },
  { surface: 'dequeue', path: 'src/apiserver/build/runner-api/coordinator-context-dequeue.spec.js' },
  { surface: 'finalize', path: 'src/apiserver/build/runner-api/finalize-failed-run.spec.js' },
  { surface: 'dequeue', path: 'src/apiserver/build/runner-api/inbox-lease-generation.spec.js' },
  { surface: 'turnComplete', path: 'src/apiserver/build/runner-api/merge-source-sha.spec.js' },
  { surface: 'dequeue', path: 'src/apiserver/build/runner-api/reload-provider-env.spec.js' },
  { surface: 'finalize', path: 'src/apiserver/build/runner-api/run-finalize-lock.spec.js' },
  { surface: 'turnComplete/finalize', path: 'src/apiserver/build/runner-api/runner-write-lease-owner.spec.js' },
  { surface: 'dequeue', path: 'src/apiserver/build/runner-api/setconfig-dequeue.spec.js' },
  { surface: 'dequeue', path: 'src/apiserver/build/runner-api/steer-dequeue.spec.js' },
  { surface: 'turnComplete', path: 'src/apiserver/build/runner-api/steer-requeue.spec.js' },
  { surface: 'turnComplete', path: 'src/apiserver/build/runner-api/steer-turn-complete.spec.js' },
  { surface: 'turnComplete', path: 'src/apiserver/build/runner-api/turn-complete-scheduling.spec.js' },
  { surface: 'interrupt/terminalization', path: 'src/apiserver/build/sessions/current-work-delivery.spec.js' },
  { surface: 'interrupt/end', path: 'src/apiserver/build/sessions/end-scheduling.spec.js' },
  { surface: 'interrupt', path: 'src/apiserver/build/sessions/interrupt-and-send.spec.js' },
  { surface: 'interrupt', path: 'src/apiserver/build/sessions/interrupt-scheduling.spec.js' },
  { surface: 'interrupt/lifecycle', path: 'src/apiserver/build/sessions/session-lifecycle-transaction.spec.js' },
  { surface: 'interrupt', path: 'src/apiserver/build/sessions/turn-error-contract.spec.js' },
];
assert.equal(new Set(requiredSpecs.map(({ path: spec }) => spec)).size, requiredSpecs.length);

const inventoryByPath = new Map(inventory.specs.map((entry) => [entry.path, entry]));
const cases = requiredSpecs.map((required) => {
  const entry = inventoryByPath.get(required.path);
  assert.ok(entry, `focused transaction-double spec omitted from inventory: ${required.path}`);
  assert.equal(entry.class, 'parallel', `${required.path} unexpectedly left the parallel partition`);
  return {
    ...required,
    index: entry.index,
    shard: (entry.index - 1) % inventory.shardCount,
    bytes: entry.bytes,
    sha256: entry.sha256,
  };
});
assert.equal(cases.length, 19);
assert.equal(new Set(cases.map(({ index }) => index)).size, cases.length);

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
  OUTCOME_API_CASE_TOTAL: String(inventory.totalSpecs),
};

function runCase(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [
      path.join(repo, 'scripts', 'outcome-reconciler-full-api-case.sh'),
      String(entry.index), path.join(repo, entry.path),
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
        reject(new Error(`focused API case ${entry.path} exited code=${code} signal=${signal ?? 'none'}\n${raw.toString('utf8')}`));
        return;
      }
      resolve({ ...entry, log });
    });
  });
}

// Match the formal scheduler's four-case ceiling while still exercising allocator overlap.
const completedCases = [];
for (let offset = 0; offset < cases.length; offset += inventory.shardCount) {
  completedCases.push(...await Promise.all(
    cases.slice(offset, offset + inventory.shardCount).map((entry) => runCase(entry)),
  ));
}

const oldFingerprints = [
  'args[0].join is not a function',
  'tx.conversationTurn.findMany is not a function',
];
const receipts = completedCases.map((entry) => {
  const stem = String(entry.index).padStart(4, '0');
  const receipt = readJson(path.join(caseRoot, `${stem}.json`));
  const launcherRaw = readFileSync(entry.log, 'utf8');
  const tapPath = path.join(caseRoot, `${stem}.tap`);
  const tapRaw = readFileSync(tapPath, 'utf8');
  assert.equal(receipt.outcome, 'PASS');
  assert.equal(receipt.spec.path, entry.path);
  assert.equal(receipt.spec.bytes, entry.bytes);
  assert.equal(receipt.spec.sha256, entry.sha256);
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
  for (const fingerprint of oldFingerprints) {
    assert.ok(!tapRaw.includes(fingerprint), `${entry.path} retained ${fingerprint}`);
    assert.ok(!launcherRaw.includes(fingerprint), `${entry.path} launcher retained ${fingerprint}`);
  }
  return {
    entry,
    receipt,
    tapRaw,
    tap: { bytes: Buffer.byteLength(tapRaw), sha256: sha256(tapRaw) },
    launcherLog: { bytes: Buffer.byteLength(launcherRaw), sha256: sha256(launcherRaw) },
  };
});

const delivery = receipts.find(({ entry }) =>
  entry.path.endsWith('/sessions/current-work-delivery.spec.js'));
assert.ok(delivery);
for (const title of [
  'the raw-query double renders a tagged-template call with its separate bindings',
  'the raw-query double renders a composed Prisma.Sql object with embedded bindings',
  'zero CURRENT_WORK candidates perform both reads and no receipt writes',
  'steer and startup candidates receive their exact terminal receipts together',
]) assert.ok(delivery.tapRaw.includes(title), `terminalization TAP omitted: ${title}`);

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
  cancelled: summary.cancelled + receipt.summary.cancelled,
  skipped: summary.skipped + receipt.summary.skipped,
}), { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0 });
assert.ok(apiSummary.tests > 0);
assert.equal(apiSummary.passed, apiSummary.tests);
assert.equal(apiSummary.failed, 0);
assert.equal(apiSummary.cancelled, 0);
assert.equal(apiSummary.skipped, 0);

const surfaceCounts = Object.fromEntries(['dequeue', 'turnComplete', 'finalize', 'interrupt']
  .map((surface) => [surface, cases.filter((entry) => entry.surface.includes(surface)).length]));
for (const count of Object.values(surfaceCounts)) assert.ok(count > 0);

const inventoryRaw = readFileSync(inventoryPath);
const body = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-dag-transaction-double-focused-run',
  suite: 'release-dag-current-work-transaction-double-rebind-v2',
  outcome: 'PASS',
  targetSha: binding.targetSha,
  bindingDigest: binding.bindingDigest,
  releaseAttempt: binding.releaseAttempt,
  inventory: {
    totalSpecs: inventory.totalSpecs,
    parallelSpecs: inventory.parallelSpecs,
    serialSpecs: inventory.serialSpecs,
    shardCount: inventory.shardCount,
    path: path.relative(repo, inventoryPath),
    bytes: inventoryRaw.byteLength,
    sha256: sha256(inventoryRaw),
  },
  api: {
    summary: apiSummary,
    surfaceCounts,
    cases: receipts.map(({ entry, receipt, tap, launcherLog }) => ({
      surface: entry.surface,
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
      oldFingerprintsCleared: oldFingerprints,
    })),
  },
  terminalization: {
    taggedTemplateQueryRaw: true,
    prismaSqlQueryRaw: true,
    zeroCandidateNoWrites: true,
    steerExactTerminalReceipt: true,
    evidenceSpec: delivery.entry.path,
    tests: delivery.receipt.summary.tests,
  },
  isolation: {
    maxConcurrentCases: inventory.shardCount,
    overlappingAllocatorBatches: Math.ceil(cases.length / inventory.shardCount),
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
console.log(`release-dag transaction-double focus PASS: cases=${cases.length} tests=${apiSummary.tests} target=${binding.targetSha}`);
