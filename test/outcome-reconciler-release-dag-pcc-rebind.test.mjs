import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  fullApiCaseIdentity,
  nodeDatabaseIdentity,
} from '../scripts/outcome-reconciler-release-dag-database.mjs';
import { dagPlanDigest, validatePlan } from '../scripts/outcome-reconciler-release-dag-lib.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const plan = readJson('contracts/outcome-reconciler-release-dag.json');
const authoritative = readJson('contracts/outcome-reconciler-authoritative-target.json');
const frontier = readJson('contracts/outcome-reconciler-release-frontier.json');
const packageJson = readJson('package.json');
const bindingDigest = '7'.repeat(64);
const attemptToken = '8'.repeat(12);

test('the pcc repair is bound to this builder and its one declared successor', () => {
  assert.equal(plan.builder.taskId, '34GPMWXHBT6PcxQ4KV3qO');
  assert.equal(plan.builder.sessionId, '2dYsqAzyq3NF0dM96npo3N');
  assert.equal(plan.builder.sourceBranch, 'orbit/release-dag-target-bc59f8');
  assert.equal(plan.builder.acceptanceCommand,
    'npm run test:outcome-reconciler:release-dag-pcc-rebind');
  assert.equal(plan.builder.commandDigest,
    '2a4c7402bf8b7adb6c692ce0eee4a046c61ada8c5354d06038fe3726e6ce3330');
  assert.equal(plan.builder.evaluationPlanDigest,
    '44b25cad5d9c9a0926cfda911b667ff728fd59b34a9123856873ddb20b60d4eb');
  assert.equal(plan.evaluator.taskId, '34GPMWmm6WxUjmxCYvLxh');
  assert.equal(plan.evaluator.automaticRetries, 0);
  assert.equal(authoritative.taskId, plan.builder.taskId);
  assert.equal(frontier.task.publicId, plan.builder.taskId);
  assert.equal(frontier.session.publicId, plan.builder.sessionId);
  assert.equal(packageJson.scripts['test:outcome-reconciler:release-dag-pcc-rebind'],
    'bash scripts/outcome-reconciler-release-dag-pcc-rebind.sh');
});

test('the superseded formal attempt remains EXITED 1 with the exact old binding', () => {
  assert.deepEqual({
    taskId: plan.supersededAttempt.taskId,
    sessionId: plan.supersededAttempt.sessionId,
    attemptId: plan.supersededAttempt.attemptId,
    target: plan.supersededAttempt.preservedTip,
    terminalState: plan.supersededAttempt.terminalState,
    actualExitCode: plan.supersededAttempt.actualExitCode,
    safetyFailureCount: plan.supersededAttempt.safetyFailureCount,
    rawOutputBytes: plan.supersededAttempt.rawOutput.bytes,
    rawOutputDigest: plan.supersededAttempt.rawOutput.sha256,
  }, {
    taskId: '34GG81bW8miI0nbxFDqN6',
    sessionId: '6rNh1hXjWnzeainpXADY90',
    attemptId: '3brMY66ZOuyYAO8BLjI83V',
    target: '360f08f9600dc41357ced9a4872ab08ca530f681',
    terminalState: 'EXITED',
    actualExitCode: 1,
    safetyFailureCount: 16,
    rawOutputBytes: 1358580,
    rawOutputDigest: 'bd90e9d5257bb47a338a2888503fa58dc4cbc83204c87ab22019f3935d9252cd',
  });
  assert.equal(plan.supersededAttempt.binding.bindingDigest,
    '7b44df90632060c220d74c916569cfbecfd5015353fbb8c2922398e15d478f32');
  assert.equal(plan.supersededAttempt.binding.dagPlanDigest,
    '428f9127a48f56edbc856e49761a35107c8e8fa8892906755866f46d9c6e9b75');
  assert.equal(plan.supersededAttempt.binding.evidenceCutDigest,
    '878e3c8b7abc4a7fefc92b6f62858ed861785fdf547ce37d94be5a77bb1a372a');
  assert.equal(plan.supersededAttempt.evidenceReuse, 'NONE');
});

test('the destructive coordinator safety gate is byte-for-byte unchanged', () => {
  const raw = readFileSync(path.join(
    repo, 'src/apiserver/src/projects/coordinator-pg-test-safety.ts',
  ));
  assert.equal(raw.byteLength, 3999);
  assert.equal(createHash('sha256').update(raw).digest('hex'),
    'ef413a9aecbcf0678f24c07b79d7001a6a6d84ab8db20967266745718b9af8cd');
  const source = raw.toString('utf8');
  assert.match(source,
    /assert\.match\(database, \/\^pcc\[0-9a-z\]\*\[_-\]\/, 'destructive coordinator specs require a dedicated pcc_\* database'\)/u);
  assert.match(source,
    /assert\.match\(user, \/\^pcc\[0-9a-z\]\*\[_-\]\/, 'destructive coordinator specs require a dedicated pcc_\* role'\)/u);
});

test('every PostgreSQL DAG node has an exact disposable database and role policy', () => {
  const validation = validatePlan(plan);
  assert.equal(plan.declaredDagPlanDigest, dagPlanDigest(plan));
  assert.equal(validation.order.length, plan.nodes.length);
  assert.equal(plan.postgresIsolation.allocator,
    'ATTEMPT_BOUND_NODE_AND_CASE_DISPOSABLE_DATABASE_ROLE_V2');
  assert.equal(plan.postgresIsolation.concurrentShardPolicy,
    'UNIQUE_DATABASE_AND_ROLE_PER_GLOBAL_CASE_INDEX');
  const postgresNodes = plan.nodes.filter((node) => node.usesSharedPostgres);
  assert.equal(Object.keys(plan.postgresIsolation.nodes).length, postgresNodes.length);
  const identities = postgresNodes.map((node) => {
    const policy = plan.postgresIsolation.nodes[node.id];
    const identity = nodeDatabaseIdentity({
      node: { ...node, ...policy }, bindingDigest, attemptToken,
    });
    assert.match(identity.database, new RegExp(`^${policy.postgresDatabasePrefix}_`, 'u'));
    assert.match(identity.role, new RegExp(`^${policy.postgresRolePrefix}_`, 'u'));
    assert.match(identity.database, /_b77777777_a888888888888_/u);
    assert.match(identity.role, /_b77777777_a888888888888_/u);
    if (policy.destructiveCoordinatorSpecs) {
      assert.match(identity.database, /^pcc[0-9a-z]*_/u);
      assert.match(identity.role, /^pcc[0-9a-z]*_/u);
    }
    return identity;
  });
  assert.equal(new Set(identities.map(({ database }) => database)).size, identities.length);
  assert.equal(new Set(identities.map(({ role }) => role)).size, identities.length);
  assert.equal(plan.postgresIsolation.nodes['suite-evaluator'].postgresDatabasePrefix, 'pceval');
  assert.equal(plan.postgresIsolation.nodes['suite-projection'].postgresDatabasePrefix,
    'pcprojection');
  assert.equal(plan.postgresIsolation.nodes['suite-fact-ingress'].postgresDatabasePrefix,
    'pccfact');
  assert.equal(plan.postgresIsolation.nodes['suite-auto-dispatch'].postgresDatabasePrefix,
    'orbit_auto_dispatch');
  assert.equal(plan.postgresIsolation.nodes['suite-watchdog-111k'].postgresDatabasePrefix,
    'pcwatchdog');
});

test('337 Full API identities are pcc, attempt-bound and globally disjoint', () => {
  const identities = Array.from({ length: 337 }, (_, offset) => {
    const caseIndex = offset + 1;
    const partitionClass = caseIndex > 330 ? 'serial' : 'parallel';
    const partitionIndex = partitionClass === 'serial' ? 0 : offset % 4;
    const identity = fullApiCaseIdentity({
      bindingDigest, attemptToken, partitionClass, partitionIndex, caseIndex,
    });
    for (const value of Object.values(identity)) {
      assert.match(value, /^pcc[0-9a-z]*_/u);
      assert.match(value, /_b77777777_a888888888888_/u);
      assert.doesNotMatch(value, /(^|_)orbit(_|$)/u);
    }
    return identity;
  });
  for (const field of ['database', 'emptyDatabase', 'role']) {
    assert.equal(new Set(identities.map((identity) => identity[field])).size, identities.length);
  }
});

test('the focused harness covers affected suites, representative specs and failure cleanup', () => {
  const runner = read('scripts/outcome-reconciler-release-dag.mjs');
  const focus = read('scripts/outcome-reconciler-release-dag-pcc-focus.mjs');
  const caseRunner = read('scripts/outcome-reconciler-full-api-case.sh');
  const harness = read('scripts/outcome-reconciler-release-dag-pcc-rebind.sh');
  for (const id of [
    'suite-bootstrap', 'suite-evaluator', 'suite-projection', 'suite-fact-ingress',
    'suite-auto-dispatch', 'suite-work-overview-readiness', 'suite-watchdog-111k',
  ]) assert.match(focus, new RegExp(`'${id}'`, 'u'));
  for (const spec of [
    'agent-identity-migration.pg.spec.js',
    'agent-persistence.pg.spec.js',
    'transaction-retry.pg.spec.js',
  ]) assert.match(focus, new RegExp(spec.replaceAll('.', '\\.'), 'u'));
  assert.match(runner, /--focus-pcc-rebind/u);
  assert.match(focus, /EXPECTED_FAILURE_PROPAGATED/u);
  assert.match(caseRunner, /trap 'cleanup_case \$\?' EXIT/u);
  assert.match(caseRunner, /DROP DATABASE IF EXISTS/u);
  assert.match(caseRunner, /DROP ROLE IF EXISTS/u);
  assert.match(caseRunner, /COORDINATOR_PG_EXPECTED_DATABASE="\$CASE_DB"/u);
  assert.match(caseRunner, /COORDINATOR_PG_EXPECTED_USER="\$CASE_ROLE"/u);
  assert.doesNotMatch(harness, /npm run test:outcome-reconciler:release-dag(?:\s|$)/u);
});

test('package lock and owner ratification remain frozen', () => {
  assert.equal(frontier.ownerRatification.publicId, 'wcTYTTh2pHj6myzKLXM20');
  assert.equal(frontier.ownerRatification.contractDigest,
    '038956112d061ea7b3b0e2b9e94b6a7349af2fd3c7ca5d126b669174758bc903');
  assert.equal(frontier.ownerRatification.evaluationPlanDigest,
    'c05e07633d01b7fe1f3a7a92af931656d439a09b8484d93e03493c68b10b5e9e');
  assert.equal(createHash('sha256').update(readFileSync(path.join(repo, 'package-lock.json')))
    .digest('hex'), '50bc5c50f24724a9860ae8cad2fe5cfc55d4297bd79dca7cdd3bf7608642887c');
});
