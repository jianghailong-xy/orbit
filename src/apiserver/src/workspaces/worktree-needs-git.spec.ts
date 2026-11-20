import assert from 'node:assert/strict';
import { test } from 'node:test';
import { worktreeNeedsGit, type WorktreeGitCurrent } from './worktree-needs-git';

const base: WorktreeGitCurrent = {
  name: 'orbit-cloud', workDir: '/home/orbit/orbit', workDirIsGit: false, repoUrl: null, autoInitGit: false, enableWorktree: false,
};

test('refuses turning isolation on in a directory known not to be git', () => {
  const err = worktreeNeedsGit(base, { enableWorktree: true });
  assert.equal((err?.getResponse() as { code: string }).code, 'WORKTREE_NEEDS_GIT');
  assert.match(err!.message, /orbit-cloud.*\/home\/orbit\/orbit.*not a git repository/);
});
test('allows when git, never probed, or turning off', () => {
  assert.equal(worktreeNeedsGit({ ...base, workDirIsGit: true }, { enableWorktree: true }), null);
  assert.equal(worktreeNeedsGit({ ...base, workDirIsGit: null }, { enableWorktree: true }), null);
  assert.equal(worktreeNeedsGit({ ...base, enableWorktree: true }, { enableWorktree: false }), null);
});
test('allows when the same write moves workDir, or git will exist', () => {
  assert.equal(worktreeNeedsGit(base, { enableWorktree: true, workDir: '/srv/other' }), null);
  assert.equal(worktreeNeedsGit({ ...base, repoUrl: 'https://github.com/o/r' }, { enableWorktree: true }), null);
  assert.equal(worktreeNeedsGit({ ...base, autoInitGit: true }, { enableWorktree: true }), null);
  assert.equal(worktreeNeedsGit(base, { enableWorktree: true, autoInitGit: true }), null);
});
test('a workDir resubmitted unchanged does not count as a move', () => {
  assert.ok(worktreeNeedsGit(base, { enableWorktree: true, workDir: '/home/orbit/orbit' }));
});
test('refuses clearing autoInitGit while isolation is on and git is absent; leaves unrelated writes alone', () => {
  assert.ok(worktreeNeedsGit({ ...base, enableWorktree: true, autoInitGit: true }, { autoInitGit: false }));
  assert.equal(worktreeNeedsGit({ ...base, enableWorktree: true }, {}), null);
});
