/**
 * routeSubagent's two steps (docs/subagent-design.md §4.2, owner 2026-11-22): choose the model, then the account, with
 * the strictness Optimize For sets — Intelligence strictly model first, Balance model first with the near-limit and
 * about-to-waste exceptions, Cost every candidate together by quota as before. And routeTaskRun, which keeps the
 * order every task run had (rankTogether). Pure: value snapshots in, decisions out.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunnerModelCatalog } from '@orbit/shared';
import {
  routeSubagent,
  routeTaskRun,
  SUBAGENT_ROUTING_POLICY_VERSION,
  SUBAGENT_WASTE_WINDOW_MS,
  type ModelRoutingInput,
  type ModelRoutingOptimizeFor,
  type SubagentPoolMember,
  type SubagentProvider,
  type SubagentRoutingInput,
} from './model-routing';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 22, 8, 0);
const WEEK_MINS = 7 * 24 * 60;
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const SOL = 'gpt-6.2-sol';
const K3 = 'kimi-code/k3';

const CATALOG: RunnerModelCatalog = {
  claude: [
    { value: OPUS, label: 'Opus 5.5', priority: 0 },
    { value: SONNET, label: 'Sonnet 5.5', priority: 2 },
  ],
  codex: [{ value: SOL, label: 'GPT-6.2 Sol' }],
  // K3.1 Pro listed: K3 is tiered S and M only, so its ceiling is Sonnet's (M) and Intelligence weighs them alike.
  kimi: [{ value: K3, label: 'K3' }, { value: 'kimi-code/k3.1-pro', label: 'K3.1 Pro' }],
};

type Account = NonNullable<SubagentProvider['account']>;
/** A subscription account with `utilization` of a weekly window spent, resetting `resetsIn` from NOW. */
const weekly = (utilization: number, resetsIn: number, over: Partial<Account> = {}): Account => ({
  quota: { utilization, window: 'weekly' }, expiresAt: NOW + resetsIn, expiryWindowMins: WEEK_MINS, ...over,
});

const signIn = (engine: string, account: Account = weekly(20, 120 * HOUR), slug = engine): SubagentProvider => ({
  slug, billing: 'subscription', inScope: true, credential: { kind: 'login', engine }, engines: [{ engine }], account,
});
const pool = (slug: string, engine: string, members: SubagentPoolMember[]): SubagentProvider => ({
  slug, billing: 'subscription', inScope: true, credential: { kind: 'pool', engine }, engines: [{ engine }], pool: { members },
});
const openaiKey: SubagentProvider = {
  slug: 'openai-key', billing: 'key', inScope: true, credential: { kind: 'key', presetSlug: 'openai' },
  engines: [{ engine: 'codex', prices: { [SOL]: 10 } }],
};

function input(optimizeFor: ModelRoutingOptimizeFor, providers: SubagentProvider[], over: Partial<SubagentRoutingInput> = {}): SubagentRoutingInput {
  return {
    type: 'general', definitionName: 'general', caller: { size: 'S' }, definition: {}, optimizeFor,
    parent: { engine: 'claude', provider: 'claude', model: OPUS, effort: 'high' },
    providers, blockedProviders: [],
    engines: { claude: { installed: true }, codex: { installed: true }, kimi: { installed: true } },
    modelCatalog: CATALOG, runtimeDefaultModels: { codex: SOL }, now: NOW,
    ...over,
  };
}

const picked = (d: ReturnType<typeof routeSubagent>) => [d.provider, d.model];
const pickLine = (d: ReturnType<typeof routeSubagent>) => d.reasons.find((r) => r.startsWith('Picked '))!;
const order = (d: ReturnType<typeof routeSubagent>) =>
  [[d.provider, d.model, d.pickLevel ?? null], ...d.fallbacks.map((f) => [f.provider, f.model, f.level ?? null])];

test('the policy version names the two steps', () => {
  assert.equal(SUBAGENT_ROUTING_POLICY_VERSION, 'p8-account-health-1');
  assert.equal(routeSubagent(input('balance', [signIn('claude')])).policyVersion, SUBAGENT_ROUTING_POLICY_VERSION);
});

// The owner's case (Routing report, 2026-11-22): tier S went to Kimi K3 because Kimi's quota reset first.
const ownersCase = () => [signIn('claude', weekly(20, 120 * HOUR)), signIn('codex', weekly(20, 100 * HOUR)), signIn('kimi', weekly(20, 30 * HOUR))];

test('Intelligence: a preferred model with room keeps the run, though another model\'s quota expires sooner', () => {
  const d = routeSubagent(input('intelligence', ownersCase(), { caller: { size: 'M' } }));
  // Codex's Sol reaches XL, so it is the strongest model in tier M; Sonnet and K3 both reach M.
  assert.deepEqual(picked(d), ['codex', SOL]);
  assert.match(pickLine(d), /\(Intelligence\): model gpt-6\.2-sol, the strongest model in tier M \(reaches XL\); account codex: the only account that can run it/);
  // Between equals the owner's order decides, not the quota: Sonnet before K3 at S, K3's reset 30 hours away or 2.
  for (const resetsIn of [30 * HOUR, 2 * HOUR]) {
    const providers = [signIn('claude', weekly(20, 120 * HOUR)), signIn('kimi', weekly(20, resetsIn))];
    const s = routeSubagent(input('intelligence', providers));
    assert.deepEqual(picked(s), ['claude', SONNET]);
    assert.match(pickLine(s), /model claude-sonnet-5-5, preferred in tier S; account claude: the only account that can run it, a subscription with 80% of its quota left until/);
  }
  // Near its limit is no reason to move in Intelligence: the model still has an account that can run.
  const near = routeSubagent(input('intelligence', [signIn('claude', weekly(85, 120 * HOUR, { nearLimit: true })), signIn('kimi', weekly(20, 2 * HOUR))]));
  assert.deepEqual(picked(near), ['claude', SONNET]);
});

test('Intelligence: the next model only when no account of the chosen one can run', () => {
  const spent = routeSubagent(input('intelligence', [signIn('claude', weekly(95, 120 * HOUR)), signIn('kimi', weekly(20, 30 * HOUR))]));
  assert.deepEqual(picked(spent), ['kimi', K3]);
  assert.match(pickLine(spent), /model kimi-code\/k3, the only model in tier S that can run/);
  assert.ok(spent.candidates.some((c) => c.provider === 'claude' && c.reason === 'The account is at 95% of its weekly quota'));
  const reports: Array<SubagentRoutingInput['engines']> = [
    { claude: { installed: true, signedOut: true }, kimi: { installed: true } },
    { kimi: { installed: true } },
  ];
  for (const engines of reports) {
    assert.deepEqual(picked(routeSubagent(input('intelligence', ownersCase().filter((p) => p.slug !== 'codex'), { engines }))), ['kimi', K3]);
  }
  const refused = routeSubagent(input('intelligence', [signIn('claude', { ...weekly(10, 120 * HOUR), refused: true }), signIn('kimi')]));
  assert.deepEqual(picked(refused), ['kimi', K3]);
});

test('Balance: the preferred model keeps the run while it has room, whatever another model\'s quota does past a day', () => {
  const d = routeSubagent(input('balance', ownersCase()));
  assert.deepEqual(picked(d), ['claude', SONNET], "Sonnet: the owner's first provider, though Kimi's quota resets first (30 hours)");
  assert.match(pickLine(d), /^Picked claude-sonnet-5-5 · low on claude \(Balance\): model claude-sonnet-5-5, preferred in tier S; account claude: the only account that can run it/);
});

test('Balance exception 1: another model takes over when every account of the preferred one is near its limit', () => {
  const providers = [signIn('claude', weekly(85, 120 * HOUR, { nearLimit: true })), signIn('kimi', weekly(20, 30 * HOUR))];
  const d = routeSubagent(input('balance', providers));
  assert.deepEqual(picked(d), ['kimi', K3]);
  assert.match(pickLine(d), /model kimi-code\/k3, takes over tier S from the preferred claude-sonnet-5-5, which has every account near its limit/);
  assert.deepEqual(d.fallbacks[0], { engine: 'claude', provider: 'claude', model: SONNET, effort: 'low', note: 'subscription with 15% quota left', level: 'S' },
    'the preferred model is the first fallback');
  // One of its accounts with room is enough to keep it: a pool member, here.
  const team = pool('claude-pool', 'claude', [{ label: 'a@team', quota: { utilization: 30, window: 'weekly' }, expiresAt: NOW + 90 * HOUR, expiryWindowMins: WEEK_MINS }]);
  assert.deepEqual(picked(routeSubagent(input('balance', [...providers, team]))), ['claude-pool', SONNET]);
  // Every model near its limit: nothing has room to take over, and the preferred model keeps it.
  const all = routeSubagent(input('balance', [providers[0], signIn('kimi', weekly(85, 30 * HOUR, { nearLimit: true }))]));
  assert.deepEqual(picked(all), ['claude', SONNET]);
});

test('Balance exception 2: a model whose weekly quota resets within a day takes over, before it goes to waste', () => {
  const at = (kimi: Account, claude: Account = weekly(20, 120 * HOUR), over: Partial<SubagentRoutingInput> = {}) =>
    routeSubagent(input('balance', [signIn('claude', claude), signIn('kimi', kimi)], over));
  const soon = at(weekly(40, 10 * HOUR));
  assert.deepEqual(picked(soon), ['kimi', K3]);
  assert.match(pickLine(soon), /model kimi-code\/k3, takes over tier S from the preferred claude-sonnet-5-5: its quota on kimi resets at 2026-11-22T18:00Z, within a day, and would otherwise go to waste; account kimi:/);
  assert.equal(soon.fallbacks[0].provider, 'claude');
  // The window's edge: a day ahead counts, a minute past it does not.
  assert.deepEqual(picked(at(weekly(40, SUBAGENT_WASTE_WINDOW_MS))), ['kimi', K3]);
  assert.deepEqual(picked(at(weekly(40, SUBAGENT_WASTE_WINDOW_MS + 60_000))), ['claude', SONNET]);
  // A 5-hour window always resets within a day: that is no waste.
  assert.deepEqual(picked(at(weekly(40, 2 * HOUR, { quota: { utilization: 40, window: '5-hour' }, expiryWindowMins: 300 }))), ['claude', SONNET]);
  // A window of unknown length, a nearly spent one, or a route without a clock: no exception.
  assert.deepEqual(picked(at(weekly(40, 2 * HOUR, { expiryWindowMins: null }))), ['claude', SONNET]);
  assert.deepEqual(picked(at(weekly(85, 2 * HOUR, { nearLimit: true }))), ['claude', SONNET]);
  assert.deepEqual(picked(at(weekly(40, 2 * HOUR), undefined, { now: undefined })), ['claude', SONNET]);
  // The preferred model's own quota about to go to waste keeps it.
  assert.deepEqual(picked(at(weekly(40, 2 * HOUR), weekly(20, 5 * HOUR))), ['claude', SONNET]);
  // Of two models about to waste theirs, the one resetting first; the preferred model then the rest follow.
  const two = routeSubagent(input('balance', [
    signIn('claude'), signIn('codex', weekly(20, 20 * HOUR)), signIn('kimi', weekly(20, 6 * HOUR)),
  ]));
  assert.deepEqual(order(two).slice(0, 3), [['kimi', K3, 'S'], ['claude', SONNET, 'S'], ['codex', SOL, 'S']]);
});

test('Cost: every candidate together by quota, as before: the soonest expiry picks the model', () => {
  const d = routeSubagent(input('cost', ownersCase()));
  assert.deepEqual(picked(d), ['kimi', K3], "Kimi's quota resets first (30 hours)");
  assert.match(pickLine(d), /^Picked kimi-code\/k3 · low on kimi \(Cost\): a subscription with 80% of its quota left until 2026-11-23T14:00Z, used before any metered key$/);
  assert.deepEqual(order(d).slice(0, 3), [['kimi', K3, 'S'], ['codex', SOL, 'S'], ['claude', SONNET, 'S']]);
});

test('the account step: one model on the sign-in, a pool and a key — subscriptions by quota, the key last', () => {
  const member = (resetsIn: number): SubagentPoolMember => ({
    label: 'b@team', quota: { utilization: 30, window: 'weekly' }, expiresAt: NOW + resetsIn, expiryWindowMins: WEEK_MINS,
  });
  for (const mode of ['balance', 'intelligence'] as const) {
    // The pool's quota resets first: its account.
    const poolFirst = routeSubagent(input(mode, [openaiKey, signIn('codex', weekly(20, 100 * HOUR)), pool('codex-pool', 'codex', [member(40 * HOUR)])]));
    assert.deepEqual(order(poolFirst).slice(0, 3), [['codex-pool', SOL, 'S'], ['codex', SOL, 'S'], ['openai-key', SOL, 'S']], mode);
    assert.match(pickLine(poolFirst), /model gpt-6\.2-sol, (preferred|the only model) in tier S[^;]*; account codex-pool: its quota resets first, a subscription pool whose account b@team has 70% of its quota left until 2026-11-24T00:00Z$/);
    // The sign-in's resets first: the sign-in.
    const signInFirst = routeSubagent(input(mode, [openaiKey, signIn('codex', weekly(20, 10 * HOUR)), pool('codex-pool', 'codex', [member(40 * HOUR)])]));
    assert.deepEqual(picked(signInFirst), ['codex', SOL], mode);
    assert.match(pickLine(signInFirst), /; account codex: its quota resets first/);
    // Only the key left: the key, said so.
    const keyOnly = routeSubagent(input(mode, [openaiKey, signIn('codex', weekly(95, 10 * HOUR))]));
    assert.deepEqual(picked(keyOnly), ['openai-key', SOL], mode);
  }
  // A subscription before the key even when the key is listed first and the subscription's quota was not read.
  const blind = routeSubagent(input('balance', [openaiKey, signIn('codex', { quota: null, unreadable: true })]));
  assert.deepEqual(picked(blind), ['codex', SOL]);
  assert.match(pickLine(blind), /; account codex: a subscription, used before any metered key, a subscription whose quota was not read$/);
});

test('fallbacks follow the same order: every account of the chosen model, the next model\'s, then the other tiers', () => {
  const providers = [signIn('claude', weekly(20, 120 * HOUR)), signIn('codex', weekly(20, 100 * HOUR)),
    pool('codex-pool', 'codex', [{ label: 'b@team', quota: { utilization: 10, window: 'weekly' }, expiresAt: NOW + 50 * HOUR, expiryWindowMins: WEEK_MINS }])];
  const d = routeSubagent(input('balance', providers, { caller: { size: 'M' } }));
  assert.deepEqual(order(d), [
    ['claude', SONNET, 'M'],
    ['codex-pool', SOL, 'M'], ['codex', SOL, 'M'],
    // Then tier L, XL, then the tier below, each model first and its accounts after.
    ['claude', OPUS, 'L'], ['codex-pool', SOL, 'L'], ['codex', SOL, 'L'],
    ['claude', OPUS, 'XL'], ['codex-pool', SOL, 'XL'], ['codex', SOL, 'XL'],
    ['claude', SONNET, 'S'], ['codex-pool', SOL, 'S'], ['codex', SOL, 'S'],
  ]);
});

test('fit across tiers stays outermost in every mode', () => {
  // A model only at L (preferred: first in the owner's order) against one at the asked tier M on a quota resetting later.
  const lOnly: SubagentProvider = {
    slug: 'l-key', billing: 'subscription', inScope: true, credential: { kind: 'key', presetSlug: null },
    engines: [{ engine: 'claude', models: [{ model: 'big', effort: null, level: 'L' }] }], account: weekly(0, 2 * HOUR),
  };
  for (const mode of ['cost', 'balance', 'intelligence'] as const) {
    const d = routeSubagent(input(mode, [lOnly, signIn('codex', weekly(50, 150 * HOUR))], { caller: { size: 'M' } }));
    assert.deepEqual([d.provider, d.model, d.pickLevel], ['codex', SOL, 'M'], mode);
    assert.equal(d.fallbacks.find((f) => f.provider === 'l-key')?.level, 'L', mode);
  }
});

test("step 1 prefers the owner's own tier over the engine's table, on one engine", () => {
  const catalog: RunnerModelCatalog = { ...CATALOG, claude: [...CATALOG.claude!, { value: 'claude-haiku-5-0', label: 'Haiku 5.0', priority: 3 }] };
  const tiers = { claude: { 'claude-haiku-5-0': 'S' as const } };
  const d = routeSubagent(input('balance', [signIn('claude')], { modelCatalog: catalog, builtinModelTiers: tiers }));
  assert.deepEqual(picked(d), ['claude', 'claude-haiku-5-0']);
  assert.equal(d.fallbacks[0].model, SONNET);
  // Without the owner's tier, the table's Sonnet (Haiku's family rule does not apply on the tabled Claude engine).
  assert.deepEqual(picked(routeSubagent(input('balance', [signIn('claude')], { modelCatalog: catalog }))), ['claude', SONNET]);
  // On a key's own list too: the owner's tier before the catalogue's.
  const ownKey: SubagentProvider = {
    slug: 'k', billing: 'subscription', inScope: true, credential: { kind: 'key', presetSlug: null }, account: weekly(10, 100 * HOUR),
    engines: [{ engine: 'claude', models: [
      { model: 'shipped', effort: null, level: 'S', source: 'catalogue' }, { model: 'mine', effort: null, level: 'S', source: 'owner' },
    ] }],
  };
  assert.equal(routeSubagent(input('balance', [ownKey])).model, 'mine');
});

// ─── Task runs keep the order they had (rankTogether) ───

/** An Agent on Kimi, whose engine has no model at the tier asked, with Claude and Codex on its runner. */
function taskInput(optimizeFor: ModelRoutingOptimizeFor): ModelRoutingInput {
  // Codex's quota resets first, but past a day: no Balance exception for a SubAgent.
  const providers = [signIn('claude', weekly(20, 120 * HOUR)), signIn('codex', weekly(20, 30 * HOUR))];
  return {
    optimizeFor,
    task: { modelHint: 'L' },
    baseline: { provider: 'kimi', model: null, effort: null },
    history: [],
    environment: { runtime: 'kimi', modelCatalog: CATALOG },
    pool: { ...input(optimizeFor, providers), type: 'task', caller: {}, engines: { claude: { installed: true }, codex: { installed: true } } },
  };
}

test('task runs are unchanged: Balance and Intelligence still rank every candidate together by quota', () => {
  // Balance, the default: Codex's quota resets first, so a task run gets Codex at L, as before p7.
  const balance = routeTaskRun(taskInput('balance'));
  assert.deepEqual([balance.engine, balance.provider, balance.model, balance.effort], ['codex', 'codex', SOL, 'high']);
  assert.ok(balance.reasons.includes('Picked gpt-6.2-sol · high on codex (Balance): a subscription with 80% of its quota left until 2026-11-23T14:00Z, used before any metered key'),
    JSON.stringify(balance.reasons));
  // A SubAgent on the same pool at the same tier gets Claude's Opus: the change task runs do not take.
  const asSubagent = routeSubagent({ ...taskInput('balance').pool!, caller: { size: 'L' } });
  assert.deepEqual(picked(asSubagent), ['claude', OPUS]);
  // Intelligence keeps its old order too: the strongest ceiling, then the soonest expiry.
  const intelligence = routeTaskRun(taskInput('intelligence'));
  assert.deepEqual([intelligence.provider, intelligence.model], ['codex', SOL]);
  assert.match(intelligence.reasons.find((r) => r.startsWith('Picked '))!, /\(Intelligence\): the strongest model in tier L \(reaches XL\), a subscription/);
});
