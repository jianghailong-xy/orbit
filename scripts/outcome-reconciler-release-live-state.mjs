#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const repo = path.resolve(import.meta.dirname, '..');
const contractPath = 'contracts/outcome-reconciler-release-frontier.json';
const contract = JSON.parse(readFileSync(path.join(repo, contractPath), 'utf8'));
const releaseDagPath = 'contracts/outcome-reconciler-release-dag.json';
const releaseDag = JSON.parse(readFileSync(path.join(repo, releaseDagPath), 'utf8'));
const predeploy = process.env.OUTCOME_RELEASE_DAG_ACTIVE === '1'
  && process.env.OUTCOME_RELEASE_DAG_PHASE === 'PREDEPLOY_EVALUATION';
const output = path.resolve(process.argv[2]
  ?? path.join(repo, 'build/outcome-reconciler-release-live-state-manifest.json'));

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

function hashCommandOutput(file, args, cwd = repo) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const child = spawn(file, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = [];
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };

    child.stdout.on('data', (chunk) => hash.update(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code, signal) => finish(() => {
      if (code !== 0) {
        reject(new Error(
          `${file} ${args.join(' ')} exited with ${code ?? signal}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
        ));
        return;
      }
      resolve(hash.digest('hex'));
    }));
  });
}

function fileEvidence(relative) {
  const absolute = path.join(repo, relative);
  assert.ok(existsSync(absolute) && statSync(absolute).isFile(), `${relative} is missing`);
  const raw = readFileSync(absolute);
  return { bytes: raw.byteLength, sha256: sha256(raw) };
}

function queryJson(sql) {
  const raw = run('docker', [
    'exec', 'orbit-postgres', 'psql', '-U', 'orbit', '-d', 'orbit',
    '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql,
  ]);
  assert.ok(raw, 'production evidence query returned no row');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `production evidence query returned ${lines.length} rows`);
  return JSON.parse(lines[0]);
}

function inspectContainer(name) {
  const [container] = JSON.parse(run('docker', ['inspect', name]));
  assert.ok(container?.State?.Running, `${name} is not running`);
  if (container.State.Health) assert.equal(container.State.Health.Status, 'healthy');
  const environment = Object.fromEntries((container.Config.Env ?? []).map((entry) => {
    const split = entry.indexOf('=');
    return split < 0 ? [entry, ''] : [entry.slice(0, split), entry.slice(split + 1)];
  }));
  return {
    id: container.Id,
    imageId: container.Image,
    startedAt: container.State.StartedAt,
    health: container.State.Health?.Status ?? 'RUNNING_NO_HEALTHCHECK',
    environment,
  };
}

assert.equal(contract.schemaVersion, 1);
assert.equal(contract.namedSuites.length, 17, 'the independent verifier named exactly 17 suites');
assert.equal(contract.restoredSuites.length, 6, 'the independent verifier named exactly six missing suites');
const packageJson = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
for (const suite of [...contract.namedSuites, ...contract.restoredSuites, ...contract.fullMatrices]) {
  assert.ok(packageJson.scripts?.[suite.packageScript], `${suite.packageScript} is missing`);
  assert.ok(fileEvidence(suite.manifest).bytes > 0, `${suite.manifest} is empty`);
}
assert.equal(
  packageJson.scripts['test:outcome-reconciler:release-frontier'],
  'npm run test:outcome-reconciler:release-dag',
);

if (predeploy) {
  assert.equal(releaseDag.evaluator.phase, 'PREDEPLOY_EVALUATION');
  assert.equal(releaseDag.evaluator.deploymentTaskId,
    process.env.OUTCOME_RELEASE_DAG_DEPLOYMENT_TASK_ID);
  git(['fetch', '--quiet', 'origin', `${contract.repository.targetRef}:refs/remotes/origin/main`]);
  const targetSha = git(['rev-parse', 'HEAD']);
  const originMain = git(['rev-parse', 'refs/remotes/origin/main']);
  const remoteMain = git(['ls-remote', 'origin', contract.repository.targetRef]).split(/\s+/u)[0];
  assert.match(targetSha, SHA);
  assert.equal(originMain, targetSha);
  assert.equal(remoteMain, targetSha);
  assert.equal(process.env.OUTCOME_RELEASE_DAG_TARGET_SHA, targetSha);
  const evaluatorBranch = git(['branch', '--show-current']) || 'DETACHED_HEAD';
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '');

  const mergeReceipt = queryJson(`
    SELECT jsonb_build_object(
      'result', result, 'sourceBranch', source_branch,
      'sourceSha', btrim(source_sha::text), 'targetBranch', target_branch,
      'targetShaBefore', btrim(target_sha_before::text),
      'targetShaAfter', btrim(target_sha_after::text), 'recordedBy', recorded_by
    )
      FROM session_merge_receipt
     WHERE session_id='${releaseDag.builder.sessionDatabaseId}'::uuid
       AND task_id='${releaseDag.builder.taskDatabaseId}'::uuid
       AND source_branch='${releaseDag.builder.sourceBranch}'
       AND source_sha='${targetSha}'::char(40)
       AND target_branch='${contract.repository.targetBranch}'
       AND target_sha_after='${targetSha}'::char(40)
       AND recorded_by='AGENT'
       AND result IN ('MERGED','ALREADY_MERGED')
     ORDER BY created_at DESC LIMIT 1
  `);
  assert.match(mergeReceipt.targetShaBefore, SHA);
  if (mergeReceipt.result === 'MERGED') assert.notEqual(mergeReceipt.targetShaBefore, targetSha);
  else assert.equal(mergeReceipt.targetShaBefore, targetSha);
  const receiptProof = {
    sessionDatabaseId: releaseDag.builder.sessionDatabaseId,
    taskDatabaseId: releaseDag.builder.taskDatabaseId,
    ...mergeReceipt,
  };
  const targetReceiptDigest = sha256(canonical(receiptProof));
  assert.equal(targetReceiptDigest, process.env.OUTCOME_RELEASE_DAG_TARGET_RECEIPT_DIGEST);

  const aggregatePath = path.join(repo, 'build/outcome-reconciler-release-dag-manifest.json');
  const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8'));
  assert.equal(aggregate.outcome, 'PASS');
  for (const [field, environmentName] of Object.entries({
    targetSha: 'OUTCOME_RELEASE_DAG_TARGET_SHA',
    targetReceiptDigest: 'OUTCOME_RELEASE_DAG_TARGET_RECEIPT_DIGEST',
    environmentDigest: 'OUTCOME_RELEASE_DAG_ENVIRONMENT_DIGEST',
    evaluationPlanDigest: 'OUTCOME_RELEASE_DAG_EVALUATION_PLAN_DIGEST',
    dagPlanDigest: 'OUTCOME_RELEASE_DAG_PLAN_DIGEST',
    evidenceCutDigest: 'OUTCOME_RELEASE_DAG_EVIDENCE_CUT_DIGEST',
    bindingDigest: 'OUTCOME_RELEASE_DAG_BINDING_DIGEST',
  })) {
    assert.equal(aggregate[field], process.env[environmentName], `aggregate has stale ${field}`);
  }
  assert.equal(aggregate.logicalSummary.failed, 0);
  assert.equal(aggregate.logicalSummary.skipped, 0);
  assert.equal(aggregate.logicalSummary.passed, aggregate.logicalSummary.tests);
  const { manifestDigest, ...aggregateBody } = aggregate;
  assert.equal(manifestDigest, sha256(canonical(aggregateBody)));

  const targetContentDigest = await hashCommandOutput('git', ['archive', targetSha]);
  const targetDigest = sha256(canonical({
    repositoryProvider: contract.repository.provider,
    repositoryId: contract.repository.id,
    targetRef: contract.repository.targetRef,
    targetSha,
    targetContentDigest,
  }));
  const sourceFiles = [contractPath, releaseDagPath, 'scripts/outcome-reconciler-release-live-state.mjs'];
  const sources = Object.fromEntries(sourceFiles.map((relative) => [relative, fileEvidence(relative)]));
  const body = {
    schemaVersion: 2,
    kind: 'orbit.outcome-reconciler.release-live-state-predeploy-boundary',
    phase: 'PREDEPLOY_EVALUATION',
    outcome: 'PASS',
    targetSha,
    targetRef: contract.repository.targetRef,
    targetContentDigest,
    targetDigest,
    targetReceiptDigest,
    repository: {
      originMain,
      remoteMain,
      evaluatorBranch,
      builderReceiptSourceBranch: releaseDag.builder.sourceBranch,
      trackedClean: true,
    },
    mergeReceipt: { ...mergeReceipt, proof: receiptProof },
    aggregateManifest: {
      path: path.relative(repo, aggregatePath),
      digest: aggregate.manifestDigest,
      bindingDigest: aggregate.bindingDigest,
      logicalSummary: aggregate.logicalSummary,
    },
    deployment: {
      state: 'DEFERRED_TO_BOUND_TASK',
      taskId: releaseDag.evaluator.deploymentTaskId,
      assertions: releaseDag.postDeploymentBoundary.assertions,
      evaluatorMayDeploy: false,
    },
    currentBinding: {
      state: 'DEFERRED_TO_BOUND_TASK',
      taskId: releaseDag.evaluator.deploymentTaskId,
      requiredEvidenceCutDigest: aggregate.evidenceCutDigest,
    },
    sources,
    sourceDigest: sha256(canonical(sources)),
    verifiedAt: new Date().toISOString(),
  };
  const manifest = { ...body, artifactDigest: sha256(canonical(body)) };
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest));
  process.exit(0);
}

git(['fetch', '--quiet', 'origin', `${contract.repository.targetRef}:refs/remotes/origin/main`]);
const targetSha = git(['rev-parse', 'HEAD']);
assert.match(targetSha, SHA);
const refs = {
  head: targetSha,
  originMain: git(['rev-parse', 'refs/remotes/origin/main']),
  remoteMain: git(['ls-remote', 'origin', contract.repository.targetRef]).split(/\s+/u)[0],
  deployedHead: git(['rev-parse', 'HEAD'], contract.repository.deploymentCheckout),
};
for (const [name, value] of Object.entries(refs)) {
  assert.match(value, SHA, `${name} is not a full SHA`);
  assert.equal(value, targetSha, `${name} differs from the release target`);
}
assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '',
  'release verification checkout has tracked modifications');
assert.equal(git(['status', '--porcelain', '--untracked-files=no'],
  contract.repository.deploymentCheckout), '', 'deployment checkout has tracked modifications');
assert.equal(git(['branch', '--show-current'], contract.repository.deploymentCheckout),
  contract.repository.targetBranch);
// A release archive is intentionally much larger than child_process's default
// one-megabyte synchronous output buffer. Hash the stream so repository growth
// cannot turn an otherwise valid release into an ENOBUFS failure.
const targetContentDigest = await hashCommandOutput('git', ['archive', targetSha]);
const targetDigest = sha256(canonical({
  repositoryProvider: contract.repository.provider,
  repositoryId: contract.repository.id,
  targetRef: contract.repository.targetRef,
  targetSha,
  targetContentDigest,
}));

const containerNames = [
  'orbit-apiserver', 'orbit-web', 'orbit-gateway', 'orbit-postgres', 'orbit-watchdog',
  'orbit-outcome-coordinator', 'orbit-outcome-coordinator-secondary',
  'orbit-executable-dead-man',
];
const containers = Object.fromEntries(containerNames.map((name) => [name, inspectContainer(name)]));
const sharedRuntimeNames = [
  'orbit-apiserver', 'orbit-watchdog', 'orbit-outcome-coordinator',
  'orbit-outcome-coordinator-secondary', 'orbit-executable-dead-man',
];
assert.equal(new Set(sharedRuntimeNames.map((name) => containers[name].imageId)).size, 1);
assert.equal(containers['orbit-watchdog'].environment.OUTCOME_WATCHDOG_COLLECTOR_SHA, targetSha);
assert.equal(containers['orbit-watchdog'].environment.OUTCOME_WATCHDOG_TARGET_SHA, targetSha);
assert.equal(containers['orbit-watchdog'].environment.OUTCOME_WATCHDOG_TARGET_REF,
  contract.repository.targetRef);
assert.equal(containers['orbit-outcome-coordinator'].environment.OUTCOME_COORDINATOR_SOURCE_SHA,
  targetSha);
assert.equal(containers['orbit-outcome-coordinator'].environment.OUTCOME_COORDINATOR_TARGET_SHA,
  targetSha);
assert.equal(containers['orbit-outcome-coordinator-secondary']
  .environment.OUTCOME_COORDINATOR_SOURCE_SHA, targetSha);
assert.equal(containers['orbit-outcome-coordinator-secondary']
  .environment.OUTCOME_COORDINATOR_TARGET_SHA, targetSha);
assert.equal(containers['orbit-executable-dead-man'].environment.EXECUTABLE_DEAD_MAN_SOURCE_SHA,
  targetSha);

const repositoryMigrations = Number(run('find', [
  path.join(repo, 'src/apiserver/prisma/migrations'), '-mindepth', '1', '-maxdepth', '1',
  '-type', 'd', '-printf', '.',
]).length);
const database = queryJson(`
  SELECT jsonb_build_object(
    'version', current_setting('server_version'),
    'migrations', (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL),
    'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system())
  )
`);
assert.equal(database.version, contract.postgres.version);
assert.equal(Number(database.migrations), repositoryMigrations);
assert.ok(Number(database.migrations) >= contract.postgres.minimumMigrations);
assert.match(String(database.systemIdentifier), /^\d+$/u);

const ratification = queryJson(`
  SELECT jsonb_build_object(
    'id', ratification.id::text,
    'ownerId', ratification.owner_id::text,
    'projectId', ratification.project_id::text,
    'contractDigest', btrim(ratification.contract_digest::text),
    'contractRevision', ratification.contract_revision::text,
    'evaluationPlanDigest', btrim(ratification.evaluation_plan_digest_at_decision::text),
    'source', ratification.source,
    'ratifiedByType', ratification.ratified_by_type,
    'ratifiedById', ratification.ratified_by_id,
    'ratifiedAt', ratification.ratified_at,
    'currentContractDigest', btrim(contract.contract_digest::text),
    'currentContractRevision', contract.contract_revision::text,
    'currentEvaluationPlanDigest', btrim(contract.evaluation_plan_digest::text),
    'effective', project_owner_ratification_effective(
      ratification.project_id, ratification.contract_digest::text)
  )
    FROM project_owner_ratification ratification
    JOIN project_completion_contract contract ON contract.project_id=ratification.project_id
   WHERE ratification.id='${contract.ownerRatification.databaseId}'::uuid
`);
assert.equal(ratification.ownerId, contract.ownerRatification.ownerDatabaseId);
assert.equal(ratification.projectId, contract.project.databaseId);
assert.equal(ratification.contractDigest, contract.ownerRatification.contractDigest);
assert.equal(ratification.contractRevision, contract.ownerRatification.contractRevision);
assert.equal(ratification.evaluationPlanDigest, contract.ownerRatification.evaluationPlanDigest);
assert.equal(ratification.currentContractDigest, contract.ownerRatification.contractDigest,
  'the owner semantic contract changed');
assert.equal(ratification.currentContractRevision, contract.ownerRatification.contractRevision,
  'the owner semantic contract revision changed');
assert.equal(ratification.currentEvaluationPlanDigest,
  contract.ownerRatification.evaluationPlanDigest, 'the evaluation plan changed');
assert.equal(ratification.source, 'OWNER');
assert.equal(ratification.ratifiedByType, 'OWNER');
assert.equal(ratification.ratifiedById, contract.ownerRatification.ownerDatabaseId);
assert.equal(ratification.effective, true, 'the declared Owner Ratification is not effective');

const immutableVerifier = queryJson(`
  SELECT jsonb_build_object(
    'evidenceId', evidence.id::text,
    'evidenceDigest', btrim(evidence.evidence_digest::text),
    'revision', evidence.revision::text,
    'taskId', task.id::text,
    'status', task.status::text,
    'verdict', task.verdict::text,
    'supersededByTaskId', task.superseded_by_task_id::text
  )
    FROM task_completion_evidence evidence
    JOIN task ON task.id=evidence.task_id
   WHERE evidence.evidence_digest='${contract.immutableVerifier.evidenceDigest}'::char(64)
   ORDER BY evidence.revision DESC LIMIT 1
`);
assert.equal(immutableVerifier.evidenceDigest, contract.immutableVerifier.evidenceDigest);
assert.equal(immutableVerifier.status, contract.immutableVerifier.expectedStatus);
assert.equal(immutableVerifier.verdict, contract.immutableVerifier.expectedVerdict);
assert.equal(immutableVerifier.supersededByTaskId, null);

const releaseEvidence = queryJson(`
  SELECT jsonb_build_object(
    'id', evidence.id::text,
    'evidenceDigest', btrim(evidence.evidence_digest::text),
    'revision', evidence.revision::text,
    'submittedAt', evidence.submitted_at,
    'sourceSessionId', evidence.source_session_id::text,
    'evidence', evidence.evidence
  )
    FROM task_completion_evidence evidence
   WHERE evidence.task_id='${contract.task.databaseId}'::uuid
     AND evidence.source_session_id='${contract.session.databaseId}'::uuid
     AND evidence.evidence->>'kind'='orbit.outcome-reconciler.release-frontier-prebinding'
     AND evidence.evidence->>'targetSha'='${targetSha}'
   ORDER BY evidence.revision DESC LIMIT 1
`);
assert.match(releaseEvidence.evidenceDigest, DIGEST);
assert.equal(releaseEvidence.sourceSessionId, contract.session.databaseId);
assert.equal(releaseEvidence.evidence.schemaVersion, 1);
assert.equal(releaseEvidence.evidence.projectId, contract.project.publicId);
assert.equal(releaseEvidence.evidence.taskId, contract.task.publicId);
assert.equal(releaseEvidence.evidence.sessionId, contract.session.publicId);
assert.equal(releaseEvidence.evidence.targetSha, targetSha);
assert.equal(releaseEvidence.evidence.targetRef, contract.repository.targetRef);
assert.equal(releaseEvidence.evidence.targetContentDigest, targetContentDigest);
assert.match(releaseEvidence.evidence.artifactDigest, DIGEST);

const mergeReceipt = queryJson(`
  SELECT jsonb_build_object(
    'id', receipt.id::text, 'result', receipt.result,
    'sourceBranch', receipt.source_branch, 'sourceSha', btrim(receipt.source_sha::text),
    'targetBranch', receipt.target_branch,
    'targetShaBefore', btrim(receipt.target_sha_before::text),
    'targetShaAfter', btrim(receipt.target_sha_after::text),
    'recordedBy', receipt.recorded_by, 'createdAt', receipt.created_at
  )
    FROM session_merge_receipt receipt
   WHERE receipt.session_id='${contract.session.databaseId}'::uuid
     AND receipt.source_branch='${contract.session.sourceBranch}'
     AND receipt.source_sha='${targetSha}'::char(40)
     AND receipt.target_branch='${contract.repository.targetBranch}'
     AND receipt.target_sha_after='${targetSha}'::char(40)
     AND receipt.result IN ('MERGED','ALREADY_MERGED')
   ORDER BY receipt.created_at DESC LIMIT 1
`);
assert.equal(mergeReceipt.sourceSha, targetSha);
assert.equal(mergeReceipt.targetShaAfter, targetSha);
assert.match(mergeReceipt.targetShaBefore, SHA);
if (mergeReceipt.result === 'MERGED') assert.notEqual(mergeReceipt.targetShaBefore, targetSha);
else assert.equal(mergeReceipt.targetShaBefore, targetSha);

const canonicalState = queryJson(`
  WITH current_binding AS (
    SELECT * FROM outcome_fact_binding
     WHERE tenant_id='${contract.ownerRatification.ownerDatabaseId}'::uuid
       AND project_id='${contract.project.databaseId}'::uuid
     ORDER BY binding_epoch DESC LIMIT 1
  ), current_evaluation AS (
    SELECT evaluation.* FROM outcome_evaluator_result evaluation
    JOIN current_binding binding USING (tenant_id,project_id,binding_digest)
     WHERE evaluation.subject_type='PROJECT'
       AND evaluation.subject_id='${contract.project.databaseId}'
     ORDER BY evaluation.watermark_logical_time DESC, evaluation.committed_at DESC LIMIT 1
  ), fact_summary AS (
    SELECT jsonb_build_object(
      'count', count(*),
      'dimensionCount', count(DISTINCT fact.payload->>'dimensionId'),
      'evidenceDigests', jsonb_agg(DISTINCT fact.payload->>'releaseEvidenceDigest'),
      'evidenceIds', jsonb_agg(DISTINCT fact.payload->>'releaseEvidenceId'),
      'targetShas', jsonb_agg(DISTINCT fact.payload->>'targetSha'),
      'artifactDigests', jsonb_agg(DISTINCT fact.payload->>'artifactDigest'),
      'pendingDimensions', COALESCE(jsonb_agg(fact.payload->>'dimensionId')
        FILTER (WHERE fact.payload->>'state'='UNSATISFIED'), '[]'::jsonb),
      'pendingReasons', COALESCE(jsonb_agg(fact.payload->>'reasonCode')
        FILTER (WHERE fact.payload->>'state'='UNSATISFIED'), '[]'::jsonb),
      'nonTerminalCount', count(*) FILTER (
        WHERE fact.payload->>'state' NOT IN ('SATISFIED','NOT_APPLICABLE'))
    ) AS value
      FROM outcome_canonical_fact fact
      JOIN current_binding binding USING (tenant_id,project_id,binding_digest)
     WHERE fact.fact_kind='DIMENSION_EVALUATED'
  ), delivery AS (
    SELECT jsonb_build_object(
      'deliveryBindingDigest', binding.delivery_binding_digest::text,
      'bindingRevisionDigest', binding.binding_revision_digest::text,
      'targetSha', binding.current_target_sha,
      'targetContentDigest', binding.current_target_content_digest::text,
      'artifactDigest', binding.artifact_digest::text,
      'attestationCount', (SELECT count(*) FROM outcome_delivery_attestation attestation
        WHERE attestation.tenant_id=binding.tenant_id
          AND attestation.project_id=binding.project_id
          AND attestation.binding_revision_digest=binding.binding_revision_digest
          AND attestation.result IN ('INTEGRATED','ALREADY_INTEGRATED')),
      'verificationCount', (SELECT count(*) FROM outcome_delivery_verification verification
        WHERE verification.tenant_id=binding.tenant_id
          AND verification.project_id=binding.project_id
          AND verification.binding_revision_digest=binding.binding_revision_digest
          AND verification.result='PASS' AND verification.exit_code=0
          AND verification.skip_count=0)
    ) AS value
      FROM outcome_delivery_binding binding
      JOIN current_binding canonical
        ON canonical.tenant_id=binding.tenant_id AND canonical.project_id=binding.project_id
       AND canonical.binding_digest=binding.canonical_binding_digest
     ORDER BY binding.binding_sequence DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'binding', (SELECT jsonb_build_object(
      'digest', binding_digest::text, 'epoch', binding_epoch::text,
      'targetDigest', target_digest::text, 'targetRef', target_ref,
      'binding', binding
    ) FROM current_binding),
    'evaluation', (SELECT jsonb_build_object(
      'id', evaluation_id::text, 'cutId', cut_id::text,
      'watermarkLogicalTime', watermark_logical_time::text,
      'evaluatorDigest', evaluator_digest::text,
      'proofDigest', proof_digest::text, 'closed', is_closed,
      'factCutDigest', result#>>'{proof,factCutDigest}',
      'modelGaps', result#>'{proof,modelGaps}',
      'activeMandatoryObligations', result->'activeMandatoryObligations'
    ) FROM current_evaluation),
    'cut', (SELECT jsonb_build_object(
      'id', cut.cut_id::text, 'bindingDigest', cut.binding_digest::text,
      'watermarkLogicalTime', cut.watermark_logical_time::text,
      'factCount', cut.fact_count, 'proofFactCount', cut.proof_fact_count,
      'factSetDigest', cut.fact_set_digest::text,
      'complete', cut.complete, 'linearizable', cut.linearizable
    ) FROM outcome_evaluation_cut cut JOIN current_evaluation evaluation
      ON evaluation.tenant_id=cut.tenant_id AND evaluation.project_id=cut.project_id
     AND evaluation.cut_id=cut.cut_id),
    'facts', (SELECT value FROM fact_summary),
    'delivery', (SELECT value FROM delivery),
    'doneGate', project_canonical_done_gate(
      '${contract.project.databaseId}'::uuid, 'PROJECT', '${contract.project.databaseId}')
  )
`);
assert.ok(canonicalState.binding);
assert.match(canonicalState.binding.digest, DIGEST);
assert.equal(canonicalState.binding.targetDigest, targetDigest);
assert.equal(canonicalState.binding.targetRef, contract.repository.targetRef);
assert.equal(canonicalState.binding.binding.contractDigest,
  contract.ownerRatification.contractDigest);
assert.equal(canonicalState.binding.binding.evaluationPlanDigest,
  contract.ownerRatification.evaluationPlanDigest);
assert.equal(canonicalState.binding.binding.artifactDigest,
  releaseEvidence.evidence.artifactDigest);
assert.equal(canonicalState.binding.binding.targetDigest, targetDigest);
assert.equal(canonicalState.binding.binding.targetRef, contract.repository.targetRef);
assert.equal(canonicalState.cut.bindingDigest, canonicalState.binding.digest);
assert.equal(canonicalState.cut.id, canonicalState.evaluation.cutId);
assert.equal(canonicalState.cut.watermarkLogicalTime,
  canonicalState.evaluation.watermarkLogicalTime);
assert.equal(canonicalState.cut.complete, true);
assert.equal(canonicalState.cut.linearizable, true);
assert.equal(canonicalState.cut.factCount, 15);
assert.equal(canonicalState.cut.proofFactCount, 15);
assert.equal(canonicalState.cut.factSetDigest, canonicalState.evaluation.factCutDigest);
assert.equal(canonicalState.evaluation.closed, false,
  'the independent target verifier is still a real successor obligation');
assert.deepEqual(canonicalState.evaluation.modelGaps, []);
assert.equal(Number(canonicalState.facts.count), 15);
assert.equal(Number(canonicalState.facts.dimensionCount), 15);
assert.deepEqual(canonicalState.facts.evidenceDigests, [releaseEvidence.evidenceDigest]);
assert.deepEqual(canonicalState.facts.evidenceIds, [releaseEvidence.id]);
assert.deepEqual(canonicalState.facts.targetShas, [targetSha]);
assert.deepEqual(canonicalState.facts.artifactDigests,
  [releaseEvidence.evidence.artifactDigest]);
assert.deepEqual(canonicalState.facts.pendingDimensions,
  [contract.canonicalBinding.pendingDimension]);
assert.deepEqual(canonicalState.facts.pendingReasons,
  [contract.canonicalBinding.pendingReasonCode]);
assert.equal(Number(canonicalState.facts.nonTerminalCount), 1);
assert.equal(canonicalState.delivery.targetSha, targetSha);
assert.equal(canonicalState.delivery.targetContentDigest, targetContentDigest);
assert.equal(canonicalState.delivery.artifactDigest, releaseEvidence.evidence.artifactDigest);
assert.ok(Number(canonicalState.delivery.attestationCount) >= 1);
assert.ok(Number(canonicalState.delivery.verificationCount) >= 1);
assert.notEqual(canonicalState.doneGate?.reason?.code, 'CURRENT_BINDING_MISSING');
assert.equal(canonicalState.doneGate?.canonicalIdentity?.bindingDigest,
  canonicalState.binding.digest);
assert.equal(canonicalState.doneGate?.canonicalIdentity?.cutId, canonicalState.cut.id);
assert.equal(canonicalState.doneGate?.ratification?.effectiveNow, true);
assert.equal(canonicalState.doneGate?.ratification?.currentContractDigest,
  contract.ownerRatification.contractDigest);
assert.equal(canonicalState.doneGate?.ratification?.boundContractDigest,
  contract.ownerRatification.contractDigest);

const runtimeBinding = queryJson(`
  SELECT jsonb_build_object(
    'count', count(*), 'bindingDigest', min(binding_digest::text),
    'generation', min(expectation_generation::text), 'instanceId', min(instance_id),
    'sourceSha', min(source_sha), 'targetSha', min(target_sha), 'targetRef', min(target_ref),
    'state', min(state), 'heartbeatSequence', min(heartbeat_sequence)::text,
    'registeredLogicalTime', min(registered_logical_time)::text,
    'evaluatedThroughLogicalTime', min(evaluated_through_logical_time)::text,
    'heartbeatFacts', (SELECT count(*) FROM executable_runtime_binding_fact fact
      WHERE fact.kind='HEARTBEAT_INGESTED'
        AND fact.binding_digest=(SELECT binding_digest FROM executable_runtime_current_binding LIMIT 1))
  ) FROM executable_runtime_current_binding
`);
assert.equal(Number(runtimeBinding.count), 1);
assert.match(runtimeBinding.bindingDigest, DIGEST);
assert.equal(runtimeBinding.instanceId, 'compose:outcome-watchdog');
assert.equal(runtimeBinding.sourceSha, targetSha);
assert.equal(runtimeBinding.targetSha, targetSha);
assert.equal(runtimeBinding.targetRef, contract.repository.targetRef);
assert.equal(runtimeBinding.state, 'HEALTHY');
assert.ok(Number(runtimeBinding.heartbeatFacts) >= 2);
assert.ok(BigInt(runtimeBinding.evaluatedThroughLogicalTime)
  > BigInt(runtimeBinding.registeredLogicalTime));

const sourceFiles = [
  contractPath,
  releaseDagPath,
  'package.json',
  'scripts/outcome-reconciler-release-frontier.sh',
  'scripts/outcome-reconciler-release-live-state.mjs',
  'scripts/outcome-reconciler-release-frontier-manifest.mjs',
  'scripts/outcome-reconciler-release-publish.mjs',
];
const sources = Object.fromEntries(sourceFiles.map((relative) => [relative, fileEvidence(relative)]));
const body = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-live-state-manifest',
  outcome: 'PASS',
  targetSha,
  targetContentDigest,
  targetDigest,
  refs,
  worktrees: { verificationTrackedClean: true, deploymentTrackedClean: true },
  deployment: {
    sharedRuntimeImageId: containers['orbit-apiserver'].imageId,
    containers: Object.fromEntries(Object.entries(containers).map(([name, value]) => [name, {
      id: value.id,
      imageId: value.imageId,
      startedAt: value.startedAt,
      health: value.health,
    }])),
  },
  postgres: database,
  immutableVerifier,
  ownerRatification: {
    publicId: contract.ownerRatification.publicId,
    ...ratification,
  },
  releaseEvidence,
  mergeReceipt,
  canonicalState,
  runtimeBinding,
  sources,
  sourceDigest: sha256(canonical(sources)),
  verifiedAt: new Date().toISOString(),
};
const manifest = { ...body, manifestDigest: sha256(canonical(body)) };
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
