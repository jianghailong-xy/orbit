import { Prisma } from '@prisma/client';
import type { ProjectPromotionView as SharedPromotionView, PromotionTask } from '@orbit/shared';
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
  upstreamMovedBy: true,
  decidedAt: true,
  mergedSha: true,
  mergedAt: true,
  openItemId: true,
  receiptIds: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type PromotionRow = Prisma.ProjectPromotionGetPayload<{ select: typeof PROMOTION_COLUMNS }>;

/**
 * What the confirmation card is drawn from (§3.6), holding its instants as the `Date`s this side of
 * the wire has them.
 *
 * The shape itself is `@orbit/shared`'s, not a second copy of it: the card in `src/web` and the one
 * in OrbitKit draw the same fields, and §7.0 keeps them in one declaration so a field added for one
 * client cannot go missing in another. The closed sets above stay here, where migration 0285's CHECK
 * constraints are mirrored — if the two ever drift, the assignment below stops compiling.
 */
export type ProjectPromotionView = SharedPromotionView<Date>;

/**
 * M6, said once: a project branch lands as a merge commit so the tasks it carries stay ancestors of
 * the upstream, and a task branch lands as a fast-forward after a rebase (appendix A-Q7).
 */
export function promotionLandsAs(sourceKind: string): 'MERGE_COMMIT' | 'FAST_FORWARD' {
  return sourceKind === 'PROJECT_BRANCH' ? 'MERGE_COMMIT' : 'FAST_FORWARD';
}

/**
 * The middle of a set of durations, in ms, or null for an empty one (§3.6's `typicalMs`).
 *
 * A median rather than a mean because what is being measured is a command on a machine somebody
 * else also uses: one run that queued for forty minutes would move a mean by more than the reader
 * gets out of it. Null rather than zero for no runs at all, because zero claims the work is
 * instant, and "we have not measured one yet" is a different sentence.
 */
export function medianMs(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * The parts of §3.6 that are not columns of the promotion row: what the merge would carry, when the
 * branch last took main in, and the re-check a landing is in the middle of (§3.1 M1, M-T7).
 *
 * Read by the service rather than derived in `promotionView`, because each one is a question about
 * another table — and passed in as one argument so that the two doors onto a candidate (reading the
 * card, and answering it) cannot describe the same merge differently.
 */
export interface PromotionFacts {
  /** What this merge would carry, in `includedTaskIds` order. */
  tasks: PromotionTask[];
  /** When the project branch last absorbed the upstream, or null when it never has. */
  upstreamSyncedAt: Date | null;
  /** The re-check in flight (state B), or null when none is. */
  recheck: { upstreamMovedBy: number | null; startedAt: Date; typicalMs: number | null } | null;
}

export function promotionView(row: PromotionRow, facts: PromotionFacts): ProjectPromotionView {
  return {
    promotionId: row.id,
    state: row.state as PromotionState,
    sourceKind: row.sourceKind as PromotionSourceKind,
    sourceRef: row.sourceRef,
    sourceSha: row.sourceSha,
    upstreamRef: row.upstreamRef,
    commitsAhead: row.commitsAhead,
    filesChanged: row.filesChanged,
    tasks: facts.tasks,
    taskIds: row.includedTaskIds,
    checks: Array.isArray(row.checks) ? (row.checks as unknown as IntegrationCheckResult[]) : [],
    conflicts: row.conflicts,
    // One source for both readings of "did anything conflict": the paths below are the files, this
    // is the answer the card's `main` row gives, and they are derived from the same array.
    upstream: { syncedAt: facts.upstreamSyncedAt, conflicts: row.conflicts.length > 0 },
    upstreamShaChecked: row.upstreamShaChecked,
    landsTreeSha: row.mergeTreeSha,
    landsAs: promotionLandsAs(row.sourceKind),
    askedAt: row.state === 'CHECKING' ? null : row.updatedAt,
    recheckedAt: row.recheckedAt,
    recheck: facts.recheck,
    merged: row.mergedSha && row.mergedAt
      ? { sha: row.mergedSha, byUserId: row.confirmedByUserId, at: row.mergedAt }
      : null,
  };
}
