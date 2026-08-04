import { AgentProvider, PROVIDER_PRESETS, type ProviderBrand } from '@orbit/shared';
import type { RunnerEngineHealth, RunnerModelCatalog, RuntimeDefaultModels } from '@orbit/shared';
import {
  defaultModelForProvider,
  modelOptionsForProvider,
  type ConfiguredProvider,
} from './agentDefaults';

/**
 * What the New Session provider picker shows: the runner's own signed-in engines first, then the
 * user's configured (BYOK) providers. One flat list, but the `kind` distinction survives for the
 * summary under the card — an engine spends the subscription you signed into on that machine, a
 * configured provider spends the API key you pasted.
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
  /** Why this row can't be picked, or absent when it can. Set for an engine whose CLI the runner
   *  doesn't have, or has but says it isn't signed into: the row stays listed, and links to the
   *  Providers page instead of picking, because that is where the install and the sign-in are. */
  unavailable?: string;
}

const ENGINE_LABELS: Record<string, string> = {
  [AgentProvider.CLAUDE]: 'Claude',
  [AgentProvider.CODEX]: 'Codex',
  [AgentProvider.KIMI]: 'Kimi',
  [AgentProvider.OPENCODE]: 'OpenCode',
};

/** One line about a provider's endpoint, for the gallery card and the connect form's identity bar.
 *  Claude and Codex borrow a CLI to speak a dialect the vendor exposes for it, so the dialect is
 *  the useful fact. Kimi is the vendor's own CLI on its own API, where it isn't. */
export const runtimeSummary = (runtime?: string | null): string =>
  runtime === AgentProvider.KIMI
    ? 'Runs on the Kimi CLI'
    : runtime === AgentProvider.CODEX
      ? 'OpenAI-compatible'
      : 'Anthropic-compatible';

// A built-in engine has no ModelProvider row, so it has no preset to inherit a look from. Borrow
// the vendor preset that ships the same mark: the engine and the BYOK provider are the same
// company, and a user who sees both should see one logo.
export const ENGINE_PRESET: Record<string, string> = {
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

/** Why an engine can't run a session on that machine, or undefined when it can. Missing outranks
 *  signed out — a CLI that isn't installed has nothing to sign into. Only the CLI's own "no"
 *  counts for auth: `unknown` is an engine that wouldn't answer, which is not evidence enough to
 *  take the choice away. */
function engineBlocker(health?: RunnerEngineHealth): string | undefined {
  if (!health) return undefined;
  if (!health.installed) return 'Not installed';
  if (health.auth === 'no') return 'Not signed in';
  return undefined;
}

/**
 * The picker's contents: the three engines, then the configured providers in the order the API
 * returned them.
 *
 * Engines carry the health the runner last reported, because an engine choice is a claim about
 * someone else's machine. Not installed there, or installed but signed out → listed with the
 * reason, pointing at the Providers page where that machine gets its install or its sign-in (see
 * `unavailable`). Hiding the row instead would leave a user who pays for Kimi with no way to find
 * out why it isn't offered. A runner that has reported nothing claims nothing, so all three stay
 * pickable — as does any engine missing from a partial report.
 */
export function providerChoices(
  configured: ConfiguredProvider[],
  modelCatalog?: RunnerModelCatalog | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
  engineHealth?: RunnerEngineHealth[] | null,
): ProviderChoice[] {
  const engines: ProviderChoice[] = ENGINE_SLUGS.map((slug) => {
    const blocker = engineBlocker(engineHealth?.find((e) => e.engine === slug));
    return {
      slug,
      label: ENGINE_LABELS[slug] ?? slug,
      kind: 'engine' as const,
      ...brandForProvider(slug, ENGINE_LABELS[slug] ?? slug),
      modelLabel: defaultModelLabel(slug, modelCatalog, configured, runtimeDefaultModels),
      ...(blocker ? { unavailable: blocker } : {}),
    };
  });
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
