/**
 * Plan usage by account, the apiserver's half: the per-account snapshots a heartbeat's planUsage may
 * be stored with, and which account a run spends — the one every quota gate judges.
 *
 * A runner reports Default's quota as that engine's snapshot's own windows and every other account's
 * under that snapshot's `accounts`, by the account's id (src/runner-go/{codex,claude}_account_usage.go),
 * and Kimi Code's and Cursor CLI's the same way under `kimi` and `cursor` (src/runner-go/cursor_usage.go).
 */
import type { PlanUsage, PlanUsageSnapshot } from '@orbit/shared';
import { ENGINE_ACCOUNTS_MAX, namedRunnerEngines, sanitizeRunnerEngines } from '../common/runner-engines';
import {
  accountDir,
  accountOfEnv,
  accountToMoveTo,
  accountToMoveToAt,
  isAccountEngine,
  planUsageBlockedUntil,
  type AccountEngine,
} from '@orbit/shared';
import {
  ACCOUNT_CHOICE,
  DEFAULT_ACCOUNT,
  accountEnvVar,
  accountOnRunner,
  accountsOn,
  automaticPick,
  defaultRemovedOn,
  remainingAccount,
  weighedPlanUsage,
  type AccountRunner,
} from './account';
import { runnerAccountPausedUntil } from '../common/account-pause';

/** An account a runner added: 4 random bytes in lowercase hex (src/runner-go/account_slot.go).
 *  Default is no entry of `accounts`: it is that engine's snapshot's own windows. */
const ADDED_ACCOUNT_ID = /^[0-9a-f]{8}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `usage` with each engine snapshot's other accounts as they are stored: each under the id of an
 * account the runner added, and each as that account's own windows only — no `accounts` of its own,
 * and no reset block, which is Default's alone (docs/codex-rate-limit-reset-contract.md §3) and the
 * only one the stored-block ordering covers (§8). An entry under any other key, that is not an
 * object, or that names another account than its key (a Cursor CLI snapshot's `account`), is dropped
 * whole; at most ENGINE_ACCOUNTS_MAX are kept, as for the accounts the engine report lists. Snapshots
 * carrying no accounts are returned as they came, so a heartbeat that reported none still stores the
 * same object.
 */
export function sanitizePlanUsageAccounts(usage: PlanUsage): PlanUsage {
  // A runner older than nested snapshots reports its Codex quota as the payload itself.
  if (usage.provider === 'codex' && !usage.codex) return sanitizeAccountsOf(usage) ?? usage;
  const codex = sanitizeAccountsOf(usage.codex);
  const claude = sanitizeAccountsOf(usage.claude);
  const kimi = sanitizeAccountsOf(usage.kimi);
  const cursor = sanitizeAccountsOf(usage.cursor);
  if (codex === usage.codex && claude === usage.claude && kimi === usage.kimi && cursor === usage.cursor) return usage;
  return {
    ...usage,
    ...(codex ? { codex } : {}),
    ...(claude ? { claude } : {}),
    ...(kimi ? { kimi } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/** One engine snapshot with its `accounts` as they are stored, or the same object when it carries
 *  none (the caller uses that identity to leave the whole payload untouched). */
function sanitizeAccountsOf(snapshot: PlanUsageSnapshot | undefined): PlanUsageSnapshot | undefined {
  if (!snapshot || !('accounts' in snapshot)) return snapshot;
  const { accounts: reported, ...rest } = snapshot;
  const accounts: Record<string, PlanUsageSnapshot> = {};
  let kept = 0;
  for (const [id, entry] of Object.entries(isObject(reported) ? reported : {})) {
    if (kept === ENGINE_ACCOUNTS_MAX) break;
    if (!ADDED_ACCOUNT_ID.test(id) || !isObject(entry)) continue;
    if (entry.account !== undefined && entry.account !== id) continue;
    const { accounts: _nested, rateLimitReset: _block, ...own } = entry as PlanUsageSnapshot;
    accounts[id] = own;
    kept += 1;
  }
  return kept ? { ...rest, accounts } : rest;
}


/**
 * The account a run on `provider` spends, which is the account dispatch runs it on — what
 * planUsageBlockedUntil and planUsageReported are asked about, so that one account's spent quota never
 * holds back a run on another. It is decided as dispatch decides it (resolveProviderExec): the account
 * picked for the session or else its workspace (Session.codexAccount, Workspace.codexAccount /
 * Workspace.claudeAccount — callers pass the one that applies) when its runner reports it
 * (accountOnRunner), in place of any config-directory variable in the workspace's env; otherwise the
 * account that env selects, or Default — or, while the owner has removed Default from Orbit, Automatic's
 * pick among the accounts that remain (accountOnRunner). The resulting env is read as the runner reads it
 * (accountOfEnv), so a run with a credential of its own spends no account. Undefined for an engine
 * whose CLI keeps one login for the machine: it has no accounts to judge a run by.
 */
export function runAccount(
  provider: string | null | undefined,
  workspaceEnv: unknown,
  choices: WorkspaceAccountChoices | null | undefined,
  runner: AccountRunner | null | undefined,
  now: Date = new Date(),
): string | null | undefined {
  const dirVar = accountEnvVar(provider);
  if (!dirVar || !isAccountEngine(provider)) return undefined;
  const env = isObject(workspaceEnv) ? workspaceEnv : null;
  const chosen = choices?.[ACCOUNT_CHOICE[provider]];
  const picked = accountOnRunner(provider, chosen, runner, env, now);
  const accounts = sanitizeRunnerEngines(runner?.engines)?.find((engine) => engine.engine === provider)?.accounts;
  const withChoice = picked ? { ...(env ?? {}), [dirVar]: accountDir(picked) } : env;
  return accountOfEnv(provider, withChoice, accounts);
}

/**
 * The account a session is on by its runner's report alone: runAccount with Default in use, whether or
 * not its owner removed it from Orbit. That is where a session dispatched before the removal runs — its
 * conversation's account — and what a move is made from: a session this answers Default for, while
 * Default is removed, is one that moves (removedDefaultMove).
 */
export function reportedRunAccount(
  provider: string | null | undefined,
  workspaceEnv: unknown,
  choices: WorkspaceAccountChoices | null | undefined,
  runnerEngines: unknown,
): string | null | undefined {
  return runAccount(provider, workspaceEnv, choices, {
    engines: runnerEngines, defaultRemoved: null, accountPauses: null, planUsage: null,
  });
}

/**
 * Whether a workspace leaves its sessions' `engine` account to Orbit — Automatic: it picked none for
 * that engine, and its env selects no other config directory (CODEX_HOME, CLAUDE_CONFIG_DIR,
 * ORBIT_ANTIGRAVITY_GOOGLE_DIR, KIMI_CODE_HOME, ORBIT_CURSOR_ACCOUNT_DIR) and no key of its own.
 * Otherwise its choice or its env decides, and Orbit neither picks nor moves.
 *
 * A workspace set to a Default its owner removed from Orbit runs on Automatic too: there is no other
 * account that choice could mean.
 */
export function workspaceLeavesAccountToOrbit(
  engine: AccountEngine,
  workspace: AccountWorkspace | null | undefined,
  runner: AccountRunner | null | undefined,
): boolean {
  const choice = workspace?.[ACCOUNT_CHOICE[engine]];
  if (choice && !(choice === DEFAULT_ACCOUNT && defaultRemovedOn(engine, runner))) return false;
  return reportedRunAccount(engine, workspace?.env, null, runner?.engines) === DEFAULT_ACCOUNT;
}

/** What the account helpers read of a workspace: its env and its choice for each engine. */
export type AccountWorkspace = { env?: unknown } & WorkspaceAccountChoices;

/**
 * The `engine` account a new session on this workspace and runner starts on when nothing picked one
 * for it: the runner's account whose quota resets soonest (accountToStartOn) — when the workspace
 * leaves the account to Orbit. Null otherwise: the session then runs where the workspace's choice and
 * env say. SessionsService.create stores the answer on the session; the task quota gate asks the same
 * question of a task that is about to get one. While the owner has removed Default from Orbit, the pick
 * is among the accounts that remain (automaticPick), and there is one even when one remains.
 */
export function automaticAccount(
  engine: AccountEngine,
  workspace: AccountWorkspace | null | undefined,
  runner: AccountRunner | null | undefined,
  now: Date,
): string | null {
  if (!workspaceLeavesAccountToOrbit(engine, workspace, runner)) return null;
  return automaticPick(engine, runner, now);
}

/** {@link automaticAccount} for Codex. */
export function automaticCodexAccount(
  workspace: { env?: unknown; codexAccount?: string | null } | null | undefined,
  runner: AccountRunner | null | undefined,
  now: Date,
): string | null {
  return automaticAccount('codex', workspace, runner, now);
}

/** A move of a session from one of its runner's accounts to another, as the moves below answer it. */
export interface AccountMove {
  from: string;
  to: string;
  /** Left because the account it was on is paused. */
  paused?: boolean;
  /** Left because it was on a Default the owner removed from Orbit (removedDefaultMove). */
  defaultRemoved?: boolean;
  /** Left because the account it was on is signed out: its runner reports it so, or it refused the
   *  session's sign-in (accountAfterSignOut). */
  signedOut?: boolean;
}

/**
 * The move off a Default the owner removed from Orbit. A session on it — picked by hand, pinned, set by
 * its workspace, or from before accounts with none at all — goes to Automatic's pick among the accounts
 * that remain (remainingAccount), pinned or not and whatever its workspace says: nothing can pin a
 * session to an account Orbit no longer uses. It goes even when that pick is spent or paused, which is
 * then the first to free up, and waits there. A workspace whose env names a directory keeps it. Null for
 * a session that is on anything else, or while Default is in use.
 */
function removedDefaultMove(
  engine: AccountEngine,
  account: string | null | undefined,
  workspace: AccountWorkspace | null | undefined,
  runner: AccountRunner | null | undefined,
  now: Date,
): AccountMove | null {
  if (!defaultRemovedOn(engine, runner)) return null;
  // The session's own column, else its workspace's choice: a session that follows its workspace is on
  // the account the workspace picked.
  const column = ACCOUNT_CHOICE[engine];
  const from = reportedRunAccount(engine, workspace?.env, { [column]: account ?? workspace?.[column] }, runner?.engines);
  if (from !== DEFAULT_ACCOUNT) return null;
  const to = remainingAccount(engine, runner, now);
  return to ? { from, to: to.id, defaultRemoved: true } : null;
}

/**
 * Where a built-in session goes when its `engine` account's usage limit stops it: another of the
 * runner's accounts that can run now (accountToMoveTo) — when the session is on Automatic (nobody
 * picked its account by hand: `pinned`) and its workspace leaves the account to Orbit. `from` is the
 * account the session ran on, as dispatch resolved it. Null when the session stays and waits for that
 * account's reset: a hand-picked account, a workspace pinned to one, a runner with no second account —
 * or no other account with room, when it waits for the first account to free up, that one or another
 * (accountAfterUsageLimitAt).
 */
/**
 * Where a session on Automatic goes BEFORE a turn is dispatched to it, when its runner's own snapshot
 * already reports the account it is on spent: another of the runner's accounts with room
 * (accountToMoveTo) — the move a usage-limit failure makes (accountAfterUsageLimit), without the
 * failed turn it costs first. Null when the session is pinned, its workspace decides, its account is
 * not known to be spent (a window at 100% whose reset has not passed), or no other account has room.
 *
 * An account the runner reports signed out is left the same way. Nothing runs on it until somebody
 * signs it in again, and on 2026-10-31 a session stayed on one for over an hour after its login lapsed,
 * beside two accounts that were signed in: its next message failed at the runner's sign-in check.
 *
 * A session on a Default the owner removed from Orbit moves whatever else holds: pinned or not, and
 * whether or not the pick has room (removedDefaultMove).
 */
export function accountBeforeDispatch(
  engine: AccountEngine,
  session: { account?: string | null; pinned?: boolean },
  workspace: AccountWorkspace | null | undefined,
  runner: AccountRunner | null | undefined,
  now: Date,
): AccountMove | null {
  const removed = removedDefaultMove(engine, session.account, workspace, runner, now);
  if (removed) return removed;
  if (session.pinned || !workspaceLeavesAccountToOrbit(engine, workspace, runner)) return null;
  const from = runAccount(engine, workspace?.env, { [ACCOUNT_CHOICE[engine]]: session.account }, runner, now);
  if (!from) return null;
  const usage = weighedPlanUsage(runner?.planUsage, runner?.engines);
  const accounts = accountsOn(engine, runner, now);
  const paused = runnerAccountPausedUntil(runner?.accountPauses, engine, from, now) !== null;
  const signedOut = accounts?.find((account) => account.id === from)?.auth === 'no';
  if (!paused && !signedOut && !planUsageBlockedUntil(usage, engine, now, from)) return null;
  const to = accountToMoveTo(engine, accounts, usage, now, from);
  return to ? { from, to, ...(paused ? { paused: true } : signedOut ? { signedOut: true } : {}) } : null;
}

export function accountAfterUsageLimit(
  engine: AccountEngine,
  session: { account?: string | null; pinned?: boolean },
  workspace: AccountWorkspace | null | undefined,
  runner: AccountRunner | null | undefined,
  now: Date,
): AccountMove | null {
  const removed = removedDefaultMove(engine, session.account, workspace, runner, now);
  if (removed) return removed;
  if (session.pinned || !workspaceLeavesAccountToOrbit(engine, workspace, runner)) return null;
  const from = runAccount(engine, workspace?.env, { [ACCOUNT_CHOICE[engine]]: session.account }, runner, now);
  if (!from) return null;
  const usage = weighedPlanUsage(runner?.planUsage, runner?.engines);
  const to = accountToMoveTo(engine, accountsOn(engine, runner, now), usage, now, from);
  return to ? { from, to } : null;
}

/**
 * Where a built-in session goes when the account it ran on refused its sign-in. Either the runtime
 * said "Failed to authenticate", or the runner found the account signed out before it could start the
 * engine. The answer is accountAfterUsageLimit's: another of the runner's accounts that can run now,
 * for a session on Automatic whose workspace leaves the account to Orbit. The account it ran on is
 * left whatever the runner last reported of it, because that report can be minutes older than the
 * refusal. Null when the session stays; then signing that account in again is the remedy.
 */
export function accountAfterSignOut(
  engine: AccountEngine,
  session: { account?: string | null; pinned?: boolean },
  workspace: AccountWorkspace | null | undefined,
  runner: AccountRunner | null | undefined,
  now: Date,
): AccountMove | null {
  const move = accountAfterUsageLimit(engine, session, workspace, runner, now);
  return move && !move.defaultRemoved ? { ...move, signedOut: true } : move;
}

/**
 * When a session on Automatic that its account's usage limit stopped can go again on another of the
 * runner's accounts — what its retry waits for, where accountAfterUsageLimit is where it goes: `now`
 * while one has room (the retry's dispatch moves it there, accountBeforeDispatch), else when the first
 * of them frees up (accountToMoveToAt). Null when the session is pinned, its workspace decides, or no
 * other account names such a moment: then only its own account's reset says when.
 */
export function accountAfterUsageLimitAt(
  engine: AccountEngine,
  session: { account?: string | null; pinned?: boolean },
  workspace: AccountWorkspace | null | undefined,
  runner: AccountRunner | null | undefined,
  now: Date,
): Date | null {
  if (session.pinned || !workspaceLeavesAccountToOrbit(engine, workspace, runner)) return null;
  const from = runAccount(engine, workspace?.env, { [ACCOUNT_CHOICE[engine]]: session.account }, runner, now);
  if (!from) return null;
  const usage = weighedPlanUsage(runner?.planUsage, runner?.engines);
  return accountToMoveToAt(engine, accountsOn(engine, runner, now), usage, now, from);
}

/** What an account's name is read from: the runner's report, and the names its accounts were given in
 *  Orbit (namedRunnerEngines). Both, so a select that forgets the names does not compile. */
export type NamedRunner = { engines: unknown; accountNames: unknown };

/** What an account is called where one is named: what the user called it — Default too, once renamed
 *  — else "Default", or the slot's id when the name it was added under is gone. */
export function accountLabel(engine: AccountEngine, id: string, runner: NamedRunner): string {
  const name = namedRunnerEngines(runner)
    ?.find((entry) => entry.engine === engine)
    ?.accounts?.find((account) => account.id === id)?.name;
  if (name) return name;
  return id === DEFAULT_ACCOUNT ? 'Default' : `Account ${id}`;
}

/**
 * The transcript line for a session moved off an account whose usage limit it hit — the twin of
 * pool-select.ts poolSwitchNotice, in the same words, and like it never a possessive on a label. Without
 * it the quota gauge jumping between two turns reads as a broken gauge. A session moved off a Default the
 * owner removed from Orbit is told so, by the name Default goes by, and one moved off a signed-out
 * account is told that.
 */
export function accountSwitchNotice(
  engine: AccountEngine,
  move: AccountMove,
  runner: NamedRunner,
): string {
  if (move.defaultRemoved) {
    return `Switched to ${accountLabel(engine, move.to, runner)} — ${accountLabel(engine, move.from, runner)} is no longer used by Orbit`;
  }
  if (move.signedOut) {
    return `Switched to ${accountLabel(engine, move.to, runner)} — ${accountLabel(engine, move.from, runner)} is signed out`;
  }
  return move.paused
    ? `Switched to ${accountLabel(engine, move.to, runner)} — ${accountLabel(engine, move.from, runner)} is paused`
    : `Switched to ${accountLabel(engine, move.to, runner)} — the usage limit on ${accountLabel(engine, move.from, runner)} is reached`;
}

/** Pause on the account this session actually spends, including a directory selected by env — and, on a
 *  Default its owner removed from Orbit, the account it runs on instead (runAccount). */
export function sessionAccountPausedUntil(
  session: { provider: string | null; providerBuiltin: boolean } & WorkspaceAccountChoices,
  workspace: AccountWorkspace | null | undefined,
  runner: AccountRunner,
  now = new Date(),
): Date | null {
  const engine = session.provider;
  if (!session.providerBuiltin || !isAccountEngine(engine)) return null;
  const account = runAccount(engine, workspace?.env, {
    codexAccount: session.codexAccount ?? workspace?.codexAccount,
    claudeAccount: session.claudeAccount ?? workspace?.claudeAccount,
    antigravityAccount: session.antigravityAccount ?? workspace?.antigravityAccount,
    kimiAccount: session.kimiAccount ?? workspace?.kimiAccount,
    cursorAccount: session.cursorAccount ?? workspace?.cursorAccount,
  }, runner, now);
  return runnerAccountPausedUntil(runner.accountPauses, engine, account, now);
}

/**
 * Whether a session is on a Default its owner removed from Orbit: by its runner's report alone it runs
 * on Default (reportedRunAccount) — a choice of Default, none, or one the runner does not report, with a
 * workspace env that selects Default too — while Orbit leaves that Default out. Such a session is moved
 * before its next turn (accountBeforeDispatch), and an engine still resident on Default is not handed one.
 */
export function onRemovedDefault(
  session: { provider: string | null; providerBuiltin: boolean } & WorkspaceAccountChoices,
  workspace: AccountWorkspace | null | undefined,
  runner: AccountRunner,
): boolean {
  const engine = session.provider;
  if (!session.providerBuiltin || !isAccountEngine(engine) || !defaultRemovedOn(engine, runner)) return false;
  const column = ACCOUNT_CHOICE[engine];
  const choice = { [column]: session[column] ?? workspace?.[column] };
  return reportedRunAccount(engine, workspace?.env, choice, runner.engines) === DEFAULT_ACCOUNT;
}

/** The accounts a workspace pins its sessions to, one per engine that keeps accounts. */
export interface WorkspaceAccountChoices {
  codexAccount?: string | null;
  claudeAccount?: string | null;
  antigravityAccount?: string | null;
  kimiAccount?: string | null;
  cursorAccount?: string | null;
}
