import { encodeId, routeId } from './idCodec';

export interface JudgmentInboxItem {
  inboxItemId: string;
  requestVersion: number;
  deliveredAt: string;
  notificationDeepLink: string;
  requestId: string;
  requestStatus: 'OPEN' | 'DECIDED' | 'SUPERSEDED';
  decision: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  projectId: string | null;
  projectTitle: string | null;
  evidenceId: string;
  evidenceRevision: string;
  evidenceDigest: string;
  submittedAt: string;
  actorType: 'USER' | 'AGENT';
  actorId: string;
  actorName: string | null;
  commit: string | null;
  testSummary: unknown | null;
  isCurrent: boolean;
  pushDelivery: {
    status: string;
    attempts: number;
    lastError: string | null;
    deliveredAt: string | null;
    stoppedAt: string | null;
  } | null;
}

export interface JudgmentInboxPage {
  total: number;
  items: JudgmentInboxItem[];
}

export interface JudgmentRequestView {
  id: string;
  taskId: string;
  evidenceId: string;
  criterionRevision: string;
  evidenceDigest: string;
  kind: 'HUMAN_SIGNOFF';
  recipientType: 'ACCOUNT_OWNER';
  recipientId: string;
  status: 'OPEN' | 'DECIDED' | 'SUPERSEDED';
  createdAt: string;
  decidedAt: string | null;
  decidedByType: string | null;
  decidedById: string | null;
  decision: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null;
  decisionNote: string | null;
  supersededAt: string | null;
  supersededById: string | null;
  signoff: {
    id: string;
    signedById: string;
    signedByName: string;
    signedAt: string;
    evidence: string;
  } | null;
}

export interface JudgmentReview {
  request: JudgmentRequestView;
  requestVersion: number;
  inbox: {
    id: string;
    deliveredAt: string;
    notificationDeepLink: string;
    pushDelivery: JudgmentInboxItem['pushDelivery'];
  };
  reviewState:
    | 'ACTION_REQUIRED'
    | 'AWAITING_NEW_EVIDENCE'
    | 'APPROVED'
    | 'SUPERSEDED'
    | 'DECIDED'
    | 'EVIDENCE_REVISED';
  isCurrent: boolean;
  task: {
    id: string;
    title: string;
    objective: string | null;
    status: string;
    projectId: string | null;
    projectTitle: string | null;
    acceptanceCriteria: string | null;
    completionCriterion: string;
  };
  criterion: unknown;
  evidence: {
    id: string;
    revision: string;
    digest: string;
    submittedAt: string;
    actorType: string;
    actorId: string;
    actorName: string | null;
    sourceSessionId: string;
    sourceAttemptId: string | null;
    structured: unknown;
    commit: string | null;
    testSummary: unknown | null;
  };
  currentEvidence: {
    id: string;
    revision: string;
    digest: string;
    requestId: string | null;
  };
  history: Array<{
    id: string;
    revision: string;
    digest: string;
    submittedAt: string;
    actorType: string;
    actorId: string;
    actorName: string | null;
    criterion: unknown;
    structured: unknown;
    commit: string | null;
    testSummary: unknown | null;
    isCurrentEvidence: boolean;
    requests: JudgmentRequestView[];
  }>;
  derived: {
    taskStatus: string;
    openRequestId: string | null;
    signalOpen: boolean;
    blockerOpen: boolean;
    legacyOpenBlockerCount: number;
    dependencyGraph: {
      nodes: Array<{
        id: string;
        title: string;
        status: string;
        dependencyState: string;
        running?: boolean;
        queued?: boolean;
      }>;
      edges: Array<{ sourceTaskId: string; targetTaskId: string }>;
    };
  };
}

export function judgmentReviewPath(requestId: string): string {
  return `/judgments/${encodeURIComponent(encodeId(requestId))}`;
}

export function judgmentInboxPath(filters: {
  status?: 'OPEN' | 'DECIDED' | 'SUPERSEDED' | 'ALL';
  projectId?: string;
  taskId?: string;
  limit?: number;
} = {}): string {
  const query = new URLSearchParams();
  query.set('status', filters.status ?? 'OPEN');
  if (filters.projectId) query.set('projectId', filters.projectId);
  if (filters.taskId) query.set('taskId', filters.taskId);
  if (filters.limit) query.set('limit', String(filters.limit));
  return `/judgments?${query.toString()}`;
}

/** N12's shipped task deep link -> the one review route that request identity names. */
export function judgmentRequestFromTaskDeepLink(value: string | null): string | null {
  return routeId(value);
}

export function shortDigest(digest: string): string {
  return `${digest.slice(0, 10)}…${digest.slice(-8)}`;
}
