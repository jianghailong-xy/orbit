import { createHash } from 'node:crypto';
import { canonicalJson, compare } from '../projects/canonical-json';

export const ACTION_EFFECT_CLASSES = [
  'READ_ONLY',
  'REVERSIBLE_INTERNAL',
  'IRREVERSIBLE_INTERNAL',
  'EXTERNAL_REVERSIBLE',
  'EXTERNAL_IRREVERSIBLE',
] as const;

export const ACTION_HUMAN_DECISION_REASONS = [
  'GOAL_DECISION',
  'RISK_ACCEPTANCE',
  'NEW_AUTHORIZATION',
  'EXTERNAL_IDENTITY',
] as const;

export type ActionEffectClass = (typeof ACTION_EFFECT_CLASSES)[number];
export type ActionHumanDecisionReason = (typeof ACTION_HUMAN_DECISION_REASONS)[number];
export type ActionOwner = 'SYSTEM' | 'AGENT' | 'OWNER' | 'EXTERNAL';
export type ActionPrincipalType = 'SYSTEM' | 'AGENT' | 'OWNER' | 'RUNNER' | 'PROVIDER';

export interface ActionPrincipal {
  type: ActionPrincipalType;
  id: string;
}

export interface ActionBudgetEnvelope {
  accountId: string;
  unit: string;
  charge: number;
  limit: number;
  reservationId: string;
}

export interface ActionRetryEnvelope {
  maxAttempts: number;
  backoffDigest: string;
  sameFailureFingerprintLimit: number;
}

export interface ActionCompensationEnvelope {
  compensatorCapability: string | null;
  manualRecovery: string | null;
  remediationObligationKind: 'REMEDIATE_SIDE_EFFECT';
}

export interface ActionReceiptRequirements {
  providerIdentity: true;
  effectDigest: true;
  observedAt: true;
  result: true;
  idempotencyKey: true;
}

/** The frozen contract envelope, plus the runtime fields needed to execute it rather than merely validate it. */
export interface ConstrainedActionIntent {
  schemaVersion: 1;
  actionIntentId: string;
  actionKind: string;
  tenantId: string;
  projectId: string;
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  protocolDigest: string;
  effectClass: ActionEffectClass;
  resourceType: string;
  resourceId: string;
  targetDigest: string;
  principal: ActionPrincipal;
  authorityGrantDigest: string;
  policyDigest: string;
  preconditionDigest: string;
  evaluatedThroughLogicalTime: string;
  idempotencyKey: string;
  budget: ActionBudgetEnvelope;
  retryPolicy: ActionRetryEnvelope;
  timeout: {
    logicalTicks: number;
    wallClockMs: number;
  };
  compensation: ActionCompensationEnvelope;
  receiptRequirements: ActionReceiptRequirements;
}

export interface ActionProtocolDeclaration {
  obligationKind: string;
  actionKind: string;
  effectClass: ActionEffectClass;
  resourceType: string;
  actor: {
    role: ActionOwner;
    adapter: string;
    capability: string;
  };
  resolver: {
    adapter: string;
    capability: string;
  } | null;
  authorityScopes: string[];
  policyRules: string[];
  budgetUnit: string;
  budgetCharge: number;
  retry: {
    maxAttempts: number;
    sameFailureFingerprintLimit: number;
    backoffLogicalTicks: number[];
  };
  timeoutLogicalTicks: number;
  compensation: {
    capability: string | null;
    manualRecovery: string | null;
    remediationObligationKind: 'REMEDIATE_SIDE_EFFECT';
  };
}

export interface BoundSourceObligation {
  obligationId: string;
  obligationRevision: string;
  kind: string;
  owner: ActionOwner;
  capability: string;
  binding: Record<string, unknown>;
  bindingDigest: string;
  goalId: string;
  goalRevision: string;
  servesCriterionIds: string[];
  blocksClosureOf: string[];
  ownership: {
    homeProjectId: string;
    blockingProjectIds: string[];
    crossingId: string | null;
    handoffId: string | null;
    handoffStatus: string;
    attributionDecisionFactId: string | null;
  };
}

export interface ActionAuthoritySnapshot {
  grantDigest: string;
  principal: ActionPrincipal;
  scopes: string[];
  validFromLogicalTime: string;
  validThroughLogicalTime: string | null;
  revokedAtLogicalTime: string | null;
}

export interface ActionPolicySnapshot {
  policyDigest: string;
  rules: string[];
  active: boolean;
}

export interface ActionBudgetSnapshot {
  accountId: string;
  budgetDigest: string;
  unit: string;
  limit: number;
  reserved: number;
  spent: number;
}

export interface ActionCommitSnapshot {
  binding: Record<string, unknown>;
  bindingDigest: string;
  streamWatermarkLogicalTime: string;
  activeObligation: BoundSourceObligation | null;
  authority: ActionAuthoritySnapshot | null;
  policy: ActionPolicySnapshot | null;
  preconditionDigest: string | null;
  budget: ActionBudgetSnapshot | null;
}

export interface CanonicalActionObligation {
  obligationId: string;
  obligationRevision: string;
  kind: string;
  state: 'ACTIVE';
  mandatory: true;
  owner: ActionOwner;
  capability: string;
  binding: Record<string, unknown>;
  bindingDigest: string;
  goalId: string;
  goalRevision: string;
  reason: {
    code: string;
    message: string;
    evidenceFactIds: string[];
    attemptedActions: string[];
    nextAction: string;
    sourceActionIntentId: string;
    humanDecisionReason: ActionHumanDecisionReason | null;
    recovery: {
      compensatorCapability: string | null;
      manualRecovery: string | null;
      remediationObligationKind: 'REMEDIATE_SIDE_EFFECT';
    };
  };
  actionProtocolProfile: 'SYSTEM_ACTION' | 'AGENT_ACTION' | 'OWNER_DECISION' | 'EXTERNAL_MONITOR';
  servesCriterionIds: string[];
  blocksClosureOf: string[];
  ownership: BoundSourceObligation['ownership'];
  resolverProfile: 'STANDARD_MANDATORY';
  createdAtLogicalTime: string;
  dueLogicalTime: string | null;
}

export interface ActionAdmissionAllowed {
  allowed: true;
  protocol: ActionProtocolDeclaration;
}

export interface ActionAdmissionRefused {
  allowed: false;
  code: string;
  obligation: CanonicalActionObligation;
}

export type ActionAdmission = ActionAdmissionAllowed | ActionAdmissionRefused;

export interface ProviderActionReceipt {
  providerIdentity: string;
  effectDigest: string;
  observedAt: string;
  result:
    | 'SUCCEEDED'
    | 'RETRYABLE_FAILURE'
    | 'PERMANENT_FAILURE'
    | 'QUOTA_WAIT'
    | 'PARTIAL_EFFECT'
    | 'WRONG_EFFECT'
    | 'TIMED_OUT';
  idempotencyKey: string;
  failureFingerprint: string | null;
  retryAfterLogicalTicks: number | null;
  detail?: Record<string, unknown>;
}

export interface ActionAttemptState {
  attempt: number;
  sameFailureFingerprintCount: number;
  logicalNow: string;
  effectMayHaveOccurred: boolean;
  compensationOutcome?: 'COMPENSATED' | 'FAILED' | 'UNAVAILABLE' | null;
}

export interface ActionTransition {
  status:
    | 'SUCCEEDED'
    | 'BACKOFF'
    | 'WAITING_QUOTA'
    | 'REMEDIATION_REQUIRED'
    | 'COMPENSATED'
    | 'DIAGNOSIS_REQUIRED'
    | 'TIMED_OUT';
  terminal: boolean;
  nextEligibleLogicalTime: string | null;
  obligation: CanonicalActionObligation | null;
}

export interface FairActionCandidate {
  actionIntentId: string;
  projectId: string;
  enqueuedSequence: number;
  nextEligibleLogicalTime: string;
  deadlineLogicalTime: string;
}

export interface ProjectFairnessState {
  projectId: string;
  lastDispatchedSequence: number | null;
}

const DIGEST = /^[0-9a-f]{64}$/;
const LOGICAL_TIME = /^(0|[1-9][0-9]*)$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function logical(value: string): bigint | null {
  if (!LOGICAL_TIME.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function finiteInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function finiteNumber(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

function hasAll(actual: string[], required: string[]): boolean {
  const values = new Set(actual);
  return required.every((entry) => values.has('*') || values.has(entry));
}

function exactReceiptRequirements(value: ActionReceiptRequirements | null | undefined): boolean {
  return value?.providerIdentity === true
    && value.effectDigest === true
    && value.observedAt === true
    && value.result === true
    && value.idempotencyKey === true;
}

function intentShapeError(intent: ConstrainedActionIntent): string | null {
  if (intent.schemaVersion !== 1) return 'ACTION_SCHEMA_UNSUPPORTED';
  for (const value of [
    intent.actionIntentId,
    intent.actionKind,
    intent.tenantId,
    intent.projectId,
    intent.resourceType,
    intent.resourceId,
    intent.principal?.id,
    intent.idempotencyKey,
    intent.budget?.accountId,
    intent.budget?.unit,
    intent.budget?.reservationId,
  ]) {
    if (!validIdentifier(value)) return 'ACTION_CONTEXT_MISSING_OR_INVALID';
  }
  for (const value of [
    intent.obligationId,
    intent.obligationRevision,
    intent.bindingDigest,
    intent.protocolDigest,
    intent.targetDigest,
    intent.authorityGrantDigest,
    intent.policyDigest,
    intent.preconditionDigest,
    intent.retryPolicy?.backoffDigest,
  ]) {
    if (typeof value !== 'string' || !DIGEST.test(value)) return 'ACTION_DIGEST_MISSING_OR_INVALID';
  }
  if (!ACTION_EFFECT_CLASSES.includes(intent.effectClass)) return 'ACTION_EFFECT_CLASS_UNKNOWN';
  if (!['SYSTEM', 'AGENT', 'OWNER', 'RUNNER', 'PROVIDER'].includes(intent.principal?.type)) {
    return 'ACTION_PRINCIPAL_INVALID';
  }
  if (logical(intent.evaluatedThroughLogicalTime) === null) return 'ACTION_WATERMARK_INVALID';
  if (!finiteNumber(intent.budget?.charge) || !finiteNumber(intent.budget?.limit)
      || intent.budget.charge > intent.budget.limit) return 'ACTION_BUDGET_ENVELOPE_INVALID';
  if (!finiteInteger(intent.retryPolicy?.maxAttempts, 1)
      || !finiteInteger(intent.retryPolicy?.sameFailureFingerprintLimit, 1)
      || intent.retryPolicy.sameFailureFingerprintLimit > intent.retryPolicy.maxAttempts) {
    return 'ACTION_RETRY_ENVELOPE_INVALID';
  }
  if (!finiteInteger(intent.timeout?.logicalTicks, 1) || !finiteInteger(intent.timeout?.wallClockMs, 1)) {
    return 'ACTION_TIMEOUT_INVALID';
  }
  if (intent.compensation?.remediationObligationKind !== 'REMEDIATE_SIDE_EFFECT'
      || (!intent.compensation?.compensatorCapability && !intent.compensation?.manualRecovery)) {
    return 'ACTION_RECOVERY_PATH_MISSING';
  }
  if (!exactReceiptRequirements(intent.receiptRequirements)) return 'ACTION_RECEIPT_REQUIREMENTS_INVALID';
  return null;
}

function ownerProfile(owner: ActionOwner): CanonicalActionObligation['actionProtocolProfile'] {
  if (owner === 'OWNER') return 'OWNER_DECISION';
  if (owner === 'AGENT') return 'AGENT_ACTION';
  if (owner === 'EXTERNAL') return 'EXTERNAL_MONITOR';
  return 'SYSTEM_ACTION';
}

interface ObligationDisposition {
  kind: string;
  owner: ActionOwner;
  capability: string;
  nextAction: string;
  humanDecisionReason: ActionHumanDecisionReason | null;
}

/**
 * Closed routing table. A new failure code cannot accidentally become a human request: it falls
 * through to agent-owned model diagnosis until this table is deliberately extended.
 */
function dispositionFor(code: string, source: BoundSourceObligation): ObligationDisposition {
  switch (code) {
    case 'GOAL_DECISION_REQUIRED':
      return { kind: 'REQUEST_GOAL_DECISION', owner: 'OWNER', capability: 'owner.goal-decision', nextAction: 'DECIDE_GOAL_DISPOSITION', humanDecisionReason: 'GOAL_DECISION' };
    case 'RISK_ACCEPTANCE_REQUIRED':
      return { kind: 'REQUEST_RISK_ACCEPTANCE', owner: 'OWNER', capability: 'owner.risk-acceptance', nextAction: 'DECIDE_RISK_ACCEPTANCE', humanDecisionReason: 'RISK_ACCEPTANCE' };
    case 'AUTHORITY_UNAVAILABLE':
    case 'AUTHORITY_REVOKED':
    case 'AUTHORITY_SCOPE_MISMATCH':
      return { kind: 'REQUEST_NEW_AUTHORIZATION', owner: 'OWNER', capability: 'owner.authorization', nextAction: 'PROVIDE_BOUND_AUTHORIZATION', humanDecisionReason: 'NEW_AUTHORIZATION' };
    case 'EXTERNAL_IDENTITY_REQUIRED':
      return { kind: 'REQUEST_EXTERNAL_IDENTITY', owner: 'OWNER', capability: 'owner.external-identity', nextAction: 'SELECT_EXTERNAL_IDENTITY', humanDecisionReason: 'EXTERNAL_IDENTITY' };
    case 'QUOTA_WAIT':
      return { kind: 'MONITOR_EXTERNAL_WAIT', owner: 'SYSTEM', capability: 'external-wait.monitor', nextAction: 'MONITOR_QUOTA', humanDecisionReason: null };
    case 'BINDING_CHANGED':
    case 'POLICY_CHANGED':
    case 'TARGET_CHANGED':
    case 'PRECONDITION_CHANGED':
    case 'WATERMARK_STALE':
    case 'OBLIGATION_STALE':
      return { kind: 'REFRESH_STALE_BINDING', owner: 'SYSTEM', capability: 'binding.refresh', nextAction: 'REEVALUATE_AND_REBIND', humanDecisionReason: null };
    case 'PARTIAL_EFFECT':
    case 'WRONG_EFFECT':
    case 'EFFECT_STATUS_UNKNOWN':
    case 'COMPENSATION_FAILED':
    case 'COMPENSATOR_UNAVAILABLE':
      return { kind: 'REMEDIATE_SIDE_EFFECT', owner: 'AGENT', capability: 'effect.remediate', nextAction: 'RECONCILE_OR_REVERSE_RECORDED_EFFECT', humanDecisionReason: null };
    case 'ACTION_TIMEOUT':
      return { kind: 'RECOVER_RECONCILER', owner: 'SYSTEM', capability: 'reconciler.recover', nextAction: 'RECOVER_TIMED_OUT_ACTION', humanDecisionReason: null };
    case 'BUDGET_EXHAUSTED':
      return { kind: source.kind, owner: 'AGENT', capability: 'budget.reconcile', nextAction: 'REDUCE_COST_OR_OBTAIN_A_NEW_BOUND_BUDGET', humanDecisionReason: null };
    case 'BACKOFF_ACTIVE':
    case 'FAIR_SCHEDULER_WAIT':
      return { kind: source.kind, owner: 'SYSTEM', capability: 'action.scheduler', nextAction: 'RESUME_WHEN_DUE', humanDecisionReason: null };
    default:
      return { kind: 'DIAGNOSE_MODEL_GAP', owner: 'AGENT', capability: 'model-gap.diagnose', nextAction: 'DIAGNOSE_ACTION_MODEL_GAP', humanDecisionReason: null };
  }
}

export function canonicalActionObligation(
  intent: ConstrainedActionIntent,
  source: BoundSourceObligation,
  code: string,
  options: {
    logicalNow: string;
    dueLogicalTime?: string | null;
    attemptedActions?: string[];
    evidenceFactIds?: string[];
    message?: string;
  },
): CanonicalActionObligation {
  const disposition = dispositionFor(code, source);
  const obligationId = digest({
    namespace: 'orbit.action-executor-obligation.v2',
    tenantId: intent.tenantId,
    projectId: intent.projectId,
    sourceObligationId: intent.obligationId,
    actionIntentId: intent.actionIntentId,
    kind: disposition.kind,
  });
  const dueLogicalTime = options.dueLogicalTime ?? null;
  const obligationRevision = digest({
    namespace: 'orbit.action-executor-obligation-revision.v2',
    obligationId,
    sourceObligationRevision: intent.obligationRevision,
    bindingDigest: intent.bindingDigest,
    targetDigest: intent.targetDigest,
    authorityGrantDigest: intent.authorityGrantDigest,
    protocolDigest: intent.protocolDigest,
    policyDigest: intent.policyDigest,
    preconditionDigest: intent.preconditionDigest,
    reasonCode: code,
    owner: disposition.owner,
    capability: disposition.capability,
    dueLogicalTime,
  });
  if ((disposition.owner === 'OWNER') !== (disposition.humanDecisionReason !== null)) {
    throw new Error('ACTION_HUMAN_DECISION_ROUTING_INVALID');
  }
  return {
    obligationId,
    obligationRevision,
    kind: disposition.kind,
    state: 'ACTIVE',
    mandatory: true,
    owner: disposition.owner,
    capability: disposition.capability,
    binding: source.binding,
    bindingDigest: intent.bindingDigest,
    goalId: source.goalId,
    goalRevision: source.goalRevision,
    reason: {
      code,
      message: options.message ?? `${code} prevents ${intent.actionKind} on ${intent.resourceType}:${intent.resourceId}.`,
      evidenceFactIds: [...(options.evidenceFactIds ?? [])].sort(compare),
      attemptedActions: [...(options.attemptedActions ?? [])],
      nextAction: disposition.nextAction,
      sourceActionIntentId: intent.actionIntentId,
      humanDecisionReason: disposition.humanDecisionReason,
      recovery: {
        compensatorCapability: intent.compensation.compensatorCapability,
        manualRecovery: intent.compensation.manualRecovery,
        remediationObligationKind: intent.compensation.remediationObligationKind,
      },
    },
    actionProtocolProfile: ownerProfile(disposition.owner),
    servesCriterionIds: [...source.servesCriterionIds].sort(compare),
    blocksClosureOf: [...source.blocksClosureOf].sort(compare),
    ownership: {
      ...source.ownership,
      blockingProjectIds: [...source.ownership.blockingProjectIds].sort(compare),
    },
    resolverProfile: 'STANDARD_MANDATORY',
    createdAtLogicalTime: options.logicalNow,
    dueLogicalTime,
  };
}

function refusal(
  intent: ConstrainedActionIntent,
  source: BoundSourceObligation,
  code: string,
  logicalNow: string,
): ActionAdmissionRefused {
  return { allowed: false, code, obligation: canonicalActionObligation(intent, source, code, { logicalNow }) };
}

export function actionProtocolDigest(protocol: ActionProtocolDeclaration): string {
  return digest(protocol);
}

export function validateActionProtocolDeclaration(protocol: ActionProtocolDeclaration): string | null {
  if (!isRecord(protocol)
      || !validIdentifier(protocol.obligationKind)
      || !validIdentifier(protocol.actionKind)
      || !ACTION_EFFECT_CLASSES.includes(protocol.effectClass)
      || !validIdentifier(protocol.resourceType)
      || !isRecord(protocol.actor)
      || !['SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL'].includes(protocol.actor.role)
      || !validIdentifier(protocol.actor.adapter)
      || !validIdentifier(protocol.actor.capability)) {
    return 'ACTION_PROTOCOL_SHAPE_INVALID';
  }
  if (protocol.resolver !== null && (!isRecord(protocol.resolver)
      || !validIdentifier(protocol.resolver.adapter)
      || !validIdentifier(protocol.resolver.capability))) {
    return 'ACTION_PROTOCOL_RESOLVER_INVALID';
  }
  if (!Array.isArray(protocol.authorityScopes) || protocol.authorityScopes.length === 0
      || protocol.authorityScopes.some((scope) => !validIdentifier(scope))
      || !Array.isArray(protocol.policyRules) || protocol.policyRules.length === 0
      || protocol.policyRules.some((rule) => !validIdentifier(rule))) {
    return 'ACTION_PROTOCOL_AUTHORITY_POLICY_INVALID';
  }
  if (!validIdentifier(protocol.budgetUnit) || !finiteNumber(protocol.budgetCharge)
      || !finiteInteger(protocol.retry?.maxAttempts, 1)
      || !finiteInteger(protocol.retry?.sameFailureFingerprintLimit, 1)
      || protocol.retry.sameFailureFingerprintLimit > protocol.retry.maxAttempts
      || !Array.isArray(protocol.retry.backoffLogicalTicks)
      || protocol.retry.backoffLogicalTicks.length === 0
      || protocol.retry.backoffLogicalTicks.some((value) => !finiteInteger(value, 1))
      || !finiteInteger(protocol.timeoutLogicalTicks, 1)) {
    return 'ACTION_PROTOCOL_BOUNDS_INVALID';
  }
  if (!isRecord(protocol.compensation)
      || protocol.compensation.remediationObligationKind !== 'REMEDIATE_SIDE_EFFECT'
      || (!protocol.compensation.capability && !protocol.compensation.manualRecovery)) {
    return 'ACTION_PROTOCOL_RECOVERY_PATH_MISSING';
  }
  return null;
}

export function actionBackoffDigest(backoffLogicalTicks: number[]): string {
  return digest(backoffLogicalTicks);
}

export function actionProtocolMismatch(
  intent: ConstrainedActionIntent,
  source: BoundSourceObligation,
  protocol: ActionProtocolDeclaration | null,
): string | null {
  const shapeError = intentShapeError(intent);
  if (shapeError) return shapeError;
  if (!protocol) return 'UNKNOWN_ACTION_KIND';
  if (!protocol.resolver) return 'RESOLVER_MISSING';
  if (source.obligationId !== intent.obligationId || source.obligationRevision !== intent.obligationRevision
      || source.bindingDigest !== intent.bindingDigest || !isRecord(source.binding)) {
    return 'OBLIGATION_CONTEXT_MISMATCH';
  }
  if (actionProtocolDigest(protocol) !== intent.protocolDigest
      || protocol.actionKind !== intent.actionKind || protocol.obligationKind !== source.kind
      || protocol.effectClass !== intent.effectClass || protocol.resourceType !== intent.resourceType
      || protocol.actor.role !== intent.principal.type || protocol.budgetUnit !== intent.budget.unit
      || protocol.budgetCharge !== intent.budget.charge
      || protocol.retry.maxAttempts !== intent.retryPolicy.maxAttempts
      || protocol.retry.sameFailureFingerprintLimit !== intent.retryPolicy.sameFailureFingerprintLimit
      || actionBackoffDigest(protocol.retry.backoffLogicalTicks) !== intent.retryPolicy.backoffDigest
      || protocol.timeoutLogicalTicks !== intent.timeout.logicalTicks
      || protocol.compensation.capability !== intent.compensation.compensatorCapability
      || protocol.compensation.manualRecovery !== intent.compensation.manualRecovery) {
    return 'ACTION_PROTOCOL_MISMATCH';
  }
  return null;
}

/** Pure fail-closed admission and commit-time recheck used on both sides of the database fence. */
export function validateActionCommit(
  intent: ConstrainedActionIntent,
  source: BoundSourceObligation,
  protocol: ActionProtocolDeclaration | null,
  snapshot: ActionCommitSnapshot,
): ActionAdmission {
  const logicalNow = snapshot.streamWatermarkLogicalTime || intent.evaluatedThroughLogicalTime || '0';
  const protocolError = actionProtocolMismatch(intent, source, protocol);
  if (protocolError) return refusal(intent, source, protocolError, logicalNow);
  if (!protocol) return refusal(intent, source, 'UNKNOWN_ACTION_KIND', logicalNow);
  if (snapshot.bindingDigest !== intent.bindingDigest) return refusal(intent, source, 'BINDING_CHANGED', logicalNow);
  if (!snapshot.activeObligation
      || snapshot.activeObligation.obligationId !== intent.obligationId
      || snapshot.activeObligation.obligationRevision !== intent.obligationRevision) {
    return refusal(intent, source, 'OBLIGATION_STALE', logicalNow);
  }
  if (snapshot.streamWatermarkLogicalTime !== intent.evaluatedThroughLogicalTime) {
    return refusal(intent, source, 'WATERMARK_STALE', logicalNow);
  }
  if (snapshot.binding.targetDigest !== intent.targetDigest) return refusal(intent, source, 'TARGET_CHANGED', logicalNow);
  if (snapshot.binding.policyDigest !== intent.policyDigest || !snapshot.policy
      || snapshot.policy.policyDigest !== intent.policyDigest || !snapshot.policy.active
      || !hasAll(snapshot.policy.rules, protocol.policyRules)) {
    return refusal(intent, source, 'POLICY_CHANGED', logicalNow);
  }
  if (snapshot.preconditionDigest !== intent.preconditionDigest) {
    return refusal(intent, source, 'PRECONDITION_CHANGED', logicalNow);
  }
  const now = logical(snapshot.streamWatermarkLogicalTime);
  const grant = snapshot.authority;
  if (!grant || grant.grantDigest !== intent.authorityGrantDigest
      || grant.principal.type !== intent.principal.type || grant.principal.id !== intent.principal.id) {
    return refusal(intent, source, 'AUTHORITY_UNAVAILABLE', logicalNow);
  }
  const validFrom = logical(grant.validFromLogicalTime);
  const validThrough = grant.validThroughLogicalTime === null ? null : logical(grant.validThroughLogicalTime);
  const revokedAt = grant.revokedAtLogicalTime === null ? null : logical(grant.revokedAtLogicalTime);
  if (now === null || validFrom === null || now < validFrom
      || (validThrough !== null && now > validThrough)
      || (revokedAt !== null && revokedAt <= now)) {
    return refusal(intent, source, 'AUTHORITY_REVOKED', logicalNow);
  }
  if (!hasAll(grant.scopes, protocol.authorityScopes)) {
    return refusal(intent, source, 'AUTHORITY_SCOPE_MISMATCH', logicalNow);
  }
  if (!snapshot.budget || snapshot.budget.accountId !== intent.budget.accountId
      || snapshot.budget.unit !== intent.budget.unit || snapshot.budget.limit !== intent.budget.limit
      || snapshot.budget.budgetDigest !== snapshot.binding.budgetDigest
      || snapshot.budget.reserved < intent.budget.charge
      || snapshot.budget.spent + snapshot.budget.reserved > snapshot.budget.limit) {
    return refusal(intent, source, 'BUDGET_EXHAUSTED', logicalNow);
  }
  return { allowed: true, protocol };
}

export function validateProviderReceipt(
  intent: ConstrainedActionIntent,
  receipt: ProviderActionReceipt,
): string | null {
  if (!receipt.providerIdentity || !IDENTIFIER.test(receipt.providerIdentity)) return 'RECEIPT_PROVIDER_INVALID';
  if (!DIGEST.test(receipt.effectDigest)) return 'RECEIPT_EFFECT_DIGEST_INVALID';
  if (!Number.isFinite(Date.parse(receipt.observedAt))) return 'RECEIPT_OBSERVED_AT_INVALID';
  if (receipt.idempotencyKey !== intent.idempotencyKey) return 'RECEIPT_IDEMPOTENCY_MISMATCH';
  if (!['SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'QUOTA_WAIT', 'PARTIAL_EFFECT', 'WRONG_EFFECT', 'TIMED_OUT'].includes(receipt.result)) {
    return 'RECEIPT_RESULT_UNKNOWN';
  }
  if (['RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'QUOTA_WAIT'].includes(receipt.result)
      && (!receipt.failureFingerprint || !DIGEST.test(receipt.failureFingerprint))) {
    return 'RECEIPT_FAILURE_FINGERPRINT_INVALID';
  }
  if (receipt.result === 'QUOTA_WAIT'
      && !finiteInteger(receipt.retryAfterLogicalTicks, 1)) return 'RECEIPT_RETRY_AFTER_INVALID';
  return null;
}

export function transitionForReceipt(
  intent: ConstrainedActionIntent,
  source: BoundSourceObligation,
  protocol: ActionProtocolDeclaration,
  receipt: ProviderActionReceipt,
  attempt: ActionAttemptState,
): ActionTransition {
  const now = logical(attempt.logicalNow) ?? 0n;
  const receiptError = validateProviderReceipt(intent, receipt);
  if (receiptError) {
    const possibleEffect = intent.effectClass !== 'READ_ONLY' && attempt.effectMayHaveOccurred;
    return {
      status: possibleEffect ? 'REMEDIATION_REQUIRED' : 'DIAGNOSIS_REQUIRED',
      terminal: true,
      nextEligibleLogicalTime: null,
      obligation: canonicalActionObligation(intent, source, possibleEffect ? 'EFFECT_STATUS_UNKNOWN' : receiptError, {
        logicalNow: attempt.logicalNow,
        attemptedActions: [intent.actionKind],
      }),
    };
  }
  if (receipt.result === 'SUCCEEDED') {
    return { status: 'SUCCEEDED', terminal: true, nextEligibleLogicalTime: null, obligation: null };
  }
  if (receipt.result === 'PARTIAL_EFFECT' || receipt.result === 'WRONG_EFFECT') {
    if (attempt.compensationOutcome === 'COMPENSATED') {
      return { status: 'COMPENSATED', terminal: true, nextEligibleLogicalTime: null, obligation: null };
    }
    const code = attempt.compensationOutcome === 'FAILED'
      ? 'COMPENSATION_FAILED'
      : attempt.compensationOutcome === 'UNAVAILABLE'
        ? 'COMPENSATOR_UNAVAILABLE'
        : receipt.result === 'WRONG_EFFECT' ? 'WRONG_EFFECT' : 'PARTIAL_EFFECT';
    return {
      status: 'REMEDIATION_REQUIRED',
      terminal: true,
      nextEligibleLogicalTime: null,
      obligation: canonicalActionObligation(intent, source, code, {
        logicalNow: attempt.logicalNow,
        attemptedActions: [intent.actionKind, ...(attempt.compensationOutcome ? [String(intent.compensation.compensatorCapability)] : [])],
      }),
    };
  }
  if (receipt.result === 'TIMED_OUT') {
    const possibleEffect = intent.effectClass !== 'READ_ONLY' && attempt.effectMayHaveOccurred;
    return {
      status: possibleEffect ? 'REMEDIATION_REQUIRED' : 'TIMED_OUT',
      terminal: true,
      nextEligibleLogicalTime: null,
      obligation: canonicalActionObligation(intent, source, possibleEffect ? 'EFFECT_STATUS_UNKNOWN' : 'ACTION_TIMEOUT', {
        logicalNow: attempt.logicalNow,
        attemptedActions: [intent.actionKind],
      }),
    };
  }
  if (receipt.result === 'QUOTA_WAIT') {
    const due = (now + BigInt(receipt.retryAfterLogicalTicks ?? 1)).toString();
    return {
      status: 'WAITING_QUOTA',
      terminal: false,
      nextEligibleLogicalTime: due,
      obligation: canonicalActionObligation(intent, source, 'QUOTA_WAIT', {
        logicalNow: attempt.logicalNow,
        dueLogicalTime: due,
        attemptedActions: [intent.actionKind],
      }),
    };
  }
  const exhausted = receipt.result === 'PERMANENT_FAILURE'
    || attempt.attempt >= protocol.retry.maxAttempts
    || attempt.sameFailureFingerprintCount >= protocol.retry.sameFailureFingerprintLimit;
  if (exhausted) {
    return {
      status: 'DIAGNOSIS_REQUIRED',
      terminal: true,
      nextEligibleLogicalTime: null,
      obligation: canonicalActionObligation(intent, source,
        receipt.result === 'PERMANENT_FAILURE' ? 'ACTION_PERMANENT_FAILURE' : 'RETRY_BUDGET_EXHAUSTED', {
          logicalNow: attempt.logicalNow,
          attemptedActions: [intent.actionKind],
        }),
    };
  }
  const backoff = protocol.retry.backoffLogicalTicks[Math.min(attempt.attempt - 1, protocol.retry.backoffLogicalTicks.length - 1)];
  const due = (now + BigInt(backoff ?? 1)).toString();
  return {
    status: 'BACKOFF',
    terminal: false,
    nextEligibleLogicalTime: due,
    obligation: canonicalActionObligation(intent, source, 'BACKOFF_ACTIVE', {
      logicalNow: attempt.logicalNow,
      dueLogicalTime: due,
      attemptedActions: [intent.actionKind],
    }),
  };
}

/** One candidate per project competes, and the least recently served project wins. */
export function selectFairAction(
  candidates: FairActionCandidate[],
  projects: ProjectFairnessState[],
  logicalNow: string,
): FairActionCandidate | null {
  const now = logical(logicalNow);
  if (now === null) return null;
  const byProject = new Map<string, FairActionCandidate>();
  for (const candidate of candidates) {
    const eligible = logical(candidate.nextEligibleLogicalTime);
    const deadline = logical(candidate.deadlineLogicalTime);
    if (eligible === null || deadline === null || eligible > now || deadline < now) continue;
    const previous = byProject.get(candidate.projectId);
    if (!previous || candidate.enqueuedSequence < previous.enqueuedSequence
        || (candidate.enqueuedSequence === previous.enqueuedSequence
          && compare(candidate.actionIntentId, previous.actionIntentId) < 0)) {
      byProject.set(candidate.projectId, candidate);
    }
  }
  const state = new Map(projects.map((entry) => [entry.projectId, entry.lastDispatchedSequence]));
  return [...byProject.values()].sort((left, right) => {
    const leftSequence = state.get(left.projectId) ?? null;
    const rightSequence = state.get(right.projectId) ?? null;
    if (leftSequence === null && rightSequence !== null) return -1;
    if (leftSequence !== null && rightSequence === null) return 1;
    if (leftSequence !== rightSequence) return (leftSequence ?? 0) - (rightSequence ?? 0);
    const projectOrder = compare(left.projectId, right.projectId);
    return projectOrder !== 0 ? projectOrder : left.enqueuedSequence - right.enqueuedSequence;
  })[0] ?? null;
}

export function actionRequestDigest(intent: ConstrainedActionIntent, source: BoundSourceObligation): string {
  return digest({ intent, source });
}

export function actionReceiptDigest(receipt: ProviderActionReceipt): string {
  return digest(receipt);
}

export function actionFailureFingerprint(code: string, detail: unknown = null): string {
  return digest({ code, detail });
}
