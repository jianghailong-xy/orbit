#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DIGEST,
  canonical,
  checkoutScopeDigests,
  commandDigest,
  expandedNode,
  nodeInputDigests,
  sha256,
  topologicalOrder,
  validatePlan,
} from './outcome-reconciler-release-dag-lib.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const [manifestArgument, outputArgument] = process.argv.slice(2);
assert.ok(manifestArgument && outputArgument,
  'usage: outcome-reconciler-release-dag-publish.mjs MANIFEST OUTPUT');
const manifestPath = path.resolve(manifestArgument);
const output = path.resolve(outputArgument);
const runRoot = path.resolve(process.env.OUTCOME_RELEASE_DAG_RUN_ROOT ?? '');
const planPath = path.resolve(process.env.OUTCOME_RELEASE_DAG_PLAN_PATH
  ?? path.join(repo, 'contracts/outcome-reconciler-release-dag.json'));
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
validatePlan(plan);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function required(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
}

const binding = {
  targetSha: required('OUTCOME_RELEASE_DAG_TARGET_SHA'),
  targetReceiptDigest: required('OUTCOME_RELEASE_DAG_TARGET_RECEIPT_DIGEST'),
  environmentDigest: required('OUTCOME_RELEASE_DAG_ENVIRONMENT_DIGEST'),
  evaluationPlanDigest: required('OUTCOME_RELEASE_DAG_EVALUATION_PLAN_DIGEST'),
  dagPlanDigest: required('OUTCOME_RELEASE_DAG_PLAN_DIGEST'),
  evidenceCutDigest: required('OUTCOME_RELEASE_DAG_EVIDENCE_CUT_DIGEST'),
  bindingDigest: required('OUTCOME_RELEASE_DAG_BINDING_DIGEST'),
};
const tokens = {
  RUN_ROOT: runRoot,
  TARGET_SHA: binding.targetSha,
  ENVIRONMENT_DIGEST: binding.environmentDigest,
  EVALUATION_PLAN_DIGEST: binding.evaluationPlanDigest,
  DAG_PLAN_DIGEST: binding.dagPlanDigest,
  EVIDENCE_CUT_DIGEST: binding.evidenceCutDigest,
  BINDING_DIGEST: binding.bindingDigest,
};
const nodes = new Map(plan.nodes.map((node) => {
  const expanded = expandedNode(node, tokens);
  return [expanded.id, expanded];
}));
const digestFile = (file) => {
  const raw = readFileSync(file);
  return { bytes: raw.byteLength, sha256: sha256(raw) };
};
assert.equal(manifest.outcome, 'PASS');
for (const [field, expected] of Object.entries(binding)) {
  assert.equal(manifest[field], expected, `aggregate manifest has stale ${field}`);
}
assert.equal(manifest.manifestDigest, sha256(canonical((({ manifestDigest: _, ...body }) => body)(manifest))),
  'aggregate manifest digest changed');
assert.equal(manifest.logicalSummary.failed, 0);
assert.equal(manifest.logicalSummary.skipped, 0);
assert.equal(manifest.logicalSummary.passed, manifest.logicalSummary.tests);

const publisherId = plan.evidenceCut.publisherNodeId;
const expectedReceiptIds = topologicalOrder(plan).filter((id) => id !== publisherId);
assert.equal(expectedReceiptIds.length + 1, plan.nodes.length,
  'the evidence cut must cover every declared node');
// Finer checkpoints may not buy a weaker gate. Every receipt admitted here has to be an
// observation of the input set that exists RIGHT NOW, whether it was made in this round or
// re-admitted from an earlier one: the digests are recomputed from this checkout, not read
// back out of the receipt that is being judged.
const currentInputDigests = nodeInputDigests({
  plan,
  scopeDigests: checkoutScopeDigests(plan, repo),
  environmentDigest: binding.environmentDigest,
});
const reusedNodes = [];
const receipts = expectedReceiptIds.map((nodeId) => {
  const node = nodes.get(nodeId);
  const file = path.join(runRoot, 'nodes', `${nodeId}.json`);
  assert.ok(existsSync(file), `${nodeId} receipt is absent at publication`);
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(receipt.nodeId, nodeId);
  assert.equal(receipt.state, 'SUCCESS');
  assert.equal(receipt.exitCode, 0);
  for (const [field, expected] of Object.entries(binding)) {
    assert.equal(receipt.binding?.[field], expected, `${nodeId} has stale ${field}`);
  }
  assert.equal(receipt.failCount, 0);
  assert.equal(receipt.skipCount, 0);
  assert.deepEqual(receipt.target, {
    ref: plan.target.ref,
    sha: binding.targetSha,
    receiptDigest: binding.targetReceiptDigest,
  });
  assert.equal(receipt.commandDigest, commandDigest(node.command));
  const currentInputDigest = currentInputDigests.get(nodeId)?.inputDigest;
  assert.ok(DIGEST.test(currentInputDigest ?? ''),
    `${nodeId} has no exactly determined input set at publication`);
  assert.equal(receipt.inputDigest, currentInputDigest,
    `${nodeId} was not observed under the current input set`);
  if (receipt.reuse) {
    assert.equal(node.artifactBinding, 'CONTENT_ONLY',
      `${nodeId} embeds its round binding and may not be re-admitted`);
    assert.equal(receipt.reuse.inputDigest, currentInputDigest,
      `${nodeId} was re-admitted under a different input set`);
    assert.match(receipt.reuse.observedTargetSha ?? '', /^[0-9a-f]{40}$/u);
    assert.match(receipt.reuse.observedBindingDigest ?? '', DIGEST);
    assert.match(receipt.reuse.sourceReceiptDigest ?? '', DIGEST);
    assert.notEqual(receipt.reuse.observedBindingDigest, binding.bindingDigest,
      `${nodeId} declares re-admission from the round it already belongs to`);
    reusedNodes.push({
      nodeId,
      inputDigest: currentInputDigest,
      observedTargetSha: receipt.reuse.observedTargetSha,
      observedBindingDigest: receipt.reuse.observedBindingDigest,
      sourceReceiptDigest: receipt.reuse.sourceReceiptDigest,
    });
  }
  assert.equal(sha256(canonical(receipt.environment)), binding.environmentDigest);
  assert.equal(receipt.evaluationPhase, plan.evaluator.phase);
  assert.deepEqual(receipt.resources, node.resources);
  assert.deepEqual(receipt.resourceLimits, plan.resourceLimits);
  assert.deepEqual(receipt.hostResourceEnvelope, plan.hostResourceEnvelope);
  assert.ok(Date.parse(receipt.startedAt) <= Date.parse(receipt.finishedAt));
  assert.ok(receipt.admission.effectiveTimeoutSeconds > 0
    && receipt.admission.effectiveTimeoutSeconds <= node.timeoutSeconds
    && receipt.admission.effectiveTimeoutSeconds <= 3600);
  assert.ok(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0);
  for (const artifact of receipt.artifacts) {
    const snapshot = path.resolve(repo, artifact.snapshotPath);
    assert.ok(existsSync(snapshot) && statSync(snapshot).isFile());
    assert.deepEqual(digestFile(snapshot), { bytes: artifact.bytes, sha256: artifact.sha256 });
  }
  const log = path.resolve(repo, receipt.log.path);
  assert.ok(existsSync(log) && statSync(log).isFile());
  assert.deepEqual(digestFile(log), { bytes: receipt.log.bytes, sha256: receipt.log.sha256 });
  assert.equal(receipt.artifactDigest, sha256(canonical({
    artifacts: receipt.artifacts,
    log: receipt.log,
  })));
  if (node.testBearing) {
    assert.ok(receipt.testCount > 0);
    assert.equal(receipt.passCount, receipt.testCount);
  }
  return {
    nodeId,
    receiptDigest: sha256(canonical(receipt)),
    commandDigest: receipt.commandDigest,
    inputDigest: receipt.inputDigest,
    reused: receipt.reuse !== undefined,
    artifactDigest: receipt.artifactDigest,
  };
});
const receiptCutDigest = sha256(canonical(receipts));
const body = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-dag-publication',
  outcome: 'PASS',
  writerNodeId: publisherId,
  targetRef: plan.target.ref,
  ...binding,
  environmentIdentity: plan.environment.identity,
  evaluationCommand: plan.evaluator.acceptanceCommand,
  evaluationCommandDigest: plan.evaluator.commandDigest,
  admittedAttemptTimeoutSeconds: plan.evaluator.attemptTimeoutSeconds,
  automaticRetries: plan.evaluator.automaticRetries,
  declaredNodeCount: plan.nodes.length,
  evidenceCut: {
    ordering: plan.evidenceCut.ordering,
    membership: plan.evidenceCut.membership,
    requiredNodeState: plan.evidenceCut.requiredNodeState,
    receipts,
    receiptCutDigest,
  },
  // Named, not smoothed over: a re-admitted observation is as strong as a rerun only
  // because its input set is identical, and a reader gets to check that claim.
  reuse: {
    key: plan.checkpointPolicy.reuseKey,
    reusedNodes,
    freshNodeCount: receipts.length - reusedNodes.length,
  },
  aggregateManifest: {
    path: path.relative(repo, manifestPath),
    digest: manifest.manifestDigest,
    logicalSummary: manifest.logicalSummary,
  },
  publishedAt: new Date().toISOString(),
};
const publication = { ...body, publicationDigest: sha256(canonical(body)) };
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(publication, null, 2)}\n`);
console.log(JSON.stringify(publication));
