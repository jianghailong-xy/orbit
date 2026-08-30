import { encodeId } from './idCodec';
import type { OwnerRatificationEligibility } from './ownerRatification';

export type OutcomeDecisionType = 'OWNER_RATIFICATION' | 'HUMAN_SIGNOFF'
  | 'GOAL_DECISION' | 'RISK_ACCEPTANCE' | 'NEW_AUTHORIZATION' | 'EXTERNAL_IDENTITY';

export interface HumanDecisionProtocol {
  decisionType: OutcomeDecisionType;
  agentWorkCompleted: unknown[];
  whyNotAgent: string;
  options: unknown[];
  impacts: unknown[];
  recommendation: unknown;
  cost: unknown;
  deadline: unknown;
  noActionConsequence: unknown;
  resumeBehavior: unknown;
}

export interface OutcomeSemanticObligation {
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  binding: Record<string, unknown>;
  owner: string;
  kind: string;
  capability: string;
  reason: Record<string, unknown>;
  evaluatedThroughLogicalTime: string;
  projectionRevision: string;
}

export interface OutcomeCta {
  kind: 'EXECUTE' | 'DECIDE' | 'VIEW';
  href: string;
  binding: Record<string, unknown>;
}

export interface CanonicalOwnerInboxItem {
  projectId: string;
  projectTitle: string;
  semantic: OutcomeSemanticObligation;
  decision: HumanDecisionProtocol;
  cta: OutcomeCta | null;
  decisionRequest: Record<string, unknown> | null;
  ctaUnavailableReason: string | null;
}

export interface RatificationInboxItem {
  decisionType: 'OWNER_RATIFICATION';
  projectId: string;
  projectTitle: string;
  requestId: string;
  requestRevision: string;
  contractDigest: string;
  reasonCode: string;
  reason: string;
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  evaluatedThroughWatermark: string;
  eligibility: OwnerRatificationEligibility;
  semanticDiff: unknown;
  protocol: HumanDecisionProtocol;
  cta: OutcomeCta;
}

export interface OutcomeHumanInbox {
  schemaVersion: 2;
  surface: 'HUMAN_DECISION_INBOX';
  actor: 'OWNER';
  total: number;
  items: Array<CanonicalOwnerInboxItem | RatificationInboxItem>;
}

export interface OutcomeDecisionView {
  projectId: string;
  canonicalIdentity: Record<string, unknown>;
  semantic: OutcomeSemanticObligation;
  decision: HumanDecisionProtocol;
  cta: OutcomeCta | null;
  decisionRequest: Record<string, unknown> | null;
  ctaUnavailableReason: string | null;
}

export interface OwnerRatificationView {
  decisionType: 'OWNER_RATIFICATION';
  contractDigest: string;
  contractRevision: string;
  evaluationPlanDigest: string;
  ratified: boolean;
  semanticContract: unknown;
  decisionRequest: null | {
    id: string;
    requestRevision: string;
    status: string;
    expiresAt: string;
    reasonCode: string;
    semanticDiff: unknown;
    protocol: HumanDecisionProtocol;
  };
}

/** Web may choose labels and CTA layout, but it must never reinterpret this tuple. */
export function outcomeSemanticTuple(item: { semantic: OutcomeSemanticObligation }) {
  return {
    obligationId: item.semantic.obligationId,
    obligationRevision: item.semantic.obligationRevision,
    bindingDigest: item.semantic.bindingDigest,
    binding: item.semantic.binding,
    reason: item.semantic.reason,
    owner: item.semantic.owner,
    evaluatedThroughLogicalTime: item.semantic.evaluatedThroughLogicalTime,
    projectionRevision: item.semantic.projectionRevision,
  };
}

export const outcomeInboxPath = (limit = 100) => `/outcomes/inbox?limit=${limit}`;
export const outcomeDecisionPath = (requestId: string) =>
  `/outcomes/decisions/${encodeURIComponent(encodeId(requestId))}`;
export const outcomeDecisionReviewPath = (requestId: string) =>
  `/judgments/outcome/${encodeURIComponent(encodeId(requestId))}`;
export const ownerRatificationPath = (projectId: string) =>
  `/outcomes/ratifications/projects/${encodeURIComponent(encodeId(projectId))}`;
export const ownerRatificationReviewPath = (projectId: string) =>
  `/judgments/owner-ratification/${encodeURIComponent(encodeId(projectId))}`;
export const ownerRatificationDecisionPath = (requestId: string) =>
  `/outcomes/ratifications/${encodeURIComponent(encodeId(requestId))}`;

export function isRatificationInboxItem(
  item: CanonicalOwnerInboxItem | RatificationInboxItem,
): item is RatificationInboxItem {
  return 'decisionType' in item && item.decisionType === 'OWNER_RATIFICATION';
}
