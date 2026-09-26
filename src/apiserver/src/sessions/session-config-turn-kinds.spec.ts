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
 * message is in flight is exactly right for it. Fast mode is built in the same way for a
 * different reason: Claude Code has no `--fast`, it reads `fastMode` out of the settings file the
 * spawn wrote, once, and answers a frame asking for it `success` while changing nothing. Model,
 * permission mode and effort are not built in; they can be said to a resident engine, and holding
 * those until the turn ends was a delay with nothing behind it.
 *
 * So each case below is a claim about one direction: the live half alone must NOT produce a
 * reload, the spawn-only half alone must NOT produce a setconfig, and neither assertion means
 * anything without the other — a rule that queued both every time would satisfy either one.
 *
 * One shape escapes the pairing, and it is filed as its own claim rather than as an exception to
 * the two: a switch that re-resolves the MODEL (see the first provider cases) queues the re-spawn
 * ALONE. The values on such a PATCH were resolved against the provider it moves the session to,
 * while the process a frame reaches is still on the endpoint it is moving from — and that endpoint
 * answers for its own models and refuses the rest. The refusal is not free: it costs the runner's
 * fallback re-spawn, which applies the committed config to job.Agent while its environment waits on
 * the reload turn, leaving an engine running the new provider's model against the old provider's
 * endpoint. Measured 2026-09-16, switching a live claude session to deepseek: the resumed turn died
 * on that endpoint's 404 and the switch never took effect.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

/** A live session with a committed model/mode/effort triple, and the turns a PATCH left. Claude
 *  unless `provider` says otherwise. */
function serviceOn(current: {
  model?: string | null;
  permissionMode?: string | null;
  effort?: string | null;
  fastMode?: boolean;
  /** The assigned runner, when a case needs its reported catalogue (Codex's fast lane is read there). */
  assignedRunner?: { modelCatalog?: unknown } | null;
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
        fastMode: false,
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

test('a provider switch that re-resolves the model is a re-spawn, effort and all', async () => {
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

  // No live frame at all in this shape — not reordered, not emptied, absent. The model this PATCH
  // resolves to belongs to the provider being moved TO ('byok-large' here), and the process a
  // frame would reach is still on the endpoint being moved FROM, which answers for its own models
  // and refuses the rest. Measured 2026-09-16 on a live claude session moved to deepseek:
  // `Model 'deepseek-flash' not found`, the runner took the re-spawn its refusal path promises —
  // which applies the committed config to job.Agent but gets its environment from the reload turn,
  // not delivered yet — and the engine came up as deepseek-flash against the Anthropic endpoint,
  // where the resumed turn died on a 404. So the frame is the one thing that must not be sent.
  // Nothing is lost with it: the reload carries the whole committed config, and the process it
  // builds is what applies an effort anyway.
  assert.deepEqual(turns.map((t) => t.kind), ['reload']);
  assert.deepEqual(JSON.parse(turns[0].content ?? '{}'), {
    model: 'byok-large',
    permissionMode: 'default',
    effort: 'xhigh',
    provider: 'byok',
  });
});

test('a provider switch that re-resolves the model says nothing to the engine it is leaving', async () => {
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

  // The permission mode moved and would be a frame the running engine can act on — but the model
  // moved with it, and a frame names the model it is filing under. That one is not servable on the
  // endpoint this process is still on, so the whole change waits for the process that can serve
  // it: one turn, the re-spawn, carrying everything. The alternative measured badly (see the
  // effort case above): the frame is refused, taken as a degradation, and the re-spawn it triggers
  // comes up on the new model against the old endpoint.
  assert.deepEqual(turns.map((t) => t.kind), ['reload']);
  const respawn = JSON.parse(turns[0].content ?? '{}');
  assert.equal(respawn.model, 'byok-large');
  assert.equal(respawn.permissionMode, 'auto');
  // The identity is what tells the inbox to resolve a new environment for this turn.
  assert.equal(respawn.provider, 'byok');
});

test('a provider switch that keeps the model still speaks to the running engine', async () => {
  process.env.PROVIDER_SECRET_KEY ??= 'test-master-key';
  // The control for the two cases above, and the reason the rule is stated about the MODEL rather
  // than about switching: a configured row that owns the id the session is already on (a second
  // account with the same vendor) re-resolves to that same id, so the frame names nothing the
  // running endpoint refuses — and the mode change beside it lands mid-turn, exactly as it would
  // without a switch.
  const { service, turns } = serviceOn({
    modelProvider: {
      runtime: 'claude',
      baseUrl: 'https://byok.example/anthropic',
      apiKeyEnc: encryptSecret('sk-byok'),
      defaultModel: 'claude-opus-5',
      models: [{ value: 'claude-opus-5', label: 'Opus 5' }],
      enabled: true,
    },
  });

  await service.updateConfig(OWNER, ID, { provider: 'byok', permissionMode: 'auto' });

  assert.deepEqual(turns.map((t) => t.kind), ['setconfig', 'reload']);
  const live = JSON.parse(turns[0].content ?? '{}');
  const respawn = JSON.parse(turns[1].content ?? '{}');
  assert.equal(live.model, 'claude-opus-5');
  assert.equal(live.permissionMode, 'auto');
  assert.equal(respawn.model, 'claude-opus-5');
  assert.equal(respawn.provider, 'byok');
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

test('a fast-mode change rebuilds the engine instead of being said to it', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { fastMode: true });

  // A reload, on the runtime that HAS the control channel — which is what makes this a claim
  // about the field rather than about the engine. `apply_flag_settings` will take a `fastMode`
  // and answer `success`, and every request the running turn goes on to make still goes out
  // without it: the opt-in is settled when the process starts. So the only thing that can move
  // it is the process being built again.
  assert.deepEqual(turns.map((t) => t.kind), ['reload']);
  assert.equal(JSON.parse(turns[0].content ?? '{}').fastMode, true);
});

test('the setconfig beside a fast-mode change never carries fast mode', async () => {
  const { service, turns } = serviceOn({});

  await service.updateConfig(OWNER, ID, { fastMode: true, effort: 'high' });

  // Both halves moved, so both turns are queued, re-spawn last — and the split is by FIELD: the
  // frame carries what a resident engine can act on and nothing else. A `fastMode` on the
  // setconfig would be a key the CLI accepts, answers `success` to, and drops.
  assert.deepEqual(
    turns.map(({ kind, seq }) => ({ kind, seq })),
    [
      { kind: 'setconfig', seq: 1 },
      { kind: 'reload', seq: 2 },
    ],
  );
  assert.equal('fastMode' in JSON.parse(turns[0].content ?? '{}'), false);
  assert.equal(JSON.parse(turns[1].content ?? '{}').fastMode, true);
  // The effort is on both, exactly as it is beside a provider switch: the frame moves the turn
  // running now, the flag builds the process that runs next.
  assert.equal(JSON.parse(turns[0].content ?? '{}').effort, 'high');
  assert.equal(JSON.parse(turns[1].content ?? '{}').effort, 'high');
});

test('re-sending the fast mode a session already has does not re-spawn it', async () => {
  const { service, turns } = serviceOn({ fastMode: true });

  await service.updateConfig(OWNER, ID, { fastMode: true });

  // Rebuilding the process to arrive at the setting it already has is the interruption this
  // split exists to stop handing out — and unlike a restated effort, a restated fast mode would
  // cost the session its process for a value that never moved.
  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
});

test('a PATCH that does not mention fast mode does not state one either', async () => {
  const { service, turns } = serviceOn({ fastMode: true });

  await service.updateConfig(OWNER, ID, { model: 'claude-haiku-4-5' });

  // Nothing moved it, so nothing says anything about it: the runner reads an absent `fastMode`
  // as "keep what this process was built with". Note the model here has no fast lane at all —
  // the stored `true` is deliberately NOT rewritten, because the constraint is applied where the
  // session dispatches, and going back to a model that has one must restore what was asked for.
  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.equal('fastMode' in JSON.parse(turns[0].content ?? '{}'), false);
});

test('asking for fast mode on a model without a fast lane stores the truth, and re-spawns nothing', async () => {
  const { service, turns } = serviceOn({ model: 'claude-sonnet-5' });

  await service.updateConfig(OWNER, ID, { fastMode: true });

  // Claude Code refuses fast mode on a model whose capabilities do not carry it, so the honest
  // answer is that nothing moved: no reload, and the row is left saying false rather than
  // recording a setting no engine will honour. The PATCH is not an error — the pickers only
  // describe this rule, and an MCP caller or an older client reaches here without passing one.
  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.equal('fastMode' in JSON.parse(turns[0].content ?? '{}'), false);
});

/** A Codex runner whose catalogue row for `gpt-6-astra` advertises the tiers named here. */
const codexRunner = (serviceTiers: string[]) => ({
  modelCatalog: { codex: [{ value: 'gpt-6-astra', label: 'GPT-6-Astra', serviceTiers }] },
});

test('a Codex session reads its fast lane off the runner catalogue, and gets it on the next turn', async () => {
  const { service, turns } = serviceOn({
    provider: 'codex',
    model: 'gpt-6-astra',
    assignedRunner: codexRunner(['priority']),
  });

  await service.updateConfig(OWNER, ID, { fastMode: true });

  // A reload and nothing else — the same kind every Codex field travels on, because Codex has no
  // setconfig arm. What differs from Claude is only what the runner does with it: Codex's fast
  // lane is a per-request service tier, so the next turn/start carries it without a re-spawn.
  assert.deepEqual(turns.map((t) => t.kind), ['reload']);
  assert.equal(JSON.parse(turns[0].content ?? '{}').fastMode, true);
});

test('a Codex model whose catalogue row does not advertise the priority tier has no fast lane', async () => {
  const { service, turns } = serviceOn({
    provider: 'codex',
    model: 'gpt-6-astra',
    assignedRunner: codexRunner([]),
  });

  await service.updateConfig(OWNER, ID, { fastMode: true });

  // Stored false and never sent. Codex does not refuse a tier its catalogue does not advertise; it
  // drops it from the request without a word, so recording `true` would be a setting nothing honours.
  assert.equal('fastMode' in JSON.parse(turns[0]?.content ?? '{}'), false);
});

/** A self-hosted Claude-runtime row whose models declare the efforts they accept — vLLM serving
 *  Qwen3.8, whose chat template raises on any `reasoning_effort` but xhigh/medium/low. */
const declaringRow = () => ({
  runtime: 'claude',
  baseUrl: 'http://127.0.0.1:8000',
  apiKeyEnc: encryptSecret('EMPTY'),
  defaultModel: 'qwen3.8-27b-fp8',
  enabled: true,
  models: [
    { value: 'qwen3.8-27b-fp8', label: 'Qwen3.8 27B', reasoningLevels: ['low', 'medium', 'xhigh'] },
    { value: 'qwen3.8-9b', label: 'Qwen3.8 9B', reasoningLevels: ['low', 'medium'] },
  ],
});

test('a model that declares its efforts is told one it accepts, not the level asked for', async () => {
  process.env.PROVIDER_SECRET_KEY ??= 'test-master-key';
  const { service, turns } = serviceOn({
    provider: 'local-vllm',
    providerBuiltin: false,
    model: 'qwen3.8-27b-fp8',
    modelProvider: declaringRow(),
  });

  await service.updateConfig(OWNER, ID, { effort: 'high' });

  // `high` is refused by this model's template on every request; the nearest level it takes is said
  // instead, the same one the claim would have spawned it on.
  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.equal(JSON.parse(turns[0].content ?? '{}').effort, 'xhigh');
});

test('moving to another declaring model restates the effort that model accepts', async () => {
  process.env.PROVIDER_SECRET_KEY ??= 'test-master-key';
  const { service, turns } = serviceOn({
    provider: 'local-vllm',
    providerBuiltin: false,
    model: 'qwen3.8-27b-fp8',
    effort: 'xhigh',
    modelProvider: declaringRow(),
  });

  await service.updateConfig(OWNER, ID, { model: 'qwen3.8-9b' });

  // The effort did not move, but the level the engine holds is one the new model refuses: a model
  // change is an effort change here, so the frame carries both.
  assert.deepEqual(turns.map((t) => t.kind), ['setconfig']);
  assert.deepEqual(JSON.parse(turns[0].content ?? '{}'), {
    model: 'qwen3.8-9b',
    permissionMode: 'default',
    effort: 'medium',
  });
});

test('a switch onto a declaring provider re-spawns on a level its model accepts', async () => {
  process.env.PROVIDER_SECRET_KEY ??= 'test-master-key';
  const { service, turns } = serviceOn({ modelProvider: declaringRow() });

  await service.updateConfig(OWNER, ID, { provider: 'local-vllm' });

  // The session had no effort of its own — which on the process it is leaving was the CLI's `high` —
  // so the re-spawn states the level the new model takes rather than leaving the default standing.
  assert.deepEqual(turns.map((t) => t.kind), ['reload']);
  const reload = JSON.parse(turns[0].content ?? '{}');
  assert.equal(reload.model, 'qwen3.8-27b-fp8');
  assert.equal(reload.effort, 'xhigh');
});
