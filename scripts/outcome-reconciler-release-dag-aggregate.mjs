#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  canonical,
  commandDigest,
  expandedNode,
  sha256,
  topologicalOrder,
  validatePlan,
} from './outcome-reconciler-release-dag-lib.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const [runRootArgument, outputArgument] = process.argv.slice(2);
assert.ok(runRootArgument && outputArgument,
  'usage: outcome-reconciler-release-dag-aggregate.mjs RUN_ROOT OUTPUT');
const runRoot = path.resolve(runRootArgument);
const output = path.resolve(outputArgument);
const planPath = path.resolve(process.env.OUTCOME_RELEASE_DAG_PLAN_PATH
  ?? path.join(repo, 'contracts/outcome-reconciler-release-dag.json'));
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
validatePlan(plan);

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
const expanded = {
  ...plan,
  nodes: plan.nodes.map((node) => expandedNode(node, tokens)),
};
const nodes = new Map(expanded.nodes.map((node) => [node.id, node]));

function digestFile(file) {
  const raw = readFileSync(file);
  return { bytes: raw.byteLength, sha256: sha256(raw) };
}

function assertBinding(receipt) {
  for (const [field, expected] of Object.entries(binding)) {
    assert.equal(receipt.binding?.[field], expected,
      `${receipt.nodeId} has stale ${field}`);
  }
}

function validateReceipt(node) {
  const file = path.join(runRoot, 'nodes', `${node.id}.json`);
  assert.ok(existsSync(file), `${node.id} has no node receipt`);
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(receipt.nodeId, node.id);
  assert.equal(receipt.state, 'SUCCESS', `${node.id} did not succeed`);
  assert.equal(receipt.exitCode, 0, `${node.id} has a non-zero exit code`);
  assertBinding(receipt);
  assert.equal(receipt.commandDigest, commandDigest(node.command),
    `${node.id} command changed after admission`);
  assert.deepEqual(receipt.target, {
    ref: plan.target.ref,
    sha: binding.targetSha,
    receiptDigest: binding.targetReceiptDigest,
  });
  assert.ok(Date.parse(receipt.startedAt) <= Date.parse(receipt.finishedAt),
    `${node.id} has invalid timestamps`);
  assert.equal(receipt.admission.requestedTimeoutSeconds, node.timeoutSeconds);
  assert.ok(receipt.admission.effectiveTimeoutSeconds > 0
    && receipt.admission.effectiveTimeoutSeconds <= node.timeoutSeconds,
    `${node.id} has invalid effective admission`);
  assert.ok(receipt.admission.effectiveTimeoutSeconds <= 3600,
    `${node.id} exceeded the node timeout ceiling`);
  assert.equal(receipt.environmentIdentity, plan.environment.identity);
  assert.equal(receipt.evaluationPhase, plan.evaluator.phase);
  assert.equal(sha256(canonical(receipt.environment)), binding.environmentDigest,
    `${node.id} environment payload differs from its binding`);
  assert.deepEqual(receipt.resources, node.resources);
  assert.deepEqual(receipt.resourceLimits, plan.resourceLimits);
  assert.deepEqual(receipt.hostResourceEnvelope, plan.hostResourceEnvelope);
  assert.ok(receipt.toolVersions && Object.keys(receipt.toolVersions).length > 0,
    `${node.id} omitted tool versions`);
  assert.ok(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0,
    `${node.id} omitted artifact evidence`);
  for (const artifact of receipt.artifacts) {
    const snapshot = path.resolve(repo, artifact.snapshotPath);
    assert.ok(existsSync(snapshot) && statSync(snapshot).isFile(),
      `${node.id} artifact snapshot is missing`);
    assert.deepEqual(digestFile(snapshot), { bytes: artifact.bytes, sha256: artifact.sha256 },
      `${node.id} artifact snapshot digest changed`);
  }
  const log = path.resolve(repo, receipt.log.path);
  assert.ok(existsSync(log) && statSync(log).isFile(), `${node.id} log is missing`);
  assert.deepEqual(digestFile(log), { bytes: receipt.log.bytes, sha256: receipt.log.sha256 },
    `${node.id} log digest changed`);
  assert.equal(receipt.artifactDigest, sha256(canonical({
    artifacts: receipt.artifacts,
    log: receipt.log,
  })), `${node.id} evidence envelope digest changed`);
  if (node.testBearing) {
    assert.ok(receipt.testCount > 0, `${node.id} has no test denominator`);
    assert.equal(receipt.passCount, receipt.testCount, `${node.id} is not all-pass`);
    assert.equal(receipt.failCount, 0, `${node.id} reports failures`);
    assert.equal(receipt.skipCount, 0, `${node.id} reports skips`);
  }
  return { receipt, receiptDigest: sha256(canonical(receipt)) };
}

const aggregateId = 'manifest-aggregate';
const publisherId = plan.evidenceCut.publisherNodeId;
const order = topologicalOrder(expanded);
const aggregateIndex = order.indexOf(aggregateId);
assert.ok(aggregateIndex > 0, 'manifest aggregate has no predecessors');
const predecessorIds = order.slice(0, aggregateIndex);
const receiptEntries = predecessorIds.map((id) => {
  const { receipt, receiptDigest } = validateReceipt(nodes.get(id));
  return {
    nodeId: id,
    nodeKind: receipt.nodeKind,
    commandDigest: receipt.commandDigest,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    exitCode: receipt.exitCode,
    tests: receipt.testCount,
    passed: receipt.passCount,
    failed: receipt.failCount,
    skipped: receipt.skipCount,
    artifactDigest: receipt.artifactDigest,
    receiptDigest,
  };
});

const logicalTestNodes = [
  ...plan.legacyEntrypoints.map((entrypoint) => entrypoint.nodeId),
  'owner-ratification-inbox-routing',
];
const logicalReceipts = new Map(receiptEntries.map((entry) => [entry.nodeId, entry]));
const logicalSummary = logicalTestNodes.reduce((summary, id) => {
  const entry = logicalReceipts.get(id);
  assert.ok(entry, `logical matrix node ${id} is absent from the cut`);
  summary.tests += entry.tests;
  summary.passed += entry.passed;
  summary.failed += entry.failed;
  summary.skipped += entry.skipped;
  return summary;
}, { tests: 0, passed: 0, failed: 0, skipped: 0 });
assert.ok(logicalSummary.tests > 0);
assert.equal(logicalSummary.passed, logicalSummary.tests);
assert.equal(logicalSummary.failed, 0);
assert.equal(logicalSummary.skipped, 0);

const body = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-dag-manifest',
  outcome: 'PASS',
  targetRef: plan.target.ref,
  ...binding,
  environmentIdentity: plan.environment.identity,
  evaluationCommandDigest: plan.evaluator.commandDigest,
  ordering: plan.evidenceCut.ordering,
  startedAt: receiptEntries.map((entry) => entry.startedAt).sort()[0],
  finishedAt: new Date().toISOString(),
  nodeCount: receiptEntries.length,
  logicalTestNodes,
  logicalSummary,
  nodeReceipts: receiptEntries,
  nodeReceiptSetDigest: sha256(canonical(receiptEntries)),
};
const manifest = { ...body, manifestDigest: sha256(canonical(body)) };
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
