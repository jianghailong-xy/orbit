import { AgentProvider, PermissionMode } from '@orbit/shared';
import { runtimeCatalogReasoningLevels } from './runtime-model';

// Keep this conservative Claude allow-list aligned with the clients. Claude Code rejects Auto
// for unsupported models (notably Haiku). Kimi's and OpenCode's Auto are runtime-wide modes and
// therefore do not depend on the configured default-model alias; Codex does not expose Auto at all.
const AUTO_CAPABLE_CLAUDE_MODELS = new Set([
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-5',
]);

// Closed CLI enums. An account default last picked in an OpenCode session (whose variants are
// model-defined and open-ended) must degrade to runtime Default rather than make these fail.
const CLAUDE_EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORTS = new Set(['', 'minimal', 'low', 'medium', 'high', 'xhigh']);

/**
 * Turn a persisted provider identity into a built-in runner runtime.
 *
 * Configured-provider slugs are resolved before dispatch; callers using this helper are handling
 * built-in session state, so an unknown/stale identity keeps the historical Claude fallback.
 */
export function normalizeRuntimeProvider(
  value?: string | null,
  providerBuiltin = true,
): AgentProvider {
  if (value === AgentProvider.CODEX) return AgentProvider.CODEX;
  if (value === AgentProvider.OPENCODE) return AgentProvider.OPENCODE;
  if (value === AgentProvider.KIMI && providerBuiltin) return AgentProvider.KIMI;
  return AgentProvider.CLAUDE;
}

/** Runtimes that learn their durable conversation id only after process initialization. */
export function initializesRuntimeDynamically(provider?: string | null): boolean {
  return (
    provider === AgentProvider.CODEX ||
    provider === AgentProvider.KIMI ||
    provider === AgentProvider.OPENCODE
  );
}

/** Prevent a runner from receiving a model/permission combination its built-in CLI rejects. */
export function normalizeBuiltinPermissionMode(
  provider: AgentProvider,
  model: string,
  permissionMode: PermissionMode,
): PermissionMode {
  if (
    permissionMode !== PermissionMode.AUTO ||
    provider === AgentProvider.KIMI ||
    provider === AgentProvider.OPENCODE
  ) {
    return permissionMode;
  }
  if (provider === AgentProvider.CODEX || !AUTO_CAPABLE_CLAUDE_MODELS.has(model)) {
    return PermissionMode.DEFAULT;
  }
  return permissionMode;
}

/**
 * Keep persisted effort values valid when a session changes runtime or is resumed from an older
 * client. Codex historically called its top level `xhigh`; managed Kimi currently advertises
 * only low/high/max through ACP. OpenCode variants are model/provider-defined and stay
 * open-ended, so only the closed CLI enums are clamped.
 */
export function normalizeEffortForProvider(
  provider: AgentProvider,
  effort?: string | null,
): string | undefined {
  if (effort == null) return undefined;
  if (provider === AgentProvider.OPENCODE) return effort;
  if (provider === AgentProvider.KIMI) {
    if (effort === 'minimal') return 'low';
    if (effort === 'medium') return 'high';
    if (effort === 'xhigh') return 'max';
    return effort;
  }
  if (provider === AgentProvider.CODEX) {
    const normalized = effort === 'max' ? 'xhigh' : effort;
    return CODEX_EFFORTS.has(normalized) ? normalized : '';
  }
  return CLAUDE_EFFORTS.has(effort) ? effort : '';
}

/**
 * The dispatch-time variant check, applied once the assigned runner's model catalog is known.
 *
 * OpenCode variants are model-defined, so `normalizeEffortForProvider` alone cannot police them:
 * an account-level default picked in a Claude session (`max`) would otherwise reach the CLI as
 * `--variant=max` and fail the turn. Mirrors the web picker's rule — an exact catalog row is
 * authoritative even when it lists no variants, while a model the runner-wide catalog does not
 * report may be project-scoped and keeps its value.
 */
export function normalizeEffortForRuntimeModel(
  provider: AgentProvider,
  effort: string | null | undefined,
  model: string,
  modelCatalog: unknown,
): string | undefined {
  const normalized = normalizeEffortForProvider(provider, effort);
  if (provider !== AgentProvider.OPENCODE || !normalized) return normalized;
  const levels = runtimeCatalogReasoningLevels(modelCatalog, provider, model);
  if (levels === undefined) return normalized;
  return levels.includes(normalized) ? normalized : '';
}
