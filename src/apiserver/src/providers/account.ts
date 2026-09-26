import type { LoginEngine, RunnerEngineAccount } from '@orbit/shared';
import { engineKeepsAccounts, sanitizeRunnerEngines } from '../common/runner-engines';

/** The account every engine's slots have: the directory its own environment selects — the one a
 *  CLI typed in a terminal shares. */
export const DEFAULT_ACCOUNT = 'default';

/**
 * The account of `engine` a session dispatched to this runner runs on, when it is not Default.
 *
 * `account` is the slot id the session is to run on — today the workspace's choice
 * (Workspace.codexAccount / Workspace.claudeAccount); a per-session choice would be handed in here
 * instead. It is resolved against the accounts the assigned runner reported in its heartbeat
 * (`Runner.engines`), which is where each slot's directory comes from: the control plane stores the
 * id, never a path.
 *
 * Null means Default, and the session is dispatched with no config directory of its own, so the
 * runner resolves its own environment exactly as it did before accounts. That covers no choice, a
 * choice of Default, an id this runner does not report — the workspace moved to another machine, the
 * slot was removed, or the runner is too old to list its accounts — and an engine whose CLI keeps a
 * single login for the machine. Those run on Default rather than fail: a session that never starts
 * is worse than one on the machine's own account.
 */
export function accountOnRunner(
  engine: LoginEngine | string | null | undefined,
  account: string | null | undefined,
  runnerEngines: unknown,
): RunnerEngineAccount | null {
  const id = account?.trim();
  if (!id || id === DEFAULT_ACCOUNT || !engineKeepsAccounts(engine)) return null;
  const report = sanitizeRunnerEngines(runnerEngines)?.find((entry) => entry.engine === engine);
  return report?.accounts?.find((candidate) => candidate.id === id) ?? null;
}

/**
 * The environment variable that hands one account's directory to `engine`'s CLI, or null for an
 * engine that takes none. This is the whole of how a session is pinned to an account: the value
 * travels in the session's env, and the runner spawns the CLI with it.
 */
export function accountEnvVar(engine: LoginEngine | string | null | undefined): string | null {
  if (!engineKeepsAccounts(engine)) return null;
  return engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
}
