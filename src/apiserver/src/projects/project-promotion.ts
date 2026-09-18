import { Prisma } from '@prisma/client';
import type { IntegrationCheckResult } from './project-integration-job';

/**
 * Promotions: merging a project's finished work into its upstream
 * (`docs/project-integration-line-contract.md` §3).
 *
 * This module is the part with no I/O of its own — the closed sets migration 0285 spells as CHECK
 * constraints, the states a card is drawn from, and the small decisions a reader has to be able to
 * re-derive (which states are live, which accept a confirmation, what a receipt and an item are
 * keyed on). Everything that touches the database is `project-promotion.service.ts`, and everything
 * that touches a repository is `src/runner-go/integrate.go`.
 *
 * ONE THING IS NOT CONFIGURABLE HERE, AND THAT IS THE POINT
 * --------------------------------------------------------
 * M7: there is no "merge automatically" branch. Every promotion is offered to the account owner and
 * waits, whatever the project's line is and however small the change. The owner drew that line on
 * 2026-09-13; relaxing it is a decision of theirs, not a column somebody sets.
 */

/** What is being promoted (§3.2). A MAIN-line project has no branch of its own, so it promotes the
 *  task branch itself (appendix A-Q7). */
export const PROMOTION_SOURCE_KINDS = ['PROJECT_BRANCH', 'TASK_BRANCH'] as const;
export type PromotionSourceKind = (typeof PROMOTION_SOURCE_KINDS)[number];

/**
 * Where a promotion is (§3.3). The four a card is drawn from are READY (A), RECHECKING (B), MERGED
 * (C) and BLOCKED (D); CHECKING is the moment before A, and the last three are how a candidate ends
 * without being merged.
 */
export const PROMOTION_STATES = [
  'CHECKING',
  'READY',
  'CONFIRMED',
  'RECHECKING',
  'MERGED',
  'BLOCKED',
  'DECLINED',
  'CANCELLED',
  'SUPERSEDED',
] as const;
export type PromotionState = (typeof PROMOTION_STATES)[number];

/**
 * The states a promotion is still alive in — the ones the partial unique index covers, so that one
 * source has one candidate. BLOCKED is among them: a conflict is a card somebody still has to deal
 * with, and a second candidate for the same ref while it stands would be two cards about one
 * problem.
 */
export const LIVE_PROMOTION_STATES: ReadonlyArray<PromotionState> = [
  'CHECKING', 'READY', 'CONFIRMED', 'RECHECKING', 'BLOCKED',
];

/** A promotion nothing will move again. */
export function isTerminalPromotionState(state: string): boolean {
  return state === 'MERGED' || state === 'DECLINED' || state === 'CANCELLED' || state === 'SUPERSEDED';
}

/**
 * Whether the owner may confirm this promotion right now, and why not when they may not.
 *
 * READY and nothing else. A BLOCKED promotion is the "有冲突时不可确认" half of §3.3 — its checks did
 * not pass, so there is no verdict for a confirmation to stand on; a CONFIRMED or RECHECKING one is
 * already on its way and a second press would queue a second landing of the same source.
 */
export function promotionConfirmRefusal(state: string): string | null {
  if (state === 'READY') return null;
  if (state === 'BLOCKED') {
    return 'this promotion did not pass its checks, so there is nothing to confirm yet; the '
      + 'conflict or the failing check has to be dealt with first, and the candidate is checked again';
  }
  if (state === 'CHECKING') return 'this promotion is still being checked';
  if (state === 'CONFIRMED' || state === 'RECHECKING') {
    return 'this promotion has already been confirmed and is being merged';
  }
  return `this promotion is ${state.toLowerCase()} and cannot be confirmed`;
}

/** The refusal code every promotion door answers a wrong-state request with (§3.4 M-F3). */
export const PROMOTION_NOT_READY = 'PROMOTION_NOT_READY';
/** The refusal code for a request that is not the account owner's own (§3.4 M-F3). */
export const PROMOTION_OWNER_ONLY = 'PROMOTION_OWNER_ONLY';

/**
 * Why this caller may not decide a promotion, or null for the account owner in the app.
 *
 * The same shape `ownerConfirmationPrincipalRefusal` uses, and for the same reason: an agent holding
 * the owner's credential is still an agent, so the session header is what decides and not whose key
 * signed the request. Asked of nothing but the request, so an agent is refused before a row is read.
 */
export function promotionPrincipalRefusal(
  ownerId: string,
  principal: { userId: string; actingSessionId?: string | null },
): string | null {
  const session = principal.actingSessionId?.trim() ? principal.actingSessionId.trim() : null;
  if (session) {
    return `this request carries the session header of ${session}, so an agent session is making it; `
      + 'merging a project branch into main is confirmed only by the account owner, from the Orbit '
      + 'app with their own sign-in';
  }
  if (principal.userId !== ownerId) {
    return 'this credential does not belong to the account that owns the project';
  }
  return null;
}

/** `pr:v1:<promotionId>` — one approval card per candidate, however often the check is replayed. */
export function promotionDedupeKey(promotionId: string): string {
  return `pr:v1:${promotionId}`;
}

/** What the owner's card is called in a list (§4.2). Built from rows that no longer change. */
export function promotionItemTitle(upstreamRef: string, taskCount: number): string {
  const branch = upstreamRef.startsWith('refs/heads/') ? upstreamRef.slice('refs/heads/'.length) : upstreamRef;
  return taskCount === 1
    ? `Merge 1 task into ${branch}?`
    : `Merge ${taskCount} tasks into ${branch}?`;
}

/** The columns every reader of a promotion needs. Kept here so the service and the read model agree. */
export const PROMOTION_COLUMNS = {
  id: true,
  projectId: true,
  ownerId: true,
  codebaseId: true,
  sourceKind: true,
  taskId: true,
  sessionId: true,
  sourceRef: true,
  sourceSha: true,
  upstreamRef: true,
  upstreamShaChecked: true,
  mergeTreeSha: true,
  includedTaskIds: true,
  commitsAhead: true,
  filesChanged: true,
  checks: true,
  conflicts: true,
  state: true,
  checkJobId: true,
  landJobId: true,
  confirmedByUserId: true,
  confirmedAt: true,
  recheckedAt: true,
  decidedAt: true,
  mergedSha: true,
  mergedAt: true,
  openItemId: true,
  receiptIds: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type PromotionRow = Prisma.ProjectPromotionGetPayload<{ select: typeof PROMOTION_COLUMNS }>;

/** What the confirmation card is drawn from (§3.6). */
export interface ProjectPromotionView {
  promotionId: string;
  state: PromotionState;
  sourceKind: PromotionSourceKind;
  sourceRef: string;
  sourceSha: string;
  upstreamRef: string;
  commitsAhead: number | null;
  filesChanged: number | null;
  taskIds: string[];
  checks: IntegrationCheckResult[];
  conflicts: string[];
  /** Null until a check has passed; after that, the upstream tip that check ran against. */
  upstreamShaChecked: string | null;
  landsAs: 'MERGE_COMMIT' | 'FAST_FORWARD';
  askedAt: Date | null;
  recheckedAt: Date | null;
  merged: { sha: string; byUserId: string | null; at: Date } | null;
}

/**
 * M6, said once: a project branch lands as a merge commit so the tasks it carries stay ancestors of
 * the upstream, and a task branch lands as a fast-forward after a rebase (appendix A-Q7).
 */
export function promotionLandsAs(sourceKind: string): 'MERGE_COMMIT' | 'FAST_FORWARD' {
  return sourceKind === 'PROJECT_BRANCH' ? 'MERGE_COMMIT' : 'FAST_FORWARD';
}

export function promotionView(row: PromotionRow): ProjectPromotionView {
  return {
    promotionId: row.id,
    state: row.state as PromotionState,
    sourceKind: row.sourceKind as PromotionSourceKind,
    sourceRef: row.sourceRef,
    sourceSha: row.sourceSha,
    upstreamRef: row.upstreamRef,
    commitsAhead: row.commitsAhead,
    filesChanged: row.filesChanged,
    taskIds: row.includedTaskIds,
    checks: Array.isArray(row.checks) ? (row.checks as unknown as IntegrationCheckResult[]) : [],
    conflicts: row.conflicts,
    upstreamShaChecked: row.upstreamShaChecked,
    landsAs: promotionLandsAs(row.sourceKind),
    askedAt: row.state === 'CHECKING' ? null : row.updatedAt,
    recheckedAt: row.recheckedAt,
    merged: row.mergedSha && row.mergedAt
      ? { sha: row.mergedSha, byUserId: row.confirmedByUserId, at: row.mergedAt }
      : null,
  };
}
