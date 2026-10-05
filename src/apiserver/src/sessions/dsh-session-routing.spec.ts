import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, PermissionMode } from '@orbit/shared';
import { RunStatus } from '@prisma/client';
import { encryptSecret } from '../providers/provider-crypto';
import { execRuntime, resolveProviderExec } from '../providers/custom-provider';
import { SessionsService } from './sessions.service';
import { sessionMoveVerdict, type SessionMoveFacts } from './session-move';

process.env.PROVIDER_SECRET_KEY = 'dsh-session-routing-test-key';

const ownerId = '22222222-2222-4222-8222-222222222222';
const sessionId = '11111111-1111-4111-8111-111111111111';
const historicalId = '55555555-5555-4555-8555-555555555555';

const providerRow = (slug: string, runtime = 'claude') => ({
  slug, runtime, ownerId, enabled: true, label: slug,
  baseUrl: 'https://api.deepseek.com/anthropic',
  apiKeyEnc: encryptSecret('legacy-deepseek-key'),
  models: [{ value: 'deepseek-flash', label: 'DeepSeek Flash' }],
  defaultModel: 'deepseek-flash', presetSlug: 'deepseek', followsPreset: true,
});
type ProviderRow = ReturnType<typeof providerRow>;
type PoolRow = { slug: string; ownerId: string; engine?: string };

function delegates(providers: ProviderRow[], pools: PoolRow[] = []) {
  return {
    modelProvider: {
      findFirst: async ({ where }: { where: { slug: string; enabled?: boolean } }) =>
        providers.find((row) => row.slug === where.slug &&
          (where.enabled === undefined || row.enabled)) ?? null,
    },
    providerPool: {
      findFirst: async ({ where }: { where: { slug: string; ownerId?: string } }) =>
        pools.find((row) => row.slug === where.slug && row.ownerId === where.ownerId) ?? null,
    },
  };
}

function createFixture(
  providers: ProviderRow[],
  options: { pools?: PoolRow[]; seed?: string; preferences?: Record<string, unknown> } = {},
) {
  const creates: Array<Record<string, unknown>> = [];
  const prisma = {
    ...delegates(providers, options.pools),
    workspace: { findFirst: async () => ({ runnerId: 'runner-1', enableWorktree: false }) },
    $queryRaw: async () => [{
      workspace_id: 'workspace-1', provider: options.seed ?? 'claude',
      provider_builtin: !options.seed || options.seed === 'claude',
    }],
    runner: { findFirst: async () => ({ id: 'runner-1', capabilities: ['provider:dsh'], capabilitiesReportedAt: new Date() }) },
    user: { findUnique: async () => ({ preferences: options.preferences ?? {} }) },
    task: { findFirst: async () => ({
      id: 'task-1', projectId: null, verifiesTaskId: null, pinnedRevision: null,
      codeless: false, attemptGeneration: 1n, knownGoodSha: null,
    }) },
    session: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { id: sessionId, ...data, endReason: null, completedAt: null, archivedAt: null, deletedAt: null };
      },
      updateMany: async () => ({ count: 1 }),
    },
  };
  const service = new SessionsService(prisma as never, {
    notifySessionQueued: () => undefined, accountPoolRefusal: async () => null,
  } as never, {
    publishSessionCreated: () => undefined, publishSessionUpdated: () => undefined,
    publishWorkspaceChanged: () => undefined,
  } as never);
  return { service, creates };
}

function historyFixture(
  providers: ProviderRow[],
  overrides: Record<string, unknown> = {},
  pools: PoolRow[] = [],
) {
  const now = new Date();
  const session = {
    id: sessionId, ownerId, provider: 'deepseek', providerBuiltin: false,
    model: 'deepseek-flash', permissionMode: 'default', usesRuntimeDefaultModel: true,
    runtimeSessionId: historicalId, numTurns: 3, startedAt: now,
    status: RunStatus.FAILED, assignedRunnerId: 'runner-1',
    assignedRunner: { id: 'runner-1', status: 'ONLINE', lastHeartbeatAt: now, capabilities: ['provider:dsh'], capabilitiesReportedAt: now },
    workspace: null, cancelRequestedAt: null, completedAt: null, archivedAt: null,
    deletedAt: null, mergeStatus: null, commitStatus: null,
    ...overrides,
  };
  const updates: Array<Record<string, unknown>> = [];
  const turns: Array<Record<string, unknown>> = [];
  const sessionDelegate = {
    findFirst: async () => session,
    findUniqueOrThrow: async () => session,
    update: async ({ data }: { data: Record<string, unknown> }) => {
      updates.push(data);
      return { ...session, ...data };
    },
  };
  const tx = {
    ...delegates(providers, pools),
    $queryRaw: async () => [{ id: sessionId }], $executeRaw: async () => 1,
    session: sessionDelegate,
    conversationTurn: {
      findUnique: async () => null,
      findFirst: async () => ({ seq: 3 }),
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        turns.push(data);
        return { id: 'resume-turn', ...data };
      },
    },
  };
  const service = new SessionsService({
    session: sessionDelegate, $transaction: async (fn: (db: typeof tx) => unknown) => fn(tx),
  } as never, {
    notifySessionQueued: () => undefined, accountPoolRefusal: async () => null,
  } as never, {
    publishSessionUpdated: () => undefined, notifyInbox: () => undefined,
  } as never);
  return { service, session, updates, turns };
}

const opening = { prompt: 'Continue the project', title: 'DeepSeek compatibility', workspaceId: 'workspace-1' };
const continuation = { clientTurnId: 'continue-1', content: 'Continue from the previous turn' };

function assertLegacyDispatch(session: Record<string, unknown>, row: ProviderRow) {
  const resolved = resolveProviderExec({
    declaredProvider: session.provider as string,
    declaredProviderBuiltin: session.providerBuiltin as boolean,
    customRow: row, sessionModel: session.model as string,
    usesRuntimeDefaultModel: true,
  });
  assert.equal(resolved.provider, AgentProvider.CLAUDE);
  assert.equal(resolved.model, 'deepseek-flash');
  assert.equal(resolved.env?.ANTHROPIC_BASE_URL, row.baseUrl);
  assert.equal(resolved.env?.ANTHROPIC_AUTH_TOKEN, 'legacy-deepseek-key');
  assert.equal(resolved.env?.ANTHROPIC_MODEL, 'deepseek-flash');
  assert.equal(resolved.env?.ORBIT_DSH_API_KEY, undefined);
}

test('dsh compatibility: legacy DeepSeek new session and task still dispatch on Claude', async () => {
  const row = providerRow('deepseek');
  for (const taskId of [undefined, 'task-1']) {
    const fixture = createFixture([row]);
    await fixture.service.create(ownerId, { ...opening, provider: 'deepseek', model: 'deepseek-flash', taskId });
    const created = fixture.creates[0];
    assert.equal(created.provider, 'deepseek');
    assert.equal(created.providerBuiltin, false);
    assert.match(created.runtimeSessionId as string, /^[0-9a-f-]{36}$/);
    assert.equal(created.taskId, taskId);
    assertLegacyDispatch(created, row);
  }
});

test('dsh compatibility: inherited legacy DeepSeek task retains the configured Claude runtime', async () => {
  const row = providerRow('deepseek');
  const fixture = createFixture([row], { seed: 'deepseek' });
  await fixture.service.create(ownerId, { ...opening, taskId: 'task-1', model: 'deepseek-flash' });
  assert.equal(fixture.creates[0].providerBuiltin, false);
  assert.match(fixture.creates[0].runtimeSessionId as string, /^[0-9a-f-]{36}$/);
  assertLegacyDispatch(fixture.creates[0], row);
});

test('dsh compatibility: legacy DeepSeek history resumes with the same Claude id model and environment', async () => {
  const row = providerRow('deepseek');
  const fixture = historyFixture([row]);
  const answer = await fixture.service.resume(ownerId, sessionId, continuation);
  assert.equal(answer.turnId, 'resume-turn');
  assert.equal(answer.revived, true);
  assert.equal(fixture.updates[0].status, RunStatus.PENDING);
  const resumed = { ...fixture.session, ...fixture.updates[0] };
  assert.equal(resumed.runtimeSessionId, historicalId);
  assert.equal(resumed.numTurns, 3);
  assert.equal(resumed.provider, 'deepseek');
  assertLegacyDispatch(resumed, row);
});

test('dsh compatibility: existing dsh provider and pool slugs stay configured on creation and switching', async () => {
  for (const kind of ['provider', 'pool']) {
    const rows = kind === 'provider' ? [providerRow('dsh')] : [];
    const pools = kind === 'pool' ? [{ slug: 'dsh', ownerId }] : [];
    const creation = createFixture(rows, { pools });
    await creation.service.create(ownerId, { ...opening, provider: 'dsh', model: 'deepseek-flash' });
    const created = creation.creates[0];
    assert.equal(created.provider, 'dsh', kind);
    assert.equal(created.providerBuiltin, false, kind);
    assert.match(created.runtimeSessionId as string, /^[0-9a-f-]{36}$/, kind);
    assert.equal(execRuntime({ declaredProvider: 'dsh', declaredProviderBuiltin: false, customRow: rows[0] ?? null }), AgentProvider.CLAUDE);

    const history = historyFixture(rows, {
      provider: 'claude', providerBuiltin: true, model: 'claude-opus-5', status: RunStatus.AWAITING_INPUT,
    }, pools);
    await history.service.updateConfig(ownerId, sessionId, { provider: 'dsh' });
    assert.equal(history.updates[0].provider, 'dsh', kind);
    assert.equal(history.updates[0].providerBuiltin, false, kind);
    assert.equal(history.updates[0].runtimeSessionId, undefined, kind);
    assert.equal(history.session.runtimeSessionId, historicalId, kind);

    const continuationFixture = historyFixture(rows, { provider: 'dsh', providerBuiltin: false }, pools);
    await continuationFixture.service.resume(ownerId, sessionId, continuation);
    const continued = { ...continuationFixture.session, ...continuationFixture.updates[0] };
    assert.equal(continued.providerBuiltin, false, kind);
    assert.equal(continued.runtimeSessionId, historicalId, kind);
    if (rows[0]) assertLegacyDispatch(continued, rows[0]);
  }
});

test('dsh compatibility: Claude and Harness histories refuse cross-runtime resume and config switches', async () => {
  const harness = providerRow('deepseek-harness', 'dsh');
  for (const direction of [
    { provider: 'deepseek', providerBuiltin: false, target: 'deepseek-harness', from: 'claude', to: 'dsh' },
    { provider: 'dsh', providerBuiltin: true, target: 'deepseek', from: 'dsh', to: 'claude' },
  ]) {
    for (const operation of ['resume', 'config']) {
      const fixture = historyFixture([providerRow('deepseek'), harness], {
        provider: direction.provider, providerBuiltin: direction.providerBuiltin,
        status: operation === 'resume' ? RunStatus.FAILED : RunStatus.AWAITING_INPUT,
      });
      await assert.rejects(
        () => operation === 'resume'
          ? fixture.service.resume(ownerId, sessionId, { ...continuation, provider: direction.target })
          : fixture.service.updateConfig(ownerId, sessionId, { provider: direction.target }),
        new RegExp(`a ${direction.from} session cannot switch to a provider that runs on ${direction.to}`),
      );
      assert.deepEqual(fixture.updates, []);
      assert.equal(fixture.session.runtimeSessionId, historicalId);
    }
  }
});

test('dsh compatibility: a disabled existing dsh provider is unavailable instead of becoming the built-in engine', async () => {
  const row = { ...providerRow('dsh'), enabled: false };
  const creation = createFixture([row]);
  await assert.rejects(
    () => creation.service.create(ownerId, { ...opening, provider: 'dsh' }),
    /provider not available/,
  );
  assert.deepEqual(creation.creates, []);
  const history = historyFixture([row], {
    provider: 'claude', providerBuiltin: true, status: RunStatus.AWAITING_INPUT,
  });
  await assert.rejects(
    () => history.service.updateConfig(ownerId, sessionId, { provider: 'dsh' }),
    /provider not available/,
  );
  assert.deepEqual(history.updates, []);
});

test('dsh admission: unverified permission policies reject explicit and account-default modes before creation', async () => {
  const row = providerRow('deepseek-harness', 'dsh');
  for (const choice of [
    { permissionMode: PermissionMode.PLAN, preferences: {} },
    { permissionMode: PermissionMode.ACCEPT_EDITS, preferences: {} },
    { permissionMode: undefined, preferences: { defaultPermissionMode: PermissionMode.BYPASS } },
  ]) {
    const fixture = createFixture([row], { preferences: choice.preferences });
    await assert.rejects(
      () => fixture.service.create(ownerId, { ...opening, provider: 'deepseek-harness', permissionMode: choice.permissionMode }),
      /dsh|DeepSeek Harness/,
    );
    assert.deepEqual(fixture.creates, []);
  }
  // The code default, Auto, is a mode dsh enforces (its workspace-write sandbox) and is admitted.
  const admitted = createFixture([row], { preferences: {} });
  await admitted.service.create(ownerId, { ...opening, provider: 'deepseek-harness' });
  assert.equal(admitted.creates.length, 1);
});

test('dsh admission: terminal Harness resume refuses an unverified permission policy without rewriting its id', async () => {
  const fixture = historyFixture([], { provider: 'dsh', providerBuiltin: true, permissionMode: PermissionMode.PLAN });
  await assert.rejects(
    () => fixture.service.resume(ownerId, sessionId, continuation),
    /dsh|DeepSeek Harness/,
  );
  assert.deepEqual(fixture.updates, []);
  assert.deepEqual(fixture.turns, []);
  assert.equal(fixture.session.runtimeSessionId, historicalId);
});

test('dsh compatibility: other built-in engine creation and runtime routes remain unchanged', async () => {
  for (const provider of [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.KIMI, AgentProvider.OPENCODE, AgentProvider.ANTIGRAVITY]) {
    const fixture = createFixture([]);
    await fixture.service.create(ownerId, { ...opening, provider });
    const created = fixture.creates[0];
    assert.equal(created.providerBuiltin, true, provider);
    assert.equal(execRuntime({ declaredProvider: provider, declaredProviderBuiltin: true, customRow: null }), provider);
    assert.equal(typeof created.runtimeSessionId === 'string', provider === AgentProvider.CLAUDE, provider);
  }
});

test('dsh admission: Harness history cannot move to a different workspace', () => {
  const verdict = sessionMoveVerdict({
    runtime: AgentProvider.DSH, status: RunStatus.SUCCEEDED, deletedAt: null,
    completedAt: null, importSourceCwd: null, taskId: null, coordinatesProject: false,
    dispatchOrigin: 'USER', cancelRequestedAt: null, engineTurnActive: false,
    runningBgShells: [], liveApprovals: 0, queuedTurns: 0, mergeStatus: null,
    commitStatus: null, mergeRecoveryOpen: false, retryAt: null,
  } satisfies SessionMoveFacts);
  assert.equal(verdict.reason, "Moving DeepSeek Harness sessions isn't supported yet.");
});
