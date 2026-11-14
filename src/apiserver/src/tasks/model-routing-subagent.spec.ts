/**
 * routeSubagent (docs/subagent-design.md §4.1, §4.2): the tier rows, Optimize For, each removal reason and
 * each ordering. The router is pure, so every case is a value snapshot in and a decision out — the
 * `fetch` trap below proves no case reaches for the network, and nothing here holds a database.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunnerModelCatalog } from '@orbit/shared';
import {
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

const claude = (over: Partial<SubagentProvider> = {}): SubagentProvider => ({
  slug: 'claude', billing: 'subscription', inScope: true, engines: [{ engine: 'claude' }], ...over,
});
const codex = (over: Partial<SubagentProvider> = {}): SubagentProvider => ({
  slug: 'codex', billing: 'subscription', inScope: true, engines: [{ engine: 'codex' }], ...over,
});
const key = (slug: string, models: SubagentModelRow[], over: Partial<SubagentProvider> = {}): SubagentProvider => ({
  slug, billing: 'key', inScope: true, engines: [{ engine: 'claude', models }], ...over,
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
      { slug: 'claude-team', billing: 'subscription', inScope: true, engines: [{ engine: 'claude' }], account: { paused: true } },
      { slug: 'kimi', billing: 'subscription', inScope: true, engines: [{ engine: 'kimi' }] },
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
  assert.deepEqual(why('kimi'), ['The model has no tier']);
  assert.deepEqual(decision.candidates.find((c) => c.provider === 'kimi')!.model, 'kimi-code');
  assert.deepEqual(why('custom-endpoint'), ['The model has no tier']);
  // claude-team is signed out through the same engine report before its pause is read; a pause alone:
  const paused = route(input({ providers: [claude({ account: { paused: true } }), DEEPSEEK] }));
  assert.deepEqual(paused.candidates.map((c) => [c.provider, c.reason]), [['claude', 'The account is paused']]);
  assert.deepEqual(why('deepseek'), [], 'what is left is not a removal');
  assert.deepEqual([decision.provider, decision.model], ['deepseek', 'deepseek-v4-flash']);

  const region = route(input({ engines: { claude: { installed: true, regionBlocked: true }, codex: { installed: true } } }));
  assert.deepEqual(region.candidates.filter((c) => c.provider === 'claude').map((c) => c.reason),
    ["claude can’t use Anthropic on the parent's runner"]);
  const missing = route(input({ engines: { claude: { installed: true } } }));
  assert.deepEqual(missing.candidates.filter((c) => c.provider === 'codex').map((c) => c.reason),
    ["codex is not installed on the parent's runner"]);
  const atLimit = route(input({ providers: [claude({ account: { quota: { utilization: 90, window: 'weekly' } } })] }));
  assert.deepEqual(atLimit.candidates.map((c) => c.reason), ['The account is at 90% of its weekly quota'], 'at the limit is out');
  assert.equal(atLimit.model, null, 'an empty pool picks nothing');
  assert.match(atLimit.reasons.at(-1)!, /NO_SUBAGENT_PROVIDER/);
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

test('Balance: headroom first, then price', () => {
  const k = key('key', [{ model: 'k', effort: null, level: 'M', outputPricePerMTok: 3 }]);
  const cheaper = key('cheaper', [{ model: 'c', effort: null, level: 'M', outputPricePerMTok: 1 }]);
  const tight = route(input({ optimizeFor: 'balance', providers: [codex({ account: { quota: { utilization: 70, window: '5-hour' } } }), k] }));
  assert.equal(tight.provider, 'key', 'a metered key has more headroom than a subscription 70% used');
  const fresh = route(input({ optimizeFor: 'balance', providers: [k, codex()] }));
  assert.equal(fresh.provider, 'codex', 'equal headroom: the subscription costs nothing at the margin');
  const twoKeys = route(input({ optimizeFor: 'balance', providers: [k, cheaper] }));
  assert.equal(twoKeys.provider, 'cheaper');
  assert.match(twoKeys.reasons.find((r) => r.startsWith('Picked'))!, /\(Balance\): the most quota headroom in tier M/);
});

test('Intelligence: the stronger model in the tier first, then price', () => {
  const sonnetHigh = key('sonnet-key', [{ model: SONNET, effort: 'high', level: 'L', outputPricePerMTok: 10 }]);
  const cheapL = key('cheap-l', [{ model: 'cheap-l', effort: null, level: 'L', outputPricePerMTok: 1 }]);
  const decision = route(input({ optimizeFor: 'intelligence', caller: { size: 'L' }, providers: [cheapL, sonnetHigh, claude()] }));
  assert.deepEqual([decision.provider, decision.model, decision.effort], ['claude', OPUS, 'high'],
    'Opus reaches XL, so it leads tier L over models whose ceiling is L');
  assert.match(decision.reasons.find((r) => r.startsWith('Picked'))!, /the strongest model in tier L \(reaches XL\)/);
  const sameCeiling = route(input({ optimizeFor: 'intelligence', caller: { size: 'L' }, providers: [sonnetHigh, cheapL] }));
  assert.equal(sameCeiling.provider, 'cheap-l', 'same ceiling: the cheaper first');
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
  slug, billing: 'subscription', inScope: true, engines: [{ engine }], pool: { members },
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

test('an exhausted account pool, and one whose quota cannot be read, is removed with its reason', () => {
  const spent = pool('spent-pool', [
    { label: 'alice@team', quota: { utilization: 95, window: 'weekly' } },
    { label: 'bob@team', quota: { utilization: 40, window: 'weekly' }, paused: true },
  ]);
  const blind = pool('blind-pool', [{ label: 'carol@team', unreadable: true }], 'codex');
  const empty = pool('empty-pool', []);
  const decision = route(input({ providers: [spent, blind, empty, DEEPSEEK] }));
  const why = (provider: string) => decision.candidates.filter((c) => c.provider === provider).map((c) => [c.engine, c.reason]);
  assert.deepEqual(why('spent-pool'), [['claude',
    'Every account in the pool is at or above 90% of its quota or paused: alice@team at 95% of its weekly quota; bob@team paused']]);
  assert.deepEqual(why('blind-pool'), [['codex',
    "The pool's quota cannot be read for carol@team, and no other account in it can run"]]);
  assert.deepEqual(why('empty-pool'), [['claude', 'The pool has no account that can run']]);
  assert.equal(decision.provider, 'deepseek');
  // A pool on an engine the parent's runner lacks goes for that first.
  const missing = route(input({ providers: [pool('far-pool', [{ label: 'x', quota: null }], 'kimi')] }));
  assert.deepEqual(missing.candidates.map((c) => c.reason), ["kimi is not installed on the parent's runner"]);
});

test('Cost: a key on its native engine is ordered by its models.dev price among the other keys', () => {
  const anthropic: SubagentProvider = {
    slug: 'anthropic-key', billing: 'key', inScope: true,
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
  const unpriced: SubagentProvider = { slug: 'unpriced-key', billing: 'key', inScope: true, engines: [{ engine: 'claude', prices: {} }] };
  const last = route(input({ providers: [unpriced, dear] }));
  assert.equal(last.provider, 'dear-key');
  assert.ok(last.reasons.includes(`No price known for ${SONNET} on unpriced-key; ordered after priced keys`), last.reasons.join('\n'));
});

test('fallbacks: the rest of the tier after the pick, in rank order (§4.3); none for a named model', () => {
  const cheap = key('cheap-key', [{ model: 'cheap', effort: null, level: 'M', outputPricePerMTok: 0.1 }]);
  const dear = key('dear-key', [{ model: 'dear', effort: null, level: 'M', outputPricePerMTok: 9 }]);
  const decision = route(input({ providers: [dear, codex({ account: { quota: { utilization: 60, window: 'weekly' } } }), cheap] }));
  assert.deepEqual([decision.provider, decision.model], ['codex', GPT]);
  assert.deepEqual(decision.fallbacks.map((f) => [f.provider, f.engine, f.model, f.effort]), [
    ['cheap-key', 'claude', 'cheap', null],
    ['dear-key', 'claude', 'dear', null],
  ]);
  assert.deepEqual(route(input({ caller: { model: 'deepseek-v4-pro' } })).fallbacks, []);
});
