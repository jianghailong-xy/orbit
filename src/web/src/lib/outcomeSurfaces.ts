import type { CanonicalFailureCoordination } from './failureCoordination';

export type OutcomeDecisionType = 'EVIDENCE_JUDGMENT'
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

export interface FailureOwnerInboxItem extends CanonicalFailureCoordination {
  itemType: 'FAILURE_CONTINUATION_OWNER_DECISION';
  decisionType: 'FAILURE_CONTINUATION_OWNER_DECISION';
  projectTitle: string;
}

export interface OutcomeHumanInbox {
  schemaVersion: 2;
  surface: 'HUMAN_DECISION_INBOX';
  actor: 'OWNER';
  total: number;
  items: Array<CanonicalOwnerInboxItem | FailureOwnerInboxItem>;
  failureContinuationIndex?: Array<{
    obligationId: string;
    obligationRevision: string;
    bindingDigest: string;
    binding: Record<string, unknown>;
    reason: Record<string, unknown>;
  }>;
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
export function isFailureOwnerInboxItem(
  item: CanonicalOwnerInboxItem | FailureOwnerInboxItem,
): item is FailureOwnerInboxItem {
  return 'itemType' in item && item.itemType === 'FAILURE_CONTINUATION_OWNER_DECISION';
}
