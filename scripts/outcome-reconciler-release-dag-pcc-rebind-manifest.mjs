#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  canonical,
  checkpointReuseDecision,
  commandDigest,
  dagPlanDigest,
  sha256,
  topologicalOrder,
} from './outcome-reconciler-release-dag-lib.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const [tapArgument, focusLogArgument, stateRootArgument, outputArgument] = process.argv.slice(2);
assert.ok(tapArgument && focusLogArgument && stateRootArgument && outputArgument,
  'usage: release-dag-pcc-rebind-manifest.mjs TAP FOCUS_LOG STATE_ROOT OUTPUT');
const tapPath = path.resolve(tapArgument);
const focusLogPath = path.resolve(focusLogArgument);
const stateRoot = path.resolve(stateRootArgument);
const output = path.resolve(outputArgument);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const plan = readJson(path.join(repo, 'contracts/outcome-reconciler-release-dag.json'));
const authoritative = readJson(path.join(repo, 'contracts/outcome-reconciler-authoritative-target.json'));
const frontier = readJson(path.join(repo, 'contracts/outcome-reconciler-release-frontier.json'));
const planCheck = readJson(path.join(stateRoot, 'plan-check.json'));
const targetCheck = readJson(path.join(stateRoot, 'target-check.json'));
const binding = readJson(path.join(stateRoot, 'current-binding.json'));
const runRoot = path.join(stateRoot, binding.bindingDigest);
const attempt = readJson(path.join(runRoot, 'attempt.json'));
const postgres = readJson(path.join(runRoot, 'postgres-context.json'));
const prisma = readJson(path.join(runRoot, 'prisma-context.json'));
const focus = readJson(path.join(runRoot, 'pcc-focused-regression.json'));
const tap = readFileSync(tapPath, 'utf8');
const focusLog = readFileSync(focusLogPath, 'utf8');
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 12 * 1024 * 1024,
    ...options,
  }).trim();
}

function git(...args) {
  return run('git', args);
}

function finalTapMetric(name) {
  const matches = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))];
  assert.ok(matches.length > 0, `structural TAP omitted ${name}`);
  return Number(matches.at(-1)[1]);
}

function fileEvidence(relative) {
  const raw = readFileSync(path.join(repo, relative));
  return { path: relative, bytes: raw.byteLength, sha256: sha256(raw) };
}

function queryOrbit(sql) {
  return run('docker', [
    'exec', 'orbit-postgres', 'psql', '-U', 'orbit', '-d', 'orbit',
    '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql,
  ]);
}

function extractAttempt(raw) {
  const marker = '"kind": "orbit.outcome-reconciler.release-dag-attempt"';
  const markerIndex = raw.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1, 'old raw output omitted its Release DAG attempt manifest');
  const start = raw.lastIndexOf('{', markerIndex);
  assert.notEqual(start, -1);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(raw.slice(start, index + 1));
    }
  }
  throw new Error('old raw output contains an unterminated attempt manifest');
}

const structural = {
  tests: finalTapMetric('tests'),
  passed: finalTapMetric('pass'),
  failed: finalTapMetric('fail'),
  cancelled: finalTapMetric('cancelled'),
  skipped: finalTapMetric('skipped'),
  todo: finalTapMetric('todo'),
};
assert.ok(structural.tests > 0);
assert.equal(structural.passed, structural.tests);
assert.equal(structural.failed, 0);
assert.equal(structural.cancelled, 0);
assert.equal(structural.skipped, 0);
assert.equal(structural.todo, 0);

const oldColumns = queryOrbit(`
SELECT termination_kind::text, actual_exit_code::text, output_truncated::text,
       btrim(evaluation_plan_digest::text), btrim(failure_fingerprint::text),
       octet_length(raw_output)::text, encode(convert_to(raw_output, 'UTF8'), 'hex')
  FROM task_executable_attempt
 WHERE id='76a28398-44c0-4df2-8f8c-79476d928559'::uuid
   AND task_id='01a053df-d2dd-76ac-a5ca-e0e4b02e3350'::uuid
   AND session_id='e16e542e-a24f-5306-a60e-47a93aa5c80e'::uuid`).split('\t');
assert.equal(oldColumns.length, 7, 'immutable attempt 3brMY66ZOuyYAO8BLjI83V is missing');
const [oldTermination, oldExitCode, oldTruncated, oldEvaluationPlan,
  oldFailureFingerprint, oldBytesText, oldHex] = oldColumns;
const oldRaw = Buffer.from(oldHex, 'hex');
assert.equal(oldTermination, 'EXITED');
assert.equal(Number(oldExitCode), 1);
assert.equal(oldTruncated, 'false');
assert.equal(oldEvaluationPlan, plan.supersededAttempt.binding.evaluationPlanDigest);
assert.equal(oldFailureFingerprint, plan.supersededAttempt.failureFingerprint);
assert.equal(oldRaw.byteLength, Number(oldBytesText));
assert.equal(oldRaw.byteLength, plan.supersededAttempt.rawOutput.bytes);
assert.equal(sha256(oldRaw), plan.supersededAttempt.rawOutput.sha256);
const oldText = oldRaw.toString('utf8');
const safetyMessage = 'destructive coordinator specs require a dedicated pcc_* database';
const safetyFailures = oldText.split(safetyMessage).length - 1;
assert.equal(safetyFailures, 16);
assert.ok((oldText.match(/ord_7b44df90/gu) ?? []).length >= 16);
assert.doesNotMatch(oldText, /Cannot find module 'prisma\/config'|Failed to load config file/u);
const oldAttempt = extractAttempt(oldText);
assert.equal(oldAttempt.outcome, 'FAIL');
assert.equal(oldAttempt.executionMode, 'FORMAL_RELEASE_DAG');
assert.equal(oldAttempt.binding.targetSha, '360f08f9600dc41357ced9a4872ab08ca530f681');
assert.equal(oldAttempt.binding.bindingDigest,
  '7b44df90632060c220d74c916569cfbecfd5015353fbb8c2922398e15d478f32');
assert.equal(sha256(`${JSON.stringify(oldAttempt, null, 2)}\n`),
  plan.supersededAttempt.attemptManifestDigest);
const oldFailedNodes = [
  'suite-bootstrap', 'suite-evaluator', 'suite-projection', 'suite-fact-ingress',
  'suite-auto-dispatch', 'suite-work-overview-readiness', 'suite-watchdog-111k',
  'full-api-shard-0', 'full-api-shard-1', 'full-api-shard-2', 'full-api-shard-3',
];
assert.deepEqual(oldAttempt.failedNodes, oldFailedNodes);
assert.ok(oldAttempt.successfulNodes.includes('prepare-postgres'));

const targetSha = git('rev-parse', 'HEAD');
const originMain = git('rev-parse', 'refs/remotes/origin/main');
const remoteMain = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/u)[0];
for (const value of [targetSha, originMain, remoteMain]) assert.match(value, SHA);
assert.notEqual(targetSha, plan.supersededAttempt.preservedTip);
assert.equal(originMain, targetSha);
assert.equal(remoteMain, targetSha);
assert.equal(git('status', '--porcelain=v1', '--untracked-files=no'), '');
assert.equal(targetCheck.targetSha, targetSha);
assert.equal(binding.targetSha, targetSha);
assert.equal(binding.targetReceipt.sourceSha, targetSha);
assert.equal(binding.targetReceipt.targetShaAfter, targetSha);
const staleTargetAncestor = spawnSync('git', [
  'merge-base', '--is-ancestor', plan.supersededAttempt.preservedTip, targetSha,
], { cwd: repo, encoding: 'utf8' });
assert.equal(staleTargetAncestor.status, 0, 'the immutable 360f target is not an ancestor');
assert.notEqual(binding.targetReceipt.targetShaBefore, targetSha);
assert.equal(binding.targetReceipt.sourceBranch, plan.builder.sourceBranch);
assert.equal(binding.targetReceipt.recordedBy, 'AGENT');
assert.equal(binding.targetReceiptDigest, sha256(canonical(binding.targetReceipt.proof)));

const declaredPlanDigest = dagPlanDigest(plan);
assert.equal(plan.declaredDagPlanDigest, declaredPlanDigest);
assert.equal(planCheck.dagPlanDigest, declaredPlanDigest);
assert.equal(binding.dagPlanDigest, declaredPlanDigest);
assert.equal(binding.evaluationPlanDigest, plan.evaluator.evaluationPlanDigest);
assert.equal(binding.environment.identity, plan.environment.identity);
assert.equal(binding.environment.dependencies.targetPackageLock.sha256,
  fileEvidence('package-lock.json').sha256);
assert.equal(binding.environment.dependencies.targetPackageLock.sha256,
  binding.environment.dependencies.installedPackageLock.sha256);
for (const field of [
  'targetReceiptDigest', 'environmentDigest', 'evaluationPlanDigest', 'dagPlanDigest',
  'evidenceCutDigest', 'bindingDigest',
]) assert.match(binding[field], DIGEST, field);

const focusRoots = [
  'prepare-postgres', 'prepare-build',
  'suite-bootstrap', 'suite-evaluator', 'suite-projection', 'suite-fact-ingress',
  'suite-auto-dispatch', 'suite-work-overview-readiness', 'suite-watchdog-111k',
];
const nodeById = new Map(plan.nodes.map((node) => [node.id, node]));
const selected = new Set();
function select(id) {
  if (selected.has(id)) return;
  for (const dependency of nodeById.get(id).dependsOn) select(dependency);
  selected.add(id);
}
for (const id of focusRoots) select(id);
const expectedFocusedNodes = topologicalOrder(plan).filter((id) => selected.has(id));
assert.equal(attempt.executionMode, 'FOCUSED_PCC_DATABASE_REBIND');
assert.equal(attempt.outcome, 'PASS');
assert.deepEqual(attempt.successfulNodes, expectedFocusedNodes);
assert.deepEqual(attempt.failedNodes, []);
assert.deepEqual(attempt.timedOutNodes, []);
assert.deepEqual(attempt.incompleteNodes, []);
assert.equal(attempt.nodeCount, expectedFocusedNodes.length);
assert.equal(attempt.focusedRegression.artifactDigest, focus.artifactDigest);
assert.equal(focus.outcome, 'PASS');
assert.equal(focus.releaseAttempt.digest, attempt.releaseAttempt.digest);
assert.equal(focus.bindingDigest, binding.bindingDigest);
assert.equal(focus.affectedSuites.length, 7);
assert.ok(focus.affectedSuites.every((suite) => (
  suite.tests > 0 && suite.failed === 0 && suite.skipped === 0
    && suite.passed === suite.tests
    && suite.databaseIsolation.cleanup.resourcesRemaining === 0
)));
assert.equal(new Set(focus.affectedSuites.map((suite) => suite.databaseIsolation.database)).size,
  focus.affectedSuites.length);
assert.equal(new Set(focus.affectedSuites.map((suite) => suite.databaseIsolation.role)).size,
  focus.affectedSuites.length);
assert.deepEqual(focus.representativeSpecs.map((entry) => entry.path), [
  'src/apiserver/build/agents/agent-identity-migration.pg.spec.js',
  'src/apiserver/build/agents/agent-persistence.pg.spec.js',
  'src/apiserver/build/common/transaction-retry.pg.spec.js',
]);
assert.ok(focus.representativeSummary.tests > 0);
assert.equal(focus.representativeSummary.passed, focus.representativeSummary.tests);
assert.equal(focus.representativeSummary.failed, 0);
assert.equal(focus.representativeSummary.skipped, 0);
assert.equal(focus.concurrency.uniqueDatabases, true);
assert.equal(focus.concurrency.uniqueRoles, true);
assert.equal(focus.concurrency.crossTenantAccess, false);
assert.equal(focus.concurrency.productionAccess, false);
assert.equal(focus.failurePropagation.outcome, 'EXPECTED_FAILURE_PROPAGATED');
assert.notEqual(focus.failurePropagation.exitCode, 0);
assert.ok(focus.failurePropagation.failedTests > 0);
assert.equal(focus.failurePropagation.cleanup.resourcesRemaining, 0);
assert.equal(focus.cleanup.resourcesRemaining, 0);

assert.equal(postgres.outcome, 'PASS');
assert.equal(postgres.migrations, postgres.migrationFrontier.repositoryCount);
assert.equal(postgres.beforeMigrations, postgres.migrations - 1);
assert.equal(postgres.lastMigration, '0213_failure_site_fingerprint');
assert.equal(postgres.prismaFixture.regression.reproducedBeforeRepair, true);
assert.equal(postgres.prismaFixture.regression.absentAfterRepair, true);
assert.equal(postgres.prismaFixture.isolation.stageRemoved, true);
assert.equal(prisma.outcome, 'PASS');
assert.doesNotMatch(focusLog, /Cannot find module 'prisma\/config'|Failed to load config file/u);
const removedContainer = spawnSync('docker', ['inspect', postgres.container], {
  cwd: repo, encoding: 'utf8',
});
assert.notEqual(removedContainer.status, 0, 'focused disposable PostgreSQL container survived');

const safetySource = fileEvidence('src/apiserver/src/projects/coordinator-pg-test-safety.ts');
assert.equal(safetySource.bytes, 3999);
assert.equal(safetySource.sha256,
  'ef413a9aecbcf0678f24c07b79d7001a6a6d84ab8db20967266745718b9af8cd');
const oldSafety = run('git', [
  'show', `${plan.supersededAttempt.preservedTip}:${safetySource.path}`,
]);
assert.equal(sha256(`${oldSafety}\n`), safetySource.sha256);

const oldBinding = plan.supersededAttempt.binding;
const staleReasons = [];
for (const field of ['targetSha', 'dagPlanDigest', 'evidenceCutDigest', 'bindingDigest']) {
  if (oldBinding[field] !== binding[field]) staleReasons.push(`${field}:CHANGED`);
}
assert.deepEqual(staleReasons, [
  'targetSha:CHANGED', 'dagPlanDigest:CHANGED', 'evidenceCutDigest:CHANGED',
  'bindingDigest:CHANGED',
]);
const preflight = nodeById.get('preflight-binding');
assert.deepEqual(checkpointReuseDecision({
  node: preflight,
  binding,
  artifactsValid: true,
  receipt: {
    nodeId: preflight.id,
    state: 'SUCCESS',
    exitCode: 0,
    commandDigest: commandDigest(preflight.command),
    binding: oldBinding,
  },
}), { reusable: false, reason: 'STALE_BINDING' });

assert.equal(authoritative.taskId, plan.builder.taskId);
assert.equal(authoritative.sourceBranch, plan.builder.sourceBranch);
assert.equal(frontier.task.publicId, plan.builder.taskId);
assert.equal(frontier.session.publicId, plan.builder.sessionId);
assert.equal(frontier.ownerRatification.publicId, 'wcTYTTh2pHj6myzKLXM20');
const implementationInputs = Object.fromEntries(plan.implementationInputs.paths.map((relative) => {
  const evidence = fileEvidence(relative);
  assert.equal(plan.implementationInputs.digests[relative], evidence.sha256, relative);
  return [relative, evidence];
}));
assert.equal(Object.keys(implementationInputs).length,
  Object.keys(plan.implementationInputs.digests).length);

const suiteSummary = focus.affectedSuites.reduce((summary, suite) => ({
  tests: summary.tests + suite.tests,
  passed: summary.passed + suite.passed,
  failed: summary.failed + suite.failed,
  skipped: summary.skipped + suite.skipped,
}), { tests: 0, passed: 0, failed: 0, skipped: 0 });
const summary = {
  tests: structural.tests + suiteSummary.tests + focus.representativeSummary.tests,
  passed: structural.passed + suiteSummary.passed + focus.representativeSummary.passed,
  failed: structural.failed + suiteSummary.failed + focus.representativeSummary.failed,
  skipped: structural.skipped + suiteSummary.skipped + focus.representativeSummary.skipped,
};
assert.ok(summary.tests > 0);
assert.equal(summary.passed, summary.tests);
assert.equal(summary.failed, 0);
assert.equal(summary.skipped, 0);

const body = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-dag-pcc-target-rebind',
  suite: 'release-dag-pcc-target-rebind-v1',
  outcome: 'PASS',
  summary,
  structural,
  target: {
    ref: plan.target.ref,
    sha: targetSha,
    originMain,
    remoteMain,
    trackedClean: true,
    mergeReceipt: binding.targetReceipt,
    mergeReceiptDigest: binding.targetReceiptDigest,
  },
  binding: {
    targetSha: binding.targetSha,
    targetReceiptDigest: binding.targetReceiptDigest,
    environmentDigest: binding.environmentDigest,
    evaluationPlanDigest: binding.evaluationPlanDigest,
    dagPlanDigest: binding.dagPlanDigest,
    evidenceCutDigest: binding.evidenceCutDigest,
    bindingDigest: binding.bindingDigest,
    releaseAttempt: attempt.releaseAttempt,
  },
  evaluationPlans: {
    builder: {
      taskId: plan.builder.taskId,
      commandDigest: plan.builder.commandDigest,
      evaluationPlanDigest: plan.builder.evaluationPlanDigest,
    },
    evaluator: {
      taskId: plan.evaluator.taskId,
      commandDigest: plan.evaluator.commandDigest,
      evaluationPlanDigest: plan.evaluator.evaluationPlanDigest,
    },
  },
  plan: {
    path: 'contracts/outcome-reconciler-release-dag.json',
    declaredDigest: plan.declaredDagPlanDigest,
    computedDigest: declaredPlanDigest,
    nodeCount: plan.nodes.length,
    focusedNodes: expectedFocusedNodes,
    fullReleaseDagExecuted: false,
  },
  environment: binding.environment,
  allocator: {
    name: plan.postgresIsolation.allocator,
    concurrentShardPolicy: plan.postgresIsolation.concurrentShardPolicy,
    policies: plan.postgresIsolation.nodes,
  },
  oldAttempt: {
    taskId: plan.supersededAttempt.taskId,
    sessionId: plan.supersededAttempt.sessionId,
    attemptId: plan.supersededAttempt.attemptId,
    targetSha: oldAttempt.binding.targetSha,
    terminalState: oldTermination,
    actualExitCode: Number(oldExitCode),
    outputTruncated: false,
    rawOutput: { bytes: oldRaw.byteLength, sha256: sha256(oldRaw) },
    attemptManifestDigest: plan.supersededAttempt.attemptManifestDigest,
    preparePostgresPassed: true,
    prismaConfigFingerprintAbsent: true,
    failedNodes: oldFailedNodes,
    safetyFailureMessage: safetyMessage,
    safetyFailureCount: safetyFailures,
    ordAllocatorReproduced: true,
    status: 'STALE',
    staleReasons,
    checkpointReuseDecision: 'STALE_BINDING',
  },
  safetyGate: {
    source: safetySource,
    equalsSupersededTarget: true,
    databaseStartsWithPccAssertionPresent: true,
    roleStartsWithPccAssertionPresent: true,
    deletedOrSoftened: false,
  },
  focusedRegression: focus,
  preparePostgres: {
    outcome: postgres.outcome,
    migrations: postgres.migrations,
    lastMigration: postgres.lastMigration,
    prismaRegressionAbsentAfterRepair: postgres.prismaFixture.regression.absentAfterRepair,
    disposableContainer: postgres.container,
    containerRemoved: true,
  },
  cleanup: {
    databasesAndRolesRemaining: focus.cleanup.resourcesRemaining,
    disposableContainerRemoved: true,
  },
  implementationInputs,
  ownerRatification: frontier.ownerRatification,
};
writeFileSync(output, `${JSON.stringify({
  ...body,
  artifactDigest: sha256(canonical(body)),
}, null, 2)}\n`, { mode: 0o600 });
console.log(`release-dag-pcc-rebind manifest: tests=${summary.tests} fail=0 skip=0 target=${targetSha}`);
