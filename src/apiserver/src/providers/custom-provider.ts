import { AgentProvider, DEFAULT_MODEL_BY_PROVIDER, modelForProvider } from '@orbit/shared';
import { decryptSecret } from './provider-crypto';
import { presetDefaultModel } from './preset-overlay';
import { firstRuntimeCatalogModel, savedRuntimeDefaultModel } from '../common/runtime-model';

// Built-in, first-class providers ship their own runtime CLI. Any other `provider` value is
// a control-plane-configured ModelProvider that borrows one of these runtimes.
/** True for a built-in provider (or an unset one) — i.e. NOT a configured ModelProvider slug.
 * `providerBuiltin` is persisted only to fence the former custom `kimi` slug during rolling
 * deployment; Claude/Codex predate the discriminator, and migration 0080 moves any pre-existing
 * custom `opencode` row aside, so both remain unambiguous. */
export function isBuiltinProvider(slug?: string | null, providerBuiltin = true): boolean {
  if (!slug || slug === AgentProvider.CLAUDE || slug === AgentProvider.CODEX) return true;
  if (slug === AgentProvider.OPENCODE) return true;
  if (slug === AgentProvider.KIMI) return providerBuiltin;
  return false;
}

/** The minimal ModelProvider row shape the exec resolver needs (a subset of the Prisma row). */
export interface ModelProviderRow {
  runtime: string;
  baseUrl: string;
  apiKeyEnc: string;
  defaultModel: string | null;
  /** The vendor preset this row came from, and whether it still owns the model list — when it
   *  does, the default model resolves from the catalogue rather than from the row. */
  presetSlug?: string | null;
  followsPreset?: boolean;
  enabled: boolean;
}

function runtimeOf(row: ModelProviderRow): AgentProvider {
  if (row.runtime === AgentProvider.CODEX) return AgentProvider.CODEX;
  if (row.runtime === AgentProvider.KIMI) return AgentProvider.KIMI;
  return AgentProvider.CLAUDE;
}

// Env injected so the borrowed runtime CLI talks to the provider's endpoint. Claude runtime →
// Anthropic-compatible vars (Phase 1); codex runtime → OpenAI-compatible (Phase 2); kimi runtime →
// the Kimi CLI's own KIMI_MODEL_* provider.
function injectedEnv(row: ModelProviderRow, model: string): Record<string, string> {
  const apiKey = decryptSecret(row.apiKeyEnc);
  if (runtimeOf(row) === AgentProvider.CODEX) {
    return { OPENAI_BASE_URL: row.baseUrl, OPENAI_API_KEY: apiKey };
  }
  if (runtimeOf(row) === AgentProvider.KIMI) {
    // Kimi has no base-url/key flags: setting KIMI_MODEL_NAME is what makes the CLI synthesize an
    // in-memory provider from these, and it refuses to start with any of the pair missing. The
    // model travels in the environment rather than through ACP's `model` config option, which
    // would switch the session back to the runner's own Kimi sign-in and ignore this key —
    // hence the runner's kimiUsesEnvModel() check. The type pins the protocol the base URL
    // speaks, so a row pointed at a CN/self-hosted Moonshot endpoint stays consistent.
    return {
      KIMI_MODEL_NAME: model,
      KIMI_MODEL_API_KEY: apiKey,
      KIMI_MODEL_PROVIDER_TYPE: 'kimi',
      KIMI_MODEL_BASE_URL: row.baseUrl,
    };
  }
  return {
    ANTHROPIC_BASE_URL: row.baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    // Claude Code disables claude.ai connectors on its own once an auth token is set — the
    // token above — and then warns on stderr, every start, that unsetting it would bring them
    // back. Unsetting it is exactly what must not happen here (it IS the provider's key), so
    // turn the feature off explicitly: same outcome, no advice that would break the session.
    ENABLE_CLAUDEAI_MCP_SERVERS: '0',
  };
}

/**
 * Resolve how to actually run a (possibly custom) provider at dispatch: the runner-facing
 * built-in runtime, the model to pass, and the process env. For a configured provider
 * the runner never learns its slug — it just receives a Claude/Codex/Kimi job whose env points at
 * the provider's endpoint, so the runner needs no changes. A built-in may also resolve
 * directly to Kimi or OpenCode.
 *
 * `customRow` is null for a built-in provider, or for a slug whose ModelProvider was
 * deleted/disabled (a safe fallback to the claude default rather than a dispatch failure).
 */
export function resolveProviderExec(args: {
  declaredProvider?: string | null;
  /** False only for a stale/pre-0077 custom-provider identity that happens to say `kimi`. */
  declaredProviderBuiltin?: boolean;
  customRow: ModelProviderRow | null;
  sessionModel?: string | null;
  /** True for Sessions created under Runtime-default semantics. False marks a model-less row
   * written by an old API replica during the 0079 rolling deployment. Defaults to true for
   * non-persisted/direct callers. */
  usesRuntimeDefaultModel?: boolean;
  /** Effective default reported by built-in runtimes on the assigned runner. Ignored for a custom
   * provider, whose ModelProvider row remains authoritative. */
  runtimeDefaultModels?: unknown;
  /**
   * Legacy per-Agent pin. New clients never write this field, but a model-less Session created
   * or claimed by an old API replica must keep the pre-0079 model through a rolling deployment.
   * The claim path immediately snapshots this fallback onto Session.model.
   */
  agentModel?: string | null;
  /** Runtime-reported catalog on the assigned runner; its first model is the final dynamic
   * fallback before the shared static default. Ignored for configured providers. */
  modelCatalog?: unknown;
  agentEnv?: Record<string, string> | null;
}): { provider: AgentProvider; model: string; env?: Record<string, string> } {
  const { customRow, sessionModel, agentModel, agentEnv } = args;
  const legacyInheritance = args.usesRuntimeDefaultModel === false;
  if (customRow && customRow.enabled) {
    const runtime = runtimeOf(customRow);
    // A custom provider's model space is its own; never coerce it through the claude/gpt
    // prefix guard. Agent.model is only a rolling-deploy bridge for model-less sessions made
    // by old replicas; current clients put their choice directly on Session.model.
    const model =
      firstNonBlank(sessionModel, legacyInheritance ? agentModel : undefined) ||
      presetDefaultModel(customRow) ||
      DEFAULT_MODEL_BY_PROVIDER[runtime];
    return {
      provider: runtime,
      model,
      // Provider env wins over any user-set agent env (e.g. a hand-typed ANTHROPIC_BASE_URL).
      // The kimi runtime also reads the model from here, so it can only be built once the
      // model above is resolved.
      env: { ...(agentEnv ?? {}), ...injectedEnv(customRow, model) },
    };
  }
  // Built-in (or stale/disabled custom slug → treat as claude). The runtime authenticates itself:
  // each runner carries its own `claude auth login`, and a session that finds it missing surfaces
  // the sign-in card (RunnerSignIn) rather than the control plane holding a credential for it.
  const provider =
    args.declaredProvider === AgentProvider.CODEX
      ? AgentProvider.CODEX
      : args.declaredProvider === AgentProvider.OPENCODE
        ? AgentProvider.OPENCODE
        : args.declaredProvider === AgentProvider.KIMI && args.declaredProviderBuiltin !== false
          ? AgentProvider.KIMI
          : AgentProvider.CLAUDE;
  const env = agentEnv ?? undefined;
  const explicitSessionModel = firstNonBlank(sessionModel);
  // An explicit per-session selection retains the historical safety behavior: a clearly
  // cross-provider id is coerced straight to the static provider default. During a rolling
  // deployment, old replicas can still create a model-less Session that expects Agent.model;
  // preserve that one-time inheritance ahead of new Runtime defaults. Queue claim snapshots it
  // onto Session.model, and current Agent create/update paths never write a new pin.
  const legacyAgentModel = legacyInheritance ? firstNonBlank(agentModel) : undefined;
  const inheritedModel = legacyInheritance
    ? modelForProvider(provider, legacyAgentModel)
    : firstCompatibleModel(
        provider,
        savedRuntimeDefaultModel(args.runtimeDefaultModels, provider),
        firstRuntimeCatalogModel(args.modelCatalog, provider),
      );
  return {
    provider,
    model: modelForProvider(provider, explicitSessionModel ?? inheritedModel),
    env,
  };
}

function firstNonBlank(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstCompatibleModel(
  provider: AgentProvider,
  ...values: Array<string | null | undefined>
): string | undefined {
  for (const value of values) {
    const model = firstNonBlank(value);
    if (model && modelForProvider(provider, model) === model) return model;
  }
  return undefined;
}
