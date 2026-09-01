#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DIGEST,
  SHA,
  TERMINATION_TYPES,
  UUID,
  addResources,
  canonical,
  checkoutScopeDigests,
  checkpointReuseDecision,
  commandDigest,
  deriveBinding,
  expandedNode,
  metricsForNode,
  nodeInputDigests,
  resourceFits,
  sha256,
  topologicalOrder,
  validatePlan,
} from './outcome-reconciler-release-dag-lib.mjs';
import {
  readCheckpoint,
  readmitCheckpoint,
  writeCheckpoint,
} from './outcome-reconciler-release-dag-checkpoints.mjs';
import {
  deriveReleaseAttemptIdentity,
  nodeDatabaseIdentity,
} from './outcome-reconciler-release-dag-database.mjs';
import { guardDisposableResources } from './outcome-reconciler-release-dag-disposable.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const processStartedAtMs = Date.now();
const planPath = path.resolve(process.env.OUTCOME_RELEASE_DAG_PLAN
  ?? path.join(repo, 'contracts/outcome-reconciler-release-dag.json'));
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const validation = validatePlan(plan);

// Whoever drives a retry names what stopped the attempts before it. Checked here, beside
// the plan's own admission, so an attempt past the declared ceiling costs nothing either.
const priorTerminations = (process.env.OUTCOME_RELEASE_DAG_PRIOR_TERMINATIONS ?? '')
  .split(',').map((entry) => entry.trim()).filter(Boolean);
assert.ok(priorTerminations.every((type) => TERMINATION_TYPES.includes(type)),
  'a prior attempt termination must be one of the declared termination types');
assert.ok(priorTerminations.length <= plan.evaluator.retryBudgets.maxTotalAutomaticRetries,
  'this attempt is past the declared automatic retry ceiling');

function run(file, args, { allowFailure = false } = {}) {
  const result = spawnSync(file, args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    killSignal: 'SIGKILL',
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

function git(...args) {
  return run('git', args).stdout;
}

function atomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function fileDigest(file) {
  const raw = readFileSync(file);
  return { bytes: raw.byteLength, sha256: sha256(raw) };
}

function relativeToRepo(file) {
  const relative = path.relative(repo, file);
  return relative.startsWith('..') ? file : relative;
}

function resolveFromRepo(file) {
  return path.isAbsolute(file) ? file : path.join(repo, file);
}

function inspectEnvironment() {
  assert.equal(process.platform, plan.environment.platform,
    'host platform differs from the Release DAG environment contract');
  const versions = {};
  for (const [name, command] of Object.entries(plan.environment.versionCommands)) {
    const observed = run(command[0], command.slice(1), { allowFailure: true });
    if (observed.status !== 0) {
      throw new Error(`required environment probe failed (${name}): ${observed.stderr}`);
    }
    versions[name] = observed.stdout;
  }
  let publicOrigin = process.env.PUBLIC_ORIGIN ?? '';
  if (!publicOrigin && existsSync('/root/orbit/.env')) {
    const line = readFileSync('/root/orbit/.env', 'utf8').split(/\r?\n/u)
      .find((entry) => entry.startsWith('PUBLIC_ORIGIN='));
    publicOrigin = line?.slice('PUBLIC_ORIGIN='.length).replace(/^(['"])(.*)\1$/u, '$2') ?? '';
  }
  publicOrigin ||= 'http://localhost:2086';
  const imageIds = {};
  for (const image of [plan.environment.postgresImage, plan.environment.swiftImage]) {
    const observed = run('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
      allowFailure: true,
    });
    if (observed.status !== 0 || !observed.stdout.startsWith('sha256:')) {
      throw new Error(`required bound image is unavailable at admission: ${image}`);
    }
    imageIds[image] = observed.stdout;
  }
  const targetPackageLock = fileDigest(path.join(repo, 'package-lock.json'));
  const installedPackageLock = fileDigest('/root/orbit/package-lock.json');
  assert.deepEqual(installedPackageLock, targetPackageLock,
    'installed dependency checkout does not match the frozen target package lock');
  const installedNodeModulesLock = fileDigest('/root/orbit/node_modules/.package-lock.json');
  return {
    identity: plan.environment.identity,
    platform: process.platform,
    architecture: process.arch,
    kernel: os.release(),
    postgresImage: plan.environment.postgresImage,
    swiftImage: plan.environment.swiftImage,
    imageIds,
    dependencies: {
      targetPackageLock,
      installedPackageLock,
      installedNodeModulesLock,
    },
    boundInputs: { PUBLIC_ORIGIN: publicOrigin },
    versions,
  };
}

function resolveTarget() {
  git('fetch', '--quiet', plan.target.remote,
    `${plan.target.ref}:${plan.target.remoteTrackingRef}`);
  const head = git('rev-parse', 'HEAD');
  const tracking = git('rev-parse', plan.target.remoteTrackingRef);
  const remote = git('ls-remote', plan.target.remote, plan.target.ref).split(/\s+/u)[0];
  for (const [name, value] of Object.entries({ head, tracking, remote })) {
    assert.match(value, SHA, `${name} is not a full commit SHA`);
  }
  assert.equal(head, tracking, 'checkout HEAD is not the freshly fetched origin/main target');
  assert.equal(head, remote, 'origin/main changed between fetch and remote observation');
  if (process.env.OUTCOME_RELEASE_DAG_TARGET_SHA) {
    assert.equal(head, process.env.OUTCOME_RELEASE_DAG_TARGET_SHA,
      'checkout does not equal the frozen target SHA');
  }
  const trackedStatus = git('status', '--porcelain=v1', '--untracked-files=no');
  assert.equal(trackedStatus, '', 'release DAG requires a tracked-clean checkout');

  const requiredReceipt = plan.target.requiredReceipt;
  assert.match(requiredReceipt.sessionDatabaseId, UUID);
  assert.match(plan.builder.taskDatabaseId, UUID);
  assert.match(requiredReceipt.sourceBranch, /^orbit\/[a-z0-9-]+$/u);
  assert.match(requiredReceipt.targetBranch, /^[a-z0-9-]+$/u);
  const acceptedResults = requiredReceipt.results.map((result) => `'${result}'`).join(',');
  const sql = `
SELECT id::text, result, source_branch, btrim(source_sha::text), target_branch,
       btrim(target_sha_before::text), btrim(target_sha_after::text), recorded_by,
       created_at::text
  FROM session_merge_receipt
 WHERE session_id='${requiredReceipt.sessionDatabaseId}'::uuid
   AND task_id='${plan.builder.taskDatabaseId}'::uuid
   AND source_branch='${requiredReceipt.sourceBranch}'
   AND target_branch='${requiredReceipt.targetBranch}'
   AND recorded_by='${requiredReceipt.recordedBy}'
   AND result IN (${acceptedResults})
 ORDER BY created_at DESC
 LIMIT 1`;
  const receiptColumns = run('docker', [
    'exec', 'orbit-postgres', 'psql', '-U', 'orbit', '-d', 'orbit',
    '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql,
  ]).stdout.split('\t');
  assert.equal(receiptColumns.length, 9, 'the frozen builder merge receipt is missing');
  const receipt = {
    databaseId: receiptColumns[0],
    result: receiptColumns[1],
    sourceBranch: receiptColumns[2],
    sourceSha: receiptColumns[3],
    targetBranch: receiptColumns[4],
    targetShaBefore: receiptColumns[5],
    targetShaAfter: receiptColumns[6],
    recordedBy: receiptColumns[7],
    createdAt: receiptColumns[8],
  };
  assert.match(receipt.databaseId, UUID);
  assert.ok(requiredReceipt.results.includes(receipt.result));
  assert.equal(receipt.sourceBranch, requiredReceipt.sourceBranch);
  assert.equal(receipt.sourceSha, head, 'checkout differs from the builder receipt target');
  assert.equal(receipt.targetBranch, requiredReceipt.targetBranch);
  assert.match(receipt.targetShaBefore, SHA);
  if (receipt.result === 'MERGED') {
    assert.notEqual(receipt.targetShaBefore, head, 'builder receipt is not a strict target advance');
  } else {
    assert.equal(receipt.targetShaBefore, head,
      'ALREADY_MERGED receipt does not describe an already-current target');
  }
  assert.equal(receipt.targetShaAfter, head, 'remote target differs from the builder receipt');
  assert.equal(receipt.recordedBy, requiredReceipt.recordedBy);
  const proof = {
    sessionDatabaseId: requiredReceipt.sessionDatabaseId,
    taskDatabaseId: plan.builder.taskDatabaseId,
    result: receipt.result,
    sourceBranch: receipt.sourceBranch,
    sourceSha: receipt.sourceSha,
    targetBranch: receipt.targetBranch,
    targetShaBefore: receipt.targetShaBefore,
    targetShaAfter: receipt.targetShaAfter,
    recordedBy: receipt.recordedBy,
  };
  return { sha: head, receipt: { ...receipt, proof, digest: sha256(canonical(proof)) } };
}

if (process.argv.includes('--check-plan')) {
  console.log(JSON.stringify({
    outcome: 'PASS',
    nodes: plan.nodes.length,
    order: validation.order,
    evidenceWriter: validation.evidenceWriter,
    dagPlanDigest: deriveBinding({
      plan,
      targetSha: '0'.repeat(40),
      targetReceiptDigest: '0'.repeat(64),
      environment: { checkOnly: true },
    }).dagPlanDigest,
    evaluationPlanDigest: plan.evaluator.evaluationPlanDigest,
  }, null, 2));
  process.exit(0);
}

const targetResolution = resolveTarget();
const targetSha = targetResolution.sha;
const environment = inspectEnvironment();
const binding = deriveBinding({
  plan,
  targetSha,
  targetReceiptDigest: targetResolution.receipt.digest,
  environment,
});
for (const field of ['targetReceiptDigest', 'environmentDigest', 'evaluationPlanDigest', 'dagPlanDigest',
  'evidenceCutDigest', 'bindingDigest']) {
  assert.match(binding[field], DIGEST);
}
const releaseAttempt = deriveReleaseAttemptIdentity({
  bindingDigest: binding.bindingDigest,
  evaluatorTaskId: plan.evaluator.taskId,
  runnerTaskId: process.env.ORBIT_TASK_ID ?? plan.evaluator.taskId,
  runnerSessionId: process.env.ORBIT_SESSION_ID ?? 'standalone',
  startedAt: new Date(processStartedAtMs).toISOString(),
  nonce: process.env.OUTCOME_RELEASE_DAG_ATTEMPT_NONCE,
});
const defaultStateRoot = path.join(repo, 'build', 'outcome-reconciler-release-dag');
const stateRoot = path.resolve(process.env.OUTCOME_RELEASE_DAG_STATE_ROOT ?? defaultStateRoot);
const runRoot = path.join(stateRoot, binding.bindingDigest);
const receiptRoot = path.join(runRoot, 'nodes');
const logRoot = path.join(runRoot, 'logs');
mkdirSync(receiptRoot, { recursive: true });
mkdirSync(logRoot, { recursive: true });

const bindingDocument = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-dag-binding',
  targetRef: plan.target.ref,
  ...binding,
  targetReceipt: targetResolution.receipt,
  releaseAttempt,
  planPath: relativeToRepo(planPath),
  admittedAt: new Date().toISOString(),
};
atomicJson(path.join(runRoot, 'binding.json'), bindingDocument);
atomicJson(path.join(stateRoot, 'current-binding.json'), bindingDocument);

if (process.argv.includes('--print-binding')) {
  console.log(JSON.stringify(bindingDocument, null, 2));
  process.exit(0);
}

const tokens = {
  RUN_ROOT: runRoot,
  TARGET_SHA: targetSha,
  ENVIRONMENT_DIGEST: binding.environmentDigest,
  EVALUATION_PLAN_DIGEST: binding.evaluationPlanDigest,
  DAG_PLAN_DIGEST: binding.dagPlanDigest,
  EVIDENCE_CUT_DIGEST: binding.evidenceCutDigest,
  BINDING_DIGEST: binding.bindingDigest,
  ATTEMPT_TOKEN: releaseAttempt.token,
};
const focusPreparePostgres = process.argv.includes('--focus-prepare-postgres');
const focusPccRebind = process.argv.includes('--focus-pcc-rebind');
const focusRegressionRebind = process.argv.includes('--focus-regression-rebind');
const focusedModeCount = [focusPreparePostgres, focusPccRebind, focusRegressionRebind]
  .filter(Boolean).length;
assert.ok(focusedModeCount <= 1,
  'only one focused Release DAG mode may be selected');
const focusedMode = focusedModeCount === 1;
const focusedNodeIds = new Set();
if (focusedMode) {
  const declaredNodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const includeWithDependencies = (id) => {
    if (focusedNodeIds.has(id)) return;
    const node = declaredNodes.get(id);
    assert.ok(node, `focused Release DAG node is missing: ${id}`);
    for (const dependency of node.dependsOn) includeWithDependencies(dependency);
    focusedNodeIds.add(id);
  };
  includeWithDependencies('prepare-postgres');
  if (focusPccRebind || focusRegressionRebind) {
    includeWithDependencies('prepare-build');
  }
  if (focusPccRebind) {
    for (const id of [
      'suite-bootstrap',
      'suite-evaluator',
      'suite-projection',
      'suite-fact-ingress',
      'suite-auto-dispatch',
      'suite-work-overview-readiness',
      'suite-watchdog-111k',
    ]) includeWithDependencies(id);
  }
  if (focusRegressionRebind) {
    includeWithDependencies('full-api-inventory');
  }
}
const expandedPlan = {
  ...plan,
  nodes: plan.nodes
    .filter((node) => !focusedMode || focusedNodeIds.has(node.id))
    .map((node) => expandedNode(node, tokens)),
};
const nodes = new Map(expandedPlan.nodes.map((node) => [node.id, node]));
const order = topologicalOrder(expandedPlan);
const orderIndex = new Map(order.map((id, index) => [id, index]));

// Reuse is keyed on this, never on the round: the declared plan entry, the content of the
// scopes the node reads, the host it reads them on, and the shape of what produced its inputs.
const observedScopeDigests = checkoutScopeDigests(plan, repo);
const nodeInputIndex = nodeInputDigests({
  plan,
  scopeDigests: observedScopeDigests,
  environmentDigest: binding.environmentDigest,
});
const inputDigestOf = (nodeId) => nodeInputIndex.get(nodeId)?.inputDigest ?? null;
const checkpointRoot = path.join(stateRoot, 'checkpoints');

function receiptPath(nodeId) {
  return path.join(receiptRoot, `${nodeId}.json`);
}

function readReceipt(nodeId) {
  const file = receiptPath(nodeId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function directoryTreesValid(trees) {
  return Array.isArray(trees) && trees.length > 0 && trees.every((tree) => {
    const directory = resolveFromRepo(tree.path);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return false;
    const found = run('find', [directory, '-type', 'f', '-print'], { allowFailure: true });
    if (found.status !== 0) return false;
    const files = found.stdout.split('\n').filter(Boolean).sort().map((file) => ({
      path: relativeToRepo(file),
      ...fileDigest(file),
    }));
    return files.length === tree.fileCount && sha256(canonical(files)) === tree.treeDigest;
  });
}

function prismaOutputsValid(receipt) {
  const contextArtifact = receipt?.artifacts?.find((artifact) => (
    path.basename(artifact.declaredPath) === 'prisma-context.json'
  ));
  if (!contextArtifact) return false;
  try {
    const context = JSON.parse(readFileSync(resolveFromRepo(contextArtifact.snapshotPath), 'utf8'));
    return context.bindingDigest === binding.bindingDigest && directoryTreesValid(context.trees);
  } catch {
    return false;
  }
}

function compiledBuildOutputsValid(receipt) {
  const contextArtifact = receipt?.artifacts?.find((artifact) => (
    path.basename(artifact.declaredPath) === 'build-context.json'
  ));
  if (!contextArtifact) return false;
  try {
    const context = JSON.parse(readFileSync(resolveFromRepo(contextArtifact.snapshotPath), 'utf8'));
    const filesValid = Array.isArray(context.outputs) && context.outputs.length > 0
      && context.outputs.every((output) => {
        const file = resolveFromRepo(output.path);
        return existsSync(file) && statSync(file).isFile()
          && fileDigest(file).bytes === output.bytes
          && fileDigest(file).sha256 === output.sha256;
      });
    const treesValid = directoryTreesValid(context.trees);
    return filesValid && treesValid;
  } catch {
    return false;
  }
}

function dependencyOutputsValid(receipt) {
  const contextArtifact = receipt?.artifacts?.find((artifact) => (
    path.basename(artifact.declaredPath) === 'dependency-context.json'
  ));
  if (!contextArtifact) return false;
  try {
    const context = JSON.parse(readFileSync(resolveFromRepo(contextArtifact.snapshotPath), 'utf8'));
    return Array.isArray(context.dependencies) && context.dependencies.length > 0
      && context.dependencies.every((dependency) => {
        const file = resolveFromRepo(dependency.path);
        if (!existsSync(file)) return false;
        const observed = run('readlink', ['-f', file], { allowFailure: true });
        return observed.status === 0 && observed.stdout === dependency.realpath;
      });
  } catch {
    return false;
  }
}

function postgresOutputsValid(receipt) {
  const contextArtifact = receipt?.artifacts?.find((artifact) => (
    path.basename(artifact.declaredPath) === 'postgres-context.json'
  ));
  if (!contextArtifact) return false;
  try {
    const context = JSON.parse(readFileSync(resolveFromRepo(contextArtifact.snapshotPath), 'utf8'));
    if (context.bindingDigest !== binding.bindingDigest
        || context.credential !== 'FIXED_DISPOSABLE_LOOPBACK_ONLY') return false;
    const inspected = run('docker', [
      'inspect', '--format',
      '{{.State.Running}}\t{{.Image}}\t{{ index .Config.Labels "orbit.release-dag.binding" }}',
      context.container,
    ], { allowFailure: true });
    if (inspected.status !== 0) return false;
    const [running, imageId, observedBinding] = inspected.stdout.split('\t');
    if (running !== 'true' || imageId !== context.imageId || observedBinding !== binding.bindingDigest) {
      return false;
    }
    const server = run('docker', [
      'exec', context.container, 'psql', '-U', context.admin, '-d', 'postgres',
      '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c',
      `SELECT current_setting('server_version'), system_identifier::text,
              (SELECT count(*) FROM pg_database
                WHERE datname IN ('${context.currentTemplate}','${context.beforeOwnerRoutingTemplate}'))
         FROM pg_control_system()`,
    ], { allowFailure: true });
    if (server.status !== 0) return false;
    const [version, systemIdentifier, templates] = server.stdout.split('\t');
    if (version !== context.version || systemIdentifier !== context.systemIdentifier || templates !== '2') {
      return false;
    }
    const migrations = run('docker', [
      'exec', context.container, 'psql', '-U', context.admin, '-d', context.currentTemplate,
      '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c',
      'SELECT count(*), max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL',
    ], { allowFailure: true });
    if (migrations.status !== 0) return false;
    const [count, last] = migrations.stdout.split('\t');
    return Number(count) === context.migrations && last === context.lastMigration;
  } catch {
    return false;
  }
}

function artifactsValid(receipt, node, { requireLivePostgres = false } = {}) {
  if (!Array.isArray(receipt?.artifacts) || receipt.artifacts.length === 0) return false;
  const snapshotsValid = receipt.artifacts.every((artifact) => {
    const snapshot = resolveFromRepo(artifact.snapshotPath);
    if (!existsSync(snapshot) || !statSync(snapshot).isFile()) return false;
    const observed = fileDigest(snapshot);
    return observed.bytes === artifact.bytes && observed.sha256 === artifact.sha256;
  });
  return snapshotsValid
    && (node.id !== 'prepare-build' || compiledBuildOutputsValid(receipt))
    && (node.id !== 'prepare-prisma' || prismaOutputsValid(receipt))
    && (node.id !== 'prepare-dependencies' || dependencyOutputsValid(receipt))
    && (!requireLivePostgres || node.id !== 'prepare-postgres' || postgresOutputsValid(receipt));
}

function materialize(receipt) {
  for (const artifact of receipt.artifacts) {
    const source = resolveFromRepo(artifact.snapshotPath);
    const destination = resolveFromRepo(artifact.declaredPath);
    if (path.resolve(source) === path.resolve(destination)) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function snapshotOutputs(node) {
  const snapshotDirectory = path.join(runRoot, 'artifacts', node.id);
  mkdirSync(snapshotDirectory, { recursive: true });
  return node.outputs.map((declared, index) => {
    const source = resolveFromRepo(declared);
    if (!existsSync(source) || !statSync(source).isFile() || statSync(source).size === 0) {
      throw new Error(`${node.id} did not produce ${declared}`);
    }
    const snapshot = source.startsWith(`${runRoot}${path.sep}`)
      ? source
      : path.join(snapshotDirectory, `${String(index).padStart(2, '0')}-${path.basename(source)}`);
    if (snapshot !== source) copyFileSync(source, snapshot);
    const digest = fileDigest(snapshot);
    return {
      declaredPath: relativeToRepo(source),
      snapshotPath: relativeToRepo(snapshot),
      ...digest,
    };
  });
}

function quarantineNodeOutputs(node) {
  const quarantine = path.join(runRoot, 'superseded-node-outputs', node.id);
  for (const [index, declared] of node.outputs.entries()) {
    const source = resolveFromRepo(declared);
    if (!existsSync(source) || !statSync(source).isFile()) continue;
    mkdirSync(quarantine, { recursive: true });
    const digest = fileDigest(source).sha256.slice(0, 12);
    const destination = path.join(
      quarantine,
      `${String(index).padStart(2, '0')}-${digest}-${path.basename(source)}`,
    );
    if (path.resolve(source) !== path.resolve(destination)) renameSync(source, destination);
  }
}

// The checkpoint store is addressed by what a node reads, not by the round it ran in.
// A round is a fresh directory; a checkpoint outlives it exactly as long as its inputs do.
function storedCheckpoint(nodeId) {
  return readCheckpoint({ storeRoot: checkpointRoot, nodeId, inputDigest: inputDigestOf(nodeId) });
}

function storeCheckpoint(receipt) {
  // A focused observation is not a resumable formal attempt and never seeds the store.
  if (focusedMode) return;
  writeCheckpoint({ repo, storeRoot: checkpointRoot, receipt });
}

function readmit(receipt, node) {
  return readmitCheckpoint({
    repo,
    receipt,
    node,
    binding: {
      targetRef: plan.target.ref,
      targetSha,
      targetReceiptDigest: binding.targetReceiptDigest,
      environmentDigest: binding.environmentDigest,
      evaluationPlanDigest: binding.evaluationPlanDigest,
      dagPlanDigest: binding.dagPlanDigest,
      evidenceCutDigest: binding.evidenceCutDigest,
      bindingDigest: binding.bindingDigest,
    },
    target: {
      ref: plan.target.ref,
      sha: targetSha,
      receiptDigest: targetResolution.receipt.digest,
    },
    releaseAttempt,
    runRoot,
    logRoot,
  });
}

function loadReusable() {
  const decide = (requireLivePostgres) => {
    const decisions = new Map();
    const reusable = new Set();
    for (const id of order) {
      const node = nodes.get(id);
      const { inputDigest, inputs } = nodeInputIndex.get(id) ?? {};
      const receipt = storedCheckpoint(id) ?? readReceipt(id);
      const decision = checkpointReuseDecision({
        receipt,
        node,
        binding,
        artifactsValid: artifactsValid(receipt, node, { requireLivePostgres }),
        inputDigest,
        inputs,
      });
      decisions.set(id, { decision, receipt });
      if (decision.reusable) reusable.add(id);
    }
    return { decisions, reusable };
  };

  // A complete immutable cut is idempotent even though its disposable PostgreSQL server was
  // intentionally removed. A partial cut must prove that the resumable server still exists.
  const generic = decide(false);
  const selected = generic.reusable.size === nodes.size ? generic : decide(true);
  const completed = new Map();
  for (const id of order) {
    const { decision, receipt } = selected.decisions.get(id);
    const node = nodes.get(id);
    if (decision.reusable) {
      const readmitted = readmit(receipt, node);
      materialize(readmitted);
      atomicJson(receiptPath(id), readmitted);
      completed.set(id, { ...readmitted, reused: true, reuseReason: decision.reason });
      console.log(`==> release-dag: reuse ${id} input=${inputDigestOf(id)?.slice(0, 12)} artifact=${readmitted.artifactDigest}`);
    } else {
      console.log(`==> release-dag: invalidate ${id} reason=${decision.reason} input=${inputDigestOf(id)?.slice(0, 12) ?? 'INDETERMINATE'}`);
    }
  }
  return completed;
}

function postgresEnvironment(node) {
  if (!node.usesSharedPostgres) return {};
  const policy = plan.postgresIsolation.nodes[node.id];
  const contextPath = path.join(runRoot, 'postgres-context.json');
  const context = JSON.parse(readFileSync(contextPath, 'utf8'));
  assert.equal(context.bindingDigest, binding.bindingDigest,
    `${node.id} received stale PostgreSQL preparation`);
  assert.equal(context.credential, 'FIXED_DISPOSABLE_LOOPBACK_ONLY');
  assert.equal(context.imageId, environment.imageIds[plan.environment.postgresImage]);
  const allocation = nodeDatabaseIdentity({
    node: { ...node, ...policy },
    bindingDigest: binding.bindingDigest,
    attemptToken: releaseAttempt.token,
  });
  return {
    OUTCOME_RELEASE_DAG_PG_CONTEXT: contextPath,
    OUTCOME_RELEASE_DAG_PG_CONTAINER: context.container,
    OUTCOME_RELEASE_DAG_PG_ADMIN: context.admin,
    OUTCOME_RELEASE_DAG_PG_PASSWORD: 'pccrd_disposable_password',
    OUTCOME_RELEASE_DAG_PG_HOST: context.host,
    OUTCOME_RELEASE_DAG_PG_PORT: String(context.port),
    OUTCOME_RELEASE_DAG_PG_SYSTEM_ID: context.systemIdentifier,
    OUTCOME_RELEASE_DAG_PG_VERSION: context.version,
    OUTCOME_RELEASE_DAG_PG_MIGRATIONS: String(context.migrations),
    OUTCOME_RELEASE_DAG_PG_LAST_MIGRATION: context.lastMigration,
    OUTCOME_RELEASE_DAG_PG_TEMPLATE: node.postgresTemplate === 'before-owner-routing'
      ? context.beforeOwnerRoutingTemplate
      : context.currentTemplate,
    OUTCOME_RELEASE_DAG_DATABASE: allocation.database,
    OUTCOME_RELEASE_DAG_DATABASE_USER: allocation.role,
    OUTCOME_RELEASE_DAG_DATABASE_PREFIX: policy.postgresDatabasePrefix,
    OUTCOME_RELEASE_DAG_ROLE_PREFIX: policy.postgresRolePrefix,
    OUTCOME_RELEASE_DAG_DESTRUCTIVE_COORDINATOR_SPECS:
      policy.destructiveCoordinatorSpecs ? '1' : '0',
  };
}

function nodeEnvironment(node, effectiveTimeoutSeconds) {
  const build = node.usesSharedBuild ? {
    OUTCOME_RELEASE_DAG_BUILD_CONTEXT: path.join(runRoot, 'build-context.json'),
    OUTCOME_RELEASE_DAG_PREPARED_BUILD: '1',
  } : {};
  const environmentVariables = {
    ...process.env,
    PUBLIC_ORIGIN: environment.boundInputs.PUBLIC_ORIGIN,
    ...node.environment,
    ...build,
    ...postgresEnvironment(node),
    OUTCOME_RELEASE_DAG_ACTIVE: '1',
    OUTCOME_RELEASE_DAG_PHASE: plan.evaluator.phase,
    OUTCOME_RELEASE_DAG_DEPLOYMENT_TASK_ID: plan.evaluator.deploymentTaskId,
    OUTCOME_RELEASE_DAG_NODE_ID: node.id,
    // The budget this admission actually enforces, so a node that guards a step of its own can
    // derive that guard from it instead of carrying a fixed ceiling that silently undercuts it.
    OUTCOME_RELEASE_DAG_NODE_TIMEOUT_SECONDS: String(effectiveTimeoutSeconds),
    OUTCOME_RELEASE_DAG_RUN_ROOT: runRoot,
    OUTCOME_RELEASE_DAG_TARGET_SHA: targetSha,
    OUTCOME_RELEASE_DAG_TARGET_RECEIPT_DIGEST: binding.targetReceiptDigest,
    OUTCOME_RELEASE_DAG_ENVIRONMENT_DIGEST: binding.environmentDigest,
    OUTCOME_RELEASE_DAG_EVALUATION_PLAN_DIGEST: binding.evaluationPlanDigest,
    OUTCOME_RELEASE_DAG_PLAN_DIGEST: binding.dagPlanDigest,
    OUTCOME_RELEASE_DAG_EVIDENCE_CUT_DIGEST: binding.evidenceCutDigest,
    OUTCOME_RELEASE_DAG_BINDING_DIGEST: binding.bindingDigest,
    OUTCOME_RELEASE_DAG_ATTEMPT_DIGEST: releaseAttempt.digest,
    OUTCOME_RELEASE_DAG_ATTEMPT_TOKEN: releaseAttempt.token,
    OUTCOME_RELEASE_DAG_PLAN_PATH: planPath,
    OUTCOME_RELEASE_DAG_COMMAND_DIGEST: commandDigest(node.command),
    OUTCOME_RELEASE_DAG_NODE_INPUT_DIGEST: inputDigestOf(node.id) ?? '',
    OUTCOME_RELEASE_DAG_POSTGRES_IMAGE_ID: environment.imageIds[plan.environment.postgresImage],
    OUTCOME_RELEASE_DAG_SWIFT_IMAGE_ID: environment.imageIds[plan.environment.swiftImage],
  };
  return environmentVariables;
}

function postgresIsolationEvidence(node, environmentVariables) {
  if (!node.usesSharedPostgres) return null;
  const database = environmentVariables.OUTCOME_RELEASE_DAG_DATABASE;
  const role = environmentVariables.OUTCOME_RELEASE_DAG_DATABASE_USER;
  const container = environmentVariables.OUTCOME_RELEASE_DAG_PG_CONTAINER;
  const provisioner = environmentVariables.OUTCOME_RELEASE_DAG_PG_ADMIN;
  const observed = run('docker', [
    'exec', container, 'psql', '-U', provisioner, '-d', 'postgres',
    '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT (SELECT count(*) FROM pg_database WHERE datname='${database}') + (SELECT count(*) FROM pg_roles WHERE rolname='${role}')`,
  ]).stdout;
  assert.equal(observed, '0', `${node.id} leaked its disposable PostgreSQL database or role`);
  return {
    allocator: plan.postgresIsolation.allocator,
    bindingDigest: binding.bindingDigest,
    attemptDigest: releaseAttempt.digest,
    attemptToken: releaseAttempt.token,
    nodeId: node.id,
    database,
    role,
    databasePrefix: environmentVariables.OUTCOME_RELEASE_DAG_DATABASE_PREFIX,
    rolePrefix: environmentVariables.OUTCOME_RELEASE_DAG_ROLE_PREFIX,
    destructiveCoordinatorSpecs:
      environmentVariables.OUTCOME_RELEASE_DAG_DESTRUCTIVE_COORDINATOR_SPECS === '1',
    identityVerifiedBeforeMutation: true,
    cleanup: { databaseRemoved: true, roleRemoved: true, resourcesRemaining: 0 },
  };
}

function redactor(environmentVariables) {
  const secrets = Object.entries(environmentVariables)
    .filter(([name, value]) => /(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|API_KEY)/u.test(name)
      && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  return (value) => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

async function executeNode(node, attemptDeadlineMs) {
  const admittedAtMs = Date.now();
  const remainingSeconds = Math.max(1, Math.floor((attemptDeadlineMs - admittedAtMs) / 1000));
  const effectiveTimeoutSeconds = Math.min(node.timeoutSeconds, remainingSeconds);
  const deadlineAtMs = admittedAtMs + (effectiveTimeoutSeconds * 1000);
  const logPath = path.join(logRoot, `${node.id}.log`);
  quarantineNodeOutputs(node);
  const environmentVariables = nodeEnvironment(node, effectiveTimeoutSeconds);
  const redact = redactor(environmentVariables);
  const chunks = [];
  console.log(`==> release-dag: admit ${node.id} timeout=${effectiveTimeoutSeconds}s commandDigest=${commandDigest(node.command)}`);
  const child = spawn(node.command[0], node.command.slice(1), {
    cwd: repo,
    env: environmentVariables,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const startedAt = new Date().toISOString();
  let timedOut = false;
  const consume = (chunk) => {
    const safe = redact(chunk.toString('utf8'));
    chunks.push(safe);
    process.stdout.write(safe);
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child, 'SIGTERM');
    setTimeout(() => killProcessGroup(child, 'SIGKILL'), 5_000).unref();
  }, effectiveTimeoutSeconds * 1000);
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => resolve({ code, signal, error: null }));
  });
  clearTimeout(timer);
  const finishedAt = new Date().toISOString();
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, chunks.join(''));
  let exitCode = typeof result.code === 'number' ? result.code : 1;
  let artifacts = [];
  let metrics = { tests: 0, passed: 0, failed: 0, skipped: 0 };
  let validationError = result.error?.message ?? null;
  let postgresIsolation = null;
  if (!timedOut && exitCode === 0) {
    try {
      const outputFiles = node.outputs.map(resolveFromRepo);
      metrics = metricsForNode(node, outputFiles);
      artifacts = snapshotOutputs(node);
      postgresIsolation = postgresIsolationEvidence(node, environmentVariables);
    } catch (error) {
      exitCode = 66;
      validationError = error instanceof Error ? error.message : String(error);
    }
  }
  const log = fileDigest(logPath);
  const state = timedOut ? 'TIMED_OUT' : exitCode === 0 ? 'SUCCESS' : 'FAILED';
  const receipt = {
    schemaVersion: 1,
    kind: 'orbit.outcome-reconciler.release-dag-node-receipt',
    nodeId: node.id,
    nodeKind: node.kind,
    state,
    artifactBinding: node.artifactBinding,
    inputDigest: inputDigestOf(node.id),
    inputs: nodeInputIndex.get(node.id)?.inputs ?? null,
    target: {
      ref: plan.target.ref,
      sha: targetSha,
      receiptDigest: targetResolution.receipt.digest,
    },
    binding: {
      targetRef: plan.target.ref,
      targetSha,
      targetReceiptDigest: binding.targetReceiptDigest,
      environmentDigest: binding.environmentDigest,
      evaluationPlanDigest: binding.evaluationPlanDigest,
      dagPlanDigest: binding.dagPlanDigest,
      evidenceCutDigest: binding.evidenceCutDigest,
      bindingDigest: binding.bindingDigest,
    },
    releaseAttempt,
    command: node.command,
    commandDigest: commandDigest(node.command),
    admission: {
      admittedAt: new Date(admittedAtMs).toISOString(),
      requestedTimeoutSeconds: node.timeoutSeconds,
      effectiveTimeoutSeconds,
      deadlineAt: new Date(deadlineAtMs).toISOString(),
      evaluatorDeadlineAt: new Date(attemptDeadlineMs).toISOString(),
      maxNodeTimeoutSeconds: 3600,
    },
    startedAt,
    finishedAt,
    durationMilliseconds: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    exitCode: timedOut ? null : exitCode,
    signal: result.signal,
    testCount: metrics.tests,
    passCount: metrics.passed,
    failCount: metrics.failed,
    skipCount: metrics.skipped,
    toolVersions: environment.versions,
    environmentIdentity: environment.identity,
    evaluationPhase: plan.evaluator.phase,
    environment,
    postgresIsolation,
    resources: node.resources,
    resourceLimits: plan.resourceLimits,
    hostResourceEnvelope: plan.hostResourceEnvelope,
    artifacts,
    log: { path: relativeToRepo(logPath), ...log },
    artifactDigest: sha256(canonical({ artifacts, log })),
    validationError,
    reusable: state === 'SUCCESS' && node.cacheable === true
      && DIGEST.test(inputDigestOf(node.id) ?? ''),
  };
  atomicJson(receiptPath(node.id), receipt);
  storeCheckpoint(receipt);
  console.log(`==> release-dag: ${node.id} ${state} exit=${receipt.exitCode ?? 'null'} tests=${receipt.testCount} skip=${receipt.skipCount} artifact=${receipt.artifactDigest}`);
  return receipt;
}

// The declared cleanup entry point stays the prepare script whenever its context exists. The
// binding label sweep behind it is what makes the manifest true, and is the whole of cleanup when
// the context is missing -- a case formal mode used to answer by abandoning cleanup entirely.
function declaredContextCleanup(context) {
  return run('timeout', [
    '-k', '5', '30', 'bash',
    'scripts/outcome-reconciler-release-dag-prepare.sh', 'cleanup-postgres', context,
  ], { allowFailure: true });
}

// Cleanup is a fact about the attempt, so it is recorded beside it and folded into the attempt
// document when one was already written. Both writes are synchronous: this runs from `exit`.
function recordDisposableCleanup(manifest) {
  atomicJson(path.join(runRoot, 'disposable-cleanup.json'), manifest);
  const attemptFile = path.join(runRoot, 'attempt.json');
  if (existsSync(attemptFile)) {
    atomicJson(attemptFile, {
      ...JSON.parse(readFileSync(attemptFile, 'utf8')),
      disposableCleanup: manifest,
    });
  }
  if (manifest.outcome === 'CLEAN') {
    console.log(`==> release-dag: disposable cleanup CLEAN reason=${manifest.reason} removed=${manifest.removed.length} remaining=0`);
    return;
  }
  console.error(`!! release-dag: disposable cleanup ${manifest.outcome} reason=${manifest.reason} remaining=${manifest.resourcesRemaining} failures=${JSON.stringify(manifest.failures)}`);
}

const attemptStartedAtMs = processStartedAtMs;
const attemptDeadlineMs = attemptStartedAtMs + (plan.evaluator.schedulerDeadlineSeconds * 1000);
// Installed before anything can be provisioned or fail, so the disposable server this attempt owns
// is removed on every exit path this process has: completion, `process.exit` after a failed node,
// an uncaught exception, a deadline that admits nothing, and SIGTERM.
guardDisposableResources({
  bindingDigest: binding.bindingDigest,
  contextPath: path.join(runRoot, 'postgres-context.json'),
  declaredContextCleanup,
  onManifest: recordDisposableCleanup,
});
// The focused rebind preflight is an observation, not a resumable formal attempt. It always
// exercises the disposable PostgreSQL and isolated Prisma fixture from scratch.
const completed = focusedMode ? new Map() : loadReusable();

// What would this round actually rerun? The answer is a property of the checkout, not of
// the run, so it is worth being able to ask without starting a 45-node matrix.
if (process.argv.includes('--plan-reuse')) {
  console.log(JSON.stringify({
    outcome: 'PASS',
    bindingDigest: binding.bindingDigest,
    targetSha,
    scopeDigests: observedScopeDigests,
    reusedNodeIds: [...completed.keys()].sort(),
    rerunNodeIds: order.filter((id) => !completed.has(id)),
    nodes: order.map((id) => ({
      id,
      artifactBinding: nodes.get(id).artifactBinding,
      inputDigest: inputDigestOf(id),
      reused: completed.has(id),
    })),
  }, null, 2));
  process.exit(0);
}
const attempted = new Set();
const running = new Map();
let inUse = {};

try {
  while (completed.size < nodes.size) {
    let admitted = false;
    const ready = order
      .filter((id) => !completed.has(id) && !attempted.has(id) && !running.has(id))
      .filter((id) => nodes.get(id).dependsOn.every((dependency) => completed.has(dependency)))
      .sort((a, b) => orderIndex.get(a) - orderIndex.get(b));
    for (const id of ready) {
      if (Date.now() >= attemptDeadlineMs) break;
      const node = nodes.get(id);
      if (!resourceFits(node, inUse, plan.resourceLimits, running.size)) continue;
      attempted.add(id);
      inUse = addResources(inUse, node, 1);
      const promise = executeNode(node, attemptDeadlineMs).then((receipt) => ({ id, receipt }));
      running.set(id, promise);
      admitted = true;
    }
    if (running.size === 0) {
      if (!admitted) break;
      continue;
    }
    const { id, receipt } = await Promise.race(running.values());
    running.delete(id);
    inUse = addResources(inUse, nodes.get(id), -1);
    if (receipt.state === 'SUCCESS') completed.set(id, receipt);
  }
  if (running.size > 0) {
    const settled = await Promise.all(running.values());
    for (const { id, receipt } of settled) {
      if (receipt.state === 'SUCCESS') completed.set(id, receipt);
    }
  }
} finally {
  // Artifact checkpoints survive a bounded evaluator timeout or a failed node, so only unfinished
  // nodes are rescheduled. The disposable server does not survive with them: a partial cut
  // re-prepares it rather than holding 3 GiB of the host hostage until the next attempt.
}

let focusedRegression = null;
if ((focusPccRebind || focusRegressionRebind) && completed.size === nodes.size) {
  const focusName = focusPccRebind ? 'pcc-focused-regression' : 'regression-rebind-focused';
  const focusScript = focusPccRebind
    ? 'outcome-reconciler-release-dag-pcc-focus.mjs'
    : 'outcome-reconciler-release-dag-regression-focus.mjs';
  const focusedOutput = path.join(runRoot, `${focusName}.json`);
  const focusedLog = path.join(logRoot, `${focusName}.log`);
  const result = spawnSync(process.execPath, [
    path.join(repo, 'scripts', focusScript),
    runRoot,
    focusedOutput,
  ], {
    cwd: repo,
    encoding: 'utf8',
    timeout: Math.max(1, attemptDeadlineMs - Date.now()),
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      OUTCOME_RELEASE_DAG_TARGET_SHA: binding.targetSha,
      OUTCOME_RELEASE_DAG_TARGET_RECEIPT_DIGEST: binding.targetReceiptDigest,
      OUTCOME_RELEASE_DAG_ENVIRONMENT_DIGEST: binding.environmentDigest,
      OUTCOME_RELEASE_DAG_EVALUATION_PLAN_DIGEST: binding.evaluationPlanDigest,
      OUTCOME_RELEASE_DAG_PLAN_DIGEST: binding.dagPlanDigest,
      OUTCOME_RELEASE_DAG_EVIDENCE_CUT_DIGEST: binding.evidenceCutDigest,
      OUTCOME_RELEASE_DAG_BINDING_DIGEST: binding.bindingDigest,
      OUTCOME_RELEASE_DAG_ATTEMPT_DIGEST: releaseAttempt.digest,
      OUTCOME_RELEASE_DAG_ATTEMPT_TOKEN: releaseAttempt.token,
      OUTCOME_RELEASE_DAG_RUN_ROOT: runRoot,
    },
  });
  writeFileSync(focusedLog, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.status === 0 && existsSync(focusedOutput)) {
    focusedRegression = JSON.parse(readFileSync(focusedOutput, 'utf8'));
    assert.equal(focusedRegression.outcome, 'PASS');
  } else {
    focusedRegression = {
      outcome: 'FAIL',
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      log: { path: relativeToRepo(focusedLog), ...fileDigest(focusedLog) },
    };
  }
}

const failed = order.filter((id) => {
  const receipt = readReceipt(id);
  return attempted.has(id) && receipt?.state === 'FAILED';
});
const timedOut = order.filter((id) => {
  const receipt = readReceipt(id);
  return attempted.has(id) && receipt?.state === 'TIMED_OUT';
});
const incomplete = order.filter((id) => !completed.has(id));
const attempt = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-dag-attempt',
  binding: bindingDocument,
  releaseAttempt,
  startedAt: new Date(attemptStartedAtMs).toISOString(),
  finishedAt: new Date().toISOString(),
  evaluatorTimeoutSeconds: plan.evaluator.attemptTimeoutSeconds,
  schedulerDeadlineSeconds: plan.evaluator.schedulerDeadlineSeconds,
  nodeCount: nodes.size,
  successfulNodes: [...completed.keys()].sort((a, b) => orderIndex.get(a) - orderIndex.get(b)),
  failedNodes: failed,
  timedOutNodes: timedOut,
  incompleteNodes: incomplete,
  automaticRetries: 0,
  // (k) A retry that nobody can count is indistinguishable from a silent re-run. The
  // declared budgets and this attempt's place in the retry sequence both land on the
  // record, so a reader can check the bound was honoured rather than assume it.
  retryPolicy: {
    ...plan.evaluator.retryBudgets,
    retryIndex: priorTerminations.length,
    priorTerminations,
  },
  executionMode: focusPreparePostgres
    ? 'FOCUSED_PREPARE_POSTGRES_PREFLIGHT'
    : focusPccRebind
      ? 'FOCUSED_PCC_DATABASE_REBIND'
      : focusRegressionRebind
        ? 'FOCUSED_RELEASE_DAG_REGRESSION_REBIND'
        : 'FORMAL_RELEASE_DAG',
  focusedRegression,
  outcome: incomplete.length === 0
    && (!(focusPccRebind || focusRegressionRebind) || focusedRegression?.outcome === 'PASS')
    ? 'PASS' : 'FAIL',
};
atomicJson(path.join(runRoot, 'attempt.json'), attempt);
console.log(JSON.stringify(attempt, null, 2));
// The failure site identity the control plane fingerprints this attempt by. Node ids only, sorted:
// a run that fails on the same nodes must digest the same, and nothing that varies per run (time,
// path, pid, log body) is allowed to reach it. Printed last so a truncated head cannot fake it.
console.log(`##orbit-failure-sites:v1 ${[...new Set([...failed, ...timedOut])].sort().join(' ')}`);
if (incomplete.length !== 0
  || ((focusPccRebind || focusRegressionRebind) && focusedRegression?.outcome !== 'PASS')) {
  process.exit(1);
}
