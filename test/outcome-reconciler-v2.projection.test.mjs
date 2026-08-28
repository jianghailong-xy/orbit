import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const MODULE_PATH = process.env.OUTCOME_PROJECTION_EVALUATOR_MODULE;
const URL = process.env.OUTCOME_PROJECTION_PG_URL;
const EXPECTED_DATABASE = process.env.OUTCOME_PROJECTION_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OUTCOME_PROJECTION_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER = process.env.OUTCOME_PROJECTION_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OUTCOME_PROJECTION_EVIDENCE_PATH;

assert.ok(MODULE_PATH, 'OUTCOME_PROJECTION_EVALUATOR_MODULE is required');
assert.ok(URL, 'OUTCOME_PROJECTION_PG_URL is required; PostgreSQL absence is a hard failure');
assert.ok(EXPECTED_DATABASE, 'OUTCOME_PROJECTION_PG_EXPECTED_DATABASE is required');
assert.ok(EXPECTED_USER, 'OUTCOME_PROJECTION_PG_EXPECTED_USER is required');
assert.ok(EXPECTED_SYSTEM_IDENTIFIER, 'OUTCOME_PROJECTION_PG_EXPECTED_SYSTEM_IDENTIFIER is required');
assert.ok(EVIDENCE_PATH, 'OUTCOME_PROJECTION_EVIDENCE_PATH is required');

const {
  OUTCOME_DIMENSIONS,
  evaluateCanonicalOutcome,
  outcomeDigest,
  outcomeEvaluatorDigest,
} = await import(pathToFileURL(path.resolve(MODULE_PATH)).href);

const pool = new Pool({ connectionString: URL, max: 16 });
const SURFACES = [
  'DONE_GATE', 'AGENT_QUEUE', 'OWNER_DECISION_INBOX',
  'PROJECT_ATTENTION', 'MUTATION_RESPONSE', 'WEB',
];
const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-projection',
  postgres: { required: true, connected: false, version: null, systemIdentifier: null },
  invariants: {
    physicallySeparated: false,
    reducerOnlyWriter: false,
    bindingStampComplete: false,
    transactionalOutbox: false,
    noOutboxLoss: false,
    unifiedSemanticIdentity: false,
    fullRebuildExact: false,
    proofAndRowsetChecksumsExact: false,
    incrementalEqualsFull: false,
    shadowDetectsAndRepairs: false,
    schemaEvaluatorUpgradeReplayable: false,
    boundedTargetIndex: false,
    staleOnEverySurface: false,
    staleNeverLooksLikeEmptyWork: false,
  },
  samples: {},
};

after(async () => {
  await pool.end();
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
});

function digest(label) {
  return createHash('sha256').update(label).digest('hex');
}

function makeBinding(scope, version = 'outcome-reducer-v2', overrides = {}) {
  return {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    subjectType: 'PROJECT',
    subjectId: scope.subjectId,
    goalId: `goal:${scope.subjectId}`,
    goalRevision: '1',
    contractDigest: digest(`contract:${scope.subjectId}:${version}`),
    evaluationPlanDigest: digest(`criteria:${scope.subjectId}:${version}`),
    policyDigest: digest(`policy:${scope.subjectId}:${version}`),
    riskPolicyDigest: scope.riskDigest,
    permissionDigest: digest(`permission:${scope.subjectId}:${version}`),
    authorityGrantDigest: scope.authority.grantDigest,
    budgetDigest: digest(`budget:${scope.subjectId}:${version}`),
    capabilityRegistryDigest: digest(`registry:${scope.subjectId}:${version}`),
    recipientDigest: digest(`recipient:${scope.subjectId}:${version}`),
    evaluatorDigest: outcomeEvaluatorDigest(version),
    factSchemaDigest: digest(`fact-schema:${version}`),
    environmentDigest: digest(`environment:${scope.subjectId}:${version}`),
    artifactDigest: digest(`artifact:${scope.subjectId}:${version}`),
    targetDigest: digest(`target:${scope.subjectId}:${version}`),
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '0',
    factCutDigest: digest(`prospective-cut:${scope.subjectId}:${version}`),
    ...overrides,
  };
}

function makeGoal(binding, overrides = {}) {
  return {
    goalId: binding.goalId,
    goalRevision: binding.goalRevision,
    tenantId: binding.tenantId,
    projectId: binding.projectId,
    statement: 'Reach the exact ratified projection fixture outcome.',
    contractDigest: binding.contractDigest,
    evaluationPlanDigest: binding.evaluationPlanDigest,
    ratification: {
      status: 'RATIFIED',
      ratifierType: 'OWNER',
      ratifierId: 'owner-projection-fixture',
      contractDigest: binding.contractDigest,
      factId: randomUUID(),
    },
    disposition: 'ACHIEVED',
    ...overrides,
  };
}

async function registerGrant(client, scope) {
  const result = await client.query({
    text: `SELECT outcome_register_authority_grant(
      $1::uuid, $2::uuid, $3::uuid, 'SYSTEM', $4, 'DIMENSION_EVALUATED',
      'ATTESTATION', 'OUTCOME_EVALUATOR', $5, 'projection-test-v1', NULL,
      1::bigint, NULL::bigint, $6
    ) AS authority`,
    values: [
      scope.tenantId, scope.projectId, scope.grantId, scope.principalId,
      scope.collectorId, scope.riskDigest,
    ],
  });
  return result.rows[0].authority;
}

async function registerBinding(client, scope, binding) {
  const result = await client.query({
    text: 'SELECT outcome_register_fact_binding($1::uuid, $2::uuid, $3::jsonb) AS registered',
    values: [scope.tenantId, scope.projectId, JSON.stringify(binding)],
  });
  scope.binding = binding;
  scope.bindingDigest = result.rows[0].registered.bindingDigest;
  scope.evaluatorVersion = binding.evaluatorDigest === outcomeEvaluatorDigest('outcome-reducer-v2')
    ? 'outcome-reducer-v2'
    : scope.evaluatorVersion;
  return result.rows[0].registered;
}

async function setupScope(label, version = 'outcome-reducer-v2') {
  const scope = {
    label,
    tenantId: randomUUID(),
    projectId: randomUUID(),
    subjectId: randomUUID(),
    grantId: randomUUID(),
    principalId: randomUUID(),
    collectorId: `projection-${randomUUID()}`,
    riskDigest: digest(`risk:${label}`),
    evaluatorVersion: version,
  };
  scope.subjectId = scope.projectId;
  scope.authority = await registerGrant(pool, scope);
  await registerBinding(pool, scope, makeBinding(scope, version));
  return scope;
}

async function appendDimension(client, scope, dimensionId, state, key) {
  const payload = {
    dimensionId,
    state,
    applicabilityProofDigest: state === 'NOT_APPLICABLE' ? digest(`na:${key}`) : null,
    reasonCode: `${key}_${state}`.toUpperCase().replaceAll(/[^A-Z0-9_]/g, '_'),
  };
  const draft = {
    factKind: 'DIMENSION_EVALUATED',
    tenantId: scope.tenantId,
    subject: { type: 'PROJECT', id: scope.subjectId, projectId: scope.projectId },
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
      system: 'OUTCOME_EVALUATOR',
      collectorId: scope.collectorId,
      collectorVersion: 'projection-test-v1',
    },
    signature: null,
  };
  const result = await client.query({
    text: 'SELECT outcome_ingest_canonical_fact($1::uuid, $2, $3, $4::jsonb) AS envelope',
    values: [scope.tenantId, 'SYSTEM', scope.principalId, JSON.stringify(draft)],
  });
  return result.rows[0].envelope;
}

async function appendDimensions(scope, prefix, overrides = {}, client = pool) {
  const facts = [];
  for (const declaration of OUTCOME_DIMENSIONS) {
    facts.push(await appendDimension(
      client,
      scope,
      declaration.id,
      overrides[declaration.id] ?? 'SATISFIED',
      `${prefix}:${declaration.id}`,
    ));
  }
  return facts;
}

async function sealCut(client, scope, key) {
  const result = await client.query({
    text: 'SELECT outcome_seal_evaluation_cut($1::uuid, $2::uuid, $3, $4, $5) AS cut',
    values: [scope.tenantId, scope.projectId, scope.bindingDigest, key, 'projection-test-v1'],
  });
  return result.rows[0].cut;
}

async function evaluateCut(client, scope, cut, goalOverrides = {}) {
  const facts = await client.query({
    text: `SELECT cf.trust_decision AS "trustDecision",
                  cf.proof_eligible AS "proofEligible", f.envelope
             FROM outcome_evaluation_cut_fact cf
             JOIN outcome_canonical_fact f
               ON f.tenant_id = cf.tenant_id AND f.project_id = cf.project_id
              AND f.fact_id = cf.fact_id
            WHERE cf.tenant_id = $1::uuid AND cf.project_id = $2::uuid
              AND cf.cut_id = $3::uuid
            ORDER BY cf.ordinal`,
    values: [scope.tenantId, scope.projectId, cut.cutId],
  });
  return evaluateCanonicalOutcome({
    binding: scope.binding,
    goal: makeGoal(scope.binding, goalOverrides),
    factCut: cut,
    facts: facts.rows,
    clock: {
      logicalNow: cut.watermarkLogicalTime,
      clockId: 'projection-logical-clock',
      evaluatedThroughLogicalTime: cut.watermarkLogicalTime,
    },
    evaluatorVersion: scope.evaluatorVersion,
  });
}

async function commitEvaluation(client, scope, cut, evaluation) {
  const result = await client.query({
    text: `SELECT outcome_commit_evaluation(
      $1::uuid, $2::uuid, 'PROJECT', $3, $4::uuid, $5, $6::bigint, $7, $8, $9::jsonb
    ) AS committed`,
    values: [
      scope.tenantId, scope.projectId, scope.subjectId, cut.cutId, scope.bindingDigest,
      cut.watermarkLogicalTime, evaluation.evaluatorVersion, evaluation.evaluatorDigest,
      JSON.stringify(evaluation),
    ],
  });
  return result.rows[0].committed;
}

async function createEvaluation(scope, prefix, overrides = {}, client = pool) {
  await appendDimensions(scope, prefix, overrides, client);
  const cut = await sealCut(client, scope, `${prefix}:cut`);
  const evaluation = await evaluateCut(client, scope, cut);
  return { cut, evaluation };
}

async function projectionSnapshot() {
  const tables = ['reconciler_state', 'obligation', 'proof', 'done_gate', 'read_model'];
  const result = {};
  for (const table of tables) {
    const rows = await pool.query(`
      SELECT to_jsonb(row_value) - 'written_at' - 'rebuild_id' AS value
        FROM outcome_projection.${table} row_value
       ORDER BY tenant_id, project_id, subject_type, subject_id,
                COALESCE(to_jsonb(row_value)->>'surface', ''),
                COALESCE(to_jsonb(row_value)->>'obligation_id', '')
    `);
    result[table] = rows.rows.map((row) => row.value);
  }
  return result;
}

async function readSurface(scope, surface) {
  const result = await pool.query({
    text: `SELECT outcome_projection.read_surface(
      $1::uuid, $2::uuid, 'PROJECT', $3, $4
    ) AS projection`,
    values: [scope.tenantId, scope.projectId, scope.subjectId, surface],
  });
  return result.rows[0].projection;
}

let openScope;
let closedScope;

test('requires isolated PostgreSQL and a physically separate disposable schema', async () => {
  const result = await pool.query(`
    SELECT current_database() AS database,
           current_user AS role,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
           current_setting('server_version') AS version,
           to_regnamespace('outcome_projection') IS NOT NULL AS projection_schema,
           to_regclass('outcome_projection.obligation') IS NOT NULL AS obligation_table,
           to_regclass('public.outcome_canonical_fact') IS NOT NULL AS canonical_table
  `);
  const identity = result.rows[0];
  assert.equal(identity.database, EXPECTED_DATABASE);
  assert.equal(identity.role, EXPECTED_USER);
  assert.equal(identity.system_identifier, EXPECTED_SYSTEM_IDENTIFIER);
  assert.match(identity.database, /^pcprojection_/);
  assert.equal(identity.projection_schema, true);
  assert.equal(identity.obligation_table, true);
  assert.equal(identity.canonical_table, true);
  const reverseDependencies = await pool.query(`
    SELECT count(*)::int AS n
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = c.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
     WHERE c.contype = 'f'
       AND child_ns.nspname = 'public'
       AND child.relname LIKE 'outcome_%'
       AND parent_ns.nspname = 'outcome_projection'
  `);
  assert.equal(reverseDependencies.rows[0].n, 0, 'canonical ledgers must not depend on projection');
  evidence.postgres.connected = true;
  evidence.postgres.version = identity.version;
  evidence.postgres.systemIdentifier = identity.system_identifier;
  evidence.invariants.physicallySeparated = true;
});

test('evaluator commit atomically materializes every binding stamp and one outbox event', async () => {
  openScope = await setupScope('open-projection');
  const { cut, evaluation } = await createEvaluation(openScope, 'open-v1', {
    CRITERIA_EVALUATION: 'UNSATISFIED',
  });
  assert.equal(evaluation.closed, false);
  assert.ok(evaluation.activeMandatoryObligations.length > 0);
  const committed = await commitEvaluation(pool, openScope, cut, evaluation);

  const counts = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM outcome_projection.reconciler_state
        WHERE source_evaluation_id = $1::uuid) AS states,
      (SELECT count(*)::int FROM outcome_projection.proof
        WHERE tenant_id = $2::uuid AND project_id = $3::uuid) AS proofs,
      (SELECT count(*)::int FROM outcome_projection.done_gate
        WHERE tenant_id = $2::uuid AND project_id = $3::uuid) AS gates,
      (SELECT count(*)::int FROM outcome_projection.read_model
        WHERE tenant_id = $2::uuid AND project_id = $3::uuid) AS reads,
      (SELECT count(*)::int FROM outcome_projection.outbox
        WHERE source_evaluation_id = $1::uuid AND event_type = 'INCREMENTAL') AS events
  `, [committed.evaluationId, openScope.tenantId, openScope.projectId]);
  assert.deepEqual(counts.rows[0], { states: 1, proofs: 1, gates: 1, reads: 6, events: 1 });

  const bindingChecks = await pool.query(`
    WITH rows AS (
      SELECT binding, binding_digest::text, contract_digest::text, criteria_digest::text,
             artifact_digest::text, target_digest::text, policy_digest::text,
             registry_digest::text, evaluator_digest::text, fact_schema_digest::text,
             environment_digest::text, as_of_logical_time
        FROM outcome_projection.reconciler_state
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
      UNION ALL
      SELECT binding, binding_digest::text, contract_digest::text, criteria_digest::text,
             artifact_digest::text, target_digest::text, policy_digest::text,
             registry_digest::text, evaluator_digest::text, fact_schema_digest::text,
             environment_digest::text, as_of_logical_time
        FROM outcome_projection.obligation
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
      UNION ALL
      SELECT binding, binding_digest::text, contract_digest::text, criteria_digest::text,
             artifact_digest::text, target_digest::text, policy_digest::text,
             registry_digest::text, evaluator_digest::text, fact_schema_digest::text,
             environment_digest::text, as_of_logical_time
        FROM outcome_projection.proof
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
      UNION ALL
      SELECT binding, binding_digest::text, contract_digest::text, criteria_digest::text,
             artifact_digest::text, target_digest::text, policy_digest::text,
             registry_digest::text, evaluator_digest::text, fact_schema_digest::text,
             environment_digest::text, as_of_logical_time
        FROM outcome_projection.done_gate
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
      UNION ALL
      SELECT binding, binding_digest::text, contract_digest::text, criteria_digest::text,
             artifact_digest::text, target_digest::text, policy_digest::text,
             registry_digest::text, evaluator_digest::text, fact_schema_digest::text,
             environment_digest::text, as_of_logical_time
        FROM outcome_projection.read_model
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
      UNION ALL
      SELECT binding, binding_digest::text, contract_digest::text, criteria_digest::text,
             artifact_digest::text, target_digest::text, policy_digest::text,
             registry_digest::text, evaluator_digest::text, fact_schema_digest::text,
             environment_digest::text, as_of_logical_time
        FROM outcome_projection.outbox
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
    )
    SELECT count(*)::int AS rows,
           bool_and(outcome_projection.binding_stamp_valid(
             binding, binding_digest, contract_digest, criteria_digest, artifact_digest,
             target_digest, policy_digest, registry_digest, evaluator_digest,
             fact_schema_digest, environment_digest, as_of_logical_time
           )) AS valid
      FROM rows
  `, [openScope.tenantId, openScope.projectId]);
  assert.ok(bindingChecks.rows[0].rows >= 10);
  assert.equal(bindingChecks.rows[0].valid, true);
  evidence.invariants.bindingStampComplete = true;
  evidence.invariants.transactionalOutbox = true;
  evidence.samples.openEvaluationId = committed.evaluationId;
  evidence.samples.openProjectionChecksum = (await pool.query(`SELECT projection_checksum::text AS checksum
    FROM outcome_projection.reconciler_state WHERE source_evaluation_id = $1::uuid`,
  [committed.evaluationId])).rows[0].checksum;
});

test('direct writers are rejected even when they know the reducer GUC', async () => {
  await assert.rejects(
    pool.query(`UPDATE outcome_projection.reconciler_state
                  SET written_at = written_at
                WHERE tenant_id = $1::uuid AND project_id = $2::uuid`,
    [openScope.tenantId, openScope.projectId]),
    /OUTCOME_PROJECTION_REDUCER_ONLY/,
  );

  const role = `projection_intruder_${process.pid}`;
  const password = `projection-test-${randomUUID()}`;
  await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
  await pool.query(`GRANT USAGE ON SCHEMA outcome_projection TO ${role}`);
  const intruderUrl = new globalThis.URL(URL);
  intruderUrl.username = role;
  intruderUrl.password = password;
  const intruder = new Client({ connectionString: intruderUrl.toString() });
  await intruder.connect();
  try {
    await intruder.query(`SET outcome_projection.reducer_write = 'on'`);
    await assert.rejects(
      intruder.query(`UPDATE outcome_projection.reconciler_state SET written_at = written_at`),
      /permission denied for table reconciler_state/,
    );
  } finally {
    await intruder.end();
  }
  evidence.invariants.reducerOnlyWriter = true;
});

test('rollback removes evaluator output, every projection row, and its transactional outbox', async () => {
  const scope = await setupScope('rollback-projection');
  const { cut, evaluation } = await createEvaluation(scope, 'rollback-v1', {
    TARGET_PRESENCE: 'UNSATISFIED',
  });
  const client = new Client({ connectionString: URL });
  await client.connect();
  let evaluationId;
  try {
    await client.query('BEGIN');
    const committed = await commitEvaluation(client, scope, cut, evaluation);
    evaluationId = committed.evaluationId;
    const inside = await client.query(`
      SELECT
        (SELECT count(*)::int FROM outcome_evaluator_result WHERE evaluation_id = $1::uuid) AS source,
        (SELECT count(*)::int FROM outcome_projection.reconciler_state
          WHERE source_evaluation_id = $1::uuid) AS projection,
        (SELECT count(*)::int FROM outcome_projection.outbox
          WHERE source_evaluation_id = $1::uuid) AS outbox
    `, [evaluationId]);
    assert.deepEqual(inside.rows[0], { source: 1, projection: 1, outbox: 1 });
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
  const outside = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM outcome_evaluator_result WHERE evaluation_id = $1::uuid) AS source,
      (SELECT count(*)::int FROM outcome_projection.reconciler_state
        WHERE source_evaluation_id = $1::uuid) AS projection,
      (SELECT count(*)::int FROM outcome_projection.outbox
        WHERE source_evaluation_id = $1::uuid) AS outbox
  `, [evaluationId]);
  assert.deepEqual(outside.rows[0], { source: 0, projection: 0, outbox: 0 });
  evidence.invariants.transactionalOutbox = true;
});

test('all six current surfaces carry one canonical semantic identity', async () => {
  const projections = await Promise.all(SURFACES.map((surface) => readSurface(openScope, surface)));
  for (const [index, projection] of projections.entries()) {
    assert.equal(projection.surface, SURFACES[index]);
    assert.equal(projection.staleness, 'CURRENT');
    assert.ok(Array.isArray(projection.obligations));
    assert.ok(projection.obligations.length > 0);
    for (const obligation of projection.obligations) {
      assert.equal(obligation.bindingDigest, projection.canonicalIdentity.bindingDigest);
      assert.equal(
        obligation.evaluatedThroughLogicalTime,
        projection.canonicalIdentity.evaluatedThroughLogicalTime,
      );
      assert.equal(obligation.projectionRevision, projection.canonicalIdentity.projectionRevision);
      assert.equal(obligation.staleness, 'CURRENT');
    }
  }
  const semantic = projections.map((projection) => ({
    canonicalIdentity: projection.canonicalIdentity,
    doneGate: projection.doneGate,
    obligations: projection.obligations,
  }));
  assert.ok(semantic.every((entry) => JSON.stringify(entry) === JSON.stringify(semantic[0])));
  evidence.invariants.unifiedSemanticIdentity = true;
});

test('full truncate/rebuild exactly reproduces incremental rows, proof and checksums', async () => {
  closedScope = await setupScope('closed-projection');
  const { cut, evaluation } = await createEvaluation(closedScope, 'closed-v1');
  assert.equal(evaluation.closed, true);
  await commitEvaluation(pool, closedScope, cut, evaluation);

  const incremental = await projectionSnapshot();
  const beforeOutbox = Number((await pool.query(
    'SELECT count(*)::bigint AS n FROM outcome_projection.outbox',
  )).rows[0].n);
  const rebuild = await pool.query(`SELECT outcome_projection.full_rebuild(
    1, 'outcome-projection-reducer-v1'
  ) AS receipt`);
  const rebuilt = await projectionSnapshot();
  assert.deepEqual(rebuilt, incremental);
  assert.ok(Number(rebuild.rows[0].receipt.sourceEvaluationCount) >= 2);
  assert.equal(Number(rebuild.rows[0].receipt.projectedSubjectCount), rebuilt.reconciler_state.length);
  const afterOutbox = Number((await pool.query(
    'SELECT count(*)::bigint AS n FROM outcome_projection.outbox',
  )).rows[0].n);
  assert.ok(afterOutbox > beforeOutbox, 'rebuild emits durable events without deleting old outbox');

  const shadow = await pool.query(`SELECT * FROM outcome_projection.shadow_compare()`);
  assert.ok(shadow.rows.length >= 2);
  assert.ok(shadow.rows.every((row) => row.comparison_status === 'MATCH'));
  assert.ok(shadow.rows.every((row) => row.expected_projection_checksum === row.actual_projection_checksum));
  assert.ok(shadow.rows.every((row) => row.expected_proof_checksum === row.actual_proof_checksum));
  const missingOutbox = await pool.query(`
    SELECT count(*)::int AS n
      FROM outcome_evaluator_result e
     WHERE NOT EXISTS (
       SELECT 1 FROM outcome_projection.outbox o WHERE o.source_evaluation_id = e.evaluation_id
     )
  `);
  assert.equal(missingOutbox.rows[0].n, 0);
  evidence.invariants.fullRebuildExact = true;
  evidence.invariants.proofAndRowsetChecksumsExact = true;
  evidence.invariants.incrementalEqualsFull = true;
  evidence.invariants.noOutboxLoss = true;
  evidence.samples.rebuildAggregateChecksum = rebuild.rows[0].receipt.aggregateChecksum;
  evidence.samples.projectedSubjects = rebuild.rows[0].receipt.projectedSubjectCount;
});

test('shadow checksum detects corruption and reducer reconciliation repairs it', async () => {
  const client = new Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL outcome_projection.reducer_write = 'on'`);
    await client.query(`
      UPDATE outcome_projection.proof
         SET proof_graph = jsonb_set(proof_graph, '{root,closed}', 'true'::jsonb)
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid
    `, [openScope.tenantId, openScope.projectId]);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
  const mismatch = await pool.query(`SELECT comparison_status
    FROM outcome_projection.shadow_compare($1::uuid, $2::uuid)`,
  [openScope.tenantId, openScope.projectId]);
  assert.equal(mismatch.rows[0].comparison_status, 'CHECKSUM_MISMATCH');
  await pool.query(`SELECT outcome_projection.reconcile_subject(
    $1::uuid, $2::uuid, 'PROJECT', $3, 1, 'outcome-projection-reducer-v1'
  )`, [openScope.tenantId, openScope.projectId, openScope.subjectId]);
  const repaired = await pool.query(`SELECT comparison_status
    FROM outcome_projection.shadow_compare($1::uuid, $2::uuid)`,
  [openScope.tenantId, openScope.projectId]);
  assert.equal(repaired.rows[0].comparison_status, 'MATCH');
  evidence.invariants.shadowDetectsAndRepairs = true;
});

test('evaluator and projection schema upgrades replay to the exact newest binding', async () => {
  const version = 'outcome-reducer-v3';
  openScope.evaluatorVersion = version;
  await registerBinding(pool, openScope, makeBinding(openScope, version, {
    artifactDigest: digest('upgraded-artifact'),
    targetDigest: digest('upgraded-target'),
  }));
  const { cut, evaluation } = await createEvaluation(openScope, 'open-v3', {
    CRITERIA_EVALUATION: 'UNSATISFIED',
  });
  assert.equal(evaluation.evaluatorVersion, version);
  await commitEvaluation(pool, openScope, cut, evaluation);
  const incremental = await pool.query(`SELECT source_evaluation_id, evaluator_version,
    evaluator_digest::text, binding_digest::text, evaluated_through_logical_time
    FROM outcome_projection.reconciler_state
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid`,
  [openScope.tenantId, openScope.projectId]);
  assert.equal(incremental.rows[0].evaluator_version, version);

  await pool.query(`SELECT outcome_projection.full_rebuild(
    2, 'outcome-projection-reducer-v2'
  )`);
  const upgraded = await pool.query(`SELECT source_evaluation_id, evaluator_version,
    evaluator_digest::text, binding_digest::text, evaluated_through_logical_time,
    projection_schema_version, reducer_version
    FROM outcome_projection.reconciler_state
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid`,
  [openScope.tenantId, openScope.projectId]);
  assert.deepEqual(upgraded.rows[0], {
    ...incremental.rows[0],
    projection_schema_version: 2,
    reducer_version: 'outcome-projection-reducer-v2',
  });
  const shadow = await pool.query(`SELECT comparison_status
    FROM outcome_projection.shadow_compare($1::uuid, $2::uuid)`,
  [openScope.tenantId, openScope.projectId]);
  assert.equal(shadow.rows[0].comparison_status, 'MATCH');
  const web = await readSurface(openScope, 'WEB');
  assert.equal(web.schemaVersion, 2);
  assert.equal(web.canonicalIdentity.evaluatorDigest, outcomeEvaluatorDigest(version));
  evidence.invariants.schemaEvaluatorUpgradeReplayable = true;
  evidence.samples.upgradedEvaluationId = upgraded.rows[0].source_evaluation_id;
  evidence.samples.upgradedBindingDigest = upgraded.rows[0].binding_digest;
});

test('online obligation selection is bounded and uses the owner/target index', async () => {
  const row = await pool.query(`SELECT owner, kind, target_digest::text AS target_digest
    FROM outcome_projection.obligation
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid
    ORDER BY obligation_id LIMIT 1`, [openScope.tenantId, openScope.projectId]);
  assert.ok(row.rows[0]);
  const client = await pool.connect();
  try {
    await client.query('SET enable_seqscan = off');
    const plan = await client.query({
      text: `EXPLAIN (FORMAT JSON)
        SELECT obligation_id, obligation_revision, binding_digest, reason
          FROM outcome_projection.obligation
         WHERE tenant_id = $1::uuid AND owner = $2 AND kind = $3
           AND target_digest = $4 AND project_id = $5::uuid
         ORDER BY obligation_id
         LIMIT 64`,
      values: [
        openScope.tenantId, row.rows[0].owner, row.rows[0].kind,
        row.rows[0].target_digest, openScope.projectId,
      ],
    });
    const rendered = JSON.stringify(plan.rows[0]['QUERY PLAN']);
    assert.match(rendered, /outcome_projection_obligation_owner_target_idx/);
    assert.match(rendered, /Limit/);
  } finally {
    client.release();
  }
  const definition = await pool.query(`SELECT pg_get_functiondef(
    'outcome_projection.read_surface(uuid,uuid,text,text,text)'::regprocedure
  ) AS source`);
  assert.match(definition.rows[0].source, /LIMIT 1/);
  evidence.invariants.boundedTargetIndex = true;
});

test('one late canonical fact makes every read surface explicitly RECONCILER_STALE', async () => {
  const prior = await readSurface(openScope, 'WEB');
  await appendDimension(
    pool,
    openScope,
    'CRITERIA_EVALUATION',
    'SATISFIED',
    'late-after-projection-watermark',
  );
  const staleRows = await Promise.all(SURFACES.map((surface) => readSurface(openScope, surface)));
  for (const [index, projection] of staleRows.entries()) {
    assert.equal(projection.surface, SURFACES[index]);
    assert.equal(projection.staleness, 'RECONCILER_STALE');
    assert.equal(projection.error.code, 'RECONCILER_STALE');
    assert.equal(projection.error.nextAction, 'RECOVER_RECONCILER');
    assert.equal(Object.hasOwn(projection, 'obligations'), false,
      'stale must not masquerade as an empty obligation list');
    assert.deepEqual(projection.canonicalIdentity, prior.canonicalIdentity);
  }
  assert.equal(new Set(staleRows.map((row) => JSON.stringify(row.canonicalIdentity))).size, 1);
  evidence.invariants.staleOnEverySurface = true;
  evidence.invariants.staleNeverLooksLikeEmptyWork = true;
  evidence.samples.staleCanonicalWatermark = staleRows[0].error.canonicalWatermarkLogicalTime;
  evidence.samples.staleEvaluatedThrough = staleRows[0].error.evaluatedThroughLogicalTime;
  assert.ok(BigInt(evidence.samples.staleCanonicalWatermark) > BigInt(evidence.samples.staleEvaluatedThrough));
});
