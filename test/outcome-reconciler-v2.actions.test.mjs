import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const MODULE_PATH = process.env.OUTCOME_ACTION_MODULE;
const SERVICE_MODULE_PATH = process.env.OUTCOME_ACTION_SERVICE_MODULE;
const URL = process.env.OUTCOME_ACTION_PG_URL;
const EXPECTED_DATABASE = process.env.OUTCOME_ACTION_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OUTCOME_ACTION_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER = process.env.OUTCOME_ACTION_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OUTCOME_ACTION_EVIDENCE_PATH;

assert.ok(MODULE_PATH, 'OUTCOME_ACTION_MODULE is required');
assert.ok(SERVICE_MODULE_PATH, 'OUTCOME_ACTION_SERVICE_MODULE is required');
assert.ok(URL, 'OUTCOME_ACTION_PG_URL is required; PostgreSQL absence is a hard failure');
assert.ok(EXPECTED_DATABASE, 'OUTCOME_ACTION_PG_EXPECTED_DATABASE is required');
assert.ok(EXPECTED_USER, 'OUTCOME_ACTION_PG_EXPECTED_USER is required');
assert.ok(EXPECTED_SYSTEM_IDENTIFIER, 'OUTCOME_ACTION_PG_EXPECTED_SYSTEM_IDENTIFIER is required');
assert.ok(EVIDENCE_PATH, 'OUTCOME_ACTION_EVIDENCE_PATH is required');

const {
  ACTION_EFFECT_CLASSES,
  ACTION_HUMAN_DECISION_REASONS,
  actionBackoffDigest,
  actionProtocolDigest,
  canonicalActionObligation,
  selectFairAction,
  transitionForReceipt,
  validateActionCommit,
} = await import(pathToFileURL(path.resolve(MODULE_PATH)).href);
const {
  ActionCapabilityRegistry,
  ActionExecutorService,
} = await import(pathToFileURL(path.resolve(SERVICE_MODULE_PATH)).href);

const pool = new Pool({ connectionString: URL, max: 32 });
const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-actions',
  postgres: { required: true, connected: false, version: null, systemIdentifier: null },
  validation: {
    effectClass: false,
    exactTarget: false,
    authority: false,
    authorityLane: false,
    policyDigest: false,
    protocolDigest: false,
    runtimeRegistryFreeze: false,
    precondition: false,
    closedHumanReasons: false,
  },
  idempotency: {
    enqueueReplay: false,
    concurrentEnqueueReplay: false,
    conflictingReplayRefused: false,
    oneProviderReceipt: false,
  },
  scheduling: {
    finiteBudget: false,
    finiteRetryFingerprint: false,
    durableBackoff: false,
    quotaWait: false,
    crossProjectFairness: false,
    boundedTimeout: false,
    wallClockTimeout: false,
  },
  races: {
    revokeAfterFenceSerializes: false,
    revokeBeforeFenceRefuses: false,
    bindingAfterFenceSerializes: false,
    bindingBeforeFenceRefuses: false,
  },
  recovery: {
    partialEffectRemediation: false,
    automaticCompensationTrace: false,
    unknownEffectNotRetried: false,
    ambiguousLeaseRemediation: false,
    declaredRecoveryPath: false,
    boundedCompensation: false,
  },
  modelGap: {
    unknownActionAgentOwned: false,
    missingResolverAgentOwned: false,
    noImplicitHumanFallback: false,
    durableDiagnosticReplay: false,
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
  assert.equal(result.rows.length, 1, `expected one row from ${text.slice(0, 80)}`);
  return result.rows[0];
}

function protocol(overrides = {}) {
  return {
    obligationKind: 'REMEDIATE_SIDE_EFFECT',
    actionKind: 'TEST_EXTERNAL_ACTION',
    effectClass: 'EXTERNAL_REVERSIBLE',
    resourceType: 'EXTERNAL_EFFECT',
    actor: { role: 'SYSTEM', adapter: 'ACTION_EXECUTOR', capability: 'test.effect.execute' },
    resolver: { adapter: 'OUTCOME_RECONCILER', capability: 'test.effect.resolve' },
    authorityScopes: ['effect:test'],
    policyRules: ['test-effect'],
    budgetUnit: 'PROTOCOL_ACTION',
    budgetCharge: 1,
    retry: { maxAttempts: 3, sameFailureFingerprintLimit: 2, backoffLogicalTicks: [1, 4, 16] },
    timeoutLogicalTicks: 20,
    compensation: {
      capability: 'effect.rollback.external',
      manualRecovery: null,
      remediationObligationKind: 'REMEDIATE_SIDE_EFFECT',
    },
    ...overrides,
  };
}

function makeBinding(scope, overrides = {}) {
  return {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    subjectType: 'PROJECT',
    subjectId: scope.projectId,
    goalId: `goal:${scope.projectId}`,
    goalRevision: '1',
    contractDigest: digest(`contract:${scope.projectId}`),
    evaluationPlanDigest: digest(`plan:${scope.projectId}`),
    policyDigest: digest(`policy:${scope.projectId}`),
    riskPolicyDigest: scope.riskPolicyDigest,
    permissionDigest: digest(`permission:${scope.projectId}`),
    authorityGrantDigest: scope.authority.grantDigest,
    budgetDigest: scope.budgetDigest,
    capabilityRegistryDigest: digest(`capabilities:${scope.projectId}`),
    recipientDigest: digest(`recipient:${scope.projectId}`),
    evaluatorDigest: digest('outcome-evaluator-v2'),
    factSchemaDigest: digest('fact-schema-v2'),
    environmentDigest: digest(`environment:${scope.projectId}`),
    artifactDigest: digest(`artifact:${scope.projectId}`),
    targetDigest: scope.targetDigest,
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '1',
    factCutDigest: digest(`prospective-cut:${scope.projectId}`),
    ...overrides,
  };
}

async function seedScope(label, options = {}) {
  const tenantId = options.tenantId ?? uuid(`tenant:${label}`);
  const projectId = options.projectId ?? uuid(`project:${label}`);
  const grantId = uuid(`grant:${label}`);
  const riskPolicyDigest = digest(`risk:${label}`);
  const targetDigest = digest(`target:${label}`);
  const preconditionDigest = digest(`precondition:${label}`);
  const budgetDigest = digest(`budget:${label}`);
  const budgetLimit = options.budgetLimit ?? 20;
  const authorityRow = await one(pool, `
    SELECT outcome_register_authority_grant(
      $1::uuid, $2::uuid, $3::uuid, 'SYSTEM', $4,
      $6, $7, $8,
      'action-executor-test', '2.0.0', NULL, 0, NULL, $5
    ) AS authority
  `, [
    tenantId, projectId, grantId, `system:${label}`, riskPolicyDigest,
    options.authorityFactKind ?? 'ACTION_INTENT_RECORDED',
    options.authorityClaimType ?? 'INTENT',
    options.authoritySourceSystem ?? 'ORBIT_CONTROL_PLANE',
  ]);
  const scope = {
    label,
    tenantId,
    projectId,
    grantId,
    riskPolicyDigest,
    targetDigest,
    preconditionDigest,
    budgetDigest,
    budgetLimit,
    authority: authorityRow.authority,
  };
  await one(pool, `
    SELECT outcome_register_action_precondition($1::uuid, $2::uuid, 'EXTERNAL_EFFECT', $3, $4, $5) AS result
  `, [tenantId, projectId, `effect:${label}`, preconditionDigest, targetDigest]);
  await one(pool, `
    SELECT outcome_register_action_budget($1::uuid, $2::uuid, $3, $4, 'PROTOCOL_ACTION', $5) AS result
  `, [tenantId, projectId, `budget:${label}`, budgetDigest, budgetLimit]);
  const binding = makeBinding(scope);
  const bindingRow = await one(pool, `
    SELECT outcome_register_fact_binding($1::uuid, $2::uuid, $3::jsonb) AS binding
  `, [tenantId, projectId, JSON.stringify(binding)]);
  const bindingDigest = bindingRow.binding.bindingDigest;
  const evaluationId = uuid(`evaluation:${label}`);
  const cutId = uuid(`cut:${label}`);
  const obligationId = digest(`obligation:${label}`);
  const obligationRevision = digest(`obligation-revision:${label}:${bindingDigest}`);
  const sourceObligation = {
    obligationId,
    obligationRevision,
    kind: 'REMEDIATE_SIDE_EFFECT',
    state: 'ACTIVE',
    mandatory: true,
    owner: 'SYSTEM',
    capability: 'effect.remediate',
    binding,
    bindingDigest,
    goalId: binding.goalId,
    goalRevision: binding.goalRevision,
    reason: {
      code: 'TEST_EFFECT_PENDING', message: 'The isolated test effect is pending.',
      evidenceFactIds: [], attemptedActions: [], nextAction: 'effect.remediate',
    },
    actionProtocolProfile: 'SYSTEM_ACTION',
    servesCriterionIds: ['ACTION_REMEDIATION'],
    blocksClosureOf: ['ACTION_REMEDIATION'],
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
  await pool.query(`
    INSERT INTO outcome_evaluation_cut (
      cut_id, tenant_id, project_id, binding_digest, watermark_logical_time,
      fact_count, proof_fact_count, fact_set_digest, opened_at, sealed_at,
      complete, linearizable, collector_version, idempotency_key, request_digest, cut_envelope
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4, 1, 0, 0, $5, clock_timestamp(), clock_timestamp(),
      true, true, 'action-test/2.0.0', $6, $7, '{}'::jsonb
    )
  `, [
    cutId, tenantId, projectId, bindingDigest, digest(`fact-set:${label}`),
    `cut:${label}`, digest(`cut-request:${label}`),
  ]);
  const proofDigest = digest(`proof:${label}`);
  const evaluatorResult = {
    schemaVersion: 1,
    evaluatorVersion: 'action-test/2.0.0',
    evaluatorDigest: binding.evaluatorDigest,
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
    INSERT INTO outcome_evaluator_result (
      evaluation_id, tenant_id, project_id, subject_type, subject_id, binding_digest,
      cut_id, watermark_logical_time, evaluator_version, evaluator_digest,
      evaluation_digest, proof_digest, result_digest, is_closed, result
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, 'PROJECT', $3::text, $4, $5::uuid, 1,
      'action-test/2.0.0', $6, $7, $8, $9, false, $10::jsonb
    )
  `, [
    evaluationId, tenantId, projectId, bindingDigest, cutId,
    binding.evaluatorDigest, digest(`evaluation:${label}`), proofDigest,
    canonicalDigest(evaluatorResult), JSON.stringify(evaluatorResult),
  ]);
  await pool.query(`
    INSERT INTO outcome_obligation_revision (
      tenant_id, project_id, obligation_id, obligation_revision, binding_digest,
      goal_id, goal_revision, kind, mandatory, obligation, obligation_digest,
      first_evaluation_id
    ) VALUES (
      $1::uuid, $2::uuid, $3, $4, $5, $6, 1, 'REMEDIATE_SIDE_EFFECT', true,
      $7::jsonb, $8, $9::uuid
    )
  `, [
    tenantId, projectId, obligationId, obligationRevision, bindingDigest, binding.goalId,
    JSON.stringify(sourceObligation), canonicalDigest(sourceObligation), evaluationId,
  ]);
  await pool.query(`
    INSERT INTO outcome_active_obligation (
      tenant_id, project_id, obligation_id, obligation_revision, binding_digest,
      goal_id, goal_revision, kind, evaluation_id, evaluated_through_logical_time,
      obligation
    ) VALUES (
      $1::uuid, $2::uuid, $3, $4, $5, $6, 1, 'REMEDIATE_SIDE_EFFECT',
      $7::uuid, 1, $8::jsonb
    )
  `, [
    tenantId, projectId, obligationId, obligationRevision, bindingDigest, binding.goalId,
    evaluationId, JSON.stringify(sourceObligation),
  ]);
  return { ...scope, binding, bindingDigest, sourceObligation, evaluationId, cutId };
}

function intentFor(scope, suffix = '0', overrides = {}) {
  const declared = protocol();
  return {
    schemaVersion: 1,
    actionIntentId: uuid(`action:${scope.label}:${suffix}`),
    actionKind: declared.actionKind,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    obligationId: scope.sourceObligation.obligationId,
    obligationRevision: scope.sourceObligation.obligationRevision,
    bindingDigest: scope.bindingDigest,
    protocolDigest: actionProtocolDigest(declared),
    effectClass: declared.effectClass,
    resourceType: declared.resourceType,
    resourceId: `effect:${scope.label}`,
    targetDigest: scope.targetDigest,
    principal: { type: 'SYSTEM', id: `system:${scope.label}` },
    authorityGrantDigest: scope.authority.grantDigest,
    policyDigest: scope.binding.policyDigest,
    preconditionDigest: scope.preconditionDigest,
    evaluatedThroughLogicalTime: '1',
    idempotencyKey: `action:${scope.label}:${suffix}`,
    budget: {
      accountId: `budget:${scope.label}`,
      unit: 'PROTOCOL_ACTION',
      charge: 1,
      limit: scope.budgetLimit,
      reservationId: `reservation:${scope.label}:${suffix}`,
    },
    retryPolicy: {
      maxAttempts: declared.retry.maxAttempts,
      backoffDigest: actionBackoffDigest(declared.retry.backoffLogicalTicks),
      sameFailureFingerprintLimit: declared.retry.sameFailureFingerprintLimit,
    },
    timeout: { logicalTicks: declared.timeoutLogicalTicks, wallClockMs: 1_000 },
    compensation: {
      compensatorCapability: declared.compensation.capability,
      manualRecovery: declared.compensation.manualRecovery,
      remediationObligationKind: 'REMEDIATE_SIDE_EFFECT',
    },
    receiptRequirements: {
      providerIdentity: true, effectDigest: true, observedAt: true, result: true, idempotencyKey: true,
    },
    ...overrides,
  };
}

function syntheticScope(label) {
  const tenantId = uuid(`synthetic-tenant:${label}`);
  const projectId = uuid(`synthetic-project:${label}`);
  const binding = {
    tenantId,
    projectId,
    goalId: `goal:${projectId}`,
    goalRevision: '1',
    targetDigest: digest(`synthetic-target:${label}`),
    policyDigest: digest(`synthetic-policy:${label}`),
    budgetDigest: digest(`synthetic-budget:${label}`),
  };
  const bindingDigest = canonicalDigest(binding);
  const sourceObligation = {
    obligationId: digest(`synthetic-obligation:${label}`),
    obligationRevision: digest(`synthetic-revision:${label}`),
    kind: 'REMEDIATE_SIDE_EFFECT',
    owner: 'SYSTEM',
    capability: 'effect.remediate',
    binding,
    bindingDigest,
    goalId: binding.goalId,
    goalRevision: binding.goalRevision,
    servesCriterionIds: [],
    blocksClosureOf: ['ACTION_REMEDIATION'],
    ownership: {
      homeProjectId: projectId,
      blockingProjectIds: [projectId],
      crossingId: null,
      handoffId: null,
      handoffStatus: 'NOT_REQUIRED',
      attributionDecisionFactId: null,
    },
  };
  return {
    label,
    tenantId,
    projectId,
    binding,
    bindingDigest,
    sourceObligation,
    targetDigest: binding.targetDigest,
    preconditionDigest: digest(`synthetic-precondition:${label}`),
    budgetLimit: 3,
    authority: { grantDigest: digest(`synthetic-grant:${label}`) },
  };
}

async function enqueue(scope, intent, logicalNow = 1, fairTicks = 100) {
  const row = await one(pool, `
    SELECT outcome_enqueue_action(
      $1::uuid, $2::uuid, $3::jsonb, $4::jsonb, ARRAY[1,4,16]::bigint[], $5, $6
    ) AS result
  `, [scope.tenantId, scope.projectId, JSON.stringify(intent), JSON.stringify(scope.sourceObligation), logicalNow, fairTicks]);
  return row.result;
}

async function claim(scope, logicalNow = 1, worker = `worker:${scope.label}`) {
  const row = await one(pool, `
    SELECT outcome_claim_next_action($1::uuid, $2, $3, 10) AS result
  `, [scope.tenantId, worker, logicalNow]);
  return row.result;
}

function receiptFor(intent, result, extras = {}) {
  const { fingerprint, ...receiptExtras } = extras;
  return {
    providerIdentity: 'provider:test',
    effectDigest: digest(`effect:${intent.actionIntentId}:${result}`),
    observedAt: '2026-08-28T00:00:00.000Z',
    result,
    idempotencyKey: intent.idempotencyKey,
    failureFingerprint: ['RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'QUOTA_WAIT'].includes(result)
      ? (fingerprint ?? digest(`failure:${intent.actionIntentId}:${result}`)) : null,
    retryAfterLogicalTicks: result === 'QUOTA_WAIT' ? (extras.retryAfterLogicalTicks ?? 5) : null,
    ...receiptExtras,
  };
}

async function fencedFinish(scope, claimed, receipt, compensation = null, logicalNow = 1) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const begun = await one(client, `
      SELECT outcome_begin_action_commit($1::uuid, $2::uuid, $3::uuid, $4, $5) AS result
    `, [scope.tenantId, claimed.actionIntentId, claimed.leaseToken, `worker:${scope.label}`, logicalNow]);
    if (!begun.result.authorized) {
      await client.query('COMMIT');
      return { begun: begun.result, finished: null };
    }
    const finished = await one(client, `
      SELECT outcome_finish_action_commit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::jsonb, $6) AS result
    `, [
      scope.tenantId, claimed.actionIntentId, claimed.leaseToken,
      JSON.stringify(receipt), compensation === null ? null : JSON.stringify(compensation), logicalNow,
    ]);
    await client.query('COMMIT');
    return { begun: begun.result, finished: finished.result };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

test('requires a real, explicitly isolated PostgreSQL server', async () => {
  const row = await one(pool, `
    SELECT current_database() AS database, current_user AS "user",
           current_setting('server_version') AS version,
           (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier"
  `);
  assert.equal(row.database, EXPECTED_DATABASE);
  assert.equal(row.user, EXPECTED_USER);
  assert.equal(row.systemIdentifier, EXPECTED_SYSTEM_IDENTIFIER);
  assert.match(row.version, /^1[6-9]\./);
  evidence.postgres = {
    required: true,
    connected: true,
    version: row.version,
    systemIdentifier: row.systemIdentifier,
  };
});

test('effect class, exact target, authority, policy and precondition fail closed', () => {
  const tenantId = uuid('pure-action-tenant');
  const projectId = uuid('pure-action-project');
  const binding = {
    tenantId, projectId, goalId: `goal:${projectId}`, goalRevision: '1',
    targetDigest: digest('pure-target'), policyDigest: digest('pure-policy'),
    budgetDigest: digest('pure-budget'),
  };
  const source = {
    obligationId: digest('pure-obligation'), obligationRevision: digest('pure-revision'),
    kind: 'REMEDIATE_SIDE_EFFECT', owner: 'SYSTEM', capability: 'effect.remediate',
    binding, bindingDigest: canonicalDigest(binding), goalId: binding.goalId, goalRevision: '1',
    servesCriterionIds: [], blocksClosureOf: ['ACTION_REMEDIATION'],
    ownership: { homeProjectId: projectId, blockingProjectIds: [projectId], crossingId: null, handoffId: null, handoffStatus: 'NOT_REQUIRED', attributionDecisionFactId: null },
  };
  const fakeScope = {
    label: 'pure', tenantId, projectId, sourceObligation: source,
    binding, bindingDigest: source.bindingDigest, targetDigest: binding.targetDigest,
    preconditionDigest: digest('pure-precondition'), budgetLimit: 3,
    authority: { grantDigest: digest('pure-grant') },
  };
  const intent = intentFor(fakeScope);
  const snapshot = {
    binding,
    bindingDigest: source.bindingDigest,
    streamWatermarkLogicalTime: '1',
    activeObligation: source,
    authority: {
      grantDigest: intent.authorityGrantDigest,
      principal: intent.principal,
      scopes: ['effect:test'],
      validFromLogicalTime: '0', validThroughLogicalTime: null, revokedAtLogicalTime: null,
    },
    policy: { policyDigest: intent.policyDigest, rules: ['test-effect'], active: true },
    preconditionDigest: intent.preconditionDigest,
    budget: { accountId: intent.budget.accountId, budgetDigest: binding.budgetDigest, unit: intent.budget.unit, limit: 3, reserved: 1, spent: 0 },
  };
  assert.equal(validateActionCommit(intent, source, protocol(), snapshot).allowed, true);
  const wrongEffect = structuredClone(intent);
  wrongEffect.effectClass = 'EXTERNAL_IRREVERSIBLE';
  assert.equal(validateActionCommit(wrongEffect, source, protocol(), snapshot).obligation.kind, 'DIAGNOSE_MODEL_GAP');
  assert.equal(validateActionCommit(intent, source, protocol(), { ...snapshot, binding: { ...binding, targetDigest: digest('other') } }).code, 'TARGET_CHANGED');
  assert.equal(validateActionCommit(intent, source, protocol(), { ...snapshot, authority: { ...snapshot.authority, revokedAtLogicalTime: '1' } }).code, 'AUTHORITY_REVOKED');
  assert.equal(validateActionCommit(intent, source, protocol(), { ...snapshot, authority: { ...snapshot.authority, scopes: [] } }).code, 'AUTHORITY_SCOPE_MISMATCH');
  assert.equal(validateActionCommit(intent, source, protocol(), { ...snapshot, policy: { ...snapshot.policy, policyDigest: digest('other') } }).code, 'POLICY_CHANGED');
  assert.equal(validateActionCommit(intent, source, protocol(), { ...snapshot, policy: { ...snapshot.policy, rules: [] } }).code, 'POLICY_CHANGED');
  assert.equal(validateActionCommit(intent, source, protocol(), { ...snapshot, preconditionDigest: digest('other') }).code, 'PRECONDITION_CHANGED');
  assert.equal(validateActionCommit({ ...intent, protocolDigest: digest('other') }, source, protocol(), snapshot).code, 'ACTION_PROTOCOL_MISMATCH');
  evidence.validation.effectClass = true;
  evidence.validation.exactTarget = true;
  evidence.validation.authority = true;
  evidence.validation.policyDigest = true;
  evidence.validation.protocolDigest = true;
  evidence.validation.precondition = true;
});

test('runtime registry freezes declarations and rejects unsafe adapters', () => {
  const registry = new ActionCapabilityRegistry();
  const declaration = protocol();
  registry.registerProtocol(declaration);
  declaration.retry.maxAttempts = 99;
  assert.equal(registry.protocol(declaration.actionKind).retry.maxAttempts, 3);
  assert.throws(() => registry.registerProtocol(declaration), /ACTION_PROTOCOL_REGISTRATION_CONFLICT/);
  assert.throws(() => registry.registerAdapter({
    capability: 'unsafe.effect',
    providerIdentity: 'provider:unsafe',
    effectClasses: new Set(['EXTERNAL_REVERSIBLE']),
    idempotency: 'NOT_ENFORCED',
    fenceMode: 'REQUIRED_BEFORE_EFFECT',
    execute: async () => { throw new Error('must not run'); },
  }), /ACTION_ADAPTER_UNSAFE/);
  evidence.validation.runtimeRegistryFreeze = true;
});

test('production adapter and compensator calls obey the wall-clock bound', async () => {
  const scope = syntheticScope('wall-clock');
  const intent = intentFor(scope);
  const registry = new ActionCapabilityRegistry();
  const service = new ActionExecutorService({}, registry);
  const adapter = {
    capability: 'test.effect.execute',
    providerIdentity: 'provider:test',
    effectClasses: new Set(['EXTERNAL_REVERSIBLE']),
    idempotency: 'PROVIDER_ENFORCED',
    fenceMode: 'REQUIRED_BEFORE_EFFECT',
    execute: async (context) => {
      await context.assertCommitFence();
      return new Promise(() => undefined);
    },
  };
  const startedAt = Date.now();
  const bounded = await service.invokeBounded(adapter, {
    intent,
    sourceObligation: scope.sourceObligation,
    attemptNumber: 1,
    assertCommitFence: async () => undefined,
  }, 20);
  assert.equal(bounded.fenceChecked, true);
  assert.equal(bounded.receipt.result, 'TIMED_OUT');
  assert.ok(Date.now() - startedAt < 1_000, 'adapter timeout must be bounded');

  registry.registerCompensator({
    capability: 'effect.rollback.external',
    idempotency: 'PROVIDER_ENFORCED',
    compensate: async () => new Promise(() => undefined),
  });
  const compensation = await service.compensationFor({
    actionIntentId: intent.actionIntentId,
    attemptNumber: 1,
    leaseToken: randomUUID(),
    leaseExpiresLogicalTime: '10',
    dispatchSequence: '1',
    intent,
    sourceObligation: scope.sourceObligation,
  }, receiptFor(intent, 'PARTIAL_EFFECT'), async () => undefined, 20);
  assert.equal(compensation.result, 'FAILED');
  assert.equal(compensation.detail.code, 'COMPENSATION_TIMEOUT');
  evidence.scheduling.wallClockTimeout = true;
  evidence.recovery.boundedCompensation = true;
});

test('human routing is a closed four-reason set and ordinary failures remain agent/system-owned', () => {
  const scope = {
    label: 'human-closed', tenantId: uuid('human-t'), projectId: uuid('human-p'),
    binding: { budgetDigest: digest('b') }, bindingDigest: digest('binding'),
    targetDigest: digest('target'), preconditionDigest: digest('pre'), budgetLimit: 2,
    authority: { grantDigest: digest('grant') },
  };
  scope.sourceObligation = {
    obligationId: digest('o'), obligationRevision: digest('r'), kind: 'REMEDIATE_SIDE_EFFECT',
    owner: 'AGENT', capability: 'effect.remediate', binding: scope.binding,
    bindingDigest: scope.bindingDigest, goalId: 'g', goalRevision: '1',
    servesCriterionIds: [], blocksClosureOf: ['ACTION_REMEDIATION'],
    ownership: { homeProjectId: scope.projectId, blockingProjectIds: [scope.projectId], crossingId: null, handoffId: null, handoffStatus: 'NOT_REQUIRED', attributionDecisionFactId: null },
  };
  const intent = intentFor(scope);
  const ownerCodes = ['GOAL_DECISION_REQUIRED', 'RISK_ACCEPTANCE_REQUIRED', 'AUTHORITY_REVOKED', 'EXTERNAL_IDENTITY_REQUIRED'];
  const observed = ownerCodes.map((code) => canonicalActionObligation(intent, scope.sourceObligation, code, { logicalNow: '1' }));
  assert.deepEqual(observed.map((entry) => entry.reason.humanDecisionReason).sort(), [...ACTION_HUMAN_DECISION_REASONS].sort());
  for (const code of ['BUDGET_EXHAUSTED', 'QUOTA_WAIT', 'BACKOFF_ACTIVE', 'PARTIAL_EFFECT', 'UNKNOWN_ACTION_KIND']) {
    const obligation = canonicalActionObligation(intent, scope.sourceObligation, code, { logicalNow: '1' });
    assert.notEqual(obligation.owner, 'OWNER');
    assert.equal(obligation.reason.humanDecisionReason, null);
  }
  evidence.validation.closedHumanReasons = true;
  evidence.modelGap.noImplicitHumanFallback = true;
});

test('unknown actions and missing resolvers become agent diagnosis/MODEL_GAP', () => {
  const scope = {
    label: 'model-gap-pure', tenantId: uuid('mg-t'), projectId: uuid('mg-p'),
    binding: { budgetDigest: digest('mg-b') }, bindingDigest: digest('mg-binding'),
    targetDigest: digest('mg-target'), preconditionDigest: digest('mg-pre'), budgetLimit: 2,
    authority: { grantDigest: digest('mg-grant') },
  };
  scope.sourceObligation = {
    obligationId: digest('mg-o'), obligationRevision: digest('mg-r'), kind: 'REMEDIATE_SIDE_EFFECT',
    owner: 'SYSTEM', capability: 'effect.remediate', binding: scope.binding,
    bindingDigest: scope.bindingDigest, goalId: 'mg-goal', goalRevision: '1',
    servesCriterionIds: [], blocksClosureOf: ['MODEL_COVERAGE'],
    ownership: { homeProjectId: scope.projectId, blockingProjectIds: [scope.projectId], crossingId: null, handoffId: null, handoffStatus: 'NOT_REQUIRED', attributionDecisionFactId: null },
  };
  const intent = intentFor(scope);
  const snapshot = { binding: scope.binding, bindingDigest: scope.bindingDigest, streamWatermarkLogicalTime: '1', activeObligation: scope.sourceObligation, authority: null, policy: null, preconditionDigest: null, budget: null };
  const unknown = validateActionCommit(intent, scope.sourceObligation, null, snapshot);
  const missing = validateActionCommit(intent, scope.sourceObligation, protocol({ resolver: null }), snapshot);
  for (const result of [unknown, missing]) {
    assert.equal(result.allowed, false);
    assert.equal(result.obligation.kind, 'DIAGNOSE_MODEL_GAP');
    assert.equal(result.obligation.owner, 'AGENT');
    assert.equal(result.obligation.reason.humanDecisionReason, null);
  }
  evidence.modelGap.unknownActionAgentOwned = true;
  evidence.modelGap.missingResolverAgentOwned = true;
});

test('enqueue replay is idempotent and a conflicting use of the key is refused', async () => {
  const scope = await seedScope('idempotency');
  const intent = intentFor(scope);
  const first = await enqueue(scope, intent);
  const replay = await enqueue(scope, intent);
  assert.equal(first.actionIntentId, replay.actionIntentId);
  assert.equal(replay.replayed, true);
  assert.deepEqual(first.obligation, canonicalActionObligation(
    intent,
    scope.sourceObligation,
    'FAIR_SCHEDULER_WAIT',
    { logicalNow: '1', dueLogicalTime: '101' },
  ));
  const conflict = structuredClone(intent);
  conflict.targetDigest = digest('conflicting-target');
  await assert.rejects(enqueue(scope, conflict), /OUTCOME_ACTION_IDEMPOTENCY_CONFLICT/);
  evidence.idempotency.enqueueReplay = true;
  evidence.idempotency.conflictingReplayRefused = true;
  evidence.samples.replayedActionIntentId = first.actionIntentId;
});

test('concurrent enqueue of one idempotency key converges on one standing intent', async () => {
  const scope = await seedScope('idempotency-concurrent');
  const intent = intentFor(scope);
  const results = await Promise.all([enqueue(scope, intent), enqueue(scope, intent)]);
  assert.deepEqual(new Set(results.map((result) => result.actionIntentId)), new Set([intent.actionIntentId]));
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  const standing = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_action_intent
     WHERE tenant_id = $1 AND project_id = $2 AND idempotency_key = $3
  `, [scope.tenantId, scope.projectId, intent.idempotencyKey]);
  assert.equal(standing.count, 1);
  evidence.idempotency.concurrentEnqueueReplay = true;
});

test('finite reservation turns budget exhaustion into a canonical obligation', async () => {
  const scope = await seedScope('budget', { budgetLimit: 1 });
  const first = await enqueue(scope, intentFor(scope, 'first'));
  const second = await enqueue(scope, intentFor(scope, 'second'));
  assert.equal(first.status, 'QUEUED');
  assert.equal(second.status, 'BLOCKED_BUDGET');
  assert.equal(second.obligation.reason.code, 'BUDGET_EXHAUSTED');
  assert.notEqual(second.obligation.owner, 'OWNER');
  const budget = await one(pool, `
    SELECT limit_amount::text AS limit, reserved_amount::text AS reserved, spent_amount::text AS spent
      FROM outcome_action_budget_account WHERE tenant_id = $1 AND project_id = $2
  `, [scope.tenantId, scope.projectId]);
  assert.deepEqual(budget, { limit: '1.000000', reserved: '1.000000', spent: '0.000000' });
  evidence.scheduling.finiteBudget = true;
});

test('a valid principal grant from the wrong authority lane is refused', async () => {
  const scope = await seedScope('authority-lane', { authorityFactKind: 'TIMER_SCHEDULED' });
  const result = await enqueue(scope, intentFor(scope));
  assert.equal(result.status, 'REFUSED');
  assert.equal(result.obligation.reason.code, 'AUTHORITY_SCOPE_MISMATCH');
  assert.equal(result.obligation.kind, 'REQUEST_NEW_AUTHORIZATION');
  assert.equal(result.obligation.reason.humanDecisionReason, 'NEW_AUTHORIZATION');
  evidence.validation.authorityLane = true;
});

test('retry fingerprint budget and durable backoff terminate a storm', async () => {
  const scope = await seedScope('retry', { budgetLimit: 5 });
  const intent = intentFor(scope);
  await enqueue(scope, intent);
  const firstClaim = await claim(scope, 1);
  const fingerprint = digest('same-failure');
  const first = await fencedFinish(scope, firstClaim, receiptFor(intent, 'RETRYABLE_FAILURE', { fingerprint }), null, 1);
  assert.equal(first.finished.status, 'BACKOFF');
  assert.equal(first.finished.nextEligibleLogicalTime, '2');
  assert.equal((await claim(scope, 1)), null);
  const secondClaim = await claim(scope, 2);
  const second = await fencedFinish(scope, secondClaim, receiptFor(intent, 'RETRYABLE_FAILURE', { fingerprint }), null, 2);
  assert.equal(second.finished.status, 'FAILED');
  assert.equal(second.finished.obligation.kind, 'DIAGNOSE_MODEL_GAP');
  assert.equal(second.finished.obligation.reason.code, 'RETRY_BUDGET_EXHAUSTED');
  const count = await one(pool, `
    SELECT occurrence_count AS count FROM outcome_action_failure_fingerprint
     WHERE action_intent_id = $1 AND failure_fingerprint = $2
  `, [intent.actionIntentId, fingerprint]);
  assert.equal(count.count, 2);
  evidence.scheduling.finiteRetryFingerprint = true;
  evidence.scheduling.durableBackoff = true;
});

test('quota waits are system-monitored obligations and resume only at their due tick', async () => {
  const scope = await seedScope('quota');
  const intent = intentFor(scope);
  await enqueue(scope, intent);
  const claimed = await claim(scope, 1);
  const result = await fencedFinish(scope, claimed, receiptFor(intent, 'QUOTA_WAIT', { retryAfterLogicalTicks: 5 }), null, 1);
  assert.equal(result.finished.status, 'WAITING_QUOTA');
  assert.equal(result.finished.obligation.kind, 'MONITOR_EXTERNAL_WAIT');
  assert.equal(result.finished.obligation.owner, 'SYSTEM');
  assert.equal(await claim(scope, 5), null);
  assert.ok(await claim(scope, 6));
  evidence.scheduling.quotaWait = true;
});

test('least-recently-served project wins before a retry storm can claim twice', async () => {
  const tenantId = '00000000-0000-4000-a000-000000000100';
  const projectA = '00000000-0000-4000-a000-000000000101';
  const projectB = '00000000-0000-4000-a000-000000000102';
  const a = await seedScope('fair-a', { tenantId, projectId: projectA });
  const b = await seedScope('fair-b', { tenantId, projectId: projectB });
  await enqueue(a, intentFor(a, 'one'));
  await enqueue(a, intentFor(a, 'two'));
  await enqueue(b, intentFor(b, 'one'));
  const first = await claim(a, 1, 'worker:fair');
  const second = await claim(a, 1, 'worker:fair');
  assert.equal(first.intent.projectId, projectA);
  assert.equal(second.intent.projectId, projectB);
  const pure = selectFairAction([
    { actionIntentId: 'a2', projectId: 'a', enqueuedSequence: 2, nextEligibleLogicalTime: '1', deadlineLogicalTime: '10' },
    { actionIntentId: 'b1', projectId: 'b', enqueuedSequence: 3, nextEligibleLogicalTime: '1', deadlineLogicalTime: '10' },
  ], [{ projectId: 'a', lastDispatchedSequence: 1 }], '1');
  assert.equal(pure.projectId, 'b');
  evidence.scheduling.crossProjectFairness = true;
  evidence.samples.fairDispatch = [first.intent.projectId, second.intent.projectId];
});

test('logical deadline timeout is terminal and visible, never an implicit retry', async () => {
  const scope = await seedScope('timeout');
  const intent = intentFor(scope, 'timeout', { timeout: { logicalTicks: 2, wallClockMs: 10 } });
  await enqueue(scope, intent);
  const swept = await one(pool, `SELECT outcome_sweep_action_queue($1::uuid, 3) AS result`, [scope.tenantId]);
  assert.equal(swept.result.timedOut, 1);
  const action = await one(pool, `
    SELECT status, effect_state AS "effectState" FROM outcome_action_intent WHERE action_intent_id = $1
  `, [intent.actionIntentId]);
  assert.deepEqual(action, { status: 'TIMED_OUT', effectState: 'NONE' });
  const active = await one(pool, `
    SELECT kind, owner, obligation#>>'{reason,code}' AS code
      FROM outcome_executor_active_obligation WHERE action_intent_id = $1
  `, [intent.actionIntentId]);
  assert.deepEqual(active, { kind: 'RECOVER_RECONCILER', owner: 'SYSTEM', code: 'ACTION_TIMEOUT' });
  evidence.scheduling.boundedTimeout = true;
});

test('an aborted fenced commit is budgeted and ends in effect-status remediation', async () => {
  const scope = await seedScope('ambiguous-commit', { budgetLimit: 3 });
  const intent = intentFor(scope);
  await enqueue(scope, intent);

  const crossFenceAndLoseTransaction = async (claimed, logicalNow) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const begun = await one(client, `
        SELECT outcome_begin_action_commit($1::uuid, $2::uuid, $3::uuid, $4, $5) AS result
      `, [scope.tenantId, claimed.actionIntentId, claimed.leaseToken, `worker:${scope.label}`, logicalNow]);
      assert.equal(begun.result.authorized, true);
      await one(client, `
        SELECT outcome_assert_action_commit_fence($1::uuid, $2::uuid, $3::uuid) AS fence
      `, [scope.tenantId, claimed.actionIntentId, claimed.leaseToken]);
      // Models a connection/database loss after the provider may have accepted the idempotency key.
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  };

  const firstClaim = await claim(scope, 1);
  await crossFenceAndLoseTransaction(firstClaim, 1);
  assert.equal(await claim(scope, 11), null, 'expired attempt enters bounded backoff first');
  const afterFirst = await one(pool, `
    SELECT status, effect_state AS "effectState" FROM outcome_action_intent WHERE action_intent_id = $1
  `, [intent.actionIntentId]);
  assert.deepEqual(afterFirst, { status: 'BACKOFF', effectState: 'POSSIBLE' });
  const firstBudget = await one(pool, `
    SELECT spent_amount::text AS spent, reserved_amount::text AS reserved
      FROM outcome_action_budget_account WHERE tenant_id = $1 AND project_id = $2
  `, [scope.tenantId, scope.projectId]);
  assert.deepEqual(firstBudget, { spent: '1.000000', reserved: '1.000000' });

  const secondClaim = await claim(scope, 12);
  await crossFenceAndLoseTransaction(secondClaim, 12);
  assert.equal(await claim(scope, 21), null, 'deadline closes an ambiguous external attempt');
  const terminal = await one(pool, `
    SELECT status, effect_state AS "effectState" FROM outcome_action_intent WHERE action_intent_id = $1
  `, [intent.actionIntentId]);
  assert.deepEqual(terminal, { status: 'REMEDIATION_REQUIRED', effectState: 'UNKNOWN' });
  const terminalBudget = await one(pool, `
    SELECT spent_amount::text AS spent, reserved_amount::text AS reserved
      FROM outcome_action_budget_account WHERE tenant_id = $1 AND project_id = $2
  `, [scope.tenantId, scope.projectId]);
  assert.deepEqual(terminalBudget, { spent: '2.000000', reserved: '0.000000' });
  const active = await one(pool, `
    SELECT kind, owner, obligation#>>'{reason,code}' AS code
      FROM outcome_executor_active_obligation WHERE action_intent_id = $1
  `, [intent.actionIntentId]);
  assert.deepEqual(active, { kind: 'REMEDIATE_SIDE_EFFECT', owner: 'AGENT', code: 'EFFECT_STATUS_UNKNOWN' });
  const receipts = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_action_receipt WHERE action_intent_id = $1
  `, [intent.actionIntentId]);
  assert.equal(receipts.count, 0);
  evidence.recovery.ambiguousLeaseRemediation = true;
});

test('partial external effect creates agent remediation; automatic compensation closes its trace', async () => {
  const manualScope = await seedScope('partial-manual');
  const manualIntent = intentFor(manualScope);
  await enqueue(manualScope, manualIntent);
  const manualClaim = await claim(manualScope, 1);
  const manual = await fencedFinish(manualScope, manualClaim, receiptFor(manualIntent, 'PARTIAL_EFFECT'), null, 1);
  assert.equal(manual.finished.status, 'REMEDIATION_REQUIRED');
  assert.equal(manual.finished.obligation.kind, 'REMEDIATE_SIDE_EFFECT');
  assert.equal(manual.finished.obligation.owner, 'AGENT');
  assert.equal(manual.finished.obligation.reason.humanDecisionReason, null);
  assert.deepEqual(manual.finished.obligation.reason.recovery, {
    compensatorCapability: 'effect.rollback.external',
    manualRecovery: null,
    remediationObligationKind: 'REMEDIATE_SIDE_EFFECT',
  });

  const autoScope = await seedScope('partial-auto');
  const autoIntent = intentFor(autoScope);
  await enqueue(autoScope, autoIntent);
  const autoClaim = await claim(autoScope, 1);
  const compensation = {
    result: 'COMPENSATED',
    capability: 'effect.rollback.external',
    effectDigest: digest('automatic-compensation'),
    idempotencyKey: `${autoIntent.idempotencyKey}:compensation`,
  };
  const automatic = await fencedFinish(autoScope, autoClaim, receiptFor(autoIntent, 'PARTIAL_EFFECT'), compensation, 1);
  assert.equal(automatic.finished.status, 'COMPENSATED');
  const activeCount = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_executor_active_obligation WHERE action_intent_id = $1
  `, [autoIntent.actionIntentId]);
  assert.equal(activeCount.count, 0);
  const trace = await pool.query(`
    SELECT to_state AS state FROM outcome_executor_obligation_event
     WHERE action_intent_id = $1 ORDER BY event_id
  `, [autoIntent.actionIntentId]);
  assert.ok(trace.rows.some((row) => row.state === 'ACTIVE'));
  assert.ok(trace.rows.some((row) => row.state === 'RESOLVED'));
  evidence.recovery.partialEffectRemediation = true;
  evidence.recovery.automaticCompensationTrace = true;
  evidence.recovery.unknownEffectNotRetried = true;
  evidence.recovery.declaredRecoveryPath = true;
});

test('an action holding the fence linearizes before concurrent revocation', async () => {
  const scope = await seedScope('revoke-after');
  const intent = intentFor(scope);
  await enqueue(scope, intent);
  const claimed = await claim(scope, 1);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const begun = await one(client, `
      SELECT outcome_begin_action_commit($1::uuid, $2::uuid, $3::uuid, $4, 1) AS result
    `, [scope.tenantId, claimed.actionIntentId, claimed.leaseToken, `worker:${scope.label}`]);
    assert.equal(begun.result.authorized, true);
    let revoked = false;
    const revocation = pool.query(`
      SELECT outcome_revoke_authority_grant($1::uuid, $2::uuid, $3::uuid, $4) AS logical_time
    `, [scope.tenantId, scope.projectId, scope.grantId, digest('revoke-after-reason')]).then((value) => {
      revoked = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(revoked, false, 'revocation must wait for the stream fence');
    await one(client, `
      SELECT outcome_finish_action_commit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, NULL, 1) AS result
    `, [scope.tenantId, claimed.actionIntentId, claimed.leaseToken, JSON.stringify(receiptFor(intent, 'SUCCEEDED'))]);
    await client.query('COMMIT');
    const revokedRow = await revocation;
    assert.equal(revokedRow.rows[0].logical_time, '2');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const receipts = await one(pool, `SELECT count(*)::integer AS count FROM outcome_action_receipt WHERE action_intent_id = $1`, [intent.actionIntentId]);
  assert.equal(receipts.count, 1);
  evidence.races.revokeAfterFenceSerializes = true;
  evidence.idempotency.oneProviderReceipt = true;
});

test('revocation that wins before the fence prevents provider commit and records authorization obligation', async () => {
  const scope = await seedScope('revoke-before');
  const intent = intentFor(scope);
  await enqueue(scope, intent);
  const claimed = await claim(scope, 1);
  await one(pool, `
    SELECT outcome_revoke_authority_grant($1::uuid, $2::uuid, $3::uuid, $4) AS logical_time
  `, [scope.tenantId, scope.projectId, scope.grantId, digest('revoke-before-reason')]);
  const result = await fencedFinish(scope, claimed, receiptFor(intent, 'SUCCEEDED'), null, 1);
  assert.equal(result.begun.authorized, false);
  assert.equal(result.begun.code, 'AUTHORITY_REVOKED');
  const receipts = await one(pool, `SELECT count(*)::integer AS count FROM outcome_action_receipt WHERE action_intent_id = $1`, [intent.actionIntentId]);
  assert.equal(receipts.count, 0);
  const active = await one(pool, `
    SELECT kind, owner, human_decision_reason AS "humanReason"
      FROM outcome_executor_active_obligation WHERE action_intent_id = $1
  `, [intent.actionIntentId]);
  assert.deepEqual(active, { kind: 'REQUEST_NEW_AUTHORIZATION', owner: 'OWNER', humanReason: 'NEW_AUTHORIZATION' });
  evidence.races.revokeBeforeFenceRefuses = true;
});

test('binding replacement races are serialized in both orders', async () => {
  const after = await seedScope('binding-after');
  const afterIntent = intentFor(after);
  await enqueue(after, afterIntent);
  const afterClaim = await claim(after, 1);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const begun = await one(client, `
      SELECT outcome_begin_action_commit($1::uuid, $2::uuid, $3::uuid, $4, 1) AS result
    `, [after.tenantId, afterClaim.actionIntentId, afterClaim.leaseToken, `worker:${after.label}`]);
    assert.equal(begun.result.authorized, true);
    const replacement = { ...after.binding, policyDigest: digest('binding-after-new-policy') };
    let replaced = false;
    const replacementPromise = pool.query(`
      SELECT outcome_register_fact_binding($1::uuid, $2::uuid, $3::jsonb) AS result
    `, [after.tenantId, after.projectId, JSON.stringify(replacement)]).then((value) => {
      replaced = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(replaced, false, 'binding replacement must wait for the action fence');
    await one(client, `
      SELECT outcome_finish_action_commit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, NULL, 1) AS result
    `, [after.tenantId, afterClaim.actionIntentId, afterClaim.leaseToken, JSON.stringify(receiptFor(afterIntent, 'SUCCEEDED'))]);
    await client.query('COMMIT');
    await replacementPromise;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  evidence.races.bindingAfterFenceSerializes = true;

  const before = await seedScope('binding-before');
  const beforeIntent = intentFor(before);
  await enqueue(before, beforeIntent);
  const beforeClaim = await claim(before, 1);
  const replacement = { ...before.binding, policyDigest: digest('binding-before-new-policy') };
  await one(pool, `
    SELECT outcome_register_fact_binding($1::uuid, $2::uuid, $3::jsonb) AS result
  `, [before.tenantId, before.projectId, JSON.stringify(replacement)]);
  const refused = await fencedFinish(before, beforeClaim, receiptFor(beforeIntent, 'SUCCEEDED'), null, 1);
  assert.equal(refused.begun.authorized, false);
  assert.equal(refused.begun.code, 'BINDING_CHANGED');
  const receiptCount = await one(pool, `SELECT count(*)::integer AS count FROM outcome_action_receipt WHERE action_intent_id = $1`, [beforeIntent.actionIntentId]);
  assert.equal(receiptCount.count, 0);
  evidence.races.bindingBeforeFenceRefuses = true;
});

test('durable unknown-action diagnostic is idempotent and cannot masquerade as a human request', async () => {
  const scope = await seedScope('diagnostic');
  const intent = intentFor(scope, 'unknown', { actionKind: 'DYNAMIC_UNKNOWN_ACTION' });
  const obligation = canonicalActionObligation(intent, scope.sourceObligation, 'UNKNOWN_ACTION_KIND', { logicalNow: '1' });
  const request = { intent, sourceObligation: scope.sourceObligation };
  const values = [
    scope.tenantId, scope.projectId, scope.sourceObligation.obligationRevision,
    `${intent.idempotencyKey}:diagnostic`, 'UNKNOWN_ACTION_KIND', JSON.stringify(request), JSON.stringify(obligation),
  ];
  const rows = await Promise.all([0, 1].map(() => one(pool, `
    SELECT outcome_record_action_diagnostic($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb) AS result
  `, values)));
  assert.equal(rows[0].result.diagnosticId, rows[1].result.diagnosticId);
  assert.deepEqual(rows.map((row) => row.result.replayed).sort(), [false, true]);
  const standing = rows[0].result;
  assert.equal(standing.obligation.kind, 'DIAGNOSE_MODEL_GAP');
  assert.equal(standing.obligation.owner, 'AGENT');
  assert.equal(standing.obligation.reason.humanDecisionReason, null);
  evidence.modelGap.durableDiagnosticReplay = true;
  evidence.samples.diagnosticId = standing.diagnosticId;
});

test('pure timeout transition treats a possibly-applied external effect as remediation, not retry', () => {
  const scope = {
    label: 'pure-timeout', tenantId: uuid('pt-t'), projectId: uuid('pt-p'),
    binding: { budgetDigest: digest('pt-b') }, bindingDigest: digest('pt-binding'),
    targetDigest: digest('pt-target'), preconditionDigest: digest('pt-pre'), budgetLimit: 2,
    authority: { grantDigest: digest('pt-grant') },
  };
  scope.sourceObligation = {
    obligationId: digest('pt-o'), obligationRevision: digest('pt-r'), kind: 'REMEDIATE_SIDE_EFFECT',
    owner: 'SYSTEM', capability: 'effect.remediate', binding: scope.binding,
    bindingDigest: scope.bindingDigest, goalId: 'pt-goal', goalRevision: '1',
    servesCriterionIds: [], blocksClosureOf: ['ACTION_REMEDIATION'],
    ownership: { homeProjectId: scope.projectId, blockingProjectIds: [scope.projectId], crossingId: null, handoffId: null, handoffStatus: 'NOT_REQUIRED', attributionDecisionFactId: null },
  };
  const intent = intentFor(scope);
  const transition = transitionForReceipt(intent, scope.sourceObligation, protocol(), receiptFor(intent, 'TIMED_OUT'), {
    attempt: 1, sameFailureFingerprintCount: 0, logicalNow: '1', effectMayHaveOccurred: true,
  });
  assert.equal(transition.status, 'REMEDIATION_REQUIRED');
  assert.equal(transition.obligation.kind, 'REMEDIATE_SIDE_EFFECT');
  assert.equal(transition.obligation.reason.code, 'EFFECT_STATUS_UNKNOWN');
});
