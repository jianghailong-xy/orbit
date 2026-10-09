/**
 * A session's engine without a database (docs/provider-engine-contract.md §4.2, §5.4): how a row with
 * no recorded engine is derived, that a recorded one always wins, and that dispatch hands a key to
 * the session's engine in that engine's own variables — refusing a key the engine cannot run rather
 * than running it on the engine the key would pick. The PostgreSQL half is
 * queue/session-engine-foundation.pg.spec.ts; both are named in
 * scripts/test-provider-engine-foundation.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { RunStatus } from '@prisma/client';
import { builtinSessionEngine, resolveProviderExec, type ModelProviderRow } from './custom-provider';
import { encryptSecret } from './provider-crypto';
import { legacySessionEngine, sessionEngine } from './session-engine';
import { ReaperService } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';

process.env.PROVIDER_SECRET_KEY = 'session-engine-spec';
const OWNER = '11111111-1111-4111-8111-111111111111';

/** A database the derivation must not ask: a built-in slug or a recorded engine answers on its own. */
const unasked = new Proxy({}, { get: () => assert.fail('the derivation asked the database') }) as never;

/** A database holding at most one key row and one pool, recording what it was asked. */
function rows(key: { runtime: string } | null, pool: { shared: boolean; engine: string } | null = null) {
  const asked: unknown[] = [];
  const db = {
    modelProvider: { findFirst: async (args: unknown) => { asked.push(args); return key; } },
    providerPool: {
      findFirst: async (args: { where: { ownerId?: string; people?: unknown } }) =>
        // The owner's own pool, else a Codex pool they are one of the people of.
        pool && (args.where.ownerId ? !pool.shared : pool.engine === 'codex') ? pool : null,
    },
  };
  return { db: db as never, asked };
}

const key = (over: Partial<ModelProviderRow> = {}): ModelProviderRow => ({
  slug: 'my-key',
  runtime: 'claude',
  baseUrl: 'https://api.example.test',
  apiKeyEnc: encryptSecret('sk-key'),
  defaultModel: 'vendor-model',
  enabled: true,
  ...over,
});
const deepSeek = (over: Partial<ModelProviderRow> = {}) =>
  key({ slug: 'deepseek', presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKeyEnc: encryptSecret('sk-ds'), ...over });

test('T2 legacy derivation: built-in slugs name themselves, kimi and dsh only when built-in', async () => {
  for (const provider of [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.OPENCODE, AgentProvider.ANTIGRAVITY]) {
    for (const providerBuiltin of [true, false]) {
      assert.equal(await legacySessionEngine(unasked, { provider, providerBuiltin, ownerId: OWNER }), provider);
    }
  }
  assert.equal(builtinSessionEngine(AgentProvider.KIMI, true), AgentProvider.KIMI);
  assert.equal(builtinSessionEngine(AgentProvider.DSH, true), AgentProvider.DSH);
  assert.equal(builtinSessionEngine(AgentProvider.KIMI, false), null, 'a configured `kimi` is a key to look up');
  assert.equal(builtinSessionEngine(AgentProvider.DSH, false), null, 'a configured `dsh` is a key to look up');
  assert.equal(builtinSessionEngine(null, false), AgentProvider.CLAUDE, "no provider is the column's default");
});

test('T2 legacy derivation: a disabled or out-of-reach key answers its row runtime, a deleted one is unknown, never Claude', async () => {
  const codex = rows({ runtime: 'codex' });
  assert.equal(await legacySessionEngine(codex.db, { provider: 'my-codex', providerBuiltin: false, ownerId: OWNER }), AgentProvider.CODEX);
  // Asked of the owner's rows and the shared ones, enabled or not, whoever may use them.
  assert.deepEqual(codex.asked, [{ where: { slug: 'my-codex', OR: [{ ownerId: OWNER }, { ownerId: null }] }, select: { runtime: true } }]);
  for (const runtime of ['claude', 'codex', 'kimi', 'antigravity', 'dsh']) {
    assert.equal(await legacySessionEngine(rows({ runtime }).db, { provider: 'k', providerBuiltin: false, ownerId: OWNER }), runtime);
  }
  assert.equal(await legacySessionEngine(rows(null).db, { provider: 'gone', providerBuiltin: false, ownerId: OWNER }), null);
  assert.equal(await legacySessionEngine(rows({ runtime: 'mystery' }).db, { provider: 'k', providerBuiltin: false, ownerId: OWNER }), null);
});

test('T2 legacy derivation: own and shared pools answer the pool engine', async () => {
  const facts = { provider: 'pool', providerBuiltin: false, ownerId: OWNER };
  assert.equal(await legacySessionEngine(rows(null, { shared: false, engine: 'claude' }).db, facts), AgentProvider.CLAUDE);
  assert.equal(await legacySessionEngine(rows(null, { shared: false, engine: 'codex' }).db, facts), AgentProvider.CODEX);
  assert.equal(await legacySessionEngine(rows(null, { shared: true, engine: 'codex' }).db, facts), AgentProvider.CODEX);
});

test('T2 a recorded engine wins over the credential', async () => {
  for (const [provider, engine] of [
    [AgentProvider.CLAUDE, AgentProvider.CLAUDE], ['deepseek', AgentProvider.DSH], ['deepseek', AgentProvider.OPENCODE],
    ['gone', AgentProvider.CODEX], [AgentProvider.DSH, AgentProvider.DSH],
  ] as const) {
    assert.equal(await sessionEngine(unasked, { provider, providerBuiltin: false, engine, ownerId: OWNER }), engine);
  }
  // Anything but an engine in the column is no recorded engine.
  assert.equal(await sessionEngine(rows({ runtime: 'kimi' }).db, { provider: 'k', engine: 'gpt', ownerId: OWNER }), AgentProvider.KIMI);
});

test('T2 dispatch injects a key in the variables of the session engine', () => {
  const on = (engine: AgentProvider, customRow: ModelProviderRow, sessionModel = 'model-x') =>
    resolveProviderExec({ engine, declaredProvider: customRow.slug, customRow, sessionModel });
  const claude = on(AgentProvider.CLAUDE, deepSeek());
  assert.equal(claude.provider, AgentProvider.CLAUDE);
  assert.equal(claude.env?.ANTHROPIC_AUTH_TOKEN, 'sk-ds');
  assert.equal(claude.env?.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  const harness = on(AgentProvider.DSH, deepSeek());
  assert.equal(harness.provider, AgentProvider.DSH);
  assert.deepEqual(harness.env, { ORBIT_DSH_API_KEY: 'sk-ds', ORBIT_DSH_BASE_URL: 'https://api.deepseek.com/anthropic' });
  const openCode = on(AgentProvider.OPENCODE, deepSeek(), 'deepseek-flash');
  assert.equal(openCode.provider, AgentProvider.OPENCODE);
  assert.equal(openCode.model, 'deepseek-flash', 'the session keeps the bare id');
  assert.equal(openCode.runnerModel, 'orbit-deepseek/deepseek-flash', 'OpenCode is told it by the key');
  const config = JSON.parse(openCode.env!.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.provider['orbit-deepseek'], {
    npm: '@ai-sdk/anthropic',
    options: { baseURL: 'https://api.deepseek.com/anthropic/v1', apiKey: 'sk-ds' },
    models: { 'deepseek-flash': { name: 'deepseek-flash' } },
  });
  assert.equal(openCode.env?.ANTHROPIC_AUTH_TOKEN, undefined);
  const responses = key({ runtime: 'codex', baseUrl: 'https://api.openai.example/v1' });
  assert.deepEqual(on(AgentProvider.CODEX, responses).env, { OPENAI_BASE_URL: 'https://api.openai.example/v1', OPENAI_API_KEY: 'sk-key' });
  const moonshot = key({ runtime: 'kimi', baseUrl: 'https://api.moonshot.ai/v1' });
  assert.equal(on(AgentProvider.KIMI, moonshot, 'kimi-k3').env?.KIMI_MODEL_API_KEY, 'sk-key');
  const gemini = key({ runtime: 'antigravity', baseUrl: 'https://generativelanguage.googleapis.com' });
  assert.equal(on(AgentProvider.ANTIGRAVITY, gemini).env?.GEMINI_API_KEY, 'sk-key');
  // A legacy Harness row is DeepSeek's Anthropic endpoint: Claude Code runs it too.
  assert.equal(on(AgentProvider.CLAUDE, deepSeek({ runtime: 'dsh', presetSlug: 'deepseek-harness' })).env?.ANTHROPIC_AUTH_TOKEN, 'sk-ds');
});

test('T2 dispatch refuses a credential the session engine cannot run instead of switching CLI', () => {
  const refusal = (engine: AgentProvider, customRow: ModelProviderRow | null, declaredProvider = customRow?.slug) => {
    try {
      resolveProviderExec({ engine, declaredProvider, declaredProviderBuiltin: !customRow, customRow, sessionModel: 'm' });
    } catch (error) {
      return (error as { getResponse(): { code?: string; message: string } }).getResponse();
    }
    return assert.fail(`${engine} ran on ${declaredProvider}`);
  };
  // DeepSeek Harness on a key that is not DeepSeek's.
  assert.deepEqual(refusal(AgentProvider.DSH, key()), {
    code: 'PROVIDER_ENGINE_INCOMPATIBLE',
    message: 'provider "my-key" cannot run on DeepSeek Harness; it runs on Claude Code, OpenCode',
    engine: AgentProvider.DSH,
    provider: 'my-key',
    engines: [AgentProvider.CLAUDE, AgentProvider.OPENCODE],
  });
  // OpenCode on a Claude subscription token, which Anthropic serves to Claude Code alone.
  assert.equal(refusal(AgentProvider.OPENCODE, key({ apiKeyEnc: encryptSecret('sk-ant-oat01-x') })).code, 'PROVIDER_ENGINE_INCOMPATIBLE');
  // A key whose protocol was changed under a Claude Code session.
  assert.equal(refusal(AgentProvider.CLAUDE, key({ runtime: 'codex' })).message,
    'provider "my-key" cannot run on Claude Code; it runs on Codex, OpenCode');
  // A sign-in runs its own engine only.
  assert.equal(refusal(AgentProvider.CODEX, null, AgentProvider.CLAUDE).message,
    'provider "claude" cannot run on Codex; it runs on Claude Code');
  // A protocol no engine speaks is refused in the words it always was.
  assert.throws(() => resolveProviderExec({ engine: AgentProvider.CLAUDE, declaredProvider: 'x', customRow: key({ runtime: 'mystery' }) }),
    /provider runtime not available: "mystery"/);
});

test('T2 standing grants are judged by the session engine', async () => {
  const rules = [{ toolName: 'Bash', ruleContent: 'npm test:*' }];
  const prisma = { workspacePermissionRule: { findMany: async () => rules } };
  const controller = new RunnerApiController(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const covers = (session: Record<string, unknown>) =>
    (controller as unknown as { standingGrantCovers(s: unknown, dto: unknown): Promise<boolean> }).standingGrantCovers(
      { workspaceId: 'w', ownerId: OWNER, providerBuiltin: false, ...session },
      { toolName: 'Bash', input: { command: 'npm test', cwd: '/repo' } },
    );
  // A Codex session whose key is gone is still Codex, whose approvals the server matches; the Claude a
  // missing key used to read as matches its own, so the grant was never applied.
  assert.equal(await covers({ provider: 'gone-codex-key', engine: AgentProvider.CODEX }), true);
  assert.equal(await covers({ provider: 'some-key', engine: AgentProvider.CLAUDE }), false);
  // One nobody can place is asked about.
  const unplaced = new RunnerApiController({ ...prisma, modelProvider: { findFirst: async () => null }, providerPool: { findFirst: async () => null } } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never);
  assert.equal(await (unplaced as unknown as { standingGrantCovers(s: unknown, dto: unknown): Promise<boolean> }).standingGrantCovers(
    { workspaceId: 'w', ownerId: OWNER, providerBuiltin: false, provider: 'gone', engine: null },
    { toolName: 'Bash', input: { command: 'npm test', cwd: '/repo' } },
  ), false);
});

test('T2 the reaper watches a configured non-Claude session initialize', async () => {
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const stuck = (over: Record<string, unknown>) => ({
    id: sessionId, taskId: null, assignedRunnerId: '33333333-3333-4333-8333-333333333333',
    status: RunStatus.RUNNING, runtimeSessionId: null, lastTurnAt: new Date(Date.now() - 3 * 60_000),
    cancelRequestedAt: null, endReason: null, task: null, ownerId: OWNER, providerBuiltin: false,
    assignedRunner: { status: 'ONLINE', lastHeartbeatAt: new Date() }, ...over,
  });
  const sweep = async (session: Record<string, unknown>, db: Record<string, unknown> = {}) => {
    const service = new ReaperService({ session: { findMany: async () => [session] }, ...db } as never, {} as never);
    let reason: string | undefined;
    (service as unknown as { forceFinalize(...args: unknown[]): Promise<void> }).forceFinalize = async (...args: unknown[]) => {
      reason = args[3] as string;
    };
    await (service as unknown as { sweep(): Promise<void> }).sweep();
    return reason;
  };
  // A Kimi session on a Moonshot key never initialized its runtime: reaped as Kimi's. Read as the
  // Claude its slug used to stand for, it was never watched at all.
  assert.equal(await sweep(stuck({ provider: 'moonshot-key', engine: AgentProvider.KIMI })), 'kimi runtime not initialized');
  // One an older replica wrote, by its key's runtime.
  assert.equal(
    await sweep(stuck({ provider: 'moonshot-key', engine: null }), { modelProvider: { findFirst: async () => ({ runtime: 'kimi' }) } }),
    'kimi runtime not initialized',
  );
  // Claude Code pre-generates its id, so a Claude session on a key is not this watchdog's.
  assert.equal(await sweep(stuck({ provider: 'anthropic-key', engine: AgentProvider.CLAUDE })), undefined);
});
