import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const MODULE = process.env.OUTCOME_DELIVERY_MODULE;
const EVALUATOR_MODULE = process.env.OUTCOME_DELIVERY_EVALUATOR_MODULE;
const PG_URL = process.env.OUTCOME_DELIVERY_PG_URL;
const EVIDENCE_PATH = process.env.OUTCOME_DELIVERY_EVIDENCE_PATH;
const EXPECTED_DATABASE = process.env.OUTCOME_DELIVERY_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OUTCOME_DELIVERY_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER = process.env.OUTCOME_DELIVERY_PG_EXPECTED_SYSTEM_IDENTIFIER;
assert.ok(MODULE && EVALUATOR_MODULE && PG_URL && EVIDENCE_PATH,
  'delivery acceptance environment is incomplete');

const delivery = await import(pathToFileURL(MODULE).href);
const {
  deliveryDimensionFacts,
  deliveryFailureTransition,
  evaluateDeliveryObligation,
} = delivery;
const { OUTCOME_DIMENSIONS } = await import(pathToFileURL(EVALUATOR_MODULE).href);
const { Pool } = pg;
const pool = new Pool({ connectionString: PG_URL, max: 8 });

const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-delivery',
  postgres: { required: true, connected: false, version: '', systemIdentifier: '' },
  scenarios: {
    worktreePassNotDelivery: false,
    attestationAloneNotDelivery: false,
    forgedReceiptRefused: false,
    wrongRepositoryRefused: false,
    cleanTargetRequired: false,
    providerReplayFenced: false,
    concurrentProviderReplayFenced: false,
    mergeConflictVisible: false,
    targetAdvanceReopens: false,
    postMergeRegressionVisible: false,
    partialEffectVisible: false,
  },
  policies: {
    everDeliveredPreserved: false,
    currentTargetContainsRechecked: false,
    currentVsEverDistinct: false,
  },
  actionExecutor: {
    mergeConflictRetry: false,
    targetAdvanceRetry: false,
    regressionDiagnosis: false,
    partialEffectCompensation: false,
  },
  recovery: {
    updatedReceiptAdvances: false,
    postMergeReceiptAdvances: false,
    compensationReceiptAdvances: false,
    noManualBlockerClear: false,
    exactReplayIdempotent: false,
  },
  invariants: {
    repositoryBound: false,
    targetShaAndContentBound: false,
    artifactBound: false,
    providerBound: false,
    authenticatedProviderBound: false,
    verificationTimeBound: false,
    verificationCausalOrderBound: false,
    canonicalBindingBound: false,
    bindingRevisionBound: false,
    historicalReplayCannotSatisfyCurrent: false,
    canonicalEvaluatorDeclared: false,
    latestCleanRunAuthoritative: false,
    zeroSkipRequired: false,
    dimensionFactsDerived: false,
  },
  samples: {
    satisfiedProofDigest: '',
    reopenedObligationRevision: '',
    deliveryBindingDigest: '',
  },
};

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function uuid(value) {
  const raw = digest(value);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

async function one(client, text, values = []) {
  const result = await client.query(text, values);
  assert.equal(result.rows.length, 1, `expected one row from ${text.slice(0, 100)}`);
  return result.rows[0];
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function canonicalBinding(scope) {
  return {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    subjectType: 'PROJECT',
    subjectId: scope.projectId,
    goalId: `goal:${scope.projectId}`,
    goalRevision: '1',
    contractDigest: digest(`contract:${scope.label}`),
    evaluationPlanDigest: digest(`evaluation-plan:${scope.label}`),
    policyDigest: digest(`policy:${scope.label}`),
    riskPolicyDigest: digest(`risk:${scope.label}`),
    permissionDigest: digest(`permission:${scope.label}`),
    authorityGrantDigest: digest(`authority:${scope.label}`),
    budgetDigest: digest(`budget:${scope.label}`),
    capabilityRegistryDigest: digest(`registry:${scope.label}`),
    recipientDigest: digest(`recipient:${scope.label}`),
    evaluatorDigest: digest('outcome-delivery-evaluator-v1'),
    factSchemaDigest: digest('outcome-delivery-facts-v1'),
    environmentDigest: digest(`environment:${scope.label}`),
    artifactDigest: digest(`artifact:${scope.label}`),
    targetDigest: digest(`repository:${scope.label}`),
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '1',
    factCutDigest: digest(`prospective-cut:${scope.label}`),
  };
}

function bindingSpec(scope, targetSha, targetContentDigest, suffix = 'initial', overrides = {}) {
  return {
    schemaVersion: 1,
    goalId: scope.binding.goalId,
    goalRevision: scope.binding.goalRevision,
    canonicalBindingDigest: scope.canonicalBindingDigest,
    policyMode: scope.policyMode,
    repositoryProvider: 'git.example.test',
    repositoryId: `owner/${scope.label}`,
    repositoryDigest: scope.binding.targetDigest,
    targetRef: scope.binding.targetRef,
    currentTargetSha: targetSha,
    currentTargetContentDigest: targetContentDigest,
    artifactDigest: scope.binding.artifactDigest,
    evaluationPlanDigest: scope.binding.evaluationPlanDigest,
    acceptanceCommandDigest: digest(`npm-test:${scope.label}`),
    integrationProviderIdentity: `merge-provider:${scope.label}`,
    verificationProviderIdentity: `clean-runner:${scope.label}`,
    asOfLogicalTime: overrides.asOfLogicalTime ?? '1',
    idempotencyKey: `delivery-binding:${scope.label}:${suffix}`,
  };
}

async function registerBinding(scope, spec) {
  const row = await one(pool, `
    SELECT outcome_register_delivery_binding($1::uuid,$2::uuid,$3::jsonb) AS receipt
  `, [scope.tenantId, scope.projectId, JSON.stringify(spec)]);
  scope.deliveryBindingDigest = row.receipt.deliveryBindingDigest;
  scope.bindingRevisionDigest = row.receipt.bindingRevisionDigest;
  scope.currentSpec = spec;
  return row.receipt;
}

async function setup(label, policyMode = 'CURRENT_TARGET_CONTAINS', targetSha = SHA_A) {
  const scope = {
    label,
    policyMode,
    tenantId: uuid(`tenant:${label}`),
    projectId: uuid(`project:${label}`),
  };
  scope.binding = canonicalBinding(scope);
  const row = await one(pool, `
    SELECT outcome_register_fact_binding($1::uuid,$2::uuid,$3::jsonb) AS receipt
  `, [scope.tenantId, scope.projectId, JSON.stringify(scope.binding)]);
  scope.canonicalBindingDigest = row.receipt.bindingDigest;
  await registerBinding(scope, bindingSpec(scope, targetSha, digest(`tree:${label}:${targetSha}`)));
  return scope;
}

function attestation(scope, overrides = {}) {
  const targetSha = overrides.targetSha ?? scope.currentSpec.currentTargetSha;
  return {
    schemaVersion: 1,
    deliveryBindingDigest: scope.deliveryBindingDigest,
    bindingRevisionDigest: scope.bindingRevisionDigest,
    providerReceiptId: overrides.providerReceiptId ?? `merge:${scope.label}:${targetSha.slice(0, 8)}`,
    providerIdentity: overrides.providerIdentity ?? scope.currentSpec.integrationProviderIdentity,
    repositoryProvider: overrides.repositoryProvider ?? scope.currentSpec.repositoryProvider,
    repositoryId: overrides.repositoryId ?? scope.currentSpec.repositoryId,
    repositoryDigest: overrides.repositoryDigest ?? scope.currentSpec.repositoryDigest,
    targetRef: overrides.targetRef ?? scope.currentSpec.targetRef,
    targetSha,
    targetContentDigest: overrides.targetContentDigest ?? scope.currentSpec.currentTargetContentDigest,
    artifactDigest: overrides.artifactDigest ?? scope.currentSpec.artifactDigest,
    result: overrides.result ?? 'INTEGRATED',
    externalEffectState: overrides.externalEffectState ?? 'NONE',
    verifiedAt: overrides.verifiedAt ?? '2026-08-28T09:00:00.000Z',
    verifiedLogicalTime: overrides.verifiedLogicalTime ?? '2',
    idempotencyKey: overrides.idempotencyKey ?? `attestation:${scope.label}:${targetSha}:${overrides.result ?? 'INTEGRATED'}`,
  };
}

async function recordAttestation(
  scope,
  receipt,
  authenticatedProviderIdentity = scope.currentSpec.integrationProviderIdentity,
) {
  return (await one(pool, `
    SELECT outcome_record_delivery_attestation($1::uuid,$2::uuid,$3,$4::jsonb) AS receipt
  `, [scope.tenantId, scope.projectId, authenticatedProviderIdentity, JSON.stringify(receipt)])).receipt;
}

function verification(scope, overrides = {}) {
  const targetSha = overrides.targetSha ?? scope.currentSpec.currentTargetSha;
  return {
    schemaVersion: 1,
    deliveryBindingDigest: scope.deliveryBindingDigest,
    bindingRevisionDigest: scope.bindingRevisionDigest,
    providerReceiptId: overrides.providerReceiptId ?? `verify:${scope.label}:${targetSha.slice(0, 8)}`,
    providerIdentity: overrides.providerIdentity ?? scope.currentSpec.verificationProviderIdentity,
    repositoryDigest: overrides.repositoryDigest ?? scope.currentSpec.repositoryDigest,
    targetRef: overrides.targetRef ?? scope.currentSpec.targetRef,
    targetSha,
    targetContentDigest: overrides.targetContentDigest ?? scope.currentSpec.currentTargetContentDigest,
    artifactDigest: overrides.artifactDigest ?? scope.currentSpec.artifactDigest,
    evaluationPlanDigest: overrides.evaluationPlanDigest ?? scope.currentSpec.evaluationPlanDigest,
    acceptanceCommandDigest: overrides.acceptanceCommandDigest ?? scope.currentSpec.acceptanceCommandDigest,
    environment: overrides.environment ?? 'CLEAN_TARGET_SHA',
    result: overrides.result ?? 'PASS',
    exitCode: overrides.exitCode ?? 0,
    skipCount: overrides.skipCount ?? 0,
    verifiedAt: overrides.verifiedAt ?? '2026-08-28T09:01:00.000Z',
    verifiedLogicalTime: overrides.verifiedLogicalTime ?? '3',
    idempotencyKey: overrides.idempotencyKey ?? `verification:${scope.label}:${targetSha}:${overrides.result ?? 'PASS'}`,
  };
}

async function recordVerification(
  scope,
  receipt,
  authenticatedProviderIdentity = scope.currentSpec.verificationProviderIdentity,
) {
  return (await one(pool, `
    SELECT outcome_record_delivery_verification($1::uuid,$2::uuid,$3,$4::jsonb) AS receipt
  `, [scope.tenantId, scope.projectId, authenticatedProviderIdentity, JSON.stringify(receipt)])).receipt;
}

async function evidenceFor(scope, worktreeExecutions = []) {
  const row = await one(pool, `
    SELECT outcome_read_delivery_evidence($1::uuid,$2::uuid,$3) AS evidence
  `, [scope.tenantId, scope.projectId, scope.deliveryBindingDigest]);
  return { ...row.evidence, worktreeExecutions };
}

async function evaluate(scope, worktreeExecutions = []) {
  return evaluateDeliveryObligation(await evidenceFor(scope, worktreeExecutions));
}

function actionFixture(source, failure, overrides = {}) {
  const readOnly = failure !== 'PARTIAL_EXTERNAL_EFFECT';
  const intent = {
    schemaVersion: 1,
    actionIntentId: `delivery-action:${failure.toLowerCase()}`,
    actionKind: `DELIVERY_${failure}`,
    tenantId: source.binding.tenantId,
    projectId: source.binding.projectId,
    obligationId: source.obligationId,
    obligationRevision: source.obligationRevision,
    bindingDigest: source.bindingDigest,
    protocolDigest: digest(`protocol:${failure}`),
    effectClass: readOnly ? 'READ_ONLY' : 'EXTERNAL_REVERSIBLE',
    resourceType: failure === 'POST_MERGE_REGRESSION' ? 'VERIFICATION' : 'GIT_REFERENCE',
    resourceId: `delivery:${failure.toLowerCase()}`,
    targetDigest: digest(`target:${failure}`),
    principal: { type: 'PROVIDER', id: `delivery-provider:${failure.toLowerCase()}` },
    authorityGrantDigest: digest(`grant:${failure}`),
    policyDigest: digest(`policy:${failure}`),
    preconditionDigest: digest(`precondition:${failure}`),
    evaluatedThroughLogicalTime: '10',
    idempotencyKey: `delivery-action-key:${failure.toLowerCase()}`,
    budget: { accountId: 'delivery', unit: 'PROTOCOL_ACTION', charge: 1, limit: 4, reservationId: `reservation:${failure.toLowerCase()}` },
    retryPolicy: { maxAttempts: 3, backoffDigest: digest([1, 4, 16]), sameFailureFingerprintLimit: 2 },
    timeout: { logicalTicks: 20, wallClockMs: 1000 },
    compensation: { compensatorCapability: 'delivery.effect.rollback', manualRecovery: null, remediationObligationKind: 'REMEDIATE_SIDE_EFFECT' },
    receiptRequirements: { providerIdentity: true, effectDigest: true, observedAt: true, result: true, idempotencyKey: true },
  };
  const protocol = {
    obligationKind: source.kind,
    actionKind: intent.actionKind,
    effectClass: intent.effectClass,
    resourceType: intent.resourceType,
    actor: { role: source.owner, adapter: 'DELIVERY_PROVIDER', capability: source.capability },
    resolver: { adapter: 'OUTCOME_RECONCILER', capability: 'delivery.resolve' },
    authorityScopes: ['delivery:test'],
    policyRules: ['delivery-bound'],
    budgetUnit: 'PROTOCOL_ACTION',
    budgetCharge: 1,
    retry: { maxAttempts: 3, sameFailureFingerprintLimit: 2, backoffLogicalTicks: [1, 4, 16] },
    timeoutLogicalTicks: 20,
    compensation: { capability: 'delivery.effect.rollback', manualRecovery: null, remediationObligationKind: 'REMEDIATE_SIDE_EFFECT' },
  };
  return deliveryFailureTransition(failure, intent, source, protocol, {
    attempt: overrides.attempt ?? 1,
    sameFailureFingerprintCount: overrides.sameFailureFingerprintCount ?? 0,
    logicalNow: '10',
    effectMayHaveOccurred: failure === 'PARTIAL_EXTERNAL_EFFECT',
    compensationOutcome: overrides.compensationOutcome,
  });
}

before(async () => {
  const server = await one(pool, `
    SELECT current_database() AS database,current_user AS role,
           current_setting('server_version') AS version,
           system_identifier::text
      FROM pg_control_system()
  `);
  assert.equal(server.database, EXPECTED_DATABASE);
  assert.equal(server.role, EXPECTED_USER);
  assert.equal(server.system_identifier, EXPECTED_SYSTEM_IDENTIFIER);
  assert.match(server.version, /^1[6-9]\./);
  evidence.postgres = {
    required: true,
    connected: true,
    version: server.version.split(' ')[0],
    systemIdentifier: server.system_identifier,
  };
});

after(async () => {
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  await pool.end();
});

test('requires a real isolated PostgreSQL server and append-only delivery ledger', async () => {
  const rows = await pool.query(`
    SELECT trigger.tgname AS trigger_name
      FROM pg_trigger trigger
     WHERE NOT trigger.tgisinternal
       AND trigger.tgname LIKE 'outcome_delivery_%_append_only'
     ORDER BY trigger.tgname
  `);
  assert.deepEqual(rows.rows.map((row) => row.trigger_name), [
    'outcome_delivery_attestation_append_only',
    'outcome_delivery_binding_append_only',
    'outcome_delivery_verification_append_only',
  ]);
});

test('delivery dimensions are first-class canonical evaluator obligations', () => {
  const declarations = new Map(OUTCOME_DIMENSIONS.map((item) => [item.id, item.obligationKind]));
  assert.equal(declarations.get('ARTIFACT_INTEGRATION'), 'PROVE_ARTIFACT_INTEGRATION');
  assert.equal(declarations.get('TARGET_PRESENCE'), 'PROVE_TARGET_PRESENCE');
  assert.equal(declarations.get('POST_MERGE_VERIFICATION'), 'RUN_BOUND_VERIFICATION');
  assert.equal(declarations.get('ACTION_REMEDIATION'), 'REMEDIATE_SIDE_EFFECT');
  evidence.invariants.canonicalEvaluatorDeclared = true;
});

test('worktree exit zero cannot satisfy the independent integration obligation', async () => {
  const scope = await setup('worktree-only');
  const result = await evaluate(scope, [{
    worktreeId: 'wt-1', sourceSha: SHA_A, commandDigest: digest('npm-test'), exitCode: 0,
  }]);
  assert.equal(result.integrationState, 'UNSATISFIED');
  assert.equal(result.worktreeExitZeroIsDeliveryEvidence, false);
  assert.equal(result.selectedAttestationId, null);
  assert.equal(result.activeMandatoryObligations[0].kind, 'PROVE_ARTIFACT_INTEGRATION');
  evidence.scenarios.worktreePassNotDelivery = true;
});

test('a repository attestation without a clean target rerun remains unsatisfied', async () => {
  const scope = await setup('attestation-only');
  await recordAttestation(scope, attestation(scope));
  const result = await evaluate(scope);
  assert.equal(result.integrationState, 'UNSATISFIED');
  assert.equal(result.currentTargetContains, false, 'current policy includes the clean verification');
  assert.equal(result.activeMandatoryObligations[0].kind, 'RUN_BOUND_VERIFICATION');
  assert.equal(result.activeMandatoryObligations[0].reason.code, 'DELIVERY_CLEAN_TARGET_RERUN_REQUIRED');
  evidence.scenarios.attestationAloneNotDelivery = true;
  evidence.scenarios.cleanTargetRequired = true;
});

test('forged provider and wrong-repository receipts are refused before ledger append', async () => {
  const scope = await setup('forged-receipt');
  await assert.rejects(
    recordAttestation(scope, attestation(scope, {
      providerIdentity: 'attacker:provider', idempotencyKey: 'forged-provider',
    })),
    /OUTCOME_DELIVERY_PROVIDER_AUTH_MISMATCH/,
  );
  await assert.rejects(
    recordAttestation(scope, attestation(scope, {
      providerReceiptId: 'forged-auth-context', idempotencyKey: 'forged-auth-context',
    }), 'attacker:authenticated-context'),
    /OUTCOME_DELIVERY_PROVIDER_AUTH_MISMATCH/,
  );
  await assert.rejects(
    recordAttestation(scope, attestation(scope, {
      providerReceiptId: 'wrong-repository',
      repositoryDigest: digest('another-repository'),
      idempotencyKey: 'wrong-repository',
    })),
    /OUTCOME_DELIVERY_ATTESTATION_SCOPE_MISMATCH/,
  );
  const count = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_delivery_attestation
     WHERE tenant_id=$1::uuid AND project_id=$2::uuid
  `, [scope.tenantId, scope.projectId]);
  assert.equal(count.count, 0);
  evidence.scenarios.forgedReceiptRefused = true;
  evidence.scenarios.wrongRepositoryRefused = true;
  evidence.invariants.repositoryBound = true;
  evidence.invariants.providerBound = true;
  evidence.invariants.authenticatedProviderBound = true;
});

test('provider replay is idempotent only for byte-identical canonical receipts', async () => {
  const scope = await setup('provider-replay');
  const receipt = attestation(scope);
  const first = await recordAttestation(scope, receipt);
  const replay = await recordAttestation(scope, receipt);
  assert.equal(first.attestationId, replay.attestationId);
  assert.equal(first.receiptDigest, replay.receiptDigest);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    recordAttestation(scope, {
      ...receipt,
      result: 'FAILED',
      verifiedLogicalTime: '4',
      idempotencyKey: 'provider-replay-mutated-key',
    }),
    /OUTCOME_DELIVERY_PROVIDER_REPLAY_CONFLICT/,
  );
  const count = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_delivery_attestation
     WHERE tenant_id=$1::uuid AND project_id=$2::uuid
  `, [scope.tenantId, scope.projectId]);
  assert.equal(count.count, 1);

  const concurrentScope = await setup('provider-replay-concurrent');
  const concurrentReceipt = attestation(concurrentScope);
  const concurrent = await Promise.all(Array.from(
    { length: 6 },
    () => recordAttestation(concurrentScope, concurrentReceipt),
  ));
  assert.equal(new Set(concurrent.map((item) => item.attestationId)).size, 1);
  assert.equal(concurrent.filter((item) => item.replayed === false).length, 1);
  const concurrentCount = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_delivery_attestation
     WHERE tenant_id=$1::uuid AND project_id=$2::uuid
  `, [concurrentScope.tenantId, concurrentScope.projectId]);
  assert.equal(concurrentCount.count, 1);
  evidence.scenarios.providerReplayFenced = true;
  evidence.scenarios.concurrentProviderReplayFenced = true;
  evidence.recovery.exactReplayIdempotent = true;
});

test('only exact attestation plus exit-0 skip-0 clean target rerun satisfies integration', async () => {
  const scope = await setup('satisfied');
  await recordAttestation(scope, attestation(scope));
  await assert.rejects(
    recordVerification(scope, verification(scope, {
      providerReceiptId: 'premature-pass',
      verifiedAt: '2026-08-28T08:59:00.000Z',
      verifiedLogicalTime: '1',
      idempotencyKey: 'premature-pass',
    })),
    /OUTCOME_DELIVERY_VERIFICATION_PRECEDES_INTEGRATION/,
  );
  await assert.rejects(
    recordVerification(scope, verification(scope, {
      providerReceiptId: 'false-pass', skipCount: 1, idempotencyKey: 'false-pass',
    })),
    /OUTCOME_DELIVERY_VERIFICATION_FALSE_PASS/,
  );
  await recordVerification(scope, verification(scope));
  const result = await evaluate(scope);
  assert.equal(result.integrationState, 'SATISFIED');
  assert.equal(result.currentTargetContains, true);
  assert.equal(result.cleanTargetVerified, true);
  assert.equal(result.activeMandatoryObligations.length, 0);
  assert.ok(result.dimensions.slice(0, 3).every((dimension) => dimension.state === 'SATISFIED'));
  assert.equal(deliveryDimensionFacts(result).every((fact) => fact.deliveryProofDigest === result.proofDigest), true);
  evidence.invariants.targetShaAndContentBound = true;
  evidence.invariants.artifactBound = true;
  evidence.invariants.verificationTimeBound = true;
  evidence.invariants.verificationCausalOrderBound = true;
  evidence.invariants.canonicalBindingBound = true;
  evidence.invariants.zeroSkipRequired = true;
  evidence.invariants.dimensionFactsDerived = true;
  evidence.samples.satisfiedProofDigest = result.proofDigest;
  evidence.samples.deliveryBindingDigest = result.deliveryBindingDigest;
});

test('CURRENT_TARGET_CONTAINS reopens on target advance and newer receipts advance automatically', async () => {
  const scope = await setup('current-advance');
  const historicalReceipt = attestation(scope);
  const historicalRecorded = await recordAttestation(scope, historicalReceipt);
  await recordVerification(scope, verification(scope));
  assert.equal((await evaluate(scope)).integrationState, 'SATISFIED');

  const staleCurrentReceipt = attestation(scope, {
    providerReceiptId: 'stale-current-revision',
    verifiedLogicalTime: '4',
    idempotencyKey: 'stale-current-revision',
  });
  const stableBindingDigest = scope.deliveryBindingDigest;
  const previousBindingRevision = scope.bindingRevisionDigest;
  const nextTree = digest('current-advance-tree-b');
  await registerBinding(scope, bindingSpec(scope, SHA_B, nextTree, 'target-b', {
    asOfLogicalTime: '4',
  }));
  assert.equal(scope.deliveryBindingDigest, stableBindingDigest);
  assert.notEqual(scope.bindingRevisionDigest, previousBindingRevision);
  await assert.rejects(
    recordAttestation(scope, staleCurrentReceipt),
    /OUTCOME_DELIVERY_ATTESTATION_SCOPE_MISMATCH/,
  );
  const historicalReplay = await recordAttestation(scope, historicalReceipt);
  assert.equal(historicalReplay.attestationId, historicalRecorded.attestationId);
  assert.equal(historicalReplay.replayed, true);
  const reopened = await evaluate(scope);
  assert.equal(reopened.integrationState, 'UNSATISFIED');
  assert.equal(reopened.everDelivered, true);
  assert.equal(reopened.currentTargetContains, false);
  assert.equal(reopened.activeMandatoryObligations[0].kind, 'PROVE_TARGET_PRESENCE');
  assert.equal(reopened.activeMandatoryObligations[0].reason.code, 'DELIVERY_TARGET_ADVANCED');
  evidence.samples.reopenedObligationRevision = reopened.activeMandatoryObligations[0].obligationRevision;

  await recordAttestation(scope, attestation(scope, {
    providerReceiptId: 'merge-current-b',
    targetSha: SHA_B,
    targetContentDigest: nextTree,
    verifiedLogicalTime: '4',
    idempotencyKey: 'attestation-current-b',
  }));
  assert.equal((await evaluate(scope)).integrationState, 'UNSATISFIED');
  await recordVerification(scope, verification(scope, {
    providerReceiptId: 'verify-current-b',
    targetSha: SHA_B,
    targetContentDigest: nextTree,
    verifiedLogicalTime: '5',
    idempotencyKey: 'verification-current-b',
  }));
  const restored = await evaluate(scope);
  assert.equal(restored.integrationState, 'SATISFIED');
  assert.equal(restored.activeMandatoryObligations.length, 0);
  evidence.scenarios.targetAdvanceReopens = true;
  evidence.policies.currentTargetContainsRechecked = true;
  evidence.recovery.updatedReceiptAdvances = true;
  evidence.recovery.noManualBlockerClear = true;
  evidence.invariants.bindingRevisionBound = true;
  evidence.invariants.historicalReplayCannotSatisfyCurrent = true;

  const retry = actionFixture(reopened.activeMandatoryObligations[0], 'TARGET_ADVANCED');
  assert.equal(retry.status, 'BACKOFF');
  assert.equal(retry.obligation.reason.code, 'BACKOFF_ACTIVE');
  evidence.actionExecutor.targetAdvanceRetry = true;
});

test('EVER_DELIVERED remains satisfied after target advance while current policy does not', async () => {
  const scope = await setup('ever-policy', 'EVER_DELIVERED');
  await recordAttestation(scope, attestation(scope));
  await recordVerification(scope, verification(scope));
  const before = await evaluate(scope);
  assert.equal(before.integrationState, 'SATISFIED');
  await registerBinding(scope, bindingSpec(scope, SHA_C, digest('ever-policy-tree-c'), 'target-c', {
    asOfLogicalTime: '4',
  }));
  const afterAdvance = await evaluate(scope);
  assert.equal(afterAdvance.integrationState, 'SATISFIED');
  assert.equal(afterAdvance.everDelivered, true);
  assert.equal(afterAdvance.currentTargetContains, false);
  assert.equal(afterAdvance.dimensions.find((item) => item.dimensionId === 'TARGET_PRESENCE').state, 'NOT_APPLICABLE');
  evidence.policies.everDeliveredPreserved = true;
  evidence.policies.currentVsEverDistinct = true;
});

test('merge conflict becomes an Action Executor retry obligation', async () => {
  const scope = await setup('merge-conflict');
  await recordAttestation(scope, attestation(scope, {
    result: 'CONFLICT',
    providerReceiptId: 'merge-conflict',
    idempotencyKey: 'merge-conflict',
  }));
  const result = await evaluate(scope);
  const obligation = result.activeMandatoryObligations[0];
  assert.equal(obligation.reason.code, 'DELIVERY_MERGE_CONFLICT');
  assert.equal(obligation.reason.route, 'RETRY');
  const transition = actionFixture(obligation, 'MERGE_CONFLICT');
  assert.equal(transition.status, 'BACKOFF');
  assert.equal(transition.terminal, false);
  assert.equal(transition.obligation.reason.code, 'BACKOFF_ACTIVE');
  evidence.scenarios.mergeConflictVisible = true;
  evidence.actionExecutor.mergeConflictRetry = true;
});

test('post-merge regression becomes an Action Executor diagnosis obligation', async () => {
  const scope = await setup('post-merge-regression');
  await recordAttestation(scope, attestation(scope));
  await recordVerification(scope, verification(scope));
  await recordVerification(scope, verification(scope, {
    result: 'FAIL', exitCode: 1, providerReceiptId: 'verify-regression',
    verifiedLogicalTime: '4', idempotencyKey: 'verify-regression',
  }));
  const result = await evaluate(scope);
  const obligation = result.activeMandatoryObligations[0];
  assert.equal(obligation.reason.code, 'DELIVERY_POST_MERGE_REGRESSION');
  assert.equal(obligation.reason.route, 'DIAGNOSIS');
  const transition = actionFixture(obligation, 'POST_MERGE_REGRESSION');
  assert.equal(transition.status, 'DIAGNOSIS_REQUIRED');
  assert.equal(transition.obligation.kind, 'DIAGNOSE_MODEL_GAP');
  evidence.scenarios.postMergeRegressionVisible = true;
  evidence.actionExecutor.regressionDiagnosis = true;
  evidence.invariants.latestCleanRunAuthoritative = true;

  await recordVerification(scope, verification(scope, {
    providerReceiptId: 'verify-recovered', verifiedLogicalTime: '5',
    idempotencyKey: 'verify-recovered',
  }));
  const recovered = await evaluate(scope);
  assert.equal(recovered.integrationState, 'SATISFIED');
  assert.equal(recovered.activeMandatoryObligations.length, 0);
  evidence.recovery.postMergeReceiptAdvances = true;
});

test('partial external effect becomes an Action Executor compensation obligation', async () => {
  const scope = await setup('partial-effect');
  await recordAttestation(scope, attestation(scope, {
    result: 'PARTIAL_EFFECT', externalEffectState: 'PARTIAL',
    providerReceiptId: 'merge-partial', idempotencyKey: 'merge-partial',
  }));
  const result = await evaluate(scope);
  const obligation = result.activeMandatoryObligations[0];
  assert.equal(obligation.kind, 'REMEDIATE_SIDE_EFFECT');
  assert.equal(obligation.reason.route, 'COMPENSATION');
  const transition = actionFixture(obligation, 'PARTIAL_EXTERNAL_EFFECT');
  assert.equal(transition.status, 'REMEDIATION_REQUIRED');
  assert.equal(transition.obligation.kind, 'REMEDIATE_SIDE_EFFECT');
  assert.equal(transition.obligation.reason.recovery.compensatorCapability, 'delivery.effect.rollback');
  evidence.scenarios.partialEffectVisible = true;
  evidence.actionExecutor.partialEffectCompensation = true;

  await recordAttestation(scope, attestation(scope, {
    result: 'EFFECT_RECONCILED', externalEffectState: 'NONE',
    providerReceiptId: 'merge-partial-reconciled', verifiedLogicalTime: '3',
    idempotencyKey: 'merge-partial-reconciled',
  }));
  const advanced = await evaluate(scope);
  assert.equal(advanced.integrationState, 'UNSATISFIED');
  assert.equal(advanced.activeMandatoryObligations[0].kind, 'PROVE_ARTIFACT_INTEGRATION');
  await recordAttestation(scope, attestation(scope, {
    providerReceiptId: 'merge-after-reconciliation', verifiedLogicalTime: '4',
    idempotencyKey: 'merge-after-reconciliation',
  }));
  await recordVerification(scope, verification(scope, {
    providerReceiptId: 'verify-after-reconciliation', verifiedLogicalTime: '5',
    idempotencyKey: 'verify-after-reconciliation',
  }));
  assert.equal((await evaluate(scope)).integrationState, 'SATISFIED');
  evidence.recovery.compensationReceiptAdvances = true;
});
