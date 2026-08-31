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
    cancelled: field('cancelled'),
    skipped: field('skipped'),
  };
}

// The failed task, typed attempt, append-only receipt, raw output and route are audit history.
const attemptRow = psql(`
SELECT termination_kind::text, actual_exit_code::text, output_truncated::text,
       btrim(failure_fingerprint::text), btrim(evaluation_plan_digest::text),
       octet_length(raw_output)::text,
       encode(digest(convert_to(raw_output,'UTF8'),'sha256'),'hex')
  FROM task_executable_attempt
 WHERE id='096973d5-dff8-41f4-afce-f3a2b835ee46'::uuid`).split('\t');
assert.deepEqual(attemptRow, [
  'EXITED',
  '1',
  'false',
  old.failureFingerprint,
  old.binding.evaluationPlanDigest,
  String(old.rawOutput.bytes),
  old.rawOutput.sha256,
]);
assert.deepEqual(psql(`SELECT status::text, terminal_reason::text,
  superseded_by_task_id::text FROM task
  WHERE id='01a05616-b60b-73e9-b696-535f278d9df5'::uuid`).split('\t'), [
  'FAILED', 'SUPERSEDED', '01a05650-3ee0-72dc-addb-439a55e0931a',
]);

const rawMarkers = [
  'full-api-shard-0',
  'full-api-shard-1',
  'full-api-shard-2',
  'full-api-shard-3',
  'interrupt-scheduling.spec.js',
  'reload-provider-env.spec.js',
  'run-finalize-lock.spec.js',
  'coordinator-context-dequeue.spec.js',
  'tx.conversationTurn.findMany is not a function',
  'args[0].join is not a function',
  old.preservedTip,
];
const markerSql = rawMarkers.map((marker) => (
  `(position('${marker.replaceAll("'", "''")}' in raw_output)>0)::text`
)).join(',');
assert.deepEqual(psql(`SELECT ${markerSql} FROM task_executable_attempt
  WHERE id='096973d5-dff8-41f4-afce-f3a2b835ee46'::uuid`).split('\t'),
Array(rawMarkers.length).fill('true'));

assert.deepEqual(psql(`
SELECT id::text, kind::text, reason_code, goal_actionable::text, status
  FROM task_executable_continuation
 WHERE id='77307d1c-03c5-415d-b17f-8709d954b3d1'::uuid`).split('\t'), [
  '77307d1c-03c5-415d-b17f-8709d954b3d1',
  'DIAGNOSIS',
  'UNEXPECTED_EXIT_OBSERVED',
  'true',
  'RESOLVED',
]);
assert.deepEqual(psql(`
SELECT id::text, kind, source, btrim(evidence_digest::text)
  FROM task_executable_diagnosis
 WHERE id='d25a7abe-dead-44f3-9bac-ff8211f08081'::uuid`).split('\t'), [
  'd25a7abe-dead-44f3-9bac-ff8211f08081',
  'UNEXPECTED_EXIT',
  'TYPED_ATTEMPT',
  'fe6015abb1a5dcd0b11c03d434e832acda26dee61651ea427152e7843296571f',
]);
assert.deepEqual(psql(`
SELECT decision_id::text, diagnostic_path, reason_code,
       btrim(canonical_reason_digest::text), btrim(decision_digest::text),
       next_action->>'allowsUnchangedRetry', next_action->>'requiresOwnerDecision'
  FROM failure_continuation_route_decision
 WHERE decision_id='c790003a-5d67-4f6d-8798-5bd9a5555bbd'::uuid`).split('\t'), [
  'c790003a-5d67-4f6d-8798-5bd9a5555bbd',
  'ALTERNATE_DIAGNOSIS',
  'TRANSIENT_EXTERNAL_EXITED',
  'bfe2fe00263c90bf08bacf35bdfac0e9d7952ecc6304447e5b4a523036b30a8c',
  old.routeDecision.decisionDigest,
  'false',
  'false',
]);
assert.deepEqual(psql(`
SELECT receipt_id::text, btrim(receipt_digest::text), btrim(output_digest::text),
       attempt_id::text
  FROM failure_continuation_attempt_receipt
 WHERE attempt_id='096973d5-dff8-41f4-afce-f3a2b835ee46'::uuid`).split('\t'), [
  '740a4129-fbfc-4bb6-b2ae-fadf09e5ce3e',
  old.receiptDigest,
  old.rawOutput.sha256,
  '096973d5-dff8-41f4-afce-f3a2b835ee46',
]);
assert.deepEqual(psql(`
SELECT source_task_id::text, successor_task_id::text, source_binding_revision::text,
       source_attempt_generation::text, binding_generation::text,
       btrim(route_decision_digest::text), btrim(binding_digest::text),
       dependency_rebind_count::text, continuation_disposition
  FROM failure_successor_handoff
 WHERE handoff_id='3a2308a9-26fc-40d4-b55f-62dd2b631568'::uuid`).split('\t'), [
  '01a05616-b60b-73e9-b696-535f278d9df5',
  '01a05650-3ee0-72dc-addb-439a55e0931a',
  '1', '1', '3', old.routeDecision.decisionDigest,
  'd00a17d6fb94721f4b2dfb0e45ae372f80bef81e2774fea21f5e7caeeba810fe',
  '0', 'RESOLVED_TO_SUCCESSOR',
]);
assert.deepEqual(psql(`
SELECT current_successor_task_id::text, binding_generation::text, btrim(binding_digest::text)
  FROM failure_successor_current_binding
 WHERE lineage_root_task_id='01a055a0-35cd-77fb-85b8-33d2042157c6'::uuid`).split('\t'), [
  '01a05650-3ee0-72dc-addb-439a55e0931a',
  '3',
  'd00a17d6fb94721f4b2dfb0e45ae372f80bef81e2774fea21f5e7caeeba810fe',
]);

const oldWorktree = '/root/.orbit/worktrees/c1360bed-d18f-58b3-b39e-187bfdabb9b6';
const oldRunRoot = path.join(oldWorktree, 'build', 'outcome-reconciler-release-dag',
  old.binding.bindingDigest);
const oldAttemptPath = path.join(oldRunRoot, 'attempt.json');
const oldAttemptEvidence = fileEvidence(oldAttemptPath);
assertEvidence(oldAttemptEvidence, { bytes: 8257, sha256: old.attemptManifestDigest },
  'old attempt manifest');
const oldAttempt = readJson(oldAttemptPath);
assert.equal(oldAttempt.outcome, 'FAIL');
assert.equal(oldAttempt.executionMode, 'FORMAL_RELEASE_DAG');
assert.equal(oldAttempt.nodeCount, 45);
assert.deepEqual(oldAttempt.failedNodes, old.failedNodes);
assert.deepEqual(oldAttempt.timedOutNodes, []);
assert.equal(oldAttempt.binding.targetSha, old.preservedTip);
assert.equal(oldAttempt.binding.bindingDigest, old.binding.bindingDigest);

const oldInventoryPath = path.join(oldRunRoot, 'full-api-inventory.json');
const oldInventoryEvidence = fileEvidence(oldInventoryPath);
assertEvidence(oldInventoryEvidence, {
  bytes: 81888,
  sha256: '00931a5902d0b9a382fa96c0ae9fed32e83feeaafb78df2da6af0eb0ea95fd5f',
}, 'old full-API inventory');
const oldInventory = readJson(oldInventoryPath);
assert.equal(oldInventory.totalSpecs, 338);
assert.equal(oldInventory.specs.length, 338);

const oldArtifactDeclarations = [
  {
    id: 'shard-0-interrupt-scheduling',
    file: path.join(oldRunRoot, 'logs', 'full-api-shard-0.log'),
    expected: { bytes: 29513, sha256: '758b844f7e1804a57ede22f5415796335b2fa62b20fddbd47b8a8026721d278b' },
    markers: ['interrupt-scheduling.spec.js', 'tx.conversationTurn.findMany is not a function'],
  },
  {
    id: 'shard-1-reload-provider-env',
    file: path.join(oldRunRoot, 'logs', 'full-api-shard-1.log'),
    expected: { bytes: 25043, sha256: '2c8ec52a78d9ffaef1dbd28223d7b7b3f32838461a19688c0c719f7cf0941d4e' },
    markers: ['reload-provider-env.spec.js', 'args[0].join is not a function'],
  },
  {
    id: 'shard-2-run-finalize-lock',
    file: path.join(oldRunRoot, 'logs', 'full-api-shard-2.log'),
    expected: { bytes: 26712, sha256: '3f4cefd26c7b5174fe6b5dc5395b32dbaf26a6679f2a6cc4eb47987933892a6f' },
    markers: ['run-finalize-lock.spec.js', 'tx.conversationTurn.findMany is not a function'],
  },
  {
    id: 'shard-3-coordinator-context-dequeue',
    file: path.join(oldRunRoot, 'logs', 'full-api-shard-3.log'),
    expected: { bytes: 43544, sha256: '38019a76657e5e1d1e9e586a55f105a728c8716ed961b50fbf495c842a47d962' },
    markers: ['coordinator-context-dequeue.spec.js', 'args[0].join is not a function'],
  },
  {
    id: 'case-148',
    file: path.join(oldRunRoot, 'full-api-cases', '0148.tap'),
    expected: { bytes: 25704, sha256: '4136c7f20463105d1ab831fc67bb333b97d2ef7c8ae1c7842e4ec3f1e88af4b4' },
    markers: ['coordinator-context-dequeue.spec.js', '# fail 18', 'args[0].join is not a function'],
  },
  {
    id: 'case-162',
    file: path.join(oldRunRoot, 'full-api-cases', '0162.tap'),
    expected: { bytes: 5625, sha256: 'fa3c9bd0d4f2ffa7fddb03e27f81e5c2389b677baee66243e33fa50829ed0dbe' },
    markers: ['reload-provider-env.spec.js', '# fail 4', 'args[0].join is not a function'],
  },
  {
    id: 'case-167',
    file: path.join(oldRunRoot, 'full-api-cases', '0167.tap'),
    expected: { bytes: 6345, sha256: 'a2c79ab718e11bbce497d80b0ba716539aa88841cd4631c2c2c301c70655f97c' },
    markers: ['run-finalize-lock.spec.js', '# fail 4', 'tx.conversationTurn.findMany is not a function'],
  },
  {
    id: 'case-209',
    file: path.join(oldRunRoot, 'full-api-cases', '0209.tap'),
    expected: { bytes: 3885, sha256: 'aa14fbe6a08b092c9036f9a0a2a97f83061f8713a24d27b70142c5574988da7a' },
    markers: ['interrupt-scheduling.spec.js', '# fail 2', 'tx.conversationTurn.findMany is not a function'],
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

// Verify the newly pushed target, merge receipt and focused repair under one fresh binding.
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
    plan.implementationInputs.digests[relative], `${relative} escaped the declared content lock`);
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
  'full-api-inventory',
]);
assert.equal(focusedAttempt.nodeCount, focusedAttempt.successfulNodes.length);
const focused = readJson(path.join(runRoot, 'regression-rebind-focused.json'));
assert.equal(focused.outcome, 'PASS');
assert.equal(focused.targetSha, targetSha);
assert.equal(focused.bindingDigest, binding.bindingDigest);
assert.equal(focused.inventory.totalSpecs, 338);
assert.equal(focused.inventory.shardCount, 4);
assert.ok(focused.api.summary.tests > 0);
assert.equal(focused.api.summary.passed, focused.api.summary.tests);
assert.equal(focused.api.summary.failed, 0);
assert.equal(focused.api.summary.cancelled, 0);
assert.equal(focused.api.summary.skipped, 0);
assert.equal(focused.api.cases.length, 19);
assert.deepEqual(focused.api.surfaceCounts, {
  dequeue: 5,
  turnComplete: 6,
  finalize: 3,
  interrupt: 6,
});
assert.ok(focused.api.cases.every((entry) => entry.summary.tests > 0));
assert.ok(focused.api.cases.every((entry) => entry.summary.failed === 0
  && entry.summary.cancelled === 0 && entry.summary.skipped === 0));
assert.ok(focused.api.cases.every((entry) => entry.cleanup.resourcesRemaining === 0));
assert.equal(new Set(focused.api.cases.map((entry) => entry.database)).size, 19);
assert.equal(new Set(focused.api.cases.map((entry) => entry.emptyDatabase)).size, 19);
assert.equal(new Set(focused.api.cases.map((entry) => entry.role)).size, 19);
assert.deepEqual(focused.terminalization, {
  ...focused.terminalization,
  taggedTemplateQueryRaw: true,
  prismaSqlQueryRaw: true,
  zeroCandidateNoWrites: true,
  steerExactTerminalReceipt: true,
  startupFragmentExactTerminalReceipt: true,
});
assert.deepEqual(focused.isolation, {
  maxConcurrentCases: 4,
  overlappingAllocatorBatches: 5,
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

const oldBindingDecision = checkpointReuseDecision({
  node: plan.nodes.find(({ id }) => id === 'full-api-shard-0'),
  binding,
  receipt: {
    nodeId: 'full-api-shard-0',
    state: 'SUCCESS',
    exitCode: 0,
    commandDigest: commandDigest(
      plan.nodes.find(({ id }) => id === 'full-api-shard-0').command,
    ),
    binding: old.binding,
  },
});
assert.deepEqual(oldBindingDecision, { reusable: false, reason: 'STALE_BINDING' });

const tapRaw = readFileSync(tapPath, 'utf8');
const structural = terminalTapSummary(tapRaw);
assert.ok(structural.tests > 0);
assert.equal(structural.passed, structural.tests);
assert.equal(structural.failed, 0);
assert.equal(structural.cancelled, 0);
assert.equal(structural.skipped, 0);
const totals = {
  tests: structural.tests + focused.api.summary.tests,
  passed: structural.passed + focused.api.summary.passed,
  failed: structural.failed + focused.api.summary.failed,
  cancelled: structural.cancelled + focused.api.summary.cancelled,
  skipped: structural.skipped + focused.api.summary.skipped,
};
assert.ok(totals.tests > 0);
assert.equal(totals.passed, totals.tests);
assert.equal(totals.failed, 0);
assert.equal(totals.cancelled, 0);
assert.equal(totals.skipped, 0);

const body = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-dag-transaction-double-rebind-manifest',
  suite: 'release-dag-current-work-transaction-double-rebind-v2',
  outcome: 'PASS',
  summary: totals,
  oldAttempt: {
    taskId: old.taskId,
    sessionId: old.sessionId,
    attemptId: old.attemptId,
    taskStatus: 'FAILED',
    terminalReason: 'SUPERSEDED',
    terminalState: 'EXITED',
    actualExitCode: 1,
    outputTruncated: false,
    failureFingerprint: old.failureFingerprint,
    receiptDigest: old.receiptDigest,
    rawOutput: old.rawOutput,
    diagnosis: {
      id: old.diagnosisId,
      kind: 'UNEXPECTED_EXIT',
      source: 'TYPED_ATTEMPT',
    },
    routeDecision: old.routeDecision,
    continuation: {
      id: old.continuationId,
      reasonCode: 'UNEXPECTED_EXIT_OBSERVED',
      status: 'RESOLVED',
    },
    successor: {
      taskId: plan.builder.taskId,
      bindingGeneration: 3,
      dependencyRebindCount: 0,
      current: true,
    },
    targetSha: old.preservedTip,
    binding: old.binding,
    bindingStatus: 'STALE',
    failedNodes: old.failedNodes,
    failureClasses: old.failureClasses,
    attemptManifest: oldAttemptEvidence,
    inventory: oldInventoryEvidence,
    machineArtifacts: oldArtifacts,
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
    targetReceiptStrict: true,
    packageLockStrict: true,
    environmentStrict: true,
    evaluationPlanStrict: true,
    dagStrict: true,
    evidenceCutStrict: true,
    tenantStrict: true,
    zeroSkipStrict: true,
    disposablePccOnly: true,
    productionDelegatesUnchanged: true,
    canonicalRouteReasonUnchanged: true,
    ownerDecisionCreated: false,
    humanSignoffCreated: false,
  },
  executionBoundary: {
    mode: focusedAttempt.executionMode,
    scheduledNodes: focusedAttempt.successfulNodes,
    completeReleaseDagExecuted: false,
    formalExecutableAttemptCreated: false,
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
