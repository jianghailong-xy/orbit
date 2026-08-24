import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { SessionsService } from './sessions.service';

/**
 * A workspace whose checkout is not on its machine yet takes no session.
 *
 * The alternative is what this exists to prevent: the workspace looks usable, the session starts,
 * and the runtime dies with ENOENT and an absolute path on a machine the user cannot see. The
 * guard sits in create(), which every start path funnels through — composer, task run, MCP spawn.
 */

type WorkspaceRow = {
  runnerId?: string | null;
  enableWorktree: boolean;
  enabled: boolean;
  provisionState: string;
};

function makeService(workspace: WorkspaceRow) {
  const prisma = {
    workspace: { findFirst: async () => workspace },
    user: { findUnique: async () => null },
  } as never;
  return new SessionsService(prisma, {} as never, {} as never);
}

const cloning: WorkspaceRow = {
  runnerId: 'runner-1',
  enableWorktree: false,
  enabled: true,
  provisionState: 'CLONING',
};

test('a workspace that is still cloning refuses a session, and says that is why', async () => {
  const service = makeService(cloning);

  await assert.rejects(
    () => service.create('owner', { prompt: 'work', workspaceId: 'workspace-1' }),
    (e: unknown) => {
      assert.ok(e instanceof ForbiddenException, `expected ForbiddenException, got ${e}`);
      const message = String((e as Error).message);
      assert.match(message, /still cloning/i);
      // Names the actual consequence rather than a generic refusal: the directory is not there yet.
      assert.match(message, /working directory/i);
      return true;
    },
  );
});

test('the refusal also covers the pinned-runner path', async () => {
  const service = makeService({ ...cloning, runnerId: null });

  await assert.rejects(
    () =>
      service.create('owner', {
        prompt: 'work',
        workspaceId: 'workspace-1',
        assignedRunnerId: 'runner-1',
      }),
    (e: unknown) => e instanceof ForbiddenException && /still cloning/i.test((e as Error).message),
  );
});

// A failed clone has no directory either, and the exits from it are not "start a session".
test('a workspace whose clone failed refuses too, and points at the ways out', async () => {
  const service = makeService({ ...cloning, provisionState: 'FAILED' });

  await assert.rejects(
    () => service.create('owner', { prompt: 'work', workspaceId: 'workspace-1' }),
    (e: unknown) => {
      const message = String((e as Error).message);
      assert.match(message, /clone failed/i);
      assert.match(message, /retry/i);
      return true;
    },
  );
});

test('a provisioned workspace is not stopped by this guard', async () => {
  const service = makeService({ ...cloning, provisionState: 'READY' });

  // It still fails further down (this stub has no runner/provider machinery behind it), but it
  // must not fail *here* — otherwise the guard would be refusing every workspace.
  await assert.rejects(
    () => service.create('owner', { prompt: 'work', workspaceId: 'workspace-1' }),
    (e: unknown) => !/cloning|clone failed/i.test(String((e as Error).message)),
  );
});

// The stored column is NOT NULL with a READY default, so this is about the read paths that select
// a subset of columns rather than about a row that could really be missing one.
test('a row read without the column is not treated as unprovisioned', async () => {
  const service = makeService({ runnerId: 'runner-1', enableWorktree: false, enabled: true } as never);

  await assert.rejects(
    () => service.create('owner', { prompt: 'work', workspaceId: 'workspace-1' }),
    (e: unknown) => !/cloning|clone failed/i.test(String((e as Error).message)),
  );
});
