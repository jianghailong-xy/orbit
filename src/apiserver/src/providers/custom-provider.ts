import { AgentProvider, DEFAULT_MODEL_BY_PROVIDER, modelForProvider } from '@orbit/shared';
import { decryptSecret } from './provider-crypto';

// Built-in, first-class providers ship their own runtime CLI. Any other `provider` value is
// a control-plane-configured ModelProvider that borrows one of these runtimes.
const BUILTIN = new Set<string>([AgentProvider.CLAUDE, AgentProvider.CODEX]);

/** True for a built-in provider (or an unset one) — i.e. NOT a configured ModelProvider slug. */
export function isBuiltinProvider(slug?: string | null): boolean {
  return !slug || BUILTIN.has(slug);
}

/** The minimal ModelProvider row shape the exec resolver needs (a subset of the Prisma row). */
export interface ModelProviderRow {
  runtime: string;
  baseUrl: string;
  apiKeyEnc: string;
  defaultModel: string | null;
  enabled: boolean;
}

function runtimeOf(row: ModelProviderRow): AgentProvider {
  return row.runtime === AgentProvider.CODEX ? AgentProvider.CODEX : AgentProvider.CLAUDE;
}

// Env injected so the borrowed runtime CLI talks to the provider's endpoint. Claude runtime →
// Anthropic-compatible vars (Phase 1); codex runtime → OpenAI-compatible (Phase 2).
function injectedEnv(row: ModelProviderRow): Record<string, string> {
  const apiKey = decryptSecret(row.apiKeyEnc);
  if (runtimeOf(row) === AgentProvider.CODEX) {
    return { OPENAI_BASE_URL: row.baseUrl, OPENAI_API_KEY: apiKey };
  }
  return { ANTHROPIC_BASE_URL: row.baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey };
}

/**
 * Resolve how to actually run a (possibly custom) provider at dispatch: the runner-facing
 * runtime (claude|codex), the model to pass, and the process env. For a configured provider
 * the runner never learns its slug — it just receives a claude/codex job whose env points at
 * the provider's endpoint, so the runner needs no changes.
 *
 * `customRow` is null for a built-in provider, or for a slug whose ModelProvider was
 * deleted/disabled (a safe fallback to the claude default rather than a dispatch failure).
 */
export function resolveProviderExec(args: {
  declaredProvider?: string | null;
  customRow: ModelProviderRow | null;
  sessionModel?: string | null;
  agentModel?: string | null;
  agentEnv?: Record<string, string> | null;
}): { provider: AgentProvider; model: string; env?: Record<string, string> } {
  const { customRow, sessionModel, agentModel, agentEnv } = args;
  if (customRow && customRow.enabled) {
    const runtime = runtimeOf(customRow);
    return {
      provider: runtime,
      // A custom provider's model space is its own; never coerce it through the claude/gpt
      // prefix guard. Prefer an explicit session/agent pick, else the provider's default.
      model:
        sessionModel || agentModel || customRow.defaultModel || DEFAULT_MODEL_BY_PROVIDER[runtime],
      // Provider env wins over any user-set agent env (e.g. a hand-typed ANTHROPIC_BASE_URL).
      env: { ...(agentEnv ?? {}), ...injectedEnv(customRow) },
    };
  }
  // Built-in (or stale/disabled custom slug → treat as claude): the pre-existing behavior.
  const provider =
    args.declaredProvider === AgentProvider.CODEX ? AgentProvider.CODEX : AgentProvider.CLAUDE;
  return {
    provider,
    model: modelForProvider(provider, sessionModel ?? agentModel),
    env: agentEnv ?? undefined,
  };
}
