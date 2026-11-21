import { describe, expect, it } from 'vitest';
import { modelTierText, priceText, providersCountText, qualityLines, tierText } from './subagentTiers';

const model = (outputPricePerMTok: number | null) => ({
  model: 'm', levels: [], source: null, editable: false, outputPricePerMTok,
  quality: {
    subagent: { averageRating: null, ratedCount: 0, runCount: 0, raters: [] },
    tasks: { firstPassRate: null, firstPassTaskCount: 0, completedTaskCount: 0 },
  },
});

describe('the Tier column and the SubAgents Providers button (docs/subagent-design.md §7)', () => {
  it('reads a model with no tier as Not set, every tier as by effort, else the tiers', () => {
    expect(tierText([])).toBe('Not set');
    expect(tierText(['S', 'M', 'L', 'XL'])).toBe('S–XL by effort');
    expect(tierText(['L', 'XL'])).toBe('L · XL');
    expect(tierText(['M'])).toBe('M');
  });

  it('reads an older family member as Older · uses the newest, until the owner tiers it', () => {
    const older = { ...model(null), supersededBy: 'claude-opus-5-5' };
    expect(modelTierText(older)).toBe('Older · uses claude-opus-5-5');
    expect(modelTierText({ ...older, levels: ['M'] })).toBe('M');
    expect(modelTierText(model(null))).toBe('Not set');
  });

  it('prices a key per million output tokens, a subscription as such, and an unknown as a dash', () => {
    expect(priceText(model(0.6), 'key')).toBe('$0.60');
    expect(priceText(model(null), 'subscription')).toBe('Subscription');
    expect(priceText(model(null), 'key')).toBe('—');
  });

  it('counts the providers SubAgents may use', () => {
    const providers = ['claude', 'codex', 'deepseek', 'kimi', 'my-endpoint', 'team'].map((slug) => ({ slug }));
    expect(providersCountText(providers, [])).toBe('6 of 6 · Edit');
    expect(providersCountText(providers, ['codex', 'gone'])).toBe('5 of 6 · Edit');
  });
});

describe('the Quality cell (docs/subagent-design.md §7.1)', () => {
  it('reads both figures with their counts, and who rated', () => {
    expect(qualityLines({
      subagent: { averageRating: 4.2, ratedCount: 18, runCount: 40,
        raters: [{ engine: 'claude', provider: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', count: 18 }] },
      tasks: { firstPassRate: 0.824, firstPassTaskCount: 28, completedTaskCount: 34 },
    })).toEqual({
      empty: false,
      subagents: { text: '4.2 · 18 rated of 40', muted: false, raters: 'Rated by Opus 5.5 (18)' },
      tasks: { text: '82% first pass · 34 tasks', muted: false },
    });
  });

  it('says why a figure is missing, and No runs yet only when there is nothing at all', () => {
    const sparse = qualityLines({
      subagent: { averageRating: null, ratedCount: 4, runCount: 9,
        raters: [{ engine: 'codex', provider: 'codex', model: 'gpt-5.5', label: null, count: 4 }] },
      tasks: { firstPassRate: null, firstPassTaskCount: 9, completedTaskCount: 9 },
    });
    expect(sparse.empty).toBe(false);
    expect(sparse.subagents).toEqual({ text: 'Not enough ratings', muted: true, raters: null });
    expect(sparse.tasks).toEqual({ text: 'Not enough tasks', muted: true });
    expect(qualityLines({
      subagent: { averageRating: null, ratedCount: 0, runCount: 0, raters: [] },
      tasks: { firstPassRate: null, firstPassTaskCount: 0, completedTaskCount: 0 },
    }).empty).toBe(true);
  });
});
