import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Client } from 'pg';

import {
  OUTCOME_DIMENSIONS,
  evaluateCanonicalOutcome,
  outcomeDigest,
  outcomeEvaluatorDigest,
} from '../outcome-reconciler/outcome-evaluator';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

/**
 * (h)(i) The DONE gate still concludes without completion ACK.
 *
 * 0201 wrapped the pre-existing gate: it renamed the real body to
 * `project_canonical_done_gate_projection_integrity_body`, ran it in a transaction-local
 * projection-only mode, then layered two operational overlays on the result and — the part that
 * mattered — swallowed the body's `no_data_found` whenever an ACTIVE completion-ACK fact existed,
 * substituting a synthesised CANONICAL_PROJECTION_UNAVAILABLE denial.
 *
 * 0220 keeps the wrapper's shape and the projection-integrity cut, drops the completion-ACK
 * overlay, and drops the swallow. So the conclusion path is now: the 0218 body decides, and only
 * runtime liveness may still deny what it allowed. This drives that path on a real server through
 * a real canonical evaluation — one that satisfies every dimension and one that does not.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

function digest(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

interface Scope {
  tenantId: string;
  projectId: string;
  bindingDigest: string;
  binding: Record<string, unknown>;
  authority: Record<string, unknown>;
  principalId: string;
  collectorId: string;
  goal: string;
  contractState: Record<string, string>;
}

async function json<T = Record<string, unknown>>(
  client: Client, text: string, values: unknown[],
): Promise<T> {
  return (await client.query<{ result: T }>({ text, values })).rows[0].result;
}

async function seedOwner(client: Client): Promise<string> {
  const ownerId = randomUUID();
  await client.query(
    `INSERT INTO "user" (id, email, name, password_hash) VALUES ($1,$2,'done-gate','x')`,
    [ownerId, `done-gate-${ownerId}@removal.invalid`],
  );
  return ownerId;
}

async function setupScope(client: Client, tenantId: string, label: string): Promise<Scope> {
  const projectId = randomUUID();
  const definitionId = randomUUID();
  const goal = `${label} canonical goal`;
  await client.query(
    `INSERT INTO "project" (
       "id","owner_id","title","goal","coordinator_enabled","automation_policy",
       "max_concurrent_tasks","session_budget_per_day","updated_at"
     ) VALUES ($1,$2,$3,$4,true,'GUARDED_AUTO'::"project_automation_policy",3,10,now())`,
    [projectId, tenantId, `${label} project`, goal],
  );
  await client.query(
    `INSERT INTO "project_acceptance_criterion_definition" (
       "id","project_id","ordinal","text","verification_method","completion_criterion",
       "content_hash"
     ) VALUES ($1,$2,1,$3,$4,'HUMAN_SIGNOFF'::"task_completion_criterion",$5)`,
    [definitionId, projectId, `${label} is closed by canonical proof`,
      `inspect ${label} canonical proof`, digest(`criterion:${definitionId}`)],
  );
  await client.query('SELECT project_refresh_completion_contract($1::uuid,$2)',
    [projectId, 'COMPLETION_ACK_REMOVAL_FIXTURE']);
  const contractState = (await client.query<Record<string, string>>(
    `SELECT "contract_digest"::text AS "contractDigest",
            "evaluation_plan_digest"::text AS "evaluationPlanDigest",
            "risk_policy_digest"::text AS "riskPolicyDigest",
            "permission_digest"::text AS "permissionDigest",
            "budget_digest"::text AS "budgetDigest",
            "recipient_digest"::text AS "recipientDigest"
       FROM "project_completion_contract" WHERE "project_id" = $1::uuid`,
    [projectId],
  )).rows[0];

  const grantId = randomUUID();
  const principalId = randomUUID();
  const collectorId = `removal-${randomUUID()}`;
  const authority = await json(client,
    `SELECT outcome_register_authority_grant(
      $1::uuid,$2::uuid,$3::uuid,'SYSTEM',$4,'DIMENSION_EVALUATED',
      'ATTESTATION','OUTCOME_EVALUATOR',$5,'completion-ack-removal-v1',NULL,
      1::bigint,NULL::bigint,$6
    ) AS result`,
    [tenantId, projectId, grantId, principalId, collectorId, contractState.riskPolicyDigest]);

  const binding: Record<string, unknown> = {
    tenantId,
    projectId,
    subjectType: 'PROJECT',
    subjectId: projectId,
    goalId: `goal:${projectId}`,
    goalRevision: '1',
    contractDigest: contractState.contractDigest,
    evaluationPlanDigest: contractState.evaluationPlanDigest,
    policyDigest: digest(`policy:${projectId}`),
    riskPolicyDigest: contractState.riskPolicyDigest,
    permissionDigest: contractState.permissionDigest,
    authorityGrantDigest: (authority as { grantDigest: string }).grantDigest,
    budgetDigest: contractState.budgetDigest,
    capabilityRegistryDigest: digest(`registry:${projectId}`),
    recipientDigest: contractState.recipientDigest,
    evaluatorDigest: outcomeEvaluatorDigest('outcome-reducer-v2'),
    factSchemaDigest: digest('completion-ack-removal-fact-schema-v2'),
    environmentDigest: digest(`environment:${projectId}`),
    artifactDigest: digest(`artifact:${projectId}`),
    targetDigest: digest(`target:${projectId}`),
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '0',
    factCutDigest: digest(`prospective-cut:${projectId}`),
  };
  const registered = await json<{ bindingDigest: string }>(client,
    'SELECT outcome_register_fact_binding($1::uuid,$2::uuid,$3::jsonb) AS result',
    [tenantId, projectId, JSON.stringify(binding)]);
  return {
    tenantId, projectId, binding, bindingDigest: registered.bindingDigest,
    authority: authority as Record<string, unknown>, principalId, collectorId, goal, contractState,
  };
}

/** Append one DIMENSION_EVALUATED fact in the state the caller asks for. */
async function appendDimension(
  client: Client, scope: Scope, dimensionId: string, state: string, key: string,
): Promise<void> {
  const payload = {
    dimensionId,
    state,
    applicabilityProofDigest: state === 'NOT_APPLICABLE' ? digest(`n/a:${key}`) : null,
    reasonCode: `${dimensionId}_${state}`,
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
    observedAt: '2026-09-01T00:00:00.000Z',
    causalPredecessorFactId: null,
    idempotencyKey: key,
    source: {
      system: 'OUTCOME_EVALUATOR',
      collectorId: scope.collectorId,
      collectorVersion: 'completion-ack-removal-v1',
    },
    signature: null,
  };
  await json(client,
    `SELECT outcome_ingest_canonical_fact($1::uuid,'SYSTEM',$2,$3::jsonb) AS result`,
    [scope.tenantId, scope.principalId, JSON.stringify(draft)]);
}

/** Seal, evaluate and commit one whole evaluation, so the projection is current. */
async function evaluate(
  client: Client, scope: Scope, prefix: string, overrides: Record<string, string> = {},
): Promise<void> {
  for (const declaration of OUTCOME_DIMENSIONS) {
    await appendDimension(
      client, scope, declaration.id, overrides[declaration.id] ?? 'SATISFIED',
      `${prefix}:${declaration.id}:${randomUUID()}`,
    );
  }
  const cut = await json<{ cutId: string; watermarkLogicalTime: string }>(client,
    'SELECT outcome_seal_evaluation_cut($1::uuid,$2::uuid,$3,$4,$5) AS result',
    [scope.tenantId, scope.projectId, scope.bindingDigest, `${prefix}:cut:${randomUUID()}`,
      'completion-ack-removal-v1']);
  const facts = await client.query(
    `SELECT cf.trust_decision AS "trustDecision", cf.proof_eligible AS "proofEligible", f.envelope
       FROM outcome_evaluation_cut_fact cf
       JOIN outcome_canonical_fact f
         ON f.tenant_id=cf.tenant_id AND f.project_id=cf.project_id AND f.fact_id=cf.fact_id
      WHERE cf.tenant_id=$1::uuid AND cf.project_id=$2::uuid AND cf.cut_id=$3::uuid
      ORDER BY cf.ordinal`,
    [scope.tenantId, scope.projectId, cut.cutId],
  );
  const evaluation = evaluateCanonicalOutcome({
    binding: scope.binding,
    goal: {
      goalId: scope.binding.goalId,
      goalRevision: scope.binding.goalRevision,
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      statement: scope.goal,
      contractDigest: scope.binding.contractDigest,
      evaluationPlanDigest: scope.binding.evaluationPlanDigest,
      ratification: {
        status: 'RATIFIED',
        ratifierType: 'OWNER',
        ratifierId: scope.tenantId,
        contractDigest: scope.binding.contractDigest,
        factId: randomUUID(),
      },
      disposition: 'ACHIEVED',
    },
    factCut: cut,
    facts: facts.rows,
    clock: {
      logicalNow: cut.watermarkLogicalTime,
      clockId: 'completion-ack-removal-clock',
      evaluatedThroughLogicalTime: cut.watermarkLogicalTime,
    },
    evaluatorVersion: 'outcome-reducer-v2',
  }) as unknown as Record<string, unknown>;
  await json(client,
    `SELECT outcome_commit_evaluation(
       $1::uuid,$2::uuid,'PROJECT',$3,$4::uuid,$5,$6::bigint,$7,$8,$9::jsonb
     ) AS result`,
    [scope.tenantId, scope.projectId, scope.projectId, cut.cutId, scope.bindingDigest,
      cut.watermarkLogicalTime, evaluation.evaluatorVersion, evaluation.evaluatorDigest,
      JSON.stringify(evaluation)]);
}

interface Gate {
  schemaVersion: number;
  decision: 'ALLOW' | 'DENY';
  allowed: boolean;
  reasons: Array<{ code: string; message: string; blocksGate: boolean }>;
  blockingReasons: Array<{ code: string }>;
  projectionIntegrity: string;
  canonicalDoneGate: { decision: string; allowed: boolean };
  runtimeLiveness: unknown[];
  staleness?: string;
  [key: string]: unknown;
}

async function gate(client: Client, projectId: string): Promise<Gate> {
  return json<Gate>(client,
    'SELECT project_canonical_done_gate($1::uuid,$2,$3) AS result',
    [projectId, 'PROJECT', projectId]);
}

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

// (h)(i) ------------------------------------------------------------------------------------------
suite('(h)(i) a satisfied project reaches ALLOW with the projection-integrity cut intact', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });
  const tenantId = await seedOwner(client);
  const scope = await setupScope(client, tenantId, 'allow');
  await evaluate(client, scope, 'allow');

  const value = await gate(client, scope.projectId);
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.decision, 'ALLOW');
  assert.equal(value.allowed, true);
  assert.deepEqual(value.blockingReasons, [], 'an allowed gate names no blocking reason');

  // (h) The projection is readable and current: not RECONCILER_STALE, not an empty queue standing
  // in for an error, and the integrity comparison really ran.
  assert.notEqual(value.staleness, 'RECONCILER_STALE');
  assert.equal(value.projectionIntegrity, 'PROJECTION_ONLY_CHECKED');
  assert.equal(value.canonicalDoneGate.decision, 'ALLOW',
    'the projection-only body is what concluded, and the wrapper did not change it');
  assert.deepEqual(value.runtimeLiveness, [],
    'no watchdog is stale, so the one remaining overlay adds nothing');
  // The completion-ACK overlay is gone rather than empty: it had its own key and its own staleness.
  assert.equal('completionAckObligations' in value, false);
  assert.equal('operationalObligations' in value, false);
  assert.notEqual(value.staleness, 'OPERATIONAL_BLOCKED');
});

suite('(i) an unsatisfied project reaches DENY and says why', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });
  const tenantId = await seedOwner(client);
  const scope = await setupScope(client, tenantId, 'deny');
  // One mandatory dimension unsatisfied is the ordinary reason a real project is not done.
  await evaluate(client, scope, 'deny', { CRITERIA_EVALUATION: 'UNSATISFIED' });

  const value = await gate(client, scope.projectId);
  assert.equal(value.decision, 'DENY');
  assert.equal(value.allowed, false);
  assert.equal(value.projectionIntegrity, 'PROJECTION_ONLY_CHECKED');
  assert.equal(value.canonicalDoneGate.decision, 'DENY');

  // A denial that cannot be read is not a conclusion. Every blocking reason is structured.
  assert.ok(value.blockingReasons.length > 0, 'a DENY must name at least one blocking reason');
  for (const reason of value.reasons) {
    assert.equal(typeof reason.code, 'string');
    assert.ok(reason.code.length > 0);
    assert.equal(typeof reason.message, 'string');
    assert.ok(reason.message.length > 0);
    assert.equal(typeof reason.blocksGate, 'boolean');
  }
  assert.ok(
    value.reasons.some((reason) => reason.blocksGate),
    'the denial must be attributable to a reason that blocks the gate',
  );
});

suite('(h) a project with no canonical projection is an explicit error, not an empty queue', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });
  const tenantId = await seedOwner(client);
  const projectId = randomUUID();
  await client.query(
    `INSERT INTO "project" ("id","owner_id","title","updated_at") VALUES ($1,$2,'no stream',now())`,
    [projectId, tenantId],
  );

  // 0201 added a second, parallel answer to this case: whenever an ACTIVE completion-ACK fact
  // existed it swallowed the projection read's `no_data_found` and substituted a synthesised
  // CANONICAL_PROJECTION_UNAVAILABLE denial of its own. Removing that leaves exactly one answer —
  // the 0218 body's own structured MODEL_GAP denial — which is a conclusion a reader can act on
  // rather than an empty obligation set.
  const value = await gate(client, projectId);
  assert.equal(value.decision, 'DENY');
  assert.equal(value.allowed, false);
  assert.deepEqual(
    value.reasons.map((reason) => reason.code),
    ['CANONICAL_FACT_STREAM_MISSING'],
    'the missing stream is named once, by the body, and not doubled by an overlay',
  );
  assert.equal(value.reasons[0].blocksGate, true);
  assert.equal('canonicalProjectionErrorCode' in value, false,
    'the completion-ACK-only CANONICAL_PROJECTION_UNAVAILABLE substitution is gone');
  assert.notEqual(value.staleness, 'CANONICAL_PROJECTION_UNAVAILABLE');
});
