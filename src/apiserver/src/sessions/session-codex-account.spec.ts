import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { RunnerEngineHealth } from '@orbit/shared';
import { SessionsService } from './sessions.service';

/**
 * A runner can hold several Codex accounts, and a workspace picks which one its sessions run on. The
 * New Session screen can also pick one for a single session (Session.codexAccount): stored as picked,
 * read ahead of the workspace's choice wherever the session's run is dispatched — and, at create,
 * by the sign-in preflight, which has to judge the account the session will actually run on.
 */

const WORK = '3fa91c2e';
const WORK_HOME = '/home/dev/.orbit/codex-accounts/3fa91c2e';
const DEFAULT_HOME = '/home/dev/.codex';

/** Codex with two accounts: Default signed in, Work signed out. */
const ENGINES: RunnerEngineHealth[] = [
  { engine: 'claude', installed: true, auth: 'yes' },
  {
    engine: 'codex',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: DEFAULT_HOME, codexHome: DEFAULT_HOME, auth: 'yes' },
      { id: WORK, name: 'Work', home: WORK_HOME, codexHome: WORK_HOME, auth: 'no' },
    ],
  },
];

function makeService(workspaceCodexAccount: string | null = null) {
  const creates: Array<Record<string, unknown>> = [];
  const prisma = {
    user: { findUnique: async () => ({ preferences: {} }) },
    workspace: {
      findFirst: async () => ({
        id: 'workspace-1',
        runnerId: 'runner-1',
        enableWorktree: false,
        enabled: true,
        env: null,
        codexAccount: workspaceCodexAccount,
        claudeAccount: null,
      }),
    },
    $queryRaw: async () => [{ workspace_id: 'workspace-1', provider: 'codex', provider_builtin: true }],
    runner: {
      findFirst: async () => ({
        id: 'runner-1',
        name: 'build-box',
        displayName: null,
        status: 'ONLINE',
        lastHeartbeatAt: new Date(),
        engines: ENGINES,
      }),
    },
    modelProvider: { findFirst: async () => null },
    session: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { id: 'session-1', ...data, endReason: null, completedAt: null, archivedAt: null, deletedAt: null };
      },
    },
  } as never;
  const queue = { notifySessionQueued: () => undefined } as never;
  const realtime = {
    publishSessionCreated: () => undefined,
    publishSessionUpdated: () => undefined,
    publishWorkspaceChanged: () => undefined,
  } as never;
  return { service: new SessionsService(prisma, queue, realtime), creates };
}

const CODEX = { prompt: 'Fix the flaky test', title: 'Fix', workspaceId: 'workspace-1', provider: 'codex' };

test('the account picked for a session is stored as picked, Default included; none follows the workspace', async () => {
  const fixture = makeService();
  await fixture.service.create('owner-1', { ...CODEX, codexAccount: 'c0ffee42' });
  await fixture.service.create('owner-1', { ...CODEX, codexAccount: 'default' });
  await fixture.service.create('owner-1', CODEX);
  // A slot this runner does not list is still stored: dispatch resolves it against whichever runner
  // runs the session, and one that reports no such account runs it on Default.
  assert.deepEqual(
    fixture.creates.map((data) => data.codexAccount),
    ['c0ffee42', 'default', null],
  );
});

test('a picked account is an account id, never a path', async () => {
  const fixture = makeService();
  for (const codexAccount of ['/home/dev/.codex', '../codex-accounts/3fa91c2e', 'Work', '3FA91C2E', '', 42]) {
    await assert.rejects(
      fixture.service.create('owner-1', { ...CODEX, codexAccount: codexAccount as string }),
      (err: unknown) => err instanceof BadRequestException,
      JSON.stringify(codexAccount),
    );
  }
  assert.deepEqual(fixture.creates, [], 'nothing was created for a refused pick');
});

test('the sign-in preflight judges the account picked for the session, not the workspace\'s', async () => {
  // Work is signed out: picking it for this session is refused, naming the account and its sign-in.
  const onDefaultWorkspace = makeService(null);
  await assert.rejects(
    onDefaultWorkspace.service.create('owner-1', { ...CODEX, codexAccount: WORK }),
    (err: unknown) => {
      assert.ok(err instanceof ConflictException);
      assert.match((err as ConflictException).message, /Codex account "Work" is signed out on runner "build-box"/);
      assert.match((err as ConflictException).message, /CODEX_HOME='\/home\/dev\/\.orbit\/codex-accounts\/3fa91c2e' codex login/);
      return true;
    },
  );
  assert.deepEqual(onDefaultWorkspace.creates, []);

  // The workspace is set to the signed-out Work, but this session picked Default, which is signed in.
  const onWorkWorkspace = makeService(WORK);
  await onWorkWorkspace.service.create('owner-1', { ...CODEX, codexAccount: 'default' });
  assert.equal(onWorkWorkspace.creates.length, 1);
  // With no pick of its own the session runs on the workspace's Work, and is refused for it.
  await assert.rejects(onWorkWorkspace.service.create('owner-1', CODEX), ConflictException);
});
