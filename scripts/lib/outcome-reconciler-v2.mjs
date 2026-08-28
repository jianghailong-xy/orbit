import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const FROZEN_COMPLETION_STATES = Object.freeze([
  'SATISFIED',
  'UNSATISFIED',
  'UNKNOWN',
  'CONFLICT',
  'NOT_APPLICABLE',
]);

export const FROZEN_COMPLETION_DIMENSIONS = Object.freeze([
  'GOAL_DISPOSITION',
  'CONTRACT_RATIFICATION',
  'CRITERIA_EVALUATION',
  'FACT_CUT_INTEGRITY',
  'EVIDENCE_TRUST',
  'BINDING_FRESHNESS',
  'AUTHORITY_VALIDITY',
  'POLICY_COMPLIANCE',
  'BUDGET_COMPLIANCE',
  'ARTIFACT_INTEGRATION',
  'TARGET_PRESENCE',
  'POST_MERGE_VERIFICATION',
  'EXTERNAL_CLOSURE_DEPENDENCIES',
  'ACTION_REMEDIATION',
  'MODEL_COVERAGE',
]);

export const FROZEN_BINDING_FIELDS = Object.freeze([
  'tenantId',
  'projectId',
  'subjectType',
  'subjectId',
  'goalId',
  'goalRevision',
  'contractDigest',
  'evaluationPlanDigest',
  'policyDigest',
  'riskPolicyDigest',
  'permissionDigest',
  'authorityGrantDigest',
  'budgetDigest',
  'capabilityRegistryDigest',
  'recipientDigest',
  'evaluatorDigest',
  'factSchemaDigest',
  'environmentDigest',
  'artifactDigest',
  'targetDigest',
  'targetRef',
  'asOfLogicalTime',
  'factCutDigest',
]);

export const FROZEN_FACT_FIELDS = Object.freeze([
  'factId',
  'factKind',
  'tenantId',
  'subject',
  'binding',
  'schemaVersion',
  'schemaDigest',
  'payload',
  'payloadDigest',
  'claimType',
  'principal',
  'authority',
  'observedAt',
  'recordedAt',
  'logicalTime',
  'causalPredecessorFactId',
  'idempotencyKey',
  'source',
  'signature',
]);

export const FROZEN_AUTHORITY_FIELDS = Object.freeze([
  'grantId',
  'grantDigest',
  'scopeDigest',
  'delegationChainDigest',
  'validFromLogicalTime',
  'validThroughLogicalTime',
  'revokedAtLogicalTime',
]);

export const FROZEN_FACT_CUT_FIELDS = Object.freeze([
  'cutId',
  'tenantId',
  'projectId',
  'watermarkLogicalTime',
  'factIds',
  'factCount',
  'factSetDigest',
  'openedAt',
  'sealedAt',
  'complete',
  'linearizable',
  'collectorVersion',
]);

export const FROZEN_GOAL_FIELDS = Object.freeze([
  'goalId',
  'goalRevision',
  'tenantId',
  'projectId',
  'statement',
  'contractDigest',
  'evaluationPlanDigest',
  'ratification',
  'disposition',
]);

export const FROZEN_ATTEMPT_FIELDS = Object.freeze([
  'attemptId',
  'attemptGeneration',
  'goalId',
  'goalRevision',
  'sessionId',
  'hypothesisDigest',
  'budgetDigest',
  'startedAtLogicalTime',
  'endedAtLogicalTime',
  'status',
  'outcome',
]);

export const FROZEN_EVALUATION_TIME_FIELDS = Object.freeze([
  'logicalNow',
  'clockId',
  'evaluatedThroughLogicalTime',
]);

export const FROZEN_TIMER_FIELDS = Object.freeze([
  'timerId',
  'tenantId',
  'goalId',
  'obligationId',
  'obligationRevision',
  'bindingDigest',
  'clockId',
  'dueLogicalTime',
  'dueAt',
  'scheduleFactId',
  'state',
  'deliveryAttempt',
  'wakeId',
  'timeoutExit',
]);

export const FROZEN_OBLIGATION_FIELDS = Object.freeze([
  'obligationId',
  'obligationRevision',
  'kind',
  'state',
  'mandatory',
  'owner',
  'capability',
  'binding',
  'reason',
  'actionProtocolProfile',
  'servesCriterionIds',
  'blocksClosureOf',
  'ownership',
  'resolverProfile',
  'createdAtLogicalTime',
  'dueLogicalTime',
]);

export const FROZEN_OBLIGATION_EXITS = Object.freeze([
  'RESOLVE',
  'CANCEL',
  'SUPERSEDE',
  'ESCALATE',
  'TIMEOUT',
]);

export const FROZEN_OBLIGATION_KINDS = Object.freeze([
  'ESTABLISH_GOAL_DISPOSITION',
  'SATISFY_COMPLETION_DIMENSION',
  'REPAIR_FACT_CUT',
  'REFRESH_STALE_BINDING',
  'PROVE_ARTIFACT_INTEGRATION',
  'PROVE_TARGET_PRESENCE',
  'RUN_BOUND_VERIFICATION',
  'DIAGNOSE_MODEL_GAP',
  'START_SUCCESSOR_ATTEMPT',
  'MONITOR_EXTERNAL_WAIT',
  'REQUEST_GOAL_DECISION',
  'REQUEST_RISK_ACCEPTANCE',
  'REQUEST_NEW_AUTHORIZATION',
  'REQUEST_EXTERNAL_IDENTITY',
  'REMEDIATE_SIDE_EFFECT',
  'RECOVER_RECONCILER',
]);

export const FROZEN_HUMAN_DECISION_KINDS = Object.freeze([
  'REQUEST_GOAL_DECISION',
  'REQUEST_RISK_ACCEPTANCE',
  'REQUEST_NEW_AUTHORIZATION',
  'REQUEST_EXTERNAL_IDENTITY',
]);

export const FROZEN_ACTION_FIELDS = Object.freeze([
  'actionIntentId',
  'tenantId',
  'obligationId',
  'obligationRevision',
  'effectClass',
  'resourceType',
  'resourceId',
  'targetDigest',
  'authorityGrantDigest',
  'policyDigest',
  'preconditionDigest',
  'evaluatedThroughLogicalTime',
  'idempotencyKey',
  'budget',
  'retryPolicy',
  'compensation',
  'receiptRequirements',
]);

export const FROZEN_ACTION_EFFECT_CLASSES = Object.freeze([
  'READ_ONLY',
  'REVERSIBLE_INTERNAL',
  'IRREVERSIBLE_INTERNAL',
  'EXTERNAL_REVERSIBLE',
  'EXTERNAL_IRREVERSIBLE',
]);

export const FROZEN_FACT_KINDS = Object.freeze([
  'GOAL_DECLARED',
  'GOAL_RATIFIED',
  'GOAL_DISPOSITION_RECORDED',
  'ATTEMPT_STARTED',
  'ATTEMPT_TERMINATED',
  'DIMENSION_EVALUATED',
  'MODEL_GAP_DETECTED',
  'TASK_STATUS_OBSERVED',
  'DONE_GATE_EVALUATED',
  'JUDGMENT_REQUESTED',
  'JUDGMENT_DECIDED',
  'JUDGMENT_SIGNAL_OBSERVED',
  'BLOCKER_EPISODE_OBSERVED',
  'PROJECT_ATTENTION_OBSERVED',
  'DISPATCH_LEASE_OBSERVED',
  'MERGE_RECEIPT_RECORDED',
  'ACCEPTANCE_REVISION_RECORDED',
  'TIMER_SCHEDULED',
  'TIMER_FIRED',
  'TIMER_CANCELLED',
  'ACTION_INTENT_RECORDED',
  'ACTION_RECEIPT_RECORDED',
  'OBLIGATION_EXIT_RECORDED',
  'CROSSING_HANDOFF_RECORDED',
]);

export const FROZEN_NON_GOALS = Object.freeze([
  'HARDENED_HUMAN_PRESENCE',
  'FULL_HISTORY_MIGRATION',
  'GENERAL_SAAS_SAGA',
]);

export const FROZEN_SOURCE_SURFACES = Object.freeze([
  'TASK_STATUS',
  'PROJECT_DONE_GATE',
  'JUDGMENT_REQUEST',
  'JUDGMENT_SIGNAL',
  'JUDGMENT_BLOCKER',
  'PROJECT_ATTENTION',
  'DISPATCH_LEASE',
  'MERGE_RECEIPT',
  'ACCEPTANCE_REVISION',
  'GOAL_ATTEMPT',
  'CROSS_PROJECT_OWNERSHIP',
  'BLOCKER_SIGNAL_EXIT_REGISTRY',
]);

export const FROZEN_CLOSED_CLAUSES = Object.freeze([
  'CONTRACT_RATIFIED_FOR_EXACT_CONTRACT_DIGEST',
  'EVALUATION_PLAN_MATCHES_EXACT_EVALUATION_PLAN_DIGEST',
  'FACT_CUT_IS_COMPLETE_LINEARIZABLE_AND_TRUSTED',
  'EVALUATOR_VERSION_AND_DIGEST_MATCH_BINDING',
  'EVERY_MANDATORY_DIMENSION_IS_SATISFIED_OR_PROVEN_NOT_APPLICABLE',
  'NO_UNKNOWN_DIMENSION',
  'NO_UNSATISFIED_DIMENSION',
  'NO_CONFLICT_DIMENSION',
  'NO_MODEL_GAP',
  'GOAL_DISPOSITION_IS_ACHIEVED',
  'NO_ACTIVE_MANDATORY_OBLIGATION',
  'NO_STALE_OR_REVOKED_BINDING',
  'NO_UNREMEDIATED_SIDE_EFFECT',
  'ALL_EXTERNAL_CLOSURE_DEPENDENCIES_SETTLED',
]);

const FROZEN_FORBIDDEN_SHORTCUTS = Object.freeze([
  'EMPTY_REDUCER_OUTPUT',
  'TASK_STATUS_DONE_ALONE',
  'PROJECT_STATUS_DONE_ALONE',
  'ATTEMPT_SUCCEEDED_ALONE',
  'ATTEMPT_FAILED_OR_CANCELLED_AS_GOAL_EXIT',
  'COMMAND_EXIT_ZERO_WITHOUT_BOUND_EVIDENCE',
  'MERGE_RECEIPT_WITHOUT_CURRENT_TARGET_PRESENCE',
  'OLD_PROOF_AFTER_BINDING_CHANGE',
  'V1_PROJECTION_AS_CANONICAL_FACT',
]);

const FROZEN_INVALIDATORS = Object.freeze([
  'CONTRACT_CHANGED',
  'CRITERIA_CHANGED',
  'ARTIFACT_CHANGED',
  'TARGET_CHANGED',
  'RISK_POLICY_CHANGED',
  'PERMISSION_CHANGED',
  'AUTHORITY_CHANGED',
  'BUDGET_CHANGED',
  'CAPABILITY_REGISTRY_CHANGED',
  'RECIPIENT_CHANGED',
  'EVALUATOR_CHANGED',
  'FACT_SCHEMA_CHANGED',
  'ENVIRONMENT_CHANGED',
  'AS_OF_ADVANCED',
]);

const FROZEN_CONTRACT_MATERIAL_FIELDS = Object.freeze([
  'goal',
  'outcomes',
  'riskBoundary',
  'criteria',
  'criteriaTrust',
  'ownerId',
  'templateDigest',
  'delegationDigest',
]);

const FROZEN_PLAN_MATERIAL_FIELDS = Object.freeze([
  'commands',
  'verifiers',
  'evidenceWiring',
  'collectorVersions',
  'environment',
]);

const FROZEN_PROJECTION_FIELDS = Object.freeze([
  'obligationId',
  'obligationRevision',
  'bindingDigest',
  'reason',
  'owner',
  'evaluatedThroughLogicalTime',
  'projectionRevision',
  'staleness',
]);

const FROZEN_PROJECTION_CONSUMERS = Object.freeze([
  'DONE_GATE',
  'AGENT_QUEUE',
  'OWNER_DECISION_INBOX',
  'PROJECT_ATTENTION',
  'MUTATION_RESPONSE',
  'WEB',
]);

export const FROZEN_OWNERSHIP_FIELDS = Object.freeze([
  'homeProjectId',
  'blockingProjectIds',
  'crossingId',
  'handoffId',
  'handoffStatus',
  'attributionDecisionFactId',
]);

export const FROZEN_CROSS_PROJECT_FIELDS = Object.freeze([
  'ownershipRequiredFields',
  'servesCriterionAndBlocksClosureAreOrthogonal',
  'foreignWorkOwnership',
  'foreignClosureDependency',
  'implicitAdoption',
  'handoffStatuses',
]);

export const FROZEN_HANDOFF_STATUSES = Object.freeze([
  'NOT_REQUIRED',
  'PROPOSED',
  'ACCEPTED',
  'REFUSED',
  'SUPERSEDED',
]);

const FROZEN_SCHEMA_TOP_LEVEL = Object.freeze([
  '$schema',
  'contractName',
  'contractVersion',
  'evaluatorVersion',
  'canonicalization',
  'nonGoals',
  'stateAlgebra',
  'completionDimensions',
  'bindingContract',
  'trustEnvelope',
  'factCutContract',
  'factKinds',
  'goalAttemptContract',
  'logicalTimeContract',
  'digestContract',
  'obligationContract',
  'actionSafetyContract',
  'crossProjectContract',
  'closedContract',
  'projectionContract',
  'compatibilityBoundary',
  'sourceAudit',
]);

const FROZEN_COMPATIBILITY_FIELDS = Object.freeze([
  'currentProtocol',
  'acceptedLegacyProtocols',
  'legacyWriteMode',
  'legacyReadMode',
  'legacyDirectDone',
  'legacyCompletionFallbackToHuman',
  'legacyMayMintAuthority',
  'legacyMayRatifyContract',
  'legacyMayWriteProjection',
  'unknownRevision',
  'mixedClientCutover',
  'rollback',
  'v1History',
]);

const FROZEN_HUMAN_PROTOCOL_FIELDS = Object.freeze([
  'whyNotAgent',
  'options',
  'impacts',
  'recommendation',
  'noActionConsequence',
  'cost',
  'deadline',
  'resumeBehavior',
  'idempotencyKey',
]);

const DIGEST_RE = /^[0-9a-f]{64}$/;
const LOGICAL_TIME_RE = /^(0|[1-9][0-9]*)$/;

function fail(message) {
  throw new Error(`OUTCOME_CONTRACT_INVALID: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function object(value, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function exactArray(actual, expected, label, { ordered = true } = {}) {
  assert(Array.isArray(actual), `${label} must be an array`);
  assert(new Set(actual).size === actual.length, `${label} contains a duplicate`);
  const left = ordered ? actual : [...actual].sort();
  const right = ordered ? [...expected] : [...expected].sort();
  assert(
    left.length === right.length && left.every((value, index) => value === right[index]),
    `${label} must be exactly ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`,
  );
}

function exactKeys(value, expected, label) {
  object(value, label);
  exactArray(Object.keys(value).sort(), [...expected].sort(), `${label} fields`);
}

function requiredKeys(value, expected, label) {
  object(value, label);
  for (const field of expected) {
    assert(Object.prototype.hasOwnProperty.call(value, field), `${label}.${field} is required`);
  }
}

function logicalTime(value, label) {
  assert(typeof value === 'string' && LOGICAL_TIME_RE.test(value), `${label} must be a decimal logical time string`);
  return BigInt(value);
}

function digest(value, label) {
  assert(typeof value === 'string' && DIGEST_RE.test(value), `${label} must be a lowercase sha256 digest`);
}

function timestamp(value, label) {
  assert(typeof value === 'string' && !Number.isNaN(Date.parse(value)), `${label} must be an RFC3339 timestamp`);
}

export function canonicalJson(value) {
  const seen = new Set();
  function normalize(node, at) {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new TypeError(`${at} contains a non-finite number`);
      return Object.is(node, -0) ? 0 : node;
    }
    if (typeof node === 'bigint' || typeof node === 'undefined' || typeof node === 'function' || typeof node === 'symbol') {
      throw new TypeError(`${at} contains a value JSON cannot canonically encode`);
    }
    if (seen.has(node)) throw new TypeError(`${at} contains a cycle`);
    seen.add(node);
    let normalized;
    if (Array.isArray(node)) {
      normalized = node.map((entry, index) => normalize(entry, `${at}[${index}]`));
    } else {
      normalized = {};
      for (const key of Object.keys(node).sort()) {
        const entry = node[key];
        if (entry === undefined) throw new TypeError(`${at}.${key} is undefined`);
        normalized[key] = normalize(entry, `${at}.${key}`);
      }
    }
    seen.delete(node);
    return normalized;
  }
  return JSON.stringify(normalize(value, '$'));
}

export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function profileById(contract, id) {
  return contract.obligationContract.actionProtocolProfiles.find((profile) => profile.id === id);
}

function obligationKindById(contract, kind) {
  return contract.obligationContract.kinds.find((entry) => entry.kind === kind);
}

function terminalStateForExit(exit) {
  return {
    RESOLVE: 'RESOLVED',
    CANCEL: 'CANCELLED',
    SUPERSEDE: 'SUPERSEDED',
    ESCALATE: 'ESCALATED',
    TIMEOUT: 'TIMED_OUT',
  }[exit];
}

function assertAcyclicResolverProfile(profile) {
  const adjacency = new Map();
  for (const resolver of profile.resolvers) {
    const next = adjacency.get(resolver.from) ?? [];
    next.push(resolver.to);
    adjacency.set(resolver.from, next);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(node) {
    if (visiting.has(node)) fail(`resolver profile ${profile.id} contains a cycle through ${node}`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) visit(next);
    visiting.delete(node);
    visited.add(node);
  }
  visit(profile.startState);
}

export function assertFrozenContract(contract, schema) {
  object(contract, 'contract');
  object(schema, 'schema');
  exactArray(schema.required, FROZEN_SCHEMA_TOP_LEVEL, 'schema.required');
  exactKeys(contract, FROZEN_SCHEMA_TOP_LEVEL, 'contract');
  assert(contract.contractName === 'orbit.outcome-reconciler', 'contractName changed');
  assert(contract.contractVersion === '2.0.0', 'contractVersion changed');
  assert(contract.evaluatorVersion === 'outcome-reducer-v2', 'evaluatorVersion changed');
  assert(contract.canonicalization.algorithm === 'RFC8785_JSON_SHA256', 'canonicalization algorithm changed');
  assert(contract.canonicalization.nullAndAbsentAreDistinct === true, 'null and absent must stay distinct');
  exactArray(contract.nonGoals, FROZEN_NON_GOALS, 'nonGoals');

  const algebra = object(contract.stateAlgebra, 'stateAlgebra');
  exactArray(algebra.states, FROZEN_COMPLETION_STATES, 'stateAlgebra.states');
  exactArray(algebra.closureEligibleStates, ['SATISFIED', 'NOT_APPLICABLE'], 'stateAlgebra.closureEligibleStates');
  exactArray(algebra.precedence, ['NOT_APPLICABLE', 'SATISFIED', 'UNSATISFIED', 'UNKNOWN', 'CONFLICT'], 'stateAlgebra.precedence');
  exactKeys(algebra.definitions, FROZEN_COMPLETION_STATES, 'stateAlgebra.definitions');
  exactKeys(algebra.combineTable, FROZEN_COMPLETION_STATES, 'stateAlgebra.combineTable');
  const rank = new Map(algebra.precedence.map((state, index) => [state, index]));
  for (const left of FROZEN_COMPLETION_STATES) {
    exactKeys(algebra.combineTable[left], FROZEN_COMPLETION_STATES, `combineTable.${left}`);
    for (const right of FROZEN_COMPLETION_STATES) {
      const expected = rank.get(left) >= rank.get(right) ? left : right;
      assert(algebra.combineTable[left][right] === expected, `combineTable.${left}.${right} must be ${expected}`);
      assert(algebra.combineTable[left][right] === algebra.combineTable[right][left], 'state combine must be commutative');
    }
    assert(algebra.combineTable[left][left] === left, `state combine must be idempotent for ${left}`);
  }
  for (const a of FROZEN_COMPLETION_STATES) {
    for (const b of FROZEN_COMPLETION_STATES) {
      for (const c of FROZEN_COMPLETION_STATES) {
        const left = algebra.combineTable[algebra.combineTable[a][b]][c];
        const right = algebra.combineTable[a][algebra.combineTable[b][c]];
        assert(left === right, `state combine must be associative for ${a},${b},${c}`);
      }
    }
  }
  assert(algebra.notApplicableRequiresApplicabilityProof === true, 'NOT_APPLICABLE must require proof');
  assert(algebra.emptyDimensionSetResult === 'MODEL_GAP', 'empty reducer output must be a model gap');

  const dimensions = contract.completionDimensions;
  exactArray(dimensions.map((entry) => entry.id), FROZEN_COMPLETION_DIMENSIONS, 'completionDimensions ids');
  for (const dimension of dimensions) {
    exactKeys(dimension, ['id', 'mandatory', 'notApplicableAllowed', 'unsatisfiedObligationKind'], `dimension ${dimension.id}`);
    assert(dimension.mandatory === true, `${dimension.id} must remain mandatory`);
    assert(FROZEN_OBLIGATION_KINDS.includes(dimension.unsatisfiedObligationKind), `${dimension.id} has no registered obligation kind`);
    if (!dimension.notApplicableAllowed) {
      assert(['GOAL_DISPOSITION', 'CONTRACT_RATIFICATION', 'CRITERIA_EVALUATION', 'FACT_CUT_INTEGRITY', 'EVIDENCE_TRUST', 'BINDING_FRESHNESS', 'AUTHORITY_VALIDITY', 'POLICY_COMPLIANCE', 'BUDGET_COMPLIANCE', 'MODEL_COVERAGE'].includes(dimension.id), `${dimension.id} applicability policy changed`);
    }
  }

  exactArray(contract.bindingContract.requiredFields, FROZEN_BINDING_FIELDS, 'bindingContract.requiredFields');
  exactArray(contract.bindingContract.materialInvalidators, FROZEN_INVALIDATORS, 'bindingContract.materialInvalidators');
  assert(contract.bindingContract.lateFactRule === 'ACCEPT_ONLY_IF_BINDING_AND_AUTHORITY_WERE_VALID_AT_THE_CUT', 'late-fact rule changed');

  const trust = contract.trustEnvelope;
  exactArray(trust.requiredFields, FROZEN_FACT_FIELDS, 'trustEnvelope.requiredFields');
  exactArray(trust.subjectRequiredFields, ['type', 'id', 'projectId'], 'trustEnvelope.subjectRequiredFields');
  exactArray(trust.principalRequiredFields, ['type', 'id'], 'trustEnvelope.principalRequiredFields');
  exactArray(trust.authorityRequiredFields, FROZEN_AUTHORITY_FIELDS, 'trustEnvelope.authorityRequiredFields');
  exactArray(trust.sourceRequiredFields, ['system', 'collectorId', 'collectorVersion'], 'trustEnvelope.sourceRequiredFields');
  exactArray(trust.signatureRequiredFields, ['algorithm', 'keyId', 'value'], 'trustEnvelope.signatureRequiredFields');
  assert(trust.claimIsProof === false, 'claim must remain distinct from proof');
  assert(trust.projectionMayBeAuthority === false, 'projection must never become authority');
  assert(trust.immutableAfterAppend === true, 'canonical facts must be append-only');
  exactArray(contract.factKinds, FROZEN_FACT_KINDS, 'factKinds');

  exactArray(contract.factCutContract.requiredFields, FROZEN_FACT_CUT_FIELDS, 'factCutContract.requiredFields');
  exactArray(contract.factCutContract.order, ['logicalTime', 'factId'], 'factCutContract.order');
  assert(contract.factCutContract.atomicEvaluation === true, 'fact cut must stay atomic');
  assert(contract.factCutContract.projectionInput === 'REFUSE', 'fact cut must refuse projection input');

  const goalAttempt = contract.goalAttemptContract;
  exactArray(goalAttempt.goalRequiredFields, FROZEN_GOAL_FIELDS, 'goalRequiredFields');
  exactArray(goalAttempt.attemptRequiredFields, FROZEN_ATTEMPT_FIELDS, 'attemptRequiredFields');
  exactArray(goalAttempt.goalDispositions, ['ACTIVE', 'ACHIEVED', 'ABANDONED', 'SUPERSEDED'], 'goalDispositions');
  exactArray(goalAttempt.attemptStatuses, ['OPEN', 'WINDING_DOWN', 'CLOSED'], 'attemptStatuses');
  exactArray(goalAttempt.attemptOutcomes, ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'SUPERSEDED'], 'attemptOutcomes');
  assert(goalAttempt.terminalAttemptDoesNotTerminateGoal === true, 'attempt terminal state must not terminate a goal');
  assert(goalAttempt.attemptIdentityExcludedFromObligationIdentity === true, 'attempt identity must not churn obligation identity');

  const time = contract.logicalTimeContract;
  exactArray(time.evaluationRequiredFields, FROZEN_EVALUATION_TIME_FIELDS, 'evaluationRequiredFields');
  exactArray(time.timerRequiredFields, FROZEN_TIMER_FIELDS, 'timerRequiredFields');
  exactArray(time.timerStates, ['SCHEDULED', 'FIRED', 'CANCELLED'], 'timerStates');
  assert(time.wallClockDecisionUse === 'FORBIDDEN', 'wall clock cannot decide reducer order');
  assert(time.timerPersistence === 'DURABLE_APPEND_FACT_PLUS_REBUILDABLE_DUE_INDEX', 'timer must remain durable');
  assert(time.timerDelivery === 'AT_LEAST_ONCE_WITH_IDEMPOTENT_WAKE', 'timer delivery contract changed');

  const digests = contract.digestContract;
  exactArray(digests.contractMaterialFields, FROZEN_CONTRACT_MATERIAL_FIELDS, 'contractMaterialFields');
  exactArray(digests.evaluationPlanMaterialFields, FROZEN_PLAN_MATERIAL_FIELDS, 'evaluationPlanMaterialFields');
  assert(digests.contractDigestAndEvaluationPlanDigestAreDistinct === true, 'contract and evaluation plan digests must be distinct');
  assert(digests.contractRatificationRequired === true, 'ratification must remain required');
  assert(digests.ordinaryRunnerMayRatify === false, 'ordinary runner must not ratify owner semantics');
  assert(new Set([...FROZEN_CONTRACT_MATERIAL_FIELDS, ...FROZEN_PLAN_MATERIAL_FIELDS]).size === FROZEN_CONTRACT_MATERIAL_FIELDS.length + FROZEN_PLAN_MATERIAL_FIELDS.length, 'digest material sets must remain disjoint');

  const obligations = contract.obligationContract;
  exactArray(obligations.requiredFields, FROZEN_OBLIGATION_FIELDS, 'obligation requiredFields');
  exactArray(obligations.exits, FROZEN_OBLIGATION_EXITS, 'obligation exits');
  exactArray(obligations.states, ['ACTIVE', 'RESOLVED', 'CANCELLED', 'SUPERSEDED', 'ESCALATED', 'TIMED_OUT'], 'obligation states');
  exactArray(obligations.owners, ['SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL'], 'obligation owners');
  exactArray(obligations.humanDecisionKinds, FROZEN_HUMAN_DECISION_KINDS, 'humanDecisionKinds');
  exactArray(obligations.kinds.map((entry) => entry.kind), FROZEN_OBLIGATION_KINDS, 'obligation kinds');
  assert(!obligations.identityComponents.some((field) => obligations.identityForbiddenComponents.includes(field)), 'obligation identity contains a volatile field');
  for (const field of ['tenantId', 'goalId', 'goalRevision', 'contractDigest', 'kind', 'subjectType', 'subjectId', 'homeProjectId']) {
    assert(obligations.identityComponents.includes(field), `obligation identity is missing ${field}`);
  }
  for (const field of ['attemptId', 'attemptGeneration', 'sessionId', 'leaseId', 'wallClock', 'reasonText']) {
    assert(obligations.identityForbiddenComponents.includes(field), `identity forbidden components lost ${field}`);
  }

  const adapters = new Map(obligations.runtimeAdapters.map((entry) => [entry.id, entry]));
  assert(adapters.size === obligations.runtimeAdapters.length, 'runtime adapter ids must be unique');
  for (const adapter of adapters.values()) {
    assert(adapter.status === 'REGISTERED', `runtime adapter ${adapter.id} is not registered`);
    assert(Array.isArray(adapter.actors) && adapter.actors.length > 0, `runtime adapter ${adapter.id} has no actor`);
  }
  assert(obligations.resolverProfiles.length === 1, 'V2 freezes one standard mandatory resolver profile');
  const resolverProfile = obligations.resolverProfiles[0];
  assert(resolverProfile.id === 'STANDARD_MANDATORY' && resolverProfile.startState === 'ACTIVE', 'standard resolver profile changed');
  exactArray(resolverProfile.resolvers.map((entry) => entry.exit), FROZEN_OBLIGATION_EXITS, 'standard resolver exits');
  for (const resolver of resolverProfile.resolvers) {
    exactKeys(resolver, ['id', 'from', 'exit', 'to', 'actor', 'capability', 'adapter'], `resolver ${resolver.id}`);
    assert(resolver.from === 'ACTIVE', `resolver ${resolver.id} is unreachable from ACTIVE`);
    assert(resolver.to === terminalStateForExit(resolver.exit), `resolver ${resolver.id} reaches the wrong terminal state`);
    const adapter = adapters.get(resolver.adapter);
    assert(adapter, `resolver ${resolver.id} names an unregistered adapter`);
    assert(adapter.actors.includes(resolver.actor), `resolver ${resolver.id} has no runtime actor on ${resolver.adapter}`);
    assert(typeof resolver.capability === 'string' && resolver.capability.length > 0, `resolver ${resolver.id} has no capability`);
  }
  assertAcyclicResolverProfile(resolverProfile);

  const profiles = new Map(obligations.actionProtocolProfiles.map((entry) => [entry.id, entry]));
  exactArray([...profiles.keys()], ['SYSTEM_ACTION', 'AGENT_ACTION', 'OWNER_DECISION', 'EXTERNAL_MONITOR'], 'action protocol profiles');
  exactArray(profiles.get('OWNER_DECISION').requiredFields, FROZEN_HUMAN_PROTOCOL_FIELDS, 'OWNER_DECISION requiredFields');
  for (const kind of obligations.kinds) {
    exactKeys(kind, ['kind', 'defaultOwner', 'capability', 'actionProtocolProfile', 'resolverProfile'], `obligation kind ${kind.kind}`);
    assert(kind.resolverProfile === 'STANDARD_MANDATORY', `${kind.kind} has no complete exit profile`);
    const profile = profiles.get(kind.actionProtocolProfile);
    assert(profile, `${kind.kind} has no action protocol`);
    if (FROZEN_HUMAN_DECISION_KINDS.includes(kind.kind)) {
      assert(kind.defaultOwner === 'OWNER' && profile.id === 'OWNER_DECISION', `${kind.kind} must enter the owner decision inbox`);
    } else {
      assert(kind.defaultOwner !== 'OWNER', `${kind.kind} improperly escalates ordinary work to a person`);
    }
  }

  const action = contract.actionSafetyContract;
  exactArray(action.requiredFields, FROZEN_ACTION_FIELDS, 'action requiredFields');
  exactArray(action.budgetRequiredFields, ['accountId', 'unit', 'charge', 'limit', 'reservationId'], 'action budgetRequiredFields');
  exactArray(action.retryPolicyRequiredFields, ['maxAttempts', 'backoffDigest', 'sameFailureFingerprintLimit'], 'action retryPolicyRequiredFields');
  exactArray(action.compensationRequiredFields, ['compensatorCapability', 'manualRecovery', 'remediationObligationKind'], 'action compensationRequiredFields');
  exactArray(action.receiptRequiredFields, ['providerIdentity', 'effectDigest', 'observedAt', 'result', 'idempotencyKey'], 'action receiptRequiredFields');
  exactArray(action.effectClasses, FROZEN_ACTION_EFFECT_CLASSES, 'action effectClasses');
  assert(action.missingContext === 'FAIL_CLOSED', 'missing action context must fail closed');
  assert(action.revokedAuthority === 'FAIL_CLOSED', 'revoked action authority must fail closed');
  assert(action.crashReplay === 'SAME_IDEMPOTENCY_KEY_NO_DUPLICATE_EFFECT', 'action crash replay safety changed');
  assert(action.wrongEffect === 'APPEND_RECEIPT_AND_DERIVE_REMEDIATE_SIDE_EFFECT', 'wrong effects must derive remediation');

  const crossing = contract.crossProjectContract;
  exactKeys(crossing, FROZEN_CROSS_PROJECT_FIELDS, 'crossProjectContract');
  exactArray(crossing.ownershipRequiredFields, FROZEN_OWNERSHIP_FIELDS, 'cross-project ownership fields');
  assert(crossing.servesCriterionAndBlocksClosureAreOrthogonal === true, 'servesCriterion and blocksClosureOf must remain orthogonal');
  assert(crossing.foreignWorkOwnership === 'REMAINS_WITH_HOME_PROJECT', 'cross-project work changed ownership implicitly');
  assert(crossing.foreignClosureDependency === 'EXPLICIT_BLOCKS_CLOSURE_EDGE', 'foreign closure dependencies must remain explicit');
  assert(crossing.implicitAdoption === 'FORBIDDEN', 'implicit cross-project adoption must remain forbidden');
  exactArray(crossing.handoffStatuses, FROZEN_HANDOFF_STATUSES, 'cross-project handoff statuses');

  const closed = contract.closedContract;
  assert(closed.relation === 'NECESSARY_AND_SUFFICIENT', 'closed must remain an iff contract');
  exactArray(closed.clauses, FROZEN_CLOSED_CLAUSES, 'closed clauses');
  exactArray(closed.forbiddenShortcuts, FROZEN_FORBIDDEN_SHORTCUTS, 'closed forbiddenShortcuts');

  const projection = contract.projectionContract;
  exactArray(projection.requiredFields, FROZEN_PROJECTION_FIELDS, 'projection requiredFields');
  exactArray(projection.consumers, FROZEN_PROJECTION_CONSUMERS, 'projection consumers');
  assert(projection.writer === 'OUTCOME_RECONCILER_ONLY', 'projection writer must remain singular');
  assert(projection.rebuildable === true && projection.mayFeedEvaluator === false, 'projection boundary changed');
  assert(projection.staleCode === 'RECONCILER_STALE', 'stale projection code changed');

  exactKeys(contract.compatibilityBoundary, FROZEN_COMPATIBILITY_FIELDS, 'compatibilityBoundary');
  assert(contract.compatibilityBoundary.currentProtocol === 'V2', 'current protocol changed');
  exactArray(contract.compatibilityBoundary.acceptedLegacyProtocols, ['V1', 'V1_HEADERLESS_N_MINUS_ONE'], 'acceptedLegacyProtocols');
  assert(contract.compatibilityBoundary.legacyDirectDone === 'REFUSE', 'legacy direct DONE must fail closed');
  assert(contract.compatibilityBoundary.legacyCompletionFallbackToHuman === 'REFUSE', 'legacy omission must not become human signoff');
  assert(contract.compatibilityBoundary.legacyMayMintAuthority === false, 'legacy clients must not mint authority');
  assert(contract.compatibilityBoundary.legacyMayRatifyContract === false, 'legacy clients must not ratify contracts');
  assert(contract.compatibilityBoundary.legacyMayWriteProjection === false, 'legacy clients must not write V2 projections');

  const defs = object(schema.$defs, 'schema.$defs');
  exactArray(defs.CompletionState.enum, FROZEN_COMPLETION_STATES, '$defs.CompletionState.enum');
  exactArray(defs.CompletionDimensionId.enum, FROZEN_COMPLETION_DIMENSIONS, '$defs.CompletionDimensionId.enum');
  exactArray(defs.Binding.required, FROZEN_BINDING_FIELDS, '$defs.Binding.required');
  exactArray(defs.CanonicalFact.required, FROZEN_FACT_FIELDS, '$defs.CanonicalFact.required');
  exactArray(defs.FactSubject.required, trust.subjectRequiredFields, '$defs.FactSubject.required');
  exactArray(defs.Principal.required, trust.principalRequiredFields, '$defs.Principal.required');
  exactArray(defs.Authority.required, FROZEN_AUTHORITY_FIELDS, '$defs.Authority.required');
  exactArray(defs.FactSource.required, trust.sourceRequiredFields, '$defs.FactSource.required');
  exactArray(defs.Signature.required, trust.signatureRequiredFields, '$defs.Signature.required');
  exactArray(defs.FactCut.required, FROZEN_FACT_CUT_FIELDS, '$defs.FactCut.required');
  exactArray(defs.Goal.required, FROZEN_GOAL_FIELDS, '$defs.Goal.required');
  exactArray(defs.Attempt.required, FROZEN_ATTEMPT_FIELDS, '$defs.Attempt.required');
  exactArray(defs.DurableTimer.required, FROZEN_TIMER_FIELDS, '$defs.DurableTimer.required');
  exactArray(defs.Obligation.required, FROZEN_OBLIGATION_FIELDS, '$defs.Obligation.required');
  exactArray(defs.ObligationExit.enum, FROZEN_OBLIGATION_EXITS, '$defs.ObligationExit.enum');
  exactArray(defs.ObligationOwnership.required, FROZEN_OWNERSHIP_FIELDS, '$defs.ObligationOwnership.required');
  exactArray(defs.ObligationOwnership.properties.handoffStatus.enum, FROZEN_HANDOFF_STATUSES, '$defs.ObligationOwnership.properties.handoffStatus.enum');
  exactArray(defs.ActionSafetyEnvelope.required, FROZEN_ACTION_FIELDS, '$defs.ActionSafetyEnvelope.required');
  exactArray(defs.EvaluationClock.required, FROZEN_EVALUATION_TIME_FIELDS, '$defs.EvaluationClock.required');
  exactArray(defs.ObligationProjection.required, FROZEN_PROJECTION_FIELDS, '$defs.ObligationProjection.required');
  assert(defs.Goal !== defs.Attempt, 'Goal and Attempt schemas must be distinct');
  assert(!defs.Goal.required.includes('attemptId') && !defs.Attempt.required.includes('disposition'), 'Goal and Attempt identities were conflated');
  return true;
}

export function validateBinding(bindingValue, contract) {
  exactKeys(bindingValue, contract.bindingContract.requiredFields, 'binding');
  for (const field of contract.bindingContract.requiredFields.filter((name) => name.endsWith('Digest'))) {
    digest(bindingValue[field], `binding.${field}`);
  }
  logicalTime(bindingValue.goalRevision, 'binding.goalRevision');
  logicalTime(bindingValue.asOfLogicalTime, 'binding.asOfLogicalTime');
  for (const field of ['tenantId', 'projectId', 'subjectType', 'subjectId', 'goalId', 'targetRef']) {
    assert(typeof bindingValue[field] === 'string' && bindingValue[field].length > 0, `binding.${field} must be non-empty`);
  }
  return bindingValue;
}

export function validateCanonicalFact(fact, contract) {
  exactKeys(fact, contract.trustEnvelope.requiredFields, 'fact');
  assert(contract.factKinds.includes(fact.factKind), `fact kind ${fact.factKind} is not registered`);
  assert(fact.tenantId === fact.binding.tenantId, 'fact tenant and binding tenant differ');
  validateBinding(fact.binding, contract);
  exactKeys(fact.subject, contract.trustEnvelope.subjectRequiredFields, 'fact.subject');
  exactKeys(fact.principal, contract.trustEnvelope.principalRequiredFields, 'fact.principal');
  exactKeys(fact.authority, contract.trustEnvelope.authorityRequiredFields, 'fact.authority');
  exactKeys(fact.source, contract.trustEnvelope.sourceRequiredFields, 'fact.source');
  if (fact.signature !== null) exactKeys(fact.signature, contract.trustEnvelope.signatureRequiredFields, 'fact.signature');
  assert(Number.isInteger(fact.schemaVersion) && fact.schemaVersion > 0, 'fact.schemaVersion must be positive');
  digest(fact.schemaDigest, 'fact.schemaDigest');
  digest(fact.payloadDigest, 'fact.payloadDigest');
  assert(fact.payloadDigest === sha256Canonical(fact.payload), 'fact.payloadDigest does not bind the payload');
  assert(contract.trustEnvelope.claimTypes.includes(fact.claimType), 'fact.claimType is not registered');
  timestamp(fact.observedAt, 'fact.observedAt');
  timestamp(fact.recordedAt, 'fact.recordedAt');
  logicalTime(fact.logicalTime, 'fact.logicalTime');
  logicalTime(fact.authority.validFromLogicalTime, 'fact.authority.validFromLogicalTime');
  if (fact.authority.validThroughLogicalTime !== null) logicalTime(fact.authority.validThroughLogicalTime, 'fact.authority.validThroughLogicalTime');
  if (fact.authority.revokedAtLogicalTime !== null) logicalTime(fact.authority.revokedAtLogicalTime, 'fact.authority.revokedAtLogicalTime');
  for (const field of ['grantDigest', 'scopeDigest', 'delegationChainDigest']) digest(fact.authority[field], `fact.authority.${field}`);
  assert(fact.authority.grantDigest === fact.binding.authorityGrantDigest, 'fact authority does not match binding authority');
  assert(fact.schemaDigest === fact.binding.factSchemaDigest, 'fact schema does not match binding fact schema');
  assert(!String(fact.source.system).startsWith('PROJECTION:'), 'a projection cannot be submitted as authority');
  return fact;
}

export function validateFactCut(cut, facts, contract) {
  exactKeys(cut, contract.factCutContract.requiredFields, 'factCut');
  assert(cut.factCount === facts.length, 'factCut.factCount does not match facts');
  assert(cut.factIds.length === facts.length, 'factCut.factIds does not match facts');
  assert(cut.tenantId === facts[0]?.tenantId || facts.length === 0, 'factCut tenant differs from fact tenant');
  const sorted = [...facts].sort((left, right) => {
    const timeOrder = logicalTime(left.logicalTime, 'fact.logicalTime') - logicalTime(right.logicalTime, 'fact.logicalTime');
    if (timeOrder < 0n) return -1;
    if (timeOrder > 0n) return 1;
    return left.factId.localeCompare(right.factId);
  });
  exactArray(cut.factIds, sorted.map((fact) => fact.factId), 'factCut.factIds');
  digest(cut.factSetDigest, 'factCut.factSetDigest');
  assert(cut.factSetDigest === sha256Canonical(sorted), 'factCut.factSetDigest does not bind the ordered fact set');
  const watermark = logicalTime(cut.watermarkLogicalTime, 'factCut.watermarkLogicalTime');
  assert(sorted.every((fact) => logicalTime(fact.logicalTime, 'fact.logicalTime') <= watermark), 'fact exceeds cut watermark');
  timestamp(cut.openedAt, 'factCut.openedAt');
  timestamp(cut.sealedAt, 'factCut.sealedAt');
  assert(typeof cut.complete === 'boolean' && typeof cut.linearizable === 'boolean', 'fact cut flags must be boolean');
  return cut;
}

export function validateGoal(goal, contract) {
  exactKeys(goal, contract.goalAttemptContract.goalRequiredFields, 'goal');
  logicalTime(goal.goalRevision, 'goal.goalRevision');
  digest(goal.contractDigest, 'goal.contractDigest');
  digest(goal.evaluationPlanDigest, 'goal.evaluationPlanDigest');
  assert(contract.goalAttemptContract.goalDispositions.includes(goal.disposition), 'goal disposition is invalid');
  exactKeys(goal.ratification, ['status', 'ratifierType', 'ratifierId', 'contractDigest', 'factId'], 'goal.ratification');
  digest(goal.ratification.contractDigest, 'goal.ratification.contractDigest');
  return goal;
}

export function validateAttempt(attempt, contract) {
  exactKeys(attempt, contract.goalAttemptContract.attemptRequiredFields, 'attempt');
  logicalTime(attempt.attemptGeneration, 'attempt.attemptGeneration');
  logicalTime(attempt.goalRevision, 'attempt.goalRevision');
  logicalTime(attempt.startedAtLogicalTime, 'attempt.startedAtLogicalTime');
  if (attempt.endedAtLogicalTime !== null) logicalTime(attempt.endedAtLogicalTime, 'attempt.endedAtLogicalTime');
  digest(attempt.hypothesisDigest, 'attempt.hypothesisDigest');
  digest(attempt.budgetDigest, 'attempt.budgetDigest');
  assert(contract.goalAttemptContract.attemptStatuses.includes(attempt.status), 'attempt status is invalid');
  assert(attempt.outcome === null || contract.goalAttemptContract.attemptOutcomes.includes(attempt.outcome), 'attempt outcome is invalid');
  assert((attempt.status === 'CLOSED') === (attempt.outcome !== null && attempt.endedAtLogicalTime !== null), 'closed attempt must have outcome and end logical time');
  return attempt;
}

export function validateDurableTimer(timer, contract) {
  exactKeys(timer, contract.logicalTimeContract.timerRequiredFields, 'durableTimer');
  for (const field of ['dueLogicalTime']) logicalTime(timer[field], `durableTimer.${field}`);
  for (const field of ['obligationId', 'obligationRevision', 'bindingDigest']) digest(timer[field], `durableTimer.${field}`);
  timestamp(timer.dueAt, 'durableTimer.dueAt');
  assert(contract.logicalTimeContract.timerStates.includes(timer.state), 'durable timer state is invalid');
  assert(Number.isInteger(timer.deliveryAttempt) && timer.deliveryAttempt >= 0, 'durable timer deliveryAttempt is invalid');
  assert(timer.timeoutExit === 'TIMEOUT', 'durable timer must name the TIMEOUT exit');
  return timer;
}

export function validateActionSafetyEnvelope(envelope, contract) {
  exactKeys(envelope, contract.actionSafetyContract.requiredFields, 'actionSafetyEnvelope');
  assert(contract.actionSafetyContract.effectClasses.includes(envelope.effectClass), 'effect class is invalid');
  for (const field of ['obligationId', 'obligationRevision', 'targetDigest', 'authorityGrantDigest', 'policyDigest', 'preconditionDigest']) {
    digest(envelope[field], `actionSafetyEnvelope.${field}`);
  }
  logicalTime(envelope.evaluatedThroughLogicalTime, 'actionSafetyEnvelope.evaluatedThroughLogicalTime');
  exactKeys(envelope.budget, contract.actionSafetyContract.budgetRequiredFields, 'actionSafetyEnvelope.budget');
  exactKeys(envelope.retryPolicy, contract.actionSafetyContract.retryPolicyRequiredFields, 'actionSafetyEnvelope.retryPolicy');
  exactKeys(envelope.compensation, contract.actionSafetyContract.compensationRequiredFields, 'actionSafetyEnvelope.compensation');
  exactKeys(envelope.receiptRequirements, contract.actionSafetyContract.receiptRequiredFields, 'actionSafetyEnvelope.receiptRequirements');
  assert(envelope.budget.charge >= 0 && envelope.budget.limit >= envelope.budget.charge, 'action is over budget');
  assert(Number.isInteger(envelope.retryPolicy.maxAttempts) && envelope.retryPolicy.maxAttempts > 0, 'action retry budget is invalid');
  assert(Number.isInteger(envelope.retryPolicy.sameFailureFingerprintLimit) && envelope.retryPolicy.sameFailureFingerprintLimit > 0 && envelope.retryPolicy.sameFailureFingerprintLimit <= envelope.retryPolicy.maxAttempts, 'same-fingerprint budget must be finite and inside maxAttempts');
  digest(envelope.retryPolicy.backoffDigest, 'actionSafetyEnvelope.retryPolicy.backoffDigest');
  assert(envelope.compensation.compensatorCapability !== null || envelope.compensation.manualRecovery !== null, 'side effects require a compensator or manual recovery');
  assert(envelope.compensation.remediationObligationKind === 'REMEDIATE_SIDE_EFFECT', 'wrong effects must produce the remediation obligation');
  assert(Object.values(envelope.receiptRequirements).every((required) => required === true), 'effect receipt requirements cannot be weakened');
  return envelope;
}

export function combineCompletionStates(left, right, contract) {
  assert(contract.stateAlgebra.states.includes(left), `unknown completion state ${left}`);
  assert(contract.stateAlgebra.states.includes(right), `unknown completion state ${right}`);
  return contract.stateAlgebra.combineTable[left][right];
}

function materialDigest(value, fields, label) {
  exactKeys(value, fields, label);
  return sha256Canonical(Object.fromEntries(fields.map((field) => [field, value[field]])));
}

export function computeContractDigest(value, contract) {
  return materialDigest(value, contract.digestContract.contractMaterialFields, 'contract material');
}

export function computeEvaluationPlanDigest(value, contract) {
  return materialDigest(value, contract.digestContract.evaluationPlanMaterialFields, 'evaluation plan material');
}

export function stableObligationIdentity(input, contract) {
  const material = {};
  for (const field of contract.obligationContract.identityComponents) {
    assert(Object.prototype.hasOwnProperty.call(input, field), `obligation identity missing ${field}`);
    material[field] = input[field];
  }
  for (const field of contract.obligationContract.identityForbiddenComponents) {
    assert(!Object.prototype.hasOwnProperty.call(material, field), `obligation identity includes volatile ${field}`);
  }
  return sha256Canonical({ namespace: 'orbit.obligation.v2', ...material });
}

export function obligationRevision(input, contract) {
  const material = {};
  for (const field of contract.obligationContract.revisionComponents) {
    assert(Object.prototype.hasOwnProperty.call(input, field), `obligation revision missing ${field}`);
    material[field] = input[field];
  }
  return sha256Canonical({ namespace: 'orbit.obligation-revision.v2', ...material });
}

function sourceEntries(audit) {
  return audit.surfaces.flatMap((surface) => [
    ...surface.writers.map((entry) => ({ ...entry, surfaceId: surface.id, role: 'writer' })),
    ...surface.readers.map((entry) => ({ ...entry, surfaceId: surface.id, role: 'reader' })),
  ]);
}

function typescriptSourceFiles(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) typescriptSourceFiles(full, found);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

function withoutSourceComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*(?:\/\/|\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '')))
    .join('\n');
}

function durableOpenDeclarations(source, relativePath) {
  const code = withoutSourceComments(source);
  const found = [];
  const named = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*(?:_BLOCKER_KIND|_(?:SIGNAL_CODE|SIGNAL_KIND|SIGNAL_TYPE)))\s*(?::[^=;]+)?=/g;
  for (const match of code.matchAll(named)) {
    const family = match[1].endsWith('_BLOCKER_KIND') ? 'PROJECT_BLOCKER' : 'DURABLE_SIGNAL';
    const initializer = /^\s*\(*\s*(['"`])([A-Z][A-Z0-9_]*)\1/.exec(code.slice(match.index + match[0].length));
    assert(initializer, `${relativePath} declares ${match[1]} without a static stable type code`);
    found.push({ family, type: initializer[2], at: relativePath });
  }
  const inline = /\b(blockerKind|signal(?:Code|Kind|Type))\s*:\s*(['"`])([A-Z][A-Z0-9_]*)\2/g;
  for (const match of code.matchAll(inline)) {
    found.push({
      family: match[1] === 'blockerKind' ? 'PROJECT_BLOCKER' : 'DURABLE_SIGNAL',
      type: match[3],
      at: relativePath,
    });
  }
  return found;
}

function sqlQuotedStrings(source) {
  return [...source.matchAll(/'((?:''|[^'])*)'/g)].map((match) => match[1].replace(/''/g, "'"));
}

function blockerConstraintEvents(sql) {
  const events = [];
  for (const match of sql.matchAll(/DROP\s+CONSTRAINT(?:\s+IF\s+EXISTS)?\s+"?project_blocker_kind_chk"?/gi)) {
    events.push({ index: match.index, kinds: null });
  }
  for (const match of sql.matchAll(/ADD\s+CONSTRAINT\s+"?project_blocker_kind_chk"?\s+CHECK\s*\(\s*"?kind"?\s+IN\s*\(([\s\S]*?)\)\s*\)/gi)) {
    events.push({ index: match.index, kinds: sqlQuotedStrings(match[1]) });
  }
  return events.sort((left, right) => left.index - right.index);
}

function liveProjectBlockerKinds(migrationsDirectory) {
  let live = null;
  for (const migration of readdirSync(migrationsDirectory).sort()) {
    const migrationPath = path.join(migrationsDirectory, migration, 'migration.sql');
    if (!existsSync(migrationPath)) continue;
    for (const event of blockerConstraintEvents(readFileSync(migrationPath, 'utf8'))) live = event.kinds;
  }
  assert(live, 'project_blocker_kind_chk is absent after replaying migrations');
  return live;
}

function exitRegistrations(source) {
  const registrations = [];
  const declaration = /\{\s*family:\s*'(PROJECT_BLOCKER|DURABLE_SIGNAL)',\s*type:\s*'([A-Z][A-Z0-9_]*)',/g;
  for (const match of source.matchAll(declaration)) {
    const end = source.indexOf('\n  },', match.index);
    assert(end > match.index, `exit registration ${match[1]}:${match[2]} is not a complete object`);
    const block = source.slice(match.index, end);
    const resolveAt = block.indexOf('resolveWhen:');
    assert(resolveAt >= 0, `exit registration ${match[1]}:${match[2]} has no resolveWhen`);
    const resolutionText = block.slice(resolveAt).replace(/[^A-Za-z0-9_]+/g, ' ').trim();
    assert(resolutionText.length >= 60, `exit registration ${match[1]}:${match[2]} has no concrete resolve condition`);
    registrations.push({ family: match[1], type: match[2] });
  }
  return registrations;
}

function episodeKey(entry) {
  return `${entry.family}:${entry.type}`;
}

/**
 * Replay the live blocker CHECK, scan every durable signal declaration, and compare that source
 * set with the V1 exit registry. This is kept in the V2 acceptance path so removing an old exit
 * cannot hide behind an otherwise complete new obligation graph.
 */
export function auditV1BlockerSignalExits(root, inventorySourceOverride = null) {
  const api = path.join(root, 'src/apiserver');
  const declarations = liveProjectBlockerKinds(path.join(api, 'prisma/migrations')).map((type) => ({
    family: 'PROJECT_BLOCKER',
    type,
    at: 'prisma/migrations#project_blocker_kind_chk',
  }));
  const sourceRoot = path.join(api, 'src');
  for (const file of typescriptSourceFiles(sourceRoot).sort()) {
    const relative = path.relative(sourceRoot, file).split(path.sep).join('/');
    declarations.push(...durableOpenDeclarations(readFileSync(file, 'utf8'), relative));
  }
  const declared = new Map(declarations.map((entry) => [episodeKey(entry), entry]));
  const inventoryPath = path.join(sourceRoot, 'common/blocker-signal-exit-inventory.ts');
  const registrations = exitRegistrations(inventorySourceOverride ?? readFileSync(inventoryPath, 'utf8'));
  const registered = new Map(registrations.map((entry) => [episodeKey(entry), entry]));
  const duplicateRegistrations = registrations
    .map(episodeKey)
    .filter((key, index, keys) => keys.indexOf(key) !== index);
  return {
    declared: [...declared.keys()].sort(),
    registered: [...registered.keys()].sort(),
    unregistered: [...declared.keys()].filter((key) => !registered.has(key)).sort(),
    stale: [...registered.keys()].filter((key) => !declared.has(key)).sort(),
    duplicateRegistrations: [...new Set(duplicateRegistrations)].sort(),
  };
}

export function auditSourcePaths(audit) {
  return [...new Set(sourceEntries(audit).map((entry) => entry.path))].sort();
}

export function validateSourceAudit(audit, contract, root) {
  exactKeys(audit, ['schemaVersion', 'scope', 'rules', 'surfaces'], 'source audit');
  assert(audit.schemaVersion === 1, 'source audit schemaVersion changed');
  exactKeys(audit.rules, ['canonicalFactsAreAppendOnly', 'projectionsAreRebuildable', 'projectionMayFeedEvaluator', 'allTenantReadsAreScoped', 'sourceLocationsAreDigestBoundByAcceptanceManifest'], 'source audit rules');
  assert(Object.values(audit.rules).every((value, index) => index === 2 ? value === false : value === true), 'source audit safety rule changed');
  exactArray(audit.surfaces.map((surface) => surface.id), FROZEN_SOURCE_SURFACES, 'source audit surfaces');
  for (const surface of audit.surfaces) {
    exactKeys(surface, ['id', 'canonicalFactKinds', 'sourceOfTruth', 'projections', 'writers', 'readers', 'v2Treatment'], `source audit ${surface.id}`);
    assert(surface.canonicalFactKinds.length > 0, `${surface.id} has no fact mapping`);
    assert(surface.canonicalFactKinds.every((kind) => contract.factKinds.includes(kind)), `${surface.id} names an unregistered fact kind`);
    assert(surface.sourceOfTruth.length > 0 && surface.projections.length > 0, `${surface.id} must separate facts and projections`);
    assert(surface.writers.length > 0 && surface.readers.length > 0, `${surface.id} must inventory writers and readers`);
    assert(typeof surface.v2Treatment === 'string' && surface.v2Treatment.length >= 30, `${surface.id} has no V2 boundary decision`);
    for (const entry of [...surface.writers, ...surface.readers]) {
      exactKeys(entry, entry.authority === undefined ? ['path', 'symbol', 'purpose'] : ['path', 'symbol', 'authority'], `${surface.id} source entry`);
      const full = path.resolve(root, entry.path);
      assert(full.startsWith(`${path.resolve(root)}${path.sep}`), `${surface.id} source path escapes the repository`);
      assert(existsSync(full), `${surface.id} source path does not exist: ${entry.path}`);
      const source = readFileSync(full, 'utf8');
      assert(source.includes(entry.symbol), `${surface.id} source symbol ${JSON.stringify(entry.symbol)} is absent from ${entry.path}`);
    }
  }
  const exits = auditV1BlockerSignalExits(root);
  assert(exits.declared.length > 0, 'V1 blocker/signal discovery returned no episodes');
  assert(exits.unregistered.length === 0, `V1 blocker/signal types have no exit: ${exits.unregistered.join(', ')}`);
  assert(exits.stale.length === 0, `V1 exit registrations no longer name a live episode: ${exits.stale.join(', ')}`);
  assert(exits.duplicateRegistrations.length === 0, `V1 exit registrations are duplicated: ${exits.duplicateRegistrations.join(', ')}`);
  return true;
}

function factTrustDecision(fact, input) {
  if (fact.tenantId !== input.binding.tenantId) return 'OUT_OF_SCOPE';
  if (fact.subject.projectId !== input.binding.projectId) return 'OUT_OF_SCOPE';
  if (canonicalJson(fact.binding) !== canonicalJson(input.binding)) return 'OUT_OF_SCOPE';
  if (fact.schemaDigest !== input.binding.factSchemaDigest) return 'STALE_SCHEMA';
  if (fact.authority.grantDigest !== input.binding.authorityGrantDigest) return 'UNTRUSTED';
  const at = logicalTime(fact.logicalTime, 'fact.logicalTime');
  if (at > logicalTime(input.factCut.watermarkLogicalTime, 'factCut.watermarkLogicalTime')) return 'OUT_OF_SCOPE';
  if (at < logicalTime(fact.authority.validFromLogicalTime, 'authority.validFromLogicalTime')) return 'UNTRUSTED';
  if (fact.authority.validThroughLogicalTime !== null && at > logicalTime(fact.authority.validThroughLogicalTime, 'authority.validThroughLogicalTime')) return 'UNTRUSTED';
  if (fact.authority.revokedAtLogicalTime !== null && logicalTime(fact.authority.revokedAtLogicalTime, 'authority.revokedAtLogicalTime') <= logicalTime(input.clock.evaluatedThroughLogicalTime, 'clock.evaluatedThroughLogicalTime')) return 'REVOKED';
  return 'TRUSTED';
}

function dimensionsFromFacts(contract, trustedFacts) {
  return contract.completionDimensions.map((declaration) => {
    const candidates = trustedFacts.filter((fact) => fact.factKind === 'DIMENSION_EVALUATED' && fact.payload?.dimensionId === declaration.id);
    if (candidates.length === 0) {
      return {
        dimensionId: declaration.id,
        state: 'UNKNOWN',
        evidenceFactIds: [],
        applicabilityProofDigest: null,
        reasonCode: 'NO_CURRENT_TRUSTED_EVIDENCE',
      };
    }
    const newest = candidates.reduce((max, fact) => logicalTime(fact.logicalTime, 'fact.logicalTime') > max ? logicalTime(fact.logicalTime, 'fact.logicalTime') : max, 0n);
    const current = candidates.filter((fact) => logicalTime(fact.logicalTime, 'fact.logicalTime') === newest);
    const states = [...new Set(current.map((fact) => fact.payload.state))];
    if (states.length !== 1 || !contract.stateAlgebra.states.includes(states[0])) {
      return {
        dimensionId: declaration.id,
        state: 'CONFLICT',
        evidenceFactIds: current.map((fact) => fact.factId).sort(),
        applicabilityProofDigest: null,
        reasonCode: 'AUTHORITATIVE_FACT_CONFLICT',
      };
    }
    const state = states[0];
    const applicabilityProofs = [...new Set(current.map((fact) => fact.payload.applicabilityProofDigest ?? null))];
    if (state === 'NOT_APPLICABLE' && (!declaration.notApplicableAllowed || applicabilityProofs.length !== 1 || applicabilityProofs[0] === null || !DIGEST_RE.test(applicabilityProofs[0]))) {
      return {
        dimensionId: declaration.id,
        state: 'UNKNOWN',
        evidenceFactIds: current.map((fact) => fact.factId).sort(),
        applicabilityProofDigest: null,
        reasonCode: 'NOT_APPLICABLE_WITHOUT_CURRENT_PROOF',
      };
    }
    return {
      dimensionId: declaration.id,
      state,
      evidenceFactIds: current.map((fact) => fact.factId).sort(),
      applicabilityProofDigest: state === 'NOT_APPLICABLE' ? applicabilityProofs[0] : null,
      reasonCode: String(current[0].payload.reasonCode ?? `DIMENSION_${state}`),
    };
  });
}

function attemptsFromFacts(contract, trustedFacts, goal) {
  const byId = new Map();
  for (const fact of trustedFacts) {
    if (!['ATTEMPT_STARTED', 'ATTEMPT_TERMINATED'].includes(fact.factKind)) continue;
    const attempt = fact.payload?.attempt;
    validateAttempt(attempt, contract);
    if (attempt.goalId !== goal.goalId || attempt.goalRevision !== goal.goalRevision) continue;
    const existing = byId.get(attempt.attemptId);
    if (!existing || logicalTime(fact.logicalTime, 'fact.logicalTime') > logicalTime(existing.fact.logicalTime, 'existing fact logicalTime')) {
      byId.set(attempt.attemptId, { attempt, fact });
    }
  }
  return [...byId.values()].map((entry) => entry.attempt).sort((left, right) => {
    const generation = logicalTime(left.attemptGeneration, 'attempt generation') - logicalTime(right.attemptGeneration, 'attempt generation');
    if (generation < 0n) return -1;
    if (generation > 0n) return 1;
    return left.attemptId.localeCompare(right.attemptId);
  });
}

function obligationFor(contract, input, { kind, subjectType, subjectId, dimensionId = null, reasonCode, evidenceFactIds = [], dueLogicalTime = null }) {
  const declaration = obligationKindById(contract, kind);
  assert(declaration, `no obligation declaration for ${kind}`);
  const bindingDigest = sha256Canonical(input.binding);
  const obligationId = stableObligationIdentity({
    tenantId: input.binding.tenantId,
    goalId: input.goal.goalId,
    goalRevision: input.goal.goalRevision,
    contractDigest: input.goal.contractDigest,
    kind,
    subjectType,
    subjectId,
    homeProjectId: input.goal.projectId,
  }, contract);
  const actionProtocolDigest = sha256Canonical(profileById(contract, declaration.actionProtocolProfile));
  const revision = obligationRevision({
    obligationId,
    bindingDigest,
    authorityGrantDigest: input.binding.authorityGrantDigest,
    reasonCode,
    owner: declaration.defaultOwner,
    capability: declaration.capability,
    actionProtocolDigest,
    dueLogicalTime,
  }, contract);
  return {
    obligationId,
    obligationRevision: revision,
    kind,
    state: 'ACTIVE',
    mandatory: true,
    owner: declaration.defaultOwner,
    capability: declaration.capability,
    binding: input.binding,
    reason: {
      code: reasonCode,
      message: `${kind} is required for ${subjectType}:${subjectId}.`,
      evidenceFactIds: [...evidenceFactIds].sort(),
      attemptedActions: [],
      nextAction: declaration.capability,
    },
    actionProtocolProfile: declaration.actionProtocolProfile,
    servesCriterionIds: dimensionId === 'CRITERIA_EVALUATION' ? [dimensionId] : [],
    blocksClosureOf: dimensionId === null ? [] : [dimensionId],
    ownership: {
      homeProjectId: input.goal.projectId,
      blockingProjectIds: dimensionId === null ? [] : [input.goal.projectId],
      crossingId: null,
      handoffId: null,
      handoffStatus: 'NOT_REQUIRED',
      attributionDecisionFactId: null,
    },
    resolverProfile: declaration.resolverProfile,
    createdAtLogicalTime: input.factCut.watermarkLogicalTime,
    dueLogicalTime,
  };
}

function validateObligation(obligation, contract) {
  exactKeys(obligation, contract.obligationContract.requiredFields, 'obligation');
  digest(obligation.obligationId, 'obligation.obligationId');
  digest(obligation.obligationRevision, 'obligation.obligationRevision');
  assert(FROZEN_OBLIGATION_KINDS.includes(obligation.kind), 'obligation kind is invalid');
  assert(contract.obligationContract.states.includes(obligation.state), 'obligation state is invalid');
  assert(contract.obligationContract.owners.includes(obligation.owner), 'obligation owner is invalid');
  validateBinding(obligation.binding, contract);
  exactKeys(obligation.reason, ['code', 'message', 'evidenceFactIds', 'attemptedActions', 'nextAction'], 'obligation.reason');
  exactKeys(obligation.ownership, contract.crossProjectContract.ownershipRequiredFields, 'obligation.ownership');
  assert(Array.isArray(obligation.servesCriterionIds) && Array.isArray(obligation.blocksClosureOf), 'obligation edges must be arrays');
  assert(new Set(obligation.servesCriterionIds).size === obligation.servesCriterionIds.length, 'servesCriterionIds must be unique');
  assert(new Set(obligation.blocksClosureOf).size === obligation.blocksClosureOf.length, 'blocksClosureOf must be unique');
  assert(obligation.servesCriterionIds.every((entry) => typeof entry === 'string' && entry.length > 0), 'servesCriterionIds must contain stable ids');
  assert(obligation.blocksClosureOf.every((entry) => FROZEN_COMPLETION_DIMENSIONS.includes(entry)), 'blocksClosureOf must name frozen completion dimensions');
  const ownership = obligation.ownership;
  assert(typeof ownership.homeProjectId === 'string' && ownership.homeProjectId.length > 0, 'ownership.homeProjectId must be non-empty');
  assert(ownership.homeProjectId === obligation.binding.projectId, 'obligation ownership cannot implicitly adopt a foreign project');
  assert(Array.isArray(ownership.blockingProjectIds), 'ownership.blockingProjectIds must be an array');
  assert(new Set(ownership.blockingProjectIds).size === ownership.blockingProjectIds.length, 'ownership.blockingProjectIds must be unique');
  assert(ownership.blockingProjectIds.every((entry) => typeof entry === 'string' && entry.length > 0), 'ownership.blockingProjectIds must contain stable ids');
  assert(contract.crossProjectContract.handoffStatuses.includes(ownership.handoffStatus), 'ownership.handoffStatus is invalid');
  for (const field of ['crossingId', 'handoffId', 'attributionDecisionFactId']) {
    assert(ownership[field] === null || (typeof ownership[field] === 'string' && ownership[field].length > 0), `ownership.${field} must be null or a stable id`);
  }
  const hasForeignClosureEdge = ownership.blockingProjectIds.some((projectId) => projectId !== ownership.homeProjectId);
  assert(!hasForeignClosureEdge || ownership.crossingId !== null, 'foreign closure edge requires crossingId');
  assert(!hasForeignClosureEdge || ownership.attributionDecisionFactId !== null, 'foreign closure edge requires attributionDecisionFactId');
  assert(hasForeignClosureEdge || ownership.crossingId === null, 'local-only obligation cannot claim a crossing');
  assert(hasForeignClosureEdge || ownership.attributionDecisionFactId === null, 'local-only obligation cannot claim foreign attribution');
  assert((ownership.handoffStatus === 'NOT_REQUIRED') === (ownership.handoffId === null), 'handoffId and handoffStatus must agree');
  assert(obligation.resolverProfile === 'STANDARD_MANDATORY', 'obligation lacks complete resolver profile');
  logicalTime(obligation.createdAtLogicalTime, 'obligation.createdAtLogicalTime');
  if (obligation.dueLogicalTime !== null) logicalTime(obligation.dueLogicalTime, 'obligation.dueLogicalTime');
  return obligation;
}

export function evaluateOutcome(input, contract, schema) {
  assertFrozenContract(contract, schema);
  exactKeys(input, ['goal', 'binding', 'factCut', 'facts', 'clock', 'durableTimers', 'declaredObligations'], 'evaluation input');
  validateGoal(input.goal, contract);
  validateBinding(input.binding, contract);
  assert(input.goal.tenantId === input.binding.tenantId && input.goal.projectId === input.binding.projectId, 'goal and binding scope differ');
  assert(input.goal.goalId === input.binding.goalId && input.goal.goalRevision === input.binding.goalRevision, 'goal and binding identity differ');
  assert(input.goal.contractDigest === input.binding.contractDigest, 'goal and binding contract digests differ');
  assert(input.goal.evaluationPlanDigest === input.binding.evaluationPlanDigest, 'goal and binding evaluation plan digests differ');
  exactKeys(input.clock, contract.logicalTimeContract.evaluationRequiredFields, 'evaluation clock');
  logicalTime(input.clock.logicalNow, 'clock.logicalNow');
  logicalTime(input.clock.evaluatedThroughLogicalTime, 'clock.evaluatedThroughLogicalTime');
  assert(logicalTime(input.clock.evaluatedThroughLogicalTime, 'clock.evaluatedThroughLogicalTime') === logicalTime(input.factCut.watermarkLogicalTime, 'factCut.watermarkLogicalTime'), 'evaluation watermark must equal the sealed cut watermark');
  assert(logicalTime(input.clock.logicalNow, 'clock.logicalNow') >= logicalTime(input.clock.evaluatedThroughLogicalTime, 'clock.evaluatedThroughLogicalTime'), 'logicalNow is behind the evaluated cut');
  assert(Array.isArray(input.facts), 'facts must be an array');
  for (const fact of input.facts) validateCanonicalFact(fact, contract);
  validateFactCut(input.factCut, input.facts, contract);
  assert(input.factCut.tenantId === input.binding.tenantId && input.factCut.projectId === input.binding.projectId, 'fact cut scope differs from binding');
  assert(Array.isArray(input.durableTimers), 'durableTimers must be an array');
  for (const timer of input.durableTimers) validateDurableTimer(timer, contract);
  assert(Array.isArray(input.declaredObligations), 'declaredObligations must be an array');
  for (const obligation of input.declaredObligations) validateObligation(obligation, contract);

  const trust = input.facts.map((fact) => ({ fact, decision: factTrustDecision(fact, input) }));
  const trustedFacts = trust.filter((entry) => entry.decision === 'TRUSTED').map((entry) => entry.fact);
  const rejectedFacts = trust.filter((entry) => entry.decision !== 'TRUSTED').map((entry) => ({ factId: entry.fact.factId, decision: entry.decision }));
  const dimensions = dimensionsFromFacts(contract, trustedFacts);
  const attempts = attemptsFromFacts(contract, trustedFacts, input.goal);
  const modelGaps = [...new Set(trustedFacts.filter((fact) => fact.factKind === 'MODEL_GAP_DETECTED').map((fact) => String(fact.payload?.code ?? 'UNSPECIFIED_MODEL_GAP')))];
  if (input.facts.length === 0) modelGaps.push('EMPTY_FACT_CUT');
  if (!input.factCut.complete || !input.factCut.linearizable) modelGaps.push('INCOMPLETE_OR_NONLINEARIZABLE_FACT_CUT');

  const obligations = [];
  for (const proof of dimensions) {
    if (!['SATISFIED', 'NOT_APPLICABLE'].includes(proof.state)) {
      const declaration = contract.completionDimensions.find((entry) => entry.id === proof.dimensionId);
      obligations.push(obligationFor(contract, input, {
        kind: declaration.unsatisfiedObligationKind,
        subjectType: 'COMPLETION_DIMENSION',
        subjectId: proof.dimensionId,
        dimensionId: proof.dimensionId,
        reasonCode: proof.reasonCode,
        evidenceFactIds: proof.evidenceFactIds,
      }));
    }
  }
  for (const gap of modelGaps) {
    obligations.push(obligationFor(contract, input, {
      kind: 'DIAGNOSE_MODEL_GAP',
      subjectType: 'MODEL_GAP',
      subjectId: gap,
      dimensionId: 'MODEL_COVERAGE',
      reasonCode: gap,
    }));
  }
  const latestAttempt = attempts.at(-1) ?? null;
  if (
    input.goal.disposition === 'ACTIVE'
    && latestAttempt?.status === 'CLOSED'
    && ['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(latestAttempt.outcome)
  ) {
    obligations.push(obligationFor(contract, input, {
      kind: 'START_SUCCESSOR_ATTEMPT',
      subjectType: 'GOAL',
      subjectId: input.goal.goalId,
      reasonCode: `ATTEMPT_${latestAttempt.outcome}_GOAL_ACTIVE`,
    }));
  }
  for (const timer of input.durableTimers) {
    if (timer.state === 'SCHEDULED' && logicalTime(timer.dueLogicalTime, 'timer.dueLogicalTime') <= logicalTime(input.clock.logicalNow, 'clock.logicalNow')) {
      const fired = trustedFacts.some((fact) => fact.factKind === 'TIMER_FIRED' && fact.payload?.timerId === timer.timerId);
      if (!fired) {
        modelGaps.push('OVERDUE_DURABLE_TIMER');
        obligations.push(obligationFor(contract, input, {
          kind: 'RECOVER_RECONCILER',
          subjectType: 'DURABLE_TIMER',
          subjectId: timer.timerId,
          reasonCode: 'OVERDUE_DURABLE_TIMER',
          dueLogicalTime: timer.dueLogicalTime,
        }));
      }
    }
  }
  obligations.push(...input.declaredObligations.filter((entry) => entry.state === 'ACTIVE'));
  const uniqueObligations = [...new Map(obligations.map((entry) => [entry.obligationId, entry])).values()]
    .sort((left, right) => left.obligationId.localeCompare(right.obligationId));
  const activeMandatory = uniqueObligations.filter((entry) => entry.mandatory && entry.state === 'ACTIVE');
  const dimensionState = new Map(dimensions.map((entry) => [entry.dimensionId, entry.state]));
  const ratified = input.goal.ratification.status === 'RATIFIED'
    && input.goal.ratification.contractDigest === input.goal.contractDigest
    && contract.digestContract.allowedRatifers.includes(input.goal.ratification.ratifierType);
  const planMatches = input.goal.evaluationPlanDigest === input.binding.evaluationPlanDigest;
  const cutTrusted = input.factCut.complete && input.factCut.linearizable && input.facts.length > 0 && rejectedFacts.length === 0;
  const evaluatorMatches = input.binding.evaluatorDigest === sha256Canonical({ id: 'OUTCOME_RECONCILER', version: contract.evaluatorVersion });
  const allEligible = dimensions.length === FROZEN_COMPLETION_DIMENSIONS.length && dimensions.every((entry) => ['SATISFIED', 'NOT_APPLICABLE'].includes(entry.state));
  const staleOrRevoked = rejectedFacts.some((entry) => ['OUT_OF_SCOPE', 'REVOKED', 'STALE_SCHEMA'].includes(entry.decision));
  const closedClauseResults = {
    CONTRACT_RATIFIED_FOR_EXACT_CONTRACT_DIGEST: ratified,
    EVALUATION_PLAN_MATCHES_EXACT_EVALUATION_PLAN_DIGEST: planMatches,
    FACT_CUT_IS_COMPLETE_LINEARIZABLE_AND_TRUSTED: cutTrusted,
    EVALUATOR_VERSION_AND_DIGEST_MATCH_BINDING: evaluatorMatches,
    EVERY_MANDATORY_DIMENSION_IS_SATISFIED_OR_PROVEN_NOT_APPLICABLE: allEligible,
    NO_UNKNOWN_DIMENSION: !dimensions.some((entry) => entry.state === 'UNKNOWN'),
    NO_UNSATISFIED_DIMENSION: !dimensions.some((entry) => entry.state === 'UNSATISFIED'),
    NO_CONFLICT_DIMENSION: !dimensions.some((entry) => entry.state === 'CONFLICT'),
    NO_MODEL_GAP: modelGaps.length === 0,
    GOAL_DISPOSITION_IS_ACHIEVED: input.goal.disposition === 'ACHIEVED' && dimensionState.get('GOAL_DISPOSITION') === 'SATISFIED',
    NO_ACTIVE_MANDATORY_OBLIGATION: activeMandatory.length === 0,
    NO_STALE_OR_REVOKED_BINDING: !staleOrRevoked,
    NO_UNREMEDIATED_SIDE_EFFECT: ['SATISFIED', 'NOT_APPLICABLE'].includes(dimensionState.get('ACTION_REMEDIATION')),
    ALL_EXTERNAL_CLOSURE_DEPENDENCIES_SETTLED: ['SATISFIED', 'NOT_APPLICABLE'].includes(dimensionState.get('EXTERNAL_CLOSURE_DEPENDENCIES')),
  };
  exactKeys(closedClauseResults, contract.closedContract.clauses, 'closed clause results');
  const closed = Object.values(closedClauseResults).every(Boolean);
  const proofBody = {
    contractDigest: input.goal.contractDigest,
    evaluationPlanDigest: input.goal.evaluationPlanDigest,
    factCutDigest: input.binding.factCutDigest,
    evaluatorVersion: contract.evaluatorVersion,
    evaluatedThroughLogicalTime: input.clock.evaluatedThroughLogicalTime,
    dimensions,
    modelGaps: [...new Set(modelGaps)].sort(),
    closed,
    closedClauseResults,
  };
  const proof = { proofDigest: sha256Canonical(proofBody), ...proofBody };
  return {
    proof,
    obligations: uniqueObligations,
    attempts,
    rejectedFacts,
    projectionSeed: uniqueObligations.map((entry, index) => ({
      obligationId: entry.obligationId,
      obligationRevision: entry.obligationRevision,
      bindingDigest: sha256Canonical(entry.binding),
      reason: entry.reason,
      owner: entry.owner,
      evaluatedThroughLogicalTime: input.clock.evaluatedThroughLogicalTime,
      projectionRevision: String(index + 1),
      staleness: 'CURRENT',
    })),
  };
}
