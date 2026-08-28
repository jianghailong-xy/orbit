import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  canonicalJson,
  sha256Canonical,
  validateCanonicalFact,
  validateFactCut,
} from '../scripts/lib/outcome-reconciler-v2.mjs';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const ROOT = path.resolve(import.meta.dirname, '..');
const URL = process.env.OUTCOME_FACT_PG_URL;
const EXPECTED_DATABASE = process.env.OUTCOME_FACT_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OUTCOME_FACT_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER = process.env.OUTCOME_FACT_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OUTCOME_FACT_EVIDENCE_PATH;

assert.ok(URL, 'OUTCOME_FACT_PG_URL is required; PostgreSQL absence is a hard failure');
assert.ok(EXPECTED_DATABASE, 'OUTCOME_FACT_PG_EXPECTED_DATABASE is required');
assert.ok(EXPECTED_USER, 'OUTCOME_FACT_PG_EXPECTED_USER is required');
assert.ok(EXPECTED_SYSTEM_IDENTIFIER, 'OUTCOME_FACT_PG_EXPECTED_SYSTEM_IDENTIFIER is required');
assert.ok(EVIDENCE_PATH, 'OUTCOME_FACT_EVIDENCE_PATH is required');

const contract = JSON.parse(readFileSync(path.join(ROOT, 'contracts/outcome-reconciler-v2.contract.json'), 'utf8'));
const schema = JSON.parse(readFileSync(path.join(ROOT, 'contracts/outcome-reconciler-v2.schema.json'), 'utf8'));
const authorityRegistry = JSON.parse(readFileSync(
  path.join(ROOT, 'contracts/outcome-reconciler-v2-authority-matrix.json'), 'utf8',
));
const pool = new Pool({ connectionString: URL, max: 20 });

const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-fact-ingress',
  postgres: { required: true, connected: false, version: null, systemIdentifier: null },
  invariants: {
    canonicalEnvelopeComplete: false,
    serverAllocatedEnvelopeFields: false,
    causalPredecessorScoped: false,
    rfc8785NumericCanonicalization: false,
    appendOnlyUpdateRefused: false,
    appendOnlyDeleteRefused: false,
    sealedCutImmutable: false,
    factsAndProjectionPhysicallySeparated: false,
    projectionCannotChangeReplay: false,
    authorityMatrixComplete: false,
    agentObservationClaimOnly: false,
    controlledRunnerExitMechanical: false,
    mergeReceiptTargetReverified: false,
    ownerDecisionThreatModelBound: false,
    authorityRevocationFailsClosed: false,
    cutLinearizable: false,
  },
  attacks: {
    crossTenantRefused: false,
    staleBindingRefused: false,
    forgedPrincipalRefused: false,
    forgedAuthorityRefused: false,
    forgedSourceRefused: false,
    payloadTamperingRefused: false,
  },
  races: {
    concurrentIdempotencySingleFact: false,
    idempotencyCollisionRefused: false,
    cutBeforeAppendExcludesLateFact: false,
    staleCutCannotPublish: false,
    factAfterProjectionInvalidatesClose: false,
  },
  replay: {
    digestMatchesSealedCut: false,
    digestMatchesJavascriptCanonicalReplay: false,
    proofReadExcludesClaims: false,
    source: 'outcome_canonical_fact+outcome_evaluation_cut_fact',
  },
  authority: { declaredFactKinds: 0, databaseLanes: 0, uncoveredFactKinds: [] },
  samples: {},
};

after(async () => {
  await pool.end();
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${canonicalJson(evidence)}\n`);
});

function digest(label) {
  return createHash('sha256').update(label).digest('hex');
}

function makeBinding({ tenantId, projectId, subjectType, subjectId, grantDigest, riskDigest, overrides = {} }) {
  return {
    tenantId,
    projectId,
    subjectType,
    subjectId,
    goalId: `goal:${subjectId}`,
    goalRevision: '1',
    contractDigest: digest(`contract:${subjectId}`),
    evaluationPlanDigest: digest(`plan:${subjectId}`),
    policyDigest: digest(`policy:${subjectId}`),
    riskPolicyDigest: riskDigest,
    permissionDigest: digest(`permission:${subjectId}`),
    authorityGrantDigest: grantDigest,
    budgetDigest: digest(`budget:${subjectId}`),
    capabilityRegistryDigest: digest(`capabilities:${subjectId}`),
    recipientDigest: digest(`recipient:${subjectId}`),
    evaluatorDigest: digest(`evaluator:${subjectId}`),
    factSchemaDigest: digest('outcome-fact-schema-v2'),
    environmentDigest: digest(`environment:${subjectId}`),
    artifactDigest: digest(`artifact:${subjectId}`),
    targetDigest: digest(`target-repository:${subjectId}`),
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '0',
    factCutDigest: digest(`prospective-cut:${subjectId}`),
    ...overrides,
  };
}

async function registerGrant(client, config) {
  const result = await client.query({
    text: `SELECT outcome_register_authority_grant(
      $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11,
      $12::bigint, $13::bigint, $14
    ) AS authority`,
    values: [
      config.tenantId, config.projectId, config.grantId, config.principalType,
      config.principalId, config.factKind, config.claimType, config.sourceSystem,
      config.collectorId, config.collectorVersion, config.signatureKeyId,
      config.validFrom ?? 1, config.validThrough ?? null, config.riskDigest,
    ],
  });
  return result.rows[0].authority;
}

async function registerBinding(client, tenantId, projectId, binding) {
  const result = await client.query({
    text: 'SELECT outcome_register_fact_binding($1::uuid, $2::uuid, $3::jsonb) AS registered',
    values: [tenantId, projectId, JSON.stringify(binding)],
  });
  return result.rows[0].registered;
}

async function setupLane({
  factKind = 'TASK_STATUS_OBSERVED',
  claimType = 'OBSERVATION',
  principalType = 'AGENT',
  sourceSystem = 'AGENT_COLLECTOR',
  tenantId = randomUUID(),
  projectId = randomUUID(),
  subjectId = randomUUID(),
  principalId = randomUUID(),
  signatureKeyId = 'test-key-v1',
} = {}) {
  const client = await pool.connect();
  try {
    const riskDigest = digest(`risk:${tenantId}:${projectId}`);
    const config = {
      tenantId,
      projectId,
      grantId: randomUUID(),
      principalType,
      principalId,
      factKind,
      claimType,
      sourceSystem,
      collectorId: `${sourceSystem.toLowerCase()}-${randomUUID()}`,
      collectorVersion: '2.0.0-test',
      signatureKeyId,
      riskDigest,
    };
    const authority = await registerGrant(client, config);
    const binding = makeBinding({
      tenantId,
      projectId,
      subjectType: 'TASK',
      subjectId,
      grantDigest: authority.grantDigest,
      riskDigest,
    });
    const registered = await registerBinding(client, tenantId, projectId, binding);
    return { ...config, subjectId, authority, binding, bindingDigest: registered.bindingDigest };
  } finally {
    client.release();
  }
}

function makeDraft(scope, payload, idempotencyKey, overrides = {}) {
  const draft = {
    factKind: scope.factKind,
    tenantId: scope.tenantId,
    subject: { type: 'TASK', id: scope.subjectId, projectId: scope.projectId },
    binding: scope.binding,
    schemaVersion: 2,
    schemaDigest: scope.binding.factSchemaDigest,
    payload,
    payloadDigest: sha256Canonical(payload),
    claimType: scope.claimType,
    principal: { type: scope.principalType, id: scope.principalId },
    authority: scope.authority,
    observedAt: new Date().toISOString(),
    causalPredecessorFactId: null,
    idempotencyKey,
    source: {
      system: scope.sourceSystem,
      collectorId: scope.collectorId,
      collectorVersion: scope.collectorVersion,
    },
    signature: scope.signatureKeyId === null ? null : {
      algorithm: 'TEST-SIGNED-CONTEXT',
      keyId: scope.signatureKeyId,
      value: digest(`signature:${idempotencyKey}`),
    },
  };
  return { ...draft, ...overrides };
}

async function append(client, scope, draft, context = {}) {
  const result = await client.query({
    text: 'SELECT outcome_ingest_canonical_fact($1::uuid, $2, $3, $4::jsonb) AS envelope',
    values: [
      context.tenantId ?? scope.tenantId,
      context.principalType ?? scope.principalType,
      context.principalId ?? scope.principalId,
      JSON.stringify(draft),
    ],
  });
  return result.rows[0].envelope;
}

async function seal(client, scope, key) {
  const result = await client.query({
    text: 'SELECT outcome_seal_evaluation_cut($1::uuid, $2::uuid, $3, $4, $5) AS cut',
    values: [scope.tenantId, scope.projectId, scope.bindingDigest, key, 'fact-ingress-test-v1'],
  });
  return result.rows[0].cut;
}

async function publish(client, scope, cut, projection, closed) {
  return client.query({
    text: `SELECT outcome_publish_evaluation_projection(
      $1::uuid, $2::uuid, 'TASK', $3, $4::uuid, $5::jsonb, $6
    ) AS published`,
    values: [scope.tenantId, scope.projectId, scope.subjectId, cut.cutId, JSON.stringify(projection), closed],
  });
}

test('requires a real, explicitly isolated PostgreSQL server', async () => {
  const client = new Client({ connectionString: URL });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT current_database() AS database,
             current_user AS role,
             (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
             current_setting('server_version') AS version
    `);
    const identity = result.rows[0];
    assert.equal(identity.database, EXPECTED_DATABASE);
    assert.equal(identity.role, EXPECTED_USER);
    assert.equal(identity.system_identifier, EXPECTED_SYSTEM_IDENTIFIER);
    assert.match(identity.database, /^pccfact_/);
    assert.match(identity.role, /^pccfact_/);
    evidence.postgres = {
      required: true,
      connected: true,
      version: identity.version,
      systemIdentifier: identity.system_identifier,
    };
  } finally {
    await client.end();
  }
});

test('the database authority matrix covers every frozen fact kind and preserves all four trust distinctions', async () => {
  const result = await pool.query(`
    SELECT fact_kind AS "factKind", claim_type AS "claimType",
           principal_type AS "principalType", source_system AS "sourceSystem",
           trust_class AS "trustClass", proof_eligible AS "proofEligible",
           signature_required AS "signatureRequired",
           requires_controlled_runner_exit AS "requiresControlledRunnerExit",
           requires_target_repository_verification AS "requiresTargetRepositoryVerification",
           requires_current_threat_model AS "requiresCurrentThreatModel"
      FROM outcome_fact_authority_matrix
     ORDER BY fact_kind, claim_type, principal_type, source_system
  `);
  const dbLanes = result.rows;
  const declared = [...contract.factKinds].sort();
  const covered = [...new Set(dbLanes.map((lane) => lane.factKind))].sort();
  assert.deepEqual(covered, declared);
  assert.deepEqual(
    dbLanes,
    [...authorityRegistry.lanes].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
      .sort((a, b) => `${a.factKind}:${a.claimType}:${a.principalType}:${a.sourceSystem}`
        .localeCompare(`${b.factKind}:${b.claimType}:${b.principalType}:${b.sourceSystem}`)),
  );
  assert.ok(dbLanes.filter((lane) => lane.principalType === 'AGENT')
    .every((lane) => lane.trustClass === 'CLAIM_ONLY' && lane.proofEligible === false));
  assert.ok(dbLanes.some((lane) => lane.requiresControlledRunnerExit && lane.trustClass === 'MECHANICAL_FACT'));
  assert.ok(dbLanes.some((lane) => lane.requiresTargetRepositoryVerification
    && lane.trustClass === 'REPOSITORY_ATTESTATION'));
  assert.ok(dbLanes.filter((lane) => lane.requiresCurrentThreatModel)
    .every((lane) => lane.principalType === 'OWNER' && lane.trustClass === 'OWNER_DECISION'));
  evidence.invariants.authorityMatrixComplete = true;
  evidence.invariants.agentObservationClaimOnly = true;
  evidence.authority = {
    declaredFactKinds: declared.length,
    databaseLanes: dbLanes.length,
    uncoveredFactKinds: declared.filter((kind) => !covered.includes(kind)),
  };
});

test('PostgreSQL canonical JSON matches the frozen RFC8785 digest across numeric thresholds', async () => {
  const samples = [
    '1.0',
    '1.2300',
    '1e30',
    '1e21',
    '1e20',
    '1e-7',
    '1e-6',
    '333333333.33333329',
    '-0',
    '{"z":1e-7,"a":[1.2300,1e20],"text":"café"}',
  ];
  for (const source of samples) {
    const value = JSON.parse(source);
    const result = await pool.query(
      'SELECT outcome_canonical_json($1::jsonb) AS canonical, outcome_sha256_json($1::jsonb) AS digest',
      [source],
    );
    assert.equal(result.rows[0].canonical, canonicalJson(value), `canonical bytes differ for ${source}`);
    assert.equal(result.rows[0].digest, sha256Canonical(value), `canonical digest differs for ${source}`);
  }
  evidence.invariants.rfc8785NumericCanonicalization = true;
});

test('canonical facts and sealed cuts are immutable while the physically separate projection is disposable', async () => {
  const scope = await setupLane();
  const client = await pool.connect();
  try {
    const payload = { status: 'DONE', observation: 'agent-reported only' };
    const fact = await append(client, scope, makeDraft(scope, payload, 'append-only-1'));
    validateCanonicalFact(fact, contract);
    assert.match(fact.factId, /^[0-9a-f-]{36}$/);
    assert.equal(fact.logicalTime, '1');
    assert.ok(Date.parse(fact.recordedAt));
    evidence.invariants.canonicalEnvelopeComplete = true;
    evidence.invariants.serverAllocatedEnvelopeFields = true;

    await assert.rejects(
      client.query('UPDATE outcome_canonical_fact SET payload = $1::jsonb WHERE fact_id = $2::uuid', [
        JSON.stringify({ tampered: true }), fact.factId,
      ]),
      /OUTCOME_APPEND_ONLY_VIOLATION:outcome_canonical_fact/,
    );
    evidence.invariants.appendOnlyUpdateRefused = true;
    await assert.rejects(
      client.query('DELETE FROM outcome_canonical_fact WHERE fact_id = $1::uuid', [fact.factId]),
      /OUTCOME_APPEND_ONLY_VIOLATION:outcome_canonical_fact/,
    );
    evidence.invariants.appendOnlyDeleteRefused = true;

    const cut = await seal(client, scope, 'append-only-cut');
    validateFactCut(cut, [fact], contract);
    await assert.rejects(
      client.query('UPDATE outcome_evaluation_cut SET fact_count = 0 WHERE cut_id = $1::uuid', [cut.cutId]),
      /OUTCOME_APPEND_ONLY_VIOLATION:outcome_evaluation_cut/,
    );
    evidence.invariants.sealedCutImmutable = true;
    await publish(client, scope, cut, { summary: 'writable cache', factSetDigest: 'not-authority' }, false);
    await client.query(`
      UPDATE outcome_evaluation_projection
         SET projection = '{"corrupted":true}'::jsonb
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
    `, [scope.tenantId, scope.projectId]);
    const stale = await client.query(`
      SELECT is_current, effective_closed FROM outcome_current_evaluation_projection
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
    `, [scope.tenantId, scope.projectId]);
    assert.deepEqual(stale.rows[0], { is_current: false, effective_closed: false });
    const replayBeforeDelete = await client.query(
      'SELECT outcome_replay_fact_set_digest($1::uuid, $2::uuid) AS digest',
      [scope.tenantId, cut.cutId],
    );
    assert.equal(replayBeforeDelete.rows[0].digest, cut.factSetDigest);
    await client.query(`
      DELETE FROM outcome_evaluation_projection
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
    `, [scope.tenantId, scope.projectId]);
    const replayAfterDelete = await client.query(
      'SELECT outcome_replay_fact_set_digest($1::uuid, $2::uuid) AS digest',
      [scope.tenantId, cut.cutId],
    );
    assert.equal(replayAfterDelete.rows[0].digest, cut.factSetDigest);
    evidence.invariants.factsAndProjectionPhysicallySeparated = true;
    evidence.invariants.projectionCannotChangeReplay = true;
  } finally {
    client.release();
  }
});

test('concurrent and replayed idempotency keys allocate one fact and collisions fail closed', async () => {
  const scope = await setupLane();
  const draft = makeDraft(scope, { status: 'IN_PROGRESS', observation: 'same bytes' }, 'concurrent-key');
  const facts = await Promise.all(Array.from({ length: 12 }, async () => {
    const client = await pool.connect();
    try { return await append(client, scope, draft); } finally { client.release(); }
  }));
  assert.equal(new Set(facts.map((fact) => fact.factId)).size, 1);
  assert.equal(new Set(facts.map((fact) => fact.logicalTime)).size, 1);
  const count = await pool.query(`
    SELECT count(*)::int AS n, bool_and(NOT proof_eligible) AS claim_only
      FROM outcome_canonical_fact
     WHERE tenant_id = $1::uuid AND project_id = $2::uuid
  `, [scope.tenantId, scope.projectId]);
  assert.deepEqual(count.rows[0], { n: 1, claim_only: true });
  evidence.races.concurrentIdempotencySingleFact = true;

  const changedPayload = { status: 'DONE', observation: 'different bytes' };
  const collision = makeDraft(scope, changedPayload, 'concurrent-key');
  await assert.rejects(append(pool, scope, collision), /OUTCOME_FACT_IDEMPOTENCY_KEY_REUSED/);
  evidence.races.idempotencyCollisionRefused = true;
});

test('tenant scope is authenticated independently of every caller-supplied tenant field', async () => {
  const scope = await setupLane();
  const otherTenant = randomUUID();
  const draft = makeDraft(scope, { status: 'OPEN' }, 'cross-tenant');
  await assert.rejects(
    append(pool, scope, draft, { tenantId: otherTenant }),
    /OUTCOME_FACT_TENANT_MISMATCH/,
  );
  const cut = await seal(pool, scope, 'tenant-cut');
  const foreignRead = await pool.query(
    'SELECT * FROM outcome_read_evaluation_cut($1::uuid, $2::uuid, false)',
    [otherTenant, cut.cutId],
  );
  assert.equal(foreignRead.rowCount, 0);
  evidence.attacks.crossTenantRefused = true;
});

test('a replaced binding rejects late facts and immediately makes its old closed projection ineffective', async () => {
  const scope = await setupLane();
  const firstDraft = makeDraft(scope, { status: 'DONE' }, 'binding-first');
  const first = await append(pool, scope, firstDraft);
  const cut = await seal(pool, scope, 'binding-cut');
  await publish(pool, scope, cut, { proofFactId: first.factId }, true);
  const before = await pool.query(`
    SELECT is_current, effective_closed FROM outcome_current_evaluation_projection
     WHERE tenant_id = $1::uuid AND project_id = $2::uuid
  `, [scope.tenantId, scope.projectId]);
  assert.deepEqual(before.rows[0], { is_current: true, effective_closed: true });

  const replacement = { ...scope.binding, environmentDigest: digest(`replacement:${scope.subjectId}`) };
  await registerBinding(pool, scope.tenantId, scope.projectId, replacement);
  const idempotentReplay = await append(pool, scope, firstDraft);
  assert.equal(idempotentReplay.factId, first.factId, 'an exact replay remains readable after binding expiry');
  await assert.rejects(
    append(pool, scope, makeDraft(scope, { status: 'DONE' }, 'binding-late')),
    /OUTCOME_FACT_BINDING_STALE/,
  );
  const after = await pool.query(`
    SELECT is_current, effective_closed FROM outcome_current_evaluation_projection
     WHERE tenant_id = $1::uuid AND project_id = $2::uuid
  `, [scope.tenantId, scope.projectId]);
  assert.deepEqual(after.rows[0], { is_current: false, effective_closed: false });
  evidence.attacks.staleBindingRefused = true;
});

test('forged principal, authority, source and payload bytes are all refused before append', async () => {
  const scope = await setupLane();
  const base = makeDraft(scope, { status: 'OPEN', detail: 'auth attacks' }, 'attack-base');
  await assert.rejects(
    append(pool, scope, base, { principalId: randomUUID() }),
    /OUTCOME_FACT_PRINCIPAL_FORGED/,
  );
  evidence.attacks.forgedPrincipalRefused = true;
  await assert.rejects(
    append(pool, scope, { ...base, idempotencyKey: 'attack-authority', authority: {
      ...base.authority, grantDigest: digest('forged-grant'),
    } }),
    /OUTCOME_FACT_AUTHORITY_FORGED/,
  );
  evidence.attacks.forgedAuthorityRefused = true;
  await assert.rejects(
    append(pool, scope, { ...base, idempotencyKey: 'attack-source', source: {
      ...base.source, collectorId: 'forged-collector',
    } }),
    /OUTCOME_FACT_SOURCE_FORGED/,
  );
  evidence.attacks.forgedSourceRefused = true;
  await assert.rejects(
    append(pool, scope, { ...base, idempotencyKey: 'attack-payload', payload: { status: 'DONE' } }),
    /OUTCOME_FACT_PAYLOAD_DIGEST_MISMATCH/,
  );
  evidence.attacks.payloadTamperingRefused = true;
  const count = await pool.query(`
    SELECT count(*)::int AS n FROM outcome_canonical_fact
     WHERE tenant_id = $1::uuid AND project_id = $2::uuid
  `, [scope.tenantId, scope.projectId]);
  assert.equal(count.rows[0].n, 0);
});

test('runner exits, merge receipts and owner decisions satisfy their distinct authority requirements', async () => {
  const runner = await setupLane({
    factKind: 'ATTEMPT_TERMINATED', claimType: 'ATTESTATION',
    principalType: 'RUNNER', sourceSystem: 'CONTROLLED_RUNNER',
  });
  const runnerPayload = {
    exitCode: 0,
    commandDigest: digest('npm-test-command'),
    executionReceiptDigest: digest('controlled-runner-receipt'),
  };
  const runnerFact = await append(pool, runner, makeDraft(runner, runnerPayload, 'runner-exit'));
  assert.equal(runnerFact.payload.exitCode, 0);
  const runnerStored = await pool.query(
    'SELECT trust_class, proof_eligible FROM outcome_canonical_fact WHERE fact_id = $1::uuid',
    [runnerFact.factId],
  );
  assert.deepEqual(runnerStored.rows[0], { trust_class: 'MECHANICAL_FACT', proof_eligible: true });
  await assert.rejects(
    append(pool, runner, makeDraft(runner, { exitCode: 0 }, 'runner-forged-exit')),
    /OUTCOME_RUNNER_EXIT_RECEIPT_INVALID/,
  );
  evidence.invariants.controlledRunnerExitMechanical = true;
  await pool.query(
    'SELECT outcome_revoke_authority_grant($1::uuid, $2::uuid, $3::uuid, $4)',
    [runner.tenantId, runner.projectId, runner.grantId, digest('runner-grant-revoked')],
  );
  const revokedCut = await seal(pool, runner, 'runner-revoked-cut');
  const revokedFacts = await pool.query(
    'SELECT trust_decision, proof_eligible FROM outcome_read_evaluation_cut($1::uuid, $2::uuid, false)',
    [runner.tenantId, revokedCut.cutId],
  );
  assert.deepEqual(revokedFacts.rows, [{ trust_decision: 'REVOKED', proof_eligible: false }]);
  evidence.invariants.authorityRevocationFailsClosed = true;

  const merge = await setupLane({
    factKind: 'MERGE_RECEIPT_RECORDED', claimType: 'RECEIPT',
    principalType: 'SYSTEM', sourceSystem: 'TARGET_REPOSITORY_VERIFIER',
  });
  const mergePayload = {
    targetRepositoryDigest: merge.binding.targetDigest,
    targetRef: merge.binding.targetRef,
    targetPresenceVerified: true,
    verificationReceiptDigest: digest('target-repository-readback'),
  };
  await append(pool, merge, makeDraft(merge, mergePayload, 'merge-receipt'));
  await assert.rejects(
    append(pool, merge, makeDraft(merge, {
      ...mergePayload, targetRepositoryDigest: digest('different-repository'),
    }, 'merge-forged-target')),
    /OUTCOME_MERGE_TARGET_NOT_REVERIFIED/,
  );
  evidence.invariants.mergeReceiptTargetReverified = true;

  const owner = await setupLane({
    factKind: 'GOAL_RATIFIED', claimType: 'DECISION',
    principalType: 'OWNER', sourceSystem: 'OWNER_DECISION',
  });
  const ownerPayload = {
    decision: 'RATIFIED',
    riskPolicyDigest: owner.binding.riskPolicyDigest,
    threatModelDigest: owner.binding.riskPolicyDigest,
  };
  await append(pool, owner, makeDraft(owner, ownerPayload, 'owner-decision'));
  const newerRisk = digest(`new-threat-model:${owner.subjectId}`);
  const newerBinding = { ...owner.binding, riskPolicyDigest: newerRisk };
  const registered = await registerBinding(pool, owner.tenantId, owner.projectId, newerBinding);
  const staleOwnerScope = { ...owner, binding: newerBinding, bindingDigest: registered.bindingDigest };
  await assert.rejects(
    append(pool, staleOwnerScope, makeDraft(staleOwnerScope, {
      decision: 'RATIFIED', riskPolicyDigest: newerRisk, threatModelDigest: newerRisk,
    }, 'owner-stale-threat')),
    /OUTCOME_OWNER_DECISION_THREAT_MODEL_STALE/,
  );
  evidence.invariants.ownerDecisionThreatModelBound = true;
});

test('append versus seal is linearizable, late work invalidates close, and replay uses canonical facts', async () => {
  const scope = await setupLane();
  const baseline = await append(pool, scope, makeDraft(scope, { status: 'OPEN' }, 'race-baseline'));
  const sealer = new Client({ connectionString: URL });
  const appender = new Client({ connectionString: URL });
  await sealer.connect();
  await appender.connect();
  try {
    await sealer.query('BEGIN');
    const cut = await seal(sealer, scope, 'race-cut-before');
    let appendSettled = false;
    const latePromise = append(
      appender,
      scope,
      makeDraft(scope, { status: 'IN_PROGRESS' }, 'race-late'),
    ).finally(() => { appendSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(appendSettled, false, 'append must wait behind the cut stream lock');
    await sealer.query('COMMIT');
    const late = await latePromise;
    assert.deepEqual(cut.factIds, [baseline.factId]);
    assert.equal(BigInt(late.logicalTime), BigInt(cut.watermarkLogicalTime) + 1n);
    evidence.races.cutBeforeAppendExcludesLateFact = true;
    evidence.invariants.cutLinearizable = true;

    await assert.rejects(
      publish(pool, scope, cut, { closed: true }, true),
      /OUTCOME_EVALUATION_CUT_STALE/,
    );
    evidence.races.staleCutCannotPublish = true;
    const replay = await pool.query(
      'SELECT outcome_replay_fact_set_digest($1::uuid, $2::uuid) AS digest',
      [scope.tenantId, cut.cutId],
    );
    assert.equal(replay.rows[0].digest, cut.factSetDigest);
    assert.equal(sha256Canonical([baseline]), cut.factSetDigest);
    evidence.replay.digestMatchesSealedCut = true;
    evidence.replay.digestMatchesJavascriptCanonicalReplay = true;

    const proofRows = await pool.query(
      'SELECT * FROM outcome_read_evaluation_cut($1::uuid, $2::uuid, true)',
      [scope.tenantId, cut.cutId],
    );
    assert.equal(proofRows.rowCount, 0, 'agent observations remain claims, never proof inputs');
    evidence.replay.proofReadExcludesClaims = true;

    const currentCut = await seal(pool, scope, 'race-cut-current');
    assert.deepEqual(currentCut.factIds, [baseline, late]
      .sort((a, b) => BigInt(a.logicalTime) < BigInt(b.logicalTime) ? -1 : 1)
      .map((fact) => fact.factId));
    validateFactCut(currentCut, [baseline, late], contract);
    await publish(pool, scope, currentCut, { proofDigest: digest('reducer-output') }, true);
    const beforeLate = await pool.query(`
      SELECT effective_closed FROM outcome_current_evaluation_projection
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
    `, [scope.tenantId, scope.projectId]);
    assert.equal(beforeLate.rows[0].effective_closed, true);
    const thirdDraft = makeDraft(scope, { status: 'DONE' }, 'race-after-projection', {
      causalPredecessorFactId: late.factId,
    });
    const third = await append(pool, scope, thirdDraft);
    assert.equal(third.causalPredecessorFactId, late.factId);
    evidence.invariants.causalPredecessorScoped = true;
    const afterLate = await pool.query(`
      SELECT is_current, effective_closed FROM outcome_current_evaluation_projection
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
    `, [scope.tenantId, scope.projectId]);
    assert.deepEqual(afterLate.rows[0], { is_current: false, effective_closed: false });
    evidence.races.factAfterProjectionInvalidatesClose = true;
    evidence.samples = {
      firstCutId: cut.cutId,
      firstWatermark: cut.watermarkLogicalTime,
      firstFactSetDigest: cut.factSetDigest,
      lateFactLogicalTime: late.logicalTime,
      currentCutId: currentCut.cutId,
      currentFactSetDigest: currentCut.factSetDigest,
    };
  } catch (error) {
    await sealer.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await sealer.end();
    await appender.end();
  }
});
