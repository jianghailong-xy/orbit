import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  checkpointReuseDecision,
  commandDigest,
  dagPlanDigest,
  deriveBinding,
} from '../scripts/outcome-reconciler-release-dag-lib.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const plan = readJson('contracts/outcome-reconciler-release-dag.json');
const authoritative = readJson('contracts/outcome-reconciler-authoritative-target.json');
const frontier = readJson('contracts/outcome-reconciler-release-frontier.json');
const packageJson = readJson('package.json');

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function isAncestor(ancestor, descendant = 'HEAD') {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result.status === 0;
}

function patchId(commit) {
  const patch = execFileSync('git', ['show', '--pretty=format:', '--binary', commit], {
    cwd: repo,
  });
  const result = spawnSync('git', ['patch-id', '--stable'], {
    cwd: repo,
    input: patch,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\s+/u)[0];
}

function sha256File(relative) {
  return createHash('sha256').update(readFileSync(path.join(repo, relative))).digest('hex');
}

test('the candidate tip contains all four successful Failure Continuation deliveries once', () => {
  const taskIds = [
    '34GBC8A6vhR6pVdPigwFU',
    '34GBC8Q012TDNY0TrFQs8',
    '34GBC8XtdyVjJkkT8kxlx',
    '34GBC8bVICSuRcT7XZht3',
  ];
  assert.equal(plan.integrationCandidate.tip,
    'cb42e0d4498fbe5f420ff6597cde237eb9aa8442');
  assert.equal(plan.integrationCandidate.duplicateCherryPicks, false);
  assert.ok(isAncestor(plan.integrationCandidate.requiredBase, plan.integrationCandidate.tip));
  assert.ok(isAncestor(plan.integrationCandidate.tip));
  const deliveries = taskIds.map((taskId) => (
    plan.integratedDeliveries.find((delivery) => delivery.taskId === taskId)
  ));
  assert.ok(deliveries.every(Boolean));
  assert.equal(new Set(deliveries.flatMap((delivery) => delivery.commits)).size,
    deliveries.flatMap((delivery) => delivery.commits).length);
  for (const delivery of deliveries) {
    assert.match(delivery.successfulSessionId, /^[0-9A-Za-z]+$/u);
    assert.match(delivery.validatedTargetSha, /^[0-9a-f]{40}$/u);
    assert.match(delivery.resultDigest, /^[0-9a-f]{64}$/u);
    for (const [index, commit] of delivery.commits.entries()) {
      assert.ok(isAncestor(commit));
      assert.equal(git('show', '-s', '--format=%s', commit), delivery.requiredSubjects[index]);
    }
    if (delivery.patchEquivalence) {
      assert.equal(patchId(delivery.patchEquivalence.sourceCommit),
        delivery.patchEquivalence.stablePatchId);
      assert.equal(patchId(delivery.patchEquivalence.integratedCommit),
        delivery.patchEquivalence.stablePatchId);
    }
  }
  assert.equal(deliveries.at(-1).validatedTargetSha, plan.integrationCandidate.tip);
});

test('the formal prepare-postgres node uses only the target-lock-isolated Prisma fixture', () => {
  const prepare = read('scripts/outcome-reconciler-release-dag-prepare.sh');
  const fixture = read('scripts/outcome-reconciler-release-dag-prisma-fixture.mjs');
  const step = read('scripts/outcome-reconciler-release-dag-step.mjs');
  assert.match(prepare, /outcome-reconciler-release-dag-prisma-fixture\.mjs/u);
  assert.match(prepare, /cd "\$STAGE_API".*node node_modules\/prisma\/build\/index\.js/su);
  assert.doesNotMatch(prepare, /cd "\$STAGE".*\$API\/node_modules/su);
  assert.match(fixture, /installed dependency checkout does not match target package-lock\.json/u);
  assert.match(fixture, /Cannot find module 'prisma\\\/config'/u);
  assert.match(fixture, /runtimeResolutionUsesInstalledRoot: false/u);
  assert.match(fixture, /generated Prisma Client is not bound to the target schema/u);
  assert.match(step, /prismaFixture\.regression\.reproducedBeforeRepair/u);
  assert.match(step, /prismaFixture\.regression\.absentAfterRepair/u);
});

test('the focused builder cannot schedule the full Release DAG matrix', () => {
  const runner = read('scripts/outcome-reconciler-release-dag.mjs');
  const harness = read('scripts/outcome-reconciler-release-dag-rebind.sh');
  assert.match(runner, /--focus-prepare-postgres/u);
  assert.match(runner, /includeWithDependencies\('prepare-postgres'\)/u);
  assert.match(runner, /FOCUSED_PREPARE_POSTGRES_PREFLIGHT/u);
  assert.match(harness, /--focus-prepare-postgres/u);
  assert.doesNotMatch(harness, /npm run test:outcome-reconciler:release-dag(?:\s|$)/u);
});

test('the fa29 binding and evidence cut are explicitly stale under the new plan', () => {
  const old = plan.supersededAttempt.binding;
  assert.equal(old.targetSha, 'fa29dbef903ddf19905c5a5f60e9ca2931cff6e7');
  assert.equal(old.dagPlanDigest,
    '7826b4d221447aca1fb0a46da4d8ba5d2056a7693534050ccaa577af1ee58076');
  assert.equal(old.evidenceCutDigest,
    '48730fb099ed8cd59f63e6a1b1da628e1cde3ea731f0a99b8622740beedcb13b');
  assert.notEqual(dagPlanDigest(plan), old.dagPlanDigest);
  const current = deriveBinding({
    plan,
    targetSha: git('rev-parse', 'HEAD'),
    targetReceiptDigest: 'a'.repeat(64),
    environment: { identity: 'focused-rebind-test' },
  });
  assert.notEqual(current.targetSha, old.targetSha);
  assert.notEqual(current.dagPlanDigest, old.dagPlanDigest);
  assert.notEqual(current.evidenceCutDigest, old.evidenceCutDigest);
  assert.notEqual(current.bindingDigest, old.bindingDigest);
  const node = plan.nodes.find(({ id }) => id === 'preflight-binding');
  const decision = checkpointReuseDecision({
    node,
    binding: current,
    artifactsValid: true,
    receipt: {
      nodeId: node.id,
      state: 'SUCCESS',
      exitCode: 0,
      commandDigest: commandDigest(node.command),
      binding: old,
    },
  });
  assert.deepEqual(decision, { reusable: false, reason: 'STALE_BINDING' });
});

test('the new builder, successor evaluator and implementation inputs are frozen exactly', () => {
  assert.equal(plan.builder.taskId, '34GG81QJ2G1b5USb00rPS');
  assert.equal(plan.builder.sessionId, '4LeiBLaxefRdW21bdsTEFR');
  assert.equal(plan.builder.sourceBranch, 'orbit/release-dag-prisma-target-4063c0');
  assert.equal(plan.evaluator.taskId, '34GG81bW8miI0nbxFDqN6');
  assert.equal(plan.evaluator.automaticRetries, 0);
  assert.equal(authoritative.taskId, plan.builder.taskId);
  assert.equal(authoritative.sourceBranch, plan.builder.sourceBranch);
  assert.equal(frontier.task.publicId, plan.builder.taskId);
  assert.equal(frontier.session.publicId, plan.builder.sessionId);
  assert.equal(frontier.postgres.minimumMigrations, 220);
  assert.equal(packageJson.scripts['test:outcome-reconciler:release-dag-rebind'],
    'bash scripts/outcome-reconciler-release-dag-rebind.sh');
  assert.equal(plan.implementationInputs.paths.length,
    Object.keys(plan.implementationInputs.digests).length);
  for (const relative of plan.implementationInputs.paths) {
    assert.equal(plan.implementationInputs.digests[relative], sha256File(relative), relative);
  }
  assert.equal(plan.declaredDagPlanDigest, dagPlanDigest(plan));
});

test('the current migration frontier is complete without changing owner ratification', () => {
  const migrations = readdirSync(path.join(repo, 'src/apiserver/prisma/migrations'), {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.equal(migrations.length, 220);
  assert.equal(migrations.at(-1), '0212_failure_successor_handoff');
  assert.equal(frontier.ownerRatification.publicId, 'wcTYTTh2pHj6myzKLXM20');
  assert.equal(frontier.ownerRatification.contractDigest,
    '038956112d061ea7b3b0e2b9e94b6a7349af2fd3c7ca5d126b669174758bc903');
  assert.equal(frontier.ownerRatification.evaluationPlanDigest,
    'c05e07633d01b7fe1f3a7a92af931656d439a09b8484d93e03493c68b10b5e9e');
});
