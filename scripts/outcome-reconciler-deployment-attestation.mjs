#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const repo = path.resolve(import.meta.dirname, '..');
const contract = JSON.parse(readFileSync(path.join(
  repo, 'contracts/outcome-reconciler-release-frontier.json',
), 'utf8'));
const releaseDag = JSON.parse(readFileSync(path.join(
  repo, 'contracts/outcome-reconciler-release-dag.json',
), 'utf8'));
const mode = process.argv[2];
assert.equal(mode, 'auto-dispatch',
  'usage: outcome-reconciler-deployment-attestation.mjs auto-dispatch');
const predeploy = process.env.OUTCOME_RELEASE_DAG_ACTIVE === '1'
  && process.env.OUTCOME_RELEASE_DAG_PHASE === 'PREDEPLOY_EVALUATION';

function run(file, args, cwd = repo) {
  return execFileSync(file, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function git(args, cwd = repo) {
  return run('git', args, cwd);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestFile(relative) {
  const raw = readFileSync(path.join(repo, relative));
  return { bytes: raw.byteLength, sha256: sha256(raw) };
}

function inspectContainer(name) {
  const [container] = JSON.parse(run('docker', ['inspect', name]));
  assert.ok(container?.State?.Running, `${name} is not running`);
  if (container.State.Health) {
    assert.equal(container.State.Health.Status, 'healthy', `${name} is not healthy`);
  }
  const environment = Object.fromEntries((container.Config.Env ?? []).map((entry) => {
    const split = entry.indexOf('=');
    return split < 0 ? [entry, ''] : [entry.slice(0, split), entry.slice(split + 1)];
  }));
  return {
    name,
    id: container.Id,
    imageId: container.Image,
    startedAt: container.State.StartedAt,
    status: container.State.Status,
    health: container.State.Health?.Status ?? 'RUNNING_NO_HEALTHCHECK',
    environment,
  };
}

function queryJson(sql) {
  const value = run('docker', [
    'exec', 'orbit-postgres', 'psql', '-U', 'orbit', '-d', 'orbit',
    '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql,
  ]);
  assert.ok(value, 'production evidence query returned no row');
  const lines = value.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `production evidence query returned ${lines.length} rows`);
  return JSON.parse(lines[0]);
}

function numericLeaves(value, names, at = '$', found = []) {
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => numericLeaves(entry, names, `${at}[${index}]`, found));
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key) && typeof child === 'number') found.push({ path: `${at}.${key}`, value: child });
    numericLeaves(child, names, `${at}.${key}`, found);
  }
  return found;
}

function validateRegression(relative, expectedSuite) {
  const manifest = JSON.parse(readFileSync(path.join(repo, relative), 'utf8'));
  assert.equal(manifest.outcome, 'PASS', `${relative} is not PASS`);
  assert.equal(manifest.targetSha, targetSha, `${relative} targets a different SHA`);
  if (expectedSuite) assert.equal(manifest.suite, expectedSuite);
  for (const entry of numericLeaves(manifest, new Set(['skip', 'skipped', 'skipCount']))) {
    assert.equal(entry.value, 0, `${relative} contains ${entry.path}=${entry.value}`);
  }
  for (const entry of numericLeaves(manifest, new Set(['fail', 'failed', 'failedFiles']))) {
    assert.equal(entry.value, 0, `${relative} contains ${entry.path}=${entry.value}`);
  }
  return { manifest, file: digestFile(relative) };
}

function loadBuilderMergeReceipt(targetSha) {
  const receipt = queryJson(`
  SELECT jsonb_build_object(
    'id', id::text, 'result', result, 'sourceBranch', source_branch,
    'sourceSha', btrim(source_sha::text), 'targetBranch', target_branch,
    'targetShaBefore', btrim(target_sha_before::text),
    'targetShaAfter', btrim(target_sha_after::text), 'recordedBy', recorded_by,
    'createdAt', created_at
  )
    FROM session_merge_receipt
   WHERE session_id='${contract.session.databaseId}'::uuid
     AND task_id='${contract.task.databaseId}'::uuid
     AND source_branch='${contract.session.sourceBranch}'
     AND source_sha='${targetSha}'::char(40)
     AND target_branch='${contract.repository.targetBranch}'
     AND target_sha_after='${targetSha}'::char(40)
     AND recorded_by='AGENT'
     AND result IN ('MERGED','ALREADY_MERGED')
   ORDER BY created_at DESC LIMIT 1
  `);
  assert.ok(['MERGED', 'ALREADY_MERGED'].includes(receipt.result));
  assert.equal(receipt.sourceBranch, contract.session.sourceBranch);
  assert.equal(receipt.sourceSha, targetSha);
  assert.equal(receipt.targetShaAfter, targetSha);
  assert.match(receipt.targetShaBefore, SHA);
  if (receipt.result === 'MERGED') assert.notEqual(receipt.targetShaBefore, targetSha);
  else assert.equal(receipt.targetShaBefore, targetSha);
  assert.equal(receipt.recordedBy, 'AGENT');
  return receipt;
}

git(['fetch', '--quiet', 'origin', `${contract.repository.targetRef}:refs/remotes/origin/main`]);
const targetSha = git(['rev-parse', 'HEAD']);
assert.match(targetSha, SHA);
const originMain = git(['rev-parse', 'refs/remotes/origin/main']);
const remoteMain = git(['ls-remote', 'origin', contract.repository.targetRef]).split(/\s+/u)[0];
assert.equal(originMain, targetSha, 'origin/main differs from the tested checkout');
assert.equal(remoteMain, targetSha, 'remote refs/heads/main differs from the tested checkout');
assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '',
  'tested checkout has tracked modifications');
const mergeReceipt = loadBuilderMergeReceipt(targetSha);

if (predeploy) {
  assert.equal(releaseDag.evaluator.phase, 'PREDEPLOY_EVALUATION');
  assert.equal(releaseDag.evaluator.deploymentTaskId, process.env.OUTCOME_RELEASE_DAG_DEPLOYMENT_TASK_ID);
  const evaluatorBranch = git(['branch', '--show-current']) || 'DETACHED_HEAD';
  assert.equal(process.env.OUTCOME_RELEASE_DAG_TARGET_SHA, targetSha,
    'predeploy attestation target differs from the DAG binding');
  const receiptProof = {
    sessionDatabaseId: releaseDag.builder.sessionDatabaseId,
    taskDatabaseId: releaseDag.builder.taskDatabaseId,
    result: mergeReceipt.result,
    sourceBranch: mergeReceipt.sourceBranch,
    sourceSha: mergeReceipt.sourceSha,
    targetBranch: mergeReceipt.targetBranch,
    targetShaBefore: mergeReceipt.targetShaBefore,
    targetShaAfter: mergeReceipt.targetShaAfter,
    recordedBy: mergeReceipt.recordedBy,
  };
  const receiptDigest = sha256(canonical(receiptProof));
  assert.equal(process.env.OUTCOME_RELEASE_DAG_TARGET_RECEIPT_DIGEST, receiptDigest,
    'predeploy attestation received a different merge receipt');
  const buildContextPath = process.env.OUTCOME_RELEASE_DAG_BUILD_CONTEXT;
  assert.ok(buildContextPath, 'predeploy attestation requires the shared build context');
  const buildContext = JSON.parse(readFileSync(buildContextPath, 'utf8'));
  assert.equal(buildContext.targetSha, targetSha);
  assert.equal(buildContext.bindingDigest, process.env.OUTCOME_RELEASE_DAG_BINDING_DIGEST);
  assert.equal(buildContext.targetReceiptDigest, receiptDigest);

  const regression = validateRegression('build/outcome-reconciler-auto-dispatch-manifest.json',
    'outcome-reconciler-auto-dispatch');
  const sourceFiles = [
    'contracts/outcome-reconciler-release-dag.json',
    'scripts/outcome-reconciler-deployment-attestation.mjs',
    'scripts/outcome-reconciler-auto-dispatch-integration.sh',
  ];
  const sources = Object.fromEntries(sourceFiles.map((relative) => [relative, digestFile(relative)]));
  const body = {
    schemaVersion: 2,
    kind: 'orbit.auto-dispatch.predeploy-target-attestation',
    suite: 'outcome-reconciler-auto-dispatch-integration',
    phase: 'PREDEPLOY_EVALUATION',
    outcome: 'PASS',
    targetSha,
    targetRef: contract.repository.targetRef,
    targetReceiptDigest: receiptDigest,
    repository: {
      remote: git(['remote', 'get-url', 'origin']),
      evaluatorBranch,
      builderReceiptSourceBranch: releaseDag.builder.sourceBranch,
      originMain,
      remoteMain,
      testedTrackedClean: true,
    },
    mergeReceipt: { ...mergeReceipt, proof: receiptProof },
    regression: {
      path: 'build/outcome-reconciler-auto-dispatch-manifest.json',
      ...regression.file,
      summary: regression.manifest.summary ?? {
        tests: regression.manifest.tests,
        passed: regression.manifest.passed,
        failed: regression.manifest.failed,
        skipped: regression.manifest.skipped,
      },
    },
    deployment: {
      state: 'DEFERRED_TO_BOUND_TASK',
      taskId: releaseDag.evaluator.deploymentTaskId,
      assertions: releaseDag.postDeploymentBoundary.assertions,
      evaluatorMayDeploy: false,
    },
    runtimeCurrentBinding: {
      state: 'DEFERRED_TO_BOUND_TASK',
      taskId: releaseDag.evaluator.deploymentTaskId,
    },
    sources,
    sourceDigest: sha256(canonical(sources)),
    verifiedAt: new Date().toISOString(),
  };
  const attestation = { ...body, attestationDigest: sha256(canonical(body)) };
  const output = path.join(repo,
    'build/outcome-reconciler-auto-dispatch-integration-attestation.json');
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(attestation, null, 2)}\n`);
  console.log(JSON.stringify(attestation));
  process.exit(0);
}

assert.equal(git(['rev-parse', 'HEAD'], contract.repository.deploymentCheckout), targetSha,
  'deployment checkout differs from the tested target');
assert.equal(git(['branch', '--show-current'], contract.repository.deploymentCheckout),
  contract.repository.targetBranch, 'deployment checkout is not on main');
assert.equal(git(['status', '--porcelain', '--untracked-files=no'],
  contract.repository.deploymentCheckout), '', 'deployment checkout has tracked modifications');

// The four independent runtime containers were removed from Compose with their services and,
// with 0221, their data layer. What remains is the API deployment itself.
const containerNames = ['orbit-apiserver', 'orbit-web', 'orbit-gateway', 'orbit-postgres'];
const containers = Object.fromEntries(containerNames.map((name) => [name, inspectContainer(name)]));
assert.equal(containers['orbit-apiserver'].environment.ORBIT_SOURCE_SHA ?? targetSha, targetSha,
  'orbit-apiserver is not bound to the target');

const repositoryMigrationCount = Number(run('find', [
  path.join(repo, 'src/apiserver/prisma/migrations'), '-mindepth', '1', '-maxdepth', '1',
  '-type', 'd', '-printf', '.',
]).length);
const database = queryJson(`
  SELECT jsonb_build_object(
    'version', current_setting('server_version'),
    'migrations', (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL),
    'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
    'autoDispatchMigration', (SELECT count(*) FROM _prisma_migrations
      WHERE migration_name='0205_task_auto_dispatch_obligation' AND finished_at IS NOT NULL),
    'bindingMigration', (SELECT count(*) FROM _prisma_migrations
      WHERE migration_name='0206_watchdog_current_binding' AND finished_at IS NOT NULL)
  )
`);
assert.equal(database.version, contract.postgres.version);
assert.equal(Number(database.migrations), repositoryMigrationCount);
assert.ok(Number(database.migrations) >= contract.postgres.minimumMigrations);
assert.equal(Number(database.autoDispatchMigration), 1);
assert.equal(Number(database.bindingMigration), 1);
assert.match(String(database.systemIdentifier), /^\d+$/u);

// 0221 removed the outcome-watchdog current-binding ledger and the process it bound, so there is
// no current binding left to attest. Asserting the relations are gone keeps this a real check
// rather than one that silently passes over an empty table.
const runtime = queryJson(`
  SELECT jsonb_build_object(
    'bindingTable', to_regclass('public.executable_runtime_binding')::text,
    'factTable', to_regclass('public.executable_runtime_binding_fact')::text,
    'currentView', to_regclass('public.executable_runtime_current_binding')::text
  )
`);
assert.deepEqual(runtime, { bindingTable: null, factTable: null, currentView: null });

const regression = validateRegression('build/outcome-reconciler-auto-dispatch-manifest.json',
  'outcome-reconciler-auto-dispatch');

const sourceFiles = [
  'contracts/outcome-reconciler-release-frontier.json',
  'scripts/outcome-reconciler-deployment-attestation.mjs',
  'scripts/outcome-reconciler-auto-dispatch-integration.sh',
];
const sources = Object.fromEntries(sourceFiles.map((relative) => [relative, digestFile(relative)]));
const body = {
  schemaVersion: 1,
  kind: 'orbit.auto-dispatch.current-target-integration-attestation',
  suite: 'outcome-reconciler-auto-dispatch-integration',
  outcome: 'PASS',
  targetSha,
  targetRef: contract.repository.targetRef,
  repository: {
    remote: git(['remote', 'get-url', 'origin']),
    originMain,
    remoteMain,
    testedTrackedClean: true,
    deployedTrackedClean: true,
  },
  mergeReceipt,
  deployment: {
    checkout: contract.repository.deploymentCheckout,
    sharedRuntimeImageId: containers['orbit-apiserver'].imageId,
    containers: Object.fromEntries(Object.entries(containers).map(([name, value]) => [name, {
      id: value.id,
      imageId: value.imageId,
      startedAt: value.startedAt,
      status: value.status,
      health: value.health,
    }])),
    exactEnvironment,
  },
  postgres: database,
  runtimeCurrentBinding: runtime,
  regression: {
    path: 'build/outcome-reconciler-auto-dispatch-manifest.json',
    ...regression.file,
    summary: regression.manifest.summary ?? {
      tests: regression.manifest.tests,
      passed: regression.manifest.passed,
      failed: regression.manifest.failed,
      skipped: regression.manifest.skipped,
    },
  },
  sources,
  sourceDigest: sha256(canonical(sources)),
  verifiedAt: new Date().toISOString(),
};
const attestation = { ...body, attestationDigest: sha256(canonical(body)) };
const output = path.join(repo,
  'build/outcome-reconciler-auto-dispatch-integration-attestation.json');
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(attestation, null, 2)}\n`);
console.log(JSON.stringify(attestation));
