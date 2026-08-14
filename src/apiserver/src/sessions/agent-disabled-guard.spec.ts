import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { SessionsService } from './sessions.service';

// A disabled workspace takes no new work. The guard lives in create(), which every start path
// funnels through — the composer, a task run, an orchestrated spawn — so these cover all of
// them at the one place the decision is made.

type WorkspaceRow = {
  runnerId?: string | null;
  enableWorktree: boolean;
  permissionMode: string;
  enabled: boolean;
};

function makeService(workspace: WorkspaceRow | null) {
  const prisma = {
    workspace: { findFirst: async () => workspace },
    // Reached only if the guard lets the call through; a null user keeps the effort
    // resolution quiet so the failure below is about routing, not about this stub.
    user: { findUnique: async () => null },
  } as never;
  return new SessionsService(prisma, {} as never, {} as never);
}

const disabled: WorkspaceRow = {
  runnerId: 'runner-1',
  enableWorktree: false,
  permissionMode: 'dontAsk',
  enabled: false,
};

test('a disabled workspace refuses a new session, and says so', async () => {
  const service = makeService(disabled);

  await assert.rejects(
    () => service.create('owner', { prompt: 'work', workspaceId: 'workspace-1' }),
    (e: unknown) => {
      assert.ok(e instanceof ForbiddenException, `expected ForbiddenException, got ${e}`);
      // Distinct from "workspace not found": the workspace is there and its config is intact, which is
      // what tells the caller it can simply be switched back on.
      assert.match(String((e as Error).message), /disabled/i);
      return true;
    },
  );
});

test('the guard also covers the pinned-runner path', async () => {
  const service = makeService({ ...disabled, runnerId: null });

  await assert.rejects(
    () =>
      service.create('owner', {
        prompt: 'work',
        workspaceId: 'workspace-1',
        assignedRunnerId: 'runner-1',
      }),
    (e: unknown) => e instanceof ForbiddenException && /disabled/i.test((e as Error).message),
  );
});

test('an enabled workspace is not stopped by this guard', async () => {
  const service = makeService({ ...disabled, enabled: true });

  // It still fails further down (this stub has no runner/provider machinery behind it), but
  // it must not fail *here* — otherwise the guard would be refusing every workspace.
  await assert.rejects(
    () => service.create('owner', { prompt: 'work', workspaceId: 'workspace-1' }),
    (e: unknown) => !/disabled/i.test(String((e as Error).message)),
  );
});

test('a missing workspace still reads as not found, not as disabled', async () => {
  const service = makeService(null);

  await assert.rejects(
    () => service.create('owner', { prompt: 'work', workspaceId: 'workspace-1' }),
    (e: unknown) => /not found/i.test(String((e as Error).message)),
  );
});
