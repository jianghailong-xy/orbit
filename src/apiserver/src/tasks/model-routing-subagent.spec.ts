/**
 * routeSubagent (docs/subagent-design.md §4.1, §4.2): the tier rows, Optimize For, each removal reason and
 * each ordering. The router is pure, so every case is a value snapshot in and a decision out — the
 * `fetch` trap below proves no case reaches for the network, and nothing here holds a database.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunnerModelCatalog } from '@orbit/shared';
import {
  familyTier,
  routeSubagent,
  SUBAGENT_ROUTING_POLICY_VERSION,
  type SubagentModelRow,
  type SubagentPoolMember,
  type SubagentProvider,
  type SubagentRoutingInput,
} from './model-routing';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const GPT = 'gpt-5.6';

const CATALOG: RunnerModelCatalog = {
  claude: [
    { value: OPUS, label: 'Opus 5.5', priority: 0 },
    { value: SONNET, label: 'Sonnet 5.5', priority: 2 },
  ],
  codex: [{ value: GPT, label: 'GPT-5.6' }],
  kimi: [{ value: 'kimi-code', label: 'Kimi Code' }],
};

// A sign-in whose quota was read and has every window free, unless `over` says otherwise.
const claude = (over: Partial<SubagentProvider> = {}): SubagentProvider => ({
  slug: 'claude', billing: 'subscription', inScope: true, credential: { kind: 'login', engine: 'claude' }, engines: [{ engine: 'claude' }],
  account: { quota: null }, ...over,
});
const codex = (over: Partial<SubagentProvider> = {}): SubagentProvider => ({
  slug: 'codex', billing: 'subscription', inScope: true, credential: { kind: 'login', engine: 'codex' }, engines: [{ engine: 'codex' }],
  account: { quota: null }, ...over,
});
const key = (slug: string, models: SubagentModelRow[], over: Partial<SubagentProvider> = {}): SubagentProvider => ({
  slug, billing: 'key', inScope: true, credential: { kind: 'key', presetSlug: null }, engines: [{ engine: 'claude', models }], ...over,
});
const DEEPSEEK = key('deepseek', [
  { model: 'deepseek-v4-pro', effort: null, level: 'L', outputPricePerMTok: 1.98 },
  { model: 'deepseek-v4-flash', effort: null, level: 'M', outputPricePerMTok: 0.6 },
]);

function input(over: Partial<SubagentRoutingInput> = {}): SubagentRoutingInput {
  return {
    type: 'general',
    definitionName: 'general',
    caller: {},
    definition: {},
    optimizeFor: 'cost',
    parent: { engine: 'claude', provider: 'claude', model: OPUS, effort: 'high' },
    providers: [claude(), codex(), DEEPSEEK],
    blockedProviders: [],
    engines: {
      claude: { installed: true },
      codex: { installed: true },
    },
    modelCatalog: CATALOG,
    runtimeDefaultModels: { codex: GPT },
    ...over,
  };
}

/** Route with `fetch` booby-trapped: a router that reached for the network would throw here. */
function route(value: SubagentRoutingInput) {
  const original = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('routeSubagent made a network call'); }) as typeof fetch;
  try {
    const decision = routeSubagent(value);
    assert.ok(!(decision instanceof Promise), 'synchronous: nothing awaited');
    return decision;
  } finally {
    globalThis.fetch = original;
  }
}

test('row 1: a model the caller named is used, not routed', () => {
  const decision = route(input({ caller: { model: 'deepseek-v4-pro', size: 'S' }, definition: { model: SONNET, size: 'L' } }));
  assert.equal(decision.tierSource, 'named-model');
  assert.equal(decision.level, null);
  assert.equal(decision.model, 'deepseek-v4-pro');
  assert.equal(decision.provider, 'deepseek');
  assert.equal(decision.engine, 'claude');
  assert.deepEqual(decision.reasons, ['Model named by the caller: deepseek-v4-pro']);
  assert.equal(decision.policyVersion, SUBAGENT_ROUTING_POLICY_VERSION);
});

test('row 2: the definition\'s model id, or inherit, is used, not routed', () => {
  const byId = route(input({ definitionName: 'spec-writer.md', definition: { model: GPT, size: 'S' } }));
  assert.equal(byId.tierSource, 'definition-model');
  assert.equal(byId.level, null);
  assert.deepEqual([byId.provider, byId.engine, byId.model], ['codex', 'codex', GPT]);
  assert.deepEqual(byId.reasons, [`Model set by spec-writer.md: ${GPT}`]);

  const inherit = route(input({ definitionName: 'spec-writer.md', definition: { model: 'inherit' } }));
  assert.equal(inherit.tierSource, 'definition-model');
  assert.deepEqual([inherit.provider, inherit.engine, inherit.model, inherit.effort], ['claude', 'claude', OPUS, 'high']);

  const unknown = route(input({ definitionName: 'spec-writer.md', definition: { model: 'gpt-9-ultra' } }));
  assert.equal(unknown.tierSource, 'type-default', 'an id no provider lists is routed as auto');
  assert.match(unknown.reasons[0], /names gpt-9-ultra, which no enabled provider lists — routed as auto/);
});

test('smart model selection off: no tier is routed, a named model still is', () => {
  // A size, a definition's size, the type's default: none is routed — the SubAgent runs on the parent's.
  for (const over of [{ caller: { size: 'S' as const } }, { definition: { size: 'XL' as const } }, {}]) {
    const off = route(input({ ...over, smartSelection: false }));
    assert.equal(off.tierSource, 'not-routed');
    assert.equal(off.level, null);
    assert.deepEqual([off.provider, off.engine, off.model, off.effort], ['claude', 'claude', OPUS, 'high']);
    assert.deepEqual(off.fallbacks, []);
    assert.deepEqual(off.reasons, [`Route by tier is off: runs on the parent's ${OPUS}`]);
  }
  // A model the caller or the definition names is not a tier: it is used as named.
  const named = route(input({ caller: { model: GPT }, smartSelection: false }));
  assert.equal(named.tierSource, 'named-model');
  assert.deepEqual([named.provider, named.model], ['codex', GPT]);
  const byDefinition = route(input({ definitionName: 'spec-writer.md', definition: { model: GPT }, smartSelection: false }));
  assert.equal(byDefinition.tierSource, 'definition-model');
  assert.equal(byDefinition.model, GPT);
  // Absent reads on, as every input before the switch reached the router.
  assert.equal(route(input({ caller: { size: 'S' } })).tierSource, 'size');
});

test("row 3: the caller's size, over the definition's", () => {
  const decision = route(input({ caller: { size: 'L', sizeReason: 'one service plus its spec' }, definition: { size: 'S' } }));
  assert.equal(decision.tierSource, 'size');
  assert.equal(decision.level, 'L');
  assert.equal(decision.reasons[0], 'Tier L, set by the caller: one service plus its spec');
  assert.deepEqual([decision.model, decision.effort], [OPUS, 'high']);
});

test("row 4: the definition's size", () => {
  const decision = route(input({ definitionName: 'explorer.md', definition: { size: 'XL' } }));
  assert.equal(decision.tierSource, 'definition-size');
  assert.equal(decision.level, 'XL');
  assert.equal(decision.reasons[0], 'Tier XL, set by explorer.md');
  assert.deepEqual([decision.model, decision.effort], [OPUS, 'max']);
});

test('row 5: the built-in default, explore S and everything else M', () => {
  const explore = route(input({ type: 'explore', definitionName: 'explore' }));
  assert.deepEqual([explore.tierSource, explore.level], ['type-default', 'S']);
  assert.equal(explore.reasons[0], 'Tier S: default for explore');
  assert.deepEqual([explore.model, explore.effort], [SONNET, 'low']);
  const general = route(input());
  assert.deepEqual([general.tierSource, general.level], ['type-default', 'M']);
  assert.equal(general.reasons[0], 'Tier M: default for general');
  const named = route(input({ type: 'refactorer', definitionName: 'refactorer.md' }));
  assert.equal(named.level, 'M');
});

test('Optimize For raises only row 5', () => {
  const raise = (optimizeFor: SubagentRoutingInput['optimizeFor'], over: Partial<SubagentRoutingInput> = {}) =>
    route(input({ type: 'explore', definitionName: 'explore', optimizeFor, ...over }));
  assert.equal(raise('cost').level, 'S', 'Cost raises nothing');
  const balance = raise('balance');
  assert.equal(balance.level, 'M');
  assert.equal(balance.reasons[1], 'Tier M: Balance minimum for a SubAgent without a size');
  const intelligence = raise('intelligence');
  assert.equal(intelligence.level, 'L');
  assert.equal(intelligence.reasons[1], 'Tier L: Intelligence minimum for a SubAgent without a size');
  assert.equal(raise('intelligence', { type: 'general', definitionName: 'general' }).level, 'L');
  assert.equal(raise('balance', { type: 'general', definitionName: 'general' }).reasons.length > 1, true);
  // Rows 3 and 4 stand as given, in any mode.
  assert.equal(raise('intelligence', { caller: { size: 'S' } }).level, 'S');
  assert.equal(raise('balance', { caller: { size: 'S' } }).level, 'S');
  assert.equal(raise('intelligence', { definition: { size: 'S' } }).level, 'S');
  assert.equal(raise('balance', { definition: { size: 'S' } }).level, 'S');
  // Rows 1 and 2 have no tier to raise.
  assert.equal(raise('intelligence', { caller: { model: SONNET } }).level, null);
});

test('each removal is recorded with its reason', () => {
  const decision = route(input({
    providers: [
      claude({ slug: 'claude' }),
      codex({ account: { quota: { utilization: 93, window: '5-hour' } } }),
      key('blocked-key', [{ model: 'm', effort: null, level: 'M', outputPricePerMTok: 1 }]),
      key('shared-key', [{ model: 'm', effort: null, level: 'M', outputPricePerMTok: 1 }], { inScope: false }),
      key('opencode-key', [{ model: 'm', effort: null, level: 'M', outputPricePerMTok: 1 }], {
        engines: [{ engine: 'opencode', models: [{ model: 'm', effort: null, level: 'M', outputPricePerMTok: 1 }] }],
      }),
      { slug: 'claude-team', billing: 'subscription', inScope: true, credential: { kind: 'pool', engine: 'claude' }, engines: [{ engine: 'claude' }], account: { paused: true } },
      { slug: 'kimi', billing: 'subscription', inScope: true, credential: { kind: 'login', engine: 'kimi' }, engines: [{ engine: 'kimi' }] },
      key('custom-endpoint', [{ model: 'house-model', effort: null, level: null }]),
      DEEPSEEK,
    ],
    blockedProviders: ['blocked-key'],
    engines: {
      claude: { installed: true, signedOut: true },
      codex: { installed: true },
      kimi: { installed: true },
    },
  }));
  const why = (provider: string) => decision.candidates.filter((c) => c.provider === provider).map((c) => c.reason);
  assert.deepEqual(why('blocked-key'), ['Blocked in the SubAgents settings']);
  assert.deepEqual(why('shared-key'), ['A shared provider, which only admins may use']);
  assert.deepEqual(why('opencode-key'), ["opencode is not installed on the parent's runner"]);
  assert.deepEqual(why('claude'), ["claude is signed out on the parent's runner"]);
  assert.deepEqual(why('codex'), ['The account is at 93% of its 5-hour quota']);
  // An engine or key with no tiers is not removed: its default model joins, after every tiered candidate above it.
  assert.deepEqual(why('kimi'), []);
  assert.deepEqual(why('custom-endpoint'), []);
  // claude-team is signed out through the same engine report before its pause is read; a pause alone:
  const paused = route(input({ providers: [claude({ account: { paused: true } }), DEEPSEEK] }));
  assert.deepEqual(paused.candidates.map((c) => [c.provider, c.reason]), [['claude', 'The account is paused']]);
  assert.deepEqual(why('deepseek'), [], 'what is left is not a removal');
  assert.deepEqual([decision.provider, decision.model], ['deepseek', 'deepseek-v4-flash']);

  const region = route(input({ engines: { claude: { installed: true, regionBlocked: true }, codex: { installed: true } } }));
  assert.deepEqual(region.candidates.filter((c) => c.provider === 'claude').map((c) => c.reason),
    ["claude can’t use Anthropic on the parent's runner"]);
  // Every Anthropic-bound credential on claude goes with it (contract §8); DeepSeek's key and codex stay (⑥).
  const sonnetKey = (slug: string, credential: SubagentProvider['credential']): SubagentProvider => ({
    slug, billing: 'key', inScope: true, credential, engines: [{ engine: 'claude', prices: { [SONNET]: 10 } }],
  });
  const blocked = route(input({
    runnerLabel: 'HPC',
    providers: [
      claude(), codex(),
      sonnetKey('anthropic-key', { kind: 'key', presetSlug: 'anthropic' }),
      sonnetKey('proxy-key', { kind: 'key', presetSlug: null, baseUrl: 'https://API.anthropic.com./v1' }),
      sonnetKey('lookalike-key', { kind: 'key', presetSlug: null, baseUrl: 'https://anthropic.com.example' }),
      pool('team-pool', [{ label: 'bob@team', quota: null }]),
      DEEPSEEK,
    ],
    engines: { claude: { installed: true, regionBlocked: true }, codex: { installed: true } },
  }));
  const out = (provider: string) => blocked.candidates.filter((c) => c.provider === provider).map((c) => c.reason);
  for (const provider of ['claude', 'anthropic-key', 'proxy-key', 'team-pool']) {
    assert.deepEqual(out(provider), ['claude can’t use Anthropic on HPC'], provider);
  }
  assert.deepEqual(out('lookalike-key'), [], 'a look-alike host is not Anthropic');
  assert.deepEqual(out('deepseek'), []);
  assert.deepEqual(out('codex'), []);
  assert.equal(blocked.provider, 'codex', 'a subscription first (Cost), and not an Anthropic one');
  const keysOnly = route(input({ runnerLabel: 'HPC', providers: [claude(), sonnetKey('anthropic-key', { kind: 'key', presetSlug: 'anthropic' }), DEEPSEEK],
    engines: { claude: { installed: true, regionBlocked: true } } }));
  assert.equal(keysOnly.provider, 'deepseek', 'on claude alone the DeepSeek key runs it');
  const missing = route(input({ engines: { claude: { installed: true } } }));
  assert.deepEqual(missing.candidates.filter((c) => c.provider === 'codex').map((c) => c.reason),
    ["codex is not installed on the parent's runner"]);
  const atLimit = route(input({ providers: [claude({ account: { quota: { utilization: 90, window: 'weekly' } } })] }));
  assert.deepEqual(atLimit.candidates.map((c) => c.reason), ['The account is at 90% of its weekly quota'], 'at the limit is out');
  assert.equal(atLimit.model, null, 'an empty pool picks nothing');
  assert.match(atLimit.reasons.at(-1)!, /NO_SUBAGENT_PROVIDER/);
});

test("Kimi's sign-in is routed through the built-in tier table, weighed by its quota like the others", () => {
  const kimi = (quota: number): SubagentProvider => ({
    slug: 'kimi', billing: 'subscription', inScope: true, credential: { kind: 'login', engine: 'kimi' }, engines: [{ engine: 'kimi' }],
    account: { quota: { utilization: quota, window: '5-hour' }, paused: false },
  });
  const catalog = (...values: string[]): RunnerModelCatalog => ({ ...CATALOG, kimi: values.map((value) => ({ value, label: value })) });
  const at = (level: 'S' | 'M' | 'L' | 'XL', modelCatalog: RunnerModelCatalog) => route(input({
    caller: { size: level },
    providers: [codex({ account: { quota: { utilization: 40, window: '5-hour' } } }), kimi(10)],
    engines: { claude: { installed: true }, codex: { installed: true }, kimi: { installed: true } },
    modelCatalog,
  }));
  const full = catalog('kimi-code/kimi-for-coding', 'kimi-code/k3', 'kimi-code/k3.1-pro');
  assert.deepEqual(['S', 'M', 'L', 'XL'].map((level) => {
    const d = at(level as 'S', full);
    return [d.provider, d.model, d.effort];
  }), [
    ['kimi', 'kimi-code/k3', 'low'],
    ['kimi', 'kimi-code/k3', 'high'],
    ['kimi', 'kimi-code/k3.1-pro', 'high'],
    ['kimi', 'kimi-code/k3.1-pro', 'max'],
  ], 'more headroom than Codex: Kimi is picked at every tier');
  // Without K3.1 Pro on the runner, L and XL fall back to K3.
  const k3Only = at('XL', catalog('kimi-code/k3'));
  assert.deepEqual([k3Only.model, k3Only.effort], ['kimi-code/k3', 'max']);
  // Less headroom than Codex: Codex first, Kimi its fallback.
  const busy = route(input({
    caller: { size: 'M' },
    providers: [codex({ account: { quota: { utilization: 40, window: '5-hour' } } }), kimi(70)],
    engines: { claude: { installed: true }, codex: { installed: true }, kimi: { installed: true } },
    modelCatalog: full,
  }));
  assert.equal(busy.provider, 'codex');
  assert.deepEqual(busy.fallbacks.map((f) => [f.provider, f.model, f.effort]), [
    ['kimi', 'kimi-code/k3', 'high'],
    ['codex', GPT, 'high'], ['kimi', 'kimi-code/k3.1-pro', 'high'],
    ['codex', GPT, 'xhigh'], ['kimi', 'kimi-code/k3.1-pro', 'max'],
    ['codex', GPT, 'low'], ['kimi', 'kimi-code/k3', 'low'],
  ]);
  // At the quota limit, or signed out, it is removed with the reason, as Claude and Codex are.
  const spent = route(input({ caller: { size: 'M' }, providers: [codex(), kimi(95)], engines: { codex: { installed: true }, kimi: { installed: true } }, modelCatalog: full }));
  assert.deepEqual(spent.candidates.filter((c) => c.provider === 'kimi').map((c) => c.reason), ['The account is at 95% of its 5-hour quota']);
  const out = route(input({ caller: { size: 'M' }, providers: [codex(), kimi(0)], engines: { codex: { installed: true }, kimi: { installed: true, signedOut: true } }, modelCatalog: full }));
  assert.deepEqual(out.candidates.filter((c) => c.provider === 'kimi').map((c) => c.reason), ["kimi is signed out on the parent's runner"]);
});

test('every registered provider joins: the asked tier, then higher tiers, then untiered defaults, then lower tiers', () => {
  const engines = { claude: { installed: true }, codex: { installed: true }, cursor: { installed: true }, opencode: { installed: true } };
  const cursor: SubagentProvider = {
    slug: 'cursor', billing: 'subscription', inScope: true, credential: { kind: 'login', engine: 'cursor' }, engines: [{ engine: 'cursor' }],
    account: { quota: null },
  };
  const opencode: SubagentProvider = {
    slug: 'opencode', billing: 'key', inScope: true, credential: { kind: 'opencode' }, engines: [{ engine: 'opencode' }],
  };
  const local = key('local-vllm', [
    { model: 'qwen-a', effort: null, level: null },
    { model: 'qwen-b', effort: null, level: null },
  ], { engines: [{ engine: 'claude', defaultModel: 'qwen-b', models: [
    { model: 'qwen-a', effort: null, level: null },
    { model: 'qwen-b', effort: null, level: null },
  ] }] });
  const lonely = key('l-only', [{ model: 'big', effort: null, level: 'L', outputPricePerMTok: 5 }]);
  const small = key('s-only', [{ model: 'tiny', effort: null, level: 'S', outputPricePerMTok: 0.1 }]);
  const modelCatalog: RunnerModelCatalog = {
    ...CATALOG,
    // No model of a known family (MODEL_FAMILY_TIERS): Cursor stays untiered here.
    cursor: [{ value: 'default', label: 'Auto' }, { value: 'muse-spark-1.3', label: 'Muse Spark 1.3' }],
    opencode: [{ value: 'opencode/free-a', label: 'A' }, { value: 'opencode/free-b', label: 'B' }],
  };
  const decision = route(input({
    caller: { size: 'M' }, providers: [small, cursor, opencode, local, lonely], engines, modelCatalog,
    runtimeDefaultModels: { codex: GPT, opencode: 'opencode/free-b' },
  }));
  // No M candidate: the nearest tier above wins over an untiered subscription.
  assert.deepEqual([decision.provider, decision.model], ['l-only', 'big']);
  assert.equal(decision.reasons[1], 'Nothing in tier M can run: the nearest tier above that can is L');
  assert.deepEqual(decision.fallbacks.map((f) => [f.provider, f.model]), [
    ['cursor', 'default'],
    ['opencode', 'opencode/free-b'],
    ['local-vllm', 'qwen-b'],
    ['s-only', 'tiny'],
  ], 'untiered: the subscription first (Cost), then the keys by owner order; the runner default, else the provider default; S last');
  // The rest of an untiered engine's list is recorded, reachable by name.
  assert.deepEqual(decision.candidates.map((c) => [c.provider, c.model, c.reason]), [
    ['cursor', 'muse-spark-1.3', 'The model has no tier; cursor runs default'],
    ['opencode', 'opencode/free-a', 'The model has no tier; opencode runs opencode/free-b'],
    ['local-vllm', 'qwen-a', 'The model has no tier; local-vllm runs qwen-b'],
  ]);
  const untiered = route(input({ caller: { size: 'L' }, providers: [small, cursor], engines, modelCatalog }));
  assert.deepEqual([untiered.provider, untiered.model, untiered.effort], ['cursor', 'default', null]);
  assert.equal(untiered.reasons[1], 'Nothing in tier L or above can run: default is the default model of cursor (cursor), which has no tiers');
  const lower = route(input({ caller: { size: 'XL' }, providers: [small], engines, modelCatalog }));
  assert.equal(lower.reasons[1], 'Nothing in tier XL or above, and no untiered model, can run: the nearest tier below is S');
  assert.equal(lower.model, 'tiny');
});

test('an engine with no tier table of its own is tiered by family: the newest of each, at the effort its model takes', () => {
  const login = (slug: string): SubagentProvider => ({
    slug, billing: 'subscription', inScope: true, credential: { kind: 'login', engine: slug as 'cursor' }, engines: [{ engine: slug }],
    account: { quota: null },
  });
  const ladder = ['low', 'medium', 'high', 'xhigh', 'max'];
  const modelCatalog: RunnerModelCatalog = {
    // Cursor's order is not a version order; a release the table never named (5-6) is still the newest Opus.
    cursor: [
      { value: 'default', label: 'Auto' },
      { value: 'claude-opus-5-5', label: 'Opus 5.5', reasoningLevels: ladder },
      { value: 'claude-opus-5-6', label: 'Opus 5.6', reasoningLevels: ladder },
      { value: 'claude-opus-4-8', label: 'Opus 4.8', reasoningLevels: ladder },
      { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', reasoningLevels: ['low', 'medium', 'high'] },
      { value: 'composer-2.5', label: 'Composer 2.5' },
      { value: 'claude-haiku-5-5', label: 'Haiku 5.5', reasoningLevels: ['low', 'medium', 'high'] },
      { value: 'kimi-k2.6', label: 'Kimi K2.6' },
      { value: 'kimi-k3', label: 'Kimi K3', reasoningLevels: ['low', 'medium', 'high'] },
    ],
    // agy takes low, medium and high only: XL's max comes down to high.
    antigravity: [
      { value: 'gemini-4-neon', label: 'Gemini 4 Neon', reasoningLevels: ['low', 'medium', 'high'] },
      { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', reasoningLevels: ['low', 'medium', 'high'] },
      { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', reasoningLevels: ['low', 'medium', 'high'] },
      { value: 'gemini-pro-orchestrator-neon', label: 'Orchestrator' },
    ],
  };
  const engines = { cursor: { installed: true }, antigravity: { installed: true } };
  const at = (size: 'S' | 'M' | 'L' | 'XL', slug: string) => {
    const d = route(input({ caller: { size }, providers: [login(slug)], engines, modelCatalog }));
    return [d.model, d.effort, d.pickLevel];
  };
  assert.deepEqual(at('XL', 'cursor'), ['claude-opus-5-6', 'max', 'XL']);
  assert.deepEqual(at('L', 'cursor'), ['claude-opus-5-6', 'high', 'L']);
  assert.deepEqual(at('M', 'cursor'), ['claude-sonnet-5-5', 'medium', 'M']);
  assert.deepEqual(at('S', 'cursor'), ['claude-sonnet-5-5', 'low', 'S'], 'Sonnet before Composer in the same tier');
  assert.deepEqual(at('XL', 'antigravity'), ['gemini-4-neon', 'high', 'XL']);
  assert.deepEqual(at('M', 'antigravity'), ['gemini-3.8-flash', 'medium', 'M']);
  // Haiku, Kimi and the K3 stand-in come after Sonnet/Opus; K3 stands in at L/XL while no K3.1 Pro is listed.
  const tiers = (catalog: RunnerModelCatalog['cursor']) => route(input({
    caller: { size: 'S' }, providers: [login('cursor')], engines, modelCatalog: { ...modelCatalog, cursor: catalog },
  })).fallbacks.map((f) => [f.model, f.effort, f.level]);
  const base = modelCatalog.cursor!;
  const withoutPro = tiers(base);
  assert.ok(withoutPro.some((r) => r[0] === 'claude-haiku-5-5' && r[1] === 'low' && r[2] === 'S'));
  assert.ok(withoutPro.some((r) => r[0] === 'kimi-k3' && r[1] === 'low' && r[2] === 'S'));
  assert.ok(withoutPro.some((r) => r[0] === 'kimi-k3' && r[1] === 'high' && r[2] === 'M'));
  assert.ok(withoutPro.some((r) => r[0] === 'kimi-k3' && r[1] === 'high' && r[2] === 'L'));
  assert.ok(withoutPro.some((r) => r[0] === 'kimi-k3' && r[1] === 'high' && r[2] === 'XL'), 'clamped to its top level');
  assert.ok(!withoutPro.some((r) => r[0] === 'kimi-k2.6' && r[2]), 'kimi-k2.* stays untiered');
  const withPro = tiers([...base, { value: 'kimi-k3.1-pro', label: 'K3.1 Pro', reasoningLevels: ['low', 'medium', 'high', 'max'] }]);
  assert.ok(withPro.some((r) => r[0] === 'kimi-k3.1-pro' && r[1] === 'high' && r[2] === 'L'));
  assert.ok(withPro.some((r) => r[0] === 'kimi-k3.1-pro' && r[1] === 'max' && r[2] === 'XL'));
  assert.ok(!withPro.some((r) => r[0] === 'kimi-k3' && (r[2] === 'L' || r[2] === 'XL')), 'no stand-in once Pro is listed');
  assert.ok(withPro.some((r) => r[0] === 'kimi-k3' && r[2] === 'M'));
  // A tiered engine now meets Claude in the same tier rather than after every higher one.
  const both = route(input({ caller: { size: 'L' }, providers: [claude(), login('cursor')], engines: { ...engines, claude: { installed: true } }, modelCatalog: { ...CATALOG, ...modelCatalog } }));
  assert.deepEqual(both.fallbacks.map((f) => [f.provider, f.model, f.level]).slice(0, 1), [['cursor', 'claude-opus-5-6', 'L']]);
  // Models of no family stay untiered, reachable by name.
  const cursorDrop = route(input({ caller: { size: 'M' }, providers: [login('cursor')], engines, modelCatalog })).candidates;
  assert.ok(cursorDrop.some((c) => c.model === 'default' && c.reason === 'The model has no tier'));
});

test('an owner tier on a built-in engine: a model of no family routes at it, overrides a family tier, and clears', () => {
  const login = (slug: string): SubagentProvider => ({
    slug, billing: 'subscription', inScope: true, credential: { kind: 'login', engine: slug as 'cursor' }, engines: [{ engine: slug }],
    account: { quota: null },
  });
  const modelCatalog: RunnerModelCatalog = {
    cursor: [
      { value: 'default', label: 'Auto' },
      { value: 'muse-spark-1.3', label: 'Muse Spark 1.3', reasoningLevels: ['low', 'medium', 'high'] },
      { value: 'claude-opus-5-6', label: 'Opus 5.6', reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', reasoningLevels: ['low', 'medium', 'high'] },
    ],
  };
  const engines = { cursor: { installed: true } };
  const at = (size: 'S' | 'M' | 'L' | 'XL', builtinModelTiers?: SubagentRoutingInput['builtinModelTiers']) => {
    const d = route(input({ caller: { size }, providers: [login('cursor')], engines, modelCatalog, builtinModelTiers }));
    return [d.model, d.effort, d.pickLevel];
  };
  // Only models of no family: Cursor is untiered, and runs its default model.
  const bare = { cursor: modelCatalog.cursor!.slice(0, 2) };
  const plain = (size: 'S' | 'XL', builtinModelTiers?: SubagentRoutingInput['builtinModelTiers']) =>
    route(input({ caller: { size }, providers: [login('cursor')], engines, modelCatalog: bare, builtinModelTiers }));
  assert.deepEqual([plain('XL').model, plain('XL').pickLevel], ['default', null]);
  assert.ok(plain('XL').candidates.some((c) => c.model === 'muse-spark-1.3' && c.reason === 'The model has no tier; cursor runs default'));

  // The owner tiers muse-spark-1.3 XL: it routes there, at XL's max clamped to the highest level it reports.
  const muse = { cursor: { 'muse-spark-1.3': 'XL' as const } };
  const routed = plain('XL', muse);
  assert.deepEqual([routed.model, routed.effort, routed.pickLevel], ['muse-spark-1.3', 'high', 'XL']);
  assert.equal(routed.candidates.some((c) => c.model === 'muse-spark-1.3'), false, 'no longer removed');
  assert.deepEqual([plain('S', muse).model, plain('S', muse).pickLevel], ['muse-spark-1.3', 'XL'], 'its only tier: a higher one at S');
  // Beside the family tiers it joins its tier after the table's rows.
  const beside = route(input({ caller: { size: 'XL' }, providers: [login('cursor')], engines, modelCatalog, builtinModelTiers: muse }));
  assert.deepEqual([beside.model, beside.effort], ['claude-opus-5-6', 'max']);
  assert.deepEqual(beside.fallbacks.slice(0, 1).map((f) => [f.model, f.effort, f.level]), [['muse-spark-1.3', 'high', 'XL']]);

  // An owner tier on a family model overrides the family's: Opus at S only, so XL falls to muse-spark, Opus answers S.
  const opusS = { cursor: { 'claude-opus-5-6': 'S' as const, 'muse-spark-1.3': 'XL' as const } };
  assert.deepEqual(at('XL', opusS), ['muse-spark-1.3', 'high', 'XL']);
  assert.deepEqual(at('L', opusS), ['muse-spark-1.3', 'high', 'XL'], 'no L left: the next tier up');
  const s = route(input({ caller: { size: 'S' }, providers: [login('cursor')], engines, modelCatalog, builtinModelTiers: opusS }));
  assert.deepEqual([s.model, s.effort], ['claude-sonnet-5-5', 'low'], 'the table rows keep their order ahead of the owner rows');
  assert.ok(s.fallbacks.some((f) => f.model === 'claude-opus-5-6' && f.level === 'S' && f.effort === 'low'));
  assert.equal(s.fallbacks.some((f) => f.model === 'claude-opus-5-6' && f.level !== 'S'), false, 'Opus keeps no family row');

  // Cleared (absent from the map, or another engine's): the family tiers again, muse-spark untiered.
  const clears: Array<SubagentRoutingInput['builtinModelTiers']> = [undefined, {}, { cursor: {} }, { antigravity: { 'muse-spark-1.3': 'XL' } }];
  for (const cleared of clears) {
    assert.deepEqual(at('XL', cleared), ['claude-opus-5-6', 'max', 'XL']);
    assert.deepEqual(at('L', cleared), ['claude-opus-5-6', 'high', 'L']);
  }
  // A tier for a model the catalogue does not report adds nothing.
  assert.deepEqual(at('XL', { cursor: { 'kimi-k3': 'XL' } }), ['claude-opus-5-6', 'max', 'XL']);
});

test('owner tiers apply to the tabled engines too, and with none set Claude, Codex and Kimi rows are unchanged', () => {
  const kimi: SubagentProvider = {
    slug: 'kimi', billing: 'subscription', inScope: true, credential: { kind: 'login', engine: 'kimi' }, engines: [{ engine: 'kimi' }],
    account: { quota: null },
  };
  const modelCatalog: RunnerModelCatalog = {
    ...CATALOG,
    codex: [{ value: GPT, label: 'GPT-5.6', reasoningLevels: ['low', 'medium', 'high', 'xhigh'] }, { value: 'gpt-5.6-mini', label: 'Mini' }],
    kimi: [{ value: 'kimi-code/k3', label: 'K3' }, { value: 'kimi-code/k3.1-pro', label: 'K3.1 Pro' }],
  };
  const engines = { claude: { installed: true }, codex: { installed: true }, kimi: { installed: true } };
  const picks = (builtinModelTiers?: SubagentRoutingInput['builtinModelTiers']) =>
    (['S', 'M', 'L', 'XL'] as const).flatMap((size) => [claude(), codex(), kimi].map((provider) => {
      const d = route(input({ caller: { size }, providers: [provider], engines, modelCatalog, builtinModelTiers }));
      return JSON.stringify([size, d.provider, d.model, d.effort, d.pickLevel, d.reasons, d.candidates, d.fallbacks]);
    }));
  const none = picks();
  assert.deepEqual(picks({}), none, 'an empty map is no map');
  assert.deepEqual(picks({ cursor: { 'muse-spark-1.3': 'XL' } }), none, "another engine's tiers change nothing here");
  assert.deepEqual(none.map((line) => JSON.parse(line).slice(0, 5)), [
    ['S', 'claude', SONNET, 'low', 'S'], ['S', 'codex', GPT, 'low', 'S'], ['S', 'kimi', 'kimi-code/k3', 'low', 'S'],
    ['M', 'claude', SONNET, 'medium', 'M'], ['M', 'codex', GPT, 'medium', 'M'], ['M', 'kimi', 'kimi-code/k3', 'high', 'M'],
    ['L', 'claude', OPUS, 'high', 'L'], ['L', 'codex', GPT, 'high', 'L'], ['L', 'kimi', 'kimi-code/k3.1-pro', 'high', 'L'],
    ['XL', 'claude', OPUS, 'max', 'XL'], ['XL', 'codex', GPT, 'xhigh', 'XL'], ['XL', 'kimi', 'kimi-code/k3.1-pro', 'max', 'XL'],
  ]);
  // Set: a Codex model the table leaves untiered joins at the owner's tier, effort clamped (none reported: null).
  const mini = route(input({ caller: { size: 'S' }, providers: [codex()], engines, modelCatalog,
    builtinModelTiers: { codex: { 'gpt-5.6-mini': 'S' } } }));
  assert.ok(mini.fallbacks.some((f) => f.model === 'gpt-5.6-mini' && f.level === 'S' && f.effort === null));
  // And a tabled model the owner tiers takes only the owner's tier: Opus at M, so XL falls back to the tier below.
  const opusM = route(input({ caller: { size: 'XL' }, providers: [claude()], engines, modelCatalog,
    builtinModelTiers: { claude: { [OPUS]: 'M' } } }));
  assert.deepEqual([opusM.model, opusM.pickLevel], [SONNET, 'M'], 'nothing at XL or L: the tier below, the table row first');
  assert.deepEqual(opusM.fallbacks.filter((f) => f.model === OPUS).map((f) => [f.effort, f.level]), [[null, 'M']],
    'Opus at M only, and no levels reported: no effort');
});

test('measured families (2026-11-21) tier Cursor and Antigravity models after the ones already ranked', () => {
  const login = (slug: string): SubagentProvider => ({
    slug, billing: 'subscription', inScope: true, credential: { kind: 'login', engine: slug as 'cursor' }, engines: [{ engine: slug }],
    account: { quota: null },
  });
  const ladder = ['low', 'medium', 'high', 'xhigh', 'max'];
  const modelCatalog: RunnerModelCatalog = {
    cursor: [
      { value: 'claude-opus-5-5', label: 'Opus 5.5', reasoningLevels: ladder },
      { value: 'claude-fable-5-2', label: 'Fable 5.2', reasoningLevels: ladder },
      { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', reasoningLevels: ladder },
      { value: 'grok-4.7', label: 'Grok 4.7', reasoningLevels: ['low', 'medium', 'high'] },
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    ],
    antigravity: [
      { value: 'gemini-4-neon', label: 'Gemini 4 Neon', reasoningLevels: ['low', 'medium', 'high'] },
      { value: 'gemini-pro-orchestrator-neon', label: 'Orchestrator', reasoningLevels: ['low', 'medium', 'high'] },
      { value: 'gemini-pro-orchestrator-g1-pro', label: 'Orchestrator G1' },
      { value: 'gpt-oss-120b', label: 'GPT-OSS 120B' },
    ],
  };
  const engines = { cursor: { installed: true }, antigravity: { installed: true } };
  const at = (size: 'S' | 'M' | 'L' | 'XL', slug: string) =>
    route(input({ caller: { size }, providers: [login(slug)], engines, modelCatalog }));
  // At L the ranked Opus still wins; Fable is its fallback at the same tier.
  const l = at('L', 'cursor');
  assert.deepEqual([l.model, l.pickLevel], ['claude-opus-5-5', 'L']);
  assert.deepEqual(l.fallbacks.filter((f) => f.level === 'L').map((f) => f.model), ['claude-fable-5-2']);
  // At S Sonnet first, then the measured S families in table order.
  const s = at('S', 'cursor');
  assert.equal(s.model, 'claude-sonnet-5-5');
  assert.deepEqual(s.fallbacks.filter((f) => f.level === 'S').map((f) => [f.model, f.effort]),
    [['grok-4.7', 'low'], ['gpt-5.6-sol', null], ['gpt-5.6-luna', null]]);
  // Antigravity: Neon first at L, the measured Orchestrator after it; G1 and gpt-oss stay untiered.
  const ag = at('L', 'antigravity');
  assert.equal(ag.model, 'gemini-4-neon');
  assert.deepEqual(ag.fallbacks.filter((f) => f.level === 'L').map((f) => f.model), ['gemini-pro-orchestrator-neon']);
  const removed = ag.candidates.filter((c) => c.reason === 'The model has no tier').map((c) => c.model);
  assert.ok(removed.includes('gpt-oss-120b') && removed.includes('gemini-pro-orchestrator-g1-pro'), removed.join(','));
});

test('familyTier: a key model of a known family takes the lowest tier of the family; any other none', () => {
  assert.equal(familyTier('claude-opus-5-6'), 'L');
  assert.equal(familyTier('claude-sonnet-4-5'), 'S');
  assert.equal(familyTier('gemini-3.8-flash'), 'S');
  assert.equal(familyTier('gemini-4-argon'), 'L');
  assert.equal(familyTier('claude-haiku-5-5'), 'S');
  assert.equal(familyTier('kimi-k3'), 'S');
  assert.equal(familyTier('kimi-k3.1-pro'), 'L');
  assert.equal(familyTier('kimi-k2.6'), null);
  assert.equal(familyTier('qwen3.8-27b-uncensored-fp8'), null);
  // Measured 2026-11-21: tiered since, pinned to the measured ids.
  assert.equal(familyTier('gemini-pro-orchestrator-neon'), 'L');
  assert.equal(familyTier('gemini-pro-orchestrator-g1-pro'), null);
  assert.equal(familyTier('claude-fable-5-2'), 'L');
  assert.equal(familyTier('deepseek-flash'), 'S');
  assert.equal(familyTier('deepseek-v4-flash'), null);
  assert.equal(familyTier('grok-4.7'), 'S');
  assert.equal(familyTier('gpt-5.6-sol'), 'S');
  assert.equal(familyTier('gpt-5.6-luna'), 'S');
  assert.equal(familyTier('gpt-6.2-sol'), null);
  assert.equal(familyTier('gpt-oss-120b'), null);
});

test('a subscription whose quota was not read ranks after those whose headroom is known, before metered keys in Cost', () => {
  const blind = codex({ account: { quota: null, unreadable: true } });
  const half = claude({ account: { quota: { utilization: 50, window: '5-hour' } } });
  const cost = route(input({ providers: [blind, half, DEEPSEEK] }));
  assert.equal(cost.provider, 'claude', 'known headroom first, even half spent');
  assert.deepEqual(cost.fallbacks.slice(0, 2).map((f) => [f.provider, f.note]), [
    ['codex', 'subscription, quota unknown'],
    ['deepseek', 'key at $0.6/M output tokens'],
  ]);
  // No account read at all (an engine whose quota no runner reports) is unknown too.
  const unread = route(input({ providers: [codex({ account: undefined }), DEEPSEEK] }));
  assert.equal(unread.provider, 'codex');
  assert.match(unread.reasons.find((r) => r.startsWith('Picked'))!, /a subscription whose quota was not read, used before any metered key/);
  // Balance too: a subscription, read or not, before any metered key.
  const balance = route(input({ optimizeFor: 'balance', providers: [DEEPSEEK, blind] }));
  assert.equal(balance.provider, 'codex');
});

test('quota that goes to waste first is spent first: nearly spent last, then the soonest expiry, then headroom', () => {
  const HOUR = 3_600_000;
  const T0 = Date.UTC(2026, 10, 19, 12, 0);
  const kimi = (utilization: number, expiresAt: number | null, nearLimit = false): SubagentProvider => ({
    slug: 'kimi', billing: 'subscription', inScope: true, credential: { kind: 'login', engine: 'kimi' }, engines: [{ engine: 'kimi' }],
    account: { quota: { utilization, window: 'monthly' }, expiresAt, nearLimit },
  });
  const soon = codex({ account: { quota: { utilization: 60, window: 'weekly' }, expiresAt: T0 + 3 * HOUR } });
  const engines = { claude: { installed: true }, codex: { installed: true }, kimi: { installed: true } };
  const modelCatalog: RunnerModelCatalog = { ...CATALOG, kimi: [{ value: 'kimi-code/k3', label: 'K3' }] };
  const at = (optimizeFor: 'cost' | 'balance' | 'intelligence', providers: SubagentProvider[]) =>
    route(input({ optimizeFor, providers, engines, modelCatalog }));

  // Codex has less left, but it resets in 3 hours; Kimi's lasts 20 days.
  const cost = at('cost', [kimi(10, T0 + 480 * HOUR), soon, DEEPSEEK]);
  assert.equal(cost.provider, 'codex');
  assert.match(cost.reasons.find((r) => r.startsWith('Picked'))!,
    /a subscription with 40% of its quota left until 2026-11-19T15:00Z, used before any metered key/);
  assert.equal(cost.fallbacks[0].provider, 'kimi');
  // A nearly spent window goes last, however soon it resets.
  assert.equal(at('cost', [kimi(10, T0 + 480 * HOUR), codex({ account: { ...soon.account, nearLimit: true } })]).provider, 'kimi');
  // No reset known counts as never: after one that has one, then by headroom as before.
  assert.equal(at('cost', [kimi(10, null), soon]).provider, 'codex');
  assert.equal(at('cost', [kimi(10, null), codex({ account: { quota: { utilization: 60, window: 'weekly' } } })]).provider, 'kimi');

  // Balance chooses the model first (policy p7, owner 2026-11-22): DeepSeek's model has only a metered key, so the next
  // model in the owner's order with a subscription takes over — Kimi's, though Codex's resets sooner. (Until p6 Balance
  // ranked as Cost and picked Codex here.) Expiry still orders the accounts of one model: see `twins` below.
  const balance = at('balance', [DEEPSEEK, kimi(10, T0 + 480 * HOUR), soon]);
  assert.equal(balance.provider, 'kimi');
  assert.match(balance.reasons.find((r) => r.startsWith('Picked'))!,
    /\(Balance\): model kimi-code\/k3, takes over tier M from the preferred deepseek-v4-flash, which has only metered keys; account kimi: the only account that can run it, a subscription with 90% of its quota left until 2026-12-09T12:00Z$/);
  assert.equal(at('balance', [DEEPSEEK, codex({ account: { quota: { utilization: 60, window: 'weekly' } } })]).provider, 'codex');

  // Intelligence: the stronger model first; expiry only between equals.
  const lOnly: SubagentProvider = {
    slug: 'team-token', billing: 'subscription', inScope: true, credential: { kind: 'key', presetSlug: null },
    engines: [{ engine: 'claude', models: [{ model: 'mid-model', effort: null, level: 'L' }] }],
    account: { quota: null, expiresAt: T0 + HOUR },
  };
  const strong = at('intelligence', [lOnly, claude({ account: { quota: null, expiresAt: T0 + 400 * HOUR } })]);
  assert.equal(strong.model, OPUS, 'Opus reaches XL; it leads tier L over a model that reaches L, whatever expires first');
  const twins = route(input({ optimizeFor: 'balance', caller: { size: 'M' }, engines, modelCatalog,
    providers: [codex({ slug: 'codex-late', account: { quota: null, expiresAt: T0 + 100 * HOUR } }), codex({ slug: 'codex-soon', account: { quota: null, expiresAt: T0 + HOUR } })] }));
  assert.equal(twins.provider, 'codex-soon');

  // An account pool runs on its member whose quota goes first.
  const crew = pool('crew', [
    { label: 'late@team', quota: { utilization: 10, window: 'weekly' }, expiresAt: T0 + 150 * HOUR },
    { label: 'soon@team', quota: { utilization: 50, window: 'weekly' }, expiresAt: T0 + 2 * HOUR },
  ], 'codex');
  assert.equal(at('cost', [crew]).note, 'subscription pool, soon@team with 50% quota left');
});

test("Opus's own weekly window at the limit takes Opus out on that account; Sonnet still runs there", () => {
  const blocked = route(input({ caller: { size: 'L' }, providers: [claude({ account: { quota: null, opusUtilization: 95 } })] }));
  assert.deepEqual([blocked.provider, blocked.model, blocked.effort], ['claude', SONNET, 'medium'], 'the nearest tier below');
  assert.deepEqual([...new Set(blocked.candidates.filter((c) => c.model === OPUS).map((c) => c.reason))],
    ["Opus's weekly quota is at 95% on this account"]);
  assert.equal(blocked.reasons[1], 'Nothing in tier L or above, and no untiered model, can run: the nearest tier below is M');
  const open = route(input({ caller: { size: 'L' }, providers: [claude({ account: { quota: null, opusUtilization: 60 } })] }));
  assert.deepEqual([open.model, open.effort], [OPUS, 'high'], 'under the limit, Opus as before');
});

test("a runner's signed-out sign-in removes only that sign-in, not a subscription key that runs on its own token", () => {
  const token: SubagentProvider = {
    slug: 'team-token', billing: 'subscription', inScope: true, credential: { kind: 'key', presetSlug: 'anthropic' },
    engines: [{ engine: 'claude', prices: {} }], account: { quota: { utilization: 20, window: 'weekly' } },
  };
  const decision = route(input({ providers: [claude(), token], engines: { claude: { installed: true, signedOut: true }, codex: { installed: true } } }));
  assert.deepEqual(decision.candidates.filter((c) => c.engine === 'claude' && c.model === null).map((c) => [c.provider, c.reason]),
    [['claude', "claude is signed out on the parent's runner"]]);
  assert.deepEqual([decision.provider, decision.model], ['team-token', SONNET]);
});

test('a named model runs on the first provider that can run it, the rest its fallbacks; refused when none can', () => {
  const anthropic: SubagentProvider = {
    slug: 'anthropic-key', billing: 'key', inScope: true, credential: { kind: 'key', presetSlug: 'anthropic' },
    engines: [{ engine: 'claude', prices: { [OPUS]: 20 } }],
  };
  const spent = claude({ account: { quota: { utilization: 95, window: 'weekly' } } });
  const moved = route(input({ caller: { model: OPUS }, providers: [spent, anthropic] }));
  assert.deepEqual([moved.provider, moved.model, moved.tierSource], ['anthropic-key', OPUS, 'named-model']);
  assert.deepEqual(moved.candidates.map((c) => [c.provider, c.reason]), [['claude', 'The account is at 95% of its weekly quota']]);
  const both = route(input({ caller: { model: OPUS }, providers: [claude(), anthropic] }));
  assert.deepEqual([both.provider, both.fallbacks.map((f) => [f.provider, f.model])], ['claude', [['anthropic-key', OPUS]]]);
  const none = route(input({ caller: { model: OPUS }, providers: [spent] }));
  assert.deepEqual([none.provider, none.model], [null, null]);
  assert.deepEqual(none.reasons, [`Model named by the caller: ${OPUS}`, `No usable provider on the parent's runner offers ${OPUS}`]);
  // Nobody lists it at all: the parent's own provider runs it as named, as before.
  const unknown = route(input({ caller: { model: 'house-model-9' } }));
  assert.deepEqual([unknown.provider, unknown.model], ['claude', 'house-model-9']);
  // A definition's model that no usable provider can run is routed as auto, and says why.
  const definitionSpent = route(input({ definitionName: 'opus.md', definition: { model: OPUS }, providers: [spent, codex()] }));
  assert.equal(definitionSpent.tierSource, 'type-default');
  assert.equal(definitionSpent.reasons[0], `opus.md names ${OPUS}, which no usable provider can run — routed as auto`);
});

test("an untiered provider runs the runner's default for its engine, else its own default, else its first model, each only if listed", () => {
  const engines = { claude: { installed: true }, codex: { installed: true }, opencode: { installed: true } };
  const own = (defaultModel: string | null): SubagentProvider => key('own', [], {
    engines: [{ engine: 'opencode', defaultModel, models: [
      { model: 'a', effort: null, level: null }, { model: 'b', effort: null, level: null }, { model: 'c', effort: null, level: null },
    ] }],
  });
  const pick = (defaultModel: string | null, runnerDefault?: string) => route(input({
    caller: { size: 'M' }, providers: [own(defaultModel)], engines,
    runtimeDefaultModels: { codex: GPT, ...(runnerDefault ? { opencode: runnerDefault } : {}) },
  })).model;
  assert.equal(pick('c', 'b'), 'b', "the runner's default first");
  assert.equal(pick('c', 'gone'), 'c', "the provider's own when the runner's is not listed");
  assert.equal(pick('gone', 'b'), 'b', "the runner's when the provider's is not listed");
  assert.equal(pick('gone'), 'a', 'else the first listed');
});

test("'No price known' is said only when a key is the pick", () => {
  const unpriced = key('unpriced', [{ model: 'u', effort: null, level: 'M', outputPricePerMTok: null }]);
  const sub = route(input({ providers: [codex(), unpriced] }));
  assert.equal(sub.provider, 'codex');
  assert.equal(sub.reasons.some((r) => r.startsWith('No price known')), false);
  const keys = route(input({ providers: [unpriced] }));
  assert.ok(keys.reasons.includes('No price known for u on unpriced; ordered after priced keys'), keys.reasons.join('\n'));
});

test('Cost: a subscription with headroom before a cheaper metered key; subscriptions by headroom; keys by price', () => {
  const tierM = (models: SubagentModelRow[]) => models;
  const cheap = key('cheap-key', tierM([{ model: 'cheap', effort: null, level: 'M', outputPricePerMTok: 0.1 }]));
  const dear = key('dear-key', tierM([{ model: 'dear', effort: null, level: 'M', outputPricePerMTok: 9 }]));
  const mid = key('mid-key', tierM([{ model: 'mid', effort: null, level: 'M', outputPricePerMTok: 2 }]));

  const sub = route(input({ providers: [cheap, codex({ account: { quota: { utilization: 60, window: 'weekly' } } })] }));
  assert.deepEqual([sub.provider, sub.model, sub.effort], ['codex', GPT, 'medium']);
  assert.match(sub.reasons.find((r) => r.startsWith('Picked'))!, /a subscription with 40% of its quota left, used before any metered key/);

  const byHeadroom = route(input({ providers: [
    claude({ account: { quota: { utilization: 70, window: 'weekly' } } }),
    codex({ account: { quota: { utilization: 20, window: 'weekly' } } }),
  ] }));
  assert.equal(byHeadroom.provider, 'codex', 'more headroom first');

  const keys = route(input({ providers: [dear, mid, cheap] }));
  assert.deepEqual([keys.provider, keys.model], ['cheap-key', 'cheap']);
  assert.match(keys.reasons.find((r) => r.startsWith('Picked'))!, /the cheapest in tier M: a metered key at \$0\.1 per million output tokens/);
  const noCheap = route(input({ providers: [dear, mid] }));
  assert.equal(noCheap.provider, 'mid-key');
});

test('Balance: a model with only metered keys yields to one with a subscription; between keys-only models, the owner\'s order', () => {
  const k = key('key', [{ model: 'k', effort: null, level: 'M', outputPricePerMTok: 3 }]);
  const cheaper = key('cheaper', [{ model: 'c', effort: null, level: 'M', outputPricePerMTok: 1 }]);
  const tight = route(input({ optimizeFor: 'balance', providers: [k, codex({ account: { quota: { utilization: 70, window: '5-hour' } } })] }));
  assert.equal(tight.provider, 'codex', 'a subscription 70% used still goes before a metered key');
  assert.match(tight.reasons.find((r) => r.startsWith('Picked'))!,
    /\(Balance\): model gpt-5\.6, takes over tier M from the preferred k, which has only metered keys; account codex: the only account that can run it, a subscription with 30% of its quota left$/);
  // Two models on keys only: no subscription to take over, so the preferred model (the owner's first) keeps the run.
  // Until p6 Balance ranked them by price and picked `cheaper`; the model is now chosen first (owner, 2026-11-22).
  const twoKeys = route(input({ optimizeFor: 'balance', providers: [k, cheaper] }));
  assert.equal(twoKeys.provider, 'key');
  assert.match(twoKeys.reasons.find((r) => r.startsWith('Picked'))!, /\(Balance\): model k, preferred in tier M; account key: the only account/);
});

test("Intelligence: the stronger model in the tier first, then the owner's order", () => {
  const sonnetHigh = key('sonnet-key', [{ model: SONNET, effort: 'high', level: 'L', outputPricePerMTok: 10 }]);
  const cheapL = key('cheap-l', [{ model: 'cheap-l', effort: null, level: 'L', outputPricePerMTok: 1 }]);
  const decision = route(input({ optimizeFor: 'intelligence', caller: { size: 'L' }, providers: [cheapL, sonnetHigh, claude()] }));
  assert.deepEqual([decision.provider, decision.model, decision.effort], ['claude', OPUS, 'high'],
    'Opus reaches XL, so it leads tier L over models whose ceiling is L');
  assert.match(decision.reasons.find((r) => r.startsWith('Picked'))!, /the strongest model in tier L \(reaches XL\)/);
  // Same ceiling: the owner's order chooses the model, not the price (policy p7, owner 2026-11-22; until p6 the cheaper
  // key, cheap-l, was first).
  const sameCeiling = route(input({ optimizeFor: 'intelligence', caller: { size: 'L' }, providers: [sonnetHigh, cheapL] }));
  assert.equal(sameCeiling.provider, 'sonnet-key', "same ceiling: the owner's first model");
  assert.equal(sameCeiling.fallbacks[0].provider, 'cheap-l');
  const cost = route(input({ optimizeFor: 'cost', caller: { size: 'L' }, providers: [cheapL, sonnetHigh] }));
  assert.equal(cost.provider, 'cheap-l');
});

test("ties go by the owner's provider order", () => {
  const a = key('key-a', [{ model: 'a', effort: null, level: 'M', outputPricePerMTok: 2 }]);
  const b = key('key-b', [{ model: 'b', effort: null, level: 'M', outputPricePerMTok: 2 }]);
  for (const optimizeFor of ['cost', 'balance', 'intelligence'] as const) {
    const caller = optimizeFor === 'intelligence' ? { size: 'M' as const } : {};
    assert.equal(route(input({ optimizeFor, caller, providers: [a, b] })).provider, 'key-a', optimizeFor);
    assert.equal(route(input({ optimizeFor, caller, providers: [b, a] })).provider, 'key-b', optimizeFor);
  }
  const subs = route(input({ providers: [codex(), claude()] }));
  assert.equal(subs.provider, 'codex', 'two subscriptions with the same headroom: the owner\'s first');
  const priceless = route(input({ providers: [key('x', [{ model: 'x', effort: null, level: 'M' }]), key('y', [{ model: 'y', effort: null, level: 'M' }])] }));
  assert.equal(priceless.provider, 'x', 'two keys of unknown price tie, and the owner\'s order decides');
});

const pool = (slug: string, members: SubagentPoolMember[], engine = 'claude'): SubagentProvider => ({
  slug, billing: 'subscription', inScope: true, credential: { kind: 'pool', engine }, engines: [{ engine }], pool: { members },
});

test('Cost: an account pool with headroom before a single subscription with less', () => {
  const team = pool('team-pool', [
    { label: 'alice@team', quota: { utilization: 85, window: 'weekly' } },
    { label: 'bob@team', quota: { utilization: 20, window: '5-hour' } },
  ]);
  const tight = claude({ account: { quota: { utilization: 70, window: 'weekly' } } });
  const decision = route(input({ providers: [tight, team] }));
  assert.deepEqual([decision.provider, decision.engine, decision.model, decision.effort], ['team-pool', 'claude', SONNET, 'medium']);
  assert.match(decision.reasons.find((r) => r.startsWith('Picked'))!,
    /a subscription pool whose account bob@team has 80% of its quota left, used before any metered key/);
  // The pool's headroom is its best member's: one with less loses to the single account.
  const worse = pool('worse-pool', [{ label: 'carol@team', quota: { utilization: 80, window: 'weekly' } }]);
  assert.equal(route(input({ providers: [worse, tight] })).provider, 'claude');
  // A paused or refused member does not count towards it.
  const pausedBest = pool('paused-pool', [
    { label: 'dan@team', quota: { utilization: 10, window: 'weekly' }, paused: true },
    { label: 'erin@team', quota: { utilization: 80, window: 'weekly' }, refused: false },
  ]);
  assert.equal(route(input({ providers: [pausedBest, tight] })).provider, 'claude');
});

test('an exhausted account pool is removed with its reason; one whose quota cannot be read still runs', () => {
  const spent = pool('spent-pool', [
    { label: 'alice@team', quota: { utilization: 95, window: 'weekly' } },
    { label: 'bob@team', quota: { utilization: 40, window: 'weekly' }, paused: true },
  ]);
  const blind = pool('blind-pool', [{ label: 'carol@team', unreadable: true }], 'codex');
  const empty = pool('empty-pool', []);
  const decision = route(input({ providers: [spent, blind, empty, DEEPSEEK] }));
  const why = (provider: string) => decision.candidates.filter((c) => c.provider === provider).map((c) => [c.engine, c.reason]);
  assert.deepEqual(why('spent-pool'), [['claude',
    'No account in the pool can run: alice@team at 95% of its weekly quota; bob@team paused']]);
  assert.deepEqual(why('blind-pool'), []);
  assert.deepEqual(why('empty-pool'), [['claude', 'The pool has no account that can run']]);
  assert.deepEqual([decision.provider, decision.note], ['blind-pool', 'subscription pool, carol@team with quota unknown'],
    'Cost: a subscription of unknown quota still goes before a metered key');
  // A pool on an engine the parent's runner lacks goes for that first.
  const missing = route(input({ providers: [pool('far-pool', [{ label: 'x', quota: null }], 'kimi')] }));
  assert.deepEqual(missing.candidates.map((c) => c.reason), ["kimi is not installed on the parent's runner"]);
});

test('Cost: a key on its native engine is ordered by its models.dev price among the other keys', () => {
  const anthropic: SubagentProvider = {
    slug: 'anthropic-key', billing: 'key', inScope: true, credential: { kind: 'key', presetSlug: 'anthropic' },
    engines: [{ engine: 'claude', prices: { [SONNET]: 10, [OPUS]: 20 } }],
  };
  const dear = key('dear-key', [{ model: 'dear', effort: null, level: 'M', outputPricePerMTok: 12 }]);
  const cheap = key('cheap-key', [{ model: 'cheap', effort: null, level: 'M', outputPricePerMTok: 0.6 }]);
  const between = route(input({ providers: [dear, anthropic] }));
  assert.deepEqual([between.provider, between.model, between.effort], ['anthropic-key', SONNET, 'medium']);
  assert.match(between.reasons.find((r) => r.startsWith('Picked'))!, /a metered key at \$10 per million output tokens/);
  assert.equal(route(input({ providers: [dear, anthropic, cheap] })).provider, 'cheap-key');
  // Tier L is Opus on that key, at Opus's price.
  const tierL = route(input({ caller: { size: 'L' }, providers: [anthropic, key('l-key', [{ model: 'l', effort: null, level: 'L', outputPricePerMTok: 25 }])] }));
  assert.deepEqual([tierL.provider, tierL.model, tierL.effort], ['anthropic-key', OPUS, 'high']);
  // A model models.dev has no price for sorts after the priced keys, and the decision says so.
  const unpriced: SubagentProvider = { slug: 'unpriced-key', billing: 'key', inScope: true, credential: { kind: 'key', presetSlug: null }, engines: [{ engine: 'claude', prices: {} }] };
  const last = route(input({ providers: [unpriced, dear] }));
  assert.equal(last.provider, 'dear-key');
  assert.ok(last.reasons.includes(`No price known for ${SONNET} on unpriced-key; ordered after priced keys`), last.reasons.join('\n'));
});

test('fallbacks: the rest of the pool after the pick, in rank order (§4.3); none for a named model', () => {
  const cheap = key('cheap-key', [{ model: 'cheap', effort: null, level: 'M', outputPricePerMTok: 0.1 }]);
  const dear = key('dear-key', [{ model: 'dear', effort: null, level: 'M', outputPricePerMTok: 9 }]);
  const decision = route(input({ providers: [dear, codex({ account: { quota: { utilization: 60, window: 'weekly' } } }), cheap] }));
  assert.deepEqual([decision.provider, decision.model], ['codex', GPT]);
  assert.deepEqual(decision.fallbacks.map((f) => [f.provider, f.engine, f.model, f.effort]), [
    ['cheap-key', 'claude', 'cheap', null],
    ['dear-key', 'claude', 'dear', null],
    // Then the tiers above M, nearest first, then the one below.
    ['codex', 'codex', GPT, 'high'],
    ['codex', 'codex', GPT, 'xhigh'],
    ['codex', 'codex', GPT, 'low'],
  ]);
  assert.deepEqual(decision.fallbacks.map((f) => f.level), ['M', 'M', 'L', 'XL', 'S'], 'each fallback carries its own tier');
  assert.deepEqual(route(input({ caller: { model: 'deepseek-v4-pro' } })).fallbacks, []);
});
