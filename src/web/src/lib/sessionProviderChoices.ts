import { AgentProvider, PROVIDER_PRESETS, type ProviderBrand } from '@orbit/shared';
import type { PlanUsage, RunnerAntigravityState, RunnerEngineHealth, RunnerModelCatalog, RuntimeDefaultModels } from '@orbit/shared';
import type { CodexLogin } from './codexLogin';
import { accountNameOf, accountPlanUsage } from './engineAccounts';
import { encodeId } from './idCodec';
import { bindingPlanUsageRow, currentPlanUsageRows } from './planUsage';
import type { SharedPool } from './sharedPools';
import {
  defaultModelForProvider,
  modelOptionsForProvider,
  runtimeForProvider,
  type ConfiguredProvider,
} from './workspaceDefaults';

/**
 * What the New Session provider picker shows: the runner's own signed-in engines first, then the
 * user's configured (BYOK) providers. One flat list, but the `kind` distinction survives for the
 * summary under the card — an engine spends the subscription you signed into on that machine, a
 * configured provider spends the API key you pasted.
 *
 * Engines are the slugs a runner can sign into (LoginEngine in @orbit/shared). Antigravity is
 * offered when the server confirms an environment key or a runner Google account.
 * `opencode` is an AgentProvider that is neither,
 * so it never appears as a choice — it only shows up as the current pick when a workspace is
 * already set to it.
 */
export const ENGINE_SLUGS = [
  AgentProvider.CLAUDE,
  AgentProvider.CODEX,
  AgentProvider.ANTIGRAVITY,
  AgentProvider.KIMI,
] as const;

export type ProviderChoiceKind = 'engine' | 'byok' | 'pool';

/** An account pool as the picker needs it: its slug, its name, and which providers it holds — and,
 *  when none of them can run, why (ProviderPool.unavailable) and the pool's id, whose page fixes it.
 *  `shared` marks a pool read as one of its people (sharedPoolAsProviderPool) — a shared pool of OpenAI
 *  keys, or somebody else's own Codex pool they were added to — which runs on Codex rather than Claude. */
export interface PoolChoiceSource {
  id: string;
  slug: string;
  label: string;
  /** What the pool holds; `login` says a member is one of its ChatGPT accounts rather than a key. */
  members: { slug: string; login?: CodexLogin }[];
  unavailable?: string | null;
  /** `codex` for a pool of one's own ChatGPT account (migration 0323); absent or `claude` otherwise. */
  engine?: string;
  shared?: SharedPool;
}

export interface ProviderChoice {
  slug: string;
  label: string;
  kind: ProviderChoiceKind;
  /** How this Gemini key reaches the runtime, shown in small type beside the identity. */
  labelDetail?: string;
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
  /** Which engine row on the Providers page answers `unavailable`. That is the CLI this choice
   *  runs on, which for a BYOK provider is not its own slug — a Moonshot row is fixed on the Kimi
   *  engine row. Set whenever `unavailable` is about this runner. */
  fixEngine?: string;
  /** Where `unavailable` is fixed when it is not about this runner at all: an account pool none of
   *  whose accounts can run is fixed on the pool's own page. */
  fixHref?: string;
  /** An account pool: how many accounts it holds, counted on its tile. */
  poolSize?: number;
  /** What `poolSize` counts when it is not accounts: a shared pool's keys. */
  poolUnit?: 'key';
  /** A configured provider that is also an account in one of the user's pools. Still pickable on
   *  its own — pinning one account is a real need — but offered behind "Pin a specific account",
   *  since the pool beside it already runs on it. */
  inPool?: boolean;
  /** The runner's own accounts of this engine, when it has signed in more than one: offered under
   *  its row, so a session can start on another account than its workspace's. Codex and Claude — the
   *  engines whose CLI keeps a login per directory (Session.codexAccount, Session.claudeAccount). */
  accounts?: AccountChoice[];
}

/** One of the runner's accounts of an engine, as a row under that engine in the picker. */
export interface AccountChoice {
  /** `default`, or the id of a slot the runner added — what the session is created with. */
  id: string;
  label: string;
  /** Its own quota's tightest window — the one closest to its limit, which is the one that stops it
   *  — compactly: "5h 100%", "Weekly 0%". Absent when the runner reports none. */
  quota?: string;
  /** That window is at least 90% spent — where the composer's quota pill turns orange too. */
  nearLimit?: boolean;
  /** Why it can't take a session: the CLI says it is signed out. */
  unavailable?: string;
}

/** A window's name short enough for a row beside an account's: "5h", "Weekly", "Weekly Opus" — Codex's
 *  "5h limit" and Claude's "5-hour limit" and "Weekly · all models" alike. */
export const compactWindowLabel = (label: string): string =>
  label.replace(/ limit$/, '').replace(/^5-hour$/, '5h').replace(/ · all models$/, '').replace(' · ', ' ');

const ENGINE_LABELS: Record<string, string> = {
  [AgentProvider.CLAUDE]: 'Claude',
  [AgentProvider.CODEX]: 'Codex',
  [AgentProvider.KIMI]: 'Kimi',
  [AgentProvider.OPENCODE]: 'OpenCode',
  [AgentProvider.ANTIGRAVITY]: 'Antigravity',
};

/** Use the runtime's name for the Gemini preset while preserving names the user gave their keys. */
export const providerDisplayLabel = (label: string, presetSlug?: string | null): string =>
  presetSlug === 'gemini' && label === 'Gemini' ? 'Antigravity' : label;

/** One line about a provider's endpoint, for the gallery card and the connect form's identity bar.
 *  Claude and Codex borrow a CLI to speak a dialect the vendor exposes for it, so the dialect is
 *  the useful fact. Kimi and Antigravity are a CLI on its vendor's own API, where it isn't. */
export const runtimeSummary = (runtime?: string | null): string =>
  runtime === AgentProvider.KIMI
    ? 'Runs on the Kimi CLI'
    : runtime === AgentProvider.ANTIGRAVITY
      ? 'Runs on the Antigravity CLI'
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

// Antigravity's environment key and configured Gemini keys share one runtime identity.
const ENGINE_BRAND: Record<string, { brand: ProviderBrand; glyphKey: string }> = {
  [AgentProvider.ANTIGRAVITY]: {
    brand: { mono: 'A', from: '#3186ff', to: '#00b95c' },
    glyphKey: 'antigravity',
  },
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
  if ((presetSlug ?? slug) === 'gemini') return ENGINE_BRAND[AgentProvider.ANTIGRAVITY];
  const presetKey = presetSlug ?? ENGINE_PRESET[slug];
  const preset = presetKey ? PROVIDER_PRESETS.find((p) => p.slug === presetKey) : undefined;
  if (preset) return { brand: preset.brand, glyphKey: preset.slug };
  return ENGINE_BRAND[slug] ?? { brand: NEUTRAL_BRAND(label) };
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
  if (!model) {
    if (runtimeForProvider(slug, configured) === AgentProvider.ANTIGRAVITY) {
      const preset = PROVIDER_PRESETS.find((p) => p.slug === 'gemini')!;
      return preset.models.find((option) => option.value === preset.defaultModel)?.label ?? preset.defaultModel;
    }
    return 'Managed by the provider';
  }
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

/** The same question for a configured provider, which runs by borrowing an engine's CLI (a
 *  Moonshot row spawns the Kimi CLI with its key in the environment). The binary has to be there,
 *  so a missing one blocks it exactly as it blocks the engine. Sign-in doesn't apply: the pasted
 *  key is the credential, and a signed-out CLI runs this provider fine. */
function byokBlocker(health?: RunnerEngineHealth): string | undefined {
  return health && !health.installed ? 'Not installed' : undefined;
}

/** Antigravity admission uses the runner capability the server reads when dispatching. */
function antigravityBlocker(state?: RunnerAntigravityState, health?: RunnerEngineHealth, login = false): string | undefined {
  if (state?.supported === false) return 'Update runner';
  if (state?.installed === false) return 'Not installed';
  if (login) {
    if (health?.auth === 'no' || (state?.authSource === 'google' && !state.envKeyAvailable)) return 'Not signed in';
    return engineBlocker(health);
  }
  return byokBlocker(health);
}

/**
 * The picker's contents: the engines, with Antigravity keys beside their engine, then the other
 * configured providers in the order the API returned them.
 *
 * Engines carry the health the runner last reported, because an engine choice is a claim about
 * someone else's machine. Not installed there, or installed but signed out → listed with the
 * reason, pointing at the Providers page where that machine gets its install or its sign-in (see
 * `unavailable`). Hiding the row instead would leave a user who pays for Kimi with no way to find
 * out why it isn't offered. A runner that has reported nothing claims nothing, so every engine
 * stays pickable — as does any engine missing from a partial report.
 *
 * A configured provider is judged the same way through the engine it borrows, since that CLI is
 * what actually runs it — a Moonshot row on a machine without the Kimi CLI reads "Not installed"
 * just as the Kimi engine does, and points at the same install.
 *
 * The user's account pools come after the engines, each one choice that runs on Claude with its
 * accounts' own keys. The providers in a pool stay pickable, marked `inPool` for the picker to fold
 * away. `configured` is expected to carry the pools too (poolsAsProviders), since that is where a
 * pool's models and runtime are resolved from; `pools` says which of its entries are pools.
 *
 * `planUsage` is the runner's quota report, read for each of its Codex and Claude accounts' own windows.
 */
export function providerChoices(
  configured: ConfiguredProvider[],
  modelCatalog?: RunnerModelCatalog | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
  engineHealth?: RunnerEngineHealth[] | null,
  pools: readonly PoolChoiceSource[] = [],
  planUsage?: PlanUsage | null,
  antigravity?: RunnerAntigravityState,
  antigravityKeyAvailable: boolean = antigravity?.envKeyAvailable ?? false,
): ProviderChoice[] {
  const usesGoogleAccount = antigravity?.authSource === 'google' && !(antigravityKeyAvailable && !antigravity.envKeyAvailable);
  const engines: ProviderChoice[] = ENGINE_SLUGS.filter(
    (slug) => slug !== AgentProvider.ANTIGRAVITY || antigravityKeyAvailable || antigravity?.authSource === 'google',
  ).map((slug) => {
    const health = engineHealth?.find((e) => e.engine === slug);
    const blocker = slug === AgentProvider.ANTIGRAVITY ? antigravityBlocker(antigravity, health, !antigravityKeyAvailable || usesGoogleAccount) : engineBlocker(health);
    const accounts =
      (slug === AgentProvider.CODEX || slug === AgentProvider.CLAUDE) && !blocker && (health?.accounts?.length ?? 0) >= 2
        ? health!.accounts!.map((account): AccountChoice => {
            const snapshot = accountPlanUsage(planUsage, slug, account.id);
            // The window that stops it: a Claude login's 5-hour window can read 0% while its weekly
            // one is spent, and the first window alone would say it has room.
            const quota =
              account.auth === 'yes' && snapshot ? bindingPlanUsageRow(currentPlanUsageRows(snapshot)) : undefined;
            return {
              id: account.id,
              label: accountNameOf(account),
              ...(quota
                ? {
                    quota: `${compactWindowLabel(quota.label)} ${quota.percent}%`,
                    ...(quota.nearLimit ? { nearLimit: true } : {}),
                  }
                : {}),
              ...(account.auth === 'no' ? { unavailable: 'Not signed in' } : {}),
            };
          })
        : undefined;
    return {
      slug,
      label: ENGINE_LABELS[slug] ?? slug,
      kind: 'engine' as const,
      ...(slug === AgentProvider.ANTIGRAVITY ? { labelDetail: usesGoogleAccount ? 'Google account' : 'env key' } : {}),
      ...brandForProvider(slug, ENGINE_LABELS[slug] ?? slug),
      modelLabel: defaultModelLabel(slug, modelCatalog, configured, runtimeDefaultModels),
      ...(blocker ? { unavailable: blocker, fixEngine: slug } : {}),
      ...(accounts ? { accounts } : {}),
    };
  });
  // Like a configured provider, a pool needs the CLI it runs on and nothing signed in: each run
  // carries one of its accounts' keys. And it needs one of those accounts to be able to run at all,
  // which the server says (`unavailable`) and refuses the pool without. A shared pool's CLI is Codex,
  // whose runs carry a session token for the pool's gateway — and so is a pool of one's own ChatGPT
  // account's, whose account the server holds.
  //
  // Somebody a pool's owner added runs on the pool's ChatGPT accounts first and on its keys when none
  // can (pool-credential-select.ts, 2026-10-03), so what the pool holds is what they can run on, and the
  // pool's own answer (`unavailable`, built the same way for them as for its owner) is the whole reason.
  const accountPools: ProviderChoice[] = pools.map((pool) => {
    const runtime = pool.shared || pool.engine === AgentProvider.CODEX ? AgentProvider.CODEX : AgentProvider.CLAUDE;
    const blocker = byokBlocker(engineHealth?.find((e) => e.engine === runtime));
    return {
      slug: pool.slug,
      label: pool.label,
      kind: 'pool' as const,
      ...brandForProvider(pool.slug, pool.label, ENGINE_PRESET[runtime]),
      modelLabel: defaultModelLabel(pool.slug, modelCatalog, configured, runtimeDefaultModels),
      poolSize: pool.members.length,
      // 'N keys' only where the pool really is nothing but keys; a pool holding ChatGPT accounts counts
      // accounts (the viewer's own words — AccountPools' memberNoun).
      ...(pool.shared && !pool.members.some((member) => member.login) ? { poolUnit: 'key' as const } : {}),
      ...(blocker
        ? { unavailable: blocker, fixEngine: runtime }
        : pool.unavailable
          ? { unavailable: pool.unavailable, fixHref: `/providers/pools/${encodeId(pool.id)}` }
          : {}),
    };
  });
  const poolSlugs = new Set(pools.map((pool) => pool.slug));
  const pooled = new Set(pools.flatMap((pool) => pool.members.map((member) => member.slug)));
  // A configured row that shadows a built-in slug would give the picker two rows that dispatch
  // the same identity; the engine entry above already covers it.
  const byok: ProviderChoice[] = configured
    .filter((p) => !ENGINE_SLUGS.some((slug) => slug === p.slug) && !poolSlugs.has(p.slug))
    .map((p) => {
      const runtime = runtimeForProvider(p.slug, configured);
      const health = engineHealth?.find((e) => e.engine === runtime);
      const blocker = runtime === AgentProvider.ANTIGRAVITY ? antigravityBlocker(antigravity, health) : byokBlocker(health);
      return {
        slug: p.slug,
        label: providerDisplayLabel(p.label, p.presetSlug),
        kind: 'byok' as const,
        ...(runtime === AgentProvider.ANTIGRAVITY ? { labelDetail: 'API key' } : {}),
        ...brandForProvider(p.slug, p.label, p.presetSlug),
        modelLabel: defaultModelLabel(p.slug, modelCatalog, configured, runtimeDefaultModels),
        ...(blocker ? { unavailable: blocker, fixEngine: runtime } : {}),
        ...(pooled.has(p.slug) ? { inPool: true } : {}),
      };
    });
  const antigravityKeys = byok.filter((choice) => runtimeForProvider(choice.slug, configured) === AgentProvider.ANTIGRAVITY);
  return [
    ...engines.flatMap((choice) => choice.slug === AgentProvider.KIMI ? [...antigravityKeys, choice] : [choice]),
    ...accountPools,
    ...byok.filter((choice) => !antigravityKeys.includes(choice)),
  ];
}

/**
 * The providers a session that is already running may be moved to: the ones that borrow the same
 * runtime CLI it was started on.
 *
 * That is the whole rule, and it is the session's own history that imposes it — the transcript,
 * the resume id and the wire protocol belong to the CLI that started the conversation, so
 * claude→codex is a new session rather than a setting. Two Anthropic accounts, or an account and
 * a compatible endpoint, are the same CLI with different credentials: the engine re-spawns with
 * `--resume` and the conversation carries over. The backend enforces the same rule
 * (SessionsService.updateConfig); this is what keeps the picker from offering a rejected move.
 *
 * A choice this machine can't currently run stays listed, carrying its reason, for the same
 * reason the New Session picker keeps it: a user who has signed into Claude somewhere, or pays
 * for it, must be able to see WHY it isn't on offer. Dropping the row turns "not signed in on
 * this runner" into "Orbit lost my provider". The composer greys it out instead — the caller
 * reads `unavailable`.
 *
 * Order is `choices`' own — engines, then configured providers as the API returned them — and is
 * deliberately NOT rotated to put the current one first. This menu is the same short list every
 * time it opens, so its rows should sit where they sat last time; re-ordering per selection made
 * two sessions on one runtime disagree about where "DeepSeek" lives, and made the New Session
 * picker disagree with both. The current row is marked by the tick, not by position.
 *
 * The one exception is a provider that isn't in `choices` at all — removed, disabled, or
 * `opencode`, which is never offered. That has no natural position, so it leads.
 */
export function sameRuntimeChoices(
  provider: string,
  choices: ProviderChoice[],
  configured: ConfiguredProvider[],
  modelCatalog?: RunnerModelCatalog | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
  antigravity?: RunnerAntigravityState,
): ProviderChoice[] {
  const runtime = runtimeForProvider(provider, configured);
  const sameRuntime = choices.filter(
    (choice) => runtimeForProvider(choice.slug, configured) === runtime,
  );
  if (sameRuntime.some((choice) => choice.slug === provider)) return sameRuntime;
  return [
    currentProviderChoice(provider, choices, modelCatalog, configured, runtimeDefaultModels, antigravity),
    ...sameRuntime,
  ];
}

/**
 * The choice to show as current. The workspace's own provider normally resolves to a row above, but
 * two cases don't: a workspace set to `opencode`, and one pointing at a provider that has since been
 * removed or disabled. Both still have to render something truthful rather than silently reading
 * as Claude, so they get a synthesized entry.
 */
export function currentProviderChoice(
  provider: string,
  choices: ProviderChoice[],
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
  antigravity?: RunnerAntigravityState,
): ProviderChoice {
  const found = choices.find((c) => c.slug === provider);
  if (found) return found;
  const label = ENGINE_LABELS[provider] ?? provider;
  const blocker = provider === AgentProvider.ANTIGRAVITY ? antigravityBlocker(antigravity, undefined, !antigravity?.envKeyAvailable) : undefined;
  return {
    slug: provider,
    label,
    kind: Object.values(AgentProvider).some((p) => p === provider) ? 'engine' : 'byok',
    ...(provider === AgentProvider.ANTIGRAVITY ? { labelDetail: antigravity?.authSource === 'google' ? 'Google account' : 'env key' } : {}),
    ...(blocker ? { unavailable: blocker, fixEngine: AgentProvider.ANTIGRAVITY } : {}),
    ...brandForProvider(provider, label),
    modelLabel: defaultModelLabel(provider, modelCatalog, configured, runtimeDefaultModels),
  };
}

/** An engine — the CLI a session runs on — as the New Session hero lists it. Which provider of that
 *  engine the session spends (its own sign-in, an account pool, a key that borrows it) is the
 *  composer's Provider menu's question, so a row here names the engine and the provider a pick of
 *  it lands on. */
export interface EngineChoice {
  slug: AgentProvider;
  label: string;
  brand: ProviderBrand;
  glyphKey?: string;
  /** Where picking this engine lands: the preferred provider of it, else its own sign-in, else the
   *  first of its providers that can run (`engineChoices`). */
  provider: ProviderChoice;
  /** Why none of this engine's providers can run here, and where that is fixed — the landing
   *  provider's own reason, since there is no better one to pick. */
  unavailable?: string;
  fixEngine?: string;
  fixHref?: string;
}

/** The engine row for `provider`, landing on it. Also how the hero names a pick that is in no group
 *  (`opencode`, a removed provider): its runtime, on the synthesized current choice. */
export function engineChoiceFor(provider: ProviderChoice, configured?: ConfiguredProvider[] | null): EngineChoice {
  const slug = runtimeForProvider(provider.slug, configured);
  const label = ENGINE_LABELS[slug] ?? slug;
  return {
    slug,
    label,
    ...brandForProvider(slug, label),
    provider,
    ...(provider.unavailable
      ? {
          unavailable: provider.unavailable,
          ...(provider.fixEngine ? { fixEngine: provider.fixEngine } : {}),
          ...(provider.fixHref ? { fixHref: provider.fixHref } : {}),
        }
      : {}),
  };
}

/**
 * `choices` grouped by the engine that runs them, in the order the engines first appear there. Each
 * engine lands on the first of `preferred` it holds that can run (the draft's pick, then what the
 * workspace last ran on), else its own sign-in, else the first of its providers that can run — one
 * in a pool last, since the pool beside it is the usual answer. An engine none of whose providers can
 * run lands on its own row (or its first) and carries that row's reason.
 */
export function engineChoices(
  choices: ProviderChoice[],
  configured: ConfiguredProvider[],
  preferred: readonly (string | null | undefined)[] = [],
): EngineChoice[] {
  const groups = new Map<AgentProvider, ProviderChoice[]>();
  for (const choice of choices) {
    const runtime = runtimeForProvider(choice.slug, configured);
    groups.set(runtime, [...(groups.get(runtime) ?? []), choice]);
  }
  return [...groups.entries()].map(([engine, group]) => {
    const ready = group.filter((choice) => !choice.unavailable);
    const landing =
      preferred.map((slug) => ready.find((choice) => choice.slug === slug)).find(Boolean) ??
      ready.find((choice) => choice.slug === engine) ??
      ready.find((choice) => !choice.inPool) ??
      ready[0] ??
      group.find((choice) => choice.slug === engine) ??
      group[0];
    return engineChoiceFor(landing, configured);
  });
}

/** How the hero says which provider its engine runs on: nothing extra for the engine's own sign-in
 *  (bar how it signs in, for Antigravity), "via DeepSeek" for anything else. */
export const engineProviderDetail = (engine: EngineChoice): string | undefined =>
  engine.provider.slug === engine.slug ? engine.provider.labelDetail : `via ${engine.provider.label}`;
