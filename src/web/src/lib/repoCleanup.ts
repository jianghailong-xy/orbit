/**
 * What repairing a stuck checkout (POST /workspaces/:id/repo-cleanup) asks before it runs, and says
 * once it is queued. Two doors lead to it — a session's merge bar and its runner's Needs Attention
 * card — and both say the same thing about what is kept and what is undone.
 */
export function repoCleanupConfirm(root: string) {
  return {
    title: 'Clean up this checkout?',
    content:
      `Orbit will save everything ${root} currently holds — uncommitted edits, conflict markers,` +
      ' untracked files — to a new orbit/rescue-… branch, then return the checkout to its last' +
      ' commit so merges work again. Nothing is discarded, and the rescue branch is never deleted.',
    okText: 'Save and clean up',
  };
}

/** Async like every runner-side action: the runner does it on its next heartbeat. */
export const REPO_CLEANUP_QUEUED =
  'Cleaning up the checkout — the runner picks this up on its next heartbeat.';
