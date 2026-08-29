import { encodeId } from './idCodec';

export interface OwnerRatificationLinkedObligation {
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  evaluatedThroughWatermark: string;
  taskId: string;
  reasonCode: string;
}

/** Secret-free canonical identity used verbatim by inbox, Project Attention and detail. */
export interface OwnerRatificationReference {
  kind: 'OWNER_RATIFICATION';
  status: 'PENDING';
  projectId: string;
  projectTitle: string;
  decisionRequestId: string;
  requestRevision: string;
  obligationId: string;
  obligationRevision: string;
  obligationSource: 'AUTO_DISPATCH' | 'OWNER_DECISION_REQUEST';
  contractDigest: string;
  contractRevision: string;
  reason: string;
  reasonCode: string;
  owner: 'OWNER';
  ownerId: string;
  evaluatedThroughWatermark: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  linkedObligations: OwnerRatificationLinkedObligation[];
}

export interface OwnerRatificationInboxPage {
  total: number;
  items: OwnerRatificationReference[];
}

export interface OwnerRatificationSemanticCriterion {
  semanticHash: string;
  text: string;
}

export interface OwnerRatificationSemanticContract {
  goal?: string | null;
  criteria?: OwnerRatificationSemanticCriterion[];
  criteriaTrust?: Array<{ completionCriterion?: string; semanticHash?: string }>;
  riskBoundary?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  recipients?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OwnerRatificationDecisionSurface {
  reference: OwnerRatificationReference;
  semanticContract: OwnerRatificationSemanticContract;
  evaluationPlan: Record<string, unknown>;
  semanticDiff: Record<string, unknown>;
  impact: unknown;
  impacts: { APPROVE?: unknown; DENY?: unknown };
  recommendation: unknown;
  noActionConsequence: unknown;
  whyNotAgent: unknown;
  resumeAfterDecision: unknown;
  options: unknown;
}

export interface OwnerRatificationDecisionRequestView {
  id: string;
  contractDigest: string;
  expiresAt: string;
  payload: Record<string, unknown>;
  reasonCode: string;
  requestGeneration: string;
  semanticDiff: Record<string, unknown>;
  status: string;
}

export interface OwnerRatificationReview {
  projectId: string;
  projectTitle: string;
  owner: 'OWNER';
  ownerId: string;
  budgetDigest: string;
  contractDigest: string;
  contractRevision: string;
  evaluationPlanDigest: string;
  evaluationPlanRevision: string;
  permissionDigest: string;
  recipientDigest: string;
  riskPolicyDigest: string;
  ratified: boolean;
  ratification: Record<string, unknown> | null;
  semanticContract: OwnerRatificationSemanticContract;
  evaluationPlan: Record<string, unknown>;
  decisionRequest: OwnerRatificationDecisionRequestView | null;
  latestDecision: OwnerRatificationLatestDecision | null;
  decisionSurface: OwnerRatificationDecisionSurface | null;
}

export interface OwnerRatificationLatestDecision {
  decisionRequestId: string;
  contractDigest: string;
  decision: 'APPROVE' | 'DENY';
  status: 'APPROVED' | 'DENIED';
  decidedAt: string;
  decidedByType: 'OWNER';
}

export interface OwnerRatificationPrivateRead extends Omit<OwnerRatificationReview, 'decisionRequest'> {
  decisionRequest: (OwnerRatificationDecisionRequestView & { ctaToken?: unknown }) | null;
}

export interface OwnerRatificationCapabilitySplit {
  review: OwnerRatificationReview;
  ctaToken: string | null;
}

function withoutCapability(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCapability);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'ctaToken' && key !== 'cta_token')
      .map(([key, nested]) => [key, withoutCapability(nested)]),
  );
}

/**
 * Move the one-use capability out of the response object before React receives any render state.
 * The review object has no field capable of holding it and can safely be inspected in devtools;
 * the returned token belongs in a component-local ref only.
 */
export function splitOwnerRatificationCapability(
  value: OwnerRatificationPrivateRead,
): OwnerRatificationCapabilitySplit {
  const request = value.decisionRequest;
  const ctaToken = typeof request?.ctaToken === 'string' ? request.ctaToken : null;
  const safe = withoutCapability(value) as OwnerRatificationReview;
  return { review: safe, ctaToken };
}

export function ownerRatificationInboxPath(limit = 100): string {
  return `/projects/ratification/pending?limit=${limit}`;
}

export function ownerRatificationPath(projectId: string): string {
  return `/projects/${encodeURIComponent(encodeId(projectId))}/ratification`;
}

export function ownerRatificationReviewPath(projectId: string, requestId: string): string {
  return `/judgments/owner-ratification/${encodeURIComponent(encodeId(projectId))}/` +
    encodeURIComponent(encodeId(requestId));
}

export function ownerRatificationDecisionPath(projectId: string): string {
  return ownerRatificationPath(projectId);
}

export function ownerRatificationReferenceKey(reference: OwnerRatificationReference): string {
  return [
    reference.decisionRequestId,
    reference.obligationId,
    reference.obligationRevision,
    reference.contractDigest,
    reference.reasonCode,
    reference.owner,
    reference.ownerId,
    reference.evaluatedThroughWatermark,
  ].join(':');
}
