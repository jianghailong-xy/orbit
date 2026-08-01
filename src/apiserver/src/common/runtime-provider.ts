import { AgentProvider } from '@orbit/shared';

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
