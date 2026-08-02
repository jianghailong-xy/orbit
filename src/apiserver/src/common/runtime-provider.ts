import { AgentProvider, PermissionMode } from '@orbit/shared';

// Keep this conservative Claude allow-list aligned with the clients. Claude Code rejects Auto
// for unsupported models (notably Haiku). Kimi's Auto is a runtime-wide mode and therefore does
// not depend on the configured default-model alias; Codex does not expose Auto at all.
const AUTO_CAPABLE_CLAUDE_MODELS = new Set([
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-5',
]);

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
  if (value === AgentProvider.KIMI && providerBuiltin) return AgentProvider.KIMI;
  return AgentProvider.CLAUDE;
}

/** Runtimes that learn their durable conversation id only after process initialization. */
export function initializesRuntimeDynamically(provider?: string | null): boolean {
  return provider === AgentProvider.CODEX || provider === AgentProvider.KIMI;
}

/** Prevent a runner from receiving a model/permission combination its built-in CLI rejects. */
export function normalizeBuiltinPermissionMode(
  provider: AgentProvider,
  model: string,
  permissionMode: PermissionMode,
): PermissionMode {
  if (permissionMode !== PermissionMode.AUTO || provider === AgentProvider.KIMI) {
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
 * only low/high/max through ACP.
 */
export function normalizeEffortForProvider(
  provider: AgentProvider,
  effort?: string | null,
): string | undefined {
  if (effort == null) return undefined;
  if (provider === AgentProvider.CODEX && effort === 'max') return 'xhigh';
  if (provider === AgentProvider.KIMI) {
    if (effort === 'minimal') return 'low';
    if (effort === 'medium') return 'high';
    if (effort === 'xhigh') return 'max';
  }
  return effort;
}
