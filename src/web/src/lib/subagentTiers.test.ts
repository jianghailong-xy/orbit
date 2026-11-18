import { describe, expect, it } from 'vitest';
import { priceText, providersCountText, tierText } from './subagentTiers';

const model = (outputPricePerMTok: number | null) => ({
  model: 'm', levels: [], source: null, editable: false, outputPricePerMTok,
});

describe('the Tier column and the SubAgents Providers button (docs/subagent-design.md §7)', () => {
  it('reads a model with no tier as Not set, every tier as by effort, else the tiers', () => {
    expect(tierText([])).toBe('Not set');
    expect(tierText(['S', 'M', 'L', 'XL'])).toBe('S–XL by effort');
    expect(tierText(['L', 'XL'])).toBe('L · XL');
    expect(tierText(['M'])).toBe('M');
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
