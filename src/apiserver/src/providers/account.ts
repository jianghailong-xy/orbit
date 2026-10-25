import {
  ACCOUNT_DIR_VAR,
  accountOfEnv,
  accountToStartOn,
  isAccountEngine,
  withEnginePlanUsage,
  type AccountEngine,
  type LoginEngine,
  type PlanUsage,
  type RunnerEngineAccount,
  type RunnerEngineHealth,
} from '@orbit/shared';
import { runnerAccountPausedUntil } from '../common/account-pause';
import { engineKeepsAccounts, sanitizeRunnerEngines, usedRunnerEngines } from '../common/runner-engines';

/** The account every engine's slots have: the directory its own environment selects — the one a
 *  CLI typed in a terminal shares. */
export const DEFAULT_ACCOUNT = 'default';

/**
 * What the account helpers read of a runner, a subset of its row: its report (`engines`), the engines
 * whose Default its owner removed from Orbit (`defaultRemoved`), its pauses and its quota. Its engines
 * are read as Orbit uses them (usedRunnerEngines), so none of the helpers lists, picks, gates or
 * dispatches on a Default the owner removed.
 *
 * Every field is required, as `accountNames` is on NamedRunner: a select that forgets one does not
 * compile. That is also what keeps Automatic's pick the same wherever it is made — at create, before a
 * turn, at dispatch and at every quota gate.
 */
export interface AccountRunner {
  engines: unknown;
  defaultRemoved: unknown;
  accountPauses: unknown;
  planUsage: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `engine`'s entry as Orbit uses it (usedRunnerEngines): marked `removedDefault`, with Default left out
 *  of its accounts, while its owner removed Default from Orbit and the runner reports another account. */
function usedEngine(engine: string, runner: AccountRunner | null | undefined): RunnerEngineHealth | undefined {
  if (!runner) return undefined;
  return usedRunnerEngines({ engines: runner.engines, accountNames: null, defaultRemoved: runner.defaultRemoved })
    ?.find((entry) => entry.engine === engine);
}

/** Whether Orbit leaves `engine`'s Default out on this runner: its owner removed it from Orbit, and the
 *  runner reports another account of that engine to run on instead. With none, Default is in use. */
export function defaultRemovedOn(engine: string | null | undefined, runner: AccountRunner | null | undefined): boolean {
  return !!engine && !!usedEngine(engine, runner)?.removedDefault;
}

/** The runner's accounts of `engine` as Orbit uses them, each with the pause it is under at `now`. */
export function accountsOn(
  engine: AccountEngine,
  runner: AccountRunner | null | undefined,
  now: Date,
): RunnerEngineAccount[] | undefined {
  return usedEngine(engine, runner)?.accounts?.map((account) => ({
    ...account,
    pausedUntil: runnerAccountPausedUntil(runner!.accountPauses, engine, account.id, now)?.toISOString(),
  }));
}

/** A runner's planUsage as the account helpers weigh it: its heartbeat snapshot with Antigravity's
 *  quota folded in from the engine health it is reported with (withEnginePlanUsage). */
export function weighedPlanUsage(planUsage: unknown, runnerEngines: unknown): PlanUsage | null {
  return withEnginePlanUsage(isObject(planUsage) ? (planUsage as PlanUsage) : null, sanitizeRunnerEngines(runnerEngines));
}

/**
 * Automatic's pick among the runner's accounts of `engine` (accountToStartOn): the one whose quota would
 * otherwise go to waste first. While Default is removed from Orbit, among the accounts that remain —
 * the only one when one remains, and the first to free up when every one is spent or paused, where the
 * session then waits.
 */
export function automaticPick(engine: AccountEngine, runner: AccountRunner | null | undefined, now: Date): string | null {
  return accountToStartOn(
    engine,
    accountsOn(engine, runner, now),
    weighedPlanUsage(runner?.planUsage, runner?.engines),
    now,
    { defaultRemoved: defaultRemovedOn(engine, runner) },
  );
}

/** Automatic's pick (automaticPick) while `engine`'s Default is removed from Orbit, as the account the
 *  runner reports; null while Default is in use. */
export function remainingAccount(
  engine: AccountEngine,
  runner: AccountRunner | null | undefined,
  now: Date,
): RunnerEngineAccount | null {
  const entry = usedEngine(engine, runner);
  if (!entry?.removedDefault) return null;
  const id = automaticPick(engine, runner, now);
  return entry.accounts?.find((account) => account.id === id) ?? null;
}

/**
 * The account of `engine` the runner reports under the id `account`, unless that is Default: null for
 * no id, Default, an id this runner does not report, and an engine whose CLI keeps a single login.
 */
export function reportedAccount(
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
 * The account of `engine` a session dispatched to this runner runs on, when it is not Default.
 *
 * `account` is the slot id the session is to run on — the one picked for the session
 * (Session.codexAccount), else its workspace's choice (Workspace.codexAccount /
 * Workspace.claudeAccount). It is resolved against the accounts the assigned runner reported in its heartbeat
 * (`Runner.engines`), which is where each slot's directory comes from: the control plane stores the
 * id, never a path.
 *
 * Null means Default, and the session is dispatched with no config directory of its own, so the
 * runner resolves its own environment exactly as it did before accounts. That covers no choice, a
 * choice of Default, an id this runner does not report — the workspace moved to another machine, the
 * slot was removed, or the runner is too old to list its accounts — and an engine whose CLI keeps a
 * single login for the machine. Those run on Default rather than fail: a session that never starts
 * is worse than one on the machine's own account.
 *
 * Unless the owner removed that Default from Orbit (`runner.default_removed`) and the runner reports
 * another account of the engine: then nothing runs on Default, and each of those lands on Automatic's
 * pick among the accounts that remain instead (remainingAccount) — whenever the workspace's env
 * (`workspaceEnv`) would have left the session on Default too. A directory that env names, and a
 * credential of the session's own, are the user's setting and stay as they are.
 */
export function accountOnRunner(
  engine: LoginEngine | string | null | undefined,
  account: string | null | undefined,
  runner: AccountRunner | null | undefined,
  workspaceEnv?: unknown,
  now: Date = new Date(),
): RunnerEngineAccount | null {
  const reported = reportedAccount(engine, account, runner?.engines);
  if (reported || !isAccountEngine(engine) || !defaultRemovedOn(engine, runner)) return reported;
  const accounts = sanitizeRunnerEngines(runner!.engines)?.find((entry) => entry.engine === engine)?.accounts;
  if (accountOfEnv(engine, isObject(workspaceEnv) ? workspaceEnv : null, accounts) !== DEFAULT_ACCOUNT) return null;
  return remainingAccount(engine, runner, now);
}

/**
 * The environment variable that hands one account's directory to `engine`'s CLI, or null for an
 * engine that takes none. This is the whole of how a session is pinned to an account: the value
 * travels in the session's env, and the runner spawns the CLI with it.
 */
export function accountEnvVar(engine: LoginEngine | string | null | undefined): string | null {
  if (!engineKeepsAccounts(engine)) return null;
  return ACCOUNT_DIR_VAR[engine as AccountEngine];
}

/** Where a workspace — and a session, ahead of it — keeps the account picked for each engine that keeps
 *  accounts, and where a session says that pick was made by hand. One row each, so no reader decides
 *  "Claude, else Codex" and hands the next engine Codex's column. */
export const ACCOUNT_CHOICE = {
  codex: 'codexAccount',
  claude: 'claudeAccount',
  antigravity: 'antigravityAccount',
  kimi: 'kimiAccount',
  cursor: 'cursorAccount',
} as const satisfies Record<AccountEngine, string>;

export const ACCOUNT_PINNED = {
  codex: 'codexAccountPinned',
  claude: 'claudeAccountPinned',
  antigravity: 'antigravityAccountPinned',
  kimi: 'kimiAccountPinned',
  cursor: 'cursorAccountPinned',
} as const satisfies Record<AccountEngine, string>;
