/** Recovery travels on the existing fenced merge operation. Old clients keep reading message. */
export const SESSION_MERGE_RECOVERY_V1 = 'session-merge-recovery-v1';
export type MergeRecoveryAction = 'preview' | 'apply' | 'sync-local';
export interface MergeRecoveryCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
  /** Two or more parents. Absent from runners that predate it. */
  merge?: boolean;
}
export interface MergeRecovery {
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
  for (const commits of [r.localCommits, r.remoteCommits, r.pushCommits]) {
    if (commits !== undefined && (!Array.isArray(commits) || !commits.every((c) => c &&
      ['sha', 'subject', 'author', 'date'].every((k) => typeof c[k as keyof MergeRecoveryCommit] === 'string') &&
      (c.merge === undefined || typeof c.merge === 'boolean')))) return null;
  }
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
    'Work only in the separate repair worktree. ' +
    (preparePr ? 'Preserve both sides’ content; organize commits on a separate PR candidate according to repository policy. Preserve the original source branch. '
      : 'Preserve both target histories and the original source branch. ') +
    'Finish the pending merge/rebase there, resolving every conflict, and run the repository checks. ' +
    'Do not reset or rebase the shared target checkout. Do not push the target. ' +
    (preparePr ? 'Respect required linear history and branch protection. Prepare a candidate branch and complete diff for review; do not claim it is merged. ' : '') +
    'Report the repair branch and checks when finished. The owner will check the recovery again and review its complete diff before any target push.';
}
