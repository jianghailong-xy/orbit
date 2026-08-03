import { AgentProvider, PROVIDER_PRESETS, type ProviderBrand } from '@orbit/shared';
import type { RunnerModelCatalog, RuntimeDefaultModels } from '@orbit/shared';
import {
  defaultModelForProvider,
  modelOptionsForProvider,
  type ConfiguredProvider,
} from './agentDefaults';

/**
 * What the New Session provider picker shows: the runner's own signed-in engines first, then the
 * user's configured (BYOK) providers. Two groups, because they differ in the one way a user cares
 * about — an engine spends the subscription you signed into on that machine, a configured provider
 * spends the API key you pasted.
 *
 * Engines are exactly the slugs a runner can sign into (LoginEngine in @orbit/shared). `opencode`
 * is a fourth AgentProvider but not a login engine, so it never appears as a choice — it only
 * shows up as the current pick when an agent is already set to it.
 */
export const ENGINE_SLUGS = [
  AgentProvider.CLAUDE,
  AgentProvider.CODEX,
  AgentProvider.KIMI,
] as const;

export type ProviderChoiceKind = 'engine' | 'byok';

export interface ProviderChoice {
  slug: string;
  label: string;
  kind: ProviderChoiceKind;
  /** Brand mark for the tile: the vendor's gradient plus the glyph key to draw on it. */
  brand: ProviderBrand;
  /** Which PROVIDER_GLYPHS entry to draw, or undefined to fall back to the monogram. */
  glyphKey?: string;
  /** The model this choice will run with when nothing overrides it, already resolved to a
   *  human label — so "switching provider changes your model" is visible before the click. */
  modelLabel: string;
}

const ENGINE_LABELS: Record<string, string> = {
  [AgentProvider.CLAUDE]: 'Claude',
  [AgentProvider.CODEX]: 'Codex',
  [AgentProvider.KIMI]: 'Kimi',
  [AgentProvider.OPENCODE]: 'OpenCode',
};

// A built-in engine has no ModelProvider row, so it has no preset to inherit a look from. Borrow
// the vendor preset that ships the same mark: the engine and the BYOK provider are the same
// company, and a user who sees both should see one logo.
const ENGINE_PRESET: Record<string, string> = {
  [AgentProvider.CLAUDE]: 'anthropic',
  [AgentProvider.CODEX]: 'openai',
  [AgentProvider.KIMI]: 'moonshot',
};

const NEUTRAL_BRAND = (label: string): ProviderBrand => ({
  mono: (label.trim()[0] ?? '?').toUpperCase(),
  from: '#9aa0a8',
  to: '#6b7178',
});

/** The brand + glyph for any provider identity: a built-in engine, a preset-backed BYOK row, or
 *  a self-maintained custom endpoint (which gets a neutral monogram). */
export function brandForProvider(
  slug: string,
  label: string,
  presetSlug?: string | null,
): { brand: ProviderBrand; glyphKey?: string } {
  const presetKey = presetSlug ?? ENGINE_PRESET[slug];
  const preset = presetKey ? PROVIDER_PRESETS.find((p) => p.slug === presetKey) : undefined;
  if (preset) return { brand: preset.brand, glyphKey: preset.slug };
  return { brand: NEUTRAL_BRAND(label) };
}

/** The label to show for a provider's resolved default model. Falls back to the raw id when the
 *  catalogue doesn't name it, and to a plain hint when the provider picks for itself (OpenCode). */
export function defaultModelLabel(
  slug: string,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
): string {
  const model = defaultModelForProvider(slug, modelCatalog, configured, runtimeDefaultModels);
  if (!model) return 'Managed by the provider';
  const named = modelOptionsForProvider(slug, modelCatalog, configured).find(
    (option) => option.value === model,
  );
  return named?.label ?? model;
}

/**
 * The picker's contents. Engines always come first and are always all three: they're what a user
 * with nothing configured can still run, so the picker must never be empty. Configured providers
 * follow in the order the API returned them.
 */
export function providerChoices(
  configured: ConfiguredProvider[],
  modelCatalog?: RunnerModelCatalog | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
): ProviderChoice[] {
  const engines: ProviderChoice[] = ENGINE_SLUGS.map((slug) => ({
    slug,
    label: ENGINE_LABELS[slug] ?? slug,
    kind: 'engine' as const,
    ...brandForProvider(slug, ENGINE_LABELS[slug] ?? slug),
    modelLabel: defaultModelLabel(slug, modelCatalog, configured, runtimeDefaultModels),
  }));
  // A configured row that shadows a built-in slug would give the picker two rows that dispatch
  // the same identity; the engine entry above already covers it.
  const byok: ProviderChoice[] = configured
    .filter((p) => !ENGINE_SLUGS.some((slug) => slug === p.slug))
    .map((p) => ({
      slug: p.slug,
      label: p.label,
      kind: 'byok' as const,
      ...brandForProvider(p.slug, p.label, p.presetSlug),
      modelLabel: defaultModelLabel(p.slug, modelCatalog, configured, runtimeDefaultModels),
    }));
  return [...engines, ...byok];
}

/**
 * The choice to show as current. The agent's own provider normally resolves to a row above, but
 * two cases don't: an agent set to `opencode`, and one pointing at a provider that has since been
 * removed or disabled. Both still have to render something truthful rather than silently reading
 * as Claude, so they get a synthesized entry.
 */
export function currentProviderChoice(
  provider: string,
  choices: ProviderChoice[],
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
): ProviderChoice {
  const found = choices.find((c) => c.slug === provider);
  if (found) return found;
  const label = ENGINE_LABELS[provider] ?? provider;
  return {
    slug: provider,
    label,
    kind: Object.values(AgentProvider).some((p) => p === provider) ? 'engine' : 'byok',
    ...brandForProvider(provider, label),
    modelLabel: defaultModelLabel(provider, modelCatalog, configured, runtimeDefaultModels),
  };
}
