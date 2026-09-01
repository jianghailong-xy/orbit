/**
 * Closed vocabulary for the deterministic Failure Continuation Controller.
 *
 * A failure domain answers who can make progress, not whether an executable criterion passed.
 * Typed termination remains an immutable attempt fact; routing may only decide the next bounded
 * piece of work.  Keep these values byte-for-byte aligned with migration 0211.
 */
export const FAILURE_CONTINUATION_DOMAINS = [
  'TRANSIENT_EXTERNAL',
  'EVALUATION_HARNESS',
  'PRODUCT_ARTIFACT',
  'CAPABILITY/ENVIRONMENT',
  'OWNER_REQUIRED',
] as const;

export type FailureContinuationDomain =
  (typeof FAILURE_CONTINUATION_DOMAINS)[number];

export const FAILURE_CONTINUATION_NODES = [
  'EXTERNAL_RATE_LIMIT',
  'EXTERNAL_NETWORK',
  'EXTERNAL_SERVICE',
  'EVALUATION_COMMAND',
  'TEST_HARNESS',
  'FIXTURE_SETUP',
  'ACCEPTANCE_ASSERTION',
  'PRODUCT_SOURCE',
  'BUILD_ARTIFACT',
  'PRODUCT_BEHAVIOR',
  'RUNTIME_CAPABILITY',
  'TOOLCHAIN',
  'EXECUTION_ENVIRONMENT',
  'RUNNER_INFRASTRUCTURE',
  'GOAL_BOUNDARY',
  'RISK_BOUNDARY',
  'AUTHORIZATION_BOUNDARY',
  'EXTERNAL_IDENTITY_BOUNDARY',
] as const;

export type FailureContinuationNode =
  (typeof FAILURE_CONTINUATION_NODES)[number];

export const FAILURE_CONTINUATION_OWNER_REASONS = [
  'GOAL_DECISION',
  'RISK_ACCEPTANCE',
  'NEW_AUTHORIZATION',
  'EXTERNAL_IDENTITY',
] as const;

export type FailureContinuationOwnerReason =
  (typeof FAILURE_CONTINUATION_OWNER_REASONS)[number];

export const FAILURE_CONTINUATION_TERMINATIONS = [
  'EXITED',
  'TIMED_OUT',
  'CANCELLED',
  'SIGNALED',
  'START_FAILED',
  'INFRASTRUCTURE_LOST',
] as const;

export type FailureContinuationTermination =
  (typeof FAILURE_CONTINUATION_TERMINATIONS)[number];

const OWNER_NODE_BY_REASON: Readonly<
  Record<FailureContinuationOwnerReason, FailureContinuationNode>
> = Object.freeze({
  GOAL_DECISION: 'GOAL_BOUNDARY',
  RISK_ACCEPTANCE: 'RISK_BOUNDARY',
  NEW_AUTHORIZATION: 'AUTHORIZATION_BOUNDARY',
  EXTERNAL_IDENTITY: 'EXTERNAL_IDENTITY_BOUNDARY',
});

const DOMAIN_BY_NODE: Readonly<Record<FailureContinuationNode, FailureContinuationDomain>> =
  Object.freeze({
    EXTERNAL_RATE_LIMIT: 'TRANSIENT_EXTERNAL',
    EXTERNAL_NETWORK: 'TRANSIENT_EXTERNAL',
    EXTERNAL_SERVICE: 'TRANSIENT_EXTERNAL',
    EVALUATION_COMMAND: 'EVALUATION_HARNESS',
    TEST_HARNESS: 'EVALUATION_HARNESS',
    FIXTURE_SETUP: 'EVALUATION_HARNESS',
    ACCEPTANCE_ASSERTION: 'EVALUATION_HARNESS',
    PRODUCT_SOURCE: 'PRODUCT_ARTIFACT',
    BUILD_ARTIFACT: 'PRODUCT_ARTIFACT',
    PRODUCT_BEHAVIOR: 'PRODUCT_ARTIFACT',
    RUNTIME_CAPABILITY: 'CAPABILITY/ENVIRONMENT',
    TOOLCHAIN: 'CAPABILITY/ENVIRONMENT',
    EXECUTION_ENVIRONMENT: 'CAPABILITY/ENVIRONMENT',
    RUNNER_INFRASTRUCTURE: 'CAPABILITY/ENVIRONMENT',
    GOAL_BOUNDARY: 'OWNER_REQUIRED',
    RISK_BOUNDARY: 'OWNER_REQUIRED',
    AUTHORIZATION_BOUNDARY: 'OWNER_REQUIRED',
    EXTERNAL_IDENTITY_BOUNDARY: 'OWNER_REQUIRED',
  });

export interface FailureDomainInput {
  terminationKind: FailureContinuationTermination;
  failureNode: FailureContinuationNode;
  ownerReason?: FailureContinuationOwnerReason | null;
  requiredCapability?: string | null;
  availableCapabilities?: readonly string[];
  evaluationPlanChanged?: boolean;
}

export interface FailureConvergenceInput {
  domain: FailureContinuationDomain;
  fingerprintOccurrence: number;
  unchangedEvidenceGenerations: number;
}

export interface FailureConvergenceRoute {
  diagnosticPath: 'PRIMARY_RECOVERY' | 'ALTERNATE_DIAGNOSIS'
    | 'PROJECT_ATTENTION' | 'OWNER_DECISION';
  projectAttention: boolean;
  allowsUnchangedRetry: boolean;
  changesDiagnosticPath: boolean;
}

export interface FailureContinuationObservation {
  /** Optional trusted structural diagnosis. Raw output is never allowed to name an owner. */
  failureNode?: FailureContinuationNode;
  /** Closed owner boundary; it must agree with the corresponding structural owner node. */
  ownerReason?: FailureContinuationOwnerReason;
  /** Additional capability needed by the selected diagnostic or repair path. */
  requiredCapability?: string;
  /** Secret-free, bounded facts that contribute to evidence identity. */
  evidenceFacts?: Record<string, unknown>;
}

export interface FailureContinuationRouteDecision {
  decisionId: string;
  obligationId: string;
  continuationId: string;
  tenantId: string;
  goalId: string;
  taskId: string;
  lineageDigest: string;
  bindingDigest: string;
  routeGeneration: string;
  contractDigest: string | null;
  attemptEvaluationPlanDigest: string;
  taskEvaluationPlanDigest: string | null;
  projectEvaluationPlanDigest: string | null;
  taskEvaluationPlanChanged: boolean;
  failureDomain: FailureContinuationDomain;
  failureNode: FailureContinuationNode;
  ownerReason: FailureContinuationOwnerReason | null;
  failureFingerprint: string;
  fingerprintOccurrence: number;
  evidenceNovel: boolean;
  unchangedEvidenceGenerations: number;
  diagnosticPath: FailureConvergenceRoute['diagnosticPath'];
  canonicalReason: Record<string, unknown>;
  evidence: Record<string, unknown>;
  evidenceSources: Array<Record<string, unknown>>;
  nextAction: Record<string, unknown>;
  deadlineAt: string;
  projectAttention: boolean;
  decisionDigest: string;
  idempotencyKey: string;
  decidedAt: string;
  replayed: boolean;
}

export function ownerNodeForFailureReason(
  reason: FailureContinuationOwnerReason,
): FailureContinuationNode {
  return OWNER_NODE_BY_REASON[reason];
}

export function validateFailureContinuationObservation(
  observation: FailureContinuationObservation,
): void {
  if (observation.failureNode !== undefined
      && !(FAILURE_CONTINUATION_NODES as readonly string[]).includes(observation.failureNode)) {
    throw new Error('FAILURE_CONTINUATION_NODE_INVALID');
  }
  if (observation.ownerReason !== undefined
      && !(FAILURE_CONTINUATION_OWNER_REASONS as readonly string[])
        .includes(observation.ownerReason)) {
    throw new Error('FAILURE_CONTINUATION_OWNER_REASON_FORBIDDEN');
  }
  if (observation.ownerReason !== undefined
      && observation.failureNode !== undefined
      && OWNER_NODE_BY_REASON[observation.ownerReason] !== observation.failureNode) {
    throw new Error('FAILURE_CONTINUATION_OWNER_REASON_NODE_MISMATCH');
  }
  if (observation.requiredCapability !== undefined
      && (observation.requiredCapability.trim() === ''
        || observation.requiredCapability.length > 200)) {
    throw new Error('FAILURE_CONTINUATION_REQUIRED_CAPABILITY_INVALID');
  }
  if (observation.evidenceFacts !== undefined) {
    if (observation.evidenceFacts === null || Array.isArray(observation.evidenceFacts)
        || typeof observation.evidenceFacts !== 'object') {
      throw new Error('FAILURE_CONTINUATION_EVIDENCE_FACTS_INVALID');
    }
    if (Buffer.byteLength(JSON.stringify(observation.evidenceFacts), 'utf8') > 16_384) {
      throw new Error('FAILURE_CONTINUATION_EVIDENCE_FACTS_TOO_LARGE');
    }
  }
}

/**
 * Pure domain reducer used by callers and regression fixtures. The database function applies the
 * same fixed priority while holding the claimed continuation fence:
 *
 * owner boundary > stale semantic contract > missing capability > evaluation-plan change > typed
 * infrastructure loss > structural failure node.
 */
export function classifyFailureContinuationDomain(
  input: FailureDomainInput,
): FailureContinuationDomain {
  if (!(FAILURE_CONTINUATION_TERMINATIONS as readonly string[])
    .includes(input.terminationKind)) {
    throw new Error('FAILURE_CONTINUATION_TERMINATION_INVALID');
  }
  if (!(FAILURE_CONTINUATION_NODES as readonly string[]).includes(input.failureNode)) {
    throw new Error('FAILURE_CONTINUATION_NODE_INVALID');
  }
  if (input.ownerReason != null) {
    if (!(FAILURE_CONTINUATION_OWNER_REASONS as readonly string[])
      .includes(input.ownerReason)) {
      throw new Error('FAILURE_CONTINUATION_OWNER_REASON_FORBIDDEN');
    }
    if (OWNER_NODE_BY_REASON[input.ownerReason] !== input.failureNode) {
      throw new Error('FAILURE_CONTINUATION_OWNER_REASON_NODE_MISMATCH');
    }
    return 'OWNER_REQUIRED';
  }
  if (DOMAIN_BY_NODE[input.failureNode] === 'OWNER_REQUIRED') return 'OWNER_REQUIRED';
  const required = input.requiredCapability?.trim();
  if (required && !(input.availableCapabilities ?? []).includes(required)) {
    return 'CAPABILITY/ENVIRONMENT';
  }
  if (input.evaluationPlanChanged === true) return 'EVALUATION_HARNESS';
  if (input.terminationKind === 'START_FAILED'
      || input.terminationKind === 'INFRASTRUCTURE_LOST') {
    return 'CAPABILITY/ENVIRONMENT';
  }
  return DOMAIN_BY_NODE[input.failureNode];
}

/** Hard convergence boundary, independent of any per-day automation setting. */
export function failureContinuationConvergenceRoute(
  input: FailureConvergenceInput,
): FailureConvergenceRoute {
  if (!(FAILURE_CONTINUATION_DOMAINS as readonly string[]).includes(input.domain)) {
    throw new Error('FAILURE_CONTINUATION_DOMAIN_INVALID');
  }
  if (!Number.isInteger(input.fingerprintOccurrence) || input.fingerprintOccurrence < 1
      || !Number.isInteger(input.unchangedEvidenceGenerations)
      || input.unchangedEvidenceGenerations < 1) {
    throw new Error('FAILURE_CONTINUATION_CONVERGENCE_COUNTER_INVALID');
  }
  if (input.domain === 'OWNER_REQUIRED') {
    return {
      diagnosticPath: 'OWNER_DECISION',
      projectAttention: false,
      allowsUnchangedRetry: false,
      changesDiagnosticPath: true,
    };
  }
  if (input.unchangedEvidenceGenerations >= 3) {
    return {
      diagnosticPath: 'PROJECT_ATTENTION',
      projectAttention: true,
      allowsUnchangedRetry: false,
      changesDiagnosticPath: true,
    };
  }
  if (input.fingerprintOccurrence >= 2) {
    return {
      diagnosticPath: 'ALTERNATE_DIAGNOSIS',
      projectAttention: false,
      allowsUnchangedRetry: false,
      changesDiagnosticPath: true,
    };
  }
  return {
    diagnosticPath: 'PRIMARY_RECOVERY',
    projectAttention: false,
    allowsUnchangedRetry: input.domain === 'TRANSIENT_EXTERNAL',
    changesDiagnosticPath: false,
  };
}

/**
 * Deterministic, owner-safe structural inference for an unannotated typed attempt. Owner nodes are
 * intentionally absent: an error string can justify engineering diagnosis, never human authority.
 */
export function inferFailureContinuationNode(input: {
  terminationKind: FailureContinuationTermination;
  rawOutput: string;
  requiredCapabilityMissing: boolean;
}): FailureContinuationNode {
  if (input.requiredCapabilityMissing) return 'RUNTIME_CAPABILITY';
  if (input.terminationKind === 'START_FAILED'
      || input.terminationKind === 'INFRASTRUCTURE_LOST') {
    return 'RUNNER_INFRASTRUCTURE';
  }
  const output = input.rawOutput.toLowerCase();
  if (/(?:\b429\b|rate.?limit|econnreset|econnrefused|enotfound|dns|service unavailable|\b503\b)/i
    .test(output)) return 'EXTERNAL_SERVICE';
  if (/(?:prisma\/config|cannot find module|fixture|test harness|test runner|tap version|configuration error)/i
    .test(output)) return 'FIXTURE_SETUP';
  if (input.terminationKind === 'TIMED_OUT') return 'TEST_HARNESS';
  if (input.terminationKind === 'CANCELLED' || input.terminationKind === 'SIGNALED') {
    return 'EXECUTION_ENVIRONMENT';
  }
  return 'PRODUCT_BEHAVIOR';
}
