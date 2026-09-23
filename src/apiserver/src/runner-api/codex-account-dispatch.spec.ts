import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException, ValidationPipe } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import {
  AgentProvider,
  PermissionMode,
  codexResetAccountOverride,
  type AgentExecConfig,
  type ClaimedSession,
  type RunnerEngineHealth,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../providers/provider-crypto';
import { QueueService } from '../queue/queue.service';
import { CodexRateLimitResetService } from '../runners/codex-rate-limit-reset.service';
import { CreateWorkspaceDto, UpdateWorkspaceDto } from '../workspaces/dto';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { RunnerApiController } from './runner-api.controller';

/**
 * The Codex account a workspace picked is the account its sessions run on.
 *
 * A runner can hold several Codex accounts, each a CODEX_HOME: Default is the one its own
 * environment selects, every other one a slot it added and reports in its heartbeat. The workspace
 * stores the slot's id; dispatch resolves it against what the assigned runner reported and injects
 * that slot's CODEX_HOME into the session's environment, which is all the runner needs to run the
 * app-server — and its SQLite state partition — in that slot.
 *
 * A session reaches a runner through more than one door: the claim that starts it, the reclaim a
 * restarted runner rebuilds it from, and the reload a provider switch re-spawns it with. Each door
 * resolves the session's exec on its own, so each is driven here with the same rows and has to
 * land on the same account — a door that forgot would re-spawn the conversation somewhere else.
 */

const OWNER = '22222222-2222-4222-8222-222222222222';
const RUNNER_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const LEASE_OWNER = '55555555-5555-4555-8555-555555555555';

const WORK = '3fa91c2e';
const WORK_HOME = '/home/dev/.orbit/codex-accounts/3fa91c2e';
const DEFAULT_HOME = '/home/dev/.codex';

/** What the runner reported: Codex with two accounts, Default and Work. */
const ENGINES: RunnerEngineHealth[] = [
  { engine: 'claude', installed: true, auth: 'yes', version: '2.1.278' },
  {
    engine: 'codex',
    installed: true,
    auth: 'yes',
    version: '0.156.0',
    accounts: [
      { id: 'default', codexHome: DEFAULT_HOME, auth: 'yes' },
      { id: WORK, name: 'Work', codexHome: WORK_HOME, auth: 'yes' },
    ],
  },
];

interface Scenario {
  /** The workspace's choice (Workspace.codexAccount). */
  codexAccount?: string | null;
  /** What the assigned runner reported (Runner.engines). */
  engines?: unknown;
  /** The session's provider identity; a configured slug also needs `customRow`. */
  provider?: string;
  providerBuiltin?: boolean;
  customRow?: Record<string, unknown> | null;
  /** The workspace's own environment variables. */
  env?: Record<string, string> | null;
}

function sessionRow(s: Scenario) {
  const provider = s.provider ?? AgentProvider.CODEX;
  return {
    id: SESSION_ID,
    ownerId: OWNER,
    status: RunStatus.RUNNING,
    provider,
    providerBuiltin: s.providerBuiltin ?? true,
    // An explicit model, so nothing is materialized and every door resolves the same pin.
    model: provider === AgentProvider.CLAUDE ? 'claude-opus-5' : 'gpt-5.5',
    permissionMode: PermissionMode.DEFAULT,
    usesRuntimeDefaultModel: true,
    effort: null,
    fastMode: false,
    numTurns: 1,
    title: 'a codex session',
    prompt: 'hello',
    runtimeSessionId: 'thread-1',
    inboxLeaseOwner: LEASE_OWNER,
    branch: null,
    mergeTarget: null,
    workspaceId: WORKSPACE_ID,
    taskId: null,
    contextTaskId: null,
    importedAt: null,
    importSourceCwd: null,
    spawnDepth: 0,
    sourceCodebaseId: null,
    sourceState: null,
    cancelRequestedAt: null,
    deletedAt: null,
    assignedRunnerId: RUNNER_ID,
    assignedRunner: {
      runtimeDefaultModels: null,
      modelCatalog: null,
      runsAsRoot: false,
      engines: s.engines === undefined ? ENGINES : s.engines,
    },
    owner: { preferences: {} },
    workspace: {
      id: WORKSPACE_ID,
      model: null,
      env: s.env ?? null,
      codexAccount: s.codexAccount ?? null,
      workDir: '/srv/repo',
      autoInitGit: false,
      defaultMergeTarget: null,
      enableOrchestration: false,
      appendSystemPrompt: null,
      systemPrompt: null,
      disallowedTools: [],
      effort: null,
      permissionRules: [],
      deletedAt: null,
    },
  };
}

/** The prisma a door reads the rows above through. No write is expected: the model is pinned. */
function prismaFor(s: Scenario) {
  const row = sessionRow(s);
  const tx = {
    $queryRaw: async () => [],
    conversationTurn: { findUnique: async () => ({ id: 'seed-turn' }) },
    session: { findUnique: async () => row },
    modelProvider: { findFirst: async () => s.customRow ?? null },
  };
  return {
    session: {
      findUniqueOrThrow: async () => row,
      findMany: async () => [row],
    },
    modelProvider: { findFirst: async () => s.customRow ?? null },
    runEvent: { aggregate: async () => ({ _max: { seq: 7 } }) },
    user: { findUnique: async () => null },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    $executeRaw: async () => {
      throw new Error('a pinned session model is not rewritten at dispatch');
    },
    tx,
  };
}

function controllerFor(prisma: unknown): RunnerApiController {
  return new RunnerApiController(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
}

/** The claim: what `GET /runner/sessions/claim` hands the runner that claimed the session. */
async function claim(s: Scenario): Promise<AgentExecConfig> {
  const prisma = prismaFor(s);
  const queue = new QueueService(prisma as unknown as PrismaService, { publishSessionUpdated() {} } as never);
  const claimed = await (
    queue as unknown as { buildSession(id: string): Promise<ClaimedSession> }
  ).buildSession(SESSION_ID);
  return claimed.agent;
}

/** The reclaim: what a restarted runner rebuilds the same session from. */
async function reclaim(s: Scenario): Promise<AgentExecConfig> {
  const response = await controllerFor(prismaFor(s)).reclaim({ id: RUNNER_ID, ownerId: OWNER });
  assert.equal(response.sessions.length, 1, 'the session was not reclaimed at all');
  return response.sessions[0].agent;
}

/** The reload: the environment a provider switch onto `provider` re-spawns the engine with. The
 *  switch is already on the session row by then (updateConfig persists it before queueing this). */
async function reload(s: Scenario, provider: string): Promise<Record<string, string> | undefined> {
  const prisma = prismaFor({ ...s, provider });
  return (
    controllerFor(prisma) as unknown as {
      reloadProviderEnv(tx: unknown, sessionId: string, content: string): Promise<Record<string, string> | undefined>;
    }
  ).reloadProviderEnv(prisma.tx, SESSION_ID, JSON.stringify({ provider }));
}

test('a workspace on another Codex account dispatches its session in that account\'s CODEX_HOME, through every door', async () => {
  const s: Scenario = { codexAccount: WORK, env: { RUST_LOG: 'warn' } };
  const claimed = await claim(s);
  assert.equal(claimed.provider, AgentProvider.CODEX);
  // The workspace's own variables still ride along; the account is one more.
  assert.deepEqual(claimed.env, { RUST_LOG: 'warn', CODEX_HOME: WORK_HOME });
  // A restarted runner rebuilds it on the same account, and a switch back onto Codex re-spawns it
  // there too: a door that resolved differently would move the conversation between accounts.
  assert.deepEqual((await reclaim(s)).env, claimed.env);
  assert.deepEqual(await reload(s, AgentProvider.CODEX), claimed.env);
});

test('a workspace that picked no account injects no CODEX_HOME: the runner resolves Default itself', async () => {
  for (const codexAccount of [null, undefined, 'default', '']) {
    const s: Scenario = { codexAccount, env: { RUST_LOG: 'warn' } };
    const label = JSON.stringify(codexAccount ?? null);
    assert.deepEqual((await claim(s)).env, { RUST_LOG: 'warn' }, label);
    assert.deepEqual((await reclaim(s)).env, { RUST_LOG: 'warn' }, label);
    assert.deepEqual(await reload(s, AgentProvider.CODEX), { RUST_LOG: 'warn' }, label);
  }
  // With no env of its own, still nothing: not even an empty CODEX_HOME for the runner to trip on.
  assert.equal((await claim({ codexAccount: null })).env, undefined);
  assert.equal((await reclaim({ codexAccount: null })).env, undefined);
});

test('an account the assigned runner does not report runs on Default instead of failing', async () => {
  const onlyDefault = [
    ENGINES[0],
    { ...ENGINES[1], accounts: [{ id: 'default', codexHome: DEFAULT_HOME, auth: 'yes' }] },
  ];
  for (const [why, engines] of [
    // The workspace moved to a machine that never had this account.
    ['another machine', onlyDefault],
    // A runner too old to list its accounts, or one that could not list them this time.
    ['no accounts listed', [ENGINES[0], { ...ENGINES[1], accounts: undefined }]],
    // A runner that has never reported its engines at all.
    ['no engine report', null],
    // An entry the heartbeat sanitizer would have dropped is not an account to run on.
    ['an unreadable entry', [ENGINES[0], { ...ENGINES[1], accounts: [{ id: WORK, auth: 'yes' }] }]],
  ] as const) {
    const s: Scenario = { codexAccount: WORK, engines };
    assert.equal((await claim(s)).env, undefined, why);
    assert.equal((await reclaim(s)).env, undefined, why);
  }
});

test('the picked account wins over a CODEX_HOME typed into the workspace env, which stays when none is picked', async () => {
  const env = { CODEX_HOME: '/srv/hand-typed-codex-home' };
  assert.deepEqual((await claim({ codexAccount: WORK, env })).env, { CODEX_HOME: WORK_HOME });
  assert.deepEqual((await claim({ codexAccount: null, env })).env, env);
});

test('only a session that runs the built-in Codex runtime is moved onto the account', async () => {
  // Claude in the same workspace: CODEX_HOME means nothing to it.
  const claude: Scenario = { codexAccount: WORK, provider: AgentProvider.CLAUDE, env: { RUST_LOG: 'warn' } };
  assert.deepEqual((await claim(claude)).env, { RUST_LOG: 'warn' });
  assert.deepEqual((await reclaim(claude)).env, { RUST_LOG: 'warn' });
  assert.deepEqual(await reload({ codexAccount: WORK }, AgentProvider.CLAUDE), {});

  // A configured provider on the Codex runtime brings its own key: no sign-in on the machine is spent,
  // so there is no account to move it onto.
  process.env.PROVIDER_SECRET_KEY ??= 'test-master-key';
  const configured: Scenario = {
    codexAccount: WORK,
    provider: 'openai-byok',
    providerBuiltin: false,
    customRow: {
      runtime: 'codex',
      baseUrl: 'https://api.example.invalid/v1',
      apiKeyEnc: encryptSecret('sk-orbit-test'),
      defaultModel: 'gpt-5.5',
      enabled: true,
    },
  };
  const env = (await claim(configured)).env ?? {};
  assert.equal(env.OPENAI_BASE_URL, 'https://api.example.invalid/v1');
  assert.equal('CODEX_HOME' in env, false);
  assert.deepEqual((await reclaim(configured)).env, env);
});

test('reset v1 reads Default only, so a workspace on another account is an account override', async () => {
  // The shared rule the create route and the web both read.
  assert.equal(codexResetAccountOverride({ provider: 'codex', codexAccount: WORK, env: null }), true);
  assert.equal(codexResetAccountOverride({ provider: 'codex', codexAccount: 'default', env: null }), false);
  assert.equal(codexResetAccountOverride({ provider: 'codex', codexAccount: null, env: null }), false);

  // And the create route itself, confirming from that workspace. Two confirmations that differ only
  // in the workspace's account: the one on Work is refused ACCOUNT_OVERRIDE before anything else is
  // asked, the one on Default gets past it and stops at the next rule (this runner declares no
  // reset capability), so the account is what refused the first.
  const refusal = async (codexAccount: string | null): Promise<string> => {
    const tx = {
      runner: {
        findFirst: async () => ({
          status: 'ONLINE',
          lastHeartbeatAt: new Date(),
          capabilities: [],
          heartbeatLeaseOwner: LEASE_OWNER,
          heartbeatDraining: false,
          planUsage: null,
        }),
      },
      workspace: {
        findFirst: async ({ select }: { select: Record<string, boolean> }) => {
          assert.equal(select.codexAccount, true, 'the workspace\'s account was never read');
          return { env: null, codexAccount };
        },
      },
      // The workspace last ran the built-in Codex, so its provider is not what refuses.
      $queryRaw: async () => [{ workspace_id: WORKSPACE_ID, provider: 'codex', provider_builtin: true }],
    };
    const operations = {
      byClientRequest: async () => null,
      activeFor: async () => null,
      unrefreshedSpendSettledAt: async () => null,
      insertIfAbsent: async () => true,
    };
    const service = new CodexRateLimitResetService(
      { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) } as never,
      operations as never,
    );
    try {
      await service.create(OWNER, RUNNER_ID, {
        clientRequestId: '66666666-6666-4666-8666-666666666666',
        accountFingerprint: `cxa1_${'9f3a41c7'.repeat(4)}`,
        workspaceId: WORKSPACE_ID,
      });
    } catch (error) {
      assert.ok(error instanceof ConflictException, String(error));
      return (error.getResponse() as { code: string }).code;
    }
    return 'created';
  };
  assert.equal(await refusal(WORK), 'ACCOUNT_OVERRIDE');
  assert.equal(await refusal(null), 'CAPABILITY_MISSING');
});

test('a workspace stores the slot id, never a path, and Default as no choice at all', async () => {
  // The pipe main.ts installs.
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
  const body = async (metatype: typeof CreateWorkspaceDto | typeof UpdateWorkspaceDto, raw: object) =>
    pipe.transform(raw, { type: 'body', metatype });
  for (const codexAccount of [WORK_HOME, '/home/dev/.codex', 'Work', '3FA91C2E', 'default ']) {
    await assert.rejects(body(UpdateWorkspaceDto, { codexAccount }), BadRequestException, codexAccount);
    await assert.rejects(body(CreateWorkspaceDto, { name: 'repo', codexAccount }), BadRequestException, codexAccount);
  }

  const written: Array<Record<string, unknown>> = [];
  const stored = { id: WORKSPACE_ID, ownerId: OWNER, name: 'repo', runner: null };
  const prisma = {
    workspace: {
      findFirst: async () => stored,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        written.push(data);
        return stored;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        written.push(data);
        return stored;
      },
    },
    user: { findUnique: async () => null },
    $queryRaw: async () => [],
  };
  const workspaces = new WorkspacesService(prisma as never);
  const update = async (raw: object) => {
    written.length = 0;
    await workspaces.update(OWNER, WORKSPACE_ID, (await body(UpdateWorkspaceDto, raw)) as UpdateWorkspaceDto);
    return written[0];
  };
  assert.equal((await update({ codexAccount: WORK })).codexAccount, WORK);
  assert.equal((await update({ codexAccount: 'default' })).codexAccount, null);
  assert.equal((await update({ codexAccount: null })).codexAccount, null);
  // A PATCH that says nothing about the account leaves it as it stands.
  assert.equal((await update({ name: 'renamed' })).codexAccount, undefined);

  written.length = 0;
  await workspaces.create(
    OWNER,
    (await body(CreateWorkspaceDto, { name: 'repo', codexAccount: WORK })) as CreateWorkspaceDto,
  );
  assert.equal(written[0].codexAccount, WORK);
  written.length = 0;
  await workspaces.create(OWNER, (await body(CreateWorkspaceDto, { name: 'repo' })) as CreateWorkspaceDto);
  assert.equal(written[0].codexAccount, null);
});
