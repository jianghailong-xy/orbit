#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const deploymentRepo = '/root/orbit';
const artifactPath = path.join(repo, 'build/outcome-reconciler-auto-dispatch-integration-attestation.json');
const regressionPath = path.join(repo, 'build/outcome-reconciler-auto-dispatch-manifest.json');
const mode = process.argv[2] ?? 'verify';

// The source session ran its isolated suite while its clean HEAD was DECLARED_SOURCE_SHA, then
// committed the complete dirty tree as FIX_COMMIT_SHA. Keeping both identities is intentional:
// the former is the SHA required by the task declaration, while only the latter names the bytes
// that can truthfully appear as source_sha in a merge receipt.
const DECLARED_SOURCE_SHA = '38cd86d35040a4fd5a9ce08cfaf43331d1ce2d99';
const FIX_COMMIT_SHA = '577a71b266219014ad8a4ee44e8ab4ee75c4c179';
const SOURCE_BRANCH = 'orbit/ready-autorun-successor-28d986';
const SOURCE_SESSION_ID = '5k9Ewp4pfylzIRFWgQmJx3';
const SOURCE_TASK_ID = '34FGd24hax5lmOVKTY1ZS';
const INTEGRATION_TASK_ID = '34FHy7tBjoBzVG6AytLx0';
const INTEGRATION_SESSION_ID = '5ti975CcEW756tp83MtvOw';
const INTEGRATION_BRANCH = 'orbit/auto-dispatch-sha-e22760';
const RUNNER_PUBLIC_ID = '33aHx39nnWbvJhYO2blSk';
const REAL_REPLAY_TASK_ID = '34EVtJuwMDJkbocbCPllX';
const TARGET_BRANCH = 'main';
const TARGET_REF = 'refs/heads/main';
const EXPECTED_PROVIDER = 'codex';
const APISERVER_IMAGE = 'orbit-apiserver:local';
const ATTESTATION_KIND = 'orbit.auto-dispatch.integration-attestation';

const runtimeFiles = [
  'src/apiserver/dist/common/auto-dispatch-obligation.js',
  'src/apiserver/dist/common/control-plane-obligation.js',
  'src/apiserver/dist/projects/projects.service.js',
  'src/apiserver/dist/runner-api/runner-api.controller.js',
  'src/apiserver/dist/tasks/tasks.service.js',
  'src/apiserver/prisma/migrations/0205_task_auto_dispatch_obligation/migration.sql',
  'src/apiserver/prisma/schema.prisma',
];

const sharedImageContainers = [
  'orbit-apiserver',
  'orbit-watchdog',
  'orbit-outcome-coordinator',
  'orbit-outcome-coordinator-secondary',
  'orbit-executable-dead-man',
];

function run(command, args, { cwd = repo } = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function git(args, cwd = repo) {
  return run('git', args, { cwd });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function digestObject(value) {
  return sha256(canonical(value));
}

function withoutDigest(attestation) {
  const { attestationDigest: _ignored, ...unsigned } = attestation;
  return unsigned;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function inspectContainer(name) {
  const [value] = JSON.parse(run('docker', ['inspect', name]));
  assert.ok(value, `container ${name} is missing`);
  return value;
}

function inspectImage(name) {
  const [value] = JSON.parse(run('docker', ['image', 'inspect', name]));
  assert.ok(value, `image ${name} is missing`);
  return value;
}

function selectedEnvironment(container, names) {
  const wanted = new Set(names);
  return Object.fromEntries((container.Config.Env ?? []).flatMap((entry) => {
    const at = entry.indexOf('=');
    const key = at < 0 ? entry : entry.slice(0, at);
    return wanted.has(key) ? [[key, at < 0 ? '' : entry.slice(at + 1)]] : [];
  }));
}

function queryDatabase(sql) {
  return run('docker', [
    'exec', 'orbit-postgres', 'psql', '-U', 'orbit', '-d', 'orbit', '-X', '-A', '-t',
    '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql,
  ]);
}

function oneDatabaseRow(sql, columns) {
  const output = queryDatabase(sql);
  assert.ok(output, `database evidence query returned zero rows: ${sql}`);
  const rows = output.split('\n').filter(Boolean);
  assert.equal(rows.length, 1, `database evidence query returned ${rows.length} rows`);
  const values = rows[0].split('\t');
  assert.equal(values.length, columns.length, `database evidence row has ${values.length} columns`);
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

function isAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repo,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function cleanTracked(cwd) {
  return git(['status', '--porcelain', '--untracked-files=no'], cwd) === '';
}

function localRuntimeFiles() {
  const files = Object.fromEntries(runtimeFiles.map((relative) => [
    relative,
    sha256(readFileSync(path.join(repo, relative))),
  ]));
  return { files, digest: digestObject(files) };
}

function containerRuntimeFiles(containerName) {
  const absolute = runtimeFiles.map((relative) => `/app/${relative}`);
  const lines = run('docker', ['exec', containerName, 'sha256sum', ...absolute]).split('\n');
  const files = {};
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})\s+\/app\/(.+)$/);
    assert.ok(match, `cannot parse runtime digest line: ${line}`);
    files[match[2]] = match[1];
  }
  assert.deepEqual(Object.keys(files).sort(), [...runtimeFiles].sort());
  return { files, digest: digestObject(files) };
}

function receiptEvidence(targetShaAfter) {
  return oneDatabaseRow(`
    SELECT id::text, result, source_branch, source_sha, target_branch,
           COALESCE(target_sha_before, ''), COALESCE(target_sha_after, ''),
           COALESCE(rebase_base_sha, ''), recorded_by,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM session_merge_receipt
     WHERE source_sha = '${FIX_COMMIT_SHA}'
       AND target_branch = '${TARGET_BRANCH}'
       AND target_sha_before = '${DECLARED_SOURCE_SHA}'
       AND target_sha_after = '${targetShaAfter}'
     ORDER BY created_at DESC
     LIMIT 1
  `, [
    'databaseId', 'result', 'sourceBranch', 'sourceSha', 'targetBranch',
    'targetShaBefore', 'targetShaAfter', 'rebaseBaseSha', 'recordedBy', 'createdAt',
  ]);
}

function providerEvidence() {
  return oneDatabaseRow(`
    SELECT id::text, provider, assigned_runner_id::text, branch,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM session
     WHERE branch = '${INTEGRATION_BRANCH}'
     ORDER BY created_at DESC
     LIMIT 1
  `, ['databaseSessionId', 'providerIdentity', 'databaseRunnerId', 'branch', 'createdAt']);
}

function migrationEvidence() {
  return oneDatabaseRow(`
    SELECT count(*)::text,
           (to_regclass('public.task_auto_dispatch_state') IS NOT NULL)::text,
           (to_regclass('public.task_auto_dispatch_wakeup') IS NOT NULL)::text
      FROM _prisma_migrations
     WHERE migration_name = '0205_task_auto_dispatch_obligation'
       AND finished_at IS NOT NULL
  `, ['appliedCount', 'stateTablePresent', 'wakeupTablePresent']);
}

function validateRegression(regression, targetSha) {
  assert.equal(regression.schemaVersion, 1);
  assert.equal(regression.suite, 'outcome-reconciler-auto-dispatch');
  assert.equal(regression.outcome, 'PASS');
  assert.equal(regression.targetSha, targetSha);
  assert.deepEqual(regression.summary, {
    tests: 8,
    passed: 8,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  });
  assert.equal(regression.skipCount, 0);
  for (const [name, count] of Object.entries(regression.samples)) {
    assert.ok(Number.isInteger(count) && count > 0, `${name} has zero live-smoke samples`);
  }
  for (const [name, proven] of Object.entries(regression.coverage)) {
    assert.equal(proven, name === 'productionWrites' ? false : true, `${name} was not proven`);
  }
  assert.deepEqual(regression.results.immediate, {
    activeSessions: 1, totalSessions: 1, dispatchAttempt: 1,
  });
  assert.deepEqual(regression.results.sweepRecovery, {
    activeSessions: 1, totalSessions: 1, dispatchAttempt: 1,
  });
  assert.deepEqual(regression.results.rollingV1Replay, {
    firstActiveSessions: 1,
    replayActiveSessions: 1,
    firstDispatchAttempt: 1,
    replayDispatchAttempt: 1,
    judgmentRequests: 1,
  });
  assert.deepEqual(regression.results.concurrentDelivery, {
    deliveredSignals: 2, activeSessions: 1, totalSessions: 1, runRequests: 1,
  });
  assert.deepEqual(regression.results.policyRefusal, {
    reasonCode: 'OWNER_RATIFICATION_REQUIRED',
    dispatchAttempt: 1,
    canonicalObligations: 1,
    wakeupStateBeforeRecovery: 'PENDING',
    activeSessionsAfterWakeup: 1,
  });
  assert.deepEqual(regression.results.capacityRefusal, {
    reasonCode: 'RUNNER_OR_LIST_CAPACITY_EXHAUSTED',
    dispatchAttempt: 1,
    canonicalObligations: 1,
    wakeupState: 'PENDING',
    activeSessions: 0,
  });
  assert.equal(regression.fixture.disposable, true);
  assert.equal(regression.fixture.cleanedBeforeManifest, true);
  assert.equal(regression.fixture.productionWrites, false);
  assert.equal(regression.fixture.manualProductionStart, false);
  assert.match(regression.postgres.database, /^orbit_auto_dispatch_[a-z0-9_]+$/);
  assert.equal(regression.postgres.lastMigration, '0205_task_auto_dispatch_obligation');
  const started = Date.parse(regression.observationWindow.startedAt);
  const finished = Date.parse(regression.observationWindow.finishedAt);
  assert.ok(Number.isFinite(started) && Number.isFinite(finished) && finished >= started);
  assert.equal(regression.observationWindow.durationMilliseconds, finished - started);
  for (const [relative, digest] of Object.entries(regression.sourceDigests)) {
    assert.equal(sha256(readFileSync(path.join(repo, relative))), digest,
      `post-merge source changed after the regression: ${relative}`);
  }
}

function collectDeployment(targetSha) {
  const image = inspectImage(APISERVER_IMAGE);
  assert.match(image.Id, /^sha256:[0-9a-f]{64}$/);
  const containers = Object.fromEntries(sharedImageContainers.map((name) => {
    const value = inspectContainer(name);
    assert.equal(value.State.Status, 'running', `${name} is not running`);
    assert.equal(value.Image, image.Id, `${name} is not using the attested apiserver image`);
    return [name, {
      containerId: value.Id,
      imageId: value.Image,
      imageReference: value.Config.Image,
      startedAt: value.State.StartedAt,
      status: value.State.Status,
      health: value.State.Health?.Status ?? null,
    }];
  }));
  assert.equal(containers['orbit-apiserver'].health, 'healthy');

  const watchdog = inspectContainer('orbit-watchdog');
  const coordinator = inspectContainer('orbit-outcome-coordinator');
  const secondary = inspectContainer('orbit-outcome-coordinator-secondary');
  const deadMan = inspectContainer('orbit-executable-dead-man');
  const runtimeBindings = {
    watchdog: selectedEnvironment(watchdog, [
      'OUTCOME_WATCHDOG_COLLECTOR_SHA', 'OUTCOME_WATCHDOG_TARGET_SHA',
    ]),
    coordinator: selectedEnvironment(coordinator, [
      'OUTCOME_COORDINATOR_SOURCE_SHA', 'OUTCOME_COORDINATOR_TARGET_SHA',
    ]),
    coordinatorSecondary: selectedEnvironment(secondary, [
      'OUTCOME_COORDINATOR_SOURCE_SHA', 'OUTCOME_COORDINATOR_TARGET_SHA',
    ]),
    executableDeadMan: selectedEnvironment(deadMan, ['EXECUTABLE_DEAD_MAN_SOURCE_SHA']),
  };
  assert.deepEqual(runtimeBindings.watchdog, {
    OUTCOME_WATCHDOG_COLLECTOR_SHA: targetSha,
    OUTCOME_WATCHDOG_TARGET_SHA: targetSha,
  });
  assert.deepEqual(runtimeBindings.coordinator, {
    OUTCOME_COORDINATOR_SOURCE_SHA: targetSha,
    OUTCOME_COORDINATOR_TARGET_SHA: targetSha,
  });
  assert.deepEqual(runtimeBindings.coordinatorSecondary, runtimeBindings.coordinator);
  assert.deepEqual(runtimeBindings.executableDeadMan, {
    EXECUTABLE_DEAD_MAN_SOURCE_SHA: targetSha,
  });

  const localRuntime = localRuntimeFiles();
  const containerRuntime = containerRuntimeFiles('orbit-apiserver');
  assert.deepEqual(containerRuntime, localRuntime,
    'the running apiserver bytes do not match the clean target build');

  const postgres = inspectContainer('orbit-postgres');
  assert.equal(postgres.State.Status, 'running');
  assert.equal(postgres.State.Health?.Status, 'healthy');
  return {
    composeProject: 'orbit',
    targetSha,
    apiserver: {
      imageId: image.Id,
      repoDigests: image.RepoDigests ?? [],
      imageCreatedAt: image.Created,
      contentDigest: containerRuntime.digest,
      contentFiles: containerRuntime.files,
      container: containers['orbit-apiserver'],
    },
    sharedImageContainers: containers,
    runtimeBindings,
    postgres: {
      containerId: postgres.Id,
      startedAt: postgres.State.StartedAt,
      imageId: postgres.Image,
      status: postgres.State.Status,
      health: postgres.State.Health?.Status ?? null,
    },
  };
}

function verifyCurrentState(attestation, { generating = false } = {}) {
  assert.equal(attestation.schemaVersion, 1);
  assert.equal(attestation.kind, ATTESTATION_KIND);
  assert.equal(attestation.outcome, 'PASS');
  assert.match(attestation.attestationDigest, /^[0-9a-f]{64}$/);
  assert.equal(attestation.attestationDigest, digestObject(withoutDigest(attestation)));

  assert.equal(attestation.repository.remote, git(['remote', 'get-url', 'origin']));
  assert.equal(attestation.repository.targetBranch, TARGET_BRANCH);
  assert.equal(attestation.repository.targetRef, TARGET_REF);
  assert.equal(attestation.repository.targetShaBefore, DECLARED_SOURCE_SHA);
  assert.match(attestation.repository.targetShaAfter, /^[0-9a-f]{40}$/);
  assert.equal(git(['rev-parse', 'HEAD']), attestation.repository.targetShaAfter);
  assert.equal(cleanTracked(repo), true, 'acceptance checkout has tracked changes');
  assert.equal(cleanTracked(deploymentRepo), true, 'deployment checkout has tracked changes');
  assert.equal(git(['rev-parse', 'HEAD'], deploymentRepo), attestation.repository.targetShaAfter);
  const targetRefNow = git(['rev-parse', TARGET_REF]);
  assert.equal(isAncestor(attestation.repository.targetShaAfter, targetRefNow), true,
    'target ref no longer contains the attested target SHA');
  if (generating) assert.equal(targetRefNow, attestation.repository.targetShaAfter);

  assert.equal(attestation.source.sourceSha, DECLARED_SOURCE_SHA);
  assert.equal(attestation.source.actualFixCommitSha, FIX_COMMIT_SHA);
  assert.equal(attestation.source.sourceBranch, SOURCE_BRANCH);
  assert.equal(attestation.source.sourceSessionId, SOURCE_SESSION_ID);
  assert.equal(attestation.source.sourceTaskId, SOURCE_TASK_ID);
  assert.equal(attestation.source.rebaseBaseSha, null);
  assert.equal(isAncestor(DECLARED_SOURCE_SHA, attestation.repository.targetShaAfter), true);
  assert.equal(isAncestor(FIX_COMMIT_SHA, attestation.repository.targetShaAfter), true);
  assert.deepEqual(attestation.inclusion, {
    declaredSourceContained: true,
    actualFixCommitContained: true,
    proof: `git merge-base --is-ancestor ${FIX_COMMIT_SHA} ${attestation.repository.targetShaAfter}`,
  });

  const regressionRaw = readFileSync(regressionPath, 'utf8');
  assert.equal(sha256(regressionRaw), attestation.regression.manifestDigest);
  const regression = JSON.parse(regressionRaw);
  assert.deepEqual(regression, attestation.regression.manifest);
  validateRegression(regression, attestation.repository.targetShaAfter);

  const receipt = receiptEvidence(attestation.repository.targetShaAfter);
  assert.deepEqual(receipt, attestation.mergeReceipt.databaseRecord);
  assert.equal(attestation.mergeReceipt.publicId.length > 0, true);
  assert.equal(receipt.result, 'MERGED');
  assert.equal(receipt.sourceBranch, SOURCE_BRANCH);
  assert.equal(receipt.sourceSha, FIX_COMMIT_SHA);
  assert.equal(receipt.targetBranch, TARGET_BRANCH);
  assert.equal(receipt.targetShaBefore, DECLARED_SOURCE_SHA);
  assert.equal(receipt.targetShaAfter, attestation.repository.targetShaAfter);
  assert.equal(receipt.rebaseBaseSha, '');

  const deployment = collectDeployment(attestation.repository.targetShaAfter);
  assert.deepEqual(deployment, attestation.deployment);
  assert.equal(attestation.deployment.postgres.containerId,
    attestation.safety.postgresContainerIdBeforeDeployment,
    'postgres was recreated during the deployment');
  assert.equal(attestation.deployment.postgres.startedAt,
    attestation.safety.postgresStartedAtBeforeDeployment,
    'postgres restarted during the deployment');

  const provider = providerEvidence();
  assert.deepEqual(provider, attestation.provider.databaseRecord);
  assert.equal(provider.providerIdentity, EXPECTED_PROVIDER);
  assert.equal(provider.branch, INTEGRATION_BRANCH);
  assert.equal(attestation.provider.identity, EXPECTED_PROVIDER);
  assert.equal(attestation.provider.sessionId, INTEGRATION_SESSION_ID);
  assert.equal(attestation.provider.runnerId, RUNNER_PUBLIC_ID);

  const migration = migrationEvidence();
  assert.deepEqual(migration, attestation.deployment.productionMigration);
  assert.deepEqual(migration, {
    appliedCount: '1', stateTablePresent: 'true', wakeupTablePresent: 'true',
  });

  assert.equal(attestation.safety.integrationTaskId, INTEGRATION_TASK_ID);
  assert.equal(attestation.safety.realReplayTaskId, REAL_REPLAY_TASK_ID);
  assert.equal(attestation.safety.realReplayManuallyStarted, false);
  assert.equal(attestation.safety.productionTaskWrites, false);
  assert.equal(attestation.safety.baseImagesPulled, false);
  assert.equal(attestation.liveSmoke.databaseIsolated, true);
  assert.equal(attestation.liveSmoke.fixtureDisposed, true);
  assert.equal(attestation.liveSmoke.temporaryProjectsAndTasks, true);
  assert.deepEqual(attestation.liveSmoke.results, regression.results);

  const deployed = Date.parse(attestation.deployment.apiserver.container.startedAt);
  const verified = Date.parse(attestation.verifiedAt);
  assert.ok(Number.isFinite(deployed) && Number.isFinite(verified) && verified >= deployed);
  assert.equal(attestation.observationWindow.startedAt,
    attestation.deployment.apiserver.container.startedAt);
  assert.equal(attestation.observationWindow.finishedAt, attestation.verifiedAt);
  assert.equal(attestation.observationWindow.durationMilliseconds, verified - deployed);
}

function generate() {
  const receiptPublicId = process.env.AUTO_DISPATCH_MERGE_RECEIPT_PUBLIC_ID;
  const postgresIdBefore = process.env.AUTO_DISPATCH_POSTGRES_CONTAINER_ID_BEFORE;
  const postgresStartedBefore = process.env.AUTO_DISPATCH_POSTGRES_STARTED_AT_BEFORE;
  assert.ok(receiptPublicId, 'AUTO_DISPATCH_MERGE_RECEIPT_PUBLIC_ID is required');
  assert.match(postgresIdBefore ?? '', /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(Date.parse(postgresStartedBefore ?? '')),
    'AUTO_DISPATCH_POSTGRES_STARTED_AT_BEFORE is required');

  const targetShaAfter = git(['rev-parse', 'HEAD']);
  assert.equal(git(['rev-parse', TARGET_REF]), targetShaAfter);
  assert.equal(git(['rev-parse', 'HEAD'], deploymentRepo), targetShaAfter);
  assert.equal(cleanTracked(repo), true);
  assert.equal(cleanTracked(deploymentRepo), true);
  assert.equal(isAncestor(FIX_COMMIT_SHA, targetShaAfter), true);

  const regressionRaw = readFileSync(regressionPath, 'utf8');
  const regression = JSON.parse(regressionRaw);
  validateRegression(regression, targetShaAfter);
  const deployment = collectDeployment(targetShaAfter);
  assert.equal(deployment.postgres.containerId, postgresIdBefore);
  assert.equal(deployment.postgres.startedAt, postgresStartedBefore);
  deployment.productionMigration = migrationEvidence();

  const provider = providerEvidence();
  assert.equal(provider.providerIdentity, EXPECTED_PROVIDER);
  const receipt = receiptEvidence(targetShaAfter);
  const verifiedAt = new Date().toISOString();
  const deployedAt = deployment.apiserver.container.startedAt;

  const attestation = {
    schemaVersion: 1,
    kind: ATTESTATION_KIND,
    outcome: 'PASS',
    repository: {
      remote: git(['remote', 'get-url', 'origin']),
      verificationCheckout: repo,
      deploymentCheckout: deploymentRepo,
      targetBranch: TARGET_BRANCH,
      targetRef: TARGET_REF,
      targetShaBefore: DECLARED_SOURCE_SHA,
      targetShaAfter,
      cleanTargetCheckout: true,
    },
    source: {
      sourceSha: DECLARED_SOURCE_SHA,
      sourceShaMeaning: 'clean HEAD used by the source session while its passing dirty tree was tested',
      actualFixCommitSha: FIX_COMMIT_SHA,
      actualFixCommitMeaning: 'source session branch tip containing the committed auto-dispatch bytes',
      sourceBranch: SOURCE_BRANCH,
      sourceSessionId: SOURCE_SESSION_ID,
      sourceTaskId: SOURCE_TASK_ID,
      rebaseBaseSha: null,
    },
    inclusion: {
      declaredSourceContained: true,
      actualFixCommitContained: true,
      proof: `git merge-base --is-ancestor ${FIX_COMMIT_SHA} ${targetShaAfter}`,
    },
    mergeReceipt: {
      publicId: receiptPublicId,
      databaseRecord: receipt,
    },
    regression: {
      command: 'npm run test:outcome-reconciler:auto-dispatch',
      manifestPath: path.relative(repo, regressionPath),
      manifestDigest: sha256(regressionRaw),
      manifest: regression,
    },
    liveSmoke: {
      databaseIsolated: true,
      databaseName: regression.postgres.database,
      fixtureDisposed: regression.fixture.cleanedBeforeManifest,
      temporaryProjectsAndTasks: true,
      results: regression.results,
    },
    deployment,
    provider: {
      identity: EXPECTED_PROVIDER,
      sessionId: INTEGRATION_SESSION_ID,
      runnerId: RUNNER_PUBLIC_ID,
      databaseRecord: provider,
    },
    safety: {
      integrationTaskId: INTEGRATION_TASK_ID,
      realReplayTaskId: REAL_REPLAY_TASK_ID,
      realReplayManuallyStarted: false,
      productionTaskWrites: false,
      baseImagesPulled: false,
      postgresContainerIdBeforeDeployment: postgresIdBefore,
      postgresStartedAtBeforeDeployment: postgresStartedBefore,
    },
    verifiedAt,
    observationWindow: {
      startedAt: deployedAt,
      finishedAt: verifiedAt,
      durationMilliseconds: Date.parse(verifiedAt) - Date.parse(deployedAt),
      regression: regression.observationWindow,
    },
  };
  attestation.attestationDigest = digestObject(attestation);
  verifyCurrentState(attestation, { generating: true });
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(attestation, null, 2)}\n`);
  console.log(JSON.stringify(attestation, null, 2));
}

function verify() {
  const attestation = readJson(artifactPath);
  verifyCurrentState(attestation);
  console.log(JSON.stringify(attestation, null, 2));
}

if (mode === 'attest') generate();
else if (mode === 'verify') verify();
else throw new Error(`usage: ${path.basename(process.argv[1])} attest|verify`);
