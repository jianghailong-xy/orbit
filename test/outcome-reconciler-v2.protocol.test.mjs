import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FROZEN_BINDING_FIELDS,
  FROZEN_COMPLETION_STATES,
  FROZEN_OBLIGATION_KINDS,
  validateCanonicalFact,
} from '../scripts/lib/outcome-reconciler-v2.mjs';
import {
  PROTOCOL_TYPE_FIELDS,
  analyzeProtocolGraph,
  assertProtocolRegistry,
  createBuiltinCapabilityCatalog,
  createControlledProtocolRuntime,
  createProtocolFixture,
  executeProtocolAction,
  inspectProtocolRegistry,
  instantiateProtocolObligation,
  protocolBinding,
  protocolDisposition,
  runProtocolConformanceMatrix,
  timeoutProtocolObligation,
  validateProtocolObligation,
} from '../scripts/lib/outcome-reconciler-protocol-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (relativePath) => JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8'));
const registry = json('contracts/outcome-reconciler-v2.protocol-registry.json');
const contract = json('contracts/outcome-reconciler-v2.contract.json');
const clone = (value) => structuredClone(value);

function executeFixture(fixture, candidateRegistry = registry, overrides = {}) {
  return executeProtocolAction({
    registry: candidateRegistry,
    contract,
    kind: overrides.kind ?? fixture.obligation.kind,
    obligation: overrides.obligation ?? fixture.obligation,
    runtime: fixture.runtime,
    disposition: overrides.disposition ?? 'UNSATISFIED',
  });
}

function assertVisibleHandling(result, expectedCode) {
  assert.equal(result.code, expectedCode);
  assert.equal(result.visible, true);
  assert.equal(result.handleable, true);
  assert.equal(result.humanFallback, false);
  assert.ok(result.next?.kind);
  assert.ok(result.next?.action);
  assert.ok(result.facts.length > 0);
  for (const fact of result.facts) validateCanonicalFact(fact, contract);
}

test('the declarative registry is complete, contract-bound, callable and graph-safe at build time', () => {
  const compiled = assertProtocolRegistry(registry, contract);
  assert.deepEqual(compiled.types.map((entry) => entry.kind), FROZEN_OBLIGATION_KINDS);
  assert.equal(compiled.types.length, 16);
  assert.ok(compiled.types.every((entry) => entry.mandatory));
  const graph = analyzeProtocolGraph(compiled);
  assert.equal(graph.valid, true);
  assert.deepEqual(graph.noExitKinds, []);
  assert.equal(graph.diagnostics.length, 0);
});

test('every mandatory type declares every protocol concern without runtime defaults', () => {
  for (const declaration of registry.types) {
    assert.deepEqual(Object.keys(declaration).sort(), [...PROTOCOL_TYPE_FIELDS].sort());
    assert.ok(declaration.identityProfile);
    assert.deepEqual(declaration.binding.profile, 'EXACT_V2_BINDING');
    assert.ok(declaration.binding.subjectTypes.length > 0);
    assert.equal(declaration.dispositionProfile, 'MANDATORY_FIVE_STATE');
    assert.ok(declaration.goalAttemptProfile);
    assert.ok(declaration.actor.role);
    assert.ok(declaration.actor.capability);
    assert.ok(declaration.resolver.capability);
    assert.equal(declaration.resolver.actionId, declaration.action.id);
    assert.ok(declaration.action.effectClass);
    assert.ok(declaration.action.authorityScopes.length > 0);
    assert.ok(declaration.action.policyRules.length > 0);
    assert.ok(declaration.action.budgetCharge >= 0);
    assert.ok(Array.isArray(declaration.prerequisites));
    assert.ok(declaration.successFacts.length > 0);
    assert.ok(declaration.failureFacts.length > 0);
    assert.ok(declaration.timeout.logicalTicks > 0);
    assert.ok(declaration.retry.maxAttempts > 0);
    assert.ok(declaration.compensation.capability || declaration.compensation.manualRecovery);
    assert.ok(declaration.attribution.blocksClosureOf.length > 0);
  }
});

test('the five-state disposition is total and UNKNOWN/CONFLICT fail into MODEL_GAP', () => {
  const expected = {
    SATISFIED: ['RESOLVE', false],
    UNSATISFIED: ['EXECUTE_ACTION', true],
    UNKNOWN: ['MODEL_GAP', true],
    CONFLICT: ['MODEL_GAP', true],
    NOT_APPLICABLE: ['RESOLVE_NOT_APPLICABLE', false],
  };
  for (const state of FROZEN_COMPLETION_STATES) {
    const disposition = protocolDisposition(registry, contract, 'SATISFY_COMPLETION_DIMENSION', state);
    assert.deepEqual([disposition.directive, disposition.blocksClosure], expected[state]);
  }
  const unknown = protocolDisposition(registry, contract, 'SATISFY_COMPLETION_DIMENSION', 'SIXTH_STATE');
  assert.equal(unknown.directive, 'MODEL_GAP');
  assert.equal(unknown.blocksClosure, true);
});

for (const kind of FROZEN_OBLIGATION_KINDS) {
  test(`protocol conformance: ${kind}`, () => {
    const fixture = createProtocolFixture(registry, contract, kind);
    const before = fixture.runtime.facts.length;
    const result = executeFixture(fixture);
    assert.equal(result.status, 'RESOLVED');
    assert.equal(result.code, 'CONTROLLED_ACTION_RESOLVED');
    assert.equal(result.proof.activeAfter, false);
    assert.equal(fixture.runtime.activeObligations.has(fixture.obligation.obligationId), false);
    assert.ok(fixture.runtime.invocationLog.includes(fixture.declaration.actor.capability));
    assert.ok(fixture.runtime.invocationLog.includes(fixture.declaration.resolver.capability));
    assert.deepEqual(
      result.facts.map((fact) => fact.factKind),
      ['ACTION_INTENT_RECORDED', fixture.declaration.successFacts[0], 'OBLIGATION_EXIT_RECORDED'],
    );
    assert.equal(fixture.runtime.facts.length, before + 3);
    for (const fact of result.facts) validateCanonicalFact(fact, contract);
  });
}

test('the independent conformance matrix instantiates and executes every registered type', () => {
  const matrix = runProtocolConformanceMatrix(registry, contract);
  assert.equal(matrix.registered, FROZEN_OBLIGATION_KINDS.length);
  assert.equal(matrix.instantiated, matrix.registered);
  assert.equal(matrix.executed, matrix.registered);
  assert.equal(matrix.resolved, matrix.registered);
  assert.equal(matrix.validFacts, matrix.registered * 3);
  assert.deepEqual(matrix.traces.map((trace) => trace.kind), FROZEN_OBLIGATION_KINDS);
  assert.ok(matrix.traces.every((trace) => trace.activeAfter === false));
});

test('stable identity ignores attempts while binding changes advance the protocol revision', () => {
  const compiled = assertProtocolRegistry(registry, contract);
  const declaration = compiled.types.find((entry) => entry.kind === 'START_SUCCESSOR_ATTEMPT');
  const bound = protocolBinding(declaration.kind, declaration.binding.subjectTypes[0]);
  const one = instantiateProtocolObligation(compiled, contract, declaration.kind, { binding: bound });
  const runtime = createControlledProtocolRuntime(bound, { contract });
  runtime.attempt = { ...runtime.attempt, attemptId: 'attempt-other', attemptGeneration: '99' };
  const two = instantiateProtocolObligation(compiled, contract, declaration.kind, { binding: bound });
  const rebound = instantiateProtocolObligation(compiled, contract, declaration.kind, {
    binding: { ...bound, policyDigest: '1'.repeat(64) },
  });
  assert.equal(one.obligationId, two.obligationId);
  assert.equal(one.obligationRevision, two.obligationRevision);
  assert.equal(one.obligationId, rebound.obligationId);
  assert.notEqual(one.obligationRevision, rebound.obligationRevision);
});

test('SATISFIED and proven NOT_APPLICABLE resolve without spending an action budget', () => {
  for (const disposition of ['SATISFIED', 'NOT_APPLICABLE']) {
    const fixture = createProtocolFixture(registry, contract, 'SATISFY_COMPLETION_DIMENSION');
    const budget = fixture.runtime.budgets.get(fixture.binding.budgetDigest);
    const before = budget.remaining;
    const result = executeFixture(fixture, registry, { disposition });
    assert.equal(result.status, 'RESOLVED');
    assert.equal(result.action, null);
    assert.equal(result.proof.activeAfter, false);
    assert.equal(budget.remaining, before);
    assert.deepEqual(result.facts.map((fact) => fact.factKind), ['OBLIGATION_EXIT_RECORDED']);
  }
});

test('UNKNOWN and CONFLICT dispositions append a visible MODEL_GAP instead of executing', () => {
  for (const disposition of ['UNKNOWN', 'CONFLICT']) {
    const fixture = createProtocolFixture(registry, contract, 'SATISFY_COMPLETION_DIMENSION');
    const result = executeFixture(fixture, registry, { disposition });
    assertVisibleHandling(result, 'UNKNOWN_DISPOSITION_STATE');
    assert.equal(result.status, 'MODEL_GAP');
    assert.equal(result.facts[0].factKind, 'MODEL_GAP_DETECTED');
    assert.equal(fixture.runtime.invocationLog.length, 0);
  }
});

test('deleting a resolver fails build validation and becomes a runtime MODEL_GAP', () => {
  const candidate = clone(registry);
  delete candidate.types[0].resolver;
  assert.throws(() => assertProtocolRegistry(candidate, contract), /MISSING_RESOLVER/);
  const fixture = createProtocolFixture(registry, contract, candidate.types[0].kind);
  const result = executeFixture(fixture, candidate);
  assertVisibleHandling(result, 'MISSING_RESOLVER');
  assert.equal(result.status, 'MODEL_GAP');
  assert.equal(result.facts[0].factKind, 'MODEL_GAP_DETECTED');
});

test('a declared but uncallable resolver fails build and runtime checks before the action runs', () => {
  const fixture = createProtocolFixture(registry, contract, 'ESTABLISH_GOAL_DISPOSITION');
  const id = fixture.declaration.resolver.capability;
  const record = fixture.runtime.capabilities.get(id);
  fixture.runtime.capabilities.set(id, { ...record, invoke: null });
  const inspection = inspectProtocolRegistry(registry, contract, {
    capabilityInventory: fixture.runtime.capabilities,
  });
  assert.equal(inspection.valid, false);
  assert.equal(inspection.diagnostics[0].code, 'RESOLVER_UNCALLABLE');
  const result = executeFixture(fixture);
  assertVisibleHandling(result, 'RESOLVER_UNCALLABLE');
  assert.equal(result.status, 'MODEL_GAP');
  assert.equal(fixture.runtime.invocationLog.length, 0);
});

test('a resolver unreachable from ACTIVE fails build and runtime graph admission', () => {
  const candidate = clone(registry);
  candidate.types[0].resolver.from = 'RESOLVED';
  const inspection = inspectProtocolRegistry(candidate, contract);
  assert.equal(inspection.valid, false);
  assert.equal(inspection.diagnostics[0].code, 'RESOLVER_UNREACHABLE');
  const fixture = createProtocolFixture(registry, contract, candidate.types[0].kind);
  const result = executeFixture(fixture, candidate);
  assertVisibleHandling(result, 'RESOLVER_UNREACHABLE');
  assert.equal(result.status, 'MODEL_GAP');
  assert.equal(fixture.runtime.invocationLog.length, 0);
});

test('an actor without the declared capability produces a system-owned recoverable fact', () => {
  const fixture = createProtocolFixture(registry, contract, 'RUN_BOUND_VERIFICATION');
  fixture.runtime.actors.get('AGENT').capabilities.delete(fixture.declaration.actor.capability);
  const result = executeFixture(fixture);
  assertVisibleHandling(result, 'ACTOR_CAPABILITY_MISSING');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.owner, 'SYSTEM');
  assert.equal(fixture.runtime.invocationLog.length, 0);
});

test('a disabled owner is visible and routed to system recovery, never silently back to a person', () => {
  const fixture = createProtocolFixture(registry, contract, 'REQUEST_GOAL_DECISION');
  fixture.runtime.actors.get('OWNER').enabled = false;
  const result = executeFixture(fixture);
  assertVisibleHandling(result, 'ACTOR_DISABLED');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.owner, 'SYSTEM');
  assert.notEqual(result.next.kind, 'REQUEST_GOAL_DECISION');
  assert.equal(fixture.runtime.invocationLog.length, 0);
});

test('budget exhaustion is a visible bounded result and does not invoke the action', () => {
  const fixture = createProtocolFixture(registry, contract, 'REPAIR_FACT_CUT');
  fixture.runtime.budgets.get(fixture.binding.budgetDigest).remaining = 0;
  const result = executeFixture(fixture);
  assertVisibleHandling(result, 'BUDGET_EXHAUSTED');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.next.action, 'VISIBLE_BUDGET_EXHAUSTED');
  assert.equal(fixture.runtime.invocationLog.length, 0);
});

test('revoked authority fails closed at commit and names the explicit authorization protocol', () => {
  const fixture = createProtocolFixture(registry, contract, 'REMEDIATE_SIDE_EFFECT');
  fixture.runtime.authorityGrants.get(fixture.binding.authorityGrantDigest).active = false;
  const result = executeFixture(fixture);
  assertVisibleHandling(result, 'AUTHORITY_UNAVAILABLE');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.next.kind, 'REQUEST_NEW_AUTHORIZATION');
  assert.equal(fixture.runtime.invocationLog.length, 0);
});

test('policy mismatch fails closed into model diagnosis without invoking the action', () => {
  const fixture = createProtocolFixture(registry, contract, 'PROVE_ARTIFACT_INTEGRATION');
  fixture.runtime.policies.get(fixture.binding.policyDigest).active = false;
  const result = executeFixture(fixture);
  assertVisibleHandling(result, 'POLICY_MISMATCH');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.next.kind, 'DIAGNOSE_MODEL_GAP');
  assert.equal(fixture.runtime.invocationLog.length, 0);
});

test('a missing prerequisite creates a visible wait fact with an explicit next action', () => {
  const fixture = createProtocolFixture(registry, contract, 'PROVE_TARGET_PRESENCE');
  fixture.runtime.factKinds.clear();
  const result = executeFixture(fixture);
  assertVisibleHandling(result, 'PREREQUISITE_UNSATISFIED');
  assert.equal(result.status, 'WAITING_PREREQUISITE');
  assert.equal(result.next.action, 'VISIBLE_PREREQUISITE');
  assert.equal(fixture.runtime.invocationLog.length, 0);
});

test('wrong project ownership is rejected before action execution with an actionable MODEL_GAP', () => {
  const fixture = createProtocolFixture(registry, contract, 'SATISFY_COMPLETION_DIMENSION');
  const obligation = clone(fixture.obligation);
  obligation.ownership.homeProjectId = 'foreign-project';
  const result = executeFixture(fixture, registry, { obligation });
  assertVisibleHandling(result, 'PROJECT_ATTRIBUTION_INVALID');
  assert.equal(result.status, 'MODEL_GAP');
  assert.equal(fixture.runtime.invocationLog.length, 0);
});

test('an explicit accepted crossing preserves home ownership while serving a foreign criterion', () => {
  const kind = 'SATISFY_COMPLETION_DIMENSION';
  const criterionId = `criterion:${kind}`;
  const foreignProjectId = 'project-foreign';
  const crossingId = 'crossing-protocol';
  const handoffId = 'handoff-protocol';
  const fixture = createProtocolFixture(registry, contract, kind, {
    obligation: {
      blockingProjectIds: ['project-protocol', foreignProjectId],
      crossingId,
      handoffId,
      handoffStatus: 'ACCEPTED',
      attributionDecisionFactId: 'attribution-fact-protocol',
    },
    runtime: {
      criterionOwners: new Map([[criterionId, foreignProjectId]]),
      crossings: new Map([[crossingId, {
        homeProjectId: 'project-protocol',
        blockingProjectIds: [foreignProjectId],
        handoffId,
        status: 'ACCEPTED',
      }]]),
    },
  });
  validateProtocolObligation(fixture.obligation, fixture.declaration, contract, fixture.runtime);
  const result = executeFixture(fixture);
  assert.equal(result.status, 'RESOLVED');
  assert.equal(fixture.obligation.ownership.homeProjectId, fixture.binding.projectId);
  assert.deepEqual(fixture.obligation.servesCriterionIds, [criterionId]);
  assert.deepEqual(fixture.obligation.blocksClosureOf, ['CRITERIA_EVALUATION']);
});

test('a closed resolver/prerequisite SCC is detected even though every field is present', () => {
  const candidate = clone(registry);
  const [left, right] = candidate.types;
  left.prerequisites = [{factKind: null, obligationKind: right.kind, onMissing: 'VISIBLE_PREREQUISITE'}];
  right.prerequisites = [{factKind: null, obligationKind: left.kind, onMissing: 'VISIBLE_PREREQUISITE'}];
  for (const [entry, target] of [[left, right.kind], [right, left.kind]]) {
    entry.resolver.routes = entry.resolver.routes.map((route) => ({
      ...route,
      terminal: null,
      kind: target,
      bypassesPrerequisites: false,
    }));
  }
  const inspection = inspectProtocolRegistry(candidate, contract);
  assert.equal(inspection.valid, false);
  assert.ok(inspection.diagnostics.some((entry) => entry.code === 'CLOSED_SCC'));
  assert.ok(inspection.diagnostics.some((entry) => entry.code === 'CLOSED_PREREQUISITE_SCC'));
  assert.ok(inspection.diagnostics.some((entry) => entry.code === 'NO_EXIT'));

  const fixture = createProtocolFixture(registry, contract, left.kind);
  const result = executeFixture(fixture, candidate);
  assert.ok(['CLOSED_SCC', 'CLOSED_PREREQUISITE_SCC'].includes(result.code));
  assert.equal(result.status, 'MODEL_GAP');
  assert.equal(result.visible, true);
  assert.equal(result.handleable, true);
  assert.equal(fixture.runtime.invocationLog.length, 0);
});

test('a resolver self-loop with no terminal is reported by no-exit analysis', () => {
  const candidate = clone(registry);
  const entry = candidate.types[2];
  entry.resolver.routes = entry.resolver.routes.map((route) => ({
    ...route,
    terminal: null,
    kind: entry.kind,
    bypassesPrerequisites: true,
  }));
  const inspection = inspectProtocolRegistry(candidate, contract);
  assert.equal(inspection.valid, false);
  assert.ok(inspection.diagnostics.some((diagnostic) =>
    diagnostic.code === 'NO_EXIT' && diagnostic.detail.kind === entry.kind));
  assert.ok(inspection.diagnostics.some((diagnostic) => diagnostic.code === 'CLOSED_SCC'));
});

test('an unknown dynamic obligation type appends MODEL_GAP and queues agent diagnosis', () => {
  const fixture = createProtocolFixture(registry, contract, 'DIAGNOSE_MODEL_GAP');
  const obligation = {
    ...fixture.obligation,
    kind: 'DYNAMIC_PLUGIN_OBLIGATION',
  };
  const result = executeFixture(fixture, registry, {
    kind: obligation.kind,
    obligation,
  });
  assertVisibleHandling(result, 'UNKNOWN_OBLIGATION_TYPE');
  assert.equal(result.status, 'MODEL_GAP');
  assert.equal(result.facts[0].factKind, 'MODEL_GAP_DETECTED');
  assert.equal(result.next.kind, 'DIAGNOSE_MODEL_GAP');
  assert.equal(result.owner, 'SYSTEM');
  assert.equal(fixture.runtime.invocationLog.length, 0);
});

test('durable timeout appends a legal exit fact and advances to declared recovery', () => {
  const fixture = createProtocolFixture(registry, contract, 'MONITOR_EXTERNAL_WAIT');
  const result = timeoutProtocolObligation({
    registry,
    contract,
    kind: fixture.obligation.kind,
    obligation: fixture.obligation,
    runtime: fixture.runtime,
  });
  assertVisibleHandling(result, 'DURABLE_TIMEOUT_EXIT');
  assert.equal(result.status, 'TIMED_OUT');
  assert.equal(result.proof.activeAfter, false);
  assert.equal(result.facts[0].factKind, 'OBLIGATION_EXIT_RECORDED');
  assert.equal(result.facts[0].payload.exit, 'TIMEOUT');
});

test('an inactive goal blocks attempt work with a fact instead of treating attempt termination as goal termination', () => {
  const fixture = createProtocolFixture(registry, contract, 'RUN_BOUND_VERIFICATION');
  fixture.runtime.goal.disposition = 'ACHIEVED';
  fixture.runtime.attempt = { ...fixture.runtime.attempt, status: 'CLOSED', outcome: 'FAILED' };
  const result = executeFixture(fixture);
  assertVisibleHandling(result, 'GOAL_CONTEXT_INVALID');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(fixture.runtime.invocationLog.length, 0);
});

test('a failed terminal attempt advances to a successor while the goal remains active', () => {
  const fixture = createProtocolFixture(registry, contract, 'START_SUCCESSOR_ATTEMPT');
  const previousAttemptId = fixture.runtime.attempt.attemptId;
  const previousGeneration = fixture.runtime.attempt.attemptGeneration;
  assert.equal(fixture.runtime.attempt.status, 'CLOSED');
  assert.equal(fixture.runtime.attempt.outcome, 'FAILED');
  const result = executeFixture(fixture);
  assert.equal(result.status, 'RESOLVED');
  assert.equal(fixture.runtime.goal.disposition, 'ACTIVE');
  assert.equal(fixture.runtime.attempt.status, 'OPEN');
  assert.equal(fixture.runtime.attempt.outcome, null);
  assert.notEqual(fixture.runtime.attempt.attemptId, previousAttemptId);
  assert.equal(Number(fixture.runtime.attempt.attemptGeneration), Number(previousGeneration) + 1);
});

test('wrong effects execute the declared compensator and derive remediation instead of vanishing', () => {
  const fixture = createProtocolFixture(registry, contract, 'ESTABLISH_GOAL_DISPOSITION');
  const capability = fixture.declaration.actor.capability;
  const original = fixture.runtime.capabilities.get(capability);
  fixture.runtime.capabilities.set(capability, {
    ...original,
    invoke() {
      return { outcome: 'WRONG_EFFECT', code: 'CONTROLLED_WRONG_EFFECT', detail: { target: 'wrong' } };
    },
  });
  const result = executeFixture(fixture);
  assert.equal(result.status, 'PROGRESSED');
  assert.equal(result.code, 'WRONG_EFFECT_REMEDIATION_REQUIRED');
  assert.equal(result.next.kind, 'REMEDIATE_SIDE_EFFECT');
  assert.equal(result.compensation.outcome, 'COMPENSATED');
  assert.ok(fixture.runtime.invocationLog.includes('effect.rollback.internal'));
  assert.deepEqual(result.facts.map((fact) => fact.factKind), [
    'ACTION_INTENT_RECORDED',
    'ACTION_RECEIPT_RECORDED',
    'ACTION_RECEIPT_RECORDED',
  ]);
  assert.equal(result.proof.activeAfter, true);
});

test('finite retry policy becomes a visible exhausted result', () => {
  const fixture = createProtocolFixture(registry, contract, 'DIAGNOSE_MODEL_GAP');
  const capability = fixture.declaration.actor.capability;
  const original = fixture.runtime.capabilities.get(capability);
  fixture.runtime.capabilities.set(capability, {
    ...original,
    invoke() {
      return { outcome: 'FAILED', code: 'CONTROLLED_REPEAT' };
    },
  });
  const first = executeFixture(fixture);
  const second = executeFixture(fixture);
  assert.equal(first.status, 'RETRY_SCHEDULED');
  assert.equal(second.status, 'BLOCKED');
  assert.equal(second.code, 'RETRY_EXHAUSTED');
  assert.equal(second.visible, true);
  assert.equal(second.handleable, true);
  assert.equal(second.humanFallback, false);
});

test('successful crash replay reuses the receipt without duplicating an effect or fact', () => {
  const fixture = createProtocolFixture(registry, contract, 'REFRESH_STALE_BINDING');
  const first = executeFixture(fixture);
  const factCount = fixture.runtime.facts.length;
  const invocationCount = fixture.runtime.invocationLog.length;
  const replay = executeFixture(fixture);
  assert.equal(first.status, 'RESOLVED');
  assert.equal(replay.status, 'RESOLVED');
  assert.equal(replay.replayed, true);
  assert.equal(fixture.runtime.facts.length, factCount);
  assert.equal(fixture.runtime.invocationLog.length, invocationCount);
  assert.deepEqual(replay.facts.map((fact) => fact.factId), first.facts.map((fact) => fact.factId));
});

test('deleting any binding/disposition/action-safety concern is rejected at build time', () => {
  const mutations = [
    (candidate) => { candidate.profiles.identity.STABLE_GOAL_OBLIGATION.components.pop(); },
    (candidate) => { candidate.profiles.binding.EXACT_V2_BINDING.requiredFields.pop(); },
    (candidate) => { delete candidate.profiles.disposition.MANDATORY_FIVE_STATE.CONFLICT; },
    (candidate) => { candidate.types[0].goalAttemptProfile = 'ABSENT'; },
    (candidate) => { candidate.types[0].action.authorityScopes = []; },
    (candidate) => { candidate.types[0].action.policyRules = []; },
    (candidate) => { candidate.types[0].action.budgetCharge = -1; },
    (candidate) => { candidate.types[0].successFacts = []; },
    (candidate) => { candidate.types[0].failureFacts = []; },
    (candidate) => { candidate.types[0].timeout.logicalTicks = 0; },
    (candidate) => { candidate.types[0].retry.maxAttempts = 0; },
    (candidate) => {
      candidate.types[0].compensation.capability = null;
      candidate.types[0].compensation.manualRecovery = null;
    },
    (candidate) => { candidate.types[0].attribution.blocksClosureOf = []; },
  ];
  for (const mutate of mutations) {
    const candidate = clone(registry);
    mutate(candidate);
    assert.throws(() => assertProtocolRegistry(candidate, contract), /PROTOCOL_REGISTRY_INVALID/);
  }
});

test('the registry binding profile is exactly the frozen binding, not a field-presence subset', () => {
  assert.deepEqual(
    registry.profiles.binding.EXACT_V2_BINDING.requiredFields,
    FROZEN_BINDING_FIELDS,
  );
  const candidate = clone(registry);
  candidate.profiles.binding.EXACT_V2_BINDING.requiredFields = [
    ...FROZEN_BINDING_FIELDS.slice(0, -1),
    'plausibleButWrongField',
  ];
  assert.throws(() => assertProtocolRegistry(candidate, contract), /binding.requiredFields/);
});

test('a capability implementation bound to the wrong actor is rejected at build time', () => {
  const capabilities = createBuiltinCapabilityCatalog();
  const id = registry.types[0].actor.capability;
  capabilities.set(id, { ...capabilities.get(id), actor: 'OWNER' });
  const inspection = inspectProtocolRegistry(registry, contract, { capabilityInventory: capabilities });
  assert.equal(inspection.valid, false);
  assert.equal(inspection.diagnostics[0].code, 'ACTOR_CAPABILITY_MISSING');
});
