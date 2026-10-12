/**
 * Which engines a credential runs on: the compatibility table of the provider/engine split
 * (docs/provider-engine-contract.md §2.1).
 *
 * A session has two axes. Its engine is the CLI on the runner that produced its runtimeSessionId,
 * fixed for the session's life. Its provider is only where the credential comes from: the engine's
 * own sign-in on the runner (the slug is the engine's name), an account pool, a configured key, or
 * OpenCode's own config. This table says which engines a credential may be paired with, and which
 * one a caller that names only the credential gets — the engine it ran on before the split, so no
 * old caller changes engine.
 *
 * A key's answer never needs the key itself: whether it holds a Claude subscription token is the
 * caller's to say, since only a server holding the decrypted key can; clients read each key's
 * engines off /providers. Mirrored in Swift and Kotlin; keep the three in sync.
 */
import type { LoginEngine } from './dto';
import { AgentProvider } from './enums';
import { keyDialect, type KeyDialect } from './openCodeKeys';

/** Every engine a session can run on, in the order a picker lists them. */
export const ALL_ENGINES: readonly AgentProvider[] = [
  AgentProvider.CLAUDE,
  AgentProvider.CODEX,
  AgentProvider.KIMI,
  AgentProvider.ANTIGRAVITY,
  AgentProvider.OPENCODE,
  AgentProvider.DSH,
];

/** Each engine's CLI by its own product name, as the web already shows it (runnerEngines.ts). */
export const ENGINE_CLI_NAMES: Readonly<Record<AgentProvider, string>> = {
  [AgentProvider.CLAUDE]: 'Claude Code',
  [AgentProvider.CODEX]: 'Codex',
  [AgentProvider.KIMI]: 'Kimi Code',
  [AgentProvider.ANTIGRAVITY]: 'Antigravity CLI',
  [AgentProvider.OPENCODE]: 'OpenCode',
  [AgentProvider.DSH]: 'DeepSeek Harness',
};

export function isEngine(value: unknown): value is AgentProvider {
  return typeof value === 'string' && (ALL_ENGINES as readonly string[]).includes(value);
}

/** Where a session's credential comes from — the four kinds a provider slug can name. */
export type EngineCredential =
  /** The engine's own sign-in on the runner; the provider slug is the engine's name. */
  | { kind: 'login'; engine: LoginEngine }
  /** An account pool (ProviderPool), which runs on the engine it was made on. */
  | { kind: 'pool'; engine: AgentProvider }
  /** A configured key (ModelProvider). `runtime` is the row's column, which names the protocol its
   *  endpoint speaks; `subscriptionToken` is whether the decrypted key is a Claude subscription
   *  token (`sk-ant-oat…`), which Anthropic serves to Claude Code alone. */
  | { kind: 'key'; runtime: string | null; presetSlug: string | null; baseUrl: string; subscriptionToken: boolean }
  /** OpenCode's own provider configuration on the runner. */
  | { kind: 'opencode' };

/** The engine whose own protocol each dialect is: what a key runs on when nothing else is named. */
const NATIVE_ENGINE: Readonly<Record<KeyDialect, AgentProvider>> = {
  anthropic: AgentProvider.CLAUDE,
  openai: AgentProvider.CODEX,
  'openai-compatible': AgentProvider.KIMI,
  gemini: AgentProvider.ANTIGRAVITY,
};

// The WHATWG URL parser every runtime this package runs on provides (Node, browsers); the package
// compiles against ES2022 alone, which does not declare it.
declare const URL: new (url: string) => { hostname: string };

const DEEPSEEK_HOST = 'api.deepseek.com';

/** The presets whose key is a DeepSeek platform key. `deepseek-harness` rows exist until the
 *  migration folds them into DeepSeek keys. */
const DEEPSEEK_PRESETS: ReadonlySet<string> = new Set(['deepseek', 'deepseek-harness']);

/**
 * Whether a row's key is a DeepSeek account's, the only keys DeepSeek Harness runs on. A preset row
 * is decided by its preset; a custom one (no preset) by its endpoint being DeepSeek's own host. The
 * same rule as the apiserver's isDeepSeekAccountRow (providers/deepseek-balance.ts).
 */
export function isDeepSeekKey(row: { presetSlug: string | null; baseUrl: string }): boolean {
  if (row.presetSlug) return DEEPSEEK_PRESETS.has(row.presetSlug);
  try {
    return new URL(row.baseUrl).hostname.toLowerCase() === DEEPSEEK_HOST;
  } catch {
    return false;
  }
}

/** The engines `credential` can run on, its default engine first and the rest in ALL_ENGINES order;
 *  empty when nothing can run it (a key on a protocol no engine speaks). */
export function credentialEngines(credential: EngineCredential): AgentProvider[] {
  switch (credential.kind) {
    case 'login':
    case 'pool':
      return isEngine(credential.engine) ? [credential.engine] : [];
    case 'opencode':
      return [AgentProvider.OPENCODE];
    case 'key':
      return keyEngines(credential);
  }
}

function keyEngines(key: Extract<EngineCredential, { kind: 'key' }>): AgentProvider[] {
  const dialect = keyDialect(key.runtime);
  if (!dialect) return [];
  if (key.subscriptionToken) return dialect === 'anthropic' ? [AgentProvider.CLAUDE] : [];
  // A row still on the retired `dsh` runtime ran on DeepSeek Harness, and keeps doing so by default.
  const legacyDsh = key.runtime === AgentProvider.DSH;
  const native = legacyDsh ? AgentProvider.DSH : NATIVE_ENGINE[dialect];
  const runs = new Set<AgentProvider>([NATIVE_ENGINE[dialect], AgentProvider.OPENCODE]);
  if (dialect === 'anthropic' && (legacyDsh || isDeepSeekKey(key))) runs.add(AgentProvider.DSH);
  return [native, ...ALL_ENGINES.filter((engine) => engine !== native && runs.has(engine))];
}

/** The engine a caller that names only the credential gets, or null when nothing can run it. */
export function defaultEngineOf(credential: EngineCredential): AgentProvider | null {
  return credentialEngines(credential)[0] ?? null;
}

export function isEngineCompatible(engine: string, credential: EngineCredential): boolean {
  return (credentialEngines(credential) as string[]).includes(engine);
}
