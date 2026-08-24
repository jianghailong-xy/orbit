import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { encryptSecret } from '../providers/provider-crypto';
import { SessionsService } from './sessions.service';

/**
 * Which control turn a config PATCH queues, decided by what that PATCH actually moved.
 *
 * The split is not a relaxation of the inbox gate — it is a statement about the fields. A
 * provider is decided when the process is built (it IS that process's environment), so the only
 * way to change one is to build another process, and the gate that holds a `reload` until no
 * message is in flight is exactly right for it. Model, permission mode and effort are not built
 * in; they can be said to a resident engine, and holding those until the turn ends was a delay
 * with nothing behind it.
 *
 * So each case below is a claim about one direction: the live half alone must NOT produce a
 * reload, the spawn-only half alone must NOT produce a setconfig, and neither assertion means
 * anything without the other — a rule that queued both every time would satisfy either one.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

/** A live session with a committed model/mode/effort triple, and the turns a PATCH left. Claude
 *  unless `provider` says otherwise. */
function serviceOn(current: {
  model?: string | null;
  permissionMode?: string | null;
  effort?: string | null;
  /** The identity the session declares. A configured (BYOK) slug takes providerBuiltin: false. */
  provider?: string;
  providerBuiltin?: boolean;
  /** The one configured row `provider` names, or may be switched onto — or none. */
  modelProvider?: Record<string, unknown>;
}) {
  const { modelProvider, ...row } = current;
  const turns: Array<{ kind: string; content?: string; seq: number }> = [];
  let sequence = 0;
  const tx = {
    $queryRaw: async () => [{ id: ID }],
    session: {
      findUniqueOrThrow: async () => ({
        id: ID,
        ownerId: OWNER,
        status: RunStatus.RUNNING,
        provider: 'claude',
        providerBuiltin: true,
        model: 'claude-opus-5',
        permissionMode: 'default',
        effort: null,
        usesRuntimeDefaultModel: false,
        numTurns: 3,
        workspace: null,
        assignedRunner: null,
        ...row,
      }),
      update: async () => ({ id: ID }),
    },
    conversationTurn: {
      findUnique: async () => null,
      findFirst: async () => (sequence ? { seq: sequence } : null),
      create: async ({ data }: { data: { kind: string; content?: string; seq: number } }) => {
        sequence = data.seq;
        turns.push(data);
        return { id: `turn-${sequence}`, ...data };
      },
      count: async () => 0,
    },
    modelProvider: { findFirst: async () => modelProvider ?? null },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never;
  const service = new SessionsService(prisma, {} as never, {
    notifyInbox: () => undefined,
  } as never);
  return { service, turns };
}

test('a model change is said to the live engine, not spawned into a new one', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { model: 'claude-haiku-4-5' });

  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.deepEqual(JSON.parse(turns[0].content ?? '{}'), {
    model: 'claude-haiku-4-5',
    permissionMode: 'default',
  });
});

test('a permission-mode change is said to the live engine too', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { permissionMode: 'auto' });

  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.equal(JSON.parse(turns[0].content ?? '{}').permissionMode, 'auto');
});

test('an effort change is said to the live engine, not spawned into a new one', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { effort: 'high' });

  // No reload beside it. `--effort` reads like a spawn flag and was treated as one until the
  // control frame was measured against the API requests a running turn goes on to make: every
  // call after it carries the new level, so there is nothing left for a new process to do.
  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.deepEqual(JSON.parse(turns[0].content ?? '{}'), {
    model: 'claude-opus-5',
    permissionMode: 'default',
    effort: 'high',
  });
});

test('an effort cleared back to the model default is stated, not omitted', async () => {
  const { service, turns } = serviceOn({ effort: 'xhigh' });

  await service.updateConfig(OWNER, ID, { effort: '' });

  // '' is a value here, not an absence: it is what the runner turns into `effortLevel: null`,
  // the frame that hands the model back its own default. An omitted key would tell the engine
  // nothing and leave it on xhigh while the session showed the default.
  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.equal(JSON.parse(turns[0].content ?? '{}').effort, '');
});

test('a PATCH that does not mention effort does not state one either', async () => {
  const { service, turns } = serviceOn({ effort: 'xhigh' });

  await service.updateConfig(OWNER, ID, { model: 'claude-haiku-4-5' });

  // Unlike the model/mode pair, effort is NOT restated on every setconfig. A session with no
  // effort of its own runs on its WORKSPACE's (the claim resolves `session.effort ??
  // workspace.effort`), so the committed value is not what the engine was built with — sending
  // it would tell a live engine to drop a workspace default nobody touched.
  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.equal('effort' in JSON.parse(turns[0].content ?? '{}'), false);
});

test('re-sending the effort a session already has moves nothing, so it does not re-spawn', async () => {
  const { service, turns } = serviceOn({ effort: 'high' });

  await service.updateConfig(OWNER, ID, { effort: 'high' });

  // Rebuilding the process to arrive at the flag it already has is the interruption this split
  // exists to stop handing out. The frame restates it and the runner asks the engine for
  // nothing, which is the cheap end of the two.
  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
});

test('moving the whole live half at once queues one setconfig and no re-spawn', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, {
    model: 'claude-haiku-4-5',
    permissionMode: 'plan',
    effort: 'high',
  });

  // All three travel together, in the one frame-bearing turn. A reload here would abort the
  // running turn to arrive at config the engine had already been told.
  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.deepEqual(JSON.parse(turns[0].content ?? '{}'), {
    model: 'claude-haiku-4-5',
    permissionMode: 'plan',
    effort: 'high',
  });
});

test('re-sending the provider a session already declares moves nothing either', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { provider: 'claude' });

  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
});

test('a provider switch alongside an effort change queues both, re-spawn last', async () => {
  process.env.PROVIDER_SECRET_KEY ??= 'test-master-key';
  const { service, turns } = serviceOn({
    modelProvider: {
      runtime: 'claude',
      baseUrl: 'https://byok.example/anthropic',
      apiKeyEnc: encryptSecret('sk-byok'),
      defaultModel: 'byok-large',
      enabled: true,
    },
  });

  await service.updateConfig(OWNER, ID, { provider: 'byok', effort: 'xhigh' });

  // Order is the point: the reload re-spawns with every new flag, so a setconfig ordered after
  // it would be a control frame for config the fresh process already has. And the effort has to
  // be on BOTH — the frame moves the turn that is running now, the flag builds the process that
  // runs next, and a reload that dropped it would come back on the old level.
  assert.deepEqual(
    turns.map(({ kind, seq }) => ({ kind, seq })),
    [
      { kind: 'setconfig', seq: 1 },
      { kind: 'reload', seq: 2 },
    ],
  );
  assert.equal(JSON.parse(turns[0].content ?? '{}').effort, 'xhigh');
  assert.equal(JSON.parse(turns[1].content ?? '{}').effort, 'xhigh');
  // Only the reload names the provider: it is the one that has to rebuild the process.
  assert.equal(JSON.parse(turns[0].content ?? '{}').provider, undefined);
  assert.equal(JSON.parse(turns[1].content ?? '{}').provider, 'byok');
});

test('a provider switch alongside a permission-mode change queues both, re-spawn last', async () => {
  process.env.PROVIDER_SECRET_KEY ??= 'test-master-key';
  // A configured slug on the claude runtime: the one kind of switch a claude session may make,
  // since resolveProviderSwitch refuses to move a session across runtimes.
  const { service, turns } = serviceOn({
    modelProvider: {
      runtime: 'claude',
      baseUrl: 'https://byok.example/anthropic',
      apiKeyEnc: encryptSecret('sk-byok'),
      defaultModel: 'byok-large',
      enabled: true,
    },
  });

  await service.updateConfig(OWNER, ID, { provider: 'byok', permissionMode: 'auto' });

  assert.deepEqual(
    turns.map(({ kind, seq }) => ({ kind, seq })),
    [
      { kind: 'setconfig', seq: 1 },
      { kind: 'reload', seq: 2 },
    ],
  );
  // Only the reload names the provider: it is the one that has to rebuild the process, and the
  // identity is what tells the inbox to resolve an environment for it.
  assert.equal(JSON.parse(turns[0].content ?? '{}').provider, undefined);
  assert.equal(JSON.parse(turns[1].content ?? '{}').provider, 'byok');
  // Both carry the same committed pair — they were written under one row lock, from one read.
  const live = JSON.parse(turns[0].content ?? '{}');
  const respawn = JSON.parse(turns[1].content ?? '{}');
  assert.equal(live.model, respawn.model);
  assert.equal(live.permissionMode, respawn.permissionMode);
  assert.equal(live.permissionMode, 'auto');
});

/**
 * Which turn a config PATCH queues also depends on the RUNTIME, not just on what moved.
 *
 * `setconfig` is a stream-json control_request. Codex and Kimi are driven over ACP/JSON-RPC and
 * OpenCode runs one process per turn; none of their session loops has an arm for the kind, so a
 * setconfig filed for one is acked on delivery and the change never reaches the engine at all —
 * strictly worse than the wait the split removed. They keep the reload they always had.
 *
 * Each case below is paired with its opposite on purpose: "codex re-spawns" says nothing without
 * "claude does not", and a rule that always re-spawned would satisfy the first half alone.
 */

test('a codex session is re-spawned for a model change — ACP has nothing to hear a frame', async () => {
  const { service, turns } = serviceOn({ provider: 'codex', model: 'gpt-5.6-sol' });

  await service.updateConfig(OWNER, ID, { model: 'gpt-5.6-thinking' });

  assert.deepEqual(turns.map((t) => t.kind), ['reload']);
  // The change still lands — it rides the process this reload builds, as it always did.
  assert.equal(JSON.parse(turns[0].content ?? '{}').model, 'gpt-5.6-thinking');
});

test('a kimi session is re-spawned for a permission-mode change', async () => {
  const { service, turns } = serviceOn({
    provider: 'kimi',
    model: 'kimi-code/kimi-for-coding',
  });

  await service.updateConfig(OWNER, ID, { permissionMode: 'plan' });

  assert.deepEqual(turns.map((t) => t.kind), ['reload']);
  assert.equal(JSON.parse(turns[0].content ?? '{}').permissionMode, 'plan');
});

test('an opencode session is re-spawned too — its process does not outlive the turn', async () => {
  const { service, turns } = serviceOn({
    provider: 'opencode',
    model: 'anthropic/claude-opus-5',
  });

  await service.updateConfig(OWNER, ID, { model: 'anthropic/claude-haiku-4-5' });

  assert.deepEqual(turns.map((t) => t.kind), ['reload']);
  assert.equal(JSON.parse(turns[0].content ?? '{}').model, 'anthropic/claude-haiku-4-5');
});

test('a built-in claude session is told, and is the control for all three above', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { model: 'claude-haiku-4-5' });

  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
});

/**
 * Effort specifically, on the runtimes that cannot be told. It moved onto the control channel
 * for claude alone; a runtime with no arm for the kind would have the change acked on delivery
 * and applied by nobody, which is strictly worse than the wait the split removed. So each of
 * the three keeps the reload it always had — with the new level on it, because the process
 * that reload builds is what applies it.
 */
for (const runtime of [
  { provider: 'codex', model: 'gpt-5.6-sol' },
  { provider: 'kimi', model: 'kimi-code/kimi-for-coding' },
  { provider: 'opencode', model: 'anthropic/claude-opus-5' },
]) {
  test(`a ${runtime.provider} session is re-spawned for an effort change`, async () => {
    const { service, turns } = serviceOn(runtime);

    await service.updateConfig(OWNER, ID, { effort: 'high' });

    assert.deepEqual(turns.map((t) => t.kind), ['reload']);
    assert.equal(JSON.parse(turns[0].content ?? '{}').effort, 'high');
  });
}

test('a claude session is the control for the three above: its effort is told, not spawned', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { effort: 'high' });

  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
});

test('a configured provider borrowing the claude runtime is told, not re-spawned', async () => {
  process.env.PROVIDER_SECRET_KEY ??= 'test-master-key';
  // The session's own slug is its owner's word — nothing about it says "claude". Judged by the
  // slug, this session would lose the control frame; judged by the runtime it borrows, it keeps
  // it, because the process it is actually running is a claude one.
  const { service, turns } = serviceOn({
    provider: 'my-anthropic',
    providerBuiltin: false,
    model: 'byok-large',
    modelProvider: {
      runtime: 'claude',
      baseUrl: 'https://byok.example/anthropic',
      apiKeyEnc: encryptSecret('sk-byok'),
      defaultModel: 'byok-large',
      enabled: true,
    },
  });

  await service.updateConfig(OWNER, ID, { model: 'byok-small' });

  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.equal(JSON.parse(turns[0].content ?? '{}').model, 'byok-small');
});

test('a configured provider borrowing the codex runtime is re-spawned', async () => {
  process.env.PROVIDER_SECRET_KEY ??= 'test-master-key';
  // The other half of the same claim: a custom slug is not what decides this, the runtime is.
  const { service, turns } = serviceOn({
    provider: 'my-openai',
    providerBuiltin: false,
    model: 'byok-gpt',
    modelProvider: {
      runtime: 'codex',
      baseUrl: 'https://byok.example/openai',
      apiKeyEnc: encryptSecret('sk-byok'),
      defaultModel: 'byok-gpt',
      enabled: true,
    },
  });

  await service.updateConfig(OWNER, ID, { model: 'byok-gpt-mini' });

  assert.deepEqual(turns.map((t) => t.kind), ['reload']);
  assert.equal(JSON.parse(turns[0].content ?? '{}').model, 'byok-gpt-mini');
});
