import { createHash } from 'node:crypto';

export const OUTCOME_EVALUATOR_VERSION = 'outcome-reducer-v2';

export const OUTCOME_STATES = [
  'SATISFIED',
  'UNSATISFIED',
  'UNKNOWN',
  'CONFLICT',
  'NOT_APPLICABLE',
] as const;

export type OutcomeState = (typeof OUTCOME_STATES)[number];

export interface OutcomeDimensionDeclaration {
  id: string;
  notApplicableAllowed: boolean;
  obligationKind: string;
}

export const OUTCOME_DIMENSIONS: readonly OutcomeDimensionDeclaration[] = Object.freeze([
  { id: 'GOAL_DISPOSITION', notApplicableAllowed: false, obligationKind: 'ESTABLISH_GOAL_DISPOSITION' },
  { id: 'CONTRACT_RATIFICATION', notApplicableAllowed: false, obligationKind: 'REQUEST_GOAL_DECISION' },
  { id: 'CRITERIA_EVALUATION', notApplicableAllowed: false, obligationKind: 'SATISFY_COMPLETION_DIMENSION' },
  { id: 'FACT_CUT_INTEGRITY', notApplicableAllowed: false, obligationKind: 'REPAIR_FACT_CUT' },
  { id: 'EVIDENCE_TRUST', notApplicableAllowed: false, obligationKind: 'REPAIR_FACT_CUT' },
  { id: 'BINDING_FRESHNESS', notApplicableAllowed: false, obligationKind: 'REFRESH_STALE_BINDING' },
  { id: 'AUTHORITY_VALIDITY', notApplicableAllowed: false, obligationKind: 'REQUEST_NEW_AUTHORIZATION' },
  { id: 'POLICY_COMPLIANCE', notApplicableAllowed: false, obligationKind: 'REQUEST_RISK_ACCEPTANCE' },
  { id: 'BUDGET_COMPLIANCE', notApplicableAllowed: false, obligationKind: 'REQUEST_RISK_ACCEPTANCE' },
  { id: 'ARTIFACT_INTEGRATION', notApplicableAllowed: true, obligationKind: 'PROVE_ARTIFACT_INTEGRATION' },
  { id: 'TARGET_PRESENCE', notApplicableAllowed: true, obligationKind: 'PROVE_TARGET_PRESENCE' },
  { id: 'POST_MERGE_VERIFICATION', notApplicableAllowed: true, obligationKind: 'RUN_BOUND_VERIFICATION' },
  { id: 'EXTERNAL_CLOSURE_DEPENDENCIES', notApplicableAllowed: true, obligationKind: 'MONITOR_EXTERNAL_WAIT' },
  { id: 'ACTION_REMEDIATION', notApplicableAllowed: true, obligationKind: 'REMEDIATE_SIDE_EFFECT' },
  { id: 'MODEL_COVERAGE', notApplicableAllowed: false, obligationKind: 'DIAGNOSE_MODEL_GAP' },
]);

const CLOSED_CLAUSES = [
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
] as const;

const OBLIGATION_PROTOCOL = Object.freeze({
  ESTABLISH_GOAL_DISPOSITION: ['AGENT', 'goal.disposition.propose', 'AGENT_ACTION'],
  SATISFY_COMPLETION_DIMENSION: ['AGENT', 'dimension.satisfy', 'AGENT_ACTION'],
  REPAIR_FACT_CUT: ['SYSTEM', 'fact-cut.repair', 'SYSTEM_ACTION'],
  REFRESH_STALE_BINDING: ['SYSTEM', 'binding.refresh', 'SYSTEM_ACTION'],
  PROVE_ARTIFACT_INTEGRATION: ['AGENT', 'artifact.integrate', 'AGENT_ACTION'],
  PROVE_TARGET_PRESENCE: ['SYSTEM', 'target.presence.verify', 'SYSTEM_ACTION'],
  RUN_BOUND_VERIFICATION: ['AGENT', 'verification.execute', 'AGENT_ACTION'],
  DIAGNOSE_MODEL_GAP: ['AGENT', 'model-gap.diagnose', 'AGENT_ACTION'],
  START_SUCCESSOR_ATTEMPT: ['AGENT', 'attempt.start-successor', 'AGENT_ACTION'],
  MONITOR_EXTERNAL_WAIT: ['SYSTEM', 'external-wait.monitor', 'EXTERNAL_MONITOR'],
  REQUEST_GOAL_DECISION: ['OWNER', 'owner.goal-decision', 'OWNER_DECISION'],
  REQUEST_RISK_ACCEPTANCE: ['OWNER', 'owner.risk-acceptance', 'OWNER_DECISION'],
  REQUEST_NEW_AUTHORIZATION: ['OWNER', 'owner.authorization', 'OWNER_DECISION'],
  REQUEST_EXTERNAL_IDENTITY: ['OWNER', 'owner.external-identity', 'OWNER_DECISION'],
  REMEDIATE_SIDE_EFFECT: ['AGENT', 'effect.remediate', 'AGENT_ACTION'],
  RECOVER_RECONCILER: ['SYSTEM', 'reconciler.recover', 'SYSTEM_ACTION'],
} satisfies Record<string, readonly [string, string, string]>);

const STATE_RANK = new Map<OutcomeState, number>([
  ['NOT_APPLICABLE', 0],
  ['SATISFIED', 1],
  ['UNSATISFIED', 2],
  ['UNKNOWN', 3],
  ['CONFLICT', 4],
]);

type JsonRecord = Record<string, unknown>;

interface NormalizedFact {
  envelope: JsonRecord;
  factId: string;
  factKind: string;
  logicalTime: bigint | null;
  logicalTimeText: string;
  trustDecision: string;
  proofEligible: boolean;
  authoritative: boolean;
  rejection: string | null;
}

export interface OutcomeDimensionResult {
  dimensionId: string;
  state: OutcomeState;
  evidenceFactIds: string[];
  applicabilityProofDigest: string | null;
  reasonCode: string;
}

export interface ActiveMandatoryObligation {
  obligationId: string;
  obligationRevision: string;
  kind: string;
  state: 'ACTIVE';
  mandatory: true;
  owner: string;
  capability: string;
  binding: JsonRecord;
  bindingDigest: string;
  goalId: string;
  goalRevision: string;
  reason: {
    code: string;
    message: string;
    evidenceFactIds: string[];
    attemptedActions: string[];
    nextAction: string;
  };
  actionProtocolProfile: string;
  servesCriterionIds: string[];
  blocksClosureOf: string[];
  ownership: {
    homeProjectId: string;
    blockingProjectIds: string[];
    crossingId: null;
    handoffId: null;
    handoffStatus: 'NOT_REQUIRED';
    attributionDecisionFactId: null;
  };
  resolverProfile: 'STANDARD_MANDATORY';
  createdAtLogicalTime: string;
  dueLogicalTime: string | null;
}

export interface OutcomeEvaluationResult {
  schemaVersion: 1;
  evaluatorVersion: string;
  evaluatorDigest: string;
  bindingDigest: string;
  evaluatedThroughLogicalTime: string;
  proof: {
    proofDigest: string;
    contractDigest: string;
    evaluationPlanDigest: string;
    factCutDigest: string;
    evaluatorVersion: string;
    evaluatedThroughLogicalTime: string;
    dimensions: OutcomeDimensionResult[];
    modelGaps: string[];
    closed: boolean;
    closedClauseResults: Record<(typeof CLOSED_CLAUSES)[number], boolean>;
    proofGraphDigest: string;
  };
  proofGraph: {
    leaves: Array<{
      nodeId: string;
      kind: 'AUTHORITATIVE_FACT' | 'UNAVAILABLE_FACT';
      factId: string;
      factKind: string | null;
      logicalTime: string | null;
      trustDecision: string;
      proofEligible: boolean;
      authoritative: boolean;
    }>;
    dimensions: Array<{
      nodeId: string;
      kind: 'DIMENSION';
      dimensionId: string;
      state: OutcomeState;
      inputs: string[];
    }>;
    root: {
      nodeId: string;
      kind: 'OUTCOME';
      inputs: string[];
      closed: boolean;
    };
  };
  activeMandatoryObligations: ActiveMandatoryObligation[];
  attempts: JsonRecord[];
  rejectedFacts: Array<{ factId: string; decision: string }>;
  closed: boolean;
  evaluationDigest: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function logicalTime(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function stableStrings(value: unknown): string[] {
  return [...new Set(arrayValue(value).filter((entry): entry is string => (
    typeof entry === 'string' && entry.length > 0
  )))].sort();
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** RFC 8785-compatible for the JSON values admitted by the trust envelope. */
export function canonicalOutcomeJson(value: unknown): string {
  const ancestors = new Set<object>();
  function normalize(node: unknown, at: string): unknown {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new TypeError(`${at} contains a non-finite number`);
      return Object.is(node, -0) ? 0 : node;
    }
    if (typeof node !== 'object' || node === undefined) {
      throw new TypeError(`${at} is not canonically JSON encodable`);
    }
    if (ancestors.has(node)) throw new TypeError(`${at} contains a cycle`);
    ancestors.add(node);
    let normalized: unknown;
    if (Array.isArray(node)) {
      normalized = node.map((entry, index) => normalize(entry, `${at}[${index}]`));
    } else {
      const output: JsonRecord = {};
      for (const key of Object.keys(node as JsonRecord).sort()) {
        const child = (node as JsonRecord)[key];
        if (child === undefined) throw new TypeError(`${at}.${key} is undefined`);
        output[key] = normalize(child, `${at}.${key}`);
      }
      normalized = output;
    }
    ancestors.delete(node);
    return normalized;
  }
  return JSON.stringify(normalize(value, '$'));
}

export function outcomeDigest(value: unknown): string {
  return createHash('sha256').update(canonicalOutcomeJson(value)).digest('hex');
}

export function outcomeEvaluatorDigest(version = OUTCOME_EVALUATOR_VERSION): string {
  return outcomeDigest({ id: 'OUTCOME_RECONCILER', version });
}

/** The frozen five-state join. It is total for every pair in the declared algebra. */
export function combineOutcomeStates(left: OutcomeState, right: OutcomeState): OutcomeState {
  const leftRank = STATE_RANK.get(left);
  const rightRank = STATE_RANK.get(right);
  if (leftRank === undefined || rightRank === undefined) return 'CONFLICT';
  return leftRank >= rightRank ? left : right;
}

function canonicalEquals(left: unknown, right: unknown): boolean {
  try {
    return canonicalOutcomeJson(left) === canonicalOutcomeJson(right);
  } catch {
    return false;
  }
}

function normalizeFacts(
  rawFacts: unknown,
  binding: JsonRecord,
  cut: JsonRecord,
  modelGaps: Set<string>,
): { facts: NormalizedFact[]; integrity: boolean } {
  const watermark = logicalTime(cut.watermarkLogicalTime);
  const cutIds = stableStrings(cut.factIds);
  const rawEntries = arrayValue(rawFacts);
  const facts: NormalizedFact[] = [];
  for (const rawEntry of rawEntries) {
    const entry = isRecord(rawEntry) ? rawEntry : {};
    const envelope = isRecord(entry.envelope) ? entry.envelope : entry;
    const factId = stringValue(envelope.factId, `malformed:${facts.length}`);
    const factKind = stringValue(envelope.factKind, 'MALFORMED');
    const at = logicalTime(envelope.logicalTime);
    let trustDecision = typeof entry.trustDecision === 'string'
      ? entry.trustDecision
      : (isRecord(envelope.principal) && envelope.principal.type === 'AGENT' ? 'CLAIM_ONLY' : 'TRUSTED');
    let proofEligible = typeof entry.proofEligible === 'boolean'
      ? entry.proofEligible
      : trustDecision === 'TRUSTED';
    let rejection: string | null = null;

    if (!isRecord(envelope.binding) || !canonicalEquals(envelope.binding, binding)) rejection = 'OUT_OF_SCOPE';
    else if (envelope.tenantId !== binding.tenantId) rejection = 'OUT_OF_SCOPE';
    else if (!isRecord(envelope.subject) || envelope.subject.projectId !== binding.projectId) rejection = 'OUT_OF_SCOPE';
    else if (envelope.schemaDigest !== binding.factSchemaDigest) rejection = 'STALE_SCHEMA';
    else if (!isRecord(envelope.authority) || envelope.authority.grantDigest !== binding.authorityGrantDigest) rejection = 'UNTRUSTED';
    else if (at === null || watermark === null || at > watermark) rejection = 'OUT_OF_SCOPE';
    else if (logicalTime(envelope.authority.validFromLogicalTime) === null
      || at < (logicalTime(envelope.authority.validFromLogicalTime) ?? 0n)) rejection = 'UNTRUSTED';
    else if (envelope.authority.validThroughLogicalTime !== null
      && (logicalTime(envelope.authority.validThroughLogicalTime) === null
        || at > (logicalTime(envelope.authority.validThroughLogicalTime) ?? -1n))) rejection = 'UNTRUSTED';
    else if (envelope.authority.revokedAtLogicalTime !== null
      && (logicalTime(envelope.authority.revokedAtLogicalTime) === null
        || (logicalTime(envelope.authority.revokedAtLogicalTime) ?? 0n) <= (watermark ?? 0n))) rejection = 'REVOKED';
    else if (!isDigest(envelope.payloadDigest) || !canonicalEquals(
      envelope.payloadDigest,
      (() => {
        try { return outcomeDigest(envelope.payload); } catch { return null; }
      })(),
    )) rejection = 'BAD_DIGEST';
    else if (isRecord(envelope.principal) && envelope.principal.type === 'AGENT') {
      trustDecision = 'CLAIM_ONLY';
      proofEligible = false;
    } else if (isRecord(envelope.source) && stringValue(envelope.source.system).startsWith('PROJECTION:')) {
      rejection = 'UNTRUSTED';
    }

    if (rejection !== null) {
      trustDecision = rejection;
      proofEligible = false;
    }
    const authoritative = trustDecision === 'TRUSTED' && proofEligible;
    facts.push({
      envelope,
      factId,
      factKind,
      logicalTime: at,
      logicalTimeText: at === null ? '' : at.toString(),
      trustDecision,
      proofEligible,
      authoritative,
      rejection: rejection ?? (authoritative ? null : trustDecision),
    });
  }

  facts.sort((left, right) => {
    if (left.logicalTime === null && right.logicalTime !== null) return 1;
    if (left.logicalTime !== null && right.logicalTime === null) return -1;
    if (left.logicalTime !== null && right.logicalTime !== null) {
      if (left.logicalTime < right.logicalTime) return -1;
      if (left.logicalTime > right.logicalTime) return 1;
    }
    return compareStableStrings(left.factId, right.factId);
  });
  const sortedIds = facts.map((fact) => fact.factId);
  let factSetDigest = '';
  try { factSetDigest = outcomeDigest(facts.map((fact) => fact.envelope)); } catch { /* invalid below */ }
  const integrity = watermark !== null
    && booleanValue(cut.complete)
    && booleanValue(cut.linearizable)
    && Number.isInteger(cut.factCount)
    && cut.factCount === facts.length
    && arrayValue(cut.factIds).length === facts.length
    && canonicalEquals(arrayValue(cut.factIds), sortedIds)
    && isDigest(cut.factSetDigest)
    && cut.factSetDigest === factSetDigest
    && cutIds.length === facts.length
    && facts.every((fact) => fact.logicalTime !== null && fact.logicalTime <= watermark);
  if (!integrity) modelGaps.add('INCOMPLETE_OR_NONLINEARIZABLE_FACT_CUT');
  if (facts.length === 0) modelGaps.add('EMPTY_FACT_CUT');
  return { facts, integrity };
}

function dimensionResults(
  facts: NormalizedFact[],
  modelGaps: Set<string>,
): OutcomeDimensionResult[] {
  const byId = new Map(OUTCOME_DIMENSIONS.map((entry) => [entry.id, entry]));
  for (const fact of facts) {
    if (!fact.authoritative || fact.factKind !== 'DIMENSION_EVALUATED') continue;
    const payload = isRecord(fact.envelope.payload) ? fact.envelope.payload : {};
    const dimensionId = stringValue(payload.dimensionId);
    if (!byId.has(dimensionId)) modelGaps.add('UNKNOWN_COMPLETION_DIMENSION');
  }

  return OUTCOME_DIMENSIONS.map((declaration) => {
    const candidates = facts.filter((fact) => {
      if (!fact.authoritative || fact.factKind !== 'DIMENSION_EVALUATED') return false;
      const payload = isRecord(fact.envelope.payload) ? fact.envelope.payload : {};
      return payload.dimensionId === declaration.id && fact.logicalTime !== null;
    });
    if (candidates.length === 0) {
      modelGaps.add(`MISSING_REQUIRED_DIMENSION_${declaration.id}`);
      return {
        dimensionId: declaration.id,
        state: 'UNKNOWN',
        evidenceFactIds: [],
        applicabilityProofDigest: null,
        reasonCode: 'NO_CURRENT_AUTHORITATIVE_EVIDENCE',
      };
    }
    // Recorded logical time orders ingress; it does not silently make an unrelated assertion
    // true.  A later authoritative fact replaces an earlier one only through the canonical
    // causal-predecessor edge.  Otherwise both facts remain on the current frontier and a late
    // matching contradiction is visible as CONFLICT instead of being hidden by last-write-wins.
    const candidateIds = new Set(candidates.map((fact) => fact.factId));
    const superseded = new Set(candidates.flatMap((fact) => {
      const predecessor = stringValue(fact.envelope.causalPredecessorFactId);
      return predecessor && candidateIds.has(predecessor) ? [predecessor] : [];
    }));
    const current = candidates.filter((fact) => !superseded.has(fact.factId));
    const states = [...new Set(current.map((fact) => {
      const payload = isRecord(fact.envelope.payload) ? fact.envelope.payload : {};
      return stringValue(payload.state);
    }))];
    if (states.length !== 1 || !OUTCOME_STATES.includes(states[0] as OutcomeState)) {
      return {
        dimensionId: declaration.id,
        state: 'CONFLICT',
        evidenceFactIds: current.map((fact) => fact.factId).sort(),
        applicabilityProofDigest: null,
        reasonCode: 'AUTHORITATIVE_FACT_CONFLICT',
      };
    }
    const state = states[0] as OutcomeState;
    const applicability = [...new Set(current.map((fact) => {
      const payload = isRecord(fact.envelope.payload) ? fact.envelope.payload : {};
      return payload.applicabilityProofDigest ?? null;
    }))];
    const evidenceIds = [...new Set(current.flatMap((fact) => {
      const payload = isRecord(fact.envelope.payload) ? fact.envelope.payload : {};
      const declared = stableStrings(payload.evidenceFactIds);
      return declared.length > 0 ? declared : [fact.factId];
    }))].sort();
    const leaves = evidenceIds.map((factId) => facts.find((fact) => fact.factId === factId));
    if (leaves.some((leaf) => !leaf?.authoritative)) {
      modelGaps.add('PROOF_LEAF_NOT_AUTHORITATIVE');
      return {
        dimensionId: declaration.id,
        state: 'UNKNOWN',
        evidenceFactIds: evidenceIds,
        applicabilityProofDigest: null,
        reasonCode: 'PROOF_LEAF_NOT_AUTHORITATIVE',
      };
    }
    if (state === 'NOT_APPLICABLE' && (
      !declaration.notApplicableAllowed || applicability.length !== 1 || !isDigest(applicability[0])
    )) {
      modelGaps.add('NOT_APPLICABLE_WITHOUT_AUTHORITATIVE_PROOF');
      return {
        dimensionId: declaration.id,
        state: 'UNKNOWN',
        evidenceFactIds: evidenceIds,
        applicabilityProofDigest: null,
        reasonCode: 'NOT_APPLICABLE_WITHOUT_CURRENT_PROOF',
      };
    }
    const firstPayload = isRecord(current[0]?.envelope.payload) ? current[0].envelope.payload : {};
    return {
      dimensionId: declaration.id,
      state,
      evidenceFactIds: evidenceIds,
      applicabilityProofDigest: state === 'NOT_APPLICABLE' ? applicability[0] as string : null,
      reasonCode: stringValue(firstPayload.reasonCode, `DIMENSION_${state}`),
    };
  });
}

function validAttempt(value: unknown, goal: JsonRecord): value is JsonRecord {
  if (!isRecord(value)) return false;
  const generation = logicalTime(value.attemptGeneration);
  const started = logicalTime(value.startedAtLogicalTime);
  const ended = value.endedAtLogicalTime === null ? null : logicalTime(value.endedAtLogicalTime);
  const status = stringValue(value.status);
  const outcome = value.outcome === null ? null : stringValue(value.outcome);
  return stringValue(value.attemptId).length > 0
    && generation !== null
    && started !== null
    && value.goalId === goal.goalId
    && value.goalRevision === goal.goalRevision
    && ['OPEN', 'WINDING_DOWN', 'CLOSED'].includes(status)
    && (outcome === null || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'SUPERSEDED'].includes(outcome))
    && ((status === 'CLOSED' && outcome !== null && ended !== null)
      || (status !== 'CLOSED' && outcome === null && value.endedAtLogicalTime === null));
}

function attemptsFromFacts(facts: NormalizedFact[], goal: JsonRecord, modelGaps: Set<string>): JsonRecord[] {
  const byId = new Map<string, { attempt: JsonRecord; at: bigint }>();
  for (const fact of facts) {
    if (!fact.authoritative || !['ATTEMPT_STARTED', 'ATTEMPT_TERMINATED'].includes(fact.factKind)) continue;
    const payload = isRecord(fact.envelope.payload) ? fact.envelope.payload : {};
    if (!validAttempt(payload.attempt, goal) || fact.logicalTime === null) {
      modelGaps.add('MALFORMED_ATTEMPT_FACT');
      continue;
    }
    const attempt = payload.attempt;
    const id = stringValue(attempt.attemptId);
    const previous = byId.get(id);
    if (!previous || fact.logicalTime > previous.at) byId.set(id, { attempt, at: fact.logicalTime });
  }
  const attempts = [...byId.values()].map((entry) => entry.attempt).sort((left, right) => {
    const leftGeneration = logicalTime(left.attemptGeneration) ?? 0n;
    const rightGeneration = logicalTime(right.attemptGeneration) ?? 0n;
    if (leftGeneration < rightGeneration) return -1;
    if (leftGeneration > rightGeneration) return 1;
    return compareStableStrings(stringValue(left.attemptId), stringValue(right.attemptId));
  });
  if (attempts.filter((attempt) => attempt.status !== 'CLOSED').length > 1) {
    modelGaps.add('MULTIPLE_ACTIVE_SUCCESSOR_ATTEMPTS');
  }
  return attempts;
}

function obligation(
  binding: JsonRecord,
  goal: JsonRecord,
  watermark: string,
  kind: string,
  subjectType: string,
  subjectId: string,
  reasonCode: string,
  evidenceFactIds: string[],
  blocksClosureOf: string[],
  dueLogicalTime: string | null = null,
): ActiveMandatoryObligation | null {
  const protocol = OBLIGATION_PROTOCOL[kind as keyof typeof OBLIGATION_PROTOCOL];
  const bindingDigest = (() => {
    try { return outcomeDigest(binding); } catch { return ''; }
  })();
  const tenantId = stringValue(binding.tenantId);
  const projectId = stringValue(binding.projectId);
  const goalId = stringValue(goal.goalId);
  const goalRevision = stringValue(goal.goalRevision);
  const contractDigest = stringValue(goal.contractDigest);
  const authorityGrantDigest = stringValue(binding.authorityGrantDigest);
  if (!protocol || !isDigest(bindingDigest) || !tenantId || !projectId || !goalId
    || logicalTime(goalRevision) === null || !isDigest(contractDigest) || !isDigest(authorityGrantDigest)) return null;
  const [owner, capability, actionProtocolProfile] = protocol;
  const obligationId = outcomeDigest({
    namespace: 'orbit.obligation.v2',
    tenantId,
    goalId,
    goalRevision,
    contractDigest,
    kind,
    subjectType,
    subjectId,
    homeProjectId: projectId,
  });
  const actionProtocolDigest = outcomeDigest({ kind, owner, capability, actionProtocolProfile });
  const obligationRevision = outcomeDigest({
    namespace: 'orbit.obligation-revision.v2',
    obligationId,
    bindingDigest,
    authorityGrantDigest,
    reasonCode,
    owner,
    capability,
    actionProtocolDigest,
    dueLogicalTime,
  });
  return {
    obligationId,
    obligationRevision,
    kind,
    state: 'ACTIVE',
    mandatory: true,
    owner,
    capability,
    binding,
    bindingDigest,
    goalId,
    goalRevision,
    reason: {
      code: reasonCode,
      message: `${kind} is required for ${subjectType}:${subjectId}.`,
      evidenceFactIds: [...evidenceFactIds].sort(),
      attemptedActions: [],
      nextAction: capability,
    },
    actionProtocolProfile,
    servesCriterionIds: blocksClosureOf.includes('CRITERIA_EVALUATION') ? ['CRITERIA_EVALUATION'] : [],
    blocksClosureOf: [...blocksClosureOf].sort(),
    ownership: {
      homeProjectId: projectId,
      blockingProjectIds: [...new Set(blocksClosureOf.length > 0 ? [projectId] : [])],
      crossingId: null,
      handoffId: null,
      handoffStatus: 'NOT_REQUIRED',
      attributionDecisionFactId: null,
    },
    resolverProfile: 'STANDARD_MANDATORY',
    // Creation identity cannot depend on the cut that happened to rediscover the obligation.
    // The binding's logical origin is stable across replay; the event ledger records first
    // activation and every later evaluation watermark separately.
    createdAtLogicalTime: stringValue(binding.asOfLogicalTime, '0'),
    dueLogicalTime,
  };
}

function timerObligations(
  facts: NormalizedFact[],
  binding: JsonRecord,
  goal: JsonRecord,
  watermark: string,
  logicalNow: bigint,
  modelGaps: Set<string>,
): ActiveMandatoryObligation[] {
  const timers = new Map<string, { kind: string; payload: JsonRecord; at: bigint }>();
  for (const fact of facts) {
    if (!fact.authoritative || !['TIMER_SCHEDULED', 'TIMER_FIRED', 'TIMER_CANCELLED'].includes(fact.factKind)
      || fact.logicalTime === null || !isRecord(fact.envelope.payload)) continue;
    const timerId = stringValue(fact.envelope.payload.timerId);
    if (!timerId) {
      modelGaps.add('MALFORMED_DURABLE_TIMER_FACT');
      continue;
    }
    const previous = timers.get(timerId);
    if (!previous || fact.logicalTime > previous.at) {
      timers.set(timerId, { kind: fact.factKind, payload: fact.envelope.payload, at: fact.logicalTime });
    }
  }
  const output: ActiveMandatoryObligation[] = [];
  for (const [timerId, timer] of timers) {
    const due = logicalTime(timer.payload.dueLogicalTime);
    if (timer.kind === 'TIMER_SCHEDULED' && due !== null && due <= logicalNow) {
      modelGaps.add('OVERDUE_DURABLE_TIMER');
      const next = obligation(
        binding,
        goal,
        watermark,
        'RECOVER_RECONCILER',
        'DURABLE_TIMER',
        timerId,
        'OVERDUE_DURABLE_TIMER',
        [],
        ['MODEL_COVERAGE'],
        due.toString(),
      );
      if (next) output.push(next);
    }
  }
  return output;
}

function proofGraphFor(
  dimensions: OutcomeDimensionResult[],
  facts: NormalizedFact[],
  goalId: string,
  closed: boolean,
): OutcomeEvaluationResult['proofGraph'] {
  const byId = new Map(facts.map((fact) => [fact.factId, fact]));
  const evidenceIds = [...new Set(dimensions.flatMap((dimension) => dimension.evidenceFactIds))].sort();
  const leaves = evidenceIds.map((factId) => {
    const fact = byId.get(factId);
    return {
      nodeId: `fact:${factId}`,
      kind: fact?.authoritative ? 'AUTHORITATIVE_FACT' as const : 'UNAVAILABLE_FACT' as const,
      factId,
      factKind: fact?.factKind ?? null,
      logicalTime: fact?.logicalTimeText || null,
      trustDecision: fact?.trustDecision ?? 'MISSING',
      proofEligible: fact?.proofEligible ?? false,
      authoritative: fact?.authoritative ?? false,
    };
  });
  const dimensionNodes = dimensions.map((dimension) => ({
    nodeId: `dimension:${dimension.dimensionId}`,
    kind: 'DIMENSION' as const,
    dimensionId: dimension.dimensionId,
    state: dimension.state,
    inputs: dimension.evidenceFactIds.map((factId) => `fact:${factId}`).sort(),
  }));
  return {
    leaves,
    dimensions: dimensionNodes,
    root: {
      nodeId: `outcome:${goalId || 'unknown'}`,
      kind: 'OUTCOME',
      inputs: dimensionNodes.map((node) => node.nodeId),
      closed,
    },
  };
}

function fatalEvaluation(input: unknown, code: string): OutcomeEvaluationResult {
  const top = isRecord(input) ? input : {};
  const binding = isRecord(top.binding) ? top.binding : {};
  const goal = isRecord(top.goal) ? top.goal : {};
  const cut = isRecord(top.factCut) ? top.factCut : {};
  const version = stringValue(top.evaluatorVersion) || OUTCOME_EVALUATOR_VERSION;
  const evaluatedThrough = stringValue(cut.watermarkLogicalTime, '0');
  const dimensions = OUTCOME_DIMENSIONS.map((entry) => ({
    dimensionId: entry.id,
    state: 'UNKNOWN' as const,
    evidenceFactIds: [],
    applicabilityProofDigest: null,
    reasonCode: code,
  }));
  const modelGaps = [code];
  const clauses = Object.fromEntries(CLOSED_CLAUSES.map((clause) => [clause, false])) as Record<(typeof CLOSED_CLAUSES)[number], boolean>;
  const graph = proofGraphFor(dimensions, [], stringValue(goal.goalId), false);
  const proofBody = {
    contractDigest: isDigest(goal.contractDigest)
      ? goal.contractDigest
      : outcomeDigest({ unavailable: 'contractDigest' }),
    evaluationPlanDigest: isDigest(goal.evaluationPlanDigest)
      ? goal.evaluationPlanDigest
      : outcomeDigest({ unavailable: 'evaluationPlanDigest' }),
    factCutDigest: isDigest(cut.factSetDigest) ? cut.factSetDigest : outcomeDigest([]),
    evaluatorVersion: version,
    evaluatedThroughLogicalTime: logicalTime(evaluatedThrough) === null ? '0' : evaluatedThrough,
    dimensions,
    modelGaps,
    closed: false,
    closedClauseResults: clauses,
    proofGraphDigest: outcomeDigest(graph),
  };
  const proof = { proofDigest: outcomeDigest(proofBody), ...proofBody };
  const body = {
    schemaVersion: 1 as const,
    evaluatorVersion: version,
    evaluatorDigest: outcomeEvaluatorDigest(version),
    bindingDigest: (() => { try { return outcomeDigest(binding); } catch { return outcomeDigest({}); } })(),
    evaluatedThroughLogicalTime: proofBody.evaluatedThroughLogicalTime,
    proof,
    proofGraph: graph,
    activeMandatoryObligations: [] as ActiveMandatoryObligation[],
    attempts: [] as JsonRecord[],
    rejectedFacts: [] as Array<{ factId: string; decision: string }>,
    closed: false,
  };
  return { ...body, evaluationDigest: outcomeDigest(body) };
}

/**
 * Pure Outcome Evaluator. Its only decision inputs are the current binding, the immutable sealed
 * cut, the goal bound by that cut, and explicit logical time. It never reads wall time, mutable
 * projections, task status, or a database. Every structurally valid input returns one result;
 * malformed fact payloads become visible MODEL_GAPs instead of escaping the reducer.
 */
export function evaluateCanonicalOutcome(input: unknown): OutcomeEvaluationResult {
  try {
    const top = isRecord(input) ? input : {};
    const binding = isRecord(top.binding) ? top.binding : {};
    const goal = isRecord(top.goal) ? top.goal : {};
    const cut = isRecord(top.factCut) ? top.factCut : {};
    const clock = isRecord(top.clock) ? top.clock : {};
    const evaluatorVersion = stringValue(top.evaluatorVersion) || OUTCOME_EVALUATOR_VERSION;
    const evaluatorDigest = outcomeEvaluatorDigest(evaluatorVersion);
    const bindingDigest = outcomeDigest(binding);
    const watermarkValue = logicalTime(cut.watermarkLogicalTime);
    const watermark = watermarkValue?.toString() ?? '0';
    const logicalNow = logicalTime(clock.logicalNow);
    const evaluatedThrough = logicalTime(clock.evaluatedThroughLogicalTime);
    const modelGaps = new Set<string>();

    if (!stringValue(binding.tenantId) || !stringValue(binding.projectId)
      || !stringValue(binding.goalId) || logicalTime(binding.goalRevision) === null
      || !isDigest(binding.contractDigest) || !isDigest(binding.evaluationPlanDigest)
      || !isDigest(binding.authorityGrantDigest) || !isDigest(binding.factSchemaDigest)) {
      modelGaps.add('MALFORMED_CURRENT_BINDING');
    }
    if (goal.tenantId !== binding.tenantId || goal.projectId !== binding.projectId
      || goal.goalId !== binding.goalId || goal.goalRevision !== binding.goalRevision
      || goal.contractDigest !== binding.contractDigest
      || goal.evaluationPlanDigest !== binding.evaluationPlanDigest) {
      modelGaps.add('GOAL_BINDING_MISMATCH');
    }
    if (watermarkValue === null || logicalNow === null || evaluatedThrough === null
      || evaluatedThrough !== watermarkValue || logicalNow !== evaluatedThrough) {
      modelGaps.add('LOGICAL_TIME_INVALID');
    }
    if (cut.tenantId !== binding.tenantId || cut.projectId !== binding.projectId) {
      modelGaps.add('FACT_CUT_SCOPE_MISMATCH');
    }

    const normalized = normalizeFacts(top.facts, binding, cut, modelGaps);
    const dimensions = dimensionResults(normalized.facts, modelGaps);
    const attempts = attemptsFromFacts(normalized.facts, goal, modelGaps);
    for (const fact of normalized.facts) {
      if (!fact.authoritative || fact.factKind !== 'MODEL_GAP_DETECTED') continue;
      const payload = isRecord(fact.envelope.payload) ? fact.envelope.payload : {};
      modelGaps.add(stringValue(payload.code, 'UNSPECIFIED_MODEL_GAP'));
    }

    const active = new Map<string, ActiveMandatoryObligation>();
    const addObligation = (next: ActiveMandatoryObligation | null): void => {
      if (next) active.set(next.obligationId, next);
    };
    for (const dimension of dimensions) {
      if (dimension.state === 'SATISFIED' || dimension.state === 'NOT_APPLICABLE') continue;
      const declaration = OUTCOME_DIMENSIONS.find((entry) => entry.id === dimension.dimensionId)!;
      addObligation(obligation(
        binding,
        goal,
        watermark,
        declaration.obligationKind,
        'COMPLETION_DIMENSION',
        dimension.dimensionId,
        dimension.reasonCode,
        dimension.evidenceFactIds,
        [dimension.dimensionId],
      ));
    }

    const openAttempts = attempts.filter((attempt) => attempt.status !== 'CLOSED');
    const latestAttempt = attempts.at(-1) ?? null;
    if (goal.disposition === 'ACTIVE' && openAttempts.length === 0 && latestAttempt?.status === 'CLOSED'
      && ['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(stringValue(latestAttempt.outcome))) {
      addObligation(obligation(
        binding,
        goal,
        watermark,
        'START_SUCCESSOR_ATTEMPT',
        'GOAL',
        stringValue(goal.goalId),
        `ATTEMPT_${stringValue(latestAttempt.outcome)}_GOAL_ACTIVE`,
        [],
        ['GOAL_DISPOSITION'],
      ));
    }

    for (const next of timerObligations(
      normalized.facts,
      binding,
      goal,
      watermark,
      logicalNow ?? 0n,
      modelGaps,
    )) addObligation(next);
    for (const gap of [...modelGaps].sort()) {
      addObligation(obligation(
        binding,
        goal,
        watermark,
        'DIAGNOSE_MODEL_GAP',
        'MODEL_GAP',
        gap,
        gap,
        [],
        ['MODEL_COVERAGE'],
      ));
    }
    const activeMandatoryObligations = [...active.values()].sort((left, right) => (
      compareStableStrings(left.obligationId, right.obligationId)
    ));
    const rejectedFacts = normalized.facts
      .filter((fact) => fact.rejection !== null)
      .map((fact) => ({ factId: fact.factId, decision: fact.rejection! }))
      .sort((left, right) => compareStableStrings(left.factId, right.factId));
    const dimensionState = new Map(dimensions.map((entry) => [entry.dimensionId, entry.state]));
    const allLeavesAuthoritative = dimensions.flatMap((entry) => entry.evidenceFactIds).every((factId) => (
      normalized.facts.some((fact) => fact.factId === factId && fact.authoritative)
    ));
    const ratification = isRecord(goal.ratification) ? goal.ratification : {};
    const ratified = ratification.status === 'RATIFIED'
      && ratification.contractDigest === goal.contractDigest
      && ['OWNER', 'PREAPPROVED_TEMPLATE', 'BOUND_DELEGATION'].includes(stringValue(ratification.ratifierType));
    const allEligible = dimensions.length === OUTCOME_DIMENSIONS.length
      && dimensions.every((entry) => entry.state === 'SATISFIED' || entry.state === 'NOT_APPLICABLE');
    const staleOrRevoked = rejectedFacts.some((entry) => (
      ['OUT_OF_SCOPE', 'REVOKED', 'STALE_SCHEMA', 'BAD_DIGEST'].includes(entry.decision)
    ));
    const preliminaryClauses: Record<(typeof CLOSED_CLAUSES)[number], boolean> = {
      CONTRACT_RATIFIED_FOR_EXACT_CONTRACT_DIGEST: ratified,
      EVALUATION_PLAN_MATCHES_EXACT_EVALUATION_PLAN_DIGEST: goal.evaluationPlanDigest === binding.evaluationPlanDigest,
      FACT_CUT_IS_COMPLETE_LINEARIZABLE_AND_TRUSTED: normalized.integrity
        && normalized.facts.length > 0 && allLeavesAuthoritative,
      EVALUATOR_VERSION_AND_DIGEST_MATCH_BINDING: binding.evaluatorDigest === evaluatorDigest,
      EVERY_MANDATORY_DIMENSION_IS_SATISFIED_OR_PROVEN_NOT_APPLICABLE: allEligible,
      NO_UNKNOWN_DIMENSION: !dimensions.some((entry) => entry.state === 'UNKNOWN'),
      NO_UNSATISFIED_DIMENSION: !dimensions.some((entry) => entry.state === 'UNSATISFIED'),
      NO_CONFLICT_DIMENSION: !dimensions.some((entry) => entry.state === 'CONFLICT'),
      NO_MODEL_GAP: modelGaps.size === 0,
      GOAL_DISPOSITION_IS_ACHIEVED: goal.disposition === 'ACHIEVED'
        && dimensionState.get('GOAL_DISPOSITION') === 'SATISFIED',
      NO_ACTIVE_MANDATORY_OBLIGATION: activeMandatoryObligations.length === 0,
      NO_STALE_OR_REVOKED_BINDING: !staleOrRevoked,
      NO_UNREMEDIATED_SIDE_EFFECT: ['SATISFIED', 'NOT_APPLICABLE'].includes(
        dimensionState.get('ACTION_REMEDIATION') ?? 'UNKNOWN',
      ),
      ALL_EXTERNAL_CLOSURE_DEPENDENCIES_SETTLED: ['SATISFIED', 'NOT_APPLICABLE'].includes(
        dimensionState.get('EXTERNAL_CLOSURE_DEPENDENCIES') ?? 'UNKNOWN',
      ),
    };
    const closed = Object.values(preliminaryClauses).every(Boolean);
    const proofGraph = proofGraphFor(dimensions, normalized.facts, stringValue(goal.goalId), closed);
    const proofBody = {
      contractDigest: isDigest(goal.contractDigest)
        ? goal.contractDigest
        : outcomeDigest({ unavailable: 'contractDigest' }),
      evaluationPlanDigest: isDigest(goal.evaluationPlanDigest)
        ? goal.evaluationPlanDigest
        : outcomeDigest({ unavailable: 'evaluationPlanDigest' }),
      factCutDigest: stringValue(cut.factSetDigest, outcomeDigest([])),
      evaluatorVersion,
      evaluatedThroughLogicalTime: watermark,
      dimensions,
      modelGaps: [...modelGaps].sort(),
      closed,
      closedClauseResults: preliminaryClauses,
      proofGraphDigest: outcomeDigest(proofGraph),
    };
    const proof = { proofDigest: outcomeDigest(proofBody), ...proofBody };
    const body = {
      schemaVersion: 1 as const,
      evaluatorVersion,
      evaluatorDigest,
      bindingDigest,
      evaluatedThroughLogicalTime: watermark,
      proof,
      proofGraph,
      activeMandatoryObligations,
      attempts,
      rejectedFacts,
      closed,
    };
    return { ...body, evaluationDigest: outcomeDigest(body) };
  } catch {
    return fatalEvaluation(input, 'EVALUATOR_TOTALITY_GUARD');
  }
}
