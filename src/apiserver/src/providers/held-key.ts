import { AgentProvider, keyDialect, openCodeKeyOf, type KeyDialect } from '@orbit/shared';
import { Prisma, type ModelProvider } from '@prisma/client';
import { isBuiltinProvider, runsOnOpenCode, usableProviderScope } from './custom-provider';
import { presetDefaultModel } from './preset-overlay';
import { decryptSecret } from './provider-crypto';

/**
 * A key the server itself holds and may spend on a call it makes for one of its people: the endpoint
 * its row stores for its CLI, the dialect that endpoint speaks, the key, and the API model to ask for.
 */
export interface HeldKey {
  dialect: KeyDialect;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Whether `host` (a URL's hostname) is one the server must never be aimed at on somebody's say-so:
 * loopback, link-local or a private range. A basic SSRF guard; DNS is not re-resolved.
 */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '0.0.0.0' ||
    h === '::1' ||
    // WHATWG URL keeps the brackets on an IPv6 hostname.
    h === '[::1]' ||
    /^127\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * The Gemini API model agy calls for one of its own model names, which is what the connection test
 * has to ask for to probe the model a session runs. agy names a model by family and thinking level
 * (`gemini-3.8-flash-high`, or the base name and `--effort`) and maps it onto an API id itself;
 * measured on agy 1.2.16 that id is the base name for every model it lists except 3.1 Pro, which the
 * API still serves only as a preview (docs/antigravity-runtime-contract.md §9.2). A name agy does
 * not list is asked for as it is.
 */
export function geminiApiModel(model: string): string {
  const base = model.replace(/-(low|medium|high|xhigh|max)$/, '');
  return base === 'gemini-3.1-pro' ? 'gemini-3.1-pro-preview' : base;
}

/** The fields of a configured row heldKeyOf reads (a subset of the Prisma row). */
export type HeldKeyRow = Pick<
  ModelProvider,
  'runtime' | 'baseUrl' | 'apiKeyEnc' | 'enabled' | 'presetSlug' | 'followsPreset' | 'models' | 'defaultModel'
>;

/**
 * The key a configured row lends a call the server makes for a session, with the model to ask for —
 * `model` when given, else the row's default — or null when the server may not spend it: a disabled
 * row, a Claude subscription token, which Anthropic serves to its own clients only (the rule an
 * OpenCode run is held to, runsOnOpenCode), an endpoint on an internal host, nothing to ask for, and —
 * for the session's own provider (`ownProvider`) — a DeepSeek Harness row, whose model values are its
 * catalogue's opaque tokens rather than API ids.
 */
export function heldKeyOf(row: HeldKeyRow, model: string | undefined, ownProvider: boolean): HeldKey | null {
  if (!runsOnOpenCode(row)) return null;
  if (ownProvider && row.runtime === AgentProvider.DSH) return null;
  try {
    if (isInternalHost(new URL(row.baseUrl).hostname)) return null;
  } catch {
    return null;
  }
  const asked = model || presetDefaultModel(row)?.trim() || undefined;
  if (!asked) return null;
  const dialect = keyDialect(row.runtime)!;
  return {
    dialect,
    baseUrl: row.baseUrl,
    apiKey: decryptSecret(row.apiKeyEnc).trim(),
    model: dialect === 'gemini' ? geminiApiModel(asked) : asked,
  };
}

/**
 * The key the server holds for a session's provider and may spend on the session's behalf — naming
 * it, when no DeepSeek key is configured — with the model the session runs: the configured row its
 * provider names, or for an OpenCode session the row its model names (`orbit-<slug>/<model>`), as
 * heldKeyOf lends it. Null as well for every credential the server does not hold: a built-in engine's
 * own sign-in, which lives on the runner, and an account pool, whose member is the claim's to choose.
 */
export async function sessionHeldKey(
  db: Pick<Prisma.TransactionClient, 'user' | 'modelProvider'>,
  session: { provider: string; providerBuiltin?: boolean; ownerId: string; model?: string | null },
): Promise<HeldKey | null> {
  let slug = session.provider;
  let model = session.model?.trim() || undefined;
  const ownProvider = !isBuiltinProvider(session.provider, session.providerBuiltin);
  if (!ownProvider) {
    const key = session.provider === AgentProvider.OPENCODE ? openCodeKeyOf(session.model) : null;
    if (!key) return null;
    ({ slug, model } = key);
  }
  const row = await db.modelProvider.findFirst({
    where: { slug, enabled: true, ...(await usableProviderScope(db, session.ownerId)) },
  });
  return row ? heldKeyOf(row, model, ownProvider) : null;
}
