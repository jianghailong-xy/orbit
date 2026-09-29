import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { RunnerEngineHealth } from '@orbit/shared';
import { SessionsService } from './sessions.service';

/**
 * A runner can hold several Codex accounts, and a workspace picks which one its sessions run on. The
 * New Session screen can also pick one for a single session (Session.codexAccount): stored as picked,
 * read ahead of the workspace's choice wherever the session's run is dispatched — and, at create,
 * by the sign-in preflight, which has to judge the account the session will actually run on. When
 * neither the session nor its workspace picked one, create picks the account Automatic ranks first and
 * stores it, so the session stays there.
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

function makeService(
  workspaceCodexAccount: string | null = null,
  runner: { engines?: unknown; planUsage?: unknown } = {},
  workspaceEnv: Record<string, string> | null = null,
) {
  const creates: Array<Record<string, unknown>> = [];
  const prisma = {
    user: { findUnique: async () => ({ preferences: {} }) },
    workspace: {
      findFirst: async () => ({
        id: 'workspace-1',
        runnerId: 'runner-1',
        enableWorktree: false,
        enabled: true,
        env: workspaceEnv,
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
        engines: runner.engines ?? ENGINES,
        planUsage: runner.planUsage ?? null,
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

test('the account picked for a session is stored as picked, Default included', async () => {
  const fixture = makeService();
  await fixture.service.create('owner-1', { ...CODEX, codexAccount: 'c0ffee42' });
  await fixture.service.create('owner-1', { ...CODEX, codexAccount: 'default' });
  // A slot this runner does not list is still stored: dispatch resolves it against whichever runner
  // runs the session, and one that reports no such account runs it on Default.
  assert.deepEqual(
    fixture.creates.map((data) => data.codexAccount),
    ['c0ffee42', 'default'],
  );
});

/** Both accounts signed in: Default's 5-hour window spent, Work with room. */
const BOTH_IN = [
  ENGINES[0],
  { ...ENGINES[1], accounts: ENGINES[1].accounts!.map((account) => ({ ...account, auth: 'yes' as const })) },
];
const reset = new Date(Date.now() + 2 * 3_600_000).toISOString();
const DEFAULT_SPENT = {
  codex: {
    provider: 'codex',
    primary: { utilization: 100, windowDurationMins: 300, resetsAt: reset },
    accounts: { [WORK]: { provider: 'codex', primary: { utilization: 12, windowDurationMins: 10080, resetsAt: reset } } },
  },
};

test('with no account picked for it or its workspace, a session starts on the one Automatic picks, and keeps it', async () => {
  const fixture = makeService(null, { engines: BOTH_IN, planUsage: DEFAULT_SPENT });
  await fixture.service.create('owner-1', CODEX);
  // Stored on the session: every door after this reads it, so the session stays on Work.
  assert.equal(fixture.creates[0].codexAccount, WORK);
});

test('the automatic choice is only made where nothing else decides the account', async () => {
  const runner = { engines: BOTH_IN, planUsage: DEFAULT_SPENT };
  const created = async (
    fixture: ReturnType<typeof makeService>,
    dto: Record<string, unknown> = {},
  ): Promise<unknown> => {
    await fixture.service.create('owner-1', { ...CODEX, ...dto });
    return fixture.creates.at(-1)?.codexAccount;
  };
  // The session's own pick, and the workspace's, are left to decide it.
  assert.equal(await created(makeService(null, runner), { codexAccount: 'default' }), 'default');
  assert.equal(await created(makeService('default', runner)), null, 'a workspace pinned to Default');
  // A CODEX_HOME typed into the workspace env, or a key of its own, already says where it runs.
  assert.equal(await created(makeService(null, runner, { CODEX_HOME: '/srv/codex' })), null);
  assert.equal(await created(makeService(null, runner, { OPENAI_API_KEY: 'sk-test' })), null);
  // One account is nothing to choose between.
  assert.equal(await created(makeService(null, { engines: [ENGINES[0], { ...ENGINES[1], accounts: [ENGINES[1].accounts![0]] }], planUsage: DEFAULT_SPENT })), null);
  // Only the built-in Codex engine runs on the runner's Codex accounts.
  assert.equal(await created(makeService(null, runner), { provider: 'claude' }), null);
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
