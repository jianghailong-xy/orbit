#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  canonical,
  checkpointReuseDecision,
  commandDigest,
  sha256,
} from './outcome-reconciler-release-dag-lib.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const [tapArgument, focusLogArgument, stateArgument, outputArgument] = process.argv.slice(2);
assert.ok(tapArgument && focusLogArgument && stateArgument && outputArgument,
  'usage: outcome-reconciler-release-dag-regression-rebind-manifest.mjs TAP FOCUS_LOG STATE OUTPUT');
const tapPath = path.resolve(tapArgument);
const focusLogPath = path.resolve(focusLogArgument);
const stateRoot = path.resolve(stateArgument);
const outputPath = path.resolve(outputArgument);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const plan = readJson(path.join(repo, 'contracts', 'outcome-reconciler-release-dag.json'));
const frontier = readJson(path.join(repo, 'contracts', 'outcome-reconciler-release-frontier.json'));
const authoritative = readJson(path.join(repo,
  'contracts', 'outcome-reconciler-authoritative-target.json'));
const old = plan.supersededAttempt;
const fileEvidence = (file) => {
  const raw = readFileSync(file);
  return { path: file, bytes: raw.byteLength, sha256: sha256(raw) };
};
const relativeEvidence = (file) => ({
  ...fileEvidence(file),
  path: path.relative(repo, file),
});

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  }).trim();
}

function psql(sql) {
  return run('docker', [
    'exec', 'orbit-postgres', 'psql', '-U', 'orbit', '-d', 'orbit',
    '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql,
  ]);
}

function assertEvidence(actual, expected, label) {
  assert.equal(actual.bytes, expected.bytes, `${label} byte count changed`);
  assert.equal(actual.sha256, expected.sha256, `${label} digest changed`);
}

function terminalTapSummary(raw) {
  const field = (name) => {
    const matches = [...raw.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))];
    assert.ok(matches.length > 0, `TAP omitted # ${name}`);
    return Number(matches.at(-1)[1]);
  };
  return {
    tests: field('tests'),
    passed: field('pass'),
    failed: field('fail'),
    skipped: field('skipped'),
  };
}

// Re-read the immutable failed executable attempt from the machine database. The full raw text
// remains in its original row; byte count + SQL-side SHA-256 prove it was neither truncated nor
// rewritten while marker booleans prove this is the expected six-node machine output.
const attemptRow = psql(`
SELECT termination_kind::text, actual_exit_code::text, output_truncated::text,
       btrim(failure_fingerprint::text), btrim(evaluation_plan_digest::text),
       octet_length(raw_output)::text,
       encode(digest(convert_to(raw_output,'UTF8'),'sha256'),'hex')
  FROM task_executable_attempt
 WHERE id='70882cfd-ba1a-4194-9a56-4f51e1ae09ce'::uuid`).split('\t');
assert.deepEqual(attemptRow, [
  'EXITED',
  '1',
  'false',
  old.failureFingerprint,
  old.binding.evaluationPlanDigest,
  String(old.rawOutput.bytes),
  old.rawOutput.sha256,
]);
assert.equal(psql(`SELECT status::text FROM task
  WHERE id='01a05538-4dfa-7049-b6cd-fdb4fdf01761'::uuid`), 'FAILED');

const rawMarkers = [
  'full-web',
  'suite-watchdog-111k',
  'full-api-shard-0',
  'full-api-shard-1',
  'full-api-shard-2',
  'full-api-shard-3',
  'tx.conversationTurn.findMany is not a function',
  'args[0].join is not a function',
  'e8308e7e933e6b8cee4f6d7f9f8edea7c60b5489',
  old.preservedTip,
  'JSON report written to /root/.orbit/worktrees/84b0f1f3-435a-550f-9a9b-ce3621f9bdb1/build/outcome-reconciler-full-web.json',
];
const markerSql = rawMarkers.map((marker) => (
  `(position('${marker.replaceAll("'", "''")}' in raw_output)>0)::text`
)).join(',');
assert.deepEqual(psql(`SELECT ${markerSql} FROM task_executable_attempt
  WHERE id='70882cfd-ba1a-4194-9a56-4f51e1ae09ce'::uuid`).split('\t'),
Array(rawMarkers.length).fill('true'));

const continuationRow = psql(`
SELECT id::text, kind::text, reason_code, goal_actionable::text, status
  FROM task_executable_continuation
 WHERE id='096cf6ca-c75a-467b-8571-ae91ba8aea60'::uuid`).split('\t');
assert.deepEqual(continuationRow, [
  '096cf6ca-c75a-467b-8571-ae91ba8aea60',
  'DIAGNOSIS',
  'UNEXPECTED_EXIT_OBSERVED',
  'true',
  'ACTIVE',
]);

const oldWorktree = '/root/.orbit/worktrees/84b0f1f3-435a-550f-9a9b-ce3621f9bdb1';
const oldRunRoot = path.join(oldWorktree, 'build', 'outcome-reconciler-release-dag',
  old.binding.bindingDigest);
const oldAttemptPath = path.join(oldRunRoot, 'attempt.json');
const oldAttemptEvidence = fileEvidence(oldAttemptPath);
assertEvidence(oldAttemptEvidence, { bytes: 8270, sha256: old.attemptManifestDigest },
  'old attempt manifest');
const oldAttempt = readJson(oldAttemptPath);
assert.equal(oldAttempt.outcome, 'FAIL');
assert.equal(oldAttempt.executionMode, 'FORMAL_RELEASE_DAG');
assert.deepEqual(oldAttempt.failedNodes, old.failedNodes);
assert.equal(oldAttempt.binding.targetSha, old.preservedTip);
assert.equal(oldAttempt.binding.bindingDigest, old.binding.bindingDigest);

const oldArtifactDeclarations = [
  {
    id: 'runner-write-lease-owner',
    file: path.join(oldRunRoot, 'logs', 'full-api-shard-0.log'),
    expected: { bytes: 24217, sha256: '40d09bc7f4ff2ba640cf3bc3f25cc80e77d0006ef8ab5d3c572269722e6bcc09' },
    markers: ['runner-write-lease-owner.spec.js', 'tx.conversationTurn.findMany is not a function'],
  },
  {
    id: 'inbox-lease-generation',
    file: path.join(oldRunRoot, 'logs', 'full-api-shard-1.log'),
    expected: { bytes: 21475, sha256: '8f7e691f55d618bb7fc8fb735b6eb35a773efbc518b7e1b788df8142de680516' },
    markers: ['inbox-lease-generation.spec.js', 'args[0].join is not a function'],
  },
  {
    id: 'project-list-rollup-audit',
    file: path.join(oldRunRoot, 'full-api-cases', '0079.tap'),
    expected: { bytes: 2813, sha256: '2a296ac3076a4aab5ab781825fc2539470fefea4ebdd4871dc1db24a83174475' },
    markers: ['project-list-rollup.audit.pg.spec.js', '9 !== 7', 'expected: 7', 'actual: 9'],
  },
  {
    id: 'project-list-rollup',
    file: path.join(oldRunRoot, 'full-api-cases', '0080.tap'),
    expected: { bytes: 4633, sha256: '9f00986b59a022304328731c997f165b723de00ea6fbf5f1dd3cf25256676bb7' },
    markers: ['project-list-rollup.pg.spec.js', '9 !== 7', 'expected: 7', 'actual: 9',
      'every bucket equals what the project page computes for the same project'],
  },
  {
    id: 'watchdog-manifest-sha',
    file: path.join(oldRunRoot, 'logs', 'suite-watchdog-111k.log'),
    expected: { bytes: 5009, sha256: '6689e6ee647ca58c6bd931633bffb15ef1f45940c623f929c5d321b92fb4560c' },
    markers: ['# tests 13', '# pass 13', '# fail 0', '# skipped 0',
      'e8308e7e933e6b8cee4f6d7f9f8edea7c60b5489', old.preservedTip],
  },
];
const oldArtifacts = oldArtifactDeclarations.map((declaration) => {
  const evidence = fileEvidence(declaration.file);
  assertEvidence(evidence, declaration.expected, declaration.id);
  const raw = readFileSync(declaration.file, 'utf8');
  for (const marker of declaration.markers) {
    assert.ok(raw.includes(marker), `${declaration.id} omitted ${marker}`);
  }
  return { id: declaration.id, ...evidence, markers: declaration.markers };
});

const oldWebPath = path.join(oldWorktree, 'build', 'outcome-reconciler-full-web.json');
const oldWebEvidence = fileEvidence(oldWebPath);
assertEvidence(oldWebEvidence, old.fullWebReport, 'old full-web report');
const oldWeb = readJson(oldWebPath);
assert.deepEqual({
  success: oldWeb.success,
  testSuites: oldWeb.numTotalTestSuites,
  passedTestSuites: oldWeb.numPassedTestSuites,
  failedTestSuites: oldWeb.numFailedTestSuites,
  tests: oldWeb.numTotalTests,
  passed: oldWeb.numPassedTests,
  failed: oldWeb.numFailedTests,
  skipped: oldWeb.numPendingTests,
}, {
  success: false,
  testSuites: old.fullWebReport.testSuites,
  passedTestSuites: old.fullWebReport.passedTestSuites,
  failedTestSuites: old.fullWebReport.failedTestSuites,
  tests: old.fullWebReport.tests,
  passed: old.fullWebReport.passed,
  failed: old.fullWebReport.failed,
  skipped: old.fullWebReport.skipped,
});
const oldReadySuite = oldWeb.testResults.find((result) =>
  result.name.endsWith('/src/web/src/components/ProjectReadyToRun.test.tsx'));
const oldReadyAssertion = oldReadySuite?.assertionResults.find((result) =>
  result.title === old.fullWebReport.failingAssertion);
assert.equal(oldReadyAssertion?.status, 'failed');
assert.equal(oldReadyAssertion?.duration, old.fullWebReport.durationMilliseconds);
assert.ok(oldReadyAssertion.failureMessages.some((message) =>
  message.includes(old.fullWebReport.failureMarker)));

// Verify the newly pushed target, merge receipt and all six focused repairs under one binding.
const targetCheck = readJson(path.join(stateRoot, 'target-check.json'));
assert.equal(targetCheck.outcome, 'PASS');
const binding = readJson(path.join(stateRoot, 'current-binding.json'));
const targetSha = run('git', ['rev-parse', 'HEAD']);
const originMain = run('git', ['rev-parse', 'origin/main']);
const remoteMain = run('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/u)[0];
assert.match(targetSha, /^[0-9a-f]{40}$/u);
assert.notEqual(targetSha, old.preservedTip);
assert.deepEqual([originMain, remoteMain, targetCheck.targetSha, binding.targetSha],
  [targetSha, targetSha, targetSha, targetSha]);
assert.equal(binding.targetReceipt.sourceSha, targetSha);
assert.equal(binding.targetReceipt.targetShaAfter, targetSha);
assert.equal(binding.targetReceipt.sourceBranch, plan.builder.sourceBranch);
assert.equal(binding.targetReceipt.recordedBy, 'AGENT');
assert.ok(['MERGED', 'ALREADY_MERGED'].includes(binding.targetReceipt.result));
assert.equal(binding.environment.identity, plan.environment.identity);
assert.equal(binding.evaluationPlanDigest, plan.evaluator.evaluationPlanDigest);
assert.equal(binding.dagPlanDigest, plan.declaredDagPlanDigest);
assert.match(binding.environmentDigest, /^[0-9a-f]{64}$/u);
assert.match(binding.evidenceCutDigest, /^[0-9a-f]{64}$/u);
assert.match(binding.bindingDigest, /^[0-9a-f]{64}$/u);
assert.notEqual(binding.bindingDigest, old.binding.bindingDigest);
assert.notEqual(binding.evidenceCutDigest, old.binding.evidenceCutDigest);
assert.equal(binding.environment.dependencies.targetPackageLock.sha256,
  plan.implementationInputs.digests['package-lock.json']);
assert.deepEqual(binding.environment.dependencies.targetPackageLock,
  binding.environment.dependencies.installedPackageLock);

for (const relative of plan.implementationInputs.paths) {
  assert.equal(sha256(readFileSync(path.join(repo, relative))),
    plan.implementationInputs.digests[relative], `${relative} escaped the declared package lock`);
}
assert.equal(frontier.task.publicId, plan.builder.taskId);
assert.equal(frontier.session.publicId, plan.builder.sessionId);
assert.equal(authoritative.taskId, plan.builderTaskId);
assert.equal(authoritative.sourceBranch, plan.builder.sourceBranch);

const runRoot = path.join(stateRoot, binding.bindingDigest);
const focusedAttempt = readJson(path.join(runRoot, 'attempt.json'));
assert.equal(focusedAttempt.outcome, 'PASS');
assert.equal(focusedAttempt.executionMode, 'FOCUSED_RELEASE_DAG_REGRESSION_REBIND');
assert.equal(focusedAttempt.automaticRetries, 0);
assert.deepEqual(focusedAttempt.failedNodes, []);
assert.deepEqual(focusedAttempt.timedOutNodes, []);
assert.deepEqual(focusedAttempt.incompleteNodes, []);
assert.deepEqual(focusedAttempt.successfulNodes, [
  'preflight-binding',
  'prepare-dependencies',
  'prepare-prisma',
  'prepare-build',
  'prepare-postgres',
  'full-web',
  'suite-acceptance-runtime',
  'suite-watchdog-111k',
]);
assert.equal(focusedAttempt.nodeCount, focusedAttempt.successfulNodes.length);
const focused = readJson(path.join(runRoot, 'regression-rebind-focused.json'));
assert.equal(focused.outcome, 'PASS');
assert.equal(focused.targetSha, targetSha);
assert.equal(focused.bindingDigest, binding.bindingDigest);
assert.deepEqual(focused.watchdog, {
  ...focused.watchdog,
  tests: 13,
  passed: 13,
  failed: 0,
  skipped: 0,
  targetSha,
  collectorSha: targetSha,
});
assert.equal(focused.watchdog.liveReleaseFence.mode, 'OFFLINE_DEV_ONLY');
assert.ok(focused.fullWeb.tests > 0);
assert.equal(focused.fullWeb.passed, focused.fullWeb.tests);
assert.equal(focused.fullWeb.failed, 0);
assert.equal(focused.fullWeb.skipped, 0);
assert.equal(focused.fullWeb.failedTestSuites, 0);
assert.equal(focused.fullWeb.oldFailingAssertionCleared, true);
assert.ok(focused.api.summary.tests > 0);
assert.equal(focused.api.summary.passed, focused.api.summary.tests);
assert.equal(focused.api.summary.failed, 0);
assert.equal(focused.api.summary.skipped, 0);
assert.equal(focused.api.cases.length, 4);
assert.ok(focused.api.cases.every((entry) => entry.cleanup.resourcesRemaining === 0));
assert.equal(new Set(focused.api.cases.map((entry) => entry.database)).size, 4);
assert.equal(new Set(focused.api.cases.map((entry) => entry.emptyDatabase)).size, 4);
assert.equal(new Set(focused.api.cases.map((entry) => entry.role)).size, 4);
assert.deepEqual(focused.rollup.bucketFields,
  ['running', 'ready', 'blocked', 'awaitingVerification', 'done', 'failed', 'cancelled']);
assert.equal(focused.rollup.indexPageParity, true);
assert.equal(focused.rollup.concurrentlyIsolated, true);
assert.deepEqual(focused.isolation, {
  allCasesStartedBeforeAwait: true,
  uniqueDatabases: true,
  uniqueEmptyDatabases: true,
  uniqueRoles: true,
  productionAccess: false,
  resourcesRemaining: 0,
});

assert.match(binding.releaseAttempt.token, /^[0-9a-f]{12}$/u);
const focusedContainer = `orbit-release-dag-pg-${binding.bindingDigest.slice(0, 12)}`;
const containerInspection = spawnSync('docker', ['inspect', focusedContainer], {
  cwd: repo,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
assert.notEqual(containerInspection.status, 0,
  'focused disposable PostgreSQL container survived cleanup');

const fullWebNode = plan.nodes.find(({ id }) => id === 'full-web');
const oldBindingDecision = checkpointReuseDecision({
  node: fullWebNode,
  binding,
  receipt: {
    nodeId: fullWebNode.id,
    state: 'SUCCESS',
    exitCode: 0,
    commandDigest: commandDigest(fullWebNode.command),
    binding: old.binding,
  },
});
assert.deepEqual(oldBindingDecision, { reusable: false, reason: 'STALE_BINDING' });

const tapRaw = readFileSync(tapPath, 'utf8');
const structural = terminalTapSummary(tapRaw);
assert.ok(structural.tests > 0);
assert.equal(structural.passed, structural.tests);
assert.equal(structural.failed, 0);
assert.equal(structural.skipped, 0);
const totals = {
  tests: structural.tests + focused.watchdog.tests + focused.fullWeb.tests
    + focused.api.summary.tests,
  passed: structural.passed + focused.watchdog.passed + focused.fullWeb.passed
    + focused.api.summary.passed,
  failed: structural.failed + focused.watchdog.failed + focused.fullWeb.failed
    + focused.api.summary.failed,
  skipped: structural.skipped + focused.watchdog.skipped + focused.fullWeb.skipped
    + focused.api.summary.skipped,
};
assert.ok(totals.tests > 0);
assert.equal(totals.passed, totals.tests);
assert.equal(totals.failed, 0);
assert.equal(totals.skipped, 0);

const body = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-dag-regression-rebind-manifest',
  suite: 'release-dag-sha-api-web-regression-rebind-v1',
  outcome: 'PASS',
  summary: totals,
  oldAttempt: {
    taskId: old.taskId,
    sessionId: old.sessionId,
    attemptId: old.attemptId,
    taskStatus: 'FAILED',
    terminalState: 'EXITED',
    actualExitCode: 1,
    outputTruncated: false,
    failureFingerprint: old.failureFingerprint,
    rawOutput: old.rawOutput,
    diagnosis: {
      id: old.diagnosisId,
      kind: 'DIAGNOSIS',
      reasonCode: 'UNEXPECTED_EXIT_OBSERVED',
      goalActionable: true,
      status: 'ACTIVE',
    },
    targetSha: old.preservedTip,
    binding: old.binding,
    bindingStatus: 'STALE',
    failedNodes: old.failedNodes,
    failureClasses: old.failureClasses,
    classificationSummary: old.classificationSummary,
    attemptManifest: oldAttemptEvidence,
    machineArtifacts: oldArtifacts,
    fullWeb: {
      ...old.fullWebReport,
      report: oldWebEvidence,
    },
  },
  frozenTarget: {
    sha: targetSha,
    sourceBranch: plan.builder.sourceBranch,
    targetBranch: 'main',
    head: targetSha,
    originMain,
    remoteMain,
    mergeReceipt: binding.targetReceipt,
  },
  binding: {
    targetSha: binding.targetSha,
    targetReceiptDigest: binding.targetReceiptDigest,
    environmentDigest: binding.environmentDigest,
    evaluationPlanDigest: binding.evaluationPlanDigest,
    dagPlanDigest: binding.dagPlanDigest,
    evidenceCutDigest: binding.evidenceCutDigest,
    bindingDigest: binding.bindingDigest,
    packageLock: binding.environment.dependencies.targetPackageLock,
    environment: binding.environment,
  },
  focusedRepair: focused,
  isolation: {
    ...focused.isolation,
    disposableContainer: focusedContainer,
    disposableContainerRemoved: true,
    productionDatabaseMutated: false,
  },
  safetyAssertions: {
    shaCurrentBindingStrict: true,
    tenantStrict: true,
    zeroSkipStrict: true,
    disposablePccOnly: true,
    ownerRatificationUnchanged: true,
    projectAcceptanceCriteriaUnchanged: true,
  },
  executionBoundary: {
    mode: focusedAttempt.executionMode,
    scheduledNodes: focusedAttempt.successfulNodes,
    completeReleaseDagExecuted: false,
    finalMatrixExecuted: false,
    productionDeployed: false,
  },
  structural: {
    summary: structural,
    tap: relativeEvidence(tapPath),
  },
  logs: {
    focused: relativeEvidence(focusLogPath),
  },
};
writeFileSync(outputPath, `${JSON.stringify({
  ...body,
  artifactDigest: sha256(canonical(body)),
}, null, 2)}\n`, { mode: 0o600 });
assert.ok(statSync(outputPath).size > 0);
