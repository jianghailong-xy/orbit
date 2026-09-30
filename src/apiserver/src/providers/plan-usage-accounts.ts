/**
 * Plan usage by account, the apiserver's half: the per-account snapshots a heartbeat's planUsage may
 * be stored with, and which account a run spends — the one every quota gate judges.
 *
 * A runner reports Default's quota as that engine's snapshot's own windows and every other account's
 * under that snapshot's `accounts`, by the account's id (src/runner-go/{codex,claude}_account_usage.go).
 */
import type { PlanUsage, PlanUsageSnapshot } from '@orbit/shared';
import { ENGINE_ACCOUNTS_MAX, sanitizeRunnerEngines } from '../common/runner-engines';
import {
  accountDir,
  accountOfEnv,
  accountToMoveTo,
  accountToStartOn,
  planUsageBlockedUntil,
  type AccountEngine,
} from '@orbit/shared';
import { DEFAULT_ACCOUNT, accountEnvVar, accountOnRunner } from './account';

/** An account a runner added: 4 random bytes in lowercase hex (src/runner-go/account_slot.go).
 *  Default is no entry of `accounts`: it is that engine's snapshot's own windows. */
const ADDED_ACCOUNT_ID = /^[0-9a-f]{8}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `usage` with each engine snapshot's other accounts as they are stored: each under the id of an
 * account the runner added, and each as that account's own windows only — no `accounts` of its own,
 * and no reset block, which is Default's alone (docs/codex-rate-limit-reset-contract.md §3) and the
 * only one the stored-block ordering covers (§8). An entry under any other key, or that is not an
 * object, is dropped whole; at most ENGINE_ACCOUNTS_MAX are kept, as for the accounts the engine
 * report lists. Snapshots carrying no accounts are returned as they came, so a heartbeat that
 * reported none still stores the same object.
 */
export function sanitizePlanUsageAccounts(usage: PlanUsage): PlanUsage {
  // A runner older than nested snapshots reports its Codex quota as the payload itself.
  if (usage.provider === 'codex' && !usage.codex) return sanitizeAccountsOf(usage) ?? usage;
  const codex = sanitizeAccountsOf(usage.codex);
  const claude = sanitizeAccountsOf(usage.claude);
  if (codex === usage.codex && claude === usage.claude) return usage;
  return { ...usage, ...(codex ? { codex } : {}), ...(claude ? { claude } : {}) };
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
 * account that env selects, or Default. The resulting env is read as the runner reads it
 * (accountOfEnv), so a run with a credential of its own spends no account. Undefined for an engine
 * whose CLI keeps one login for the machine: it has no accounts to judge a run by.
 */
export function runAccount(
  provider: string | null | undefined,
  workspaceEnv: unknown,
  choices: WorkspaceAccountChoices | null | undefined,
  runnerEngines: unknown,
): string | null | undefined {
  const dirVar = accountEnvVar(provider);
  if (!dirVar) return undefined;
  const env = isObject(workspaceEnv) ? workspaceEnv : null;
  const chosen = provider === 'claude' ? choices?.claudeAccount : choices?.codexAccount;
  const picked = accountOnRunner(provider, chosen, runnerEngines);
  const accounts = sanitizeRunnerEngines(runnerEngines)?.find((engine) => engine.engine === provider)?.accounts;
  const withChoice = picked ? { ...(env ?? {}), [dirVar]: accountDir(picked) } : env;
  return accountOfEnv(provider, withChoice, accounts);
}

/**
 * Whether a workspace leaves its sessions' `engine` account to Orbit — Automatic: it picked none for
 * that engine, and its env selects no other config directory (CODEX_HOME, CLAUDE_CONFIG_DIR) and no
 * key of its own. Otherwise its choice or its env decides, and Orbit neither picks nor moves.
 */
export function workspaceLeavesAccountToOrbit(
  engine: AccountEngine,
  workspace: { env?: unknown; codexAccount?: string | null; claudeAccount?: string | null } | null | undefined,
  runnerEngines: unknown,
): boolean {
  if (engine === 'claude' ? workspace?.claudeAccount : workspace?.codexAccount) return false;
  return runAccount(engine, workspace?.env, null, runnerEngines) === DEFAULT_ACCOUNT;
}

/**
 * The `engine` account a new session on this workspace and runner starts on when nothing picked one
 * for it: the runner's account whose quota resets soonest (accountToStartOn) — when the workspace
 * leaves the account to Orbit. Null otherwise: the session then runs where the workspace's choice and
 * env say. SessionsService.create stores the answer on the session; the task quota gate asks the same
 * question of a task that is about to get one.
 */
export function automaticAccount(
  engine: AccountEngine,
  workspace: { env?: unknown; codexAccount?: string | null; claudeAccount?: string | null } | null | undefined,
  runnerEngines: unknown,
  planUsage: unknown,
  now: Date,
): string | null {
  if (!workspaceLeavesAccountToOrbit(engine, workspace, runnerEngines)) return null;
  const usage = isObject(planUsage) ? (planUsage as PlanUsage) : null;
  return accountToStartOn(engine, accountsOf(engine, runnerEngines), usage, now);
}

/** {@link automaticAccount} for Codex. */
export function automaticCodexAccount(
  workspace: { env?: unknown; codexAccount?: string | null } | null | undefined,
  runnerEngines: unknown,
  planUsage: unknown,
  now: Date,
): string | null {
  return automaticAccount('codex', workspace, runnerEngines, planUsage, now);
}

/**
 * Where a built-in session goes when its `engine` account's usage limit stops it: another of the
 * runner's accounts that can run now (accountToMoveTo) — when the session is on Automatic (nobody
 * picked its account by hand: `pinned`) and its workspace leaves the account to Orbit. `from` is the
 * account the session ran on, as dispatch resolved it. Null when the session stays and waits for that
 * account's reset: a hand-picked account, a workspace pinned to one, a runner with no second account,
 * or no other account with room.
 */
/**
 * Where a session on Automatic goes BEFORE a turn is dispatched to it, when its runner's own snapshot
 * already reports the account it is on spent: another of the runner's accounts with room
 * (accountToMoveTo) — the move a usage-limit failure makes (accountAfterUsageLimit), without the
 * failed turn it costs first. Null when the session is pinned, its workspace decides, its account is
 * not known to be spent (a window at 100% whose reset has not passed), or no other account has room.
 */
export function accountBeforeDispatch(
  engine: AccountEngine,
  session: { account?: string | null; pinned?: boolean },
  workspace: { env?: unknown; codexAccount?: string | null; claudeAccount?: string | null } | null | undefined,
  runnerEngines: unknown,
  planUsage: unknown,
  now: Date,
): { from: string; to: string } | null {
  if (session.pinned || !workspaceLeavesAccountToOrbit(engine, workspace, runnerEngines)) return null;
  const choice = engine === 'claude' ? { claudeAccount: session.account } : { codexAccount: session.account };
  const from = runAccount(engine, workspace?.env, choice, runnerEngines);
  if (!from) return null;
  const usage = isObject(planUsage) ? (planUsage as PlanUsage) : null;
  if (!planUsageBlockedUntil(usage, engine, now, from)) return null;
  const to = accountToMoveTo(engine, accountsOf(engine, runnerEngines), usage, now, from);
  return to ? { from, to } : null;
}

export function accountAfterUsageLimit(
  engine: AccountEngine,
  session: { account?: string | null; pinned?: boolean },
  workspace: { env?: unknown; codexAccount?: string | null; claudeAccount?: string | null } | null | undefined,
  runnerEngines: unknown,
  planUsage: unknown,
  now: Date,
): { from: string; to: string } | null {
  if (session.pinned || !workspaceLeavesAccountToOrbit(engine, workspace, runnerEngines)) return null;
  const choice = engine === 'claude' ? { claudeAccount: session.account } : { codexAccount: session.account };
  const from = runAccount(engine, workspace?.env, choice, runnerEngines);
  if (!from) return null;
  const usage = isObject(planUsage) ? (planUsage as PlanUsage) : null;
  const to = accountToMoveTo(engine, accountsOf(engine, runnerEngines), usage, now, from);
  return to ? { from, to } : null;
}

/** What an account is called where one is named: "Default", or what the user called it. */
export function accountLabel(engine: AccountEngine, id: string, runnerEngines: unknown): string {
  if (id === DEFAULT_ACCOUNT) return 'Default';
  return accountsOf(engine, runnerEngines)?.find((account) => account.id === id)?.name || `Account ${id}`;
}

/**
 * The transcript line for a session moved off an account whose usage limit it hit — the twin of
 * pool-select.ts poolSwitchNotice, in the same words, and like it never a possessive on a label. Without
 * it the quota gauge jumping between two turns reads as a broken gauge.
 */
export function accountSwitchNotice(
  engine: AccountEngine,
  move: { from: string; to: string },
  runnerEngines: unknown,
): string {
  return `Switched to ${accountLabel(engine, move.to, runnerEngines)} — the usage limit on ${accountLabel(engine, move.from, runnerEngines)} is reached`;
}

const accountsOf = (engine: AccountEngine, runnerEngines: unknown) =>
  sanitizeRunnerEngines(runnerEngines)?.find((entry) => entry.engine === engine)?.accounts;

/** The accounts a workspace pins its sessions to, one per engine that keeps accounts. */
export interface WorkspaceAccountChoices {
  codexAccount?: string | null;
  claudeAccount?: string | null;
}
