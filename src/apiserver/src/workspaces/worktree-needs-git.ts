import { ConflictException } from '@nestjs/common';

/** What a workspace write is judged against: the row as it stands, and what the write sets. */
export interface WorktreeGitCurrent {
  name: string;
  workDir: string | null;
  workDirIsGit: boolean | null;
  repoUrl: string | null;
  autoInitGit: boolean;
  enableWorktree: boolean;
}
export interface WorktreeGitPatch {
  enableWorktree?: boolean;
  workDir?: string | null;
  repoUrl?: string | null;
  autoInitGit?: boolean;
}

/**
 * The refusal for a write that would leave worktree isolation on in a work directory the runner has
 * found not to be a git repository, or null when the write may go ahead. Unknown is not "no": a
 * directory never probed (`workDirIsGit` null) is let through, and so is one this same write moves
 * (the probe was of the old path). A cloned workspace, or one with `autoInitGit`, gets its repository.
 * Only a write that leaves the setting on is judged: turning it off is always allowed.
 */
export function worktreeNeedsGit(current: WorktreeGitCurrent, patch: WorktreeGitPatch): ConflictException | null {
  const enable = patch.enableWorktree ?? current.enableWorktree;
  if (!enable) return null;
  // Already on and untouched by this write: another field's PATCH must not be refused for it.
  if (patch.enableWorktree === undefined && patch.workDir === undefined && patch.autoInitGit === undefined && patch.repoUrl === undefined) {
    return null;
  }
  if (patch.workDir !== undefined && (patch.workDir ?? '') !== (current.workDir ?? '')) return null;
  if (current.workDirIsGit !== false) return null;
  if ((patch.repoUrl ?? current.repoUrl ?? '').trim() !== '') return null;
  if (patch.autoInitGit ?? current.autoInitGit) return null;
  return new ConflictException({
    statusCode: 409,
    code: 'WORKTREE_NEEDS_GIT',
    message:
      `${current.name}'s work directory ${current.workDir ?? ''} is not a git repository, so worktree isolation cannot be turned on there. ` +
      'Initialize git in that directory first (Initialize git… on the agent\'s shared-folder notice, which sets autoInitGit), or leave isolation off.',
  });
}
