import { createHash } from 'node:crypto';
import { canonicalJson, compare } from '../projects/canonical-json';
import {
  transitionForReceipt,
  type ActionAttemptState,
  type ActionProtocolDeclaration,
  type ActionTransition,
  type BoundSourceObligation,
  type ConstrainedActionIntent,
  type ProviderActionReceipt,
} from './action-executor';

/** The contract must say whether a historical landing is enough or the current ref must contain it. */
export const DELIVERY_POLICY_MODES = [
  'EVER_DELIVERED',
  'CURRENT_TARGET_CONTAINS',
] as const;

export type DeliveryPolicyMode = (typeof DELIVERY_POLICY_MODES)[number];

export const DELIVERY_ATTESTATION_RESULTS = [
  'INTEGRATED',
  'ALREADY_INTEGRATED',
  'CONFLICT',
  'FAILED',
  'PARTIAL_EFFECT',
  'EFFECT_RECONCILED',
] as const;

export type DeliveryAttestationResult = (typeof DELIVERY_ATTESTATION_RESULTS)[number];

export interface DeliveryRequirement {
  schemaVersion: 1;
  tenantId: string;
  projectId: string;
  goalId: string;
  goalRevision: string;
  canonicalBindingDigest: string;
  deliveryBindingDigest: string;
  bindingRevisionDigest: string;
  policyMode: DeliveryPolicyMode;
  repositoryProvider: string;
  repositoryId: string;
  repositoryDigest: string;
  targetRef: string;
  currentTargetSha: string;
  currentTargetContentDigest: string;
  artifactDigest: string;
  evaluationPlanDigest: string;
  acceptanceCommandDigest: string;
  integrationProviderIdentity: string;
  verificationProviderIdentity: string;
  asOfLogicalTime: string;
}

export interface DeliveryAttestation {
  schemaVersion: 1;
  attestationId: string;
  deliveryBindingDigest: string;
  bindingRevisionDigest: string;
  providerReceiptId: string;
  providerIdentity: string;
  repositoryProvider: string;
  repositoryId: string;
  repositoryDigest: string;
  targetRef: string;
  targetSha: string;
  targetContentDigest: string;
  artifactDigest: string;
  result: DeliveryAttestationResult;
  externalEffectState: 'NONE' | 'PARTIAL' | 'UNKNOWN';
  verifiedAt: string;
  verifiedLogicalTime: string;
  idempotencyKey: string;
  receiptDigest: string;
}

export interface CleanTargetVerification {
  schemaVersion: 1;
  verificationId: string;
  deliveryBindingDigest: string;
  bindingRevisionDigest: string;
  providerReceiptId: string;
  providerIdentity: string;
  repositoryDigest: string;
  targetRef: string;
  targetSha: string;
  targetContentDigest: string;
  artifactDigest: string;
  evaluationPlanDigest: string;
  acceptanceCommandDigest: string;
  environment: 'CLEAN_TARGET_SHA';
  result: 'PASS' | 'FAIL' | 'ERROR';
  exitCode: number;
  skipCount: number;
  verifiedAt: string;
  verifiedLogicalTime: string;
  idempotencyKey: string;
  receiptDigest: string;
}

export interface WorktreeExecutionEvidence {
  worktreeId: string;
  sourceSha: string;
  commandDigest: string;
  exitCode: number;
}

export interface DeliveryEvidenceSet {
  requirement: DeliveryRequirement;
  attestations: DeliveryAttestation[];
  verifications: CleanTargetVerification[];
  /** Accepted for audit visibility only. It is deliberately never a proof input. */
  worktreeExecutions?: WorktreeExecutionEvidence[];
}

export type DeliveryDimensionId =
  | 'ARTIFACT_INTEGRATION'
  | 'TARGET_PRESENCE'
  | 'POST_MERGE_VERIFICATION'
  | 'ACTION_REMEDIATION';

export interface DeliveryDimensionResult {
  dimensionId: DeliveryDimensionId;
  state: 'SATISFIED' | 'UNSATISFIED' | 'UNKNOWN' | 'CONFLICT' | 'NOT_APPLICABLE';
  reasonCode: string;
  evidenceFactIds: string[];
  applicabilityProofDigest: string | null;
}

export type DeliveryObligationRoute = 'RETRY' | 'DIAGNOSIS' | 'COMPENSATION';

export interface DeliveryObligation extends BoundSourceObligation {
  state: 'ACTIVE';
  mandatory: true;
  reason: {
    code: string;
    message: string;
    evidenceFactIds: string[];
    attemptedActions: string[];
    nextAction: string;
    route: DeliveryObligationRoute;
  };
  actionProtocolProfile: 'SYSTEM_ACTION' | 'AGENT_ACTION';
  resolverProfile: 'STANDARD_MANDATORY';
  createdAtLogicalTime: string;
  dueLogicalTime: string | null;
}

export interface DeliveryDiagnostic {
  code: string;
  evidenceId: string;
  message: string;
}

export interface DeliveryEvaluation {
  schemaVersion: 1;
  policyMode: DeliveryPolicyMode;
  deliveryBindingDigest: string;
  bindingRevisionDigest: string;
  integrationState: 'SATISFIED' | 'UNSATISFIED' | 'UNKNOWN' | 'CONFLICT';
  everDelivered: boolean;
  currentTargetContains: boolean;
  cleanTargetVerified: boolean;
  selectedAttestationId: string | null;
  selectedVerificationId: string | null;
  dimensions: DeliveryDimensionResult[];
  activeMandatoryObligations: DeliveryObligation[];
  diagnostics: DeliveryDiagnostic[];
  rejectedEvidenceIds: string[];
  exactReplayCount: number;
  worktreeExitZeroIsDeliveryEvidence: false;
  proofDigest: string;
  evaluationDigest: string;
}

export type DeliveryActionFailure =
  | 'MERGE_CONFLICT'
  | 'TARGET_ADVANCED'
  | 'POST_MERGE_REGRESSION'
  | 'PARTIAL_EXTERNAL_EFFECT';

const DIGEST = /^[0-9a-f]{64}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LOGICAL = /^(0|[1-9][0-9]*)$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validDate(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function stable(values: string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function stableRequirementMaterial(requirement: Omit<
  DeliveryRequirement,
  'deliveryBindingDigest' | 'bindingRevisionDigest' | 'currentTargetSha' |
  'currentTargetContentDigest'
>): Record<string, unknown> {
  return {
    namespace: 'orbit.delivery-binding.v1',
    schemaVersion: requirement.schemaVersion,
    tenantId: requirement.tenantId,
    projectId: requirement.projectId,
    goalId: requirement.goalId,
    goalRevision: requirement.goalRevision,
    canonicalBindingDigest: requirement.canonicalBindingDigest,
    policyMode: requirement.policyMode,
    repositoryProvider: requirement.repositoryProvider,
    repositoryId: requirement.repositoryId,
    repositoryDigest: requirement.repositoryDigest,
    targetRef: requirement.targetRef,
    artifactDigest: requirement.artifactDigest,
    evaluationPlanDigest: requirement.evaluationPlanDigest,
    acceptanceCommandDigest: requirement.acceptanceCommandDigest,
    integrationProviderIdentity: requirement.integrationProviderIdentity,
    verificationProviderIdentity: requirement.verificationProviderIdentity,
  };
}

/** Stable across target advances: that is what lets EVER_DELIVERED retain its explicit meaning. */
export function deliveryBindingDigestFor(requirement: Omit<
  DeliveryRequirement,
  'deliveryBindingDigest' | 'bindingRevisionDigest'
>): string {
  return digest(stableRequirementMaterial(requirement));
}

export function deliveryBindingRevisionDigestFor(requirement: Omit<
  DeliveryRequirement,
  'bindingRevisionDigest'
>): string {
  return digest({
    namespace: 'orbit.delivery-binding-revision.v1',
    deliveryBindingDigest: requirement.deliveryBindingDigest,
    currentTargetSha: requirement.currentTargetSha,
    currentTargetContentDigest: requirement.currentTargetContentDigest,
    asOfLogicalTime: requirement.asOfLogicalTime,
  });
}

function attestationBody(value: Omit<DeliveryAttestation, 'attestationId' | 'receiptDigest'>) {
  return {
    schemaVersion: value.schemaVersion,
    deliveryBindingDigest: value.deliveryBindingDigest,
    bindingRevisionDigest: value.bindingRevisionDigest,
    providerReceiptId: value.providerReceiptId,
    providerIdentity: value.providerIdentity,
    repositoryProvider: value.repositoryProvider,
    repositoryId: value.repositoryId,
    repositoryDigest: value.repositoryDigest,
    targetRef: value.targetRef,
    targetSha: value.targetSha,
    targetContentDigest: value.targetContentDigest,
    artifactDigest: value.artifactDigest,
    result: value.result,
    externalEffectState: value.externalEffectState,
    verifiedAt: value.verifiedAt,
    verifiedLogicalTime: value.verifiedLogicalTime,
    idempotencyKey: value.idempotencyKey,
  };
}

export function deliveryAttestationDigest(value: Omit<DeliveryAttestation, 'receiptDigest'>): string {
  return digest(attestationBody(value));
}

function verificationBody(value: Omit<CleanTargetVerification, 'verificationId' | 'receiptDigest'>) {
  return {
    schemaVersion: value.schemaVersion,
    deliveryBindingDigest: value.deliveryBindingDigest,
    bindingRevisionDigest: value.bindingRevisionDigest,
    providerReceiptId: value.providerReceiptId,
    providerIdentity: value.providerIdentity,
    repositoryDigest: value.repositoryDigest,
    targetRef: value.targetRef,
    targetSha: value.targetSha,
    targetContentDigest: value.targetContentDigest,
    artifactDigest: value.artifactDigest,
    evaluationPlanDigest: value.evaluationPlanDigest,
    acceptanceCommandDigest: value.acceptanceCommandDigest,
    environment: value.environment,
    result: value.result,
    exitCode: value.exitCode,
    skipCount: value.skipCount,
    verifiedAt: value.verifiedAt,
    verifiedLogicalTime: value.verifiedLogicalTime,
    idempotencyKey: value.idempotencyKey,
  };
}

export function cleanTargetVerificationDigest(
  value: Omit<CleanTargetVerification, 'receiptDigest'>,
): string {
  return digest(verificationBody(value));
}

function requirementError(requirement: DeliveryRequirement): string | null {
  if (requirement.schemaVersion !== 1 || !DELIVERY_POLICY_MODES.includes(requirement.policyMode)) {
    return 'DELIVERY_REQUIREMENT_SCHEMA_INVALID';
  }
  for (const value of [
    requirement.tenantId,
    requirement.projectId,
    requirement.goalId,
    requirement.repositoryProvider,
    requirement.repositoryId,
    requirement.targetRef,
    requirement.integrationProviderIdentity,
    requirement.verificationProviderIdentity,
  ]) if (!IDENTIFIER.test(value)) return 'DELIVERY_REQUIREMENT_IDENTITY_INVALID';
  for (const value of [
    requirement.canonicalBindingDigest,
    requirement.deliveryBindingDigest,
    requirement.bindingRevisionDigest,
    requirement.repositoryDigest,
    requirement.currentTargetContentDigest,
    requirement.artifactDigest,
    requirement.evaluationPlanDigest,
    requirement.acceptanceCommandDigest,
  ]) if (!DIGEST.test(value)) return 'DELIVERY_REQUIREMENT_DIGEST_INVALID';
  if (!SHA.test(requirement.currentTargetSha) || !LOGICAL.test(requirement.goalRevision)
      || !LOGICAL.test(requirement.asOfLogicalTime)) return 'DELIVERY_REQUIREMENT_VALUE_INVALID';
  const expectedBinding = deliveryBindingDigestFor(requirement);
  if (expectedBinding !== requirement.deliveryBindingDigest) return 'DELIVERY_BINDING_DIGEST_MISMATCH';
  const expectedRevision = deliveryBindingRevisionDigestFor(requirement);
  if (expectedRevision !== requirement.bindingRevisionDigest) return 'DELIVERY_BINDING_REVISION_MISMATCH';
  return null;
}

function attestationError(
  receipt: DeliveryAttestation,
  requirement: DeliveryRequirement,
): string | null {
  if (receipt.schemaVersion !== 1 || !DELIVERY_ATTESTATION_RESULTS.includes(receipt.result)) {
    return 'DELIVERY_ATTESTATION_SCHEMA_INVALID';
  }
  if (!IDENTIFIER.test(receipt.attestationId) || !IDENTIFIER.test(receipt.providerReceiptId)
      || !IDENTIFIER.test(receipt.providerIdentity) || !IDENTIFIER.test(receipt.idempotencyKey)) {
    return 'DELIVERY_ATTESTATION_IDENTITY_INVALID';
  }
  if (!DIGEST.test(receipt.receiptDigest) || !DIGEST.test(receipt.bindingRevisionDigest)
      || !DIGEST.test(receipt.repositoryDigest)
      || !DIGEST.test(receipt.targetContentDigest) || !DIGEST.test(receipt.artifactDigest)
      || !SHA.test(receipt.targetSha) || !LOGICAL.test(receipt.verifiedLogicalTime)
      || !validDate(receipt.verifiedAt)) return 'DELIVERY_ATTESTATION_VALUE_INVALID';
  if (deliveryAttestationDigest(receipt) !== receipt.receiptDigest) {
    return 'DELIVERY_ATTESTATION_DIGEST_MISMATCH';
  }
  if (receipt.deliveryBindingDigest !== requirement.deliveryBindingDigest) {
    return 'DELIVERY_ATTESTATION_BINDING_MISMATCH';
  }
  if (receipt.providerIdentity !== requirement.integrationProviderIdentity) {
    return 'DELIVERY_ATTESTATION_PROVIDER_MISMATCH';
  }
  if (receipt.repositoryProvider !== requirement.repositoryProvider
      || receipt.repositoryId !== requirement.repositoryId
      || receipt.repositoryDigest !== requirement.repositoryDigest) {
    return 'DELIVERY_ATTESTATION_REPOSITORY_MISMATCH';
  }
  if (receipt.targetRef !== requirement.targetRef || receipt.artifactDigest !== requirement.artifactDigest) {
    return 'DELIVERY_ATTESTATION_TARGET_OR_ARTIFACT_MISMATCH';
  }
  if (receipt.result === 'PARTIAL_EFFECT' && receipt.externalEffectState !== 'PARTIAL') {
    return 'DELIVERY_PARTIAL_EFFECT_STATE_INVALID';
  }
  if (receipt.result === 'EFFECT_RECONCILED' && receipt.externalEffectState !== 'NONE') {
    return 'DELIVERY_RECONCILED_EFFECT_STATE_INVALID';
  }
  if (!['PARTIAL_EFFECT'].includes(receipt.result) && receipt.externalEffectState === 'PARTIAL') {
    return 'DELIVERY_EFFECT_STATE_CONFLICT';
  }
  return null;
}

function verificationError(
  receipt: CleanTargetVerification,
  requirement: DeliveryRequirement,
): string | null {
  if (receipt.schemaVersion !== 1 || !['PASS', 'FAIL', 'ERROR'].includes(receipt.result)
      || receipt.environment !== 'CLEAN_TARGET_SHA') return 'DELIVERY_VERIFICATION_SCHEMA_INVALID';
  if (!IDENTIFIER.test(receipt.verificationId) || !IDENTIFIER.test(receipt.providerReceiptId)
      || !IDENTIFIER.test(receipt.providerIdentity) || !IDENTIFIER.test(receipt.idempotencyKey)) {
    return 'DELIVERY_VERIFICATION_IDENTITY_INVALID';
  }
  if (!DIGEST.test(receipt.receiptDigest) || !DIGEST.test(receipt.bindingRevisionDigest)
      || !DIGEST.test(receipt.repositoryDigest)
      || !DIGEST.test(receipt.targetContentDigest) || !DIGEST.test(receipt.artifactDigest)
      || !DIGEST.test(receipt.evaluationPlanDigest) || !DIGEST.test(receipt.acceptanceCommandDigest)
      || !SHA.test(receipt.targetSha) || !LOGICAL.test(receipt.verifiedLogicalTime)
      || !validDate(receipt.verifiedAt) || !Number.isSafeInteger(receipt.exitCode)
      || !Number.isSafeInteger(receipt.skipCount) || receipt.skipCount < 0) {
    return 'DELIVERY_VERIFICATION_VALUE_INVALID';
  }
  if (cleanTargetVerificationDigest(receipt) !== receipt.receiptDigest) {
    return 'DELIVERY_VERIFICATION_DIGEST_MISMATCH';
  }
  if (receipt.deliveryBindingDigest !== requirement.deliveryBindingDigest
      || receipt.providerIdentity !== requirement.verificationProviderIdentity) {
    return 'DELIVERY_VERIFICATION_BINDING_OR_PROVIDER_MISMATCH';
  }
  if (receipt.repositoryDigest !== requirement.repositoryDigest
      || receipt.targetRef !== requirement.targetRef
      || receipt.artifactDigest !== requirement.artifactDigest
      || receipt.evaluationPlanDigest !== requirement.evaluationPlanDigest
      || receipt.acceptanceCommandDigest !== requirement.acceptanceCommandDigest) {
    return 'DELIVERY_VERIFICATION_TARGET_OR_PLAN_MISMATCH';
  }
  if (receipt.result === 'PASS' && (receipt.exitCode !== 0 || receipt.skipCount !== 0)) {
    return 'DELIVERY_VERIFICATION_FALSE_PASS';
  }
  return null;
}

function compareLogical<T extends { verifiedLogicalTime: string; providerReceiptId: string }>(
  left: T,
  right: T,
): number {
  const logicalOrder = BigInt(left.verifiedLogicalTime) < BigInt(right.verifiedLogicalTime)
    ? -1
    : BigInt(left.verifiedLogicalTime) > BigInt(right.verifiedLogicalTime) ? 1 : 0;
  return logicalOrder || compare(left.providerReceiptId, right.providerReceiptId);
}

function routeProfile(route: DeliveryObligationRoute, kind: string) {
  if (route === 'COMPENSATION') {
    return { owner: 'AGENT' as const, capability: 'effect.remediate', nextAction: 'RECONCILE_OR_REVERSE_RECORDED_EFFECT' };
  }
  if (route === 'DIAGNOSIS') {
    return { owner: 'AGENT' as const, capability: 'model-gap.diagnose', nextAction: 'DIAGNOSE_DELIVERY_FAILURE' };
  }
  if (kind === 'PROVE_TARGET_PRESENCE') {
    return { owner: 'SYSTEM' as const, capability: 'target.presence.verify', nextAction: 'REVERIFY_CURRENT_TARGET' };
  }
  if (kind === 'RUN_BOUND_VERIFICATION') {
    return { owner: 'AGENT' as const, capability: 'verification.execute', nextAction: 'RERUN_ON_CLEAN_TARGET_SHA' };
  }
  return { owner: 'AGENT' as const, capability: 'artifact.integrate', nextAction: 'RETRY_BOUND_INTEGRATION' };
}

function deliveryObligation(
  requirement: DeliveryRequirement,
  kind: string,
  code: string,
  route: DeliveryObligationRoute,
  blocksClosureOf: DeliveryDimensionId[] | Array<DeliveryDimensionId | 'MODEL_COVERAGE'>,
  evidenceFactIds: string[],
): DeliveryObligation {
  const profile = routeProfile(route, kind);
  const obligationId = digest({
    namespace: 'orbit.delivery-obligation.v1',
    tenantId: requirement.tenantId,
    projectId: requirement.projectId,
    goalId: requirement.goalId,
    goalRevision: requirement.goalRevision,
    deliveryBindingDigest: requirement.deliveryBindingDigest,
    kind,
  });
  const obligationRevision = digest({
    namespace: 'orbit.delivery-obligation-revision.v1',
    obligationId,
    bindingRevisionDigest: requirement.bindingRevisionDigest,
    code,
    route,
  });
  return {
    obligationId,
    obligationRevision,
    kind,
    state: 'ACTIVE',
    mandatory: true,
    owner: profile.owner,
    capability: profile.capability,
    binding: {
      tenantId: requirement.tenantId,
      projectId: requirement.projectId,
      goalId: requirement.goalId,
      goalRevision: requirement.goalRevision,
      canonicalBindingDigest: requirement.canonicalBindingDigest,
      deliveryBindingDigest: requirement.deliveryBindingDigest,
      bindingRevisionDigest: requirement.bindingRevisionDigest,
      repositoryDigest: requirement.repositoryDigest,
      targetRef: requirement.targetRef,
      currentTargetSha: requirement.currentTargetSha,
      currentTargetContentDigest: requirement.currentTargetContentDigest,
      artifactDigest: requirement.artifactDigest,
      policyMode: requirement.policyMode,
    },
    bindingDigest: requirement.deliveryBindingDigest,
    goalId: requirement.goalId,
    goalRevision: requirement.goalRevision,
    reason: {
      code,
      message: `${code} prevents trusted delivery for ${requirement.repositoryId}:${requirement.targetRef}.`,
      evidenceFactIds: stable(evidenceFactIds),
      attemptedActions: [],
      nextAction: profile.nextAction,
      route,
    },
    actionProtocolProfile: profile.owner === 'SYSTEM' ? 'SYSTEM_ACTION' : 'AGENT_ACTION',
    servesCriterionIds: ['ARTIFACT_INTEGRATION', 'TARGET_PRESENCE', 'POST_MERGE_VERIFICATION'],
    blocksClosureOf: stable(blocksClosureOf),
    ownership: {
      homeProjectId: requirement.projectId,
      blockingProjectIds: [requirement.projectId],
      crossingId: null,
      handoffId: null,
      handoffStatus: 'NOT_REQUIRED',
      attributionDecisionFactId: null,
    },
    resolverProfile: 'STANDARD_MANDATORY',
    createdAtLogicalTime: requirement.asOfLogicalTime,
    dueLogicalTime: null,
  };
}

function fatalDeliveryEvaluation(requirement: DeliveryRequirement, code: string): DeliveryEvaluation {
  const obligation = deliveryObligation(
    requirement,
    'DIAGNOSE_MODEL_GAP',
    code,
    'DIAGNOSIS',
    ['ARTIFACT_INTEGRATION', 'TARGET_PRESENCE', 'POST_MERGE_VERIFICATION', 'MODEL_COVERAGE'],
    [],
  );
  const dimensions: DeliveryDimensionResult[] = [
    'ARTIFACT_INTEGRATION',
    'TARGET_PRESENCE',
    'POST_MERGE_VERIFICATION',
    'ACTION_REMEDIATION',
  ].map((dimensionId) => ({
    dimensionId: dimensionId as DeliveryDimensionId,
    state: 'UNKNOWN',
    reasonCode: code,
    evidenceFactIds: [],
    applicabilityProofDigest: null,
  }));
  const proofDigest = digest({ code, dimensions, obligation });
  const body = {
    schemaVersion: 1 as const,
    policyMode: requirement.policyMode,
    deliveryBindingDigest: requirement.deliveryBindingDigest,
    bindingRevisionDigest: requirement.bindingRevisionDigest,
    integrationState: 'UNKNOWN' as const,
    everDelivered: false,
    currentTargetContains: false,
    cleanTargetVerified: false,
    selectedAttestationId: null,
    selectedVerificationId: null,
    dimensions,
    activeMandatoryObligations: [obligation],
    diagnostics: [{ code, evidenceId: 'requirement', message: code }],
    rejectedEvidenceIds: [] as string[],
    exactReplayCount: 0,
    worktreeExitZeroIsDeliveryEvidence: false as const,
    proofDigest,
  };
  return { ...body, evaluationDigest: digest(body) };
}

/**
 * Pure delivery reducer. It does not read a worktree or mutable blocker projection. Exact provider
 * receipts, the bound repository/target/artifact and a clean-target verification are the only
 * positive inputs; every call re-derives the obligation set, so later valid evidence advances it
 * without anybody clearing a blocker by hand.
 */
export function evaluateDeliveryObligation(evidence: DeliveryEvidenceSet): DeliveryEvaluation {
  const requirement = evidence.requirement;
  const malformed = requirementError(requirement);
  if (malformed) return fatalDeliveryEvaluation(requirement, malformed);

  const diagnostics: DeliveryDiagnostic[] = [];
  const rejected = new Set<string>();
  let exactReplayCount = 0;
  const attestations: DeliveryAttestation[] = [];
  const attestationReplay = new Map<string, string>();
  for (const receipt of evidence.attestations ?? []) {
    const error = attestationError(receipt, requirement);
    if (error) {
      diagnostics.push({ code: error, evidenceId: receipt.attestationId, message: error });
      rejected.add(receipt.attestationId);
      continue;
    }
    const replayKey = `${receipt.providerIdentity}\u0000${receipt.providerReceiptId}`;
    const standing = attestationReplay.get(replayKey);
    if (standing) {
      if (standing === receipt.receiptDigest) exactReplayCount += 1;
      else {
        diagnostics.push({
          code: 'DELIVERY_PROVIDER_RECEIPT_REPLAY_CONFLICT',
          evidenceId: receipt.attestationId,
          message: 'One provider receipt identity was replayed with different canonical bytes.',
        });
        rejected.add(receipt.attestationId);
      }
      continue;
    }
    attestationReplay.set(replayKey, receipt.receiptDigest);
    attestations.push(receipt);
  }

  const verifications: CleanTargetVerification[] = [];
  const verificationReplay = new Map<string, string>();
  for (const receipt of evidence.verifications ?? []) {
    const error = verificationError(receipt, requirement);
    if (error) {
      diagnostics.push({ code: error, evidenceId: receipt.verificationId, message: error });
      rejected.add(receipt.verificationId);
      continue;
    }
    const replayKey = `${receipt.providerIdentity}\u0000${receipt.providerReceiptId}`;
    const standing = verificationReplay.get(replayKey);
    if (standing) {
      if (standing === receipt.receiptDigest) exactReplayCount += 1;
      else {
        diagnostics.push({
          code: 'DELIVERY_PROVIDER_RECEIPT_REPLAY_CONFLICT',
          evidenceId: receipt.verificationId,
          message: 'One verification receipt identity was replayed with different canonical bytes.',
        });
        rejected.add(receipt.verificationId);
      }
      continue;
    }
    verificationReplay.set(replayKey, receipt.receiptDigest);
    verifications.push(receipt);
  }
  attestations.sort(compareLogical);
  verifications.sort(compareLogical);

  const integrated = attestations.filter((receipt) => (
    receipt.result === 'INTEGRATED' || receipt.result === 'ALREADY_INTEGRATED'
  ));
  const everAttestation = integrated.at(-1) ?? null;
  const currentAttestation = integrated.filter((receipt) => (
    receipt.bindingRevisionDigest === requirement.bindingRevisionDigest
    && receipt.targetSha === requirement.currentTargetSha
    && receipt.targetContentDigest === requirement.currentTargetContentDigest
  )).at(-1) ?? null;
  const selectedAttestation = requirement.policyMode === 'EVER_DELIVERED'
    ? everAttestation
    : currentAttestation;
  const latestVerificationFor = (attestation: DeliveryAttestation | null) => attestation
    ? verifications.filter((receipt) => (
      receipt.bindingRevisionDigest === attestation.bindingRevisionDigest
      && receipt.targetSha === attestation.targetSha
      && receipt.targetContentDigest === attestation.targetContentDigest
      && BigInt(receipt.verifiedLogicalTime) >= BigInt(attestation.verifiedLogicalTime)
      && Date.parse(receipt.verifiedAt) >= Date.parse(attestation.verifiedAt)
    )).at(-1) ?? null
    : null;
  const selectedVerification = latestVerificationFor(selectedAttestation);
  const matchingVerification = selectedVerification?.result === 'PASS'
    && selectedVerification.exitCode === 0
    && selectedVerification.skipCount === 0 ? selectedVerification : null;
  const everVerification = latestVerificationFor(everAttestation);
  const everVerified = everVerification?.result === 'PASS'
    && everVerification.exitCode === 0 && everVerification.skipCount === 0;
  const currentVerification = latestVerificationFor(currentAttestation);
  const currentVerified = currentVerification?.result === 'PASS'
    && currentVerification.exitCode === 0 && currentVerification.skipCount === 0;
  const latestEffectReceipt = attestations.filter((receipt) => (
    receipt.result === 'PARTIAL_EFFECT' || receipt.result === 'EFFECT_RECONCILED'
      || receipt.externalEffectState === 'PARTIAL' || receipt.externalEffectState === 'UNKNOWN'
  )).at(-1) ?? null;
  const partial = latestEffectReceipt && latestEffectReceipt.result !== 'EFFECT_RECONCILED'
    ? latestEffectReceipt
    : null;
  const latestFailure = attestations.filter((receipt) => (
    !['INTEGRATED', 'ALREADY_INTEGRATED'].includes(receipt.result)
  )).at(-1) ?? null;
  const selectedVerificationFailure = selectedVerification?.result !== 'PASS'
    ? selectedVerification ?? null
    : null;

  const applicableProof = digest({
    policyMode: requirement.policyMode,
    deliveryBindingDigest: requirement.deliveryBindingDigest,
  });
  const dimensions: DeliveryDimensionResult[] = [
    {
      dimensionId: 'ARTIFACT_INTEGRATION',
      state: everAttestation ? 'SATISFIED' : diagnostics.length > 0 ? 'CONFLICT' : 'UNSATISFIED',
      reasonCode: everAttestation ? 'DELIVERY_ATTESTATION_VERIFIED' : 'DELIVERY_ATTESTATION_REQUIRED',
      evidenceFactIds: everAttestation ? [everAttestation.attestationId] : [],
      applicabilityProofDigest: null,
    },
    {
      dimensionId: 'TARGET_PRESENCE',
      state: requirement.policyMode === 'EVER_DELIVERED'
        ? 'NOT_APPLICABLE'
        : currentAttestation ? 'SATISFIED' : diagnostics.length > 0 ? 'CONFLICT' : 'UNSATISFIED',
      reasonCode: requirement.policyMode === 'EVER_DELIVERED'
        ? 'POLICY_REQUIRES_EVER_DELIVERED_ONLY'
        : currentAttestation ? 'CURRENT_TARGET_CONTAINS_ARTIFACT' : 'CURRENT_TARGET_PRESENCE_REQUIRED',
      evidenceFactIds: currentAttestation ? [currentAttestation.attestationId] : [],
      applicabilityProofDigest: requirement.policyMode === 'EVER_DELIVERED' ? applicableProof : null,
    },
    {
      dimensionId: 'POST_MERGE_VERIFICATION',
      state: matchingVerification ? 'SATISFIED' : diagnostics.length > 0 ? 'CONFLICT' : 'UNSATISFIED',
      reasonCode: matchingVerification ? 'CLEAN_TARGET_SHA_VERIFIED' : 'CLEAN_TARGET_SHA_VERIFICATION_REQUIRED',
      evidenceFactIds: matchingVerification ? [matchingVerification.verificationId] : [],
      applicabilityProofDigest: null,
    },
    {
      dimensionId: 'ACTION_REMEDIATION',
      state: partial ? 'UNSATISFIED' : 'NOT_APPLICABLE',
      reasonCode: partial ? 'DELIVERY_PARTIAL_EXTERNAL_EFFECT' : 'NO_DELIVERY_SIDE_EFFECT_TO_REMEDIATE',
      evidenceFactIds: partial ? [partial.attestationId] : [],
      applicabilityProofDigest: partial ? null : applicableProof,
    },
  ];

  const active: DeliveryObligation[] = [];
  const nonterminal = dimensions
    .filter((dimension) => !['SATISFIED', 'NOT_APPLICABLE'].includes(dimension.state))
    .map((dimension) => dimension.dimensionId);
  if (diagnostics.length > 0) {
    active.push(deliveryObligation(
      requirement,
      'DIAGNOSE_MODEL_GAP',
      diagnostics.some((item) => item.code === 'DELIVERY_PROVIDER_RECEIPT_REPLAY_CONFLICT')
        ? 'DELIVERY_PROVIDER_RECEIPT_REPLAY_CONFLICT'
        : 'DELIVERY_ATTESTATION_INVALID',
      'DIAGNOSIS',
      [...nonterminal, 'MODEL_COVERAGE'],
      diagnostics.map((item) => item.evidenceId),
    ));
  } else if (partial) {
    active.push(deliveryObligation(
      requirement,
      'REMEDIATE_SIDE_EFFECT',
      'DELIVERY_PARTIAL_EXTERNAL_EFFECT',
      'COMPENSATION',
      ['ACTION_REMEDIATION'],
      [partial.attestationId],
    ));
  } else if (!selectedAttestation) {
    const targetAdvanced = requirement.policyMode === 'CURRENT_TARGET_CONTAINS' && everAttestation !== null;
    active.push(deliveryObligation(
      requirement,
      targetAdvanced ? 'PROVE_TARGET_PRESENCE' : 'PROVE_ARTIFACT_INTEGRATION',
      targetAdvanced
        ? 'DELIVERY_TARGET_ADVANCED'
        : latestFailure?.result === 'CONFLICT' ? 'DELIVERY_MERGE_CONFLICT' : 'DELIVERY_ATTESTATION_REQUIRED',
      'RETRY',
      nonterminal,
      latestFailure ? [latestFailure.attestationId] : [],
    ));
  } else if (!matchingVerification) {
    const regression = selectedVerificationFailure !== null;
    active.push(deliveryObligation(
      requirement,
      regression ? 'DIAGNOSE_MODEL_GAP' : 'RUN_BOUND_VERIFICATION',
      regression ? 'DELIVERY_POST_MERGE_REGRESSION' : 'DELIVERY_CLEAN_TARGET_RERUN_REQUIRED',
      regression ? 'DIAGNOSIS' : 'RETRY',
      ['POST_MERGE_VERIFICATION', ...(regression ? ['MODEL_COVERAGE' as const] : [])],
      regression ? [selectedVerificationFailure.verificationId] : [selectedAttestation.attestationId],
    ));
  }

  const everDelivered = everAttestation !== null && everVerified;
  const currentTargetContains = currentAttestation !== null && currentVerified;
  const cleanTargetVerified = matchingVerification !== null;
  const satisfiedByPolicy = requirement.policyMode === 'EVER_DELIVERED'
    ? everDelivered
    : currentTargetContains;
  const integrationState: DeliveryEvaluation['integrationState'] = diagnostics.length > 0
    ? 'CONFLICT'
    : satisfiedByPolicy && !partial && active.length === 0 ? 'SATISFIED' : 'UNSATISFIED';
  const proofMaterial = {
    requirement: {
      deliveryBindingDigest: requirement.deliveryBindingDigest,
      bindingRevisionDigest: requirement.bindingRevisionDigest,
      policyMode: requirement.policyMode,
      repositoryDigest: requirement.repositoryDigest,
      targetRef: requirement.targetRef,
      currentTargetSha: requirement.currentTargetSha,
      currentTargetContentDigest: requirement.currentTargetContentDigest,
      artifactDigest: requirement.artifactDigest,
      evaluationPlanDigest: requirement.evaluationPlanDigest,
      acceptanceCommandDigest: requirement.acceptanceCommandDigest,
    },
    selectedAttestationDigest: selectedAttestation?.receiptDigest ?? null,
    selectedVerificationDigest: matchingVerification?.receiptDigest ?? null,
    dimensions,
    obligationRevisions: active.map((item) => item.obligationRevision),
    rejectedEvidenceIds: stable([...rejected]),
  };
  const proofDigest = digest(proofMaterial);
  const body = {
    schemaVersion: 1 as const,
    policyMode: requirement.policyMode,
    deliveryBindingDigest: requirement.deliveryBindingDigest,
    bindingRevisionDigest: requirement.bindingRevisionDigest,
    integrationState,
    everDelivered,
    currentTargetContains,
    cleanTargetVerified,
    selectedAttestationId: selectedAttestation?.attestationId ?? null,
    selectedVerificationId: matchingVerification?.verificationId ?? null,
    dimensions,
    activeMandatoryObligations: active.sort((left, right) => compare(left.obligationId, right.obligationId)),
    diagnostics: diagnostics.sort((left, right) => compare(left.evidenceId, right.evidenceId)),
    rejectedEvidenceIds: stable([...rejected]),
    exactReplayCount,
    worktreeExitZeroIsDeliveryEvidence: false as const,
    proofDigest,
  };
  return { ...body, evaluationDigest: digest(body) };
}

/** Payloads a trusted delivery evaluator may append to the canonical fact stream. */
export function deliveryDimensionFacts(evaluation: DeliveryEvaluation): Array<{
  dimensionId: DeliveryDimensionId;
  state: DeliveryDimensionResult['state'];
  reasonCode: string;
  evidenceFactIds: string[];
  applicabilityProofDigest: string | null;
  deliveryProofDigest: string;
}> {
  return evaluation.dimensions.map((dimension) => ({
    ...dimension,
    deliveryProofDigest: evaluation.proofDigest,
  }));
}

/**
 * Delivery failures are not private status strings. This adapter turns them into provider
 * receipts and delegates retry/diagnosis/compensation to the constrained Action Executor.
 */
export function deliveryFailureTransition(
  failure: DeliveryActionFailure,
  intent: ConstrainedActionIntent,
  source: BoundSourceObligation,
  protocol: ActionProtocolDeclaration,
  attempt: ActionAttemptState,
): ActionTransition {
  const result: ProviderActionReceipt['result'] = failure === 'PARTIAL_EXTERNAL_EFFECT'
    ? 'PARTIAL_EFFECT'
    : failure === 'POST_MERGE_REGRESSION' ? 'PERMANENT_FAILURE' : 'RETRYABLE_FAILURE';
  const failureFingerprint = result === 'RETRYABLE_FAILURE' || result === 'PERMANENT_FAILURE'
    ? digest({ failure, targetDigest: intent.targetDigest })
    : null;
  const receipt: ProviderActionReceipt = {
    providerIdentity: intent.principal.id,
    effectDigest: digest({ failure, actionIntentId: intent.actionIntentId, attempt: attempt.attempt }),
    observedAt: '1970-01-01T00:00:00.000Z',
    result,
    idempotencyKey: intent.idempotencyKey,
    failureFingerprint,
    retryAfterLogicalTicks: null,
    detail: { deliveryFailure: failure },
  };
  return transitionForReceipt(intent, source, protocol, receipt, attempt);
}
