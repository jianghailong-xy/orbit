import { describe, expect, it } from 'vitest';
import { AgentProvider } from './enums';
import { PROVIDER_PRESETS, providerPreset } from './providerPresets';

// The catalogue is hand-edited whenever a vendor ships a model, and the server now derives real
// behaviour from it — a configured provider's picker list, and the model a session dispatches with
// when nothing overrides it. These guard the shape a bad edit would break.
describe('PROVIDER_PRESETS', () => {
  it('has a unique, dispatchable slug per vendor', () => {
    const slugs = PROVIDER_PRESETS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      // Same rule the server enforces on a configured provider (ProvidersService.assertSlug).
      expect(slug).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(Object.values(AgentProvider)).not.toContain(slug);
    }
  });

  it('offers at least one model, and defaults to one of them', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.models.length).toBeGreaterThan(0);
      // A default outside the list would leave the picker showing one model and the runner
      // launching another.
      expect(p.models.map((m) => m.value)).toContain(p.defaultModel);
      for (const m of p.models) {
        expect(m.value.trim()).not.toBe('');
        expect(m.label.trim()).not.toBe('');
      }
    }
  });

  it('points at an https endpoint', () => {
    for (const p of PROVIDER_PRESETS) expect(p.baseUrl).toMatch(/^https:\/\//);
  });

  it('resolves a preset only for a slug it knows', () => {
    expect(providerPreset('anthropic')?.label).toBe('Anthropic (Claude)');
    expect(providerPreset('moonshot')?.label).toBe('Kimi (Moonshot)');
    expect(providerPreset('kimi')).toBeUndefined();
    expect(providerPreset('nope')).toBeUndefined();
    expect(providerPreset(null)).toBeUndefined();
    expect(providerPreset(undefined)).toBeUndefined();
  });
});
