import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const MODULE_PATH = process.env.OUTCOME_EVALUATOR_MODULE;
const URL = process.env.OUTCOME_EVALUATOR_PG_URL;
const EXPECTED_DATABASE = process.env.OUTCOME_EVALUATOR_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OUTCOME_EVALUATOR_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER = process.env.OUTCOME_EVALUATOR_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OUTCOME_EVALUATOR_EVIDENCE_PATH;

assert.ok(MODULE_PATH, 'OUTCOME_EVALUATOR_MODULE is required');
assert.ok(URL, 'OUTCOME_EVALUATOR_PG_URL is required; PostgreSQL absence is a hard failure');
assert.ok(EXPECTED_DATABASE, 'OUTCOME_EVALUATOR_PG_EXPECTED_DATABASE is required');
assert.ok(EXPECTED_USER, 'OUTCOME_EVALUATOR_PG_EXPECTED_USER is required');
assert.ok(EXPECTED_SYSTEM_IDENTIFIER, 'OUTCOME_EVALUATOR_PG_EXPECTED_SYSTEM_IDENTIFIER is required');
assert.ok(EVIDENCE_PATH, 'OUTCOME_EVALUATOR_EVIDENCE_PATH is required');

const {
  OUTCOME_DIMENSIONS,
  OUTCOME_STATES,
  combineOutcomeStates,
  evaluateCanonicalOutcome,
  outcomeDigest,
  outcomeEvaluatorDigest,
} = await import(pathToFileURL(path.resolve(MODULE_PATH)).href);

const pool = new Pool({ connectionString: URL, max: 24 });
const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-evaluator',
  postgres: { required: true, connected: false, version: null, systemIdentifier: null },
  pure: {
    fiveStateTotal: false,
    everyDimensionTotal: false,
    emptyAndOmittedFailClosed: false,
    attemptGoalSeparated: false,
    proofLeavesAuthoritative: false,
    logicalTimeOnly: false,
    stableDigest: false,
    malformedPayloadTotal: false,
  },
  races: {
    passVsCriteriaEdit: false,
    mergeVsTargetAdvance: false,
    cancelVsEvidence: false,
    leaseExpiryVsOldCallback: false,
    doubleSuccessor: false,
    verdictReplacement: false,
    artifactReplacement: false,
    evaluatorVersionSwitch: false,
  },
  invariants: {
    noFalseClose: false,
    noLostObligation: false,
    noDoubleActiveSuccessor: false,
    deterministicCommitReplay: false,
    appendOnlyObligationLedger: false,
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

function uuid(label) {
  const raw = digest(label);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

function clone(value) {
  return structuredClone(value);
}

function makeBinding(overrides = {}) {
  const { evaluatorVersion: requestedVersion, ...bindingOverrides } = overrides;
  const subjectId = bindingOverrides.subjectId ?? uuid('pure-project');
  const tenantId = bindingOverrides.tenantId ?? uuid('pure-tenant');
  const projectId = bindingOverrides.projectId ?? subjectId;
  const version = requestedVersion ?? 'outcome-reducer-v2';
  return {
    tenantId,
    projectId,
    subjectType: 'PROJECT',
    subjectId,
    goalId: `goal:${subjectId}`,
    goalRevision: '1',
    contractDigest: digest(`contract:${subjectId}`),
    evaluationPlanDigest: digest(`plan:${subjectId}`),
    policyDigest: digest(`policy:${subjectId}`),
    riskPolicyDigest: digest(`risk:${subjectId}`),
    permissionDigest: digest(`permission:${subjectId}`),
    authorityGrantDigest: digest(`grant:${subjectId}`),
    budgetDigest: digest(`budget:${subjectId}`),
    capabilityRegistryDigest: digest(`capability:${subjectId}`),
    recipientDigest: digest(`recipient:${subjectId}`),
    evaluatorDigest: outcomeEvaluatorDigest(version),
    factSchemaDigest: digest('outcome-fact-schema-v2'),
    environmentDigest: digest(`environment:${subjectId}`),
    artifactDigest: digest(`artifact:${subjectId}`),
    targetDigest: digest(`target:${subjectId}`),
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '0',
    factCutDigest: digest(`prospective-cut:${subjectId}`),
    ...bindingOverrides,
  };
}

function makeGoal(binding, overrides = {}) {
  return {
    goalId: binding.goalId,
    goalRevision: binding.goalRevision,
    tenantId: binding.tenantId,
    projectId: binding.projectId,
    statement: 'Reach the exact ratified outcome.',
    contractDigest: binding.contractDigest,
    evaluationPlanDigest: binding.evaluationPlanDigest,
    ratification: {
      status: 'RATIFIED',
      ratifierType: 'OWNER',
      ratifierId: 'owner-1',
      contractDigest: binding.contractDigest,
      factId: uuid(`ratification:${binding.subjectId}`),
    },
    disposition: 'ACHIEVED',
    ...overrides,
  };
}

function makeFact(binding, {
  factId,
  factKind = 'DIMENSION_EVALUATED',
  logicalTime,
  payload,
  principalType = 'SYSTEM',
  sourceSystem = 'OUTCOME_EVALUATOR',
  claimType = 'ATTESTATION',
}) {
  return {
    factId,
    factKind,
    tenantId: binding.tenantId,
    subject: { type: binding.subjectType, id: binding.subjectId, projectId: binding.projectId },
    binding,
    schemaVersion: 2,
    schemaDigest: binding.factSchemaDigest,
    payload,
    payloadDigest: outcomeDigest(payload),
    claimType,
    principal: { type: principalType, id: `${principalType.toLowerCase()}-fixture` },
    authority: {
      grantId: uuid(`grant-id:${binding.subjectId}`),
      grantDigest: binding.authorityGrantDigest,
      scopeDigest: digest(`scope:${binding.subjectId}`),
      delegationChainDigest: digest(`delegation:${binding.subjectId}`),
      validFromLogicalTime: '0',
      validThroughLogicalTime: null,
      revokedAtLogicalTime: null,
    },
    observedAt: '2026-08-28T00:00:00.000Z',
    recordedAt: '2026-08-28T00:00:01.000Z',
    logicalTime: String(logicalTime),
    causalPredecessorFactId: null,
    idempotencyKey: `fact:${factId}`,
    source: { system: sourceSystem, collectorId: 'evaluator-fixture', collectorVersion: '2.0.0' },
    signature: null,
  };
}

function dimensionFact(binding, id, index, state = 'SATISFIED', extras = {}) {
  return makeFact(binding, {
    factId: uuid(`dimension:${binding.subjectId}:${id}:${index}:${state}`),
    logicalTime: index + 1,
    payload: {
      dimensionId: id,
      state,
      applicabilityProofDigest: state === 'NOT_APPLICABLE' ? digest(`applicability:${id}`) : null,
      reasonCode: `${id}_${state}`,
      ...extras,
    },
  });
}

function cutFor(binding, entries, overrides = {}) {
  const sorted = [...entries].sort((left, right) => {
    const a = BigInt((left.envelope ?? left).logicalTime);
    const b = BigInt((right.envelope ?? right).logicalTime);
    if (a < b) return -1;
    if (a > b) return 1;
    return (left.envelope ?? left).factId.localeCompare((right.envelope ?? right).factId);
  });
  const envelopes = sorted.map((entry) => entry.envelope ?? entry);
  return {
    cutId: uuid(`cut:${binding.subjectId}:${outcomeDigest(envelopes)}`),
    tenantId: binding.tenantId,
    projectId: binding.projectId,
    watermarkLogicalTime: String(Math.max(0, ...envelopes.map((fact) => Number(fact.logicalTime)))),
    factIds: envelopes.map((fact) => fact.factId),
    factCount: envelopes.length,
    factSetDigest: outcomeDigest(envelopes),
    openedAt: '2026-08-28T00:00:02.000Z',
    sealedAt: '2026-08-28T00:00:03.000Z',
    complete: true,
    linearizable: true,
    collectorVersion: 'evaluator-fixture/2.0.0',
    ...overrides,
  };
}

function perfectFixture(overrides = {}) {
  const binding = overrides.binding ?? makeBinding();
  const envelopes = overrides.envelopes ?? OUTCOME_DIMENSIONS.map((entry, index) => (
    dimensionFact(binding, entry.id, index, 'SATISFIED')
  ));
  const entries = overrides.entries ?? envelopes.map((envelope) => ({
    envelope, trustDecision: 'TRUSTED', proofEligible: true,
  }));
  const factCut = overrides.factCut ?? cutFor(binding, entries, { watermarkLogicalTime: '100' });
  return {
    binding,
    goal: overrides.goal ?? makeGoal(binding),
    factCut,
    facts: entries,
    clock: overrides.clock ?? {
      logicalNow: factCut.watermarkLogicalTime,
      clockId: 'outcome-logical-clock',
      evaluatedThroughLogicalTime: factCut.watermarkLogicalTime,
    },
    ...(overrides.evaluatorVersion ? { evaluatorVersion: overrides.evaluatorVersion } : {}),
  };
}

function rebuildFixture(input, entries, cutOverrides = {}) {
  const factCut = cutFor(input.binding, entries, {
    watermarkLogicalTime: input.factCut.watermarkLogicalTime,
    ...cutOverrides,
  });
  return {
    ...input,
    facts: entries,
    factCut,
    clock: { ...input.clock, evaluatedThroughLogicalTime: factCut.watermarkLogicalTime },
  };
}

test('requires a real, explicitly isolated PostgreSQL server', async () => {
  const result = await pool.query(`
    SELECT current_database() AS database, current_user AS role,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
           current_setting('server_version') AS version
  `);
  const identity = result.rows[0];
  assert.equal(identity.database, EXPECTED_DATABASE);
  assert.equal(identity.role, EXPECTED_USER);
  assert.equal(identity.system_identifier, EXPECTED_SYSTEM_IDENTIFIER);
  assert.match(identity.database, /^pceval_/);
  assert.match(identity.role, /^pceval_/);
  evidence.postgres = {
    required: true,
    connected: true,
    version: identity.version,
    systemIdentifier: identity.system_identifier,
  };
});

test('table-driven five-state algebra is total, commutative, associative and idempotent', () => {
  for (const left of OUTCOME_STATES) {
    assert.equal(combineOutcomeStates(left, left), left);
    for (const right of OUTCOME_STATES) {
      const combined = combineOutcomeStates(left, right);
      assert.ok(OUTCOME_STATES.includes(combined));
      assert.equal(combined, combineOutcomeStates(right, left));
      for (const third of OUTCOME_STATES) {
        assert.equal(
          combineOutcomeStates(combined, third),
          combineOutcomeStates(left, combineOutcomeStates(right, third)),
        );
      }
    }
  }
  evidence.pure.fiveStateTotal = true;
});

test('every required dimension has exactly one five-state result and a perfect cut closes', () => {
  const result = evaluateCanonicalOutcome(perfectFixture());
  assert.equal(result.closed, true);
  assert.equal(result.proof.dimensions.length, OUTCOME_DIMENSIONS.length);
  assert.deepEqual(result.proof.dimensions.map((entry) => entry.dimensionId), OUTCOME_DIMENSIONS.map((entry) => entry.id));
  assert.ok(result.proof.dimensions.every((entry) => entry.state === 'SATISFIED'));
  assert.deepEqual(result.activeMandatoryObligations, []);
  evidence.pure.everyDimensionTotal = true;
});

test('empty and every table-driven omitted dimension fail closed without vacuous success', () => {
  const empty = perfectFixture({ envelopes: [], entries: [] });
  empty.factCut = cutFor(empty.binding, [], { watermarkLogicalTime: '0' });
  empty.clock = { logicalNow: '0', clockId: 'clock', evaluatedThroughLogicalTime: '0' };
  const emptyResult = evaluateCanonicalOutcome(empty);
  assert.equal(emptyResult.closed, false);
  assert.ok(emptyResult.proof.modelGaps.includes('EMPTY_FACT_CUT'));
  assert.ok(emptyResult.proof.dimensions.every((entry) => entry.state === 'UNKNOWN'));

  for (const declaration of OUTCOME_DIMENSIONS) {
    const input = perfectFixture();
    const entries = input.facts.filter((entry) => entry.envelope.payload.dimensionId !== declaration.id);
    const result = evaluateCanonicalOutcome(rebuildFixture(input, entries));
    const dimension = result.proof.dimensions.find((entry) => entry.dimensionId === declaration.id);
    assert.equal(result.closed, false, declaration.id);
    assert.equal(dimension.state, 'UNKNOWN', declaration.id);
    assert.ok(result.activeMandatoryObligations.some((entry) => entry.blocksClosureOf.includes(declaration.id)), declaration.id);
  }
  evidence.pure.emptyAndOmittedFailClosed = true;
});

test('table-driven non-terminal, conflict and applicability states obey closure algebra', () => {
  for (const state of ['UNSATISFIED', 'UNKNOWN']) {
    const input = perfectFixture();
    const entries = input.facts.map((entry) => {
      if (entry.envelope.payload.dimensionId !== 'CRITERIA_EVALUATION') return entry;
      const envelope = clone(entry.envelope);
      envelope.payload.state = state;
      envelope.payload.reasonCode = `FIXTURE_${state}`;
      envelope.payloadDigest = outcomeDigest(envelope.payload);
      return { ...entry, envelope };
    });
    assert.equal(evaluateCanonicalOutcome(rebuildFixture(input, entries)).closed, false);
  }

  const conflictInput = perfectFixture();
  const original = conflictInput.facts.find((entry) => entry.envelope.payload.dimensionId === 'CRITERIA_EVALUATION');
  const conflict = makeFact(conflictInput.binding, {
    factId: uuid('pure-conflict'),
    logicalTime: original.envelope.logicalTime,
    payload: { ...original.envelope.payload, state: 'UNSATISFIED', reasonCode: 'CONFLICTING_CURRENT_FACT' },
  });
  const conflictResult = evaluateCanonicalOutcome(rebuildFixture(conflictInput, [
    ...conflictInput.facts,
    { envelope: conflict, trustDecision: 'TRUSTED', proofEligible: true },
  ]));
  assert.equal(conflictResult.proof.dimensions.find((entry) => entry.dimensionId === 'CRITERIA_EVALUATION').state, 'CONFLICT');
  assert.equal(conflictResult.closed, false);

  const naInput = perfectFixture();
  const naEntries = naInput.facts.map((entry) => {
    if (entry.envelope.payload.dimensionId !== 'ARTIFACT_INTEGRATION') return entry;
    const envelope = clone(entry.envelope);
    envelope.payload.state = 'NOT_APPLICABLE';
    envelope.payload.applicabilityProofDigest = digest('no-artifact-applicable');
    envelope.payloadDigest = outcomeDigest(envelope.payload);
    return { ...entry, envelope };
  });
  assert.equal(evaluateCanonicalOutcome(rebuildFixture(naInput, naEntries)).closed, true);
});

function attemptFact(binding, outcome, generation, logical, status = 'CLOSED') {
  const attempt = {
    attemptId: `attempt-${generation}`,
    attemptGeneration: String(generation),
    goalId: binding.goalId,
    goalRevision: binding.goalRevision,
    sessionId: `session-${generation}`,
    hypothesisDigest: digest(`hypothesis:${generation}`),
    budgetDigest: binding.budgetDigest,
    startedAtLogicalTime: String(logical - 10),
    endedAtLogicalTime: status === 'CLOSED' ? String(logical) : null,
    status,
    outcome: status === 'CLOSED' ? outcome : null,
  };
  return makeFact(binding, {
    factId: uuid(`attempt:${binding.subjectId}:${generation}:${outcome}:${status}`),
    factKind: status === 'CLOSED' ? 'ATTEMPT_TERMINATED' : 'ATTEMPT_STARTED',
    logicalTime: logical,
    payload: { attempt },
    principalType: 'RUNNER',
    sourceSystem: 'CONTROLLED_RUNNER',
  });
}

test('FAILED and CANCELLED close only attempts while a live goal gets one stable successor obligation', () => {
  const identities = [];
  for (const outcome of ['FAILED', 'CANCELLED']) {
    for (const generation of [1, 9]) {
      const input = perfectFixture();
      input.goal = makeGoal(input.binding, { disposition: 'ACTIVE' });
      const attempt = attemptFact(input.binding, outcome, generation, 80 + generation);
      const result = evaluateCanonicalOutcome(rebuildFixture(input, [
        ...input.facts,
        { envelope: attempt, trustDecision: 'TRUSTED', proofEligible: true },
      ]));
      const successors = result.activeMandatoryObligations.filter((entry) => entry.kind === 'START_SUCCESSOR_ATTEMPT');
      assert.equal(successors.length, 1);
      assert.equal(result.closed, false);
      identities.push(successors[0].obligationId);
    }
  }
  assert.equal(new Set(identities).size, 1, 'attempt/session/generation must not churn successor identity');
  evidence.pure.attemptGoalSeparated = true;
});

test('proof graph refuses claim-only, missing and revoked leaves', () => {
  for (const mode of ['CLAIM_ONLY', 'MISSING', 'REVOKED']) {
    const input = perfectFixture();
    const target = input.facts.find((entry) => entry.envelope.payload.dimensionId === 'CRITERIA_EVALUATION');
    const leafId = uuid(`leaf:${mode}`);
    const envelope = clone(target.envelope);
    envelope.payload.evidenceFactIds = [leafId];
    envelope.payloadDigest = outcomeDigest(envelope.payload);
    const entries = input.facts.map((entry) => entry === target ? { ...entry, envelope } : entry);
    if (mode !== 'MISSING') {
      const leaf = makeFact(input.binding, {
        factId: leafId,
        factKind: 'TASK_STATUS_OBSERVED',
        logicalTime: 90,
        payload: { status: 'DONE' },
        principalType: mode === 'CLAIM_ONLY' ? 'AGENT' : 'SYSTEM',
        sourceSystem: mode === 'CLAIM_ONLY' ? 'AGENT_COLLECTOR' : 'ORBIT_CONTROL_PLANE',
        claimType: 'OBSERVATION',
      });
      if (mode === 'REVOKED') leaf.authority.revokedAtLogicalTime = '90';
      entries.push({
        envelope: leaf,
        trustDecision: mode,
        proofEligible: false,
      });
    }
    const result = evaluateCanonicalOutcome(rebuildFixture(input, entries));
    assert.equal(result.closed, false, mode);
    assert.equal(result.proof.dimensions.find((entry) => entry.dimensionId === 'CRITERIA_EVALUATION').state, 'UNKNOWN', mode);
    assert.ok(result.proof.modelGaps.includes('PROOF_LEAF_NOT_AUTHORITATIVE'), mode);
  }
  evidence.pure.proofLeavesAuthoritative = true;
});

test('logical time, not wall time, decides future facts and durable timer expiry', () => {
  const input = perfectFixture();
  const schedule = makeFact(input.binding, {
    factId: uuid('overdue-timer'),
    factKind: 'TIMER_SCHEDULED',
    logicalTime: 90,
    payload: { timerId: 'timer-1', dueLogicalTime: '95' },
  });
  const due = evaluateCanonicalOutcome(rebuildFixture(input, [
    ...input.facts,
    { envelope: schedule, trustDecision: 'TRUSTED', proofEligible: true },
  ], { watermarkLogicalTime: '100' }));
  assert.ok(due.proof.modelGaps.includes('OVERDUE_DURABLE_TIMER'));
  assert.ok(due.activeMandatoryObligations.some((entry) => entry.kind === 'RECOVER_RECONCILER'));

  const futureInput = perfectFixture();
  const future = dimensionFact(futureInput.binding, 'CRITERIA_EVALUATION', 200, 'UNSATISFIED');
  future.logicalTime = '101';
  const futureEntries = [
    ...futureInput.facts,
    { envelope: future, trustDecision: 'TRUSTED', proofEligible: true },
  ];
  const futureResult = evaluateCanonicalOutcome(rebuildFixture(futureInput, futureEntries, { watermarkLogicalTime: '100' }));
  assert.equal(futureResult.closed, false);
  assert.ok(futureResult.proof.modelGaps.includes('INCOMPLETE_OR_NONLINEARIZABLE_FACT_CUT'));
  evidence.pure.logicalTimeOnly = true;
});

test('same sealed input cut has a stable digest independent of delivery order', () => {
  const input = perfectFixture();
  const first = evaluateCanonicalOutcome(input);
  const second = evaluateCanonicalOutcome(clone(input));
  const reversed = evaluateCanonicalOutcome({ ...clone(input), facts: [...clone(input.facts)].reverse() });
  assert.equal(first.evaluationDigest, second.evaluationDigest);
  assert.equal(first.evaluationDigest, reversed.evaluationDigest);
  assert.equal(first.proof.proofDigest, reversed.proof.proofDigest);
  evidence.pure.stableDigest = true;
});

test('malformed canonical payload is a deterministic MODEL_GAP, never an evaluator exception', () => {
  const input = perfectFixture();
  const malformed = makeFact(input.binding, {
    factId: uuid('malformed-attempt'),
    factKind: 'ATTEMPT_TERMINATED',
    logicalTime: 99,
    payload: { attempt: { status: 'CLOSED' } },
  });
  const result = evaluateCanonicalOutcome(rebuildFixture(input, [
    ...input.facts,
    { envelope: malformed, trustDecision: 'TRUSTED', proofEligible: true },
  ]));
  assert.equal(result.closed, false);
  assert.ok(result.proof.modelGaps.includes('MALFORMED_ATTEMPT_FACT'));
  assert.equal(evaluateCanonicalOutcome({ nonsense: true }).closed, false);
  evidence.pure.malformedPayloadTotal = true;
});

async function registerGrant(client, config) {
  const result = await client.query({
    text: `SELECT outcome_register_authority_grant(
      $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11,
      1::bigint, NULL::bigint, $12
    ) AS authority`,
    values: [
      config.tenantId, config.projectId, config.grantId, config.principalType,
      config.principalId, config.factKind, 'ATTESTATION', config.sourceSystem,
      config.collectorId, 'evaluator-pg-test-v1', config.signatureKeyId, config.riskDigest,
    ],
  });
  return result.rows[0].authority;
}

async function registerBinding(client, scope, binding) {
  const result = await client.query({
    text: 'SELECT outcome_register_fact_binding($1::uuid, $2::uuid, $3::jsonb) AS registered',
    values: [scope.tenantId, scope.projectId, JSON.stringify(binding)],
  });
  return result.rows[0].registered;
}

async function setupDbScope({ factKind = 'DIMENSION_EVALUATED', evaluatorVersion = 'outcome-reducer-v2' } = {}) {
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const principalType = factKind === 'ATTEMPT_TERMINATED' ? 'RUNNER' : 'SYSTEM';
  const sourceSystem = factKind === 'ATTEMPT_TERMINATED' ? 'CONTROLLED_RUNNER' : 'OUTCOME_EVALUATOR';
  const signatureKeyId = factKind === 'ATTEMPT_TERMINATED' ? 'runner-test-key' : null;
  const scope = {
    tenantId,
    projectId,
    subjectId: projectId,
    grantId: randomUUID(),
    principalType,
    principalId: randomUUID(),
    factKind,
    sourceSystem,
    collectorId: `collector-${randomUUID()}`,
    signatureKeyId,
    riskDigest: digest(`risk:${tenantId}:${projectId}`),
    evaluatorVersion,
  };
  scope.authority = await registerGrant(pool, scope);
  scope.binding = makeBinding({
    tenantId,
    projectId,
    subjectId: projectId,
    authorityGrantDigest: scope.authority.grantDigest,
    riskPolicyDigest: scope.riskDigest,
    evaluatorVersion,
    evaluatorDigest: outcomeEvaluatorDigest(evaluatorVersion),
  });
  const registered = await registerBinding(pool, scope, scope.binding);
  scope.bindingDigest = registered.bindingDigest;
  return scope;
}

async function appendDbFact(client, scope, payload, key, causalPredecessorFactId = null) {
  const runner = scope.factKind === 'ATTEMPT_TERMINATED';
  const completePayload = runner ? {
    ...payload,
    exitCode: payload.exitCode ?? 1,
    commandDigest: payload.commandDigest ?? digest(`command:${key}`),
    executionReceiptDigest: payload.executionReceiptDigest ?? digest(`receipt:${key}`),
  } : payload;
  const draft = {
    factKind: scope.factKind,
    tenantId: scope.tenantId,
    subject: { type: 'PROJECT', id: scope.subjectId, projectId: scope.projectId },
    binding: scope.binding,
    schemaVersion: 2,
    schemaDigest: scope.binding.factSchemaDigest,
    payload: completePayload,
    payloadDigest: outcomeDigest(completePayload),
    claimType: 'ATTESTATION',
    principal: { type: scope.principalType, id: scope.principalId },
    authority: scope.authority,
    observedAt: '2026-08-28T00:00:00.000Z',
    causalPredecessorFactId,
    idempotencyKey: key,
    source: {
      system: scope.sourceSystem,
      collectorId: scope.collectorId,
      collectorVersion: 'evaluator-pg-test-v1',
    },
    signature: scope.signatureKeyId === null ? null : {
      algorithm: 'TEST-SIGNATURE', keyId: scope.signatureKeyId, value: digest(`signature:${key}`),
    },
  };
  const result = await client.query({
    text: 'SELECT outcome_ingest_canonical_fact($1::uuid, $2, $3, $4::jsonb) AS envelope',
    values: [scope.tenantId, scope.principalType, scope.principalId, JSON.stringify(draft)],
  });
  return result.rows[0].envelope;
}

async function appendAllDimensions(scope, prefix = 'pass', overrides = {}) {
  const facts = [];
  for (const [index, declaration] of OUTCOME_DIMENSIONS.entries()) {
    const state = overrides[declaration.id] ?? 'SATISFIED';
    facts.push(await appendDbFact(pool, scope, {
      dimensionId: declaration.id,
      state,
      applicabilityProofDigest: state === 'NOT_APPLICABLE' ? digest(`db-na:${declaration.id}`) : null,
      reasonCode: `${prefix}_${declaration.id}_${state}`,
    }, `${prefix}:${index}:${declaration.id}`));
  }
  return facts;
}

async function sealDbCut(client, scope, key) {
  const result = await client.query({
    text: 'SELECT outcome_seal_evaluation_cut($1::uuid, $2::uuid, $3, $4, $5) AS cut',
    values: [scope.tenantId, scope.projectId, scope.bindingDigest, key, 'evaluator-pg-test-v1'],
  });
  return result.rows[0].cut;
}

async function readCutEntries(client, scope, cut) {
  const result = await client.query({
    text: `SELECT cf.trust_decision AS "trustDecision", cf.proof_eligible AS "proofEligible", f.envelope
      FROM outcome_evaluation_cut_fact cf
      JOIN outcome_canonical_fact f
        ON f.tenant_id = cf.tenant_id AND f.project_id = cf.project_id AND f.fact_id = cf.fact_id
     WHERE cf.tenant_id = $1::uuid AND cf.project_id = $2::uuid AND cf.cut_id = $3::uuid
     ORDER BY cf.ordinal`,
    values: [scope.tenantId, scope.projectId, cut.cutId],
  });
  return result.rows;
}

async function evaluateDbCut(client, scope, cut, goalOverrides = {}, evaluatorVersion = scope.evaluatorVersion) {
  const facts = await readCutEntries(client, scope, cut);
  return evaluateCanonicalOutcome({
    binding: scope.binding,
    goal: makeGoal(scope.binding, goalOverrides),
    factCut: cut,
    facts,
    clock: {
      logicalNow: cut.watermarkLogicalTime,
      clockId: 'outcome-pg-logical-clock',
      evaluatedThroughLogicalTime: cut.watermarkLogicalTime,
    },
    evaluatorVersion,
  });
}

async function commitDbEvaluation(client, scope, cut, evaluation) {
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

async function closedDbFixture(label = 'closed') {
  const scope = await setupDbScope();
  const facts = await appendAllDimensions(scope, label);
  const cut = await sealDbCut(pool, scope, `${label}:cut`);
  const evaluation = await evaluateDbCut(pool, scope, cut);
  assert.equal(evaluation.closed, true);
  return { scope, cut, evaluation, facts };
}

test('PostgreSQL PASS racing a criteria-standard edit cannot leave a false current close', async () => {
  const { scope, cut, evaluation } = await closedDbFixture('criteria-race');
  const committer = new Client({ connectionString: URL });
  const editor = new Client({ connectionString: URL });
  await committer.connect();
  await editor.connect();
  try {
    await committer.query('BEGIN');
    const committed = await commitDbEvaluation(committer, scope, cut, evaluation);
    assert.equal(committed.closed, true);
    let editSettled = false;
    const replacement = {
      ...scope.binding,
      contractDigest: digest(`criteria-edited:${scope.subjectId}`),
      evaluationPlanDigest: digest(`criteria-plan-edited:${scope.subjectId}`),
    };
    const editPromise = registerBinding(editor, scope, replacement).finally(() => { editSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(editSettled, false, 'criteria edit must serialize behind evaluation commit');
    await committer.query('COMMIT');
    await editPromise;
    const current = await pool.query(`SELECT is_current, effective_closed
      FROM outcome_current_evaluator_result WHERE tenant_id = $1::uuid AND project_id = $2::uuid`,
    [scope.tenantId, scope.projectId]);
    assert.deepEqual(current.rows[0], { is_current: false, effective_closed: false });
    evidence.races.passVsCriteriaEdit = true;
    evidence.invariants.noFalseClose = true;
  } finally {
    await committer.query('ROLLBACK').catch(() => undefined);
    await committer.end();
    await editor.end();
  }
});

test('PostgreSQL merge proof racing target advance refuses the stale evaluator callback', async () => {
  const { scope, cut, evaluation } = await closedDbFixture('target-race');
  const advancer = new Client({ connectionString: URL });
  const stale = new Client({ connectionString: URL });
  await advancer.connect();
  await stale.connect();
  try {
    await advancer.query('BEGIN');
    const replacement = {
      ...scope.binding,
      targetDigest: digest(`advanced-target:${scope.subjectId}`),
    };
    await registerBinding(advancer, scope, replacement);
    let staleSettled = false;
    const stalePromise = commitDbEvaluation(stale, scope, cut, evaluation)
      .then(() => null, (error) => error)
      .finally(() => { staleSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(staleSettled, false, 'stale merge evaluator must wait behind target advance');
    await advancer.query('COMMIT');
    const error = await stalePromise;
    assert.match(String(error?.message), /OUTCOME_EXPECTED_BINDING_WATERMARK_STALE/);
    const count = await pool.query(`SELECT count(*)::int AS n FROM outcome_evaluator_result
      WHERE tenant_id = $1::uuid AND project_id = $2::uuid`, [scope.tenantId, scope.projectId]);
    assert.equal(count.rows[0].n, 0);
    evidence.races.mergeVsTargetAdvance = true;
  } finally {
    await advancer.query('ROLLBACK').catch(() => undefined);
    await advancer.end();
    await stale.end();
  }
});

function dbAttempt(scope, generation, outcome) {
  return {
    attempt: {
      attemptId: `attempt-${generation}`,
      attemptGeneration: String(generation),
      goalId: scope.binding.goalId,
      goalRevision: scope.binding.goalRevision,
      sessionId: `session-${generation}`,
      hypothesisDigest: digest(`db-hypothesis:${scope.subjectId}:${generation}`),
      budgetDigest: scope.binding.budgetDigest,
      startedAtLogicalTime: String(generation * 10),
      endedAtLogicalTime: String(generation * 10 + 1),
      status: 'CLOSED',
      outcome,
    },
  };
}

test('PostgreSQL cancel then later success evidence atomically obsoletes and remaps the old obligation', async () => {
  const scope = await setupDbScope({ factKind: 'ATTEMPT_TERMINATED' });
  await appendDbFact(pool, scope, dbAttempt(scope, 1, 'CANCELLED'), 'cancel-attempt');
  const cancelledCut = await sealDbCut(pool, scope, 'cancel-cut');
  const cancelledEvaluation = await evaluateDbCut(pool, scope, cancelledCut, { disposition: 'ACTIVE' });
  const successor = cancelledEvaluation.activeMandatoryObligations.find((entry) => entry.kind === 'START_SUCCESSOR_ATTEMPT');
  assert.ok(successor);
  await commitDbEvaluation(pool, scope, cancelledCut, cancelledEvaluation);

  await appendDbFact(pool, scope, dbAttempt(scope, 2, 'SUCCEEDED'), 'success-evidence');
  const evidenceCut = await sealDbCut(pool, scope, 'success-evidence-cut');
  const evidenceEvaluation = await evaluateDbCut(pool, scope, evidenceCut, { disposition: 'ACTIVE' });
  assert.equal(evidenceEvaluation.activeMandatoryObligations.some((entry) => entry.kind === 'START_SUCCESSOR_ATTEMPT'), false);
  await commitDbEvaluation(pool, scope, evidenceCut, evidenceEvaluation);
  const transition = await pool.query(`SELECT to_state, reason_code FROM outcome_obligation_event
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND obligation_id = $3
    ORDER BY event_id DESC LIMIT 1`, [scope.tenantId, scope.projectId, successor.obligationId]);
  assert.deepEqual(transition.rows[0], {
    to_state: 'SUPERSEDED', reason_code: 'MATCHING_FACT_APPENDED',
  });
  const reduced = await pool.query(`SELECT successor_count FROM outcome_obligation_successor_set
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid
      AND predecessor_obligation_revision = $3`,
  [scope.tenantId, scope.projectId, successor.obligationRevision]);
  assert.deepEqual(
    reduced.rows[0],
    { successor_count: 1 },
    'the old goal-disposition blocker maps to the current unresolved goal-disposition blocker',
  );
  evidence.races.cancelVsEvidence = true;
  evidence.invariants.noLostObligation = true;
  evidence.invariants.appendOnlyObligationLedger = true;
});

test('PostgreSQL lease-expiry cut wins over an old callback result at the prior watermark', async () => {
  const scope = await setupDbScope();
  const firstCut = await sealDbCut(pool, scope, 'lease-before-expiry');
  const firstEvaluation = await evaluateDbCut(pool, scope, firstCut, { disposition: 'ACTIVE' });
  await commitDbEvaluation(pool, scope, firstCut, firstEvaluation);
  await appendDbFact(pool, scope, {
    dimensionId: 'CRITERIA_EVALUATION', state: 'UNKNOWN', applicabilityProofDigest: null,
    reasonCode: 'LEASE_EXPIRED_CALLBACK_EPOCH_ADVANCED',
  }, 'lease-expired');
  const expiryCut = await sealDbCut(pool, scope, 'lease-expired-cut');
  const expiryEvaluation = await evaluateDbCut(pool, scope, expiryCut, { disposition: 'ACTIVE' });
  await commitDbEvaluation(pool, scope, expiryCut, expiryEvaluation);
  await assert.rejects(
    commitDbEvaluation(pool, scope, firstCut, firstEvaluation),
    /OUTCOME_EXPECTED_BINDING_WATERMARK_STALE/,
  );
  const current = await pool.query(`SELECT watermark_logical_time::text AS watermark, is_current
    FROM outcome_current_evaluator_result WHERE tenant_id = $1::uuid AND project_id = $2::uuid`,
  [scope.tenantId, scope.projectId]);
  assert.deepEqual(current.rows[0], { watermark: expiryCut.watermarkLogicalTime, is_current: true });
  evidence.races.leaseExpiryVsOldCallback = true;
});

test('two concurrent successor reductions create one result and one active successor', async () => {
  const scope = await setupDbScope({ factKind: 'ATTEMPT_TERMINATED' });
  await appendDbFact(pool, scope, dbAttempt(scope, 1, 'FAILED'), 'double-successor-failed');
  const cut = await sealDbCut(pool, scope, 'double-successor-cut');
  const evaluation = await evaluateDbCut(pool, scope, cut, { disposition: 'ACTIVE' });
  assert.equal(evaluation.activeMandatoryObligations.filter((entry) => entry.kind === 'START_SUCCESSOR_ATTEMPT').length, 1);
  const receipts = await Promise.all([
    commitDbEvaluation(pool, scope, cut, evaluation),
    commitDbEvaluation(pool, scope, cut, clone(evaluation)),
  ]);
  assert.equal(receipts.filter((entry) => entry.replayed).length, 1);
  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM outcome_evaluator_result WHERE tenant_id = $1::uuid AND project_id = $2::uuid) AS evaluations,
    (SELECT count(*)::int FROM outcome_active_obligation WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND kind = 'START_SUCCESSOR_ATTEMPT') AS successors`,
  [scope.tenantId, scope.projectId]);
  assert.deepEqual(counts.rows[0], { evaluations: 1, successors: 1 });
  evidence.races.doubleSuccessor = true;
  evidence.invariants.noDoubleActiveSuccessor = true;
  evidence.invariants.deterministicCommitReplay = true;
});

test('PostgreSQL verdict replacement reopens and material artifact replacement supersedes obligations', async () => {
  const { scope, cut, evaluation, facts } = await closedDbFixture('replacement');
  await commitDbEvaluation(pool, scope, cut, evaluation);
  await appendDbFact(pool, scope, {
    dimensionId: 'CRITERIA_EVALUATION', state: 'UNSATISFIED', applicabilityProofDigest: null,
    reasonCode: 'VERDICT_REPLACED_WITH_FAIL',
  }, 'verdict-replacement', facts.find(
    (fact) => fact.payload.dimensionId === 'CRITERIA_EVALUATION',
  ).factId);
  const verdictCut = await sealDbCut(pool, scope, 'verdict-replacement-cut');
  const verdictEvaluation = await evaluateDbCut(pool, scope, verdictCut);
  assert.equal(verdictEvaluation.closed, false);
  await commitDbEvaluation(pool, scope, verdictCut, verdictEvaluation);
  assert.ok(verdictEvaluation.activeMandatoryObligations.some((entry) => entry.blocksClosureOf.includes('CRITERIA_EVALUATION')));
  evidence.races.verdictReplacement = true;

  const replacement = { ...scope.binding, artifactDigest: digest(`replacement-artifact:${scope.subjectId}`) };
  const registered = await registerBinding(pool, scope, replacement);
  scope.binding = replacement;
  scope.bindingDigest = registered.bindingDigest;
  const artifactCut = await sealDbCut(pool, scope, 'artifact-replacement-cut');
  const artifactEvaluation = await evaluateDbCut(pool, scope, artifactCut);
  assert.equal(artifactEvaluation.closed, false);
  await commitDbEvaluation(pool, scope, artifactCut, artifactEvaluation);
  const oldCurrent = await pool.query(`SELECT effective_closed FROM outcome_current_evaluator_result
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid`, [scope.tenantId, scope.projectId]);
  assert.equal(oldCurrent.rows[0].effective_closed, false);
  const superseded = await pool.query(`SELECT count(*)::int AS n FROM outcome_obligation_event
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND to_state = 'SUPERSEDED'`,
  [scope.tenantId, scope.projectId]);
  assert.ok(superseded.rows[0].n > 0);
  evidence.races.artifactReplacement = true;
});

test('evaluator version switch invalidates old proof and only the exact new version may close', async () => {
  const { scope, cut, evaluation } = await closedDbFixture('version-switch');
  await commitDbEvaluation(pool, scope, cut, evaluation);
  const version = 'outcome-reducer-v3';
  const replacement = {
    ...scope.binding,
    evaluatorDigest: outcomeEvaluatorDigest(version),
    environmentDigest: digest(`v3-environment:${scope.subjectId}`),
  };
  const registered = await registerBinding(pool, scope, replacement);
  scope.binding = replacement;
  scope.bindingDigest = registered.bindingDigest;
  scope.evaluatorVersion = version;
  await assert.rejects(commitDbEvaluation(pool, { ...scope, bindingDigest: evaluation.bindingDigest }, cut, evaluation), /OUTCOME_EXPECTED_BINDING_WATERMARK_STALE/);
  const staleView = await pool.query(`SELECT effective_closed FROM outcome_current_evaluator_result
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid`, [scope.tenantId, scope.projectId]);
  assert.equal(staleView.rows[0].effective_closed, false);

  await appendAllDimensions(scope, 'version-v3');
  const newCut = await sealDbCut(pool, scope, 'version-v3-cut');
  const newEvaluation = await evaluateDbCut(pool, scope, newCut, {}, version);
  assert.equal(newEvaluation.closed, true);
  await commitDbEvaluation(pool, scope, newCut, newEvaluation);
  const current = await pool.query(`SELECT evaluator_version, is_current, effective_closed
    FROM outcome_current_evaluator_result WHERE tenant_id = $1::uuid AND project_id = $2::uuid`,
  [scope.tenantId, scope.projectId]);
  assert.deepEqual(current.rows[0], {
    evaluator_version: version, is_current: true, effective_closed: true,
  });
  evidence.races.evaluatorVersionSwitch = true;
  evidence.samples = {
    closedEvaluationDigest: evaluation.evaluationDigest,
    switchedEvaluationDigest: newEvaluation.evaluationDigest,
    oldWatermark: cut.watermarkLogicalTime,
    newWatermark: newCut.watermarkLogicalTime,
  };
});
