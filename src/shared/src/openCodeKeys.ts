/**
 * Which configured keys an engine can run on, and how a session on OpenCode names the key it spends.
 *
 * A configured key speaks exactly one dialect: the protocol of the endpoint Orbit already drives it
 * through, which its row's `runtime` says — an Anthropic-compatible endpoint borrows Claude Code, an
 * OpenAI Responses one Codex, Moonshot's own API Kimi, Google's Gemini API Antigravity. An engine
 * runs every key whose dialect it speaks. The four CLIs above each speak one; OpenCode speaks all
 * four (one AI SDK provider per dialect), so every such key also runs there.
 *
 * A session's `provider` stays its engine — `opencode` — because the claim SQL, its trigger and the
 * runner capability gate all route on it. The key an OpenCode session spends is named inside its
 * model instead, `orbit-<key slug>/<model>`: OpenCode's own selector is `provider/model`, and the
 * dispatch that sees such a model writes exactly that one key into the run's OPENCODE_CONFIG_CONTENT
 * as a provider of that name. Mirrored in Swift (`OpenCodeKeys`); keep the two in sync.
 */

export type KeyDialect = 'anthropic' | 'openai' | 'openai-compatible' | 'gemini';

/** The dialect a configured key's endpoint speaks, from the runtime its row borrows. DeepSeek
 *  Harness rows hold DeepSeek's Anthropic-compatible endpoint; anything unknown speaks nothing. */
export function keyDialect(runtime?: string | null): KeyDialect | null {
  switch (runtime ?? 'claude') {
    case 'claude':
    case 'dsh':
      return 'anthropic';
    case 'codex':
      return 'openai';
    case 'kimi':
      return 'openai-compatible';
    case 'antigravity':
      return 'gemini';
    default:
      return null;
  }
}

/** The AI SDK package OpenCode drives each dialect with, all bundled in OpenCode itself. */
export const OPENCODE_DIALECT_NPM: Record<KeyDialect, string> = {
  anthropic: '@ai-sdk/anthropic',
  openai: '@ai-sdk/openai',
  'openai-compatible': '@ai-sdk/openai-compatible',
  gemini: '@ai-sdk/google',
};

/**
 * The base URL that SDK wants, from the one the row stores for its own CLI. Claude Code and agy append
 * the API version themselves (ANTHROPIC_BASE_URL, GOOGLE_GEMINI_BASE_URL); the SDKs expect it in the
 * URL. The OpenAI-style rows already carry `/v1`, as OPENAI_BASE_URL and Kimi's base URL do.
 */
export function openCodeBaseUrl(dialect: KeyDialect, baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (dialect === 'anthropic') return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  if (dialect === 'gemini') return /\/v1(beta)?$/.test(trimmed) ? trimmed : `${trimmed}/v1beta`;
  return trimmed;
}

const KEY_PREFIX = 'orbit-';

/** OpenCode's provider id for the configured key `slug`. */
export const openCodeKeyProvider = (slug: string): string => `${KEY_PREFIX}${slug}`;

/** The OpenCode model id of `model` on the configured key `slug`. */
export const openCodeKeyModel = (slug: string, model: string): string => `${openCodeKeyProvider(slug)}/${model}`;

/** The configured key an OpenCode model id names, and the model on it — null for any other id
 *  (OpenCode's own `provider/model`, the empty "managed by OpenCode" pick). */
export function openCodeKeyOf(model?: string | null): { slug: string; model: string } | null {
  if (!model?.startsWith(KEY_PREFIX)) return null;
  const slash = model.indexOf('/');
  if (slash <= KEY_PREFIX.length || slash === model.length - 1) return null;
  return { slug: model.slice(KEY_PREFIX.length, slash), model: model.slice(slash + 1) };
}
