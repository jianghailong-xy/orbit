import type { RunnerEngineAccount } from '@orbit/shared';
import { sanitizeRunnerEngines } from '../common/runner-engines';

/** The account every runner has: the CODEX_HOME its own environment selects. */
export const CODEX_DEFAULT_ACCOUNT = 'default';

/**
 * The Codex account a session dispatched to this runner runs on, when it is not Default.
 *
 * `account` is the slot id the session is to run on — today the workspace's choice
 * (Workspace.codexAccount); a per-session choice would be handed in here instead. It is resolved
 * against the accounts the assigned runner reported in its heartbeat (`Runner.engines`), which is
 * where each slot's CODEX_HOME comes from: the control plane stores the id, never a path.
 *
 * Null means Default, and the session is dispatched with no CODEX_HOME of its own, so the runner
 * resolves its own environment exactly as it did before accounts. That covers no choice, a choice
 * of Default, and an id this runner does not report — the workspace moved to another machine, the
 * slot was removed, or the runner is too old to list its accounts. Those run on Default rather
 * than fail: a session that never starts is worse than one on the machine's own account.
 */
export function codexAccountOnRunner(
  account: string | null | undefined,
  runnerEngines: unknown,
): RunnerEngineAccount | null {
  const id = account?.trim();
  if (!id || id === CODEX_DEFAULT_ACCOUNT) return null;
  const codex = sanitizeRunnerEngines(runnerEngines)?.find((engine) => engine.engine === 'codex');
  return codex?.accounts?.find((candidate) => candidate.id === id) ?? null;
}
