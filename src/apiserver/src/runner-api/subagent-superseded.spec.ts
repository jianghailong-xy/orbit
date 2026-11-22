import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ModelQuality, ProviderModelTier, RunnerModelInfo } from '@orbit/shared';

import { subagentEngineRows } from '../tasks/model-routing';
import { markSuperseded } from './subagent-route';

const info = (...values: string[]): RunnerModelInfo[] =>
  values.map((value) => ({ value, label: value, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }));

/** No runs: the quality every row here carries, which supersededBy does not read. */
const NO_QUALITY: ModelQuality = {
  subagent: { averageRating: null, ratedCount: 0, runCount: 0, raters: [] },
  tasks: { firstPassRate: null, firstPassTaskCount: 0, completedTaskCount: 0 },
};

const CURSOR = info('claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'grok-4.7', 'gemini-4-neon', 'gemini-4-argon', 'default');

/** The Tier column's models the way subagentTierView builds them: owner tiers applied to the engine rows. */
function view(catalog: RunnerModelInfo[], owned: Record<string, 'S' | 'M' | 'L' | 'XL'> = {}): ProviderModelTier[] {
  const rows = subagentEngineRows({ engine: 'cursor' }, {
    modelCatalog: { cursor: catalog } as never, runtimeDefaultModels: {}, builtinModelTiers: { cursor: owned },
  });
  const models = new Map<string, ProviderModelTier>();
  for (const row of rows) {
    const seen = models.get(row.model) ?? { model: row.model, levels: [], source: null, editable: true, outputPricePerMTok: null, quality: NO_QUALITY };
    if (row.level && !seen.levels.includes(row.level)) seen.levels.push(row.level);
    models.set(row.model, seen);
  }
  for (const entry of catalog) if (!models.has(entry.value)) {
    models.set(entry.value, { model: entry.value, levels: [], source: null, editable: true, outputPricePerMTok: null, quality: NO_QUALITY });
  }
  return [...models.values()];
}

const supersededBy = (models: ProviderModelTier[]) => Object.fromEntries(models.map((m) => [m.model, m.supersededBy ?? null]));

test('an older family member points at the newest tiered model; no family means no flag', () => {
  const models = view(CURSOR);
  markSuperseded(models, CURSOR);
  assert.deepEqual(supersededBy(models), {
    'claude-opus-5-5': null, 'claude-opus-5': 'claude-opus-5-5', 'claude-opus-4-8': 'claude-opus-5-5',
    'gemini-4-neon': null, 'gemini-4-argon': 'gemini-4-neon', 'grok-4.7': null, default: null,
  });
});

test('an owner tier on an older model wins: it is tiered, not superseded', () => {
  const models = view(CURSOR, { 'claude-opus-5': 'M' });
  markSuperseded(models, CURSOR);
  const older = models.find((m) => m.model === 'claude-opus-5');
  assert.deepEqual(older?.levels, ['M']);
  assert.equal(older?.supersededBy, undefined);
  assert.equal(models.find((m) => m.model === 'claude-opus-4-8')?.supersededBy, 'claude-opus-5-5');
});

test('marking does not change the routing rows', () => {
  const input = { modelCatalog: { cursor: CURSOR } as never, runtimeDefaultModels: {}, builtinModelTiers: {} };
  const before = JSON.stringify(subagentEngineRows({ engine: 'cursor' }, input));
  const models = view(CURSOR);
  markSuperseded(models, CURSOR);
  assert.equal(JSON.stringify(subagentEngineRows({ engine: 'cursor' }, input)), before);
});
