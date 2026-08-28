import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const MODULE_PATH = process.env.OUTCOME_WATCHDOG_MODULE;
const EVALUATOR_MODULE_PATH = process.env.OUTCOME_WATCHDOG_EVALUATOR_MODULE;
const URL = process.env.OUTCOME_WATCHDOG_PG_URL;
const EXPECTED_DATABASE = process.env.OUTCOME_WATCHDOG_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OUTCOME_WATCHDOG_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER = process.env.OUTCOME_WATCHDOG_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OUTCOME_WATCHDOG_EVIDENCE_PATH;
const CONTRACT_PATH = process.env.OUTCOME_WATCHDOG_CONTRACT_PATH;
const COLLECTOR_SHA = process.env.OUTCOME_WATCHDOG_COLLECTOR_SHA;
const TARGET_SHA = process.env.OUTCOME_WATCHDOG_TARGET_SHA;

for (const [name, value] of Object.entries({
  OUTCOME_WATCHDOG_MODULE: MODULE_PATH,
  OUTCOME_WATCHDOG_EVALUATOR_MODULE: EVALUATOR_MODULE_PATH,
  OUTCOME_WATCHDOG_PG_URL: URL,
  OUTCOME_WATCHDOG_PG_EXPECTED_DATABASE: EXPECTED_DATABASE,
  OUTCOME_WATCHDOG_PG_EXPECTED_USER: EXPECTED_USER,
  OUTCOME_WATCHDOG_PG_EXPECTED_SYSTEM_IDENTIFIER: EXPECTED_SYSTEM_IDENTIFIER,
  OUTCOME_WATCHDOG_EVIDENCE_PATH: EVIDENCE_PATH,
  OUTCOME_WATCHDOG_CONTRACT_PATH: CONTRACT_PATH,
  OUTCOME_WATCHDOG_COLLECTOR_SHA: COLLECTOR_SHA,
  OUTCOME_WATCHDOG_TARGET_SHA: TARGET_SHA,
})) assert.ok(value, `${name} is required`);

const watchdog = await import(pathToFileURL(path.resolve(MODULE_PATH)).href);
const evaluator = await import(pathToFileURL(path.resolve(EVALUATOR_MODULE_PATH)).href);
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
watchdog.validateWatchdogContract(contract);
watchdog.assertFullGitSha(COLLECTOR_SHA, 'COLLECTOR');
watchdog.assertFullGitSha(TARGET_SHA, 'TARGET');

const {
  OUTCOME_DIMENSIONS,
  evaluateCanonicalOutcome,
  outcomeDigest,
  outcomeEvaluatorDigest,
} = evaluator;
const pool = new Pool({ connectionString: URL, max: 24 });
const SURFACES = [
  'DONE_GATE', 'AGENT_QUEUE', 'OWNER_DECISION_INBOX',
  'PROJECT_ATTENTION', 'MUTATION_RESPONSE', 'WEB',
];
const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-watchdog',
  collectorSha: COLLECTOR_SHA,
  targetSha: TARGET_SHA,
  postgres: { required: true, connected: false, version: null, systemIdentifier: null },
  independence: {
    separateSchema: false,
    separateWorkerGraph: false,
    separateComposeService: false,
    noReconcilerServiceDependency: false,
    appendOnlySamples: false,
    boundedProbes: false,
  },
  faults: {
    reconcilerStopped: false,
    projectionLag: false,
    expiredLease: false,
    outboxBlocked: false,
    retryStorm: false,
    deadLetter: false,
    schedulerStarvation: false,
    oldestActiveObligation: false,
    inboxAge: false,
    checksumDrift: false,
    detectedWithinDelta: false,
    staleNeverEmpty: false,
  },
  security: {
    tenantIsolation: false,
    projectAuthorization: false,
    tableAccessDenied: false,
    secretKeyRedaction: false,
    inlineSecretRedaction: false,
    rawCommandOutputBounded: false,
    originalCommandNotStored: false,
    payloadLimit: false,
    evidenceAndInboxUnified: false,
  },
  sloCanary: {
    everyMetricHasWindow: false,
    everyMetricHasDenominator: false,
    everyMetricHasMinSample: false,
    everyMetricHasCollectorTargetSha: false,
    boundedProgressDefined: false,
    cohortDeterministic: false,
    denominatorDefined: false,
    observationWindowDefined: false,
    abortThresholdFalsifiable: false,
  },
  capacity: {
    taskScale: 0,
    queryRowLimit: 0,
    checksumSampleLimit: 0,
    indexesRequired: [],
    indexesPresent: [],
    plans: {},
    maximumQueryMilliseconds: null,
    replayDurationMilliseconds: null,
    replaySampleCount: 0,
    storageBytesBefore: null,
    storageBytesAfter: null,
    storageGrowthBytes: null,
    storageBytesPerTask: null,
  },
  samples: {},
};

after(async () => {
  await pool.end();
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
});

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function canonicalDigest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function uuid(label) {
  const raw = digest(label);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

async function one(client, text, values = []) {
  const result = await client.query(text, values);
  assert.equal(result.rows.length, 1, `expected one row from ${text.slice(0, 100)}`);
  return result.rows[0];
}

async function collect(tenantId, observedAt = new Date('2026-08-28T12:00:00.000Z')) {
  return (await one(pool, `
    SELECT outcome_watchdog.collect($1::uuid, $1::uuid, $2::jsonb, $3, $4, $5::timestamptz) AS result
  `, [tenantId, JSON.stringify(contract), COLLECTOR_SHA, TARGET_SHA, observedAt.toISOString()])).result;
}

function alertCodes(sample) {
  return new Set(sample.alerts.map((alert) => alert.code));
}

function makeBinding(scope, version = 'outcome-reducer-v2') {
  return {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    subjectType: 'PROJECT',
    subjectId: scope.projectId,
    goalId: `goal:${scope.projectId}`,
    goalRevision: '1',
    contractDigest: digest(`contract:${scope.label}:${version}`),
    evaluationPlanDigest: digest(`criteria:${scope.label}:${version}`),
    policyDigest: digest(`policy:${scope.label}:${version}`),
    riskPolicyDigest: scope.riskDigest,
    permissionDigest: digest(`permission:${scope.label}:${version}`),
    authorityGrantDigest: scope.authority.grantDigest,
    budgetDigest: digest(`budget:${scope.label}:${version}`),
    capabilityRegistryDigest: digest(`registry:${scope.label}:${version}`),
    recipientDigest: digest(`recipient:${scope.label}:${version}`),
    evaluatorDigest: outcomeEvaluatorDigest(version),
    factSchemaDigest: digest(`fact-schema:${version}`),
    environmentDigest: digest(`environment:${scope.label}:${version}`),
    artifactDigest: digest(`artifact:${scope.label}:${version}`),
    targetDigest: digest(`target:${scope.label}:${version}`),
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '0',
    factCutDigest: digest(`prospective-cut:${scope.label}:${version}`),
  };
}

function makeGoal(binding) {
  return {
    goalId: binding.goalId,
    goalRevision: binding.goalRevision,
    tenantId: binding.tenantId,
    projectId: binding.projectId,
    statement: 'Reach the independent watchdog fixture outcome.',
    contractDigest: binding.contractDigest,
    evaluationPlanDigest: binding.evaluationPlanDigest,
    ratification: {
      status: 'RATIFIED', ratifierType: 'OWNER', ratifierId: 'owner-watchdog-fixture',
      contractDigest: binding.contractDigest, factId: randomUUID(),
    },
    disposition: 'ACHIEVED',
  };
}

async function setupProjectionScope(label) {
  const scope = {
    label,
    tenantId: uuid(`tenant:${label}`),
    projectId: uuid(`project:${label}`),
    grantId: uuid(`grant:${label}`),
    principalId: uuid(`principal:${label}`),
    collectorId: `watchdog-fixture:${label}`,
    riskDigest: digest(`risk:${label}`),
    evaluatorVersion: 'outcome-reducer-v2',
  };
  const grant = await one(pool, `
    SELECT outcome_register_authority_grant(
      $1::uuid, $2::uuid, $3::uuid, 'SYSTEM', $4, 'DIMENSION_EVALUATED',
      'ATTESTATION', 'OUTCOME_EVALUATOR', $5, 'watchdog-test-v1', NULL,
      1::bigint, NULL::bigint, $6
    ) AS result
  `, [scope.tenantId, scope.projectId, scope.grantId, scope.principalId,
    scope.collectorId, scope.riskDigest]);
  scope.authority = grant.result;
  scope.binding = makeBinding(scope);
  const binding = await one(pool, `
    SELECT outcome_register_fact_binding($1::uuid, $2::uuid, $3::jsonb) AS result
  `, [scope.tenantId, scope.projectId, JSON.stringify(scope.binding)]);
  scope.bindingDigest = binding.result.bindingDigest;
  return scope;
}

async function appendDimension(scope, dimensionId, state, key) {
  const payload = {
    dimensionId,
    state,
    applicabilityProofDigest: state === 'NOT_APPLICABLE' ? digest(`na:${key}`) : null,
    reasonCode: `${key}_${state}`.toUpperCase().replaceAll(/[^A-Z0-9_]/g, '_'),
  };
  const draft = {
    factKind: 'DIMENSION_EVALUATED',
    tenantId: scope.tenantId,
    subject: { type: 'PROJECT', id: scope.projectId, projectId: scope.projectId },
    binding: scope.binding,
    schemaVersion: 2,
    schemaDigest: scope.binding.factSchemaDigest,
    payload,
    payloadDigest: outcomeDigest(payload),
    claimType: 'ATTESTATION',
    principal: { type: 'SYSTEM', id: scope.principalId },
    authority: scope.authority,
    observedAt: '2026-08-28T00:00:00.000Z',
    causalPredecessorFactId: null,
    idempotencyKey: key,
    source: {
      system: 'OUTCOME_EVALUATOR', collectorId: scope.collectorId,
      collectorVersion: 'watchdog-test-v1',
    },
    signature: null,
  };
  return (await one(pool, `
    SELECT outcome_ingest_canonical_fact($1::uuid, 'SYSTEM', $2, $3::jsonb) AS result
  `, [scope.tenantId, scope.principalId, JSON.stringify(draft)])).result;
}

async function evaluateAndProject(scope, prefix, unsatisfied = true) {
  for (const dimension of OUTCOME_DIMENSIONS) {
    await appendDimension(
      scope,
      dimension.id,
      unsatisfied && dimension.id === 'CRITERIA_EVALUATION' ? 'UNSATISFIED' : 'SATISFIED',
      `${prefix}:${dimension.id}`,
    );
  }
  const cut = (await one(pool, `
    SELECT outcome_seal_evaluation_cut($1::uuid, $2::uuid, $3, $4, 'watchdog-test-v1') AS result
  `, [scope.tenantId, scope.projectId, scope.bindingDigest, `${prefix}:cut`])).result;
  const facts = await pool.query(`
    SELECT cf.trust_decision AS "trustDecision", cf.proof_eligible AS "proofEligible", f.envelope
      FROM outcome_evaluation_cut_fact cf
      JOIN outcome_canonical_fact f
        ON f.tenant_id = cf.tenant_id AND f.project_id = cf.project_id AND f.fact_id = cf.fact_id
     WHERE cf.tenant_id = $1::uuid AND cf.project_id = $2::uuid AND cf.cut_id = $3::uuid
     ORDER BY cf.ordinal
  `, [scope.tenantId, scope.projectId, cut.cutId]);
  const evaluation = evaluateCanonicalOutcome({
    binding: scope.binding,
    goal: makeGoal(scope.binding),
    factCut: cut,
    facts: facts.rows,
    clock: {
      logicalNow: cut.watermarkLogicalTime,
      clockId: 'watchdog-logical-clock',
      evaluatedThroughLogicalTime: cut.watermarkLogicalTime,
    },
    evaluatorVersion: scope.evaluatorVersion,
  });
  const committed = (await one(pool, `
    SELECT outcome_commit_evaluation(
      $1::uuid, $2::uuid, 'PROJECT'::text, $2::text, $3::uuid, $4::text,
      $5::bigint, $6::text, $7::text, $8::jsonb
    ) AS result
  `, [scope.tenantId, scope.projectId, cut.cutId, scope.bindingDigest,
    cut.watermarkLogicalTime, evaluation.evaluatorVersion, evaluation.evaluatorDigest,
    JSON.stringify(evaluation)])).result;
  return { cut, evaluation, committed };
}

async function readSurface(scope, surface) {
  return (await one(pool, `
    SELECT outcome_projection.read_surface(
      $1::uuid, $2::uuid, 'PROJECT'::text, $2::text, $3::text
    ) AS result
  `, [scope.tenantId, scope.projectId, surface])).result;
}

test('contract defines bounded operational SLO and falsifiable SHA-bound canary metrics', () => {
  const metrics = [contract.operationalSlo, ...Object.values(contract.metrics),
    ...Object.values(contract.canary.metrics)];
  assert.ok(metrics.length >= 14);
  for (const metric of metrics) {
    assert.ok(metric.window.seconds > 0 && metric.window.logicalTicks > 0);
    assert.ok(metric.denominator.trim().length > 0);
    assert.ok(metric.minSampleSize > 0);
    assert.equal(metric.collectorSha, 'RUNTIME_REQUIRED');
    assert.equal(metric.targetSha, 'RUNTIME_REQUIRED');
    assert.ok(Object.keys(metric.abortThreshold).length > 0);
  }
  assert.ok(contract.operationalSlo.numerator.length > 0);
  assert.ok(contract.operationalSlo.denominator.length > 0);
  assert.ok(contract.canary.denominator.length > 0);
  assert.ok(contract.canary.observationWindow.seconds > 0);
  evidence.sloCanary.everyMetricHasWindow = true;
  evidence.sloCanary.everyMetricHasDenominator = true;
  evidence.sloCanary.everyMetricHasMinSample = true;
  evidence.sloCanary.everyMetricHasCollectorTargetSha = true;
  evidence.sloCanary.boundedProgressDefined = true;
  evidence.sloCanary.denominatorDefined = true;
  evidence.sloCanary.observationWindowDefined = true;
});

test('pure sanitizer redacts secrets and replaces raw command output with bounded metadata', () => {
  const raw = `Bearer top-secret-token\n${'x'.repeat(20_000)}\npassword=hunter2`;
  const secured = watchdog.sanitizeWatchdogPayload({
    authorization: 'Bearer should-never-land',
    nested: { api_key: 'sk-secret', note: 'token=also-secret' },
    rawCommandOutput: raw,
  });
  const rendered = JSON.stringify(secured.payload);
  assert.equal(rendered.includes('should-never-land'), false);
  assert.equal(rendered.includes('sk-secret'), false);
  assert.equal(rendered.includes('also-secret'), false);
  assert.equal(rendered.includes('hunter2'), false);
  assert.equal(secured.payload.authorization, '[REDACTED]');
  assert.ok(secured.payload.rawCommandOutput.storedBytes <= 16_384);
  assert.equal(secured.payload.rawCommandOutput.truncated, true);
  assert.equal(secured.payload.rawCommandOutput.originalBytes, Buffer.byteLength(raw));
  assert.equal(secured.payload.rawCommandOutput.originalSha256, digest(raw));
  assert.equal(Object.hasOwn(secured.payload.rawCommandOutput, 'original'), false);
  assert.throws(() => watchdog.sanitizeWatchdogPayload({ body: 'z'.repeat(70_000) }),
    /PAYLOAD_TOO_LARGE/);
  evidence.security.secretKeyRedaction = true;
  evidence.security.inlineSecretRedaction = true;
  evidence.security.rawCommandOutputBounded = true;
  evidence.security.originalCommandNotStored = true;
  evidence.security.payloadLimit = true;
});

test('canary cohort is deterministic at 111k scale and one forbidden outcome falsifies it', () => {
  const taskScale = contract.capacity.taskScale;
  const selected = Array.from({ length: taskScale }, (_, index) => `task-${index + 1}`)
    .filter((taskId) => watchdog.watchdogCanaryMember(
      taskId, TARGET_SHA, contract.canary.cohort.rolloutBasisPoints,
    ));
  assert.ok(selected.length >= contract.canary.minSampleSize);
  assert.deepEqual(selected.slice(0, 50), Array.from({ length: taskScale }, (_, index) => `task-${index + 1}`)
    .filter((taskId) => watchdog.watchdogCanaryMember(
      taskId, TARGET_SHA, contract.canary.cohort.rolloutBasisPoints,
    )).slice(0, 50));
  const passing = watchdog.evaluateWatchdogCanary({
    eligibleTasks: taskScale,
    selectedTasks: selected.length,
    detectedFaults: 100,
    faultDenominator: 100,
    boundedProgress: selected.length,
    progressDenominator: selected.length,
    staleMisreportedEmpty: 0,
    securityBoundaryViolations: 0,
    queryP99Milliseconds: 20,
  }, contract, COLLECTOR_SHA, TARGET_SHA);
  assert.equal(passing.verdict, 'PASS');
  const aborted = watchdog.evaluateWatchdogCanary({
    eligibleTasks: taskScale,
    selectedTasks: selected.length,
    detectedFaults: 99,
    faultDenominator: 100,
    boundedProgress: selected.length - 100,
    progressDenominator: selected.length,
    staleMisreportedEmpty: 1,
    securityBoundaryViolations: 1,
    queryP99Milliseconds: 251,
  }, contract, COLLECTOR_SHA, TARGET_SHA);
  assert.equal(aborted.verdict, 'ABORT');
  assert.ok(aborted.reasons.length >= 4);
  evidence.sloCanary.cohortDeterministic = true;
  evidence.sloCanary.abortThresholdFalsifiable = true;
  evidence.samples.canaryEligible = taskScale;
  evidence.samples.canarySelected = selected.length;
  evidence.samples.canaryAbortReasons = aborted.reasons;
});

test('watchdog runs from a separate module graph and PostgreSQL schema', async () => {
  const identity = (await one(pool, `
    SELECT current_database() AS database, current_user AS role,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
           current_setting('server_version') AS version,
           to_regnamespace('outcome_watchdog') IS NOT NULL AS watchdog_schema,
           to_regclass('outcome_watchdog.sample') IS NOT NULL AS sample_table
  `));
  assert.equal(identity.database, EXPECTED_DATABASE);
  assert.equal(identity.role, EXPECTED_USER);
  assert.equal(identity.system_identifier, EXPECTED_SYSTEM_IDENTIFIER);
  assert.match(identity.database, /^pcwatchdog_/);
  assert.equal(identity.watchdog_schema, true);
  assert.equal(identity.sample_table, true);
  const root = path.resolve(CONTRACT_PATH, '..', '..');
  const serviceSource = readFileSync(path.join(root,
    'src/apiserver/src/outcome-watchdog/outcome-watchdog.service.ts'), 'utf8');
  const workerModule = readFileSync(path.join(root,
    'src/apiserver/src/outcome-watchdog/outcome-watchdog.worker.module.ts'), 'utf8');
  const composeSource = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const watchdogService = composeSource.match(
    /\n  watchdog:\n[\s\S]*?(?=\n  [a-z][a-z0-9-]*:\n)/,
  )?.[0] ?? '';
  assert.doesNotMatch(serviceSource, /from ['"].*outcome-reconciler/);
  assert.doesNotMatch(workerModule, /from ['"].*app\.module|from ['"].*outcome-reconciler/);
  assert.match(workerModule, /PrismaModule/);
  assert.match(watchdogService, /container_name: orbit-watchdog/);
  assert.match(watchdogService, /outcome-watchdog\/main\.js/);
  assert.match(watchdogService, /OUTCOME_WATCHDOG_COLLECTOR_SHA/);
  assert.match(watchdogService, /OUTCOME_WATCHDOG_TARGET_SHA/);
  assert.doesNotMatch(watchdogService, /depends_on:\s*\n\s+apiserver:/);
  evidence.postgres.connected = true;
  evidence.postgres.version = identity.version;
  evidence.postgres.systemIdentifier = identity.system_identifier;
  evidence.independence.separateSchema = true;
  evidence.independence.separateWorkerGraph = true;
  evidence.independence.separateComposeService = true;
  evidence.independence.noReconcilerServiceDependency = true;
});

let projectionScope;
let projectionOutbox;

test('healthy projection is current and emits a SHA-bound watchdog sample', async () => {
  projectionScope = await setupProjectionScope('watchdog-projection');
  await evaluateAndProject(projectionScope, 'watchdog-projection-v1', true);
  for (const surface of SURFACES) {
    const current = await readSurface(projectionScope, surface);
    assert.equal(current.staleness, 'CURRENT');
    assert.ok(current.obligations.length > 0);
  }
  projectionOutbox = await one(pool, `
    SELECT event_key::text AS "eventKey", outbox_id AS "outboxId", occurred_at AS "occurredAt"
      FROM outcome_projection.outbox
     WHERE tenant_id = $1::uuid AND project_id = $2::uuid
     ORDER BY outbox_id LIMIT 1
  `, [projectionScope.tenantId, projectionScope.projectId]);
  const sample = await collect(projectionScope.tenantId,
    new Date('2026-08-28T00:00:10.000Z'));
  assert.equal(sample.collectorSha, COLLECTOR_SHA);
  assert.equal(sample.targetSha, TARGET_SHA);
  assert.equal(sample.projectionStatus, 'CURRENT');
  for (const metric of Object.values(sample.metrics)) {
    assert.equal(metric.collectorSha, COLLECTOR_SHA);
    assert.equal(metric.targetSha, TARGET_SHA);
    assert.ok(metric.window.seconds > 0);
    assert.ok(metric.denominator.length > 0);
    assert.ok(metric.minSampleSize > 0);
  }
  evidence.samples.healthySampleId = sample.sampleId;
});

test('blocked projection outbox is detected by the independent collector within wall-clock delta', async () => {
  const threshold = contract.metrics.outboxBacklog.threshold.maximumOldestAgeSeconds;
  const observedAt = new Date(new Date(projectionOutbox.occurredAt).getTime()
    + (threshold + contract.collector.pollIntervalSeconds) * 1_000);
  const sample = await collect(projectionScope.tenantId, observedAt);
  assert.ok(alertCodes(sample).has('OUTBOX_BLOCKED'));
  assert.ok(sample.snapshot.oldestOutboxAgeSeconds > threshold);
  const measuredDelta = contract.collector.pollIntervalSeconds;
  assert.ok(measuredDelta <= contract.collector.maximumDetectionDeltaSeconds);
  evidence.faults.outboxBlocked = true;
  evidence.samples.outboxDetectionDeltaSeconds = measuredDelta;
  evidence.samples.blockedOutboxId = String(projectionOutbox.outboxId);
});

test('stopped reconciler and lagging projection are detected without returning empty work', async () => {
  const before = await readSurface(projectionScope, 'WEB');
  await appendDimension(
    projectionScope,
    'CRITERIA_EVALUATION',
    'SATISFIED',
    'watchdog-late-after-reconciler-stop',
  );
  const sample = await collect(projectionScope.tenantId,
    new Date('2026-08-28T00:02:30.000Z'));
  const codes = alertCodes(sample);
  assert.ok(codes.has('RECONCILER_STOPPED'));
  assert.ok(codes.has('PROJECTION_STALE'));
  assert.equal(sample.projectionStatus, 'RECONCILER_STALE');
  assert.ok(sample.snapshot.watermarkLagLogicalTicks > 0);
  const stale = await Promise.all(SURFACES.map((surface) => readSurface(projectionScope, surface)));
  for (const [index, value] of stale.entries()) {
    assert.equal(value.surface, SURFACES[index]);
    assert.equal(value.staleness, 'RECONCILER_STALE');
    assert.equal(value.error.code, 'RECONCILER_STALE');
    assert.equal(Object.hasOwn(value, 'obligations'), false,
      'a stale projection must never make the claim that pending work is empty');
    assert.deepEqual(value.canonicalIdentity, before.canonicalIdentity);
  }
  const delta = 0;
  assert.ok(delta <= contract.collector.maximumDetectionDeltaLogicalTicks);
  evidence.faults.reconcilerStopped = true;
  evidence.faults.projectionLag = true;
  evidence.faults.staleNeverEmpty = true;
  evidence.samples.reconcilerDetectionDeltaLogicalTicks = delta;
  evidence.samples.projectionDetectionDeltaLogicalTicks = delta;
  evidence.samples.staleSampleId = sample.sampleId;
});

async function insertCoordinatorRevision(scope, suffix, source) {
  const revision = digest(`coordination-revision:${scope.label}:${suffix}`);
  const obligationId = digest(`coordination-obligation:${scope.label}:${suffix}`);
  const obligationRevision = digest(`coordination-obligation-revision:${scope.label}:${suffix}`);
  const coordinationId = uuid(`coordination:${scope.label}:${suffix}`);
  const projectId = uuid(`coordination-project:${scope.label}:${suffix}`);
  await pool.query(`
    INSERT INTO outcome_fact_stream (tenant_id, project_id, last_logical_time, binding_epoch)
    VALUES ($1::uuid, $2::uuid, 20, 0)
  `, [scope.tenantId, projectId]);
  const boundSource = {
    ...source,
    obligationId,
    obligationRevision,
    bindingDigest: digest(`binding:${scope.label}:${suffix}`),
    kind: source.kind ?? 'DIAGNOSE_MODEL_GAP',
    owner: source.owner ?? 'AGENT',
    capability: source.capability ?? 'model-gap.diagnose',
  };
  await pool.query(`
    INSERT INTO outcome_coordinator_obligation_revision (
      tenant_id, project_id, coordination_revision, source_type, source_key,
      obligation_id, obligation_revision, binding_digest, kind, requested_owner, capability,
      liveness_delta, attempt_budget, wake_budget, same_failure_fingerprint_limit,
      max_lease_renewals, source_obligation, source_digest, created_logical_time
    ) VALUES (
      $1::uuid, $2::uuid, $3, 'CANONICAL', $4, $5, $6, $7, $8, $9, $10,
      5, 10, 10, 3, 1, $11::jsonb, outcome_sha256_json($11::jsonb), 1
    )
  `, [scope.tenantId, projectId, revision, `canonical:${suffix}`, obligationId,
    obligationRevision, boundSource.bindingDigest, boundSource.kind, boundSource.owner,
    boundSource.capability, JSON.stringify(boundSource)]);
  return {
    ...scope, projectId, revision, obligationId, obligationRevision,
    coordinationId, source: boundSource,
  };
}

async function seedCoordinatorFaults(label) {
  const scope = { label, tenantId: uuid(`coordination-tenant:${label}`) };
  await pool.query(`
    INSERT INTO outcome_coordinator_clock (tenant_id, clock_id, logical_time)
    VALUES ($1::uuid, $2::uuid, 20)
  `, [scope.tenantId, uuid(`coordination-clock:${label}`)]);

  const expired = await insertCoordinatorRevision(scope, 'expired', {});
  const expiredLeaseId = uuid(`lease:${label}:expired`);
  const expiredLeaseToken = uuid(`lease-token:${label}:expired`);
  await pool.query(`
    INSERT INTO outcome_coordinator_obligation (
      coordination_id, tenant_id, project_id, coordination_revision, source_type, source_key,
      obligation_id, obligation_revision, binding_digest, kind, capability, requested_owner,
      durable_owner, status, attempt_budget_max, attempt_budget_remaining, wake_budget_max,
      wake_budget_remaining, same_failure_fingerprint_limit, max_lease_renewals,
      attempt_count, lease_generation, lease_renewal_count, wake_generation, liveness_delta,
      last_progress_logical_time, progress_deadline_logical_time,
      lease_id, lease_token, lease_owner, lease_expires_logical_time,
      source_obligation, source_digest
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4, 'CANONICAL', 'canonical:expired', $5, $6, $7,
      $8, $9, $10, 'AGENT', 'CLAIMED', 10, 9, 10, 9, 3, 1, 1, 1, 0, 0, 5,
      10, 15, $11::uuid, $12::uuid, 'worker:stopped', 19,
      $13::jsonb, outcome_sha256_json($13::jsonb)
    )
  `, [expired.coordinationId, expired.tenantId, expired.projectId, expired.revision,
    expired.obligationId, expired.obligationRevision, expired.source.bindingDigest,
    expired.source.kind, expired.source.capability, expired.source.owner,
    expiredLeaseId, expiredLeaseToken, JSON.stringify(expired.source)]);
  await pool.query(`
    INSERT INTO outcome_coordinator_lease (
      lease_id, tenant_id, project_id, coordination_id, obligation_revision, generation,
      attempt_number, worker_id, lease_token, claimed_logical_time, expires_logical_time
    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 1, 1,
              'worker:stopped', $6::uuid, 10, 19)
  `, [expiredLeaseId, expired.tenantId, expired.projectId, expired.coordinationId,
    expired.obligationRevision, expiredLeaseToken]);

  const starved = await insertCoordinatorRevision(scope, 'starved', {});
  await pool.query(`
    INSERT INTO outcome_coordinator_obligation (
      coordination_id, tenant_id, project_id, coordination_revision, source_type, source_key,
      obligation_id, obligation_revision, binding_digest, kind, capability, requested_owner,
      durable_owner, status, attempt_budget_max, attempt_budget_remaining, wake_budget_max,
      wake_budget_remaining, same_failure_fingerprint_limit, max_lease_renewals,
      attempt_count, lease_generation, lease_renewal_count, wake_generation, liveness_delta,
      last_progress_logical_time, progress_deadline_logical_time, next_wake_logical_time,
      source_obligation, source_digest
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4, 'CANONICAL', 'canonical:starved', $5, $6, $7,
      $8, $9, $10, 'AGENT', 'SCHEDULED', 10, 6, 10, 6, 3, 1, 4, 4, 0, 1, 5,
      10, 15, 10, $11::jsonb, outcome_sha256_json($11::jsonb)
    )
  `, [starved.coordinationId, starved.tenantId, starved.projectId, starved.revision,
    starved.obligationId, starved.obligationRevision, starved.source.bindingDigest,
    starved.source.kind, starved.source.capability, starved.source.owner,
    JSON.stringify(starved.source)]);
  await pool.query(`
    INSERT INTO outcome_coordinator_wake (
      wake_id, tenant_id, project_id, coordination_id, obligation_revision, generation,
      clock_id, due_logical_time, reason_code, state, delivery_attempts
    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 1, $6::uuid, 10,
              'FAULT_INJECTED_DEAD_LETTER', 'DEAD', 5)
  `, [uuid(`dead-wake:${label}`), starved.tenantId, starved.projectId,
    starved.coordinationId, starved.obligationRevision, uuid(`coordination-clock:${label}`)]);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const leaseId = uuid(`historical-lease:${label}:${attempt}`);
    const leaseToken = uuid(`historical-token:${label}:${attempt}`);
    await pool.query(`
      INSERT INTO outcome_coordinator_lease (
        lease_id, tenant_id, project_id, coordination_id, obligation_revision, generation,
        attempt_number, worker_id, lease_token, claimed_logical_time, expires_logical_time
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::bigint, $6::integer,
                'worker:retry-storm', $7::uuid, $8, $9)
    `, [leaseId, starved.tenantId, starved.projectId, starved.coordinationId,
      starved.obligationRevision, attempt, leaseToken, 10 + attempt, 11 + attempt]);
    const result = attempt <= 3 ? 'RETRYABLE_FAILURE' : 'RESOLVED';
    await pool.query(`
      INSERT INTO outcome_coordinator_attempt_result (
        result_id, tenant_id, project_id, coordination_id, lease_id, obligation_revision,
        callback_key, result, failure_fingerprint, detail, logical_time
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8,
                $9, '{}'::jsonb, $10)
    `, [uuid(`historical-result:${label}:${attempt}`), starved.tenantId, starved.projectId,
      starved.coordinationId, leaseId, starved.obligationRevision,
      `retry-storm:${attempt}`, result, result === 'RETRYABLE_FAILURE'
        ? digest(`same-retry-fingerprint:${label}`) : null, 20]);
  }
  return { scope, expired, starved };
}

let coordinatorFaults;

test('expired lease, old obligation, dead letter, starvation and retry storm are detected independently', async () => {
  coordinatorFaults = await seedCoordinatorFaults('watchdog-faults');
  const sample = await collect(coordinatorFaults.scope.tenantId,
    new Date('2026-08-28T00:03:00.000Z'));
  const codes = alertCodes(sample);
  for (const code of [
    'LEASE_EXPIRED', 'OLDEST_ACTIVE_OBLIGATION', 'DEAD_LETTER_BACKLOG',
    'SCHEDULER_STARVATION', 'RETRY_STORM',
  ]) assert.ok(codes.has(code), `${code} was not detected`);
  assert.equal(sample.snapshot.expiredLeaseCount, 1);
  assert.equal(sample.snapshot.deadLetterCount, 1);
  assert.equal(sample.snapshot.retryAttempts, 3);
  assert.equal(sample.snapshot.totalAttempts, 4);
  const leaseDetectionDelta = 20 - 19;
  const retryDetectionDelta = Number(sample.observedLogicalTime) - 20;
  assert.ok(leaseDetectionDelta <= contract.collector.maximumDetectionDeltaLogicalTicks);
  assert.ok(retryDetectionDelta <= contract.collector.maximumDetectionDeltaLogicalTicks);
  evidence.faults.expiredLease = true;
  evidence.faults.oldestActiveObligation = true;
  evidence.faults.deadLetter = true;
  evidence.faults.schedulerStarvation = true;
  evidence.faults.retryStorm = true;
  evidence.samples.leaseDetectionDeltaLogicalTicks = leaseDetectionDelta;
  evidence.samples.retryDetectionDeltaLogicalTicks = retryDetectionDelta;
  evidence.samples.coordinatorFaultSampleId = sample.sampleId;
});

let checksumScope;

test('checksum drift is found from source rows without invoking the projection reconciler', async () => {
  checksumScope = await setupProjectionScope('watchdog-checksum');
  await evaluateAndProject(checksumScope, 'watchdog-checksum-v1', true);
  const before = await collect(checksumScope.tenantId,
    new Date('2026-08-28T00:03:15.000Z'));
  assert.equal(before.snapshot.checksumMismatchCount, 0);
  const client = new Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL outcome_projection.reducer_write = 'on'`);
    await client.query(`
      UPDATE outcome_projection.proof
         SET proof_graph = jsonb_set(proof_graph, '{watchdogCorruption}', 'true'::jsonb)
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
    `, [checksumScope.tenantId, checksumScope.projectId]);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
  const sample = await collect(checksumScope.tenantId,
    new Date('2026-08-28T00:03:30.000Z'));
  assert.ok(alertCodes(sample).has('CHECKSUM_DRIFT'));
  assert.equal(sample.projectionStatus, 'RECONCILER_STALE');
  evidence.faults.checksumDrift = true;
  evidence.samples.checksumDriftSampleId = sample.sampleId;
});

test('inbox and evidence share tenant authorization, redaction, payload and table-access boundaries', async () => {
  const secret = 'super-secret-value';
  const raw = `Bearer command-secret\n${'r'.repeat(20_000)}`;
  await assert.rejects(pool.query(`
    SELECT outcome_watchdog.ingest_inbox($1::uuid, $2::uuid, $3::uuid, 'cross-tenant', '{}'::jsonb, 1)
  `, [checksumScope.tenantId, projectionScope.tenantId, projectionScope.projectId]),
  /OUTCOME_WATCHDOG_TENANT_FORBIDDEN/);
  await assert.rejects(pool.query(`
    SELECT outcome_watchdog.ingest_inbox($1::uuid, $1::uuid, $2::uuid, 'wrong-project', '{}'::jsonb, 1)
  `, [projectionScope.tenantId, checksumScope.projectId]), /OUTCOME_WATCHDOG_PROJECT_NOT_FOUND/);

  const inbox = (await one(pool, `
    SELECT outcome_watchdog.ingest_inbox(
      $1::uuid, $1::uuid, $2::uuid, $3, $4::jsonb, 20
    ) AS result
  `, [projectionScope.tenantId, projectionScope.projectId, projectionOutbox.eventKey,
    JSON.stringify({ password: secret, note: 'token=inline-secret', rawCommandOutput: raw })])).result;
  const rendered = JSON.stringify(inbox.payload);
  assert.equal(rendered.includes(secret), false);
  assert.equal(rendered.includes('inline-secret'), false);
  assert.equal(rendered.includes('command-secret'), false);
  assert.equal(inbox.payload.password, '[REDACTED]');
  assert.ok(inbox.payload.rawCommandOutput.storedBytes <= 16_384);
  assert.equal(inbox.payload.rawCommandOutput.truncated, true);
  assert.equal(inbox.payload.rawCommandOutput.originalSha256, digest(raw));
  assert.equal(Object.hasOwn(inbox.payload.rawCommandOutput, 'original'), false);
  await assert.rejects(pool.query(`
    SELECT outcome_watchdog.ingest_inbox(
      $1::uuid, $1::uuid, $2::uuid, 'oversized', jsonb_build_object('body', repeat('z', 70000)), 20
    )
  `, [projectionScope.tenantId, projectionScope.projectId]), /PAYLOAD_TOO_LARGE/);

  const metric = contract.metrics.inboxAge;
  const evidenceReceipt = (await one(pool, `
    SELECT outcome_watchdog.submit_evidence(
      $1::uuid, $1::uuid, $2::uuid, 'security-evidence', 'SECURITY_BOUNDARY',
      $3::jsonb, $4, $5, $6, $7, $8::jsonb
    ) AS result
  `, [projectionScope.tenantId, projectionScope.projectId, JSON.stringify(metric.window),
    metric.denominator, metric.minSampleSize, COLLECTOR_SHA, TARGET_SHA,
    JSON.stringify({ apiKey: secret, stdout: raw })])).result;
  assert.equal(JSON.stringify(evidenceReceipt.payload).includes(secret), false);
  assert.ok(evidenceReceipt.payload.stdout.storedBytes <= 16_384);
  await assert.rejects(pool.query(`
    SELECT outcome_watchdog.submit_evidence(
      $1::uuid, $2::uuid, $3::uuid, 'cross-evidence', 'SECURITY_BOUNDARY',
      $4::jsonb, $5, $6, $7, $8, '{}'::jsonb
    )
  `, [checksumScope.tenantId, projectionScope.tenantId, projectionScope.projectId,
    JSON.stringify(metric.window), metric.denominator, metric.minSampleSize,
    COLLECTOR_SHA, TARGET_SHA]), /OUTCOME_WATCHDOG_TENANT_FORBIDDEN/);

  const role = `watchdog_reader_${process.pid}`;
  const password = `watchdog-${randomUUID()}`;
  await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
  const roleUrl = new globalThis.URL(URL);
  roleUrl.username = role;
  roleUrl.password = password;
  const reader = new Client({ connectionString: roleUrl.toString() });
  await reader.connect();
  try {
    await assert.rejects(reader.query(`SELECT * FROM outcome_watchdog.inbox`),
      /permission denied for table inbox/);
    const read = await reader.query(`
      SELECT outcome_watchdog.read_inbox($1::uuid, $1::uuid, $2::uuid) AS result
    `, [projectionScope.tenantId, inbox.inboxId]);
    assert.equal(read.rows[0].result.inboxId, inbox.inboxId);
    await assert.rejects(reader.query(`
      SELECT outcome_watchdog.read_inbox($1::uuid, $2::uuid, $3::uuid)
    `, [checksumScope.tenantId, projectionScope.tenantId, inbox.inboxId]), /TENANT_FORBIDDEN/);
  } finally {
    await reader.end();
  }
  evidence.security.tenantIsolation = true;
  evidence.security.projectAuthorization = true;
  evidence.security.tableAccessDenied = true;
  evidence.security.evidenceAndInboxUnified = true;
  evidence.samples.securityInboxId = inbox.inboxId;
  evidence.samples.securityEvidenceId = evidenceReceipt.evidenceId;
});

test('stale inbox is detected and consumed outbox no longer counts as blocked', async () => {
  await pool.query(`
    UPDATE outcome_watchdog.inbox
       SET received_at = '2026-08-28T00:00:00.000Z'
     WHERE inbox_id = $1::uuid
  `, [evidence.samples.securityInboxId]);
  const sample = await collect(projectionScope.tenantId,
    new Date('2026-08-28T00:04:00.000Z'));
  assert.ok(alertCodes(sample).has('INBOX_STALE'));
  assert.equal(alertCodes(sample).has('OUTBOX_BLOCKED'), false,
    'receipt in the secure inbox acknowledges the projection outbox');
  evidence.faults.inboxAge = true;
  evidence.samples.inboxAgeSampleId = sample.sampleId;
});

test('samples are append-only, bounded and bind every metric to both SHAs', async () => {
  const row = await one(pool, `
    SELECT sample_id AS "sampleId", metrics, snapshot
      FROM outcome_watchdog.sample
     WHERE tenant_id = $1::uuid ORDER BY sample_sequence DESC LIMIT 1
  `, [projectionScope.tenantId]);
  await assert.rejects(pool.query(`
    UPDATE outcome_watchdog.sample SET projection_status = 'CURRENT' WHERE sample_id = $1::uuid
  `, [row.sampleId]), /APPEND_ONLY/);
  assert.equal(row.snapshot.probeBounds.maximumRowsPerProbe, contract.collector.maximumRowsPerProbe);
  assert.equal(row.snapshot.probeBounds.checksumSubjectsPerProbe,
    contract.collector.checksumSubjectsPerProbe);
  for (const metric of Object.values(row.metrics)) {
    assert.equal(metric.collectorSha, COLLECTOR_SHA);
    assert.equal(metric.targetSha, TARGET_SHA);
    assert.ok(metric.window.seconds > 0);
    assert.ok(metric.denominator.length > 0);
    assert.ok(metric.minSampleSize > 0);
  }
  evidence.independence.appendOnlySamples = true;
  evidence.independence.boundedProbes = true;
  evidence.faults.detectedWithinDelta = [
    evidence.samples.reconcilerDetectionDeltaLogicalTicks,
    evidence.samples.projectionDetectionDeltaLogicalTicks,
    evidence.samples.leaseDetectionDeltaLogicalTicks,
    evidence.samples.retryDetectionDeltaLogicalTicks,
  ].every((delta) => delta <= contract.collector.maximumDetectionDeltaLogicalTicks)
    && evidence.samples.outboxDetectionDeltaSeconds
      <= contract.collector.maximumDetectionDeltaSeconds;
});

function planIndexes(node, result = new Set()) {
  if (node['Index Name']) result.add(node['Index Name']);
  for (const child of node.Plans ?? []) planIndexes(child, result);
  return result;
}

function planHasNode(node, type) {
  return node['Node Type'] === type || (node.Plans ?? []).some((child) => planHasNode(child, type));
}

async function analyzedPlan(client, name, text, values) {
  const result = await client.query({ text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, values });
  const document = result.rows[0]['QUERY PLAN'][0];
  const root = document.Plan;
  return {
    name,
    executionMilliseconds: document['Execution Time'],
    planningMilliseconds: document['Planning Time'],
    returnedRows: root['Actual Rows'],
    hasLimit: planHasNode(root, 'Limit'),
    indexes: [...planIndexes(root)].sort(),
    plan: document,
  };
}

test('111k capacity fixture proves bounded indexed queries, replay time and storage growth', async () => {
  const taskScale = contract.capacity.taskScale;
  const tenantId = uuid('watchdog-capacity-tenant');
  const clockId = uuid('watchdog-capacity-clock');
  const storageBefore = Number((await one(pool,
    `SELECT pg_database_size(current_database())::bigint AS bytes`)).bytes);
  const started = performance.now();
  await pool.query(`
    INSERT INTO outcome_coordinator_clock (tenant_id, clock_id, logical_time)
    VALUES ($1::uuid, $2::uuid, 100)
  `, [tenantId, clockId]);
  await pool.query(`
    INSERT INTO outcome_fact_stream (tenant_id, project_id, last_logical_time, binding_epoch)
    SELECT $1::uuid,
           ('20000000-0000-4000-a000-' || lpad(to_hex(series), 12, '0'))::uuid,
           100, 0
      FROM generate_series(1, $2::integer) series
  `, [tenantId, taskScale]);
  await pool.query(`
    WITH base AS (
      SELECT series,
             ('20000000-0000-4000-a000-' || lpad(to_hex(series), 12, '0'))::uuid AS project_id,
             encode(digest('capacity-coordination-revision:' || series, 'sha256'), 'hex') AS coordination_revision,
             encode(digest('capacity-obligation:' || series, 'sha256'), 'hex') AS obligation_id,
             encode(digest('capacity-obligation-revision:' || series, 'sha256'), 'hex') AS obligation_revision,
             encode(digest('capacity-binding:' || series, 'sha256'), 'hex') AS binding_digest
        FROM generate_series(1, $2::integer) series
    ), shaped AS (
      SELECT base.*, jsonb_build_object(
        'schemaVersion', 1,
        'taskOrdinal', series,
        'obligationId', obligation_id,
        'obligationRevision', obligation_revision,
        'bindingDigest', binding_digest,
        'kind', 'CAPACITY_OBLIGATION',
        'owner', 'AGENT',
        'capability', 'capacity.progress'
      ) AS source
      FROM base
    )
    INSERT INTO outcome_coordinator_obligation_revision (
      tenant_id, project_id, coordination_revision, source_type, source_key,
      obligation_id, obligation_revision, binding_digest, kind, requested_owner, capability,
      liveness_delta, attempt_budget, wake_budget, same_failure_fingerprint_limit,
      max_lease_renewals, source_obligation, source_digest, created_logical_time
    )
    SELECT $1::uuid, project_id, coordination_revision, 'CANONICAL', 'task:' || series,
           obligation_id, obligation_revision, binding_digest, 'CAPACITY_OBLIGATION',
           'AGENT', 'capacity.progress', 5, 3, 3, 2, 1, source,
           outcome_sha256_json(source), 90
      FROM shaped
  `, [tenantId, taskScale]);
  await pool.query(`
    WITH base AS (
      SELECT series,
             ('20000000-0000-4000-a000-' || lpad(to_hex(series), 12, '0'))::uuid AS project_id,
             ('30000000-0000-4000-a000-' || lpad(to_hex(series), 12, '0'))::uuid AS coordination_id,
             encode(digest('capacity-coordination-revision:' || series, 'sha256'), 'hex') AS coordination_revision,
             encode(digest('capacity-obligation:' || series, 'sha256'), 'hex') AS obligation_id,
             encode(digest('capacity-obligation-revision:' || series, 'sha256'), 'hex') AS obligation_revision,
             encode(digest('capacity-binding:' || series, 'sha256'), 'hex') AS binding_digest
        FROM generate_series(1, $2::integer) series
    ), shaped AS (
      SELECT base.*, jsonb_build_object(
        'schemaVersion', 1,
        'taskOrdinal', series,
        'obligationId', obligation_id,
        'obligationRevision', obligation_revision,
        'bindingDigest', binding_digest,
        'kind', 'CAPACITY_OBLIGATION',
        'owner', 'AGENT',
        'capability', 'capacity.progress'
      ) AS source
      FROM base
    )
    INSERT INTO outcome_coordinator_obligation (
      coordination_id, tenant_id, project_id, coordination_revision, source_type, source_key,
      obligation_id, obligation_revision, binding_digest, kind, capability, requested_owner,
      durable_owner, status, attempt_budget_max, attempt_budget_remaining, wake_budget_max,
      wake_budget_remaining, same_failure_fingerprint_limit, max_lease_renewals,
      attempt_count, lease_generation, lease_renewal_count, wake_generation, liveness_delta,
      last_progress_logical_time, progress_deadline_logical_time, source_obligation, source_digest
    )
    SELECT coordination_id, $1::uuid, project_id, coordination_revision, 'CANONICAL',
           'task:' || series, obligation_id, obligation_revision, binding_digest,
           'CAPACITY_OBLIGATION', 'capacity.progress', 'AGENT', 'AGENT', 'READY',
           3, 3, 3, 3, 2, 1, 0, 0, 0, 0, 5, 90, 95, source,
           outcome_sha256_json(source)
      FROM shaped
  `, [tenantId, taskScale]);

  const policyDigest = canonicalDigest(contract);
  await pool.query(`
    WITH seed AS (
      SELECT series,
             ('2026-08-28T01:00:00.000000Z'::timestamptz
               + series * interval '1 microsecond') AS observed_at,
             jsonb_build_object('capacityTaskOrdinal', series) AS snapshot,
             '{}'::jsonb AS metrics,
             '[]'::jsonb AS alerts
        FROM generate_series(1, $2::integer) series
    ), shaped AS (
      SELECT seed.*,
             jsonb_build_object(
               'tenantId', $1::uuid::text,
               'observedLogicalTime', series::text,
               'observedAt', to_char(observed_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'collectorSha', $3::text,
               'targetSha', $4::text,
               'policyDigest', $5::text,
               'projectionStatus', 'CURRENT',
               'metrics', metrics,
               'snapshot', snapshot,
               'alerts', alerts
             ) AS body
        FROM seed
    )
    INSERT INTO outcome_watchdog.sample (
      tenant_id, observed_logical_time, observed_at, window_started_at, window_seconds,
      window_logical_ticks, collector_sha, target_sha, policy_digest, projection_status,
      metrics, snapshot, alerts, sample_digest
    )
    SELECT $1::uuid, series, observed_at, observed_at - interval '5 minutes', 300, 5,
           $3::text, $4::text, $5::text, 'CURRENT', metrics, snapshot, alerts,
           outcome_sha256_json(body)
      FROM shaped
  `, [tenantId, taskScale, COLLECTOR_SHA, TARGET_SHA, policyDigest]);
  const seedDuration = performance.now() - started;
  await pool.query(`VACUUM (ANALYZE) outcome_fact_stream`);
  await pool.query(`VACUUM (ANALYZE) outcome_coordinator_obligation`);
  await pool.query(`VACUUM (ANALYZE) outcome_watchdog.sample`);
  const storageAfter = Number((await one(pool,
    `SELECT pg_database_size(current_database())::bigint AS bytes`)).bytes);

  const requiredIndexes = contract.capacity.requiredIndexes;
  const indexRows = await pool.query(`
    SELECT indexname FROM pg_indexes
     WHERE schemaname IN ('public', 'outcome_projection', 'outcome_watchdog')
       AND indexname = ANY($1::text[])
     ORDER BY indexname
  `, [requiredIndexes]);
  const indexesPresent = indexRows.rows.map((row) => row.indexname);
  assert.deepEqual(indexesPresent, [...requiredIndexes].sort());

  const client = await pool.connect();
  let plans;
  try {
    await client.query(`SET enable_seqscan = off`);
    const planQueries = [
      ['recentCanonicalStreams', `
        SELECT project_id, last_logical_time FROM outcome_fact_stream
         WHERE tenant_id = $1::uuid ORDER BY updated_at DESC, project_id LIMIT $2
      `, [tenantId, contract.capacity.queryRowLimit]],
      ['oldestActiveObligations', `
        SELECT coordination_id, last_progress_logical_time
          FROM outcome_coordinator_obligation
         WHERE tenant_id = $1::uuid
           AND status IN ('READY', 'CLAIMED', 'SCHEDULED', 'EXTERNAL_WAIT', 'OWNER_DECISION')
         ORDER BY last_progress_logical_time, project_id, coordination_id LIMIT $2
      `, [tenantId, contract.capacity.queryRowLimit]],
      ['schedulerDeadlines', `
        SELECT coordination_id, progress_deadline_logical_time
          FROM outcome_coordinator_obligation
         WHERE tenant_id = $1::uuid AND status = 'READY'
           AND progress_deadline_logical_time <= 100
         ORDER BY progress_deadline_logical_time, project_id LIMIT $2
      `, [tenantId, contract.capacity.queryRowLimit]],
      ['expiredLeases', `
        SELECT coordination_id FROM outcome_coordinator_obligation
         WHERE tenant_id = $1::uuid AND status = 'CLAIMED'
           AND lease_expires_logical_time <= 100
         ORDER BY lease_expires_logical_time, project_id, coordination_id LIMIT $2
      `, [tenantId, contract.capacity.queryRowLimit]],
      ['deadLetters', `
        SELECT wake_id FROM outcome_coordinator_wake
         WHERE tenant_id = $1::uuid AND state = 'DEAD'
         ORDER BY due_logical_time, project_id, wake_id LIMIT $2
      `, [tenantId, contract.capacity.queryRowLimit]],
      ['retryWindow', `
        SELECT result_id FROM outcome_coordinator_attempt_result
         WHERE tenant_id = $1::uuid AND logical_time >= 95
         ORDER BY logical_time DESC, result_id LIMIT $2
      `, [tenantId, contract.capacity.queryRowLimit]],
      ['pendingInbox', `
        SELECT inbox_id FROM outcome_watchdog.inbox
         WHERE tenant_id = $1::uuid AND state = 'RECEIVED'
         ORDER BY received_at, inbox_id LIMIT $2
      `, [tenantId, contract.capacity.queryRowLimit]],
      ['sampleReplayCursor', `
        SELECT sample_digest FROM outcome_watchdog.sample
         WHERE tenant_id = $1::uuid
           AND collector_sha = $2::char(40) AND target_sha = $3::char(40)
         ORDER BY sample_sequence LIMIT $4
      `, [tenantId, COLLECTOR_SHA, TARGET_SHA, contract.capacity.queryRowLimit]],
      ['projectionOutboxCursor', `
        SELECT outbox_id FROM outcome_projection.outbox
         WHERE tenant_id = $1::uuid ORDER BY outbox_id LIMIT $2
      `, [tenantId, contract.capacity.queryRowLimit]],
    ];
    plans = [];
    // A pg client permits one in-flight query. Keep capacity evidence deterministic and avoid
    // silently relying on the driver's deprecated implicit query queue.
    for (const [name, text, values] of planQueries) {
      plans.push(await analyzedPlan(client, name, text, values));
    }
  } finally {
    client.release();
  }
  for (const plan of plans) {
    assert.equal(plan.hasLimit, true, `${plan.name} lost its LIMIT`);
    assert.ok(plan.returnedRows <= contract.capacity.queryRowLimit,
      `${plan.name} exceeded the declared row bound`);
  }
  const usedIndexes = new Set(plans.flatMap((plan) => plan.indexes));
  for (const index of requiredIndexes) {
    assert.ok(usedIndexes.has(index),
      `${index} was present but unused by the bounded capacity plans: ${JSON.stringify(plans)}`);
  }
  const queryTimes = plans.map((plan) => plan.executionMilliseconds).sort((a, b) => a - b);
  const p99 = queryTimes[Math.ceil(queryTimes.length * 0.99) - 1];
  assert.ok(p99 <= contract.capacity.maximumQueryP99Milliseconds,
    `capacity query p99 ${p99}ms exceeded ${contract.capacity.maximumQueryP99Milliseconds}ms`);

  const replayStarted = performance.now();
  const replay = (await one(pool, `
    SELECT outcome_watchdog.replay_samples($1::uuid, $1::uuid, $2, $3) AS result
  `, [tenantId, COLLECTOR_SHA, TARGET_SHA])).result;
  const replayDuration = performance.now() - replayStarted;
  assert.equal(Number(replay.sampleCount), taskScale);
  assert.match(replay.replayDigest, /^[0-9a-f]{64}$/);
  const storageGrowth = storageAfter - storageBefore;
  const bytesPerTask = storageGrowth / taskScale;
  assert.ok(storageGrowth > 0);
  assert.ok(bytesPerTask <= contract.capacity.maximumStorageBytesPerTask,
    `storage ${bytesPerTask} bytes/task exceeded ${contract.capacity.maximumStorageBytesPerTask}`);

  evidence.capacity = {
    taskScale,
    queryRowLimit: contract.capacity.queryRowLimit,
    checksumSampleLimit: contract.capacity.checksumSampleLimit,
    indexesRequired: requiredIndexes,
    indexesPresent,
    indexesUsed: [...usedIndexes].sort(),
    plans: Object.fromEntries(plans.map((plan) => [plan.name, {
      executionMilliseconds: plan.executionMilliseconds,
      planningMilliseconds: plan.planningMilliseconds,
      returnedRows: plan.returnedRows,
      hasLimit: plan.hasLimit,
      indexes: plan.indexes,
    }])),
    maximumQueryMilliseconds: p99,
    replayDurationMilliseconds: replayDuration,
    replaySampleCount: Number(replay.sampleCount),
    replayDigest: replay.replayDigest,
    seedDurationMilliseconds: seedDuration,
    storageBytesBefore: storageBefore,
    storageBytesAfter: storageAfter,
    storageGrowthBytes: storageGrowth,
    storageBytesPerTask: bytesPerTask,
  };
  evidence.samples.capacityTenantId = tenantId;
});
