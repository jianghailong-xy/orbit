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
 *
 * `activeSessions` is not a column but a count of the session table (withActiveSessions), so a read that
 * has no need of it leaves it out. With it, a pick keeps each account to its share of them
 * (accountToStartOn, accountToMoveTo); without it, it answers by quota alone. A quota gate can go
 * without: an account's share only ever decides between accounts that can run.
 *
 * `blockedAccounts` is not a column either but what account health says of the runner's accounts
 * (docs/routing-account-health-design.md §7.6, withAccountHealth in account-health-blocked.ts). With it,
 * Automatic's choice inside one engine passes over a blocked account as it passes over a paused one
 * (accountsOn, accountBlockOn), so a runner with two Cursor accounts moves to the second; without it, it
 * answers as before health. It is the automatic account choice, not routing: it holds with smart model
 * selection off too.
 */
export interface AccountRunner {
  engines: unknown;
  defaultRemoved: unknown;
  accountPauses: unknown;
  planUsage: unknown;
  activeSessions?: ActiveSessions;
  blockedAccounts?: BlockedAccounts;
}

/**
 * Why account health takes an account out of Automatic's choice, for the line a move off it says
 * (accountSwitchNotice): the provider refused it in a way only its owner can fix (`needs-action`), it
 * failed to start runs at no cost (`failing`, the breaker), it hit its usage limit with no reading to go by
 * (`usage-limit`), or another run is trying it now (`trial`).
 */
export type AccountBlockReason = 'needs-action' | 'failing' | 'usage-limit' | 'trial';

/** One account health takes out (§7.1's removing states, on the whole account): until when (ms), and why. */
export interface AccountBlock {
  until: number;
  reason: AccountBlockReason;
}

/** The accounts account health takes out on one runner, by engine and account id; one with none left out. */
export type BlockedAccounts = Partial<Record<AccountEngine, Record<string, AccountBlock>>>;

/** How many sessions are at work on each of a runner's accounts of each engine, by account id, an account
 *  with none left out (activeSessionsOn). An engine present here was counted. */
export type ActiveSessions = Partial<Record<AccountEngine, Record<string, number>>>;

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

/**
 * The runner's accounts of `engine` as Orbit uses them, each with the pause it is under at `now` and,
 * where they were counted, its active sessions. An account health takes out (accountBlockOn) reads as
 * paused until its block ends, which is how every pick below passes it over: a blocked account is treated
 * as a paused one (§7.6). Nothing is written as a pause; the owner's own pause stays theirs.
 */
export function accountsOn(
  engine: AccountEngine,
  runner: AccountRunner | null | undefined,
  now: Date,
): RunnerEngineAccount[] | undefined {
  const active = runner?.activeSessions?.[engine];
  return usedEngine(engine, runner)?.accounts?.map((account) => {
    const pause = runnerAccountPausedUntil(runner!.accountPauses, engine, account.id, now);
    const block = accountBlockOn(engine, runner, account.id, now);
    const until = block && !(pause && pause.getTime() >= block.until) ? new Date(block.until) : pause;
    return {
      ...account,
      pausedUntil: until?.toISOString(),
      ...(active ? { activeSessions: active[account.id] ?? 0 } : {}),
    };
  });
}

/**
 * The block account health puts on the runner's `account` of `engine` at `now` (AccountRunner.blockedAccounts),
 * or null: none, it has run out, or every other signed-in account of the engine is blocked as well. Health then
 * decides nothing, and the choice is made as it was before health: an account that may refuse is still better
 * than the session going nowhere, and the routing above holds a task whose every account is out (§7.5).
 */
export function accountBlockOn(
  engine: AccountEngine,
  runner: AccountRunner | null | undefined,
  account: string | null | undefined,
  now: Date,
): AccountBlock | null {
  const blocked = runner?.blockedAccounts?.[engine];
  if (!blocked || !account) return null;
  const at = now.getTime();
  const live = (id: string) => ((blocked[id]?.until ?? 0) > at ? blocked[id] : null);
  const block = live(account);
  if (!block) return null;
  const free = usedEngine(engine, runner)?.accounts?.some((other) => other.auth !== 'no' && !live(other.id));
  return free ? block : null;
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

/**
 * Where a session on account `leaving` goes while that account is being removed: Automatic's ranking
 * (accountToStartOn) over the runner's other accounts of `engine` that are signed in — the only one when
 * one is left. Null when none is, and the session has nowhere to go.
 */
export function accountInPlaceOf(
  engine: AccountEngine,
  runner: AccountRunner | null | undefined,
  leaving: string,
  now: Date,
): string | null {
  const pool = accountsOn(engine, runner, now)?.filter((account) => account.id !== leaving && account.auth !== 'no');
  if (!pool || pool.length === 0) return null;
  if (pool.length === 1) return pool[0].id;
  return accountToStartOn(engine, pool, weighedPlanUsage(runner?.planUsage, runner?.engines), now) ?? pool[0].id;
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
