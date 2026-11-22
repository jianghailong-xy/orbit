import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceWriteCardInput } from './runner-workspace-approval';

const WORKSPACE_ID = '0190f3a2-7b1c-7d4e-9f00-000000000001';

/** Just what workspaceWriteCardInput reads: the owner's switch and one workspace. */
function db(workspace: Record<string, unknown>) {
  return {
    user: { findUniqueOrThrow: async () => ({ preferences: {} }) },
    runner: { findFirst: async () => null },
    workspace: { findFirst: async () => ({ id: WORKSPACE_ID, name: 'orbit-cloud', workDir: '/home/orbit/orbit', env: {},
      runner: { id: 'r', name: 'Orbit Cloud', displayName: null }, repoUrl: null, autoInitGit: false, enableWorktree: false,
      ...workspace }) },
    approval: {},
  } as never;
}

const ask = (workspace: Record<string, unknown>, write: Record<string, unknown>) =>
  workspaceWriteCardInput(db(workspace), { ownerId: 'o', runnerId: 'r' }, 'orbit_agent_update', WORKSPACE_ID, write as never);

test('turning worktrees on in a folder known not to be a git repository is refused before its card is filed', async () => {
  await assert.rejects(ask({ workDirIsGit: false }, { enableWorktree: true }), (error: { getResponse(): { code?: string } }) => {
    assert.equal(error.getResponse().code, 'WORKTREE_NEEDS_GIT');
    return true;
  });
});

test('a folder that is a repository, or was never probed, gets its card', async () => {
  for (const workDirIsGit of [true, null]) {
    const card = await ask({ workDirIsGit }, { enableWorktree: true });
    assert.equal(card.agentId, WORKSPACE_ID);
  }
});

test('turning worktrees off is asked about even in a folder that is not a repository', async () => {
  const card = await ask({ workDirIsGit: false, enableWorktree: true }, { enableWorktree: false });
  assert.equal(card.agentId, WORKSPACE_ID);
});
