#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const deploymentRepo = '/root/orbit';
const buildDir = path.join(repo, 'build');
const regressionPath = path.join(buildDir,
  'outcome-reconciler-watchdog-current-binding-manifest.json');
const snapshotPath = path.join(buildDir,
  'outcome-reconciler-watchdog-current-binding-predeployment.json');
const artifactPath = path.join(buildDir,
  'outcome-reconciler-watchdog-current-binding-attestation.json');
const mode = process.argv[2] ?? 'verify';

const KIND = 'orbit.watchdog-current-binding.integration-attestation';
const TARGET_BRANCH = 'main';
const TARGET_REF = 'refs/heads/main';
const INITIAL_TARGET_SHA = 'c2f326329dbd0282dde7b5941755d5f4e76922ac';
const SOURCE_BRANCH = 'orbit/watchdog-current-binding-heartbeat-c3165c';
const SESSION_ID = 'ed08f238-c771-538f-958f-a0bb19b4fd70';
const SESSION_PUBLIC_ID = '7DHGjXLrL3IEKvW7klcxyy';
const TASK_ID = '01a04b39-9c1b-7392-a096-2402dabe76f3';
const TASK_PUBLIC_ID = '34FIm9qiJ567naahHHe8x';
const PROJECT_ID = '01a04416-6517-7329-b0b7-9926a89d86aa';
const PROJECT_PUBLIC_ID = '34EVnSK4xSBvXox6Za9AA';
const EXPECTED_PROVIDER = 'codex';
const APISERVER_IMAGE = 'orbit-apiserver:local';
const OLD_INSTANCE_ID = 'c4bc5303e476:1';
const OLD_SOURCE_SHA = '88f6be57dd121000fcd94fa2d6543e2a022e4114';
const OLD_HEARTBEAT_DIGEST =
  '1e4f97715b3623ea05de7c1f56da442c64fd2c0e28898be6fdc665f14891d2c6';
const STARTUP_WINDOW_MS = 60_000;

const runtimeFiles = [
  'src/apiserver/dist/outcome-watchdog/outcome-watchdog.runner.js',
  'src/apiserver/dist/outcome-watchdog/outcome-watchdog.service.js',
  'src/apiserver/prisma/migrations/0206_watchdog_current_binding/migration.sql',
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

function withoutDigest(value) {
  const { attestationDigest: _ignored, ...unsigned } = value;
  return unsigned;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function cleanTracked(cwd) {
  return git(['status', '--porcelain', '--untracked-files=no'], cwd) === '';
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

function inspectContainer(name) {
  const [container] = JSON.parse(run('docker', ['inspect', name]));
  assert.ok(container, `container ${name} is missing`);
  return container;
}

function inspectImage(name) {
  const [image] = JSON.parse(run('docker', ['image', 'inspect', name]));
  assert.ok(image, `image ${name} is missing`);
  return image;
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

function queryJson(sql) {
  const output = queryDatabase(sql);
  assert.ok(output, `database evidence query returned zero rows: ${sql}`);
  const rows = output.split('\n').filter(Boolean);
  assert.equal(rows.length, 1, `database evidence query returned ${rows.length} rows`);
  return JSON.parse(rows[0]);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function projectionSnapshot() {
  const output = queryDatabase(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'outcome_projection' AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `);
  const tables = output ? output.split('\n').filter(Boolean) : [];
  const snapshot = {};
  for (const table of tables) {
    const quoted = quoteIdentifier(table);
    snapshot[table] = queryJson(`
      SELECT jsonb_build_object(
        'count', count(*),
        'digest', md5(COALESCE(string_agg(to_jsonb(value)::text, '|'
          ORDER BY to_jsonb(value)::text), ''))
      )
        FROM outcome_projection.${quoted} value
    `);
  }
  return snapshot;
}

function protectedStateSnapshot() {
  return queryJson(`
    SELECT jsonb_build_object(
      'projectCount', (SELECT count(*) FROM project WHERE id = '${PROJECT_ID}'::uuid),
      'projectDigest', (SELECT encode(digest(to_jsonb(p)::text, 'sha256'), 'hex')
                          FROM project p WHERE p.id = '${PROJECT_ID}'::uuid),
      'taskCount', (SELECT count(*) FROM task WHERE id = '${TASK_ID}'::uuid),
      'taskDigest', (SELECT encode(digest(to_jsonb(t)::text, 'sha256'), 'hex')
                       FROM task t WHERE t.id = '${TASK_ID}'::uuid)
    )
  `);
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

function migrationEvidence() {
  return queryJson(`
    SELECT jsonb_build_object(
      'appliedCount', (SELECT count(*) FROM _prisma_migrations
        WHERE migration_name = '0206_watchdog_current_binding' AND finished_at IS NOT NULL),
      'bindingTablePresent', to_regclass('public.executable_runtime_binding') IS NOT NULL,
      'factTablePresent', to_regclass('public.executable_runtime_binding_fact') IS NOT NULL,
      'currentViewPresent', to_regclass('public.executable_runtime_current_binding') IS NOT NULL,
      'registerFunctionPresent', EXISTS (SELECT 1 FROM pg_proc
        WHERE proname = 'executable_runtime_register_current_binding'),
      'heartbeatFunctionPresent', EXISTS (SELECT 1 FROM pg_proc
        WHERE proname = 'executable_runtime_append_current_heartbeat')
    )
  `);
}

function providerEvidence() {
  return queryJson(`
    SELECT jsonb_build_object(
      'databaseSessionId', id::text,
      'providerIdentity', provider,
      'databaseRunnerId', assigned_runner_id::text,
      'branch', branch,
      'createdAt', to_char(created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
      FROM session
     WHERE id = '${SESSION_ID}'::uuid
  `);
}

function receiptEvidence(targetSha) {
  return queryJson(`
    SELECT jsonb_build_object(
      'databaseId', id::text,
      'result', result,
      'sourceBranch', source_branch,
      'sourceSha', btrim(source_sha),
      'targetBranch', target_branch,
      'targetShaBefore', btrim(target_sha_before),
      'targetShaAfter', btrim(target_sha_after),
      'rebaseBaseSha', CASE WHEN rebase_base_sha IS NULL THEN NULL ELSE btrim(rebase_base_sha) END,
      'recordedBy', recorded_by,
      'createdAt', to_char(created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
      FROM session_merge_receipt
     WHERE session_id = '${SESSION_ID}'::uuid
       AND source_branch = '${SOURCE_BRANCH}'
       AND target_branch = '${TARGET_BRANCH}'
       AND target_sha_after = '${targetSha}'
       AND result = 'MERGED'
     ORDER BY created_at DESC
     LIMIT 1
  `);
}

function uuidToBase62(uuid) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let number = BigInt(`0x${uuid.replaceAll('-', '')}`);
  if (number === 0n) return '0';
  let result = '';
  while (number > 0n) {
    result = alphabet[Number(number % 62n)] + result;
    number /= 62n;
  }
  return result;
}

function currentBindingEvidence() {
  return queryJson(`
    WITH current_row AS (
      SELECT * FROM executable_runtime_current_binding
       WHERE component = 'outcome-watchdog'
    ), heartbeat_facts AS (
      SELECT fact.logical_time, fact.fact_digest, fact.heartbeat_digest,
             heartbeat.sequence, heartbeat.observed_at, heartbeat.deadline_at
        FROM current_row current
        JOIN executable_runtime_binding_fact fact
          ON fact.binding_digest = current.binding_digest
         AND fact.kind = 'HEARTBEAT_INGESTED'
        JOIN executable_runtime_heartbeat heartbeat
          ON heartbeat.heartbeat_digest = fact.heartbeat_digest
       ORDER BY fact.logical_time
    )
    SELECT jsonb_build_object(
      'currentCount', (SELECT count(*) FROM current_row),
      'component', current.component,
      'bindingDigest', btrim(current.binding_digest),
      'registeredFactDigest', btrim(current.registered_fact_digest),
      'generation', current.expectation_generation::text,
      'expectationDigest', btrim(current.expectation_digest),
      'instanceId', current.instance_id,
      'sourceSha', current.source_sha,
      'targetSha', current.target_sha,
      'targetRef', current.target_ref,
      'moduleGraphDigest', btrim(current.module_graph_digest),
      'registeredAt', to_char(current.registered_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'registeredLogicalTime', current.registered_logical_time::text,
      'latestHeartbeatDigest', btrim(current.heartbeat_digest),
      'latestHeartbeatSequence', current.heartbeat_sequence::text,
      'evaluatedThroughLogicalTime', current.evaluated_through_logical_time::text,
      'state', current.state,
      'heartbeatFactCount', (SELECT count(*) FROM heartbeat_facts),
      'heartbeatSamples', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'logicalTime', logical_time::text,
        'factDigest', btrim(fact_digest),
        'heartbeatDigest', btrim(heartbeat_digest),
        'sequence', sequence::text,
        'observedAt', to_char(observed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'deadlineAt', to_char(deadline_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) ORDER BY logical_time), '[]'::jsonb) FROM heartbeat_facts)
    )
      FROM current_row current
  `);
}

function legacyEvidence() {
  return queryJson(`
    SELECT jsonb_build_object(
      'instanceId', '${OLD_INSTANCE_ID}',
      'sourceSha', '${OLD_SOURCE_SHA}',
      'heartbeatDigest', '${OLD_HEARTBEAT_DIGEST}',
      'heartbeatCount', (SELECT count(*) FROM executable_runtime_heartbeat
        WHERE component = 'outcome-watchdog'
          AND instance_id = '${OLD_INSTANCE_ID}'
          AND source_sha = '${OLD_SOURCE_SHA}'
          AND heartbeat_digest = '${OLD_HEARTBEAT_DIGEST}'),
      'obsoleteFacts', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'factDigest', btrim(fact_digest),
        'logicalTime', logical_time::text,
        'supersededByBindingDigest', btrim(superseded_by_binding_digest),
        'recordedAt', to_char(recorded_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) ORDER BY logical_time), '[]'::jsonb)
        FROM executable_runtime_binding_fact
       WHERE kind = 'OBSOLETED'
         AND subject_instance_id = '${OLD_INSTANCE_ID}'
         AND subject_source_sha = '${OLD_SOURCE_SHA}'
         AND heartbeat_digest = '${OLD_HEARTBEAT_DIGEST}'),
      'livenessCount', (SELECT count(*) FROM executable_runtime_liveness
        WHERE component = 'outcome-watchdog' AND instance_id = '${OLD_INSTANCE_ID}')
    )
  `);
}

function supersessionEvidence(currentDigest) {
  return queryJson(`
    SELECT jsonb_build_object(
      'count', count(*),
      'facts', COALESCE(jsonb_agg(jsonb_build_object(
        'bindingDigest', btrim(binding_digest),
        'factDigest', btrim(fact_digest),
        'logicalTime', logical_time::text,
        'supersededByBindingDigest', btrim(superseded_by_binding_digest),
        'subjectInstanceId', subject_instance_id,
        'subjectSourceSha', subject_source_sha,
        'recordedAt', to_char(recorded_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) ORDER BY logical_time), '[]'::jsonb)
    )
      FROM executable_runtime_binding_fact
     WHERE kind = 'SUPERSEDED'
       AND superseded_by_binding_digest = '${currentDigest}'
  `);
}

function deadManEvidence(generation) {
  return queryJson(`
    SELECT jsonb_build_object(
      'staleCount', count(*) FILTER (WHERE kind IN ('WATCHDOG_STALE', 'WATCHDOG_MISSING')),
      'recoveredCount', count(*) FILTER (WHERE kind = 'WATCHDOG_RECOVERED'),
      'events', COALESCE(jsonb_agg(jsonb_build_object(
        'kind', kind,
        'eventDigest', btrim(event_digest),
        'heartbeatDigest', CASE WHEN heartbeat_digest IS NULL THEN NULL
          ELSE btrim(heartbeat_digest) END,
        'checkedAt', to_char(checked_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'deadlineAt', CASE WHEN deadline_at IS NULL THEN NULL ELSE
          to_char(deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'sourceSha', source_sha
      ) ORDER BY checked_at, created_at, id), '[]'::jsonb)
    )
      FROM executable_dead_man_event
     WHERE expectation_generation = '${generation}'::uuid
  `);
}

function projectAcceptanceEvidence(currentDigest) {
  const result = queryJson(`
    SELECT executable_runtime_overlay_read_surface(
      project_canonical_done_gate('${PROJECT_ID}'::uuid, 'PROJECT', '${PROJECT_PUBLIC_ID}'),
      'DONE_GATE'
    )
  `);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(OLD_INSTANCE_ID), false,
    'project acceptance still exposes the obsolete watchdog instance');
  assert.equal(serialized.includes(OLD_HEARTBEAT_DIGEST), false,
    'project acceptance still exposes the obsolete watchdog heartbeat');
  assert.ok(Array.isArray(result.runtimeBindings) && result.runtimeBindings.length === 1,
    'project acceptance did not expose exactly one current runtime binding');
  assert.equal(result.runtimeBindings[0].bindingDigest, currentDigest);
  assert.equal(result.runtimeBindings[0].state, 'HEALTHY');
  return {
    oldInstancePresent: false,
    oldHeartbeatPresent: false,
    currentBindingDigest: result.runtimeBindings[0].bindingDigest,
    currentGeneration: result.runtimeBindings[0].generation,
    currentEvaluatedThroughLogicalTime:
      result.runtimeBindings[0].evaluatedThroughLogicalTime,
    canonicalReasonCode: result.reason?.code ?? result.doneGate?.reason?.code ?? null,
    canonicalStaleness: result.staleness ?? null,
    runtimeStaleObligationCount: Array.isArray(result.runtimeLiveness)
      ? result.runtimeLiveness.length : 0,
    readDigest: digestObject(result),
  };
}

function collectDeployment(targetSha) {
  const image = inspectImage(APISERVER_IMAGE);
  assert.match(image.Id, /^sha256:[0-9a-f]{64}$/);
  const containers = Object.fromEntries(sharedImageContainers.map((name) => {
    const value = inspectContainer(name);
    assert.equal(value.State.Status, 'running', `${name} is not running`);
    assert.equal(value.Image, image.Id, `${name} does not use the attested image`);
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
  const watchdogContainer = inspectContainer('orbit-watchdog');
  const watchdog = selectedEnvironment(watchdogContainer, [
    'OUTCOME_WATCHDOG_COLLECTOR_SHA',
    'OUTCOME_WATCHDOG_TARGET_SHA',
    'OUTCOME_WATCHDOG_TARGET_REF',
    'OUTCOME_WATCHDOG_EXPECTATION_GENERATION',
    'OUTCOME_WATCHDOG_INSTANCE_ID',
  ]);
  assert.deepEqual(watchdog, {
    OUTCOME_WATCHDOG_COLLECTOR_SHA: targetSha,
    OUTCOME_WATCHDOG_EXPECTATION_GENERATION:
      watchdog.OUTCOME_WATCHDOG_EXPECTATION_GENERATION,
    OUTCOME_WATCHDOG_INSTANCE_ID: 'compose:outcome-watchdog',
    OUTCOME_WATCHDOG_TARGET_REF: TARGET_REF,
    OUTCOME_WATCHDOG_TARGET_SHA: targetSha,
  });
  assert.match(watchdog.OUTCOME_WATCHDOG_EXPECTATION_GENERATION,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const localRuntime = localRuntimeFiles();
  const containerRuntime = containerRuntimeFiles('orbit-apiserver');
  assert.deepEqual(containerRuntime, localRuntime,
    'running image bytes do not match the clean target build');

  const postgres = inspectContainer('orbit-postgres');
  assert.equal(postgres.State.Status, 'running');
  assert.equal(postgres.State.Health?.Status, 'healthy');
  return {
    composeProject: 'orbit',
    targetSha,
    image: {
      reference: APISERVER_IMAGE,
      imageId: image.Id,
      repoDigests: image.RepoDigests ?? [],
      createdAt: image.Created,
      contentDigest: containerRuntime.digest,
      contentFiles: containerRuntime.files,
    },
    containers,
    watchdogEnvironment: watchdog,
    postgres: {
      containerId: postgres.Id,
      startedAt: postgres.State.StartedAt,
      imageId: postgres.Image,
      status: postgres.State.Status,
      health: postgres.State.Health?.Status ?? null,
    },
    migration: migrationEvidence(),
  };
}

function validateRegression(regression, targetSha) {
  assert.equal(regression.schemaVersion, 1);
  assert.equal(regression.suite, 'outcome-reconciler-watchdog-current-binding');
  assert.equal(regression.outcome, 'PASS');
  assert.equal(regression.targetSha, targetSha);
  assert.ok(regression.summary.tests >= 5);
  assert.equal(regression.summary.passed, regression.summary.tests);
  assert.equal(regression.summary.failed, 0);
  assert.equal(regression.summary.cancelled, 0);
  assert.equal(regression.summary.skipped, 0);
  assert.equal(regression.summary.todo, 0);
  assert.equal(regression.skipCount, 0);
  assert.equal(regression.postgres.required, true);
  assert.equal(regression.postgres.connected, true);
  assert.ok(regression.postgres.migrations > 0);
  assert.equal(regression.postgres.requiredMigrationApplied, true);
  assert.match(regression.postgres.lastMigration, /^\d{4}_[a-z0-9_]+$/);
  for (const [name, count] of Object.entries(regression.samples)) {
    assert.ok(Number.isInteger(count) && count > 0, `${name} has zero regression samples`);
  }
  for (const [name, proven] of Object.entries(regression.coverage)) {
    assert.equal(proven, name === 'productionProjectionWrites' ? false : true,
      `${name} was not proven`);
  }
  assert.equal(regression.fixture.disposable, true);
  assert.equal(regression.fixture.cleanedBeforeManifest, true);
  assert.equal(regression.fixture.productionWrites, false);
  assert.equal(regression.fixture.productionProjectionWrites, false);
  assert.equal(regression.results.race.winner.bindingDigest.length, 64);
  assert.equal(regression.results.race.candidates.length, 2);
  assert.equal(regression.results.deadMan.projectRead.oldInstancePresent, false);
  assert.equal(regression.results.deadMan.projectRead.oldHeartbeatPresent, false);
  const started = Date.parse(regression.observationWindow.startedAt);
  const finished = Date.parse(regression.observationWindow.finishedAt);
  assert.ok(Number.isFinite(started) && Number.isFinite(finished) && finished >= started);
  assert.equal(regression.observationWindow.durationMilliseconds, finished - started);
  assert.ok(regression.observationWindow.startupRegistrationMilliseconds <= 2_000);
  for (const [relative, digest] of Object.entries(regression.sourceDigests)) {
    assert.equal(sha256(readFileSync(path.join(repo, relative))), digest,
      `post-merge source changed after the regression: ${relative}`);
  }
}

function captureSnapshot() {
  const targetSha = git(['rev-parse', 'HEAD']);
  assert.equal(git(['branch', '--show-current']), SOURCE_BRANCH);
  assert.equal(git(['rev-parse', TARGET_REF]), targetSha);
  assert.equal(git(['rev-parse', 'HEAD'], deploymentRepo), targetSha);
  assert.equal(cleanTracked(repo), true);
  assert.equal(cleanTracked(deploymentRepo), true);
  const postgres = inspectContainer('orbit-postgres');
  assert.equal(postgres.State.Status, 'running');
  const preRead = queryJson(`
    SELECT executable_runtime_overlay_read_surface(
      project_canonical_done_gate('${PROJECT_ID}'::uuid, 'PROJECT', '${PROJECT_PUBLIC_ID}'),
      'DONE_GATE'
    )
  `);
  const preSerialized = JSON.stringify(preRead);
  assert.equal(preSerialized.includes(OLD_INSTANCE_ID), true,
    'predeployment evidence no longer contains the declared stale instance');
  assert.equal(preSerialized.includes(OLD_HEARTBEAT_DIGEST), true,
    'predeployment evidence no longer contains the declared stale heartbeat');
  const snapshot = {
    schemaVersion: 1,
    kind: 'orbit.watchdog-current-binding.predeployment-snapshot',
    targetSha,
    capturedAt: new Date().toISOString(),
    postgres: {
      containerId: postgres.Id,
      startedAt: postgres.State.StartedAt,
      imageId: postgres.Image,
    },
    initialBlockedRead: {
      oldInstancePresent: true,
      oldHeartbeatPresent: true,
      digest: digestObject(preRead),
    },
    projection: projectionSnapshot(),
    protectedState: protectedStateSnapshot(),
  };
  snapshot.snapshotDigest = digestObject(snapshot);
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify(snapshot, null, 2));
}

function verifyCurrentState(attestation, { generating = false } = {}) {
  assert.equal(attestation.schemaVersion, 1);
  assert.equal(attestation.kind, KIND);
  assert.equal(attestation.outcome, 'PASS');
  assert.match(attestation.attestationDigest, /^[0-9a-f]{64}$/);
  assert.equal(attestation.attestationDigest, digestObject(withoutDigest(attestation)));

  const targetSha = attestation.repository.targetSha;
  assert.match(targetSha, /^[0-9a-f]{40}$/);
  assert.equal(attestation.repository.remote, git(['remote', 'get-url', 'origin']));
  assert.equal(attestation.repository.targetBranch, TARGET_BRANCH);
  assert.equal(attestation.repository.targetRef, TARGET_REF);
  assert.equal(attestation.repository.targetShaBefore, INITIAL_TARGET_SHA);
  assert.equal(git(['rev-parse', 'HEAD']), targetSha);
  assert.equal(git(['rev-parse', TARGET_REF]), targetSha);
  assert.equal(git(['rev-parse', 'HEAD'], deploymentRepo), targetSha);
  assert.equal(cleanTracked(repo), true, 'verification checkout has tracked changes');
  assert.equal(cleanTracked(deploymentRepo), true, 'deployment checkout has tracked changes');
  assert.equal(isAncestor(INITIAL_TARGET_SHA, targetSha), true);

  assert.deepEqual(attestation.source, {
    branch: SOURCE_BRANCH,
    sessionId: SESSION_PUBLIC_ID,
    taskId: TASK_PUBLIC_ID,
    sourceSha: targetSha,
  });

  const regressionRaw = readFileSync(regressionPath, 'utf8');
  assert.equal(sha256(regressionRaw), attestation.regression.manifestDigest);
  const regression = JSON.parse(regressionRaw);
  assert.deepEqual(regression, attestation.regression.manifest);
  validateRegression(regression, targetSha);

  const receipt = receiptEvidence(targetSha);
  assert.deepEqual(receipt, attestation.mergeReceipt.databaseRecord);
  assert.equal(attestation.mergeReceipt.publicId, uuidToBase62(receipt.databaseId));
  assert.equal(receipt.result, 'MERGED');
  assert.equal(receipt.sourceBranch, SOURCE_BRANCH);
  assert.equal(receipt.sourceSha, targetSha);
  assert.equal(receipt.targetBranch, TARGET_BRANCH);
  assert.equal(receipt.targetShaBefore, INITIAL_TARGET_SHA);
  assert.equal(receipt.targetShaAfter, targetSha);
  assert.equal(receipt.rebaseBaseSha, null);

  const provider = providerEvidence();
  assert.deepEqual(provider, attestation.provider.databaseRecord);
  assert.equal(provider.providerIdentity, EXPECTED_PROVIDER);
  assert.equal(provider.branch, SOURCE_BRANCH);
  assert.equal(attestation.provider.identity, EXPECTED_PROVIDER);
  assert.equal(attestation.provider.sessionId, SESSION_PUBLIC_ID);
  assert.equal(attestation.provider.runnerId, uuidToBase62(provider.databaseRunnerId));

  const deployment = collectDeployment(targetSha);
  assert.deepEqual(deployment, attestation.deployment);
  assert.equal(deployment.postgres.containerId, attestation.safety.postgresContainerIdBefore);
  assert.equal(deployment.postgres.startedAt, attestation.safety.postgresStartedAtBefore);
  assert.deepEqual(deployment.migration, {
    appliedCount: 1,
    bindingTablePresent: true,
    factTablePresent: true,
    currentViewPresent: true,
    registerFunctionPresent: true,
    heartbeatFunctionPresent: true,
  });

  const current = currentBindingEvidence();
  assert.equal(current.currentCount, 1);
  assert.equal(current.component, 'outcome-watchdog');
  assert.equal(current.instanceId, 'compose:outcome-watchdog');
  assert.equal(current.sourceSha, targetSha);
  assert.equal(current.targetSha, targetSha);
  assert.equal(current.targetRef, TARGET_REF);
  assert.equal(current.generation,
    deployment.watchdogEnvironment.OUTCOME_WATCHDOG_EXPECTATION_GENERATION);
  assert.equal(current.bindingDigest, attestation.runtime.current.bindingDigest);
  assert.equal(current.registeredFactDigest,
    attestation.runtime.current.registeredFactDigest);
  assert.equal(current.state, 'HEALTHY');
  assert.ok(BigInt(current.evaluatedThroughLogicalTime)
    >= BigInt(attestation.runtime.current.evaluatedThroughLogicalTime));
  assert.ok(BigInt(current.evaluatedThroughLogicalTime)
    > BigInt(current.registeredLogicalTime));
  assert.ok(current.heartbeatFactCount >= attestation.runtime.current.heartbeatFactCount);
  for (const sample of attestation.runtime.current.heartbeatSamples) {
    const retained = current.heartbeatSamples.find((candidate) =>
      candidate.factDigest === sample.factDigest
      && candidate.heartbeatDigest === sample.heartbeatDigest
      && candidate.logicalTime === sample.logicalTime);
    assert.ok(retained, `attested heartbeat fact disappeared: ${sample.factDigest}`);
  }

  const legacy = legacyEvidence();
  assert.deepEqual(legacy, attestation.runtime.obsoleteLegacy);
  assert.equal(legacy.heartbeatCount, 1);
  assert.equal(legacy.livenessCount, 0);
  assert.ok(legacy.obsoleteFacts.length >= 1);
  assert.ok(legacy.obsoleteFacts.some((fact) =>
    fact.supersededByBindingDigest === attestation.runtime.firstDeployedBindingDigest));

  const supersession = supersessionEvidence(current.bindingDigest);
  assert.deepEqual(supersession, attestation.runtime.rollingSupersession);
  assert.ok(supersession.count >= 1);
  assert.ok(supersession.facts.every((fact) =>
    fact.supersededByBindingDigest === current.bindingDigest));

  const deadMan = deadManEvidence(current.generation);
  assert.deepEqual(deadMan, attestation.runtime.deadMan);
  assert.ok(deadMan.staleCount >= 1);
  assert.ok(deadMan.recoveredCount >= 1);
  const staleIndex = deadMan.events.findIndex((event) =>
    event.kind === 'WATCHDOG_STALE' || event.kind === 'WATCHDOG_MISSING');
  const recoveredIndex = deadMan.events.findIndex((event, index) =>
    index > staleIndex && event.kind === 'WATCHDOG_RECOVERED');
  assert.ok(staleIndex >= 0 && recoveredIndex > staleIndex,
    'dead-man did not record stale then recovered for the current generation');

  const projectRead = projectAcceptanceEvidence(current.bindingDigest);
  assert.equal(projectRead.oldInstancePresent, false);
  assert.equal(projectRead.oldHeartbeatPresent, false);
  assert.equal(projectRead.runtimeStaleObligationCount, 0);
  assert.notEqual(projectRead.canonicalStaleness, 'WATCHDOG_STALE');
  assert.equal(projectRead.currentGeneration, current.generation);
  assert.ok(BigInt(projectRead.currentEvaluatedThroughLogicalTime)
    >= BigInt(attestation.runtime.projectAcceptance.currentEvaluatedThroughLogicalTime));
  if (generating) assert.deepEqual(projectRead, attestation.runtime.projectAcceptance);

  assert.deepEqual(projectionSnapshot(), attestation.safety.projectionSnapshot);
  assert.deepEqual(protectedStateSnapshot(), attestation.safety.protectedStateSnapshot);
  assert.equal(attestation.safety.baseImagesPulled, false);
  assert.equal(attestation.safety.productionProjectionWrites, false);
  assert.equal(attestation.safety.manualDoneGateWrites, false);
  assert.equal(attestation.safety.manualProjectStateWrites, false);
  assert.equal(attestation.safety.oldFactsDeletedOrOverwritten, false);

  const deployed = Date.parse(deployment.containers['orbit-watchdog'].startedAt);
  const registered = Date.parse(attestation.runtime.current.registeredAt);
  const verified = Date.parse(attestation.verifiedAt);
  assert.ok(Number.isFinite(deployed) && Number.isFinite(registered)
    && Number.isFinite(verified));
  const startupRegistrationMilliseconds = registered - deployed;
  assert.ok(startupRegistrationMilliseconds >= -5_000
    && startupRegistrationMilliseconds <= STARTUP_WINDOW_MS,
  `startup binding registration exceeded the bounded window: ${startupRegistrationMilliseconds}ms`);
  assert.equal(attestation.observationWindow.startedAt,
    deployment.containers['orbit-watchdog'].startedAt);
  assert.equal(attestation.observationWindow.finishedAt, attestation.verifiedAt);
  assert.equal(attestation.observationWindow.durationMilliseconds, verified - deployed);
  assert.equal(attestation.observationWindow.startupRegistrationMilliseconds,
    startupRegistrationMilliseconds);
}

function generateAttestation() {
  const snapshot = readJson(snapshotPath);
  const targetSha = git(['rev-parse', 'HEAD']);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.targetSha, targetSha);
  assert.match(snapshot.snapshotDigest, /^[0-9a-f]{64}$/);
  const { snapshotDigest: _ignored, ...unsignedSnapshot } = snapshot;
  assert.equal(snapshot.snapshotDigest, digestObject(unsignedSnapshot));
  assert.equal(git(['rev-parse', TARGET_REF]), targetSha);
  assert.equal(git(['rev-parse', 'HEAD'], deploymentRepo), targetSha);
  assert.equal(cleanTracked(repo), true);
  assert.equal(cleanTracked(deploymentRepo), true);

  const regressionRaw = readFileSync(regressionPath, 'utf8');
  const regression = JSON.parse(regressionRaw);
  validateRegression(regression, targetSha);
  const deployment = collectDeployment(targetSha);
  assert.equal(deployment.postgres.containerId, snapshot.postgres.containerId);
  assert.equal(deployment.postgres.startedAt, snapshot.postgres.startedAt);
  assert.deepEqual(projectionSnapshot(), snapshot.projection,
    'production outcome_projection changed during the binding recovery');
  assert.deepEqual(protectedStateSnapshot(), snapshot.protectedState,
    'Project or Task state changed during the binding recovery');

  const current = currentBindingEvidence();
  assert.equal(current.currentCount, 1);
  assert.equal(current.state, 'HEALTHY');
  assert.equal(current.targetSha, targetSha);
  assert.equal(current.targetRef, TARGET_REF);
  assert.ok(current.heartbeatFactCount >= 2,
    'current binding has fewer than two heartbeat facts');
  assert.ok(BigInt(current.evaluatedThroughLogicalTime)
    > BigInt(current.registeredLogicalTime));
  for (let index = 1; index < current.heartbeatSamples.length; index += 1) {
    assert.ok(BigInt(current.heartbeatSamples[index].logicalTime)
      > BigInt(current.heartbeatSamples[index - 1].logicalTime));
    assert.ok(BigInt(current.heartbeatSamples[index].sequence)
      > BigInt(current.heartbeatSamples[index - 1].sequence));
  }

  const legacy = legacyEvidence();
  assert.equal(legacy.heartbeatCount, 1);
  assert.equal(legacy.livenessCount, 0);
  assert.ok(legacy.obsoleteFacts.length >= 1);
  const firstDeployedBindingDigest = legacy.obsoleteFacts[0].supersededByBindingDigest;
  assert.match(firstDeployedBindingDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(firstDeployedBindingDigest, current.bindingDigest,
    'rolling evidence requires a second binding to supersede the first deployment binding');
  const supersession = supersessionEvidence(current.bindingDigest);
  assert.ok(supersession.count >= 1);
  assert.ok(supersession.facts.some((fact) =>
    fact.bindingDigest === firstDeployedBindingDigest));
  const deadMan = deadManEvidence(current.generation);
  assert.ok(deadMan.staleCount >= 1);
  assert.ok(deadMan.recoveredCount >= 1);
  const projectRead = projectAcceptanceEvidence(current.bindingDigest);

  const provider = providerEvidence();
  assert.equal(provider.providerIdentity, EXPECTED_PROVIDER);
  assert.equal(provider.branch, SOURCE_BRANCH);
  const receipt = receiptEvidence(targetSha);
  assert.equal(receipt.sourceSha, targetSha);
  assert.equal(receipt.targetShaAfter, targetSha);
  const verifiedAt = new Date().toISOString();
  const deployedAt = deployment.containers['orbit-watchdog'].startedAt;
  const registeredAt = current.registeredAt;

  const attestation = {
    schemaVersion: 1,
    kind: KIND,
    outcome: 'PASS',
    repository: {
      remote: git(['remote', 'get-url', 'origin']),
      verificationCheckout: repo,
      deploymentCheckout: deploymentRepo,
      targetBranch: TARGET_BRANCH,
      targetRef: TARGET_REF,
      targetShaBefore: INITIAL_TARGET_SHA,
      targetSha,
      cleanTargetSha: true,
    },
    source: {
      branch: SOURCE_BRANCH,
      sessionId: SESSION_PUBLIC_ID,
      taskId: TASK_PUBLIC_ID,
      sourceSha: targetSha,
    },
    mergeReceipt: {
      publicId: uuidToBase62(receipt.databaseId),
      databaseRecord: receipt,
    },
    regression: {
      command: 'npm run test:outcome-reconciler:watchdog-current-binding:regression',
      manifestPath: path.relative(repo, regressionPath),
      manifestDigest: sha256(regressionRaw),
      manifest: regression,
    },
    deployment,
    provider: {
      identity: EXPECTED_PROVIDER,
      sessionId: SESSION_PUBLIC_ID,
      runnerId: uuidToBase62(provider.databaseRunnerId),
      databaseRecord: provider,
    },
    runtime: {
      current,
      firstDeployedBindingDigest,
      obsoleteLegacy: legacy,
      rollingSupersession: supersession,
      deadMan,
      projectAcceptance: projectRead,
      concurrentRegistrationProof: regression.results.race,
    },
    safety: {
      postgresContainerIdBefore: snapshot.postgres.containerId,
      postgresStartedAtBefore: snapshot.postgres.startedAt,
      baseImagesPulled: false,
      productionProjectionWrites: false,
      manualDoneGateWrites: false,
      manualProjectStateWrites: false,
      oldFactsDeletedOrOverwritten: false,
      projectionSnapshot: snapshot.projection,
      protectedStateSnapshot: snapshot.protectedState,
      predeploymentSnapshotDigest: snapshot.snapshotDigest,
      initialOldInstanceObserved: snapshot.initialBlockedRead.oldInstancePresent,
      initialOldHeartbeatObserved: snapshot.initialBlockedRead.oldHeartbeatPresent,
    },
    verifiedAt,
    observationWindow: {
      startedAt: deployedAt,
      finishedAt: verifiedAt,
      durationMilliseconds: Date.parse(verifiedAt) - Date.parse(deployedAt),
      startupRegistrationMilliseconds: Date.parse(registeredAt) - Date.parse(deployedAt),
      regression: regression.observationWindow,
    },
  };
  attestation.attestationDigest = digestObject(attestation);
  verifyCurrentState(attestation, { generating: true });
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(attestation, null, 2)}\n`);
  console.log(JSON.stringify(attestation, null, 2));
}

function verify() {
  const attestation = readJson(artifactPath);
  verifyCurrentState(attestation);
  console.log(JSON.stringify(attestation, null, 2));
}

if (mode === 'snapshot') captureSnapshot();
else if (mode === 'attest') generateAttestation();
else if (mode === 'verify') verify();
else throw new Error(`usage: ${path.basename(process.argv[1])} snapshot|attest|verify`);
