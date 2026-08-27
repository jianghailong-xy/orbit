import { encodeId } from './idCodec';

export type ProjectAcceptanceVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface ProjectAcceptanceInboxItem {
  runId: string;
  projectId: string;
  projectTitle: string;
  projectStatus: string;
  attempt: string;
  startedAt: string;
  criterionCount: number;
  answeredCount: number;
  unansweredCount: number;
  currentVerdict: 'UNDECIDED';
}

export interface ProjectAcceptanceInboxPage {
  total: number;
  items: ProjectAcceptanceInboxItem[];
}

export interface ProjectAcceptanceCriterion {
  id: string;
  ordinal: number;
  criterionKey: string;
  criterionId: string | null;
  definitionRevision: number | null;
  criterionText: string;
  verificationMethod: string | null;
  verdict: ProjectAcceptanceVerdict | null;
  summary: string | null;
  evidence: unknown;
  evidenceTaskId: string | null;
  evidenceSessionId: string | null;
  decidedAt: string | null;
}

export interface ProjectAcceptanceRun {
  id: string;
  projectId: string;
  attempt: string;
  evidenceVersion: string;
  acceptanceEpoch: string;
  verdict: ProjectAcceptanceVerdict | null;
  decidedBy: string;
  inputDigest: string;
  resultDigest: string | null;
  supersededAt: string | null;
  supersededReason: string | null;
  startedAt: string;
  completedAt: string | null;
  criteria: ProjectAcceptanceCriterion[];
  conclusions: unknown[];
}

export interface ProjectAcceptanceOverview {
  projectId: string;
  projectTitle: string;
  status: string;
  criteria: Array<{
    ordinal: number;
    criterionId: string | null;
    criterionKey: string;
    criterionText: string;
    verificationMethod: string | null;
  }>;
  acceptanceDigest: string;
  runs: ProjectAcceptanceRun[];
  runsEmptyReason: string | null;
  audit: unknown[];
}

export interface ProjectAcceptanceCriterionDecision {
  ordinal: number;
  criterionId?: string;
  criterionKey: string;
  verdict: ProjectAcceptanceVerdict;
  summary?: string;
  evidence?: {
    command?: string;
    exitCode?: number;
  };
  evidenceTaskId?: string;
  evidenceSessionId?: string;
}

export function projectAcceptanceInboxPath(limit = 100): string {
  return `/projects/acceptance/pending?limit=${limit}`;
}

export function projectAcceptanceReviewPath(projectId: string, runId: string): string {
  return `/judgments/project-acceptance/${encodeURIComponent(encodeId(projectId))}/${encodeURIComponent(encodeId(runId))}`;
}

export function projectAcceptanceOverviewPath(projectId: string): string {
  return `/projects/${encodeURIComponent(encodeId(projectId))}/acceptance?limit=100`;
}

export function projectAcceptanceVerdictPath(projectId: string, runId: string): string {
  return `/projects/${encodeURIComponent(encodeId(projectId))}/acceptance/runs/${encodeURIComponent(encodeId(runId))}/verdict`;
}
