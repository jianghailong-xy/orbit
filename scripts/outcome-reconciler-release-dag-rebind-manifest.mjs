#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canonical,
  checkpointReuseDecision,
  commandDigest,
  dagPlanDigest,
  sha256,
} from './outcome-reconciler-release-dag-lib.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const [tapArgument, focusLogArgument, stateRootArgument, outputArgument] = process.argv.slice(2);
assert.ok(tapArgument && focusLogArgument && stateRootArgument && outputArgument,
  'usage: outcome-reconciler-release-dag-rebind-manifest.mjs TAP FOCUS_LOG STATE_ROOT OUTPUT');
const tapPath = path.resolve(tapArgument);
const focusLogPath = path.resolve(focusLogArgument);
const stateRoot = path.resolve(stateRootArgument);
const output = path.resolve(outputArgument);
const readJson = (relative) => JSON.parse(readFileSync(path.join(repo, relative), 'utf8'));
const plan = readJson('contracts/outcome-reconciler-release-dag.json');
const authoritative = readJson('contracts/outcome-reconciler-authoritative-target.json');
const planCheck = JSON.parse(readFileSync(path.join(stateRoot, 'plan-check.json'), 'utf8'));
const binding = JSON.parse(readFileSync(path.join(stateRoot, 'current-binding.json'), 'utf8'));
const runRoot = path.join(stateRoot, binding.bindingDigest);
const attempt = JSON.parse(readFileSync(path.join(runRoot, 'attempt.json'), 'utf8'));
const postgres = JSON.parse(readFileSync(path.join(runRoot, 'postgres-context.json'), 'utf8'));
const prisma = JSON.parse(readFileSync(path.join(runRoot, 'prisma-context.json'), 'utf8'));
const dependencies = JSON.parse(readFileSync(path.join(runRoot, 'dependency-context.json'), 'utf8'));
const preflight = JSON.parse(readFileSync(path.join(runRoot, 'preflight.json'), 'utf8'));
const tap = readFileSync(tapPath, 'utf8');
const focusLog = readFileSync(focusLogPath, 'utf8');
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function git(...args) {
  return run('git', args);
}

function isAncestor(ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result.status === 0;
}

function patchId(commit) {
  const patch = execFileSync('git', ['show', '--pretty=format:', '--binary', commit], { cwd: repo });
  const result = spawnSync('git', ['patch-id', '--stable'], {
    cwd: repo,
    input: patch,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\s+/u)[0];
}

function fileEvidence(relative) {
  const raw = readFileSync(path.join(repo, relative));
  return { path: relative, bytes: raw.byteLength, sha256: sha256(raw) };
}

function finalTapMetric(name) {
  const values = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))];
  assert.ok(values.length > 0, `TAP omitted ${name}`);
  return Number(values.at(-1)[1]);
}

function base62ToUuid(publicId) {
  let value = 0n;
  for (const character of publicId) {
    const digit = ALPHABET.indexOf(character);
    assert.notEqual(digit, -1, `invalid public id: ${publicId}`);
    value = (value * 62n) + BigInt(digit);
  }
  const hex = value.toString(16).padStart(32, '0');
  assert.equal(hex.length, 32);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)]
    .join('-');
}

function queryOrbit(sql) {
  return run('docker', [
    'exec', 'orbit-postgres', 'psql', '-U', 'orbit', '-d', 'orbit',
    '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql,
  ]);
}

const summary = {
  tests: finalTapMetric('tests'),
  passed: finalTapMetric('pass'),
  failed: finalTapMetric('fail'),
  cancelled: finalTapMetric('cancelled'),
  skipped: finalTapMetric('skipped'),
  todo: finalTapMetric('todo'),
};
assert.ok(summary.tests > 0);
assert.equal(summary.passed, summary.tests);
assert.equal(summary.failed, 0);
assert.equal(summary.cancelled, 0);
assert.equal(summary.skipped, 0);
assert.equal(summary.todo, 0);

const targetSha = git('rev-parse', 'HEAD');
const originMain = git('rev-parse', 'refs/remotes/origin/main');
const remoteMain = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/u)[0];
for (const value of [targetSha, originMain, remoteMain]) assert.match(value, SHA);
assert.equal(originMain, targetSha);
assert.equal(remoteMain, targetSha);
assert.equal(git('status', '--porcelain=v1', '--untracked-files=no'), '');
assert.equal(binding.targetSha, targetSha);
assert.equal(binding.targetReceipt.sourceSha, targetSha);
assert.equal(binding.targetReceipt.targetShaAfter, targetSha);
assert.equal(binding.targetReceipt.sourceBranch, plan.builder.sourceBranch);
assert.equal(binding.targetReceipt.recordedBy, 'AGENT');
assert.ok(plan.target.requiredReceipt.results.includes(binding.targetReceipt.result));
assert.equal(binding.targetReceiptDigest, sha256(canonical(binding.targetReceipt.proof)));

const declaredPlanDigest = dagPlanDigest(plan);
assert.equal(plan.declaredDagPlanDigest, declaredPlanDigest);
assert.equal(planCheck.dagPlanDigest, declaredPlanDigest);
assert.equal(binding.dagPlanDigest, declaredPlanDigest);
assert.equal(binding.evaluationPlanDigest, plan.evaluator.evaluationPlanDigest);
for (const field of [
  'targetReceiptDigest', 'environmentDigest', 'evaluationPlanDigest', 'dagPlanDigest',
  'evidenceCutDigest', 'bindingDigest',
]) assert.match(binding[field], DIGEST, field);

const expectedFocusedNodes = [
  'preflight-binding', 'prepare-dependencies', 'prepare-prisma', 'prepare-postgres',
];
assert.equal(attempt.executionMode, 'FOCUSED_PREPARE_POSTGRES_PREFLIGHT');
assert.equal(attempt.outcome, 'PASS');
assert.deepEqual(attempt.successfulNodes, expectedFocusedNodes);
assert.deepEqual(attempt.failedNodes, []);
assert.deepEqual(attempt.timedOutNodes, []);
assert.deepEqual(attempt.incompleteNodes, []);
assert.equal(attempt.nodeCount, expectedFocusedNodes.length);
for (const context of [preflight, dependencies, prisma, postgres]) {
  assert.equal(context.outcome, 'PASS');
  assert.equal(context.targetSha, targetSha);
  assert.equal(context.bindingDigest, binding.bindingDigest);
}
assert.doesNotMatch(focusLog, /Failed to load config file/u);
assert.doesNotMatch(focusLog, /Cannot find module 'prisma\/config'/u);

assert.equal(postgres.migrations, postgres.migrationFrontier.repositoryCount);
assert.equal(postgres.lastMigration, '0216_project_authority_envelope');
assert.equal(postgres.prismaFixture.packageLock.target.sha256,
  binding.environment.dependencies.targetPackageLock.sha256);
assert.equal(postgres.prismaFixture.packageLock.installed.sha256,
  binding.environment.dependencies.installedPackageLock.sha256);
assert.equal(postgres.prismaFixture.packages.prisma.version, '7.9.1');
assert.equal(postgres.prismaFixture.packages.client.version, '7.9.1');
assert.equal(postgres.prismaFixture.regression.reproducedBeforeRepair, true);
assert.equal(postgres.prismaFixture.regression.absentAfterRepair, true);
assert.equal(postgres.prismaFixture.generatedClient.schema.sha256,
  postgres.prismaFixture.sources.formattedFixtureSchema.sha256);
assert.equal(postgres.prismaFixture.isolation.stageRemoved, true);
const removedContainer = spawnSync('docker', ['inspect', postgres.container], {
  cwd: repo,
  encoding: 'utf8',
});
assert.notEqual(removedContainer.status, 0, 'focused disposable PostgreSQL was not removed');

const oldBinding = plan.supersededAttempt.binding;
const staleReasons = [];
for (const field of ['targetSha', 'dagPlanDigest', 'evidenceCutDigest', 'bindingDigest']) {
  if (oldBinding[field] !== binding[field]) staleReasons.push(`${field}:CHANGED`);
}
assert.ok(staleReasons.includes('targetSha:CHANGED'));
assert.ok(staleReasons.includes('dagPlanDigest:CHANGED'));
assert.ok(staleReasons.includes('evidenceCutDigest:CHANGED'));
const preflightNode = plan.nodes.find(({ id }) => id === 'preflight-binding');
assert.deepEqual(checkpointReuseDecision({
  node: preflightNode,
  binding,
  artifactsValid: true,
  receipt: {
    nodeId: preflightNode.id,
    state: 'SUCCESS',
    exitCode: 0,
    commandDigest: commandDigest(preflightNode.command),
    binding: oldBinding,
  },
}), { reusable: false, reason: 'STALE_BINDING' });

const failureTaskIds = [
  '34GBC8A6vhR6pVdPigwFU',
  '34GBC8Q012TDNY0TrFQs8',
  '34GBC8XtdyVjJkkT8kxlx',
  '34GBC8bVICSuRcT7XZht3',
];
const deliveries = failureTaskIds.map((taskId) => {
  const declared = plan.integratedDeliveries.find((delivery) => delivery.taskId === taskId);
  assert.ok(declared, taskId);
  const commits = declared.commits.map((commit, index) => {
    assert.ok(isAncestor(commit, targetSha), `${taskId}/${commit} is not in target`);
    const subject = git('show', '-s', '--format=%s', commit);
    assert.equal(subject, declared.requiredSubjects[index]);
    return { sha: commit, subject, targetAncestor: true };
  });
  const patchEquivalence = declared.patchEquivalence ? {
    ...declared.patchEquivalence,
    sourcePatchId: patchId(declared.patchEquivalence.sourceCommit),
    integratedPatchId: patchId(declared.patchEquivalence.integratedCommit),
  } : null;
  if (patchEquivalence) {
    assert.equal(patchEquivalence.sourcePatchId, patchEquivalence.stablePatchId);
    assert.equal(patchEquivalence.integratedPatchId, patchEquivalence.stablePatchId);
  }
  return { ...declared, commits, patchEquivalence };
});
assert.ok(isAncestor(plan.integrationCandidate.tip, targetSha));

const taskUuids = failureTaskIds.map(base62ToUuid);
const sessionUuids = deliveries.map((delivery) => base62ToUuid(delivery.successfulSessionId));
// The four delivered tasks and their sessions used to be re-read here together with the typed
// attempt that settled each one. Migration 0227 removed `task_executable_attempt`, so the join
// could only raise `relation does not exist`. What it was evidence FOR -- that each delivery's
// task is DONE and its session SUCCEEDED -- is read from the two relations that remain.
const taskSessionSql = `
SELECT t.id::text, t.status::text, s.id::text, s.status::text
  FROM task t
  JOIN session s ON s.task_id = t.id
 WHERE t.id IN (${taskUuids.map((id) => `'${id}'::uuid`).join(',')})
   AND s.id IN (${sessionUuids.map((id) => `'${id}'::uuid`).join(',')})
 ORDER BY t.created_at`;
const durableRows = queryOrbit(taskSessionSql).split('\n').filter(Boolean).map((line) => {
  const [taskId, taskStatus, sessionId, runStatus] = line.split('\t');
  return {
    taskDatabaseId: taskId,
    taskStatus,
    sessionDatabaseId: sessionId,
    runStatus,
  };
});
assert.equal(durableRows.length, 4);
for (const row of durableRows) {
  assert.equal(row.taskStatus, 'DONE');
  assert.equal(row.runStatus, 'SUCCEEDED');
}

assert.equal(authoritative.taskId, plan.builder.taskId);
assert.equal(authoritative.sourceBranch, plan.builder.sourceBranch);
const sourceEvidence = Object.fromEntries(plan.implementationInputs.paths.map((relative) => {
  const evidence = fileEvidence(relative);
  assert.equal(plan.implementationInputs.digests[relative], evidence.sha256, relative);
  return [relative, evidence];
}));
assert.equal(Object.keys(sourceEvidence).length, Object.keys(plan.implementationInputs.digests).length);

const cleanCloneRoot = mkdtempSync(path.join(tmpdir(), 'orbit-release-dag-rebind-clone-'));
let cleanClone;
try {
  cleanClone = path.join(cleanCloneRoot, 'checkout');
  run('git', [
    'clone', '--quiet', '--depth', '1', '--single-branch', '--branch', 'main',
    git('config', '--get', 'remote.origin.url'), cleanClone,
  ]);
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: cleanClone }), targetSha);
  assert.equal(run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: cleanClone,
  }), '');
} finally {
  rmSync(cleanCloneRoot, { recursive: true, force: true });
}

const body = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-dag-target-rebind',
  suite: 'release-dag-target-rebind-v1',
  outcome: 'PASS',
  target: {
    ref: 'refs/heads/main',
    sha: targetSha,
    originMain,
    remoteMain,
    trackedClean: true,
    cleanClone: { sha: targetSha, clean: true },
    mergeReceipt: binding.targetReceipt,
    mergeReceiptDigest: binding.targetReceiptDigest,
  },
  integratedDeliveries: deliveries,
  successfulTaskSessions: durableRows,
  binding: {
    targetSha: binding.targetSha,
    targetReceiptDigest: binding.targetReceiptDigest,
    environmentDigest: binding.environmentDigest,
    evaluationPlanDigest: binding.evaluationPlanDigest,
    dagPlanDigest: binding.dagPlanDigest,
    evidenceCutDigest: binding.evidenceCutDigest,
    bindingDigest: binding.bindingDigest,
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
  oldEvidenceCut: {
    targetSha: oldBinding.targetSha,
    bindingDigest: oldBinding.bindingDigest,
    dagPlanDigest: oldBinding.dagPlanDigest,
    evidenceCutDigest: oldBinding.evidenceCutDigest,
    status: 'STALE',
    reasons: staleReasons,
    checkpointReuseDecision: 'STALE_BINDING',
  },
  preparePostgres: {
    containerRemoved: true,
    disposable: true,
    systemIdentifier: postgres.systemIdentifier,
    version: postgres.version,
    imageId: postgres.imageId,
    migrationFrontier: postgres.migrationFrontier,
    prismaFixture: postgres.prismaFixture,
    legacyFailureFingerprintAbsentFromExecution: true,
  },
  sourceEvidence,
  summary,
  skipCount: summary.skipped,
  observationWindow: {
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    durationMilliseconds: new Date(attempt.finishedAt).getTime()
      - new Date(attempt.startedAt).getTime(),
  },
  generatedAt: new Date().toISOString(),
};
const manifest = { ...body, artifactDigest: sha256(canonical(body)) };
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  outcome: manifest.outcome,
  targetSha: manifest.target.sha,
  tests: manifest.summary.tests,
  skipCount: manifest.skipCount,
  migrations: manifest.preparePostgres.migrationFrontier.currentCount,
  bindingDigest: manifest.binding.bindingDigest,
  oldEvidenceCut: manifest.oldEvidenceCut.status,
  fullReleaseDagExecuted: manifest.plan.fullReleaseDagExecuted,
  manifest: path.relative(repo, output),
  artifactDigest: manifest.artifactDigest,
}));
