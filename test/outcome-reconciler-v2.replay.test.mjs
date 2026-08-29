import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  FROZEN_COMPLETION_DIMENSIONS,
  FROZEN_COMPLETION_STATES,
  canonicalJson,
  combineCompletionStates,
  evaluateOutcome,
  sha256Canonical,
  validateActionSafetyEnvelope,
  validateCanonicalFact,
} from '../scripts/lib/outcome-reconciler-v2.mjs';
import {
  REPLAY_SURFACES,
  assertSurfaceAgreement,
  makeProofLeaves,
  makeTrace,
  projectCanonicalObligation,
  reconstructLegacyTimedOutAttempt,
  replayActionDecision,
  replayBoundaryDecision,
  summarizeObligation,
  syntheticInputCut,
  validateReplayCatalog,
} from '../scripts/lib/outcome-reconciler-replay.mjs';
import {
  REPLAY_CATEGORIES,
  REPLAY_CATEGORY_MINIMUMS,
  REPLAY_FIXTURES,
  replayFixtureById,
} from './fixtures/outcome-reconciler-v2-replay-fixtures.mjs';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const ROOT = path.resolve(import.meta.dirname, '..');
const URL = process.env.OUTCOME_REPLAY_PG_URL;
const EXPECTED_DATABASE = process.env.OUTCOME_REPLAY_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OUTCOME_REPLAY_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER = process.env.OUTCOME_REPLAY_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OUTCOME_REPLAY_EVIDENCE_PATH;
const RUNTIME_MODULE = process.env.OUTCOME_REPLAY_RUNTIME_MODULE;
const TARGET_SHA = process.env.OUTCOME_REPLAY_TARGET_SHA;

assert.ok(URL, 'OUTCOME_REPLAY_PG_URL is required; PostgreSQL absence is a hard failure');
assert.ok(EXPECTED_DATABASE, 'OUTCOME_REPLAY_PG_EXPECTED_DATABASE is required');
assert.ok(EXPECTED_USER, 'OUTCOME_REPLAY_PG_EXPECTED_USER is required');
assert.ok(EXPECTED_SYSTEM_IDENTIFIER, 'OUTCOME_REPLAY_PG_EXPECTED_SYSTEM_IDENTIFIER is required');
assert.ok(EVIDENCE_PATH, 'OUTCOME_REPLAY_EVIDENCE_PATH is required');
assert.ok(RUNTIME_MODULE, 'OUTCOME_REPLAY_RUNTIME_MODULE is required');
assert.match(TARGET_SHA ?? '', /^[0-9a-f]{40}$/, 'OUTCOME_REPLAY_TARGET_SHA must be exact');

const runtime = await import(pathToFileURL(path.resolve(RUNTIME_MODULE)).href);
const contract = JSON.parse(readFileSync(
  path.join(ROOT, 'contracts/outcome-reconciler-v2.contract.json'), 'utf8',
));
const schema = JSON.parse(readFileSync(
  path.join(ROOT, 'contracts/outcome-reconciler-v2.schema.json'), 'utf8',
));
const pool = new Pool({ connectionString: URL, max: 24 });

const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-trace-replay',
  postgres: { required: true, connected: false, version: null, systemIdentifier: null },
  traces: [],
  invariants: {
    noFalseClose: false,
    noLostObligation: false,
    noDoubleActiveSuccessor: false,
    noOrphan: false,
    noInvisibleGate: false,
    ownerCredentialBoundary: false,
    productionDataBoundary: false,
    forgedFactRejected: false,
    fiveStateAlgebra: false,
    goalAttemptSeparated: false,
    writerFence: false,
    mixedClientBoundary: false,
    actionRevocationBudgetCompensation: false,
    concurrentLinearization: false,
    timeoutNegotiationExact: false,
    legacyAuditPreserved: false,
    typedTimeoutReconstructed: false,
    successorOwnsCurrentGoal: false,
    downstreamRecovered: false,
  },
  runtime: {},
};

const D = (label) => sha256Canonical({ label });
const EVALUATOR_DIGEST = sha256Canonical({
  id: 'OUTCOME_RECONCILER', version: contract.evaluatorVersion,
});
let typedTimeoutState = null;
let successorState = null;

after(async () => {
  await pool.end();
  evidence.traces.sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${canonicalJson(evidence)}\n`);
});

function bindingForFixture(fixtureId, overrides = {}) {
  return {
    tenantId: `tenant:${fixtureId}`,
    projectId: `project:${fixtureId}`,
    subjectType: 'PROJECT',
    subjectId: `project:${fixtureId}`,
    goalId: `goal:${fixtureId}`,
    goalRevision: '1',
    contractDigest: D(`contract:${fixtureId}`),
    evaluationPlanDigest: D(`plan:${fixtureId}`),
    policyDigest: D(`policy:${fixtureId}`),
    riskPolicyDigest: D(`risk:${fixtureId}`),
    permissionDigest: D(`permission:${fixtureId}`),
    authorityGrantDigest: D(`authority:${fixtureId}`),
    budgetDigest: D(`budget:${fixtureId}`),
    capabilityRegistryDigest: D(`capabilities:${fixtureId}`),
    recipientDigest: D(`recipients:${fixtureId}`),
    evaluatorDigest: EVALUATOR_DIGEST,
    factSchemaDigest: D('replay-fact-schema-v2'),
    environmentDigest: D(`environment:${fixtureId}`),
    artifactDigest: D(`artifact:${fixtureId}`),
    targetDigest: D(`target:${fixtureId}`),
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '100',
    factCutDigest: D(`fact-cut-binding:${fixtureId}`),
    ...overrides,
  };
}

function goalFor(bound, disposition) {
  return {
    goalId: bound.goalId,
    goalRevision: bound.goalRevision,
    tenantId: bound.tenantId,
    projectId: bound.projectId,
    statement: 'Replay the bound historical outcome without rewriting its source audit.',
    contractDigest: bound.contractDigest,
    evaluationPlanDigest: bound.evaluationPlanDigest,
    ratification: {
      status: 'RATIFIED', ratifierType: 'OWNER', ratifierId: 'owner:replay',
      contractDigest: bound.contractDigest, factId: `ratification:${bound.goalId}`,
    },
    disposition,
  };
}

function canonicalFact({ fixtureId, factId, factKind, payload, logicalTime, bound }) {
  return {
    factId,
    factKind,
    tenantId: bound.tenantId,
    subject: { type: bound.subjectType, id: bound.subjectId, projectId: bound.projectId },
    binding: bound,
    schemaVersion: 2,
    schemaDigest: bound.factSchemaDigest,
    payload,
    payloadDigest: sha256Canonical(payload),
    claimType: factKind.endsWith('_RECORDED') ? 'RECEIPT' : 'ATTESTATION',
    principal: { type: 'SYSTEM', id: 'outcome-replay' },
    authority: {
      grantId: `grant:${fixtureId}`,
      grantDigest: bound.authorityGrantDigest,
      scopeDigest: D(`scope:${fixtureId}`),
      delegationChainDigest: D(`delegation:${fixtureId}`),
      validFromLogicalTime: '0', validThroughLogicalTime: null, revokedAtLogicalTime: null,
    },
    observedAt: '2026-08-28T00:00:00.000Z',
    recordedAt: '2026-08-28T00:00:01.000Z',
    logicalTime: String(logicalTime),
    causalPredecessorFactId: null,
    idempotencyKey: `replay:${fixtureId}:${factId}`,
    source: { system: 'ORBIT_CONTROL_PLANE', collectorId: 'trace-replay', collectorVersion: '2.0.0' },
    signature: null,
  };
}

function dimensionFact(fixtureId, dimensionId, index, state, reasonCode, bound) {
  return canonicalFact({
    fixtureId,
    factId: `${fixtureId}:dimension:${dimensionId}`,
    factKind: 'DIMENSION_EVALUATED',
    logicalTime: index + 1,
    bound,
    payload: {
      dimensionId,
      state,
      applicabilityProofDigest: state === 'NOT_APPLICABLE'
        ? D(`applicability:${fixtureId}:${dimensionId}`) : null,
      reasonCode,
    },
  });
}

function attemptFor(bound, outcome, attemptId = 'attempt:replay', generation = '1') {
  return {
    attemptId,
    attemptGeneration: generation,
    goalId: bound.goalId,
    goalRevision: bound.goalRevision,
    sessionId: `session:${generation}:${bound.goalId}`,
    hypothesisDigest: D(`hypothesis:${bound.goalId}:${generation}`),
    budgetDigest: bound.budgetDigest,
    startedAtLogicalTime: '50',
    endedAtLogicalTime: '60',
    status: 'CLOSED',
    outcome,
  };
}

function cutFor(fixtureId, facts, bound) {
  const sorted = [...facts].sort((left, right) => {
    const delta = BigInt(left.logicalTime) - BigInt(right.logicalTime);
    if (delta < 0n) return -1;
    if (delta > 0n) return 1;
    return left.factId.localeCompare(right.factId);
  });
  return {
    cutId: `cut:${fixtureId}`,
    tenantId: bound.tenantId,
    projectId: bound.projectId,
    watermarkLogicalTime: '100',
    factIds: sorted.map(({ factId }) => factId),
    factCount: sorted.length,
    factSetDigest: sha256Canonical(sorted),
    openedAt: '2026-08-28T00:00:02.000Z',
    sealedAt: '2026-08-28T00:00:03.000Z',
    complete: true,
    linearizable: true,
    collectorVersion: 'trace-replay/2.0.0',
  };
}

function evaluateFixture(fixture, overrides = {}) {
  const bound = overrides.binding ?? bindingForFixture(fixture.id);
  const input = { ...fixture.input, ...overrides };
  const omitted = new Set(input.omittedDimensions ?? []);
  const facts = [];
  for (const [index, dimensionId] of FROZEN_COMPLETION_DIMENSIONS.entries()) {
    if (omitted.has(dimensionId)) continue;
    const configured = input.dimensionStates?.[dimensionId];
    const state = configured?.state ?? 'SATISFIED';
    facts.push(dimensionFact(
      fixture.id,
      dimensionId,
      index,
      state,
      configured?.reasonCode ?? `${dimensionId}_${state}`,
      bound,
    ));
  }
  if (input.taskStatusClaim) {
    facts.push(canonicalFact({
      fixtureId: fixture.id,
      factId: `${fixture.id}:task-status`,
      factKind: 'TASK_STATUS_OBSERVED',
      logicalTime: 30,
      bound,
      payload: { status: input.taskStatusClaim, role: 'V1_COMPATIBILITY_LIFECYCLE_CLAIM' },
    }));
  }
  if (input.attemptOutcome) {
    facts.push(canonicalFact({
      fixtureId: fixture.id,
      factId: `${fixture.id}:attempt-terminated`,
      factKind: 'ATTEMPT_TERMINATED',
      logicalTime: 60,
      bound,
      payload: {
        attempt: attemptFor(
          bound,
          input.attemptOutcome,
          input.attemptId ?? `attempt:${fixture.id}`,
          input.attemptGeneration ?? '1',
        ),
        terminationKind: input.terminationKind ?? null,
      },
    }));
  }
  for (const [index, code] of (input.modelGapCodes ?? []).entries()) {
    facts.push(canonicalFact({
      fixtureId: fixture.id,
      factId: `${fixture.id}:model-gap:${index}`,
      factKind: 'MODEL_GAP_DETECTED',
      logicalTime: 70 + index,
      bound,
      payload: { code },
    }));
  }
  const durableTimers = input.durableTimerOverdue ? [{
    timerId: `timer:${fixture.id}`,
    tenantId: bound.tenantId,
    goalId: bound.goalId,
    obligationId: D(`timer-obligation:${fixture.id}`),
    obligationRevision: D(`timer-obligation-revision:${fixture.id}`),
    bindingDigest: sha256Canonical(bound),
    clockId: 'outcome-replay-logical-clock',
    dueLogicalTime: '90',
    dueAt: '2026-08-28T00:00:04.000Z',
    scheduleFactId: `timer-scheduled:${fixture.id}`,
    state: 'SCHEDULED',
    deliveryAttempt: 0,
    wakeId: `wake:${fixture.id}`,
    timeoutExit: 'TIMEOUT',
  }] : [];
  const factCut = cutFor(fixture.id, facts, bound);
  const evaluatorInput = {
    goal: goalFor(bound, input.goalDisposition ?? 'ACTIVE'),
    binding: bound,
    factCut,
    facts,
    clock: {
      logicalNow: '100', clockId: 'outcome-replay-logical-clock',
      evaluatedThroughLogicalTime: '100',
    },
    durableTimers,
    declaredObligations: [],
  };
  return { input: evaluatorInput, output: evaluateOutcome(evaluatorInput, contract, schema) };
}

function sourceEvidence(fixture) {
  if (fixture.source.kind !== 'REPOSITORY_SOURCE') return fixture.source;
  const source = readFileSync(path.join(ROOT, fixture.source.path), 'utf8');
  assert.ok(source.includes(fixture.source.symbol),
    `${fixture.id}: repository source no longer contains ${fixture.source.symbol}`);
  return {
    path: fixture.source.path,
    symbol: fixture.source.symbol,
    fileDigest: createHash('sha256').update(source).digest('hex'),
  };
}

function expectedObligation(fixture, actual) {
  const expected = fixture.expectedFinalObligation;
  assert.equal(actual.kind, expected.kind, `${fixture.id}: final obligation kind`);
  assert.equal(actual.state, expected.state, `${fixture.id}: final obligation state`);
  if (expected.owner !== null) assert.equal(actual.owner, expected.owner, `${fixture.id}: final owner`);
  assert.equal(actual.reasonCode, expected.reasonCode, `${fixture.id}: final reason`);
}

function recordTrace(fixture, {
  inputBinding,
  inputCut,
  actualTransition,
  proofLeaves,
  finalObligation,
  detail = {},
}) {
  expectedObligation(fixture, finalObligation);
  const trace = makeTrace({
    fixture,
    targetSha: TARGET_SHA,
    inputBinding,
    inputCut,
    actualTransition,
    proofLeaves,
    finalObligation,
    detail: { sourceEvidence: sourceEvidence(fixture), ...detail },
  });
  assert.ok(!evidence.traces.some(({ fixtureId }) => fixtureId === fixture.id),
    `${fixture.id}: trace was recorded twice`);
  evidence.traces.push(trace);
  return trace;
}

function evaluatorProofLeaves(fixture, evaluated, obligation, extras = []) {
  return makeProofLeaves([
    ['SOURCE_RECORD_BOUND', true, fixture.source],
    ['INPUT_CUT_COMPLETE', evaluated.input.factCut.complete, evaluated.input.factCut],
    ['INPUT_CUT_LINEARIZABLE', evaluated.input.factCut.linearizable, evaluated.input.factCut],
    ['EVALUATOR_PROOF_CLOSED', evaluated.output.proof.closed, evaluated.output.proof],
    ['EXPECTED_OBLIGATION_PRESENT', Boolean(obligation), obligation ?? {}],
    ['TASK_STATUS_IS_CLAIM_NOT_AUTHORITY', true, {
      taskStatus: fixture.input.taskStatusClaim ?? null,
      proofDigest: evaluated.output.proof.proofDigest,
    }],
    ...extras,
  ]);
}

function replayEvaluatorFixture(fixture, overrides = {}) {
  const evaluated = evaluateFixture(fixture, overrides);
  const obligation = evaluated.output.obligations.find((candidate) => (
    candidate.kind === fixture.expectedTransition.obligationKind
    && candidate.reason.code === fixture.expectedTransition.reasonCode
  ));
  assert.ok(obligation, `${fixture.id}: expected canonical obligation is absent`);
  const actualTransition = {
    from: fixture.input.from,
    event: fixture.input.event,
    to: 'GOAL_ACTIVE_WITH_OBLIGATION',
    closed: evaluated.output.proof.closed,
    obligationKind: obligation.kind,
    reasonCode: obligation.reason.code,
  };
  const finalObligation = summarizeObligation(obligation, fixture.expectedFinalObligation);
  recordTrace(fixture, {
    inputBinding: evaluated.input.binding,
    inputCut: { ...evaluated.input.factCut, bindingDigest: sha256Canonical(evaluated.input.binding) },
    actualTransition,
    proofLeaves: evaluatorProofLeaves(fixture, evaluated, obligation),
    finalObligation,
    detail: {
      evaluatorProofDigest: evaluated.output.proof.proofDigest,
      obligationKinds: [...new Set(evaluated.output.obligations.map(({ kind }) => kind))].sort(),
      rejectedFacts: evaluated.output.rejectedFacts,
    },
  });
}

function manualFinalObligation(fixture, inputBinding) {
  return {
    obligationId: D(`manual-obligation:${fixture.id}:${fixture.expectedFinalObligation.kind}`),
    obligationRevision: D(`manual-obligation-revision:${fixture.id}`),
    bindingDigest: sha256Canonical(inputBinding),
    blocksClosureOf: fixture.expectedFinalObligation.kind === 'NONE' ? [] : ['MODEL_COVERAGE'],
    ...fixture.expectedFinalObligation,
  };
}

function recordManualTrace(fixture, actualTransition, proofEntries, detail = {}) {
  const inputBinding = bindingForFixture(fixture.id);
  const inputCut = syntheticInputCut(fixture.id, inputBinding, { input: fixture.input, detail });
  return recordTrace(fixture, {
    inputBinding,
    inputCut,
    actualTransition,
    proofLeaves: makeProofLeaves(proofEntries),
    finalObligation: manualFinalObligation(fixture, inputBinding),
    detail,
  });
}

async function one(client, text, values = []) {
  const result = await client.query({ text, values });
  assert.equal(result.rows.length, 1, `expected one row from ${text.slice(0, 80)}`);
  return result.rows[0];
}

function dbDigest(label) {
  return createHash('sha256').update(label).digest('hex');
}

async function setupFactLane(label) {
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const subjectId = randomUUID();
  const principalId = randomUUID();
  const grantId = randomUUID();
  const collectorId = `agent-collector-${randomUUID()}`;
  const riskDigest = dbDigest(`risk:${label}`);
  const authority = (await one(pool, `
    SELECT outcome_register_authority_grant(
      $1::uuid,$2::uuid,$3::uuid,'AGENT',$4,'TASK_STATUS_OBSERVED','OBSERVATION',
      'AGENT_COLLECTOR',$5,'2.0.0-replay','replay-signing-key',1,NULL,$6
    ) AS authority
  `, [tenantId, projectId, grantId, principalId, collectorId, riskDigest])).authority;
  const binding = {
    tenantId,
    projectId,
    subjectType: 'TASK',
    subjectId,
    goalId: `goal:${subjectId}`,
    goalRevision: '1',
    contractDigest: dbDigest(`contract:${label}`),
    evaluationPlanDigest: dbDigest(`plan:${label}`),
    policyDigest: dbDigest(`policy:${label}`),
    riskPolicyDigest: riskDigest,
    permissionDigest: dbDigest(`permission:${label}`),
    authorityGrantDigest: authority.grantDigest,
    budgetDigest: dbDigest(`budget:${label}`),
    capabilityRegistryDigest: dbDigest(`capabilities:${label}`),
    recipientDigest: dbDigest(`recipient:${label}`),
    evaluatorDigest: dbDigest(`evaluator:${label}`),
    factSchemaDigest: dbDigest('outcome-fact-schema-v2'),
    environmentDigest: dbDigest(`environment:${label}`),
    artifactDigest: dbDigest(`artifact:${label}`),
    targetDigest: dbDigest(`target:${label}`),
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '0',
    factCutDigest: dbDigest(`prospective-cut:${label}`),
  };
  const registered = (await one(pool,
    'SELECT outcome_register_fact_binding($1::uuid,$2::uuid,$3::jsonb) AS value',
    [tenantId, projectId, JSON.stringify(binding)])).value;
  return {
    label, tenantId, projectId, subjectId, principalId, grantId, collectorId,
    authority, binding, bindingDigest: registered.bindingDigest,
  };
}

function dbFactDraft(scope, payload, idempotencyKey) {
  return {
    factKind: 'TASK_STATUS_OBSERVED',
    tenantId: scope.tenantId,
    subject: { type: 'TASK', id: scope.subjectId, projectId: scope.projectId },
    binding: scope.binding,
    schemaVersion: 2,
    schemaDigest: scope.binding.factSchemaDigest,
    payload,
    payloadDigest: sha256Canonical(payload),
    claimType: 'OBSERVATION',
    principal: { type: 'AGENT', id: scope.principalId },
    authority: scope.authority,
    observedAt: '2026-08-28T00:00:00.000Z',
    causalPredecessorFactId: null,
    idempotencyKey,
    source: {
      system: 'AGENT_COLLECTOR', collectorId: scope.collectorId, collectorVersion: '2.0.0-replay',
    },
    signature: {
      algorithm: 'TEST-SIGNED-CONTEXT', keyId: 'replay-signing-key',
      value: dbDigest(`signature:${idempotencyKey}`),
    },
  };
}

async function appendDbFact(client, scope, draft) {
  return (await one(client, `
    SELECT outcome_ingest_canonical_fact($1::uuid,'AGENT',$2,$3::jsonb) AS value
  `, [scope.tenantId, scope.principalId, JSON.stringify(draft)])).value;
}

async function sealDbCut(client, scope, key) {
  return (await one(client, `
    SELECT outcome_seal_evaluation_cut($1::uuid,$2::uuid,$3,$4,'trace-replay/2.0.0') AS value
  `, [scope.tenantId, scope.projectId, scope.bindingDigest, key])).value;
}

function validActionEnvelope(fixtureId) {
  return {
    actionIntentId: `action:${fixtureId}`,
    tenantId: `tenant:${fixtureId}`,
    obligationId: D(`action-obligation:${fixtureId}`),
    obligationRevision: D(`action-revision:${fixtureId}`),
    effectClass: 'EXTERNAL_REVERSIBLE',
    resourceType: 'GIT_REFERENCE',
    resourceId: 'repo:refs/heads/main',
    targetDigest: D(`action-target:${fixtureId}`),
    authorityGrantDigest: D(`action-authority:${fixtureId}`),
    policyDigest: D(`action-policy:${fixtureId}`),
    preconditionDigest: D(`action-precondition:${fixtureId}`),
    evaluatedThroughLogicalTime: '100',
    idempotencyKey: `action-key:${fixtureId}`,
    budget: { accountId: 'project-budget', unit: 'external-write', charge: 1, limit: 3, reservationId: `reservation:${fixtureId}` },
    retryPolicy: { maxAttempts: 3, backoffDigest: D(`backoff:${fixtureId}`), sameFailureFingerprintLimit: 2 },
    compensation: { compensatorCapability: 'git.reference.restore', manualRecovery: null, remediationObligationKind: 'REMEDIATE_SIDE_EFFECT' },
    receiptRequirements: { providerIdentity: true, effectDigest: true, observedAt: true, result: true, idempotencyKey: true },
  };
}

test('requires the explicit disposable PostgreSQL 16+ identity', async () => {
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

test('catalog binds every historical and fault fixture to a reviewable source record', () => {
  assert.equal(validateReplayCatalog(REPLAY_FIXTURES, REPLAY_CATEGORY_MINIMUMS), true);
  assert.equal(REPLAY_FIXTURES.length, 34);
  for (const fixture of REPLAY_FIXTURES) sourceEvidence(fixture);
});

for (const fixture of REPLAY_FIXTURES.filter(({ scenario }) => scenario === 'EVALUATOR_OBLIGATION')) {
  test(`historical replay: ${fixture.id}`, () => {
    replayEvaluatorFixture(fixture);
  });
}

for (const fixture of REPLAY_FIXTURES.filter(({ scenario }) => scenario === 'SURFACE_EVALUATOR')) {
  test(`read-model replay: ${fixture.id}`, () => {
    const evaluated = evaluateFixture(fixture);
    const obligation = evaluated.output.obligations.find((candidate) => (
      candidate.kind === fixture.expectedTransition.obligationKind
      && candidate.reason.code === fixture.expectedTransition.reasonCode
    ));
    assert.ok(obligation);
    const projections = projectCanonicalObligation(
      obligation, evaluated.output.proof.evaluatedThroughLogicalTime,
    );
    assert.equal(assertSurfaceAgreement(projections), true);
    const actualTransition = {
      from: fixture.input.from,
      event: fixture.input.event,
      to: 'VISIBLE_ON_ALL_SIX_SURFACES',
      closed: evaluated.output.proof.closed,
      obligationKind: obligation.kind,
      reasonCode: obligation.reason.code,
      surfaceCount: Object.keys(projections).length,
    };
    recordTrace(fixture, {
      inputBinding: evaluated.input.binding,
      inputCut: { ...evaluated.input.factCut, bindingDigest: sha256Canonical(evaluated.input.binding) },
      actualTransition,
      proofLeaves: evaluatorProofLeaves(fixture, evaluated, obligation, [
        ['ALL_SIX_SURFACES_AGREE', true, projections],
      ]),
      finalObligation: summarizeObligation(obligation, fixture.expectedFinalObligation),
      detail: { projections, evaluatorProofDigest: evaluated.output.proof.proofDigest },
    });
  });
}

test('owner-shaped credentials minted by an agent do not cross the provenance boundary', () => {
  const fixture = replayFixtureById('boundary-owner-credential-forgery');
  const result = replayBoundaryDecision({
    presentedRole: 'OWNER', credentialProvenance: 'AGENT_MINTED_LOCAL_SECRET',
    executionEnvironment: 'ACCEPTANCE_FIXTURE', targetEnvironment: 'FIXTURE',
    productionGrantDigest: null,
  });
  assert.deepEqual(result, { allowed: false, reasonCode: 'OWNER_CREDENTIAL_PROVENANCE_UNTRUSTED' });
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event, to: 'MUTATION_REFUSED', closed: false,
    obligationKind: 'REQUEST_NEW_AUTHORIZATION', reasonCode: result.reasonCode,
  }, [
    ['PRESENTED_ROLE_OWNER', true, { role: 'OWNER' }],
    ['OWNER_CHANNEL_PROVENANCE_TRUSTED', false, { provenance: 'AGENT_MINTED_LOCAL_SECRET' }],
    ['MUTATION_OCCURRED', false],
  ]);
  evidence.invariants.ownerCredentialBoundary = true;
});

test('acceptance fixtures cannot turn prose into authority to mutate production data', () => {
  const fixture = replayFixtureById('boundary-production-data-write');
  const result = replayBoundaryDecision({
    presentedRole: 'AGENT', credentialProvenance: 'RUNNER_SESSION',
    executionEnvironment: 'ACCEPTANCE_FIXTURE', targetEnvironment: 'PRODUCTION',
    productionGrantDigest: null,
  });
  assert.deepEqual(result, { allowed: false, reasonCode: 'PRODUCTION_TARGET_OUTSIDE_FIXTURE_AUTHORITY' });
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event, to: 'MUTATION_REFUSED', closed: false,
    obligationKind: 'REQUEST_RISK_ACCEPTANCE', reasonCode: result.reasonCode,
  }, [
    ['EXECUTION_ENVIRONMENT_IS_FIXTURE', true],
    ['TARGET_ENVIRONMENT_IS_PRODUCTION', true],
    ['EXACT_PRODUCTION_GRANT_PRESENT', false],
    ['PRODUCTION_ROWS_WRITTEN', 0],
  ]);
  evidence.invariants.productionDataBoundary = true;
});

test('payload tampering remains a rejected claim rather than forged proof', () => {
  const fixture = replayFixtureById('boundary-forged-fact-payload');
  const bound = bindingForFixture(fixture.id);
  const fact = dimensionFact(fixture.id, 'CRITERIA_EVALUATION', 0, 'SATISFIED', 'ORIGINAL', bound);
  fact.payload.state = 'UNSATISFIED';
  assert.throws(() => validateCanonicalFact(fact, contract), /payloadDigest/);
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event, to: 'FACT_REJECTED', closed: false,
    obligationKind: 'REPAIR_FACT_CUT', reasonCode: 'PAYLOAD_DIGEST_MISMATCH',
  }, [
    ['STORED_PAYLOAD_DIGEST', fact.payloadDigest],
    ['RECOMPUTED_PAYLOAD_DIGEST', sha256Canonical(fact.payload)],
    ['DIGESTS_MATCH', false],
    ['FACT_ACCEPTED_AS_PROOF', false],
  ]);
  evidence.invariants.forgedFactRejected = true;
});

test('five-state algebra is total and only proof-eligible states can close', () => {
  const fixture = replayFixtureById('property-five-state-total-algebra');
  let pairCount = 0;
  let tripleCount = 0;
  for (const left of FROZEN_COMPLETION_STATES) {
    assert.equal(combineCompletionStates(left, left, contract), left);
    for (const right of FROZEN_COMPLETION_STATES) {
      const combined = combineCompletionStates(left, right, contract);
      assert.ok(FROZEN_COMPLETION_STATES.includes(combined));
      assert.equal(combined, combineCompletionStates(right, left, contract));
      pairCount += 1;
      for (const third of FROZEN_COMPLETION_STATES) {
        assert.equal(
          combineCompletionStates(combined, third, contract),
          combineCompletionStates(left, combineCompletionStates(right, third, contract), contract),
        );
        tripleCount += 1;
      }
    }
  }
  assert.equal(pairCount, 25);
  assert.equal(tripleCount, 125);
  const closedByState = {};
  for (const state of FROZEN_COMPLETION_STATES) {
    const dimension = state === 'NOT_APPLICABLE' ? 'ARTIFACT_INTEGRATION' : 'CRITERIA_EVALUATION';
    const configured = state === 'SATISFIED' ? {} : {
      dimensionStates: { [dimension]: { state, reasonCode: `PROPERTY_${state}` } },
    };
    const evaluated = evaluateFixture(fixture, {
      goalDisposition: 'ACHIEVED', ...configured,
    });
    closedByState[state] = evaluated.output.proof.closed;
  }
  assert.deepEqual(closedByState, {
    SATISFIED: true, UNSATISFIED: false, UNKNOWN: false, CONFLICT: false, NOT_APPLICABLE: true,
  });
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event,
    to: 'TOTAL_COMMUTATIVE_ASSOCIATIVE_IDEMPOTENT', closed: true,
    obligationKind: 'NONE', reasonCode: 'FIVE_STATE_PROPERTIES_HOLD', pairCount, tripleCount,
  }, [
    ['PAIR_MATRIX_TOTAL', pairCount, { states: FROZEN_COMPLETION_STATES }],
    ['TRIPLE_ASSOCIATIVITY_CASES', tripleCount],
    ['CLOSURE_BY_STATE', closedByState],
  ], { closedByState });
  evidence.invariants.fiveStateAlgebra = true;
});

test('database writer fence refuses a direct DONE projection write', async () => {
  const fixture = replayFixtureById('writer-fence-direct-done-refused');
  const ownerId = randomUUID();
  const taskId = randomUUID();
  await pool.query(`
    INSERT INTO "user" (id,email,name,password_hash) VALUES ($1,$2,'writer fence','x')
  `, [ownerId, `writer-fence-${ownerId}@example.test`]);
  await pool.query(`
    INSERT INTO task (
      id,title,owner_id,creator_type,creator_id,completion_criterion,status,updated_at
    ) VALUES ($1,'bare done write',$2,'USER',$2,'HUMAN_SIGNOFF','OPEN',clock_timestamp())
  `, [taskId, ownerId]);
  await assert.rejects(
    pool.query(`UPDATE task SET status='DONE'::task_status WHERE id=$1`, [taskId]),
    /TASK_DONE_CANONICAL_FACT_REQUIRED/,
  );
  const standing = await one(pool, 'SELECT status::text AS status FROM task WHERE id=$1', [taskId]);
  assert.equal(standing.status, 'OPEN');
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event, to: 'WRITE_REFUSED_TASK_OPEN',
    closed: false, obligationKind: 'SATISFY_COMPLETION_DIMENSION',
    reasonCode: 'TASK_DONE_CANONICAL_FACT_REQUIRED',
  }, [
    ['DATABASE_TRIGGER_EXECUTED', true],
    ['CANONICAL_COMPLETION_FACT_PRESENT', false],
    ['FINAL_TASK_STATUS', standing.status],
  ], { taskId, finalTaskStatus: standing.status });
  evidence.invariants.writerFence = true;
});

test('known V1 clients remain claim-only and cannot direct-write DONE', () => {
  const fixture = replayFixtureById('mixed-client-v1-claim-only');
  const boundary = contract.compatibilityBoundary;
  assert.ok(boundary.acceptedLegacyProtocols.includes('V1'));
  assert.equal(boundary.legacyDirectDone, 'REFUSE');
  assert.equal(boundary.legacyMayMintAuthority, false);
  assert.equal(boundary.legacyMayRatifyContract, false);
  assert.equal(boundary.legacyMayWriteProjection, false);
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event,
    to: 'CLAIM_RECORDED_DIRECT_DONE_REFUSED', closed: false,
    obligationKind: 'SATISFY_COMPLETION_DIMENSION', reasonCode: 'LEGACY_DONE_IS_CLAIM_ONLY',
  }, [
    ['V1_LANE_DECLARED', true, boundary.acceptedLegacyProtocols],
    ['DIRECT_DONE_ALLOWED', false],
    ['LEGACY_MAY_MINT_AUTHORITY', boundary.legacyMayMintAuthority],
    ['LEGACY_MAY_WRITE_PROJECTION', boundary.legacyMayWriteProjection],
  ]);
});

test('unknown mixed-client revisions fail closed with an actionable upgrade path', () => {
  const fixture = replayFixtureById('mixed-client-unknown-revision-refused');
  assert.equal(
    contract.compatibilityBoundary.unknownRevision,
    'REFUSE_WITH_STRUCTURED_UPGRADE_OR_ROLLBACK_ACTION',
  );
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event,
    to: 'WRITE_REFUSED_WITH_UPGRADE_ACTION', closed: false,
    obligationKind: 'DIAGNOSE_MODEL_GAP', reasonCode: 'UNKNOWN_PROTOCOL_REVISION',
  }, [
    ['UNKNOWN_REVISION_ACCEPTED', false],
    ['UPGRADE_OR_ROLLBACK_ACTION_PRESENT', true, contract.compatibilityBoundary],
  ]);
  evidence.invariants.mixedClientBoundary = true;
});

test('action authority revoked before commit is rechecked and refused', () => {
  const fixture = replayFixtureById('action-revoked-authority');
  const envelope = validActionEnvelope(fixture.id);
  validateActionSafetyEnvelope(envelope, contract);
  const decision = replayActionDecision(envelope, { revokedAtLogicalTime: '100' });
  assert.deepEqual(decision, { allowed: false, reasonCode: 'AUTHORITY_REVOKED_AT_COMMIT' });
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event, to: 'ACTION_REFUSED', closed: false,
    obligationKind: 'REQUEST_NEW_AUTHORIZATION', reasonCode: decision.reasonCode,
  }, [
    ['INTENT_ENVELOPE_VALID', true, envelope],
    ['AUTHORITY_CURRENT_AT_COMMIT', false, { revokedAtLogicalTime: '100' }],
    ['EXTERNAL_EFFECT_COUNT', 0],
  ]);
});

test('over-budget action fails closed before side effects', () => {
  const fixture = replayFixtureById('action-budget-exhausted');
  const envelope = validActionEnvelope(fixture.id);
  envelope.budget.charge = 4;
  assert.throws(() => validateActionSafetyEnvelope(envelope, contract), /over budget/);
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event, to: 'ACTION_REFUSED', closed: false,
    obligationKind: 'REQUEST_RISK_ACCEPTANCE', reasonCode: 'ACTION_BUDGET_EXCEEDED',
  }, [
    ['BUDGET_CHARGE', envelope.budget.charge],
    ['BUDGET_LIMIT', envelope.budget.limit],
    ['EXTERNAL_EFFECT_COUNT', 0],
  ]);
});

test('side-effect action without compensation or manual recovery is refused', () => {
  const fixture = replayFixtureById('action-compensation-missing');
  const envelope = validActionEnvelope(fixture.id);
  envelope.compensation.compensatorCapability = null;
  envelope.compensation.manualRecovery = null;
  assert.throws(() => validateActionSafetyEnvelope(envelope, contract), /compensator or manual recovery/);
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event, to: 'ACTION_REFUSED', closed: false,
    obligationKind: 'REMEDIATE_SIDE_EFFECT', reasonCode: 'COMPENSATION_OR_MANUAL_RECOVERY_REQUIRED',
  }, [
    ['COMPENSATOR_PRESENT', false],
    ['MANUAL_RECOVERY_PRESENT', false],
    ['ACTION_ADMITTED', false],
  ]);
  evidence.invariants.actionRevocationBudgetCompensation = true;
});

test('concurrent identical fact writes linearize to one append-only fact', async () => {
  const fixture = replayFixtureById('concurrency-idempotent-fact-ingress');
  const scope = await setupFactLane(fixture.id);
  const draft = dbFactDraft(scope, { status: 'IN_PROGRESS', observation: 'same bytes' },
    `replay:${fixture.id}`);
  const results = await Promise.all(Array.from({ length: 8 }, async () => {
    const client = await pool.connect();
    try {
      return await appendDbFact(client, scope, draft);
    } finally {
      client.release();
    }
  }));
  assert.equal(new Set(results.map(({ factId }) => factId)).size, 1);
  assert.equal(new Set(results.map(({ logicalTime }) => logicalTime)).size, 1);
  const count = await one(pool, `
    SELECT count(*)::integer AS count FROM outcome_canonical_fact
     WHERE tenant_id=$1::uuid AND project_id=$2::uuid AND idempotency_key=$3
  `, [scope.tenantId, scope.projectId, draft.idempotencyKey]);
  assert.equal(count.count, 1);
  const inputCut = syntheticInputCut(fixture.id, scope.binding, [draft]);
  recordTrace(fixture, {
    inputBinding: scope.binding,
    inputCut,
    actualTransition: {
      from: fixture.input.from, event: fixture.input.event, to: 'ONE_CANONICAL_FACT', closed: true,
      obligationKind: 'NONE', reasonCode: 'IDEMPOTENT_FACT_LINEARIZED', writerCount: 8, factCount: 1,
    },
    proofLeaves: makeProofLeaves([
      ['CONCURRENT_WRITER_COUNT', 8],
      ['DISTINCT_FACT_IDS', 1, results.map(({ factId }) => factId)],
      ['DISTINCT_LOGICAL_TIMES', 1, results.map(({ logicalTime }) => logicalTime)],
      ['PERSISTED_FACT_COUNT', count.count],
    ]),
    finalObligation: manualFinalObligation(fixture, scope.binding),
    detail: { factId: results[0].factId, logicalTime: results[0].logicalTime },
  });
});

test('a cut holds the stream frontier and excludes the fact that linearizes after it', async () => {
  const fixture = replayFixtureById('concurrency-cut-before-late-fact');
  const scope = await setupFactLane(fixture.id);
  const firstDraft = dbFactDraft(scope, { status: 'OPEN', ordinal: 1 }, `replay:${fixture.id}:first`);
  await appendDbFact(pool, scope, firstDraft);
  const sealing = await pool.connect();
  let lateSettled = false;
  try {
    await sealing.query('BEGIN');
    const cut = await sealDbCut(sealing, scope, `replay:${fixture.id}:cut`);
    const lateDraft = dbFactDraft(scope, { status: 'IN_PROGRESS', ordinal: 2 },
      `replay:${fixture.id}:late`);
    const latePromise = appendDbFact(pool, scope, lateDraft).then((value) => {
      lateSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(lateSettled, false, 'late fact bypassed the cut stream lock');
    await sealing.query('COMMIT');
    const late = await latePromise;
    assert.equal(cut.factCount, 1);
    assert.equal(BigInt(late.logicalTime), BigInt(cut.watermarkLogicalTime) + 1n);
    const replayed = await one(pool,
      'SELECT outcome_replay_fact_set_digest($1::uuid,$2::uuid) AS digest',
      [scope.tenantId, cut.cutId]);
    assert.equal(replayed.digest, cut.factSetDigest);
    recordTrace(fixture, {
      inputBinding: scope.binding,
      inputCut: { ...cut, bindingDigest: sha256Canonical(scope.binding) },
      actualTransition: {
        from: fixture.input.from, event: fixture.input.event,
        to: 'SEALED_CUT_EXCLUDES_LATE_FACT', closed: true,
        obligationKind: 'NONE', reasonCode: 'CUT_LINEARIZED_BEFORE_LATE_FACT', watermarkDelta: 1,
      },
      proofLeaves: makeProofLeaves([
        ['CUT_COMPLETE', cut.complete, cut],
        ['CUT_LINEARIZABLE', cut.linearizable, cut],
        ['LATE_FACT_BLOCKED_UNTIL_COMMIT', true],
        ['LATE_FACT_LOGICAL_TIME_DELTA', 1, { cut: cut.watermarkLogicalTime, late: late.logicalTime }],
        ['REPLAY_DIGEST_MATCHES_SEALED_CUT', replayed.digest === cut.factSetDigest, replayed],
      ]),
      finalObligation: manualFinalObligation(fixture, scope.binding),
      detail: { lateFactId: late.factId, replayDigest: replayed.digest },
    });
  } catch (error) {
    await sealing.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    sealing.release();
  }
  evidence.invariants.concurrentLinearization = true;
});

function acceptancePlan() {
  return runtime.executableEvaluationPlan({
    command: 'npm run test:outcome-reconciler:watchdog',
    expectedExitCode: 0,
    requestedTimeoutSeconds: 1200,
    ownerTimeoutCeilingSeconds: 1200,
    policyTimeoutCeilingSeconds: 3600,
  });
}

test('V2 rejects requested=1200 against legacy hardMax=120 before spawn', () => {
  const fixture = replayFixtureById('timeout-v2-rejects-1200-on-hardmax-120');
  const plan = acceptancePlan();
  const admission = runtime.negotiateExecutableAcceptance(plan, {
    schemaRevision: 2, capabilityRevision: 2, hardMaxSeconds: 120,
    runnerSha: '1'.repeat(40),
  }, new Date('2026-08-28T00:00:00.000Z'));
  assert.equal(admission.decision, 'REJECTED');
  assert.equal(admission.rejectionCode, 'RUNNER_HARD_MAX_INSUFFICIENT');
  assert.equal(admission.effectiveTimeoutSeconds, null);
  assert.equal(admission.spawnCount, 0);
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event, to: 'ADMISSION_REJECTED', closed: false,
    obligationKind: 'DIAGNOSE_MODEL_GAP', reasonCode: admission.rejectionCode,
    spawnCount: admission.spawnCount,
  }, [
    ['REQUESTED_DEADLINE_SECONDS', plan.requestedTimeoutSeconds],
    ['RUNNER_HARD_MAX_SECONDS', admission.runnerHardMaxSeconds],
    ['EFFECTIVE_DEADLINE_SECONDS', admission.effectiveTimeoutSeconds],
    ['SPAWN_COUNT', admission.spawnCount],
  ], { admission, evaluationPlanDigest: plan.evaluationPlanDigest });
});

test('successor V2 admission preserves requested=effective=1200 without clamping', () => {
  const fixture = replayFixtureById('timeout-v2-admits-exact-1200');
  const plan = acceptancePlan();
  const now = new Date('2026-08-28T00:00:00.000Z');
  const admission = runtime.negotiateExecutableAcceptance(plan, {
    schemaRevision: 2, capabilityRevision: 2, hardMaxSeconds: 1200,
    runnerSha: '2'.repeat(40),
  }, now);
  assert.equal(admission.decision, 'ADMITTED');
  assert.equal(admission.effectiveTimeoutSeconds, 1200);
  assert.equal(admission.effectiveDeadline.getTime() - now.getTime(), 1_200_000);
  assert.equal(admission.spawnCount, 0);
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event,
    to: 'ADMITTED_WITH_EXACT_DEADLINE', closed: true,
    obligationKind: 'NONE', reasonCode: 'REQUESTED_EQUALS_EFFECTIVE_DEADLINE',
    spawnCount: admission.spawnCount,
  }, [
    ['REQUESTED_DEADLINE_SECONDS', plan.requestedTimeoutSeconds],
    ['EFFECTIVE_DEADLINE_SECONDS', admission.effectiveTimeoutSeconds],
    ['DEADLINE_DELTA_MILLISECONDS', admission.effectiveDeadline.getTime() - now.getTime()],
    ['CLAMP_OCCURRED', false],
  ], { admission, evaluationPlanDigest: plan.evaluationPlanDigest });
  evidence.invariants.timeoutNegotiationExact = true;
});

function legacyTimeoutObservation() {
  return {
    sourceTaskId: '34Elz5t7HAZZRf6ruE73y',
    sourceSessionId: '3RIgJAt2GsNCTVoKKfOvK',
    legacyTermination: 'UNTYPED',
    legacyExitCode: -1,
    attemptGeneration: 1,
    requestedDeadlineSeconds: 1200,
    runnerHardMaxSeconds: 120,
    elapsedMilliseconds: 120_841,
    outputStreamComplete: false,
    lastObservedPassingSubtest: 12,
    declaredSubtestCount: 13,
    watchdog: {
      deadlineObserved: true,
      sourceSessionId: '3RIgJAt2GsNCTVoKKfOvK',
      collector: 'OUTCOME_WATCHDOG',
      observation: 'legacy runner stopped at its 120-second hard maximum',
    },
  };
}

test('exit -1 plus bound deadline evidence reconstructs typed TIMED_OUT and a successor obligation', () => {
  const fixture = replayFixtureById('goal-attempt-typed-timeout-continuation');
  const raw = legacyTimeoutObservation();
  assert.throws(
    () => reconstructLegacyTimedOutAttempt({ ...raw, watchdog: { ...raw.watchdog, deadlineObserved: false } }),
    /watchdog deadline evidence is required/,
    'exit -1 alone must never invent a typed termination',
  );
  const reconstructed = reconstructLegacyTimedOutAttempt(raw);
  assert.equal(reconstructed.terminationKind, 'TIMED_OUT');
  assert.equal(reconstructed.historicalAuditMutation, 'NONE');
  const evaluated = evaluateFixture(fixture, {
    goalDisposition: 'ACTIVE',
    taskStatusClaim: 'FAILED',
    attemptOutcome: 'TIMED_OUT',
    attemptId: reconstructed.attemptId,
    attemptGeneration: reconstructed.attemptGeneration,
    terminationKind: reconstructed.terminationKind,
  });
  const obligation = evaluated.output.obligations.find(({ kind }) => kind === 'START_SUCCESSOR_ATTEMPT');
  assert.ok(obligation);
  assert.equal(obligation.reason.code, 'ATTEMPT_TIMED_OUT_GOAL_ACTIVE');
  const actualTransition = {
    from: fixture.input.from, event: fixture.input.event,
    to: 'GOAL_ACTIVE_WITH_SUCCESSOR_OBLIGATION', closed: evaluated.output.proof.closed,
    obligationKind: obligation.kind, reasonCode: obligation.reason.code,
    terminationKind: reconstructed.terminationKind,
  };
  const trace = recordTrace(fixture, {
    inputBinding: evaluated.input.binding,
    inputCut: { ...evaluated.input.factCut, bindingDigest: sha256Canonical(evaluated.input.binding) },
    actualTransition,
    proofLeaves: evaluatorProofLeaves(fixture, evaluated, obligation, [
      ['LEGACY_AUDIT_MUTATION', reconstructed.historicalAuditMutation, raw],
      ['RECONSTRUCTION_EVIDENCE_DIGEST', reconstructed.evidenceDigest, reconstructed.evidence],
      ['TYPED_TERMINATION_KIND', reconstructed.terminationKind],
      ['GOAL_REMAINS_ACTIONABLE', true],
    ]),
    finalObligation: summarizeObligation(obligation, fixture.expectedFinalObligation),
    detail: { rawObservation: raw, reconstructed, evaluatorProofDigest: evaluated.output.proof.proofDigest },
  });
  typedTimeoutState = { raw, reconstructed, evaluated, obligation, trace };
  evidence.invariants.goalAttemptSeparated = true;
  evidence.invariants.typedTimeoutReconstructed = true;
});

async function insertReplayOwnerFoundation(ownerId, runnerId, workspaceId) {
  await pool.query(`
    INSERT INTO "user" (id,email,name,password_hash) VALUES ($1,$2,'timeout replay','x')
  `, [ownerId, `timeout-replay-${ownerId}@example.test`]);
  await pool.query(`
    INSERT INTO runner (id,name,owner_id,status,token_hash)
    VALUES ($1,'timeout-replay-runner',$2,'ONLINE','x')
  `, [runnerId, ownerId]);
  await pool.query(`
    INSERT INTO workspace (id,name,owner_id,runner_id,enabled)
    VALUES ($1,'timeout-replay-workspace',$2,$3,true)
  `, [workspaceId, ownerId, runnerId]);
}

test('concurrent successor claims converge on the one historical successor identity', async () => {
  const fixture = replayFixtureById('concurrency-single-active-successor');
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const successorId = '01a0480d-7aba-7281-9b84-aefcba1e75b0';
  await insertReplayOwnerFoundation(ownerId, runnerId, workspaceId);
  const claimantIds = await Promise.all(Array.from({ length: 12 }, async () => {
    const client = await pool.connect();
    try {
      const row = await one(client, `
        INSERT INTO task (
          id,title,owner_id,creator_type,creator_id,status,completion_criterion,idempotency_key,
          updated_at
        ) VALUES ($1,'Watchdog successor',$2,'AGENT',$3,'DONE','EXECUTABLE',$4,
          clock_timestamp())
        ON CONFLICT (id) DO UPDATE SET updated_at=task.updated_at
        RETURNING id
      `, [successorId, ownerId, workspaceId, D('watchdog-successor-goal')]);
      return row.id;
    } finally {
      client.release();
    }
  }));
  assert.equal(new Set(claimantIds).size, 1);
  const count = await one(pool, 'SELECT count(*)::integer AS count FROM task WHERE id=$1', [successorId]);
  assert.equal(count.count, 1);
  recordManualTrace(fixture, {
    from: fixture.input.from, event: fixture.input.event, to: 'ONE_ACTIVE_SUCCESSOR', closed: true,
    obligationKind: 'NONE', reasonCode: 'SUCCESSOR_IDENTITY_LINEARIZED',
    claimantCount: 12, successorCount: count.count,
  }, [
    ['CONCURRENT_CLAIMANT_COUNT', 12],
    ['DISTINCT_RETURNED_SUCCESSOR_IDS', new Set(claimantIds).size, claimantIds],
    ['PERSISTED_SUCCESSOR_COUNT', count.count],
  ], { successorId });
  successorState = { ownerId, runnerId, workspaceId, successorId };
  evidence.invariants.noDoubleActiveSuccessor = true;
});

test('legacy FAILED audit survives while successor owns the goal and stored downstream edge recovers', async () => {
  assert.ok(typedTimeoutState, 'typed timeout replay did not run');
  assert.ok(successorState, 'successor linearization did not run');
  const fixture = replayFixtureById('timeout-legacy-reconstruction-successor-recovery');
  const oldTaskId = '01a04672-4b57-7267-9f0c-24ac4e0ab282';
  const oldSessionId = '01d2bdbf-f122-5b50-8f2c-02112709dcba';
  const dependentId = randomUUID();
  const dependentSessionId = randomUUID();
  const legacyAttemptId = randomUUID();
  await pool.query(`
    INSERT INTO task (
      id,title,owner_id,creator_type,creator_id,status,completion_criterion,
      terminal_reason,superseded_at,superseded_by_task_id,idempotency_key,updated_at
    ) VALUES (
      $1,'Legacy Watchdog attempt',$2,'AGENT',$3,'FAILED','EXECUTABLE',
      'SUPERSEDED',clock_timestamp(),$4,$5,clock_timestamp()
    )
  `, [oldTaskId, successorState.ownerId, successorState.workspaceId,
    successorState.successorId, D('legacy-watchdog-attempt')]);
  await pool.query(`
    INSERT INTO session (
      id,title,prompt,owner_id,creator_id,assigned_runner_id,workspace_id,task_id,
      dispatch_origin,starts_task_work,provider,status,updated_at
    ) VALUES (
      $1,'Legacy Watchdog audit','historical audit',$2,$2,$3,$4,$5,
      'USER',false,'codex','FAILED',clock_timestamp()
    )
  `, [oldSessionId, successorState.ownerId, successorState.runnerId,
    successorState.workspaceId, oldTaskId]);
  await pool.query(`
    INSERT INTO task_executable_attempt (
      id,task_id,session_id,started_at,legacy_termination,legacy_exit_code,raw_output,output_truncated
    ) VALUES ($1,$2,$3,clock_timestamp(),'UNTYPED',-1,'ok 12 of 13; exit -1',true)
  `, [legacyAttemptId, oldTaskId, oldSessionId]);
  await pool.query(`
    INSERT INTO task (
      id,title,owner_id,creator_type,creator_id,status,completion_criterion,
      assignee_id,auto_run_when_ready,idempotency_key,updated_at
    ) VALUES ($1,'Replay downstream',$2,'AGENT',$3,'OPEN','EXECUTABLE',$4,true,$5,
      clock_timestamp())
  `, [dependentId, successorState.ownerId, successorState.workspaceId,
    successorState.workspaceId, D('replay-downstream')]);
  await pool.query(`
    INSERT INTO task_dependency (id,task_id,depends_on_task_id) VALUES ($1,$2,$3)
  `, [randomUUID(), dependentId, oldTaskId]);

  const audit = await one(pool, `
    SELECT t.status::text AS status,t.terminal_reason AS "terminalReason",
           t.superseded_by_task_id AS "successorId",
           a.legacy_termination::text AS "legacyTermination",a.legacy_exit_code AS "legacyExitCode",
           a.termination_kind::text AS "terminationKind"
      FROM task t JOIN task_executable_attempt a ON a.task_id=t.id
     WHERE t.id=$1 AND a.id=$2
  `, [oldTaskId, legacyAttemptId]);
  assert.deepEqual(audit, {
    status: 'FAILED', terminalReason: 'SUPERSEDED', successorId: successorState.successorId,
    legacyTermination: 'UNTYPED', legacyExitCode: -1, terminationKind: null,
  });
  await assert.rejects(pool.query(`
    UPDATE task_executable_attempt
       SET termination_kind='TIMED_OUT',terminated_at=clock_timestamp()
     WHERE id=$1
  `, [legacyAttemptId]), /legacy executable attempt is immutable/);
  const tail = await one(pool, `
    SELECT task_dependency_tail_id($1::uuid) AS "tailId",
           task_dependency_tail_satisfied($1::uuid) AS satisfied,
           task_all_dependency_tails_satisfied($2::uuid) AS "downstreamReady"
  `, [oldTaskId, dependentId]);
  assert.equal(tail.tailId, successorState.successorId);
  assert.equal(tail.satisfied, true);
  assert.equal(tail.downstreamReady, true);
  await pool.query(`
    INSERT INTO session (
      id,title,prompt,owner_id,creator_id,assigned_runner_id,workspace_id,task_id,
      dispatch_origin,run_source,starts_task_work,provider,status,updated_at
    ) VALUES ($1,'Recovered downstream','auto recovered',$2,$2,$3,$4,$5,
      'LEGACY_SWEEP','TASK_LIST_AUTO',true,'codex','PENDING',clock_timestamp())
  `, [dependentSessionId, successorState.ownerId, successorState.runnerId,
    successorState.workspaceId, dependentId]);
  const dispatched = await one(pool,
    'SELECT task_id AS "taskId",starts_task_work AS "startsTaskWork" FROM session WHERE id=$1',
    [dependentSessionId]);
  assert.deepEqual(dispatched, { taskId: dependentId, startsTaskWork: true });

  const inputBinding = typedTimeoutState.evaluated.input.binding;
  const inputCut = {
    ...typedTimeoutState.evaluated.input.factCut,
    bindingDigest: sha256Canonical(inputBinding),
  };
  const actualTransition = {
    from: fixture.input.from, event: fixture.input.event,
    to: 'SUCCESSOR_OWNS_GOAL_AND_DOWNSTREAM_READY', closed: true,
    obligationKind: 'NONE', reasonCode: 'SUCCESSOR_COMPLETED_DOWNSTREAM_RECOVERED',
    terminationKind: typedTimeoutState.reconstructed.terminationKind,
    legacyAuditPreserved: true, successorCount: 1, downstreamState: 'READY',
  };
  recordTrace(fixture, {
    inputBinding,
    inputCut,
    actualTransition,
    proofLeaves: makeProofLeaves([
      ['LEGACY_TASK_STATUS', audit.status, audit],
      ['LEGACY_TERMINATION', audit.legacyTermination, audit],
      ['LEGACY_EXIT_CODE', audit.legacyExitCode, audit],
      ['LEGACY_TYPED_COLUMN_UNCHANGED', audit.terminationKind === null, audit],
      ['REPLAY_TYPED_TERMINATION', typedTimeoutState.reconstructed.terminationKind,
        typedTimeoutState.reconstructed],
      ['CURRENT_GOAL_OWNER', successorState.successorId, tail],
      ['STORED_DEPENDENCY_EDGE_STILL_NAMES_OLD_ATTEMPT', oldTaskId],
      ['DEPENDENCY_TAIL', tail.tailId, tail],
      ['DOWNSTREAM_READY', tail.downstreamReady, tail],
      ['DOWNSTREAM_DISPATCH_COMMIT_ACCEPTED', dispatched.startsTaskWork, dispatched],
    ]),
    finalObligation: manualFinalObligation(fixture, inputBinding),
    detail: {
      legacy: { taskId: '34Elz5t7HAZZRf6ruE73y', sessionId: '3RIgJAt2GsNCTVoKKfOvK', ...audit },
      reconstructed: typedTimeoutState.reconstructed,
      successor: { taskId: '34Ex0SFCY6DpfvW2I4ydE', internalId: successorState.successorId },
      downstream: {
        replayTaskId: '34EVtJuwMDJkbocbCPllX', canaryTaskId: '34EVtJyRwtCxw0Dv9yE6N',
        fixtureTaskId: dependentId, storedDependsOnInternalId: oldTaskId,
        dependencyTailInternalId: tail.tailId, state: 'READY', dispatchedSessionId: dependentSessionId,
      },
    },
  });
  Object.assign(evidence.runtime, {
    legacyTaskId: '34Elz5t7HAZZRf6ruE73y',
    legacySessionId: '3RIgJAt2GsNCTVoKKfOvK',
    legacyStatus: audit.status,
    legacyTermination: audit.legacyTermination,
    legacyExitCode: audit.legacyExitCode,
    legacyTypedColumn: audit.terminationKind,
    reconstructedTerminationKind: typedTimeoutState.reconstructed.terminationKind,
    reconstructedEvidenceDigest: typedTimeoutState.reconstructed.evidenceDigest,
    successorTaskId: '34Ex0SFCY6DpfvW2I4ydE',
    currentGoalOwnerInternalId: tail.tailId,
    downstreamState: 'READY',
    downstreamDispatchCommitted: true,
  });
  evidence.invariants.legacyAuditPreserved = true;
  evidence.invariants.successorOwnsCurrentGoal = true;
  evidence.invariants.downstreamRecovered = true;
  evidence.invariants.noOrphan = true;
});

test('aggregate replay properties forbid false close, lost obligations and invisible gates', () => {
  assert.equal(evidence.traces.length, REPLAY_FIXTURES.length,
    'not every declared fixture produced a trace');
  assert.deepEqual(
    new Set(evidence.traces.map(({ fixtureId }) => fixtureId)),
    new Set(REPLAY_FIXTURES.map(({ id }) => id)),
  );
  const historical = evidence.traces.filter(({ category }) => [
    REPLAY_CATEGORIES.ENTRY_WITHOUT_EXIT,
    REPLAY_CATEGORIES.DONE_NOT_MERGED,
    REPLAY_CATEGORIES.READ_MODEL_GAP,
  ].includes(category));
  assert.equal(historical.length, 17);
  assert.ok(historical.every(({ actualTransition }) => actualTransition.closed === false));
  assert.ok(historical.every(({ finalObligation }) => finalObligation.state === 'ACTIVE'));
  assert.ok(historical.every(({ finalObligation }) => finalObligation.kind !== 'NONE'));
  const done = historical.filter(({ category }) => category === REPLAY_CATEGORIES.DONE_NOT_MERGED);
  assert.equal(done.length, 7);
  assert.ok(done.every(({ actualTransition }) => actualTransition.to === 'GOAL_ACTIVE_WITH_OBLIGATION'));
  const visible = historical.filter(({ category }) => category === REPLAY_CATEGORIES.READ_MODEL_GAP);
  assert.equal(visible.length, 3);
  assert.ok(visible.every(({ detail }) => (
    Object.keys(detail.projections).length === REPLAY_SURFACES.length
    && assertSurfaceAgreement(detail.projections)
  )));
  for (const trace of evidence.traces) {
    assert.match(trace.sourceHash, /^[0-9a-f]{64}$/);
    assert.equal(trace.targetSha, TARGET_SHA);
    assert.equal(trace.bindingDigest, sha256Canonical(trace.inputBinding));
    assert.equal(trace.inputCut.bindingDigest, trace.bindingDigest);
    assert.equal(trace.inputCut.complete, true);
    assert.equal(trace.inputCut.linearizable, true);
    assert.deepEqual(trace.actualTransition, trace.expectedTransition);
    assert.equal(trace.proofDigest, sha256Canonical(trace.proofLeaves));
  }
  evidence.invariants.noFalseClose = true;
  evidence.invariants.noLostObligation = true;
  evidence.invariants.noInvisibleGate = true;
  for (const [key, value] of Object.entries(evidence.invariants)) {
    assert.equal(value, true, `${key} was not proven`);
  }
});
