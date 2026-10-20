/** Recovery travels on the existing fenced merge operation. Old clients keep reading message. */
export const SESSION_MERGE_RECOVERY_V1 = 'session-merge-recovery-v1';
/** `confirm-landed` is the owner's Done on an ALREADY_LANDED check (see mergeRecoveryConfirmable). The server
 *  records the session merged by itself and no runner is sent anything; clients that predate it never offer it. */
export type MergeRecoveryAction = 'preview' | 'apply' | 'sync-local' | 'confirm-landed';
export interface MergeRecoveryCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
  /** Two or more parents. Absent from runners that predate it. */
  merge?: boolean;
}
export interface MergeRecovery {
  /** ALREADY_LANDED: every one of this session's own commits (the non-merge commits since its fork point)
   *  is already on origin/<target> — as itself, or as a commit with the same `git patch-id --stable`, such
   *  as a rebase copy or a cherry-pick. Nothing was pushed, no branch moved and there is no candidate; the
   *  local target's own commits are not part of this session. Clients that predate it show their generic title. */
  code: string;
  targetBranch: string;
  repoRoot?: string;
  previewId?: string;
  sourceSha?: string;
  localSha?: string;
  remoteSha?: string;
  candidateSha?: string;
  candidateTreeSha?: string;
  rebaseBaseSha?: string;
  repairBranch?: string;
  repairWorktree?: string;
  phase?: 'TARGET_SYNC' | 'SOURCE_REPLAY';
  conflicts?: string[];
  localCommits?: MergeRecoveryCommit[];
  remoteCommits?: MergeRecoveryCommit[];
  /** Exactly what the push adds to origin/<target>, newest first. Absent from older runners and past the commit cap. */
  pushCommits?: MergeRecoveryCommit[];
  /** ALREADY_LANDED: the commit on origin/<target> carrying each of this session's commits (sourceSha), newest
   *  first. Its date is when it was committed onto origin — for a rebase copy, when it merged. */
  landedCommits?: Array<MergeRecoveryCommit & { sourceSha: string }>;
  patch?: string;
  addsMergeCommit?: boolean;
  checkedAt?: string;
  check?: { status: 'passed' | 'failed' | 'unconfigured'; output?: string; command?: string; timeoutSeconds?: number };
}

export function readMergeRecovery(value: unknown): MergeRecovery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as MergeRecovery;
  if (typeof r.code !== 'string' || typeof r.targetBranch !== 'string') return null;
  for (const key of ['repoRoot', 'previewId', 'sourceSha', 'localSha', 'remoteSha', 'candidateSha',
    'candidateTreeSha', 'rebaseBaseSha', 'repairBranch', 'repairWorktree', 'phase', 'patch', 'checkedAt'] as const) {
    if (r[key] !== undefined && typeof r[key] !== 'string') return null;
  }
  if (r.conflicts !== undefined && (!Array.isArray(r.conflicts) || !r.conflicts.every((p) => typeof p === 'string'))) return null;
  for (const commits of [r.localCommits, r.remoteCommits, r.pushCommits, r.landedCommits]) {
    if (commits !== undefined && (!Array.isArray(commits) || !commits.every((c) => c &&
      ['sha', 'subject', 'author', 'date'].every((k) => typeof c[k as keyof MergeRecoveryCommit] === 'string') &&
      (c.merge === undefined || typeof c.merge === 'boolean')))) return null;
  }
  if (r.landedCommits !== undefined && !r.landedCommits.every((c) => typeof c.sourceSha === 'string')) return null;
  if (r.addsMergeCommit !== undefined && typeof r.addsMergeCommit !== 'boolean') return null;
  if (r.check !== undefined && (!r.check || !['passed', 'failed', 'unconfigured'].includes(r.check.status) ||
      (r.check.output !== undefined && typeof r.check.output !== 'string') ||
      (r.check.command !== undefined && typeof r.check.command !== 'string') ||
      (r.check.timeoutSeconds !== undefined && typeof r.check.timeoutSeconds !== 'number'))) return null;
  return r;
}

/** A diagnostic or conflict is never an authorization to push a candidate. */
export function mergeRecoveryReady(r: MergeRecovery | null | undefined): boolean {
  return !!r && r.code === 'READY' && !!r.previewId &&
    [r.sourceSha, r.localSha, r.remoteSha, r.candidateSha, r.candidateTreeSha]
      .every((sha) => typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha)) &&
    typeof r.patch === 'string' && ['passed', 'unconfigured'].includes(r.check?.status ?? '');
}

/** Whether Done (`confirm-landed`) may close this recovery: a check that found every one of the session's commits
 *  already on origin, naming the source it checked and the previewId it was stored under. The runner mints no
 *  previewId for this result; the server gives it one when it stores it. */
export function mergeRecoveryConfirmable(r: MergeRecovery | null | undefined): boolean {
  return !!r && r.code === 'ALREADY_LANDED' && !!r.previewId &&
    typeof r.sourceSha === 'string' && /^[0-9a-f]{40}$/.test(r.sourceSha);
}

/** Where a commit the push adds comes from. Local-only first: an unpublished local merge is still unpublished. */
export function mergeRecoveryCommitOrigin(r: MergeRecovery, c: MergeRecoveryCommit): 'local' | 'merge' | 'session' {
  if (r.localCommits?.some((l) => l.sha === c.sha)) return 'local';
  return c.merge ? 'merge' : 'session';
}

/** Local target against origin/target, once a check has listed both sides. The runner leaves an empty
 *  list out, so two absent lists only mean "same" when the tips agree; otherwise they went unread. */
export function mergeRecoveryTargetRelation(r: MergeRecovery): { ahead: number; behind: number } | null {
  if (!r.localSha || !r.remoteSha) return null;
  if (r.localSha === r.remoteSha) return { ahead: 0, behind: 0 };
  if (!r.localCommits && !r.remoteCommits) return null;
  return { ahead: r.localCommits?.length ?? 0, behind: r.remoteCommits?.length ?? 0 };
}

/** Used by clients handing a conflict or a rejected target push to a coding session. */
export function mergeRecoveryPrompt(r: MergeRecovery, preparePr = false): string {
  return `${preparePr ? 'Prepare a reviewable PR candidate' : 'Resolve this merge recovery'} for ${r.targetBranch}.\n\n` +
    `Repository: ${r.repoRoot ?? 'see the workspace configuration'}\n` +
    `Repair branch: ${r.repairBranch ?? 'create a separate repair branch'}\n` +
    `Repair worktree: ${r.repairWorktree ?? 'use a separate worktree'}\n` +
    `Frozen source: ${r.sourceSha ?? 'unknown'}\nLocal target: ${r.localSha ?? 'unknown'}\n` +
    `Remote target: ${r.remoteSha ?? 'unknown'}\nPhase: ${r.phase ?? r.code}\n` +
    `Conflicting files: ${(r.conflicts ?? []).join(', ') || 'see the diagnostic'}\n\n` +
    repairInstructions(preparePr);
}

/** The next step of the same recovery, for the repair session already working on it: where the recovery stands
 *  now, so the session goes on from its own context. A repair left unfinished lists its unresolved files. */
export function mergeRecoveryContinuePrompt(r: MergeRecovery, preparePr = false): string {
  return `This is the next step of the same merge recovery for ${r.targetBranch}: ` +
    `${preparePr ? 'prepare a reviewable PR candidate from the repair' : 'continue the repair'}. Here is where it stands now.\n\n` +
    `Check result: ${r.code}\nPhase: ${r.phase ?? r.code}\n` +
    `${r.code === 'REPAIR_IN_PROGRESS' ? 'Unresolved files' : 'Conflicting files'}: ` +
    `${(r.conflicts ?? []).join(', ') || 'see the diagnostic'}\n` +
    `Repair branch: ${r.repairBranch ?? 'the one you have been repairing on'}\n` +
    `Repair worktree: ${r.repairWorktree ?? 'the one you have been repairing in'}\n` +
    `Repository: ${r.repoRoot ?? 'see the workspace configuration'}\n` +
    `Frozen source: ${r.sourceSha ?? 'unknown'}\nLocal target: ${r.localSha ?? 'unknown'}\n` +
    `Remote target: ${r.remoteSha ?? 'unknown'}\n\n` +
    repairInstructions(preparePr);
}

/** What every message to a repair session asks of it, the first one and each that continues it. */
function repairInstructions(preparePr: boolean): string {
  return 'Work only in the separate repair worktree. ' +
    (preparePr ? 'Preserve both sides’ content; organize commits on a separate PR candidate according to repository policy. Preserve the original source branch. '
      : 'Preserve both target histories and the original source branch. ') +
    'Finish the pending merge/rebase there, resolving every conflict, and run the repository checks. ' +
    'Commit the resolution in the repair worktree: Orbit reads anything left uncommitted there as an unfinished repair. ' +
    'Do not reset or rebase the shared target checkout. Do not push the target. ' +
    (preparePr ? 'Respect required linear history and branch protection. Prepare a candidate branch and complete diff for review; do not claim it is merged. ' : '') +
    'Report the repair branch and checks when finished. ' +
    'When this turn ends, Orbit checks the recovery again by itself, so there is no need to ask for a check. ' +
    'If the repair needs a decision from the owner, ask the owner directly in this conversation. ' +
    'The owner reviews the complete diff before any target push.';
}
