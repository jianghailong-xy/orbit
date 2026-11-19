/**
 * appliedDecision (docs/subagent-design.md §4.2, §10.3): when the router's pick cannot start where the SubAgent runs —
 * a remote workspace's default it skips, a candidate this runner cannot start — and one further down runs instead,
 * the reasons say when that one is not of the asked tier.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeSubagent, type SubagentProvider, type SubagentRoutingInput } from '../tasks/model-routing';
import { appliedDecision, fallbackCandidates } from './subagent-run';

const pool: SubagentProvider = {
  slug: 'codex-pool', billing: 'subscription', inScope: true, credential: { kind: 'pool', engine: 'codex' },
  engines: [{ engine: 'codex' }], pool: { members: [{ label: 'a@team', quota: { utilization: 20, window: 'weekly' } }] },
};
const key = (slug: string, model: string, level: 'S' | 'M' | null, price: number | null): SubagentProvider => ({
  slug, billing: 'key', inScope: true, credential: { kind: 'key', presetSlug: null },
  engines: [{ engine: 'claude', models: [{ model, effort: null, level, outputPricePerMTok: price }] }],
});

function route(providers: SubagentProvider[]) {
  const input: SubagentRoutingInput = {
    type: 'general', definitionName: 'general', caller: { size: 'S' }, definition: {}, optimizeFor: 'cost',
    parent: { engine: 'codex', provider: 'codex-pool', model: '', effort: null },
    providers, blockedProviders: [], engines: { claude: { installed: true }, codex: { installed: true } },
    modelCatalog: { codex: [{ value: 'gpt-6.2-sol', label: 'GPT' }] }, runtimeDefaultModels: { codex: 'gpt-6.2-sol' },
  };
  return routeSubagent(input);
}
const target = (decision: ReturnType<typeof route>, provider: string) => fallbackCandidates(decision).find((c) => c.provider === provider)!;

test('a candidate of a higher tier that runs in place of the pick says so', () => {
  const decision = route([pool, key('deepseek', 'deepseek-v4-flash', 'M', 0.6)]);
  assert.equal(decision.provider, 'codex-pool');
  const ran = appliedDecision(decision, target(decision, 'deepseek'));
  assert.deepEqual([ran.provider, ran.model], ['deepseek', 'deepseek-v4-flash']);
  assert.equal(ran.reasons.at(-1), 'Nothing in tier S can run: the nearest tier above that can is M');
  assert.equal(ran.fallbacks?.some((f) => f.provider === 'deepseek'), false, 'what runs is not its own fallback');
});

test('an untiered default that runs in place of the pick says so; one of the asked tier adds nothing', () => {
  const untiered = route([pool, key('house', 'qwen', null, null)]);
  assert.equal(appliedDecision(untiered, target(untiered, 'house')).reasons.at(-1),
    'Nothing in tier S or above can run: qwen is the default model of house (claude), which has no tiers');
  const same = route([pool, key('small', 'tiny', 'S', 0.1)]);
  const ran = appliedDecision(same, target(same, 'small'));
  assert.equal(ran.reasons.some((r) => r.startsWith('Nothing in tier')), false);
  // A decision stored before fallbacks carried their tier says nothing it cannot know.
  const higher = route([pool, key('deepseek', 'deepseek-v4-flash', 'M', 0.6)]);
  const old = { ...higher, fallbacks: higher.fallbacks.map(({ level: _level, ...f }) => f) };
  assert.equal(appliedDecision(old, target(old, 'deepseek')).reasons.some((r) => r.startsWith('Nothing in tier')), false);
  // The pick itself running adds nothing either.
  assert.deepEqual(appliedDecision(same, target(same, 'codex-pool')).reasons, same.reasons);
});
