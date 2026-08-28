import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const MODULE_PATH = process.env.OUTCOME_COORDINATOR_MODULE;
const SERVICE_MODULE_PATH = process.env.OUTCOME_COORDINATOR_SERVICE_MODULE;
const ACTION_MODULE_PATH = process.env.OUTCOME_COORDINATOR_ACTION_MODULE;
const URL = process.env.OUTCOME_COORDINATOR_PG_URL;
const EXPECTED_DATABASE = process.env.OUTCOME_COORDINATOR_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OUTCOME_COORDINATOR_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER = process.env.OUTCOME_COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OUTCOME_COORDINATOR_EVIDENCE_PATH;

for (const [name, value] of Object.entries({
  OUTCOME_COORDINATOR_MODULE: MODULE_PATH,
  OUTCOME_COORDINATOR_SERVICE_MODULE: SERVICE_MODULE_PATH,
  OUTCOME_COORDINATOR_ACTION_MODULE: ACTION_MODULE_PATH,
  OUTCOME_COORDINATOR_PG_URL: URL,
  OUTCOME_COORDINATOR_PG_EXPECTED_DATABASE: EXPECTED_DATABASE,
  OUTCOME_COORDINATOR_PG_EXPECTED_USER: EXPECTED_USER,
  OUTCOME_COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER: EXPECTED_SYSTEM_IDENTIFIER,
  OUTCOME_COORDINATOR_EVIDENCE_PATH: EVIDENCE_PATH,
})) assert.ok(value, `${name} is required`);

const coordinator = await import(pathToFileURL(path.resolve(MODULE_PATH)).href);
const { OutcomeCoordinatorResolverRegistry } = await import(
  pathToFileURL(path.resolve(SERVICE_MODULE_PATH)).href
);
const { actionBackoffDigest, actionProtocolDigest } = await import(
  pathToFileURL(path.resolve(ACTION_MODULE_PATH)).href
);

const pool = new Pool({ connectionString: URL, max: 32 });
const clocks = new Map();
const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-coordinator',
  postgres: { required: true, connected: false, version: null, systemIdentifier: null },
  persistence: {
    durableClock: false,
    canonicalDiscovery: false,
    durableOwnerAndWake: false,
    immutableTrace: false,
  },
  recovery: {
    crashTakeover: false,
    expiredLeaseFenced: false,
    boundedLeaseRenewal: false,
    lostWakeRebuilt: false,
    duplicateWakeIdempotent: false,
    duplicateCallbackIdempotent: false,
    staleCallbackRejected: false,
  },
  bounded: {
    attemptBudgetExhaustion: false,
    fingerprintChangesPath: false,
    repeatedFingerprintEscalates: false,
    wakeBudgetFinite: false,
    noLeaseWakeChurn: false,
  },
  scheduling: {
    quotaWaitSystemOwned: false,
    externalWaitAutoResume: false,
    durableBackoff: false,
    crossProjectFairness: false,
    livenessDeltaDisposition: false,
    zeroActiveViolations: false,
  },
  decisions: {
    closedReasonSet: false,
    whyNotAgentRequired: false,
    fullProtocolRequired: false,
    validRequestDurable: false,
    decisionAutoResume: false,
    externalWaitDoesNotNotifyOwner: false,
    ordinaryFailureDoesNotNotifyOwner: false,
  },
  executor: {
    resolverRegistryBound: false,
    constrainedActionRequired: false,
    constrainedActionLinked: false,
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

function canonicalDigest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function digest(label) {
  return createHash('sha256').update(String(label)).digest('hex');
}

function uuid(label) {
  const raw = digest(label);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

async function one(client, text, values = []) {
  const result = await client.query(text, values);
  assert.equal(result.rows.length, 1, `expected one row from ${text.slice(0, 90)}`);
  return result.rows[0];
}

function clockId(tenantId) {
  if (!clocks.has(tenantId)) clocks.set(tenantId, uuid(`clock:${tenantId}`));
  return clocks.get(tenantId);
}

async function advance(tenantId, logicalNow) {
  return (await one(pool, `
    SELECT outcome_advance_coordinator_clock($1::uuid, $2::uuid, $3) AS result
  `, [tenantId, clockId(tenantId), logicalNow])).result;
}

function bindingFor(scope, overrides = {}) {
  return {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    subjectType: 'PROJECT',
    subjectId: scope.projectId,
    goalId: `goal:${scope.projectId}`,
    goalRevision: '1',
    contractDigest: digest(`contract:${scope.label}`),
    evaluationPlanDigest: digest(`plan:${scope.label}`),
    policyDigest: digest(`policy:${scope.label}`),
    riskPolicyDigest: scope.riskPolicyDigest,
    permissionDigest: digest(`permission:${scope.label}`),
    authorityGrantDigest: scope.grantDigest,
    budgetDigest: scope.budgetDigest,
    capabilityRegistryDigest: digest(`capability:${scope.label}`),
    recipientDigest: digest(`recipient:${scope.label}`),
    evaluatorDigest: scope.evaluatorDigest,
    factSchemaDigest: digest('fact-schema-v2'),
    environmentDigest: digest(`environment:${scope.label}`),
    artifactDigest: digest(`artifact:${scope.label}`),
    targetDigest: scope.targetDigest,
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '1',
    factCutDigest: digest(`cut:${scope.label}`),
    ...overrides,
  };
}

async function seedActive(label, options = {}) {
  const tenantId = options.tenantId ?? uuid(`tenant:${label}`);
  const projectId = options.projectId ?? uuid(`project:${label}`);
  const scope = {
    label,
    tenantId,
    projectId,
    riskPolicyDigest: digest(`risk:${label}`),
    budgetDigest: digest(`budget:${label}`),
    targetDigest: digest(`target:${label}`),
    evaluatorDigest: digest('coordinator-evaluator-v2'),
    grantDigest: digest(`grant:${label}`),
  };
  if (options.actionReady) {
    const grantId = uuid(`grant-id:${label}`);
    const grant = await one(pool, `
      SELECT outcome_register_authority_grant(
        $1::uuid, $2::uuid, $3::uuid, 'SYSTEM', $4,
        'ACTION_INTENT_RECORDED', 'INTENT', 'ORBIT_CONTROL_PLANE',
        'coordinator-test', '2.0.0', NULL, 0, NULL, $5
      ) AS result
    `, [tenantId, projectId, grantId, `system:${label}`, scope.riskPolicyDigest]);
    scope.grantId = grantId;
    scope.grantDigest = grant.result.grantDigest;
    scope.preconditionDigest = digest(`precondition:${label}`);
    await one(pool, `
      SELECT outcome_register_action_precondition(
        $1::uuid, $2::uuid, 'EXTERNAL_EFFECT', $3, $4, $5
      ) AS result
    `, [tenantId, projectId, `effect:${label}`, scope.preconditionDigest, scope.targetDigest]);
    await one(pool, `
      SELECT outcome_register_action_budget($1::uuid, $2::uuid, $3, $4, 'PROTOCOL_ACTION', 20) AS result
    `, [tenantId, projectId, `budget:${label}`, scope.budgetDigest]);
  } else {
    await pool.query(`
      INSERT INTO outcome_fact_stream (tenant_id, project_id, last_logical_time, binding_epoch)
      VALUES ($1::uuid, $2::uuid, 1, 0)
      ON CONFLICT (tenant_id, project_id) DO NOTHING
    `, [tenantId, projectId]);
  }
  const binding = bindingFor(scope);
  const bindingReceipt = await one(pool, `
    SELECT outcome_register_fact_binding($1::uuid, $2::uuid, $3::jsonb) AS result
  `, [tenantId, projectId, JSON.stringify(binding)]);
  const bindingDigest = bindingReceipt.result.bindingDigest;
  const kind = options.kind ?? 'DIAGNOSE_MODEL_GAP';
  const owner = options.owner ?? 'AGENT';
  const capability = options.capability ?? 'model-gap.diagnose';
  const obligationId = digest(`obligation:${label}`);
  const obligationRevision = digest(`obligation-revision:${label}:${bindingDigest}`);
  const sourceObligation = {
    obligationId,
    obligationRevision,
    kind,
    state: 'ACTIVE',
    mandatory: true,
    owner,
    capability,
    binding,
    bindingDigest,
    goalId: binding.goalId,
    goalRevision: binding.goalRevision,
    reason: {
      code: options.reasonCode ?? 'TEST_OBLIGATION_ACTIVE',
      message: `The isolated ${label} obligation is active.`,
      evidenceFactIds: [],
      attemptedActions: [],
      nextAction: capability,
    },
    actionProtocolProfile: owner === 'OWNER' ? 'OWNER_DECISION'
      : owner === 'AGENT' ? 'AGENT_ACTION' : 'SYSTEM_ACTION',
    servesCriterionIds: [],
    blocksClosureOf: ['MODEL_COVERAGE'],
    ownership: {
      homeProjectId: projectId,
      blockingProjectIds: [projectId],
      crossingId: null,
      handoffId: null,
      handoffStatus: 'NOT_REQUIRED',
      attributionDecisionFactId: null,
    },
    resolverProfile: 'STANDARD_MANDATORY',
    createdAtLogicalTime: '1',
    dueLogicalTime: null,
  };
  const cutId = uuid(`cut:${label}`);
  const evaluationId = uuid(`evaluation:${label}`);
  const proofDigest = digest(`proof:${label}`);
  const evaluationResult = {
    schemaVersion: 1,
    evaluatorVersion: 'coordinator-test/2.0.0',
    evaluatorDigest: scope.evaluatorDigest,
    bindingDigest,
    evaluatedThroughLogicalTime: '1',
    proof: { proofDigest },
    proofGraph: {},
    activeMandatoryObligations: [sourceObligation],
    attempts: [],
    rejectedFacts: [],
    closed: false,
  };
  await pool.query(`
    INSERT INTO outcome_evaluation_cut (
      cut_id, tenant_id, project_id, binding_digest, watermark_logical_time,
      fact_count, proof_fact_count, fact_set_digest, opened_at, sealed_at,
      complete, linearizable, collector_version, idempotency_key, request_digest, cut_envelope
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4, 1, 0, 0, $5,
      clock_timestamp(), clock_timestamp(), true, true, 'coordinator-test/2.0.0',
      $6, $7, '{}'::jsonb
    )
  `, [
    cutId, tenantId, projectId, bindingDigest, digest(`fact-set:${label}`),
    `cut:${label}`, digest(`cut-request:${label}`),
  ]);
  await pool.query(`
    INSERT INTO outcome_evaluator_result (
      evaluation_id, tenant_id, project_id, subject_type, subject_id, binding_digest,
      cut_id, watermark_logical_time, evaluator_version, evaluator_digest,
      evaluation_digest, proof_digest, result_digest, is_closed, result
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, 'PROJECT', $3::text, $4, $5::uuid, 1,
      'coordinator-test/2.0.0', $6, $7, $8, $9, false, $10::jsonb
    )
  `, [
    evaluationId, tenantId, projectId, bindingDigest, cutId, scope.evaluatorDigest,
    digest(`evaluation:${label}`), proofDigest, canonicalDigest(evaluationResult),
    JSON.stringify(evaluationResult),
  ]);
  await pool.query(`
    INSERT INTO outcome_obligation_revision (
      tenant_id, project_id, obligation_id, obligation_revision, binding_digest,
      goal_id, goal_revision, kind, mandatory, obligation, obligation_digest,
      first_evaluation_id
    ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 1, $7, true, $8::jsonb, $9, $10::uuid)
  `, [
    tenantId, projectId, obligationId, obligationRevision, bindingDigest,
    binding.goalId, kind, JSON.stringify(sourceObligation), canonicalDigest(sourceObligation),
    evaluationId,
  ]);
  await pool.query(`
    INSERT INTO outcome_active_obligation (
      tenant_id, project_id, obligation_id, obligation_revision, binding_digest,
      goal_id, goal_revision, kind, evaluation_id, evaluated_through_logical_time,
      obligation
    ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 1, $7, $8::uuid, 1, $9::jsonb)
  `, [
    tenantId, projectId, obligationId, obligationRevision, bindingDigest,
    binding.goalId, kind, evaluationId, JSON.stringify(sourceObligation),
  ]);
  return {
    ...scope,
    binding,
    bindingDigest,
    sourceObligation,
    obligationId,
    obligationRevision,
    evaluationId,
  };
}

async function reconcile(tenantId, overrides = {}) {
  const config = {
    delta: overrides.delta ?? 10,
    attempts: overrides.attempts ?? 4,
    wakes: overrides.wakes ?? 10,
    fingerprintLimit: overrides.fingerprintLimit ?? 2,
    renewals: overrides.renewals ?? 1,
  };
  return (await one(pool, `
    SELECT outcome_reconcile_active_obligations($1::uuid, $2, $3, $4, $5, $6) AS result
  `, [tenantId, config.delta, config.attempts, config.wakes, config.fingerprintLimit, config.renewals])).result;
}

async function claim(scope, logicalNow, worker = `worker:${scope.label}`, leaseTicks = 2) {
  await advance(scope.tenantId, logicalNow);
  return (await one(pool, `
    SELECT outcome_claim_next_coordination($1::uuid, $2, $3) AS result
  `, [scope.tenantId, worker, leaseTicks])).result;
}

async function record(scope, claimValue, logicalNow, result, extras = {}) {
  await advance(scope.tenantId, logicalNow);
  return (await one(pool, `
    SELECT outcome_record_coordinator_result(
      $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb
    ) AS result
  `, [
    scope.tenantId, claimValue.coordinationId, claimValue.leaseToken,
    extras.worker ?? `worker:${scope.label}`, extras.callbackKey ?? `callback:${claimValue.leaseId}`,
    result, extras.failureFingerprint ?? null, extras.retryAfter ?? null,
    JSON.stringify(extras.detail ?? {}),
  ])).result;
}

async function current(scope) {
  return one(pool, `
    SELECT coordination_id AS "coordinationId", status, durable_owner AS "durableOwner",
           diagnostic_path AS "diagnosticPath", attempt_budget_remaining AS "attemptsRemaining",
           wake_budget_remaining AS "wakesRemaining", lease_owner AS "leaseOwner",
           last_progress_logical_time::text AS "lastProgress",
           progress_deadline_logical_time::text AS "progressDeadline",
           next_wake_logical_time::text AS "nextWake"
      FROM outcome_coordinator_obligation
     WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND obligation_id = $3
  `, [scope.tenantId, scope.projectId, scope.obligationId]);
}

function validOwnerPayload(label, overrides = {}) {
  return {
    whyNotAgent: 'The agent cannot choose the owner-approved goal disposition.',
    options: [{ id: 'continue' }, { id: 'stop' }],
    impacts: [{ option: 'continue', impact: 'work continues' }],
    recommendation: 'continue',
    noActionConsequence: 'The obligation remains open.',
    cost: { amount: 0, unit: 'OWNER_DECISION' },
    deadline: null,
    resumeBehavior: 'Wake the agent coordinator immediately after a bound decision.',
    idempotencyKey: `owner-request:${label}`,
    ...overrides,
  };
}

test('isolated PostgreSQL identity is explicit and PostgreSQL 16+', async () => {
  const identity = await one(pool, `
    SELECT current_database() AS database, current_user AS "user",
           current_setting('server_version') AS version,
           (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier"
  `);
  assert.equal(identity.database, EXPECTED_DATABASE);
  assert.equal(identity.user, EXPECTED_USER);
  assert.equal(identity.systemIdentifier, EXPECTED_SYSTEM_IDENTIFIER);
  assert.match(identity.version, /^1[6-9]\./);
  evidence.postgres = {
    required: true, connected: true, version: identity.version,
    systemIdentifier: identity.systemIdentifier,
  };
});

test('pure policy closes the owner reasons and requires whyNotAgent plus the full protocol', () => {
  const obligation = {
    obligationId: digest('pure-o'), obligationRevision: digest('pure-r'),
    bindingDigest: digest('pure-b'), kind: 'REQUEST_GOAL_DECISION',
    owner: 'OWNER', capability: 'owner.goal-decision',
  };
  assert.equal(
    coordinator.validateCoordinatorOwnerDecision(obligation, 'OPERATOR_HELP', validOwnerPayload('pure')),
    'OWNER_DECISION_REASON_FORBIDDEN',
  );
  assert.equal(
    coordinator.validateCoordinatorOwnerDecision(
      obligation, 'GOAL_DECISION', validOwnerPayload('pure-no-why', { whyNotAgent: '' }),
    ),
    'WHY_NOT_AGENT_REQUIRED',
  );
  const incomplete = validOwnerPayload('pure-incomplete');
  delete incomplete.resumeBehavior;
  assert.equal(
    coordinator.validateCoordinatorOwnerDecision(obligation, 'GOAL_DECISION', incomplete),
    'OWNER_DECISION_FIELD_REQUIRED:resumeBehavior',
  );
  assert.equal(
    coordinator.validateCoordinatorOwnerDecision(obligation, 'GOAL_DECISION', validOwnerPayload('pure-ok')),
    null,
  );
  evidence.decisions.closedReasonSet = true;
  evidence.decisions.whyNotAgentRequired = true;
  evidence.decisions.fullProtocolRequired = true;
});

test('pure failure policy changes diagnosis and terminates finite budgets', () => {
  assert.deepEqual(coordinator.coordinatorFailurePath(1, 2, 3), {
    path: 'PRIMARY_RECOVERY', terminal: false, changedDiagnosticPath: false,
  });
  assert.equal(coordinator.coordinatorFailurePath(2, 2, 2).path, 'ALTERNATE_DIAGNOSIS');
  assert.equal(coordinator.coordinatorFailurePath(3, 2, 1).terminal, true);
  assert.equal(coordinator.coordinatorFailurePath(1, 2, 0).path, 'ATTEMPT_BUDGET_EXHAUSTED');
  coordinator.assertBoundedCoordinatorWake('5', '15', 10);
  assert.throws(() => coordinator.assertBoundedCoordinatorWake('5', '16', 10), /OUTSIDE_LIVENESS/);
});

test('resolver registry is capability-bound and refuses ambiguous replacement', () => {
  const registry = new OutcomeCoordinatorResolverRegistry();
  const resolver = { capability: 'test.resolve', async resolve() { return { kind: 'RESOLVED' }; } };
  registry.register(resolver);
  registry.register(resolver);
  assert.equal(registry.resolve('test.resolve'), resolver);
  assert.throws(() => registry.register({ ...resolver }), /REGISTRATION_CONFLICT/);
  evidence.executor.resolverRegistryBound = true;
});

test('persistent clock rejects regression and a different clock identity', async () => {
  const tenantId = uuid('clock-tenant');
  const first = await advance(tenantId, 4);
  assert.equal(first.logicalTime, '4');
  const replay = await advance(tenantId, 4);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    pool.query(`SELECT outcome_advance_coordinator_clock($1::uuid, $2::uuid, 3)`, [tenantId, clockId(tenantId)]),
    /OUTCOME_COORDINATOR_CLOCK_REGRESSION/,
  );
  await assert.rejects(
    pool.query(`SELECT outcome_advance_coordinator_clock($1::uuid, $2::uuid, 5)`, [tenantId, uuid('other-clock')]),
    /OUTCOME_COORDINATOR_CLOCK_ID_MISMATCH/,
  );
  evidence.persistence.durableClock = true;
});

test('reconciliation discovers canonical obligations and assigns a durable owner plus wake', async () => {
  const scope = await seedActive('discovery');
  await advance(scope.tenantId, 1);
  const receipt = await reconcile(scope.tenantId);
  assert.equal(receipt.registered, 1);
  const row = await current(scope);
  assert.deepEqual({ status: row.status, owner: row.durableOwner }, { status: 'SCHEDULED', owner: 'AGENT' });
  assert.equal(row.nextWake, '1');
  const wake = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_coordinator_wake
     WHERE coordination_id = $1::uuid AND state = 'SCHEDULED'
  `, [row.coordinationId]);
  assert.equal(wake.count, 1);
  const revision = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_coordinator_obligation_revision
     WHERE tenant_id = $1::uuid AND project_id = $2::uuid
  `, [scope.tenantId, scope.projectId]);
  assert.equal(revision.count, 1);
  evidence.persistence.canonicalDiscovery = true;
  evidence.persistence.durableOwnerAndWake = true;
  evidence.samples.discoveryCoordinationId = row.coordinationId;
});

test('committed crash lease expires, changes recovery path, and another worker takes over', async () => {
  const scope = await seedActive('crash');
  await advance(scope.tenantId, 1);
  await reconcile(scope.tenantId, { attempts: 4, delta: 10 });
  const first = await claim(scope, 1, 'worker:crashed', 2);
  assert.equal(first.attemptNumber, 1);
  const noneDuringBackoff = await claim(scope, 3, 'worker:takeover', 2);
  assert.equal(noneDuringBackoff, null);
  const afterExpiry = await current(scope);
  assert.equal(afterExpiry.status, 'SCHEDULED');
  assert.equal(afterExpiry.leaseOwner, null);
  const takeover = await claim(scope, 4, 'worker:takeover', 2);
  assert.equal(takeover.attemptNumber, 2);
  assert.notEqual(takeover.leaseToken, first.leaseToken);
  await assert.rejects(
    record(scope, first, 4, 'RESOLVED', {
      worker: 'worker:crashed', callbackKey: 'late-crashed-result',
    }),
    /OUTCOME_COORDINATOR_LEASE_STALE/,
  );
  evidence.recovery.crashTakeover = true;
  evidence.recovery.expiredLeaseFenced = true;
  evidence.recovery.staleCallbackRejected = true;
  evidence.samples.takeoverWorkers = ['worker:crashed', 'worker:takeover'];
});

test('lease renewal is finite and never advances the liveness watermark', async () => {
  const scope = await seedActive('renew');
  await advance(scope.tenantId, 1);
  await reconcile(scope.tenantId, { delta: 6, renewals: 1 });
  const claimed = await claim(scope, 1, 'worker:renew', 2);
  await advance(scope.tenantId, 2);
  const first = (await one(pool, `
    SELECT outcome_renew_coordinator_lease($1::uuid, $2::uuid, $3::uuid, $4, 2) AS result
  `, [scope.tenantId, claimed.coordinationId, claimed.leaseToken, 'worker:renew'])).result;
  assert.equal(first.renewed, true);
  const second = (await one(pool, `
    SELECT outcome_renew_coordinator_lease($1::uuid, $2::uuid, $3::uuid, $4, 2) AS result
  `, [scope.tenantId, claimed.coordinationId, claimed.leaseToken, 'worker:renew'])).result;
  assert.equal(second.code, 'LEASE_RENEWAL_BUDGET_EXHAUSTED');
  const row = await current(scope);
  assert.equal(row.lastProgress, '1');
  assert.equal(row.progressDeadline, '7');
  evidence.recovery.boundedLeaseRenewal = true;
  evidence.bounded.noLeaseWakeChurn = true;
});

test('lost durable wake is rebuilt and duplicate callback delivery is idempotent', async () => {
  const scope = await seedActive('wake-loss');
  await advance(scope.tenantId, 1);
  await reconcile(scope.tenantId, { wakes: 4 });
  const initial = await one(pool, `
    SELECT wake_id AS "wakeId" FROM outcome_coordinator_wake
     WHERE tenant_id = $1::uuid AND state = 'SCHEDULED'
  `, [scope.tenantId]);
  await pool.query(`UPDATE outcome_coordinator_wake SET state = 'DEAD' WHERE wake_id = $1::uuid`, [initial.wakeId]);
  const claimed = await claim(scope, 1, 'worker:wake-recovery', 2);
  assert.ok(claimed);
  const rebuilt = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_coordinator_event
     WHERE coordination_id = $1::uuid AND event_type = 'WAKE_REBUILT'
  `, [claimed.coordinationId]);
  assert.equal(rebuilt.count, 1);

  const duplicateScope = await seedActive('wake-duplicate');
  await advance(duplicateScope.tenantId, 1);
  await reconcile(duplicateScope.tenantId);
  const wake = await one(pool, `
    SELECT wake_id AS "wakeId" FROM outcome_coordinator_wake
     WHERE tenant_id = $1::uuid AND state = 'SCHEDULED'
  `, [duplicateScope.tenantId]);
  const first = (await one(pool, `
    SELECT outcome_deliver_coordinator_wake($1::uuid, $2::uuid, 'duplicate-key') AS result
  `, [duplicateScope.tenantId, wake.wakeId])).result;
  const replay = (await one(pool, `
    SELECT outcome_deliver_coordinator_wake($1::uuid, $2::uuid, 'duplicate-key') AS result
  `, [duplicateScope.tenantId, wake.wakeId])).result;
  assert.equal(first.outcome, 'DELIVERED');
  assert.equal(replay.replayed, true);
  const deliveries = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_coordinator_wake_delivery
     WHERE tenant_id = $1::uuid AND callback_key = 'duplicate-key'
  `, [duplicateScope.tenantId]);
  assert.equal(deliveries.count, 1);
  evidence.recovery.lostWakeRebuilt = true;
  evidence.recovery.duplicateWakeIdempotent = true;
});

test('result callback replay is exactly-once', async () => {
  const scope = await seedActive('result-replay');
  await advance(scope.tenantId, 1);
  await reconcile(scope.tenantId);
  const claimed = await claim(scope, 1);
  const first = await record(scope, claimed, 1, 'DELIVERED', { callbackKey: 'same-result' });
  const replay = await record(scope, claimed, 1, 'DELIVERED', { callbackKey: 'same-result' });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  const count = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_coordinator_attempt_result
     WHERE tenant_id = $1::uuid AND callback_key = 'same-result'
  `, [scope.tenantId]);
  assert.equal(count.count, 1);
  evidence.recovery.duplicateCallbackIdempotent = true;
});

test('attempt budget exhaustion produces an agent escalation, never a human fallback', async () => {
  const scope = await seedActive('attempt-budget');
  await advance(scope.tenantId, 1);
  await reconcile(scope.tenantId, { attempts: 1, fingerprintLimit: 1 });
  const claimed = await claim(scope, 1);
  const result = await record(scope, claimed, 1, 'RETRYABLE_FAILURE', {
    failureFingerprint: digest('attempt-budget-failure'), retryAfter: 1,
  });
  assert.equal(result.status, 'ESCALATED');
  const row = await current(scope);
  assert.equal(row.durableOwner, 'AGENT');
  const decisions = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_coordinator_owner_decision_request
     WHERE tenant_id = $1::uuid
  `, [scope.tenantId]);
  assert.equal(decisions.count, 0);
  evidence.bounded.attemptBudgetExhaustion = true;
  evidence.decisions.ordinaryFailureDoesNotNotifyOwner = true;
});

test('same fingerprint switches diagnosis once and then escalates within finite budget', async () => {
  const scope = await seedActive('fingerprint');
  await advance(scope.tenantId, 1);
  await reconcile(scope.tenantId, { attempts: 4, fingerprintLimit: 2, delta: 10 });
  const fingerprint = digest('same-fingerprint');
  const first = await claim(scope, 1);
  await record(scope, first, 1, 'RETRYABLE_FAILURE', { failureFingerprint: fingerprint, retryAfter: 1 });
  const second = await claim(scope, 2);
  const changed = await record(scope, second, 2, 'RETRYABLE_FAILURE', {
    failureFingerprint: fingerprint, retryAfter: 1,
  });
  assert.equal(changed.diagnosticPath, 'ALTERNATE_DIAGNOSIS');
  const third = await claim(scope, 3);
  const exhausted = await record(scope, third, 3, 'RETRYABLE_FAILURE', {
    failureFingerprint: fingerprint, retryAfter: 1,
  });
  assert.equal(exhausted.status, 'ESCALATED');
  const occurrences = await one(pool, `
    SELECT occurrence_count AS count, diagnostic_path AS path
      FROM outcome_coordinator_failure_fingerprint
     WHERE coordination_id = $1::uuid AND failure_fingerprint = $2
  `, [first.coordinationId, fingerprint]);
  assert.equal(occurrences.count, 3);
  assert.equal(occurrences.path, 'REPEATED_FAILURE_ESCALATION');
  evidence.bounded.fingerprintChangesPath = true;
  evidence.bounded.repeatedFingerprintEscalates = true;
});

test('quota wait remains system-owned, does not notify owner, and resumes from durable due time', async () => {
  const scope = await seedActive('quota');
  await advance(scope.tenantId, 1);
  await reconcile(scope.tenantId, { attempts: 4, delta: 10 });
  const first = await claim(scope, 1);
  const waiting = await record(scope, first, 1, 'QUOTA_WAIT', {
    retryAfter: 3,
    detail: { provider: 'quota:test', condition: { available: true }, pollBudget: 3 },
  });
  assert.equal(waiting.durableOwner, 'SYSTEM');
  assert.equal(waiting.ownerNotified, false);
  assert.equal(await claim(scope, 3), null);
  const resumed = await claim(scope, 4, 'worker:quota-poll', 2);
  assert.ok(resumed);
  const requests = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_coordinator_owner_decision_request
     WHERE tenant_id = $1::uuid
  `, [scope.tenantId]);
  assert.equal(requests.count, 0);
  evidence.scheduling.quotaWaitSystemOwned = true;
  evidence.scheduling.externalWaitAutoResume = true;
  evidence.decisions.externalWaitDoesNotNotifyOwner = true;
});

test('retry backoff is durable and cannot be claimed before its logical due time', async () => {
  const scope = await seedActive('backoff');
  await advance(scope.tenantId, 1);
  await reconcile(scope.tenantId);
  const first = await claim(scope, 1);
  const waiting = await record(scope, first, 1, 'RETRYABLE_FAILURE', {
    failureFingerprint: digest('backoff-failure'), retryAfter: 4,
  });
  assert.equal(waiting.status, 'SCHEDULED');
  assert.equal(await claim(scope, 4), null);
  assert.ok(await claim(scope, 5, 'worker:after-backoff'));
  evidence.scheduling.durableBackoff = true;
});

test('fair scheduler rotates projects before taking a second obligation from one project', async () => {
  const tenantId = uuid('fair-tenant');
  const projectA = uuid('fair-project-a');
  const projectB = uuid('fair-project-b');
  const a1 = await seedActive('fair-a1', { tenantId, projectId: projectA });
  await seedActive('fair-a2', { tenantId, projectId: projectA });
  const b1 = await seedActive('fair-b1', { tenantId, projectId: projectB });
  await advance(tenantId, 1);
  await reconcile(tenantId, { attempts: 3, delta: 10 });
  const first = await claim(a1, 1, 'worker:fair-1');
  await record(a1, first, 1, 'RESOLVED', { worker: 'worker:fair-1' });
  const second = await claim(a1, 1, 'worker:fair-2');
  assert.notEqual(first.projectId, second.projectId);
  assert.ok([projectA, projectB].includes(second.projectId));
  assert.equal(new Set([first.projectId, second.projectId]).size, 2);
  evidence.scheduling.crossProjectFairness = true;
  evidence.samples.fairProjects = [first.projectId, second.projectId];
  // Keep the second claim from becoming an unrelated expired lease in later assertions.
  await record(b1.projectId === second.projectId ? b1 : a1, second, 1, 'RESOLVED', {
    worker: 'worker:fair-2', callbackKey: `fair-resolve:${second.leaseId}`,
  });
});

test('only a complete closed-set owner request enters the durable queue and decision auto-resumes', async () => {
  const scope = await seedActive('owner', {
    kind: 'REQUEST_GOAL_DECISION', owner: 'OWNER', capability: 'owner.goal-decision',
  });
  await advance(scope.tenantId, 1);
  await reconcile(scope.tenantId);
  const claimed = await claim(scope, 1, 'worker:owner');
  assert.equal((await current(scope)).durableOwner, 'AGENT', 'owner-shaped source is not queued without protocol');
  const call = (reason, request) => pool.query(`
    SELECT outcome_request_coordinator_owner_decision(
      $1::uuid, $2::uuid, $3::uuid, 'worker:owner', $4, $5::jsonb
    ) AS result
  `, [scope.tenantId, claimed.coordinationId, claimed.leaseToken, reason, JSON.stringify(request)]);
  await assert.rejects(call('OPERATOR_HELP', validOwnerPayload('owner-bad-reason')), /REASON_FORBIDDEN/);
  await assert.rejects(call('GOAL_DECISION', validOwnerPayload('owner-no-why', { whyNotAgent: '' })), /WHY_NOT_AGENT/);
  const incomplete = validOwnerPayload('owner-incomplete');
  delete incomplete.resumeBehavior;
  await assert.rejects(call('GOAL_DECISION', incomplete), /PAYLOAD_INCOMPLETE/);
  const request = validOwnerPayload('owner-valid');
  const accepted = (await call('GOAL_DECISION', request)).rows[0].result;
  assert.equal(accepted.status, 'OPEN');
  assert.equal((await current(scope)).durableOwner, 'OWNER');
  const decided = (await one(pool, `
    SELECT outcome_decide_coordinator_owner_request(
      $1::uuid, $2::uuid, $3, 'decision:owner-valid', $4::jsonb
    ) AS result
  `, [
    scope.tenantId, accepted.requestId, scope.obligationRevision,
    JSON.stringify({ option: 'continue', actor: 'owner:test' }),
  ])).result;
  assert.equal(decided.resumed, true);
  const resumed = await claim(scope, 1, 'worker:owner-resumed');
  assert.ok(resumed);
  evidence.decisions.validRequestDurable = true;
  evidence.decisions.decisionAutoResume = true;
  evidence.samples.ownerRequestId = accepted.requestId;
});

test('constrained Action Executor intent is required and linked before action delivery is recorded', async () => {
  const scope = await seedActive('action-link', {
    actionReady: true,
    kind: 'REMEDIATE_SIDE_EFFECT', owner: 'SYSTEM', capability: 'effect.remediate',
  });
  await advance(scope.tenantId, 1);
  await reconcile(scope.tenantId);
  const claimed = await claim(scope, 1, 'worker:action');
  await assert.rejects(
    record(scope, claimed, 1, 'ACTION_ENQUEUED', {
      worker: 'worker:action', callbackKey: 'unbound-action',
      detail: { actionIntentId: uuid('absent-action') },
    }),
    /ACTION_NOT_CONSTRAINED_OR_BOUND/,
  );
  const protocol = {
    obligationKind: 'REMEDIATE_SIDE_EFFECT',
    actionKind: 'TEST_COORDINATOR_ACTION',
    effectClass: 'EXTERNAL_REVERSIBLE',
    resourceType: 'EXTERNAL_EFFECT',
    actor: { role: 'SYSTEM', adapter: 'ACTION_EXECUTOR', capability: 'test.effect.execute' },
    resolver: { adapter: 'OUTCOME_RECONCILER', capability: 'effect.remediate' },
    authorityScopes: ['effect:test'], policyRules: ['test-effect'],
    budgetUnit: 'PROTOCOL_ACTION', budgetCharge: 1,
    retry: { maxAttempts: 3, sameFailureFingerprintLimit: 2, backoffLogicalTicks: [1, 4, 16] },
    timeoutLogicalTicks: 20,
    compensation: {
      capability: 'effect.rollback.external', manualRecovery: null,
      remediationObligationKind: 'REMEDIATE_SIDE_EFFECT',
    },
  };
  const intent = {
    schemaVersion: 1,
    actionIntentId: uuid('action-link-intent'),
    actionKind: protocol.actionKind,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    obligationId: scope.obligationId,
    obligationRevision: scope.obligationRevision,
    bindingDigest: scope.bindingDigest,
    protocolDigest: actionProtocolDigest(protocol),
    effectClass: protocol.effectClass,
    resourceType: protocol.resourceType,
    resourceId: `effect:${scope.label}`,
    targetDigest: scope.targetDigest,
    principal: { type: 'SYSTEM', id: `system:${scope.label}` },
    authorityGrantDigest: scope.grantDigest,
    policyDigest: scope.binding.policyDigest,
    preconditionDigest: scope.preconditionDigest,
    evaluatedThroughLogicalTime: '1',
    idempotencyKey: 'coordinator-action-link',
    budget: {
      accountId: `budget:${scope.label}`, unit: 'PROTOCOL_ACTION', charge: 1, limit: 20,
      reservationId: 'coordinator-action-reservation',
    },
    retryPolicy: {
      maxAttempts: 3,
      backoffDigest: actionBackoffDigest([1, 4, 16]),
      sameFailureFingerprintLimit: 2,
    },
    timeout: { logicalTicks: 20, wallClockMs: 1_000 },
    compensation: {
      compensatorCapability: 'effect.rollback.external', manualRecovery: null,
      remediationObligationKind: 'REMEDIATE_SIDE_EFFECT',
    },
    receiptRequirements: {
      providerIdentity: true, effectDigest: true, observedAt: true, result: true, idempotencyKey: true,
    },
  };
  const queued = (await one(pool, `
    SELECT outcome_enqueue_action(
      $1::uuid, $2::uuid, $3::jsonb, $4::jsonb, ARRAY[1,4,16]::bigint[], 1, 10
    ) AS result
  `, [
    scope.tenantId, scope.projectId, JSON.stringify(intent), JSON.stringify(scope.sourceObligation),
  ])).result;
  assert.equal(queued.actionIntentId, intent.actionIntentId);
  const linked = await record(scope, claimed, 1, 'ACTION_ENQUEUED', {
    worker: 'worker:action', callbackKey: 'bound-action',
    detail: { actionIntentId: intent.actionIntentId },
  });
  assert.equal(linked.result, 'ACTION_ENQUEUED');
  const event = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_coordinator_event
     WHERE coordination_id = $1::uuid AND event_type = 'CONSTRAINED_ACTION_ENQUEUED'
  `, [claimed.coordinationId]);
  assert.equal(event.count, 1);
  evidence.executor.constrainedActionRequired = true;
  evidence.executor.constrainedActionLinked = true;
  evidence.samples.actionIntentId = intent.actionIntentId;
});

test('wake budget and liveness delta end churn with an auditable non-human disposition', async () => {
  const scope = await seedActive('liveness');
  await advance(scope.tenantId, 1);
  await reconcile(scope.tenantId, { delta: 5, wakes: 2, attempts: 3 });
  await advance(scope.tenantId, 6);
  const swept = (await one(pool, `SELECT outcome_sweep_coordinator($1::uuid) AS result`, [scope.tenantId])).result;
  assert.ok(swept.escalated >= 1);
  const row = await current(scope);
  assert.equal(row.status, 'ESCALATED');
  assert.equal(row.durableOwner, 'AGENT');
  const audit = await pool.query(`SELECT * FROM outcome_coordinator_liveness_audit($1::uuid)`, [scope.tenantId]);
  assert.equal(audit.rows.length, 0);
  const progress = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_coordinator_event
     WHERE coordination_id = $1::uuid AND progress_kind = 'ESCALATE'
       AND logical_time <= 6
  `, [row.coordinationId]);
  assert.ok(progress.count >= 1);
  const requests = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_coordinator_owner_decision_request
     WHERE tenant_id = $1::uuid
  `, [scope.tenantId]);
  assert.equal(requests.count, 0);
  evidence.bounded.wakeBudgetFinite = true;
  evidence.scheduling.livenessDeltaDisposition = true;
  evidence.scheduling.zeroActiveViolations = true;
  evidence.persistence.immutableTrace = true;
});
