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
      // Harness choices are opaque ACP values that must come from configOptions. It has no
      // static model/default/window fallback (docs/deepseek-harness-runtime-contract.md §4).
      if (p.runtime === AgentProvider.DSH) {
        expect(p.modelsFromRuntime).toBe(true);
        expect(p.models).toEqual([]);
        expect(p.defaultModel).toBe('');
        continue;
      }
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

  it('keeps every maintained list on a catalogue that recognizes its own models', () => {
    for (const p of PROVIDER_PRESETS) {
      if (!p.catalog) {
        // The only lists allowed to stand still are the ones the runner's CLI reports instead.
        expect(p.modelsFromRuntime).toBe(true);
        continue;
      }
      expect(p.catalog.source.trim()).not.toBe('');
      // A pattern that rejects the ids we ship is a typo — it would filter every refresh down to
      // nothing and freeze the list without anything failing.
      for (const m of p.models) expect(m.value).toMatch(p.catalog.match);
    }
  });

  it('points at an https endpoint', () => {
    for (const p of PROVIDER_PRESETS) expect(p.baseUrl).toMatch(/^https:\/\//);
  });

  it('runs Kimi on the Kimi CLI, pointed at the API that CLI speaks', () => {
    const kimi = providerPreset('moonshot')!;
    // Picking Kimi has to reach the Kimi CLI through either door — the runner's own sign-in or a
    // key pasted here. Its injected provider (KIMI_MODEL_*) takes Moonshot's platform API, not the
    // Anthropic-compatible shim other CLIs are given, so runtime and endpoint move together.
    expect(kimi.runtime).toBe('kimi');
    expect(kimi.baseUrl).toBe('https://api.moonshot.ai/v1');
  });

  it('runs Gemini on the Antigravity CLI, pointed at the API that CLI speaks', () => {
    const gemini = providerPreset('gemini')!;
    // Codex needs the Responses API, which Google's OpenAI-compatible endpoint never served, so
    // no session could run on the old pairing. agy speaks the Gemini API itself and appends
    // /v1beta/models/… to the host it is given.
    expect(gemini.runtime).toBe('antigravity');
    expect(gemini.baseUrl).toBe('https://generativelanguage.googleapis.com');
    expect(gemini.note).toBeUndefined();
    // agy refuses a model it doesn't list, so the list is agy's — read from the runner, with these
    // as the fallback: one row per model, its thinking levels folded out of the slug as the
    // runner folds them (`gemini-3.8-flash-high` is `gemini-3.8-flash` at `high`).
    expect(gemini.modelsFromRuntime).toBe(true);
    expect(gemini.catalog).toBeUndefined();
    for (const m of gemini.models) expect(m.value).not.toMatch(/-(low|medium|high)$/);
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
