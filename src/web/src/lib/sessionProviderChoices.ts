import {
  AgentProvider,
  ALL_ENGINES,
  ENGINE_CLI_NAMES,
  isAccountEngine,
  PROVIDER_PRESETS,
  withEnginePlanUsage,
  type ProviderBrand,
} from '@orbit/shared';
import type { PlanUsage, RunnerAntigravityState, RunnerEngineHealth, RunnerModelCatalog, RuntimeDefaultModels } from '@orbit/shared';
import type { CodexLogin } from './codexLogin';
import { DSH_CONNECT_HREF, DSH_PRESET_SLUG, DSH_STATE_LABEL, dshRunnerState, type DshRunnerFacts } from './dshRuntime';
import { accountNameOf, accountPlanUsage, runsOnEnvKey } from './engineAccounts';
import { encodeId } from './idCodec';
import { bindingPlanUsageRow, currentPlanUsageRows } from './planUsage';
import type { SharedPool } from './sharedPools';
import {
  defaultModelFor,
  isLoginProvider,
  modelOptionsFor,
  providerEngines,
  type ConfiguredProvider,
} from './workspaceDefaults';

/**
 * What the pickers offer, engine first: the New Session hero lists the engines — the CLIs a session
 * runs on, fixed for its life — and the composer's Provider menu lists the credentials the session's
 * engine can run on (docs/provider-engine-contract.md §2.1): its own sign-in on the runner with that
 * machine's accounts, the account pools on it, and every key it runs — the same DeepSeek key under
 * Claude Code, DeepSeek Harness and OpenCode alike.
 *
 * The engines a runner signs into (LoginEngine in @orbit/shared). Antigravity's sign-in is offered
 * when the server confirms an environment key or a runner Google account. `opencode` has no sign-in
 * to offer, only its own configuration; `dsh` runs on DeepSeek keys alone.
 */
export const ENGINE_SLUGS = [
  AgentProvider.CLAUDE,
  AgentProvider.CODEX,
  AgentProvider.ANTIGRAVITY,
  AgentProvider.KIMI,
] as const;

/** Where a credential comes from: the engine's own sign-in on the runner (`login`), OpenCode's own
 *  configuration there (`opencode`), an account pool, or one of the user's keys. */
export type ProviderChoiceKind = 'login' | 'opencode' | 'pool' | 'key';

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

/**
 * One credential an engine can run on, as the Provider menu lists it under that engine. A key is a
 * choice under every engine that runs it; picking one never changes the engine.
 */
export interface ProviderChoice {
  /** What a session on it stores as its provider: the engine's name for its own sign-in, `opencode`
   *  for OpenCode's own configuration, the pool's or the key's slug. */
  slug: string;
  label: string;
  kind: ProviderChoiceKind;
  /** Which credential an engine's own sign-in is, in small type beside it: Antigravity's Google
   *  account or the machine's Gemini key, OpenCode's `opencode auth`. */
  labelDetail?: string;
  /** Brand mark for the tile: the vendor's gradient plus the glyph key to draw on it. */
  brand: ProviderBrand;
  /** Which PROVIDER_GLYPHS entry to draw, or undefined to fall back to the monogram. */
  glyphKey?: string;
  /** The model a session on this engine and credential runs with when nothing overrides it, already
   *  resolved to a human label — so "switching provider changes your model" is visible before the
   *  click. */
  modelLabel: string;
  /** Why this row can't be picked, or absent when it can. Set for a credential the engine can't run
   *  on that machine — its CLI missing there, or its sign-in signed out: the row stays listed, and
   *  links to Infrastructure instead of picking, because that is where the install and the sign-in
   *  are. */
  unavailable?: string;
  /** Which engine row in Infrastructure answers `unavailable` — the engine the menu is for. Set
   *  whenever `unavailable` is about this runner. */
  fixEngine?: string;
  /** Where `unavailable` is fixed when it is not about this runner at all: an account pool none of
   *  whose accounts can run is fixed on the pool's own page. */
  fixHref?: string;
  /** An account pool: how many accounts it holds, counted on its tile. */
  poolSize?: number;
  /** What `poolSize` counts when it is not accounts: a shared pool's keys. */
  poolUnit?: 'key';
  /** A key that is also an account in one of the user's pools. Still pickable on its own — pinning
   *  one account is a real need — but a session lands on the pool beside it first. */
  inPool?: boolean;
  /** The runner's own accounts of this engine, when it has signed in more than one: offered under
   *  the sign-in, so a session can start on another account than its workspace's. Codex, Claude,
   *  Antigravity and Kimi — the engines whose CLI keeps a login per directory (Session.codexAccount,
   *  Session.claudeAccount, Session.antigravityAccount, Session.kimiAccount). */
  accounts?: AccountChoice[];
}

/** One of the runner's accounts of an engine, as a row under that engine in the picker. */
export interface AccountChoice {
  /** `default`, or the id of a slot the runner added — what the session is created with. */
  id: string;
  label: string;
  /** Its own quota's tightest window — the one closest to its limit, which is the one that stops it
   *  — compactly: "5h 100%", "Weekly 0%"; for Antigravity the bucket with the least left, by agy's
   *  name for it: "gemini-5h 4% left". Absent when the runner reports none. "env key" for
   *  Antigravity's Default on a runner that runs it on its Gemini key, which has no quota to show. */
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

/** Use the runtime's name for the Gemini preset while preserving names the user gave their keys. */
export const providerDisplayLabel = (label: string, presetSlug?: string | null): string =>
  presetSlug === 'gemini' && label === 'Gemini' ? 'Antigravity' : label;

/** One line about a provider's endpoint, for the gallery card and the connect form's identity bar.
 *  Claude and Codex borrow a CLI to speak a dialect the vendor exposes for it, so the dialect is
 *  the useful fact. Kimi and Antigravity are a CLI on its vendor's own API, where it isn't. */
export const runtimeSummary = (runtime?: string | null, presetSlug?: string | null): string =>
  runtime === AgentProvider.KIMI
    ? 'Runs on the Kimi CLI'
    : runtime === AgentProvider.ANTIGRAVITY
      ? 'Runs on the Antigravity CLI'
      : runtime === AgentProvider.DSH
        ? 'Runs on DeepSeek Harness'
        : runtime === AgentProvider.CODEX
          ? 'OpenAI-compatible'
          : // DeepSeek's two presets share a vendor and a key; which agent runs is what tells them apart.
            presetSlug === 'deepseek'
            ? 'Runs on Claude Code'
            : 'Anthropic-compatible';

// A built-in engine has no ModelProvider row, so it has no preset to inherit a look from. Borrow
// the vendor preset that ships the same mark: the engine and the BYOK provider are the same
// company, and a user who sees both should see one logo.
export const ENGINE_PRESET: Record<string, string> = {
  [AgentProvider.CLAUDE]: 'anthropic',
  [AgentProvider.CODEX]: 'openai',
  [AgentProvider.KIMI]: 'moonshot',
};

// Antigravity, the engine, ships no preset to borrow a mark from. A Gemini key is Google Gemini's
// and wears that preset's own.
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
  if (slug === AgentProvider.DSH && !presetSlug) presetSlug = DSH_PRESET_SLUG;
  const presetKey = presetSlug ?? ENGINE_PRESET[slug];
  const preset = presetKey ? PROVIDER_PRESETS.find((p) => p.slug === presetKey) : undefined;
  if (preset) return { brand: preset.brand, glyphKey: preset.slug };
  return ENGINE_BRAND[slug] ?? { brand: NEUTRAL_BRAND(label) };
}

/** The label to show for the model a session on `engine` with `provider` resolves to. Falls back to
 *  the raw id when the catalogue doesn't name it; an engine that picks for itself shows the option
 *  that says so — OpenCode's "Managed by OpenCode", agy's fallback named for Gemini's default. */
export function defaultModelLabel(
  engine: AgentProvider,
  provider: string,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
): string {
  const model = defaultModelFor(engine, provider, modelCatalog, configured, runtimeDefaultModels);
  const named = modelOptionsFor(engine, provider, modelCatalog, configured).find((option) => option.value === model);
  if (named) return named.label;
  return model || 'Managed by the provider';
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

/** Harness admission, read the way the server reads it (dshRunnerState). Its credential is the
 *  configured key itself, so there is nothing to be signed into. */
function dshBlocker(runner: DshRunnerFacts | null | undefined): string | undefined {
  const state = dshRunnerState(runner);
  return state === 'ready' ? undefined : DSH_STATE_LABEL[state];
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

/** What the pickers judge an engine and its credentials by: the account's keys and pools, and the
 *  runner a session would run on. */
export interface ChoiceSources {
  /** GET /providers, with the pools read as providers too (poolsAsProviders) — where a pool's models
   *  are resolved from; `pools` says which of its entries are pools. */
  configured: ConfiguredProvider[];
  modelCatalog?: RunnerModelCatalog | null;
  runtimeDefaultModels?: RuntimeDefaultModels;
  /** The engines' health as the runner last reported it. A runner that has reported nothing claims
   *  nothing, so everything stays pickable — as does any engine missing from a partial report. */
  engineHealth?: RunnerEngineHealth[] | null;
  pools?: readonly PoolChoiceSource[];
  /** The runner's quota report, read for each of its Codex, Claude and Kimi accounts' own windows; its
   *  Antigravity accounts' travel with `engineHealth` and are read from there (withEnginePlanUsage). */
  planUsage?: PlanUsage | null;
  antigravity?: RunnerAntigravityState;
  /** Whether Antigravity's sign-in runs on the machine's Gemini key for this workspace. */
  antigravityKeyAvailable?: boolean;
  dshRunner?: DshRunnerFacts | null;
}

/** An engine and a provider of it — a draft's pick, or what a workspace last ran on. */
export interface EnginePick {
  engine: string | null | undefined;
  provider: string | null | undefined;
}

/** The engine an account pool runs on: Codex for a shared pool and for one of one's own ChatGPT
 *  accounts, Claude Code otherwise. */
const poolEngine = (pool: PoolChoiceSource): AgentProvider =>
  pool.shared || pool.engine === AgentProvider.CODEX ? AgentProvider.CODEX : AgentProvider.CLAUDE;

/** OpenCode has no sign-in to judge, only whether it is there: Orbit installs it, so a machine without
 *  it lists it with the reason. A runner that has reported nothing claims nothing. */
const openCodeMissing = (engineHealth?: RunnerEngineHealth[] | null): boolean =>
  !!engineHealth && engineHealth.find((e) => e.engine === AgentProvider.OPENCODE)?.installed !== true;

/** What an account's sign-in is called in the menu: the one account the runner reports by its own
 *  name, else Default — the account dispatch resolves a session on the sign-in to. */
const signInLabel = (health?: RunnerEngineHealth): string =>
  health?.accounts?.length === 1 ? accountNameOf(health.accounts[0]) : 'Default';

/** The runner's accounts of an engine, when it has signed in more than one: each with its own
 *  quota's tightest window, as the composer's quota pill reads it. */
function accountChoices(
  engine: AgentProvider,
  health: RunnerEngineHealth | undefined,
  usage: PlanUsage | null | undefined,
): AccountChoice[] | undefined {
  if (!isAccountEngine(engine) || (health?.accounts?.length ?? 0) < 2) return undefined;
  return health!.accounts!.map((account): AccountChoice => {
    // Antigravity's Default on the runner's Gemini key: it runs, on the key, with no quota.
    if (runsOnEnvKey(health, account)) return { id: account.id, label: accountNameOf(account), quota: 'env key' };
    const snapshot = accountPlanUsage(usage, engine, account.id);
    // The window that stops it: a Claude login's 5-hour window can read 0% while its weekly one is
    // spent, and the first window alone would say it has room.
    const quota = account.auth === 'yes' && snapshot ? bindingPlanUsageRow(currentPlanUsageRows(snapshot)) : undefined;
    return {
      id: account.id,
      label: accountNameOf(account),
      ...(quota
        ? {
            // Antigravity's buckets say what is left, under agy's own names for them.
            quota: quota.remaining
              ? `${quota.groupLabel ?? quota.label} ${quota.percent}% left`
              : `${compactWindowLabel(quota.label)} ${quota.percent}%`,
            ...(quota.nearLimit ? { nearLimit: true } : {}),
          }
        : {}),
      ...(account.auth === 'no' ? { unavailable: 'Not signed in' } : {}),
    };
  });
}

/**
 * The credentials `engine` can run on, in the Provider menu's order: the engine's own sign-in on the
 * runner — or OpenCode's own configuration — then the account pools that run on it, then every key it
 * runs (shared providerEngines.ts, read off GET /providers' `engines`) in the order the API returned
 * them. DeepSeek Harness has no sign-in: its credentials are the user's DeepSeek keys, every one of
 * them.
 *
 * Each carries the health the runner last reported, because a choice is a claim about someone else's
 * machine. The engine's CLI not installed there, or its sign-in signed out → listed with the reason,
 * pointing at Infrastructure, where that machine gets its install or its sign-in (see `unavailable`).
 * Hiding the row instead would leave a user who pays for Kimi with no way to find out why it isn't
 * offered. A key or a pool brings its own credential, so only the CLI has to be there; a pool also
 * needs one of its accounts able to run, which the server says (`PoolChoiceSource.unavailable`).
 */
export function engineProviders(engine: AgentProvider, sources: ChoiceSources): ProviderChoice[] {
  const { configured, modelCatalog, runtimeDefaultModels, engineHealth, antigravity, dshRunner } = sources;
  const pools = sources.pools ?? [];
  const antigravityKeyAvailable = sources.antigravityKeyAvailable ?? antigravity?.envKeyAvailable ?? false;
  const health = engineHealth?.find((e) => e.engine === engine);
  const modelLabel = (provider: string) =>
    defaultModelLabel(engine, provider, modelCatalog, configured, runtimeDefaultModels);
  // What a credential that brings its own key needs from this runner: the engine's CLI, and for
  // Harness and agy what the server admits them on.
  const carried =
    engine === AgentProvider.DSH
      ? dshBlocker(dshRunner)
      : engine === AgentProvider.ANTIGRAVITY
        ? antigravityBlocker(antigravity, health)
        : engine === AgentProvider.OPENCODE
          ? openCodeMissing(engineHealth)
            ? 'Not installed'
            : undefined
          : byokBlocker(health);

  const own: ProviderChoice[] = [];
  if (isLoginProvider(engine) && (engine !== AgentProvider.ANTIGRAVITY || antigravityKeyAvailable || antigravity?.authSource === 'google')) {
    const usesGoogleAccount =
      antigravity?.authSource === 'google' && !(antigravityKeyAvailable && !antigravity.envKeyAvailable);
    const blocker =
      engine === AgentProvider.ANTIGRAVITY
        ? antigravityBlocker(antigravity, health, !antigravityKeyAvailable || usesGoogleAccount)
        : engineBlocker(health);
    const accounts = blocker ? undefined : accountChoices(engine, health, withEnginePlanUsage(sources.planUsage, engineHealth));
    own.push({
      slug: engine,
      label: signInLabel(health),
      kind: 'login',
      ...(engine === AgentProvider.ANTIGRAVITY ? { labelDetail: usesGoogleAccount ? 'Google account' : 'env key' } : {}),
      ...brandForProvider(engine, ENGINE_CLI_NAMES[engine]),
      modelLabel: modelLabel(engine),
      ...(blocker ? { unavailable: blocker, fixEngine: engine } : {}),
      ...(accounts ? { accounts } : {}),
    });
  }
  if (engine === AgentProvider.OPENCODE) own.push(openCodeOwnChoice(sources));

  // Somebody a pool's owner added runs on the pool's ChatGPT accounts first and on its keys when none
  // can (pool-credential-select.ts, 2026-10-03), so what the pool holds is what they can run on, and
  // the pool's own answer (`unavailable`, built the same way for them as for its owner) is the reason.
  const poolChoices: ProviderChoice[] = pools
    .filter((pool) => poolEngine(pool) === engine)
    .map((pool) => ({
      slug: pool.slug,
      label: pool.label,
      kind: 'pool' as const,
      ...brandForProvider(pool.slug, pool.label, ENGINE_PRESET[engine]),
      modelLabel: modelLabel(pool.slug),
      poolSize: pool.members.length,
      // 'N keys' only where the pool really is nothing but keys; a pool holding ChatGPT accounts counts
      // accounts (the viewer's own words — AccountPools' memberNoun).
      ...(pool.shared && !pool.members.some((member) => member.login) ? { poolUnit: 'key' as const } : {}),
      ...(carried
        ? { unavailable: carried, fixEngine: engine }
        : pool.unavailable
          ? { unavailable: pool.unavailable, fixHref: `/providers/pools/${encodeId(pool.id)}` }
          : {}),
    }));

  const poolSlugs = new Set(pools.map((pool) => pool.slug));
  const pooled = new Set(pools.flatMap((pool) => pool.members.map((member) => member.slug)));
  // A configured row that shadows a built-in slug would give the menu two rows that dispatch the
  // same identity; the engine's own sign-in above already covers it.
  const keys: ProviderChoice[] = configured
    .filter(
      (p) =>
        !poolSlugs.has(p.slug) &&
        !isLoginProvider(p.slug) &&
        p.slug !== AgentProvider.OPENCODE &&
        providerEngines(p.slug, configured).includes(engine),
    )
    .map((p) => ({
      slug: p.slug,
      label: p.label,
      kind: 'key' as const,
      ...brandForProvider(p.slug, p.label, p.presetSlug),
      modelLabel: modelLabel(p.slug),
      ...(carried ? { unavailable: carried, fixEngine: engine } : {}),
      ...(pooled.has(p.slug) ? { inPool: true } : {}),
    }));

  return [...own, ...poolChoices, ...keys];
}

/** OpenCode's own configuration on the runner — whatever `opencode auth login` set up there. */
function openCodeOwnChoice(sources: ChoiceSources): ProviderChoice {
  return {
    slug: AgentProvider.OPENCODE,
    label: "OpenCode's own sign-in",
    kind: 'opencode',
    labelDetail: 'opencode auth',
    ...brandForProvider(AgentProvider.OPENCODE, ENGINE_CLI_NAMES[AgentProvider.OPENCODE]),
    modelLabel: defaultModelLabel(
      AgentProvider.OPENCODE,
      AgentProvider.OPENCODE,
      sources.modelCatalog,
      sources.configured,
      sources.runtimeDefaultModels,
    ),
    ...(openCodeMissing(sources.engineHealth) ? { unavailable: 'Not installed', fixEngine: AgentProvider.OPENCODE } : {}),
  };
}

/** A vendor's name, as its keys are called in a sentence (board 8): one key runs on several engines,
 *  so it is never named after one. */
const KEY_VENDORS: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  [DSH_PRESET_SLUG]: 'DeepSeek',
  moonshot: 'Moonshot',
  glm: 'Z.AI',
  minimax: 'MiniMax',
  qwen: 'Qwen',
};

/** A key as a sentence names it, lowercase for the middle of one: `the DeepSeek key “DeepSeek 2”` —
 *  its vendor and the name its owner gave it, never its slug. A custom endpoint is DeepSeek's when
 *  DeepSeek Harness runs it (`engines`, which only the server can tell). */
export function keyName(row: Pick<ConfiguredProvider, 'label' | 'presetSlug' | 'engines'>): string {
  const vendor = row.presetSlug
    ? KEY_VENDORS[row.presetSlug]
    : row.engines?.includes(AgentProvider.DSH)
      ? KEY_VENDORS.deepseek
      : undefined;
  return vendor ? `the ${vendor} key “${row.label}”` : `the key “${row.label}”`;
}

/** What a session runs on, engine and credential in one phrase, as a workspace's settings say it
 *  (board 7): `Claude Code` on the engine's own sign-in — or OpenCode's own configuration, the legacy
 *  built-in `dsh` — and `Claude Code via DeepSeek` on a key or a pool, by its own name. */
export function engineVia(
  engine: AgentProvider,
  provider: string,
  configured?: readonly ConfiguredProvider[] | null,
): string {
  const name = ENGINE_CLI_NAMES[engine];
  if (provider === engine) return name;
  return `${name} via ${configured?.find((p) => p.slug === provider)?.label ?? provider}`;
}

/** What names a credential where its engine is not beside it: an engine's own sign-in by the
 *  engine's CLI, anything else by its own label. */
export const providerNameOn = (engine: AgentProvider, choice: Pick<ProviderChoice, 'kind' | 'label'>): string =>
  choice.kind === 'login' ? ENGINE_CLI_NAMES[engine] : choice.label;

/**
 * The choice to show as a session's (or a draft's) current provider when the menu does not list it:
 * a key this account no longer has on offer — removed, turned off — or one that has not loaded yet,
 * the legacy built-in `dsh` (DeepSeek Harness on a key in its workspace's environment), or
 * Antigravity's sign-in on a runner that offers it neither a Google account nor a Gemini key. Each
 * still renders something truthful rather than silently reading as another credential, and never
 * changes the engine.
 */
export function currentProviderChoice(
  engine: AgentProvider,
  provider: string,
  providers: readonly ProviderChoice[],
  sources: ChoiceSources,
): ProviderChoice {
  const found = providers.find((choice) => choice.slug === provider);
  if (found) return found;
  const { configured, modelCatalog, runtimeDefaultModels, antigravity } = sources;
  const modelLabel = defaultModelLabel(engine, provider, modelCatalog, configured, runtimeDefaultModels);
  if (provider === AgentProvider.OPENCODE) return openCodeOwnChoice(sources);
  if (isLoginProvider(provider)) {
    const google = antigravity?.authSource === 'google';
    const blocker =
      provider === AgentProvider.ANTIGRAVITY ? antigravityBlocker(antigravity, undefined, !antigravity?.envKeyAvailable) : undefined;
    return {
      slug: provider,
      label: 'Default',
      kind: 'login',
      ...(provider === AgentProvider.ANTIGRAVITY ? { labelDetail: google ? 'Google account' : 'env key' } : {}),
      ...brandForProvider(provider, ENGINE_CLI_NAMES[provider as AgentProvider]),
      modelLabel,
      ...(blocker ? { unavailable: blocker, fixEngine: provider } : {}),
    };
  }
  if (provider === AgentProvider.DSH && !configured.some((p) => p.slug === provider)) {
    return {
      slug: provider,
      label: 'Workspace key',
      kind: 'key',
      labelDetail: 'ORBIT_DSH_API_KEY',
      ...brandForProvider(provider, ENGINE_CLI_NAMES[AgentProvider.DSH]),
      modelLabel,
    };
  }
  const row = configured.find((p) => p.slug === provider);
  return {
    slug: provider,
    label: row?.label ?? provider,
    kind: 'key',
    ...brandForProvider(provider, row?.label ?? provider, row?.presetSlug),
    modelLabel,
  };
}

/** An engine — the CLI a session runs on, fixed for its life — as the New Session hero lists it, with
 *  the credentials it can run on here. Which of them a session spends is the composer's Provider
 *  menu's question; a row here names the engine and the credential a pick of it lands on. */
export interface EngineChoice {
  slug: AgentProvider;
  /** The CLI's own product name (ENGINE_CLI_NAMES). */
  label: string;
  brand: ProviderBrand;
  glyphKey?: string;
  /** Every credential on this runner the engine can run on (engineProviders). */
  providers: ProviderChoice[];
  /** Where picking the engine lands (engineChoices) — or nothing, for DeepSeek Harness before a
   *  DeepSeek key is connected. */
  provider: ProviderChoice | null;
  /** Why the engine can't take a session here, and where that is fixed: the landing's own reason when
   *  none of its credentials can run, or the DeepSeek key there is none of. */
  unavailable?: string;
  fixEngine?: string;
  fixHref?: string;
}

/** The engine's name and mark, over no credential yet. */
const engineHead = (engine: AgentProvider) => ({
  slug: engine,
  label: ENGINE_CLI_NAMES[engine],
  ...brandForProvider(engine, ENGINE_CLI_NAMES[engine]),
});

/** `engine` landing on `provider`, carrying its reason when it cannot run. */
function engineLanding(engine: AgentProvider, providers: ProviderChoice[], provider: ProviderChoice): EngineChoice {
  return {
    ...engineHead(engine),
    providers,
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

/** Where a pick of `engine` lands: the first of `preferred` it holds that can run (the draft's pick,
 *  then what the workspace last ran there), else its own sign-in (OpenCode's own configuration), else
 *  the first of its credentials that can run — one in a pool last, since the pool beside it is the
 *  usual answer. DeepSeek Harness, with no sign-in, lands on the first DeepSeek key. An engine none of
 *  whose credentials can run lands on its own sign-in (or its first) and carries that reason. */
function landingOf(engine: AgentProvider, providers: ProviderChoice[], preferred: readonly EnginePick[]): ProviderChoice {
  const ready = providers.filter((choice) => !choice.unavailable);
  const own = (choice: ProviderChoice) => choice.kind === 'login' || choice.kind === 'opencode';
  return (
    preferred
      .filter((pick) => pick.engine === engine)
      .map((pick) => ready.find((choice) => choice.slug === pick.provider))
      .find((choice): choice is ProviderChoice => !!choice) ??
    ready.find(own) ??
    ready.find((choice) => !choice.inPool) ??
    ready[0] ??
    providers.find(own) ??
    providers[0]
  );
}

/**
 * The New Session hero's engines, in ALL_ENGINES order (Claude Code, Codex, Kimi Code, Antigravity CLI,
 * OpenCode, DeepSeek Harness), each with its credentials and the one a pick of it lands on. An engine
 * with nothing to run on here is left out — except DeepSeek Harness on a runner that could run it:
 * with no DeepSeek key yet it offers the connection instead (a turned-off key does not count, since
 * GET /providers lists none), so "where is DeepSeek Harness?" has an answer in the picker itself.
 */
export function engineChoices(sources: ChoiceSources, preferred: readonly EnginePick[] = []): EngineChoice[] {
  return ALL_ENGINES.flatMap((engine): EngineChoice[] => {
    const providers = engineProviders(engine, sources);
    if (providers.length > 0) return [engineLanding(engine, providers, landingOf(engine, providers, preferred))];
    if (engine === AgentProvider.DSH && sources.dshRunner && dshRunnerState(sources.dshRunner) !== 'updateRunner') {
      return [{ ...engineHead(engine), providers: [], provider: null, unavailable: 'Connect a DeepSeek key', fixHref: DSH_CONNECT_HREF }];
    }
    return [];
  });
}

/** The hero's current engine: `engine` landing on `provider` — the draft's pick, or what the workspace
 *  last ran on — even where that provider is not one of the credentials listed for it (a key since
 *  removed), which is then drawn as it is rather than silently replaced. */
export function currentEngineChoice(
  engine: AgentProvider,
  provider: string,
  engines: readonly EngineChoice[],
  sources: ChoiceSources,
): EngineChoice {
  const providers = engines.find((choice) => choice.slug === engine)?.providers ?? [];
  return engineLanding(engine, providers, currentProviderChoice(engine, provider, providers, sources));
}

/** The engine a session runs on, as the composer's model menu titles itself: the CLI's own product
 *  name (`Claude Code`, not `Claude`, because a session on a DeepSeek key writes DeepSeek's models
 *  while Claude Code executes them) over that engine's brand mark. Read off the session's own engine,
 *  which no pick in the menu changes — a session's engine is fixed for its life (contract §3.5). */
export function engineTitleFor(engine: AgentProvider): {
  slug: AgentProvider;
  name: string;
  brand: ProviderBrand;
  glyphKey?: string;
} {
  const { slug, label, ...brand } = engineHead(engine);
  return { slug, name: label, ...brand };
}
