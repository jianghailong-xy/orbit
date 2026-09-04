import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FROZEN_ACTION_FIELDS,
  FROZEN_AUTHORITY_FIELDS,
  FROZEN_BINDING_FIELDS,
  FROZEN_CLOSED_CLAUSES,
  FROZEN_COMPLETION_DIMENSIONS,
  FROZEN_COMPLETION_STATES,
  FROZEN_CROSS_PROJECT_FIELDS,
  FROZEN_EVALUATION_TIME_FIELDS,
  FROZEN_FACT_FIELDS,
  FROZEN_GOAL_FIELDS,
  FROZEN_ATTEMPT_FIELDS,
  FROZEN_HUMAN_DECISION_KINDS,
  FROZEN_HANDOFF_STATUSES,
  FROZEN_NON_GOALS,
  FROZEN_OBLIGATION_EXITS,
  FROZEN_OBLIGATION_FIELDS,
  FROZEN_OBLIGATION_KINDS,
  FROZEN_OWNERSHIP_FIELDS,
  FROZEN_SOURCE_SURFACES,
  FROZEN_TIMER_FIELDS,
  assertFrozenContract,
  auditV1BlockerSignalExits,
  auditSourcePaths,
  canonicalJson,
  combineCompletionStates,
  computeContractDigest,
  computeEvaluationPlanDigest,
  evaluateOutcome,
  obligationRevision,
  sha256Canonical,
  stableObligationIdentity,
  validateActionSafetyEnvelope,
  validateCanonicalFact,
  validateDurableTimer,
  validateSourceAudit,
} from '../scripts/lib/outcome-reconciler-v2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(path.join(ROOT, 'contracts/outcome-reconciler-v2.contract.json'), 'utf8'));
const schema = JSON.parse(readFileSync(path.join(ROOT, 'contracts/outcome-reconciler-v2.schema.json'), 'utf8'));
const audit = JSON.parse(readFileSync(path.join(ROOT, 'contracts/outcome-reconciler-v2-source-audit.json'), 'utf8'));
const D = (label) => sha256Canonical({ label });
const EVALUATOR_DIGEST = sha256Canonical({ id: 'OUTCOME_RECONCILER', version: contract.evaluatorVersion });

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function binding(overrides = {}) {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    subjectType: 'PROJECT',
    subjectId: 'project-1',
    goalId: 'goal-1',
    goalRevision: '1',
    contractDigest: D('owner-contract'),
    evaluationPlanDigest: D('evaluation-plan'),
    policyDigest: D('policy'),
    riskPolicyDigest: D('risk-policy'),
    permissionDigest: D('permission'),
    authorityGrantDigest: D('authority'),
    budgetDigest: D('budget'),
    capabilityRegistryDigest: D('capabilities'),
    recipientDigest: D('recipients'),
    evaluatorDigest: EVALUATOR_DIGEST,
    factSchemaDigest: D('fact-schema'),
    environmentDigest: D('environment'),
    artifactDigest: D('artifact'),
    targetDigest: D('target'),
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '100',
    factCutDigest: D('fact-cut-binding'),
    ...overrides,
  };
}

function goal(bound = binding(), overrides = {}) {
  return {
    goalId: bound.goalId,
    goalRevision: bound.goalRevision,
    tenantId: bound.tenantId,
    projectId: bound.projectId,
    statement: 'Ship the exact ratified outcome.',
    contractDigest: bound.contractDigest,
    evaluationPlanDigest: bound.evaluationPlanDigest,
    ratification: {
      status: 'RATIFIED',
      ratifierType: 'OWNER',
      ratifierId: 'owner-1',
      contractDigest: bound.contractDigest,
      factId: 'ratification-fact-1',
    },
    disposition: 'ACHIEVED',
    ...overrides,
  };
}

function canonicalFact({
  factId,
  factKind,
  payload,
  logicalTime,
  bound = binding(),
  sourceSystem = 'ORBIT_CONTROL_PLANE',
}) {
  return {
    factId,
    factKind,
    tenantId: bound.tenantId,
    subject: {
      type: bound.subjectType,
      id: bound.subjectId,
      projectId: bound.projectId,
    },
    binding: bound,
    schemaVersion: 2,
    schemaDigest: bound.factSchemaDigest,
    payload,
    payloadDigest: sha256Canonical(payload),
    claimType: factKind.endsWith('_RECORDED') ? 'RECEIPT' : 'ATTESTATION',
    principal: {
      type: 'SYSTEM',
      id: 'outcome-fixture',
    },
    authority: {
      grantId: 'grant-1',
      grantDigest: bound.authorityGrantDigest,
      scopeDigest: D('scope'),
      delegationChainDigest: D('delegation'),
      validFromLogicalTime: '0',
      validThroughLogicalTime: null,
      revokedAtLogicalTime: null,
    },
    observedAt: '2026-08-28T00:00:00.000Z',
    recordedAt: '2026-08-28T00:00:01.000Z',
    logicalTime: String(logicalTime),
    causalPredecessorFactId: null,
    idempotencyKey: `fact:${factId}`,
    source: {
      system: sourceSystem,
      collectorId: 'fixture-collector',
      collectorVersion: '2.0.0',
    },
    signature: null,
  };
}

function dimensionFact(id, index, state = 'SATISFIED', bound = binding(), extras = {}) {
  return canonicalFact({
    factId: `dimension-${String(index).padStart(2, '0')}-${id}`,
    factKind: 'DIMENSION_EVALUATED',
    logicalTime: index + 1,
    bound,
    payload: {
      dimensionId: id,
      state,
      applicabilityProofDigest: state === 'NOT_APPLICABLE' ? D(`applicability:${id}`) : null,
      reasonCode: `${id}_${state}`,
      ...extras,
    },
  });
}

function attempt({ generation = '1', outcome = 'FAILED', status = 'CLOSED', bound = binding() } = {}) {
  return {
    attemptId: `attempt-${generation}`,
    attemptGeneration: generation,
    goalId: bound.goalId,
    goalRevision: bound.goalRevision,
    sessionId: `session-${generation}`,
    hypothesisDigest: D(`hypothesis-${generation}`),
    budgetDigest: bound.budgetDigest,
    startedAtLogicalTime: String(50 + Number(generation)),
    endedAtLogicalTime: status === 'CLOSED' ? String(60 + Number(generation)) : null,
    status,
    outcome: status === 'CLOSED' ? outcome : null,
  };
}

function cutFor(facts, bound = binding(), overrides = {}) {
  const sorted = [...facts].sort((left, right) => {
    const delta = BigInt(left.logicalTime) - BigInt(right.logicalTime);
    if (delta < 0n) return -1;
    if (delta > 0n) return 1;
    return left.factId.localeCompare(right.factId);
  });
  return {
    cutId: 'cut-1',
    tenantId: bound.tenantId,
    projectId: bound.projectId,
    watermarkLogicalTime: '100',
    factIds: sorted.map((fact) => fact.factId),
    factCount: sorted.length,
    factSetDigest: sha256Canonical(sorted),
    openedAt: '2026-08-28T00:00:02.000Z',
    sealedAt: '2026-08-28T00:00:03.000Z',
    complete: true,
    linearizable: true,
    collectorVersion: 'fixture-collector/2.0.0',
    ...overrides,
  };
}

function perfectInput(overrides = {}) {
  const bound = overrides.binding ?? binding();
  const facts = overrides.facts ?? FROZEN_COMPLETION_DIMENSIONS.map((id, index) => dimensionFact(id, index, 'SATISFIED', bound));
  return {
    goal: overrides.goal ?? goal(bound),
    binding: bound,
    factCut: overrides.factCut ?? cutFor(facts, bound),
    facts,
    clock: overrides.clock ?? {
      logicalNow: '100',
      clockId: 'outcome-logical-clock',
      evaluatedThroughLogicalTime: '100',
    },
    durableTimers: overrides.durableTimers ?? [],
    declaredObligations: overrides.declaredObligations ?? [],
  };
}

function rebuildFacts(input, facts) {
  return {
    ...input,
    facts,
    factCut: cutFor(facts, input.binding, {
      complete: input.factCut.complete,
      linearizable: input.factCut.linearizable,
    }),
  };
}

function replaceFact(input, factId, update) {
  const facts = input.facts.map((fact) => {
    if (fact.factId !== factId) return fact;
    const next = update(clone(fact));
    next.payloadDigest = sha256Canonical(next.payload);
    return next;
  });
  return rebuildFacts(input, facts);
}

function assertContractMutationRejected(mutator) {
  const candidate = clone(contract);
  mutator(candidate);
  assert.throws(() => assertFrozenContract(candidate, schema), /OUTCOME_CONTRACT_INVALID/);
}

function assertSchemaMutationRejected(mutator) {
  const candidate = clone(schema);
  mutator(candidate);
  assert.throws(() => assertFrozenContract(contract, candidate), /OUTCOME_CONTRACT_INVALID/);
}

function validActionEnvelope() {
  return {
    actionIntentId: 'action-intent-1',
    tenantId: 'tenant-1',
    obligationId: D('obligation-id'),
    obligationRevision: D('obligation-revision'),
    effectClass: 'EXTERNAL_REVERSIBLE',
    resourceType: 'GIT_REFERENCE',
    resourceId: 'repo-1:refs/heads/main',
    targetDigest: D('action-target'),
    authorityGrantDigest: D('authority'),
    policyDigest: D('policy'),
    preconditionDigest: D('precondition'),
    evaluatedThroughLogicalTime: '100',
    idempotencyKey: 'action:stable-key',
    budget: {
      accountId: 'project-budget',
      unit: 'external-write',
      charge: 1,
      limit: 3,
      reservationId: 'reservation-1',
    },
    retryPolicy: {
      maxAttempts: 3,
      backoffDigest: D('backoff'),
      sameFailureFingerprintLimit: 2,
    },
    compensation: {
      compensatorCapability: 'git.reference.restore',
      manualRecovery: null,
      remediationObligationKind: 'REMEDIATE_SIDE_EFFECT',
    },
    receiptRequirements: {
      providerIdentity: true,
      effectDigest: true,
      observedAt: true,
      result: true,
      idempotencyKey: true,
    },
  };
}

test('the checked-in schema and semantic registry satisfy the independently frozen V2 invariants', () => {
  assert.equal(assertFrozenContract(contract, schema), true);
});

test('the source audit covers the frozen surfaces and resolves every writer/reader symbol', () => {
  assert.equal(validateSourceAudit(audit, contract, ROOT), true);
  assert.deepEqual(audit.surfaces.map((entry) => entry.id), FROZEN_SOURCE_SURFACES);
  assert.ok(auditSourcePaths(audit).length >= 20);
});

test('the live V1 blocker and durable-signal type set has one concrete registered exit per episode', () => {
  const coverage = auditV1BlockerSignalExits(ROOT);
  assert.ok(coverage.declared.length >= 25);
  assert.deepEqual(coverage.unregistered, []);
  assert.deepEqual(coverage.stale, []);
  assert.deepEqual(coverage.duplicateRegistrations, []);
});

test('deleting any live V1 blocker/signal exit is detected by declaration-to-registry coverage', () => {
  const sourcePath = path.join(ROOT, 'src/apiserver/src/common/blocker-signal-exit-inventory.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const withoutOneExit = source.replace(
    /\s*\{\s*family:\s*'PROJECT_BLOCKER',[\s\S]*?\n\s*\},/,
    '',
  );
  const coverage = auditV1BlockerSignalExits(ROOT, withoutOneExit);
  assert.equal(coverage.unregistered.length, 1);
});

test('the frozen scope explicitly excludes only hardened presence, full history migration and a general SaaS saga', () => {
  assert.deepEqual(contract.nonGoals, FROZEN_NON_GOALS);
});

for (const dimensionId of FROZEN_COMPLETION_DIMENSIONS) {
  test(`contract mutation: deleting completion dimension ${dimensionId} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.completionDimensions = candidate.completionDimensions.filter((entry) => entry.id !== dimensionId);
    });
  });
  test(`schema mutation: deleting completion dimension branch ${dimensionId} is refused`, () => {
    assertSchemaMutationRejected((candidate) => {
      candidate.$defs.CompletionDimensionId.enum = candidate.$defs.CompletionDimensionId.enum.filter((entry) => entry !== dimensionId);
    });
  });
}

for (const state of FROZEN_COMPLETION_STATES) {
  test(`contract mutation: deleting five-state algebra branch ${state} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.stateAlgebra.states = candidate.stateAlgebra.states.filter((entry) => entry !== state);
    });
  });
  test(`schema mutation: deleting state enum branch ${state} is refused`, () => {
    assertSchemaMutationRejected((candidate) => {
      candidate.$defs.CompletionState.enum = candidate.$defs.CompletionState.enum.filter((entry) => entry !== state);
    });
  });
}

for (const field of FROZEN_BINDING_FIELDS) {
  test(`contract mutation: deleting binding field ${field} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.bindingContract.requiredFields = candidate.bindingContract.requiredFields.filter((entry) => entry !== field);
    });
  });
  test(`schema mutation: deleting binding field ${field} is refused`, () => {
    assertSchemaMutationRejected((candidate) => {
      candidate.$defs.Binding.required = candidate.$defs.Binding.required.filter((entry) => entry !== field);
    });
  });
}

for (const field of FROZEN_AUTHORITY_FIELDS) {
  test(`contract mutation: deleting authority field ${field} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.trustEnvelope.authorityRequiredFields = candidate.trustEnvelope.authorityRequiredFields.filter((entry) => entry !== field);
    });
  });
  test(`schema mutation: deleting authority field ${field} is refused`, () => {
    assertSchemaMutationRejected((candidate) => {
      candidate.$defs.Authority.required = candidate.$defs.Authority.required.filter((entry) => entry !== field);
    });
  });
}

for (const field of FROZEN_FACT_FIELDS) {
  test(`canonical fact runtime: deleting trust-envelope field ${field} is refused`, () => {
    const fact = dimensionFact('GOAL_DISPOSITION', 0);
    delete fact[field];
    assert.throws(() => validateCanonicalFact(fact, contract), /OUTCOME_CONTRACT_INVALID/);
  });
}

for (const field of FROZEN_EVALUATION_TIME_FIELDS) {
  test(`contract mutation: deleting logical evaluation time field ${field} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.logicalTimeContract.evaluationRequiredFields = candidate.logicalTimeContract.evaluationRequiredFields.filter((entry) => entry !== field);
    });
  });
}

for (const field of FROZEN_TIMER_FIELDS) {
  test(`contract mutation: deleting durable timer field ${field} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.logicalTimeContract.timerRequiredFields = candidate.logicalTimeContract.timerRequiredFields.filter((entry) => entry !== field);
    });
  });
  test(`schema mutation: deleting durable timer field ${field} is refused`, () => {
    assertSchemaMutationRejected((candidate) => {
      candidate.$defs.DurableTimer.required = candidate.$defs.DurableTimer.required.filter((entry) => entry !== field);
    });
  });
}

for (const field of FROZEN_GOAL_FIELDS) {
  test(`contract mutation: deleting Goal field ${field} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.goalAttemptContract.goalRequiredFields = candidate.goalAttemptContract.goalRequiredFields.filter((entry) => entry !== field);
    });
  });
}

for (const field of FROZEN_ATTEMPT_FIELDS) {
  test(`contract mutation: deleting Attempt field ${field} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.goalAttemptContract.attemptRequiredFields = candidate.goalAttemptContract.attemptRequiredFields.filter((entry) => entry !== field);
    });
  });
}

for (const field of FROZEN_OBLIGATION_FIELDS) {
  test(`contract mutation: deleting obligation field ${field} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.obligationContract.requiredFields = candidate.obligationContract.requiredFields.filter((entry) => entry !== field);
    });
  });
}

for (const field of FROZEN_CROSS_PROJECT_FIELDS) {
  test(`contract mutation: deleting cross-project declaration ${field} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      delete candidate.crossProjectContract[field];
    });
  });
}

for (const field of FROZEN_OWNERSHIP_FIELDS) {
  test(`schema mutation: deleting ownership field ${field} is refused`, () => {
    assertSchemaMutationRejected((candidate) => {
      candidate.$defs.ObligationOwnership.required = candidate.$defs.ObligationOwnership.required.filter((entry) => entry !== field);
    });
  });
}

for (const status of FROZEN_HANDOFF_STATUSES) {
  test(`contract mutation: deleting handoff status ${status} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.crossProjectContract.handoffStatuses = candidate.crossProjectContract.handoffStatuses.filter((entry) => entry !== status);
    });
  });
  test(`schema mutation: deleting handoff status ${status} is refused`, () => {
    assertSchemaMutationRejected((candidate) => {
      candidate.$defs.ObligationOwnership.properties.handoffStatus.enum = candidate.$defs.ObligationOwnership.properties.handoffStatus.enum.filter((entry) => entry !== status);
    });
  });
}

for (const exit of FROZEN_OBLIGATION_EXITS) {
  test(`contract mutation: deleting obligation exit ${exit} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.obligationContract.exits = candidate.obligationContract.exits.filter((entry) => entry !== exit);
    });
  });
  test(`contract mutation: deleting runtime resolver for ${exit} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.obligationContract.resolverProfiles[0].resolvers = candidate.obligationContract.resolverProfiles[0].resolvers.filter((entry) => entry.exit !== exit);
    });
  });
}

for (const kind of FROZEN_OBLIGATION_KINDS) {
  test(`contract mutation: deleting obligation kind ${kind} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.obligationContract.kinds = candidate.obligationContract.kinds.filter((entry) => entry.kind !== kind);
    });
  });
}

for (const field of FROZEN_ACTION_FIELDS) {
  test(`contract mutation: deleting action safety field ${field} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.actionSafetyContract.requiredFields = candidate.actionSafetyContract.requiredFields.filter((entry) => entry !== field);
    });
  });
  test(`runtime action envelope: deleting action safety field ${field} is refused`, () => {
    const envelope = validActionEnvelope();
    delete envelope[field];
    assert.throws(() => validateActionSafetyEnvelope(envelope, contract), /OUTCOME_CONTRACT_INVALID/);
  });
}

for (const clause of FROZEN_CLOSED_CLAUSES) {
  test(`contract mutation: deleting closed iff clause ${clause} is refused`, () => {
    assertContractMutationRejected((candidate) => {
      candidate.closedContract.clauses = candidate.closedContract.clauses.filter((entry) => entry !== clause);
    });
  });
}

for (const surfaceId of FROZEN_SOURCE_SURFACES) {
  test(`source audit mutation: deleting audited surface ${surfaceId} is refused`, () => {
    const candidate = clone(audit);
    candidate.surfaces = candidate.surfaces.filter((entry) => entry.id !== surfaceId);
    assert.throws(() => validateSourceAudit(candidate, contract, ROOT), /OUTCOME_CONTRACT_INVALID/);
  });
}

test('source audit mutation: a writer symbol that no longer exists is refused', () => {
  const candidate = clone(audit);
  candidate.surfaces[0].writers[0].symbol = 'THIS_WRITER_DOES_NOT_EXIST';
  assert.throws(() => validateSourceAudit(candidate, contract, ROOT), /OUTCOME_CONTRACT_INVALID/);
});

test('the five-state combine operation is total, commutative, associative and idempotent', () => {
  for (const a of FROZEN_COMPLETION_STATES) {
    assert.equal(combineCompletionStates(a, a, contract), a);
    for (const b of FROZEN_COMPLETION_STATES) {
      assert.ok(FROZEN_COMPLETION_STATES.includes(combineCompletionStates(a, b, contract)));
      assert.equal(combineCompletionStates(a, b, contract), combineCompletionStates(b, a, contract));
      for (const c of FROZEN_COMPLETION_STATES) {
        assert.equal(
          combineCompletionStates(combineCompletionStates(a, b, contract), c, contract),
          combineCompletionStates(a, combineCompletionStates(b, c, contract), contract),
        );
      }
    }
  }
});

test('a complete trusted proof closes if and only if every frozen closure clause is true', () => {
  const output = evaluateOutcome(perfectInput(), contract, schema);
  assert.equal(output.proof.closed, true);
  assert.deepEqual(Object.keys(output.proof.closedClauseResults), FROZEN_CLOSED_CLAUSES);
  assert.ok(Object.values(output.proof.closedClauseResults).every(Boolean));
  assert.equal(output.obligations.length, 0);
  assert.match(output.proof.proofDigest, /^[0-9a-f]{64}$/);
});

for (const dimensionId of FROZEN_COMPLETION_DIMENSIONS) {
  test(`closed safety: missing ${dimensionId} evidence yields UNKNOWN and cannot close`, () => {
    const input = perfectInput();
    const facts = input.facts.filter((fact) => fact.payload.dimensionId !== dimensionId);
    const output = evaluateOutcome(rebuildFacts(input, facts), contract, schema);
    assert.equal(output.proof.closed, false);
    assert.equal(output.proof.dimensions.find((entry) => entry.dimensionId === dimensionId).state, 'UNKNOWN');
    assert.ok(output.obligations.some((entry) => entry.blocksClosureOf.includes(dimensionId)));
  });
}

for (const state of ['UNSATISFIED', 'UNKNOWN']) {
  test(`closed safety: ${state} cannot close`, () => {
    const input = perfectInput();
    const target = input.facts.find((fact) => fact.payload.dimensionId === 'CRITERIA_EVALUATION');
    const changed = replaceFact(input, target.factId, (fact) => {
      fact.payload.state = state;
      fact.payload.reasonCode = `FIXTURE_${state}`;
      return fact;
    });
    const output = evaluateOutcome(changed, contract, schema);
    assert.equal(output.proof.closed, false);
    assert.equal(output.proof.dimensions.find((entry) => entry.dimensionId === 'CRITERIA_EVALUATION').state, state);
  });
}

test('closed safety: contradictory current authoritative facts produce CONFLICT', () => {
  const input = perfectInput();
  const original = input.facts.find((fact) => fact.payload.dimensionId === 'CRITERIA_EVALUATION');
  const conflict = canonicalFact({
    factId: 'dimension-conflict-criteria',
    factKind: 'DIMENSION_EVALUATED',
    logicalTime: original.logicalTime,
    bound: input.binding,
    payload: {
      dimensionId: 'CRITERIA_EVALUATION',
      state: 'UNSATISFIED',
      applicabilityProofDigest: null,
      reasonCode: 'CONTRADICTORY_EVIDENCE',
    },
  });
  const output = evaluateOutcome(rebuildFacts(input, [...input.facts, conflict]), contract, schema);
  assert.equal(output.proof.closed, false);
  assert.equal(output.proof.dimensions.find((entry) => entry.dimensionId === 'CRITERIA_EVALUATION').state, 'CONFLICT');
});

test('NOT_APPLICABLE is closure-eligible only with a current applicability proof and only on declared dimensions', () => {
  const input = perfectInput();
  const target = input.facts.find((fact) => fact.payload.dimensionId === 'ARTIFACT_INTEGRATION');
  const allowed = replaceFact(input, target.factId, (fact) => {
    fact.payload.state = 'NOT_APPLICABLE';
    fact.payload.applicabilityProofDigest = D('no-code-artifact');
    return fact;
  });
  assert.equal(evaluateOutcome(allowed, contract, schema).proof.closed, true);

  const missingProof = replaceFact(input, target.factId, (fact) => {
    fact.payload.state = 'NOT_APPLICABLE';
    fact.payload.applicabilityProofDigest = null;
    return fact;
  });
  const missingOutput = evaluateOutcome(missingProof, contract, schema);
  assert.equal(missingOutput.proof.closed, false);
  assert.equal(missingOutput.proof.dimensions.find((entry) => entry.dimensionId === 'ARTIFACT_INTEGRATION').state, 'UNKNOWN');

  const forbiddenTarget = input.facts.find((fact) => fact.payload.dimensionId === 'GOAL_DISPOSITION');
  const forbidden = replaceFact(input, forbiddenTarget.factId, (fact) => {
    fact.payload.state = 'NOT_APPLICABLE';
    fact.payload.applicabilityProofDigest = D('forbidden');
    return fact;
  });
  assert.equal(evaluateOutcome(forbidden, contract, schema).proof.closed, false);
});

test('an empty reducer cut is a MODEL_GAP, never vacuous success', () => {
  const input = perfectInput({ facts: [] });
  input.factCut = cutFor([], input.binding);
  const output = evaluateOutcome(input, contract, schema);
  assert.equal(output.proof.closed, false);
  assert.ok(output.proof.modelGaps.includes('EMPTY_FACT_CUT'));
  assert.equal(output.proof.dimensions.length, FROZEN_COMPLETION_DIMENSIONS.length);
});

test('V1 task status DONE alone is a claim and cannot close the goal', () => {
  const bound = binding();
  const statusFact = canonicalFact({
    factId: 'legacy-task-done',
    factKind: 'TASK_STATUS_OBSERVED',
    logicalTime: 1,
    bound,
    payload: { status: 'DONE', protocol: 'V1' },
  });
  const input = perfectInput({ binding: bound, facts: [statusFact] });
  input.factCut = cutFor(input.facts, bound);
  const output = evaluateOutcome(input, contract, schema);
  assert.equal(output.proof.closed, false);
  assert.ok(output.proof.dimensions.every((entry) => entry.state === 'UNKNOWN'));
});

test('an attempt success alone is not a goal disposition and cannot close', () => {
  const bound = binding();
  const run = attempt({ generation: '1', outcome: 'SUCCEEDED', bound });
  const runFact = canonicalFact({
    factId: 'attempt-succeeded',
    factKind: 'ATTEMPT_TERMINATED',
    logicalTime: 70,
    bound,
    payload: { attempt: run },
  });
  const input = perfectInput({
    binding: bound,
    goal: goal(bound, { disposition: 'ACTIVE' }),
    facts: [runFact],
  });
  input.factCut = cutFor(input.facts, bound);
  const output = evaluateOutcome(input, contract, schema);
  assert.equal(output.proof.closed, false);
  assert.equal(output.attempts[0].outcome, 'SUCCEEDED');
});

for (const terminalOutcome of ['FAILED', 'CANCELLED', 'TIMED_OUT']) {
  test(`${terminalOutcome} terminates an attempt but an active goal derives a stable successor obligation`, () => {
    const bound = binding();
    const make = (generation) => {
      const run = attempt({ generation, outcome: terminalOutcome, bound });
      const runFact = canonicalFact({
        factId: `attempt-${generation}-${terminalOutcome}`,
        factKind: 'ATTEMPT_TERMINATED',
        logicalTime: 70 + Number(generation),
        bound,
        payload: { attempt: run },
      });
      const input = perfectInput({
        binding: bound,
        goal: goal(bound, { disposition: 'ACTIVE' }),
        facts: [runFact],
      });
      input.factCut = cutFor(input.facts, bound);
      return evaluateOutcome(input, contract, schema);
    };
    const first = make('1');
    const second = make('2');
    const a = first.obligations.find((entry) => entry.kind === 'START_SUCCESSOR_ATTEMPT');
    const b = second.obligations.find((entry) => entry.kind === 'START_SUCCESSOR_ATTEMPT');
    assert.ok(a && b);
    assert.equal(a.obligationId, b.obligationId, 'attempt generation must not churn logical obligation identity');
    assert.equal(first.proof.closed, false);
  });
}

test('stable obligation identity excludes attempts, sessions, leases, wall time and prose', () => {
  const base = {
    tenantId: 'tenant-1',
    goalId: 'goal-1',
    goalRevision: '1',
    contractDigest: D('owner-contract'),
    kind: 'SATISFY_COMPLETION_DIMENSION',
    subjectType: 'COMPLETION_DIMENSION',
    subjectId: 'CRITERIA_EVALUATION',
    homeProjectId: 'project-1',
  };
  const one = stableObligationIdentity({ ...base, attemptId: 'attempt-1', sessionId: 'session-1', reasonText: 'first wording' }, contract);
  const two = stableObligationIdentity({ ...base, attemptId: 'attempt-99', sessionId: 'session-99', reasonText: 'different wording' }, contract);
  assert.equal(one, two);
  assert.notEqual(one, stableObligationIdentity({ ...base, goalRevision: '2' }, contract));
});

test('binding changes preserve logical obligation identity but advance obligation revision', () => {
  const identity = D('stable-obligation');
  const revisionInput = {
    obligationId: identity,
    bindingDigest: D('binding-1'),
    authorityGrantDigest: D('authority'),
    reasonCode: 'MISSING_EVIDENCE',
    owner: 'AGENT',
    capability: 'dimension.satisfy',
    actionProtocolDigest: D('agent-protocol'),
    dueLogicalTime: null,
  };
  const one = obligationRevision(revisionInput, contract);
  const two = obligationRevision({ ...revisionInput, bindingDigest: D('binding-2') }, contract);
  assert.notEqual(one, two);
});

test('contractDigest and evaluationPlanDigest bind disjoint material', () => {
  const ownerContract = {
    goal: 'ship outcome',
    outcomes: ['merged', 'verified'],
    riskBoundary: 'no production mutation',
    criteria: ['all checks pass'],
    ownerId: 'owner-1',
    templateDigest: null,
    delegationDigest: null,
  };
  const plan = {
    verifiers: ['ci'],
    collectorVersions: ['collector@2'],
    environment: 'clean target SHA',
  };
  const contractDigest = computeContractDigest(ownerContract, contract);
  const planDigest = computeEvaluationPlanDigest(plan, contract);
  assert.notEqual(contractDigest, planDigest);
  assert.equal(computeContractDigest(ownerContract, contract), contractDigest);
  assert.notEqual(computeContractDigest({ ...ownerContract, goal: 'changed goal' }, contract), contractDigest);
  assert.equal(computeContractDigest(ownerContract, contract), contractDigest, 'plan edits cannot alter owner semantic digest');
  assert.notEqual(computeEvaluationPlanDigest({ ...plan, verifiers: ['ci', 'nightly'] }, contract), planDigest);
});

test('an unratified or stale ratification cannot close even when every evaluator dimension says satisfied', () => {
  for (const status of ['UNRATIFIED', 'STALE']) {
    const input = perfectInput();
    input.goal.ratification.status = status;
    const output = evaluateOutcome(input, contract, schema);
    assert.equal(output.proof.closed, false);
    assert.equal(output.proof.closedClauseResults.CONTRACT_RATIFIED_FOR_EXACT_CONTRACT_DIGEST, false);
  }
});

test('an ordinary runner cannot ratify the contract registry', () => {
  assert.equal(contract.digestContract.ordinaryRunnerMayRatify, false);
  assert.ok(!contract.digestContract.allowedRatifers.includes('RUNNER'));
});

test('a stale-binding fact is rejected and cannot be used as proof', () => {
  const input = perfectInput();
  const staleBound = binding({ targetDigest: D('old-target') });
  const stale = dimensionFact('CRITERIA_EVALUATION', 99, 'SATISFIED', staleBound);
  const facts = input.facts.filter((fact) => fact.payload.dimensionId !== 'CRITERIA_EVALUATION').concat(stale);
  const output = evaluateOutcome(rebuildFacts(input, facts), contract, schema);
  assert.equal(output.proof.closed, false);
  assert.deepEqual(output.rejectedFacts, [{ factId: stale.factId, decision: 'OUT_OF_SCOPE' }]);
  assert.equal(output.proof.dimensions.find((entry) => entry.dimensionId === 'CRITERIA_EVALUATION').state, 'UNKNOWN');
});

test('revoked authority is rejected at the evaluation cut', () => {
  const input = perfectInput();
  const target = input.facts[0];
  const revoked = clone(target);
  revoked.authority.revokedAtLogicalTime = '50';
  const output = evaluateOutcome(rebuildFacts(input, input.facts.map((fact) => fact.factId === target.factId ? revoked : fact)), contract, schema);
  assert.equal(output.proof.closed, false);
  assert.ok(output.rejectedFacts.some((entry) => entry.factId === target.factId && entry.decision === 'REVOKED'));
});

test('a projection cannot be submitted in a canonical trust envelope', () => {
  const fact = dimensionFact('GOAL_DISPOSITION', 0);
  fact.source.system = 'PROJECTION:DONE_GATE';
  assert.throws(() => validateCanonicalFact(fact, contract), /projection cannot be submitted as authority/);
});

test('payload tampering is detected independently of fact prose', () => {
  const fact = dimensionFact('GOAL_DISPOSITION', 0);
  fact.payload.state = 'UNSATISFIED';
  assert.throws(() => validateCanonicalFact(fact, contract), /payloadDigest/);
});

test('the reducer is deterministic, order-independent inside a sealed cut, and does not mutate frozen input', () => {
  const input = perfectInput();
  const expected = evaluateOutcome(input, contract, schema);
  const reversed = { ...clone(input), facts: [...input.facts].reverse() };
  deepFreeze(input);
  const again = evaluateOutcome(input, contract, schema);
  const reordered = evaluateOutcome(reversed, contract, schema);
  assert.equal(canonicalJson(again), canonicalJson(expected));
  assert.equal(canonicalJson(reordered), canonicalJson(expected));
  assert.ok(Object.isFrozen(input));
});

test('the reducer takes logical time explicitly and never consults wall time for decisions', () => {
  assert.deepEqual(contract.logicalTimeContract.evaluationRequiredFields, FROZEN_EVALUATION_TIME_FIELDS);
  assert.equal(contract.logicalTimeContract.wallClockDecisionUse, 'FORBIDDEN');
  const input = perfectInput();
  input.clock.logicalNow = '99';
  assert.throws(() => evaluateOutcome(input, contract, schema), /logicalNow is behind/);
});

test('an overdue durable timer yields a recovery obligation until an idempotent TIMER_FIRED fact exists', () => {
  const base = perfectInput();
  const unknownInput = rebuildFacts(
    base,
    base.facts.filter((fact) => fact.payload.dimensionId !== 'CRITERIA_EVALUATION'),
  );
  const pending = evaluateOutcome(unknownInput, contract, schema).obligations.find((entry) => entry.blocksClosureOf.includes('CRITERIA_EVALUATION'));
  assert.ok(pending);
  const timer = {
    timerId: 'timer-1',
    tenantId: base.binding.tenantId,
    goalId: base.goal.goalId,
    obligationId: pending.obligationId,
    obligationRevision: pending.obligationRevision,
    bindingDigest: sha256Canonical(base.binding),
    clockId: 'outcome-logical-clock',
    dueLogicalTime: '90',
    dueAt: '2026-08-28T00:10:00.000Z',
    scheduleFactId: 'timer-scheduled-1',
    state: 'SCHEDULED',
    deliveryAttempt: 0,
    wakeId: 'wake-timer-1',
    timeoutExit: 'TIMEOUT',
  };
  validateDurableTimer(timer, contract);
  const overdue = evaluateOutcome({ ...base, durableTimers: [timer] }, contract, schema);
  assert.equal(overdue.proof.closed, false);
  assert.ok(overdue.obligations.some((entry) => entry.kind === 'RECOVER_RECONCILER'));
  assert.ok(overdue.proof.modelGaps.includes('OVERDUE_DURABLE_TIMER'));
});

test('an active mandatory obligation blocks closure across every projection consumer', () => {
  const incomplete = perfectInput();
  const facts = incomplete.facts.filter((fact) => fact.payload.dimensionId !== 'CRITERIA_EVALUATION');
  const obligation = evaluateOutcome(rebuildFacts(incomplete, facts), contract, schema).obligations.find((entry) => entry.blocksClosureOf.includes('CRITERIA_EVALUATION'));
  const output = evaluateOutcome(perfectInput({ declaredObligations: [obligation] }), contract, schema);
  assert.equal(output.proof.closed, false);
  assert.equal(output.proof.closedClauseResults.NO_ACTIVE_MANDATORY_OBLIGATION, false);
  assert.deepEqual(contract.projectionContract.consumers, ['DONE_GATE', 'AGENT_QUEUE', 'OWNER_DECISION_INBOX', 'PROJECT_ATTENTION', 'MUTATION_RESPONSE', 'WEB']);
  assert.ok(output.projectionSeed.every((entry) => entry.obligationId === obligation.obligationId));
});

test('servesCriterion and blocksClosureOf remain orthogonal, with explicit cross-project ownership', () => {
  assert.equal(contract.crossProjectContract.servesCriterionAndBlocksClosureAreOrthogonal, true);
  const input = perfectInput();
  const facts = input.facts.filter((fact) => fact.payload.dimensionId !== 'EXTERNAL_CLOSURE_DEPENDENCIES');
  const obligation = evaluateOutcome(rebuildFacts(input, facts), contract, schema).obligations.find((entry) => entry.blocksClosureOf.includes('EXTERNAL_CLOSURE_DEPENDENCIES'));
  assert.ok(obligation);
  assert.deepEqual(obligation.servesCriterionIds, []);
  assert.deepEqual(obligation.blocksClosureOf, ['EXTERNAL_CLOSURE_DEPENDENCIES']);
  assert.equal(obligation.ownership.homeProjectId, input.goal.projectId);
});

test('foreign closure edges require explicit crossing, attribution and coherent handoff state without implicit adoption', () => {
  const incomplete = perfectInput();
  const facts = incomplete.facts.filter((fact) => fact.payload.dimensionId !== 'EXTERNAL_CLOSURE_DEPENDENCIES');
  const obligation = evaluateOutcome(rebuildFacts(incomplete, facts), contract, schema).obligations.find((entry) => entry.blocksClosureOf.includes('EXTERNAL_CLOSURE_DEPENDENCIES'));
  obligation.ownership.blockingProjectIds = ['project-2'];
  obligation.ownership.crossingId = 'crossing-1';
  obligation.ownership.handoffId = 'handoff-1';
  obligation.ownership.handoffStatus = 'ACCEPTED';
  obligation.ownership.attributionDecisionFactId = 'fact-attribution-1';
  assert.equal(evaluateOutcome(perfectInput({ declaredObligations: [obligation] }), contract, schema).proof.closed, false);

  for (const field of ['crossingId', 'attributionDecisionFactId']) {
    const invalid = clone(obligation);
    invalid.ownership[field] = null;
    assert.throws(() => evaluateOutcome(perfectInput({ declaredObligations: [invalid] }), contract, schema), /OUTCOME_CONTRACT_INVALID/);
  }

  const implicitlyAdopted = clone(obligation);
  implicitlyAdopted.ownership.homeProjectId = 'project-2';
  assert.throws(() => evaluateOutcome(perfectInput({ declaredObligations: [implicitlyAdopted] }), contract, schema), /OUTCOME_CONTRACT_INVALID/);

  const incoherentHandoff = clone(obligation);
  incoherentHandoff.ownership.handoffId = null;
  assert.throws(() => evaluateOutcome(perfectInput({ declaredObligations: [incoherentHandoff] }), contract, schema), /OUTCOME_CONTRACT_INVALID/);
});

test('only four value/authority decisions route to a human; ordinary external waits stay system-owned', () => {
  assert.deepEqual(contract.obligationContract.humanDecisionKinds, FROZEN_HUMAN_DECISION_KINDS);
  const byKind = new Map(contract.obligationContract.kinds.map((entry) => [entry.kind, entry]));
  for (const kind of FROZEN_HUMAN_DECISION_KINDS) {
    assert.equal(byKind.get(kind).defaultOwner, 'OWNER');
    assert.equal(byKind.get(kind).actionProtocolProfile, 'OWNER_DECISION');
  }
  assert.equal(byKind.get('MONITOR_EXTERNAL_WAIT').defaultOwner, 'SYSTEM');
  const ownerProfile = contract.obligationContract.actionProtocolProfiles.find((entry) => entry.id === 'OWNER_DECISION');
  assert.deepEqual(ownerProfile.requiredFields, ['whyNotAgent', 'options', 'impacts', 'recommendation', 'noActionConsequence', 'cost', 'deadline', 'resumeBehavior', 'idempotencyKey']);
});

test('all mandatory obligation exits are acyclic and runtime reachable by a registered current actor', () => {
  const profile = contract.obligationContract.resolverProfiles[0];
  const adapters = new Map(contract.obligationContract.runtimeAdapters.map((entry) => [entry.id, entry]));
  assert.deepEqual(profile.resolvers.map((entry) => entry.exit), FROZEN_OBLIGATION_EXITS);
  for (const resolver of profile.resolvers) {
    assert.equal(resolver.from, 'ACTIVE');
    assert.ok(adapters.get(resolver.adapter).actors.includes(resolver.actor));
  }
});

test('a resolver cycle or an adapter without the declared actor is rejected', () => {
  assertContractMutationRejected((candidate) => {
    candidate.obligationContract.resolverProfiles[0].resolvers[0].from = 'RESOLVED';
    candidate.obligationContract.resolverProfiles[0].resolvers[0].to = 'ACTIVE';
  });
  assertContractMutationRejected((candidate) => {
    candidate.obligationContract.runtimeAdapters.find((entry) => entry.id === 'DURABLE_TIMER_SERVICE').actors = ['AGENT'];
  });
});

test('the full action safety envelope accepts a bounded compensatable intent', () => {
  assert.equal(validateActionSafetyEnvelope(validActionEnvelope(), contract).idempotencyKey, 'action:stable-key');
});

test('actions fail closed without compensation/manual recovery, within-budget spend or finite fingerprint budget', () => {
  const noRecovery = validActionEnvelope();
  noRecovery.compensation.compensatorCapability = null;
  noRecovery.compensation.manualRecovery = null;
  assert.throws(() => validateActionSafetyEnvelope(noRecovery, contract), /compensator or manual recovery/);

  const overBudget = validActionEnvelope();
  overBudget.budget.charge = 4;
  assert.throws(() => validateActionSafetyEnvelope(overBudget, contract), /over budget/);

  const storm = validActionEnvelope();
  storm.retryPolicy.sameFailureFingerprintLimit = 4;
  assert.throws(() => validateActionSafetyEnvelope(storm, contract), /same-fingerprint budget/);
});

test('mixed-client boundary admits only known V1 lanes and refuses legacy authority, ratification, projection writes and direct DONE', () => {
  const boundary = contract.compatibilityBoundary;
  assert.deepEqual(boundary.acceptedLegacyProtocols, ['V1', 'V1_HEADERLESS_N_MINUS_ONE']);
  assert.equal(boundary.legacyDirectDone, 'REFUSE');
  assert.equal(boundary.legacyCompletionFallbackToHuman, 'REFUSE');
  assert.equal(boundary.legacyMayMintAuthority, false);
  assert.equal(boundary.legacyMayRatifyContract, false);
  assert.equal(boundary.legacyMayWriteProjection, false);
  assert.match(boundary.unknownRevision, /^REFUSE_/);
});

test('removing any compatibility boundary declaration is refused', () => {
  for (const field of Object.keys(contract.compatibilityBoundary)) {
    assertContractMutationRejected((candidate) => {
      delete candidate.compatibilityBoundary[field];
    });
  }
});
