/**
 * Plan usage by account, the apiserver's half: the per-account snapshots a heartbeat's planUsage may
 * be stored with, and which account a run spends — the one every quota gate judges.
 *
 * A runner reports Default's quota as that engine's snapshot's own windows and every other account's
 * under that snapshot's `accounts`, by the account's id (src/runner-go/{codex,claude}_account_usage.go).
 */
import type { PlanUsage, PlanUsageSnapshot } from '@orbit/shared';
import { ENGINE_ACCOUNTS_MAX, sanitizeRunnerEngines } from '../common/runner-engines';
import { accountDir, accountOfEnv, codexAccountToMoveTo, roomiestCodexAccount } from '@orbit/shared';
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
 * The Codex account a new session on this workspace and runner starts on when nothing picked one for
 * it: the runner's account with the most room right now (roomiestCodexAccount) — when the workspace
 * picked none either, and its env selects no other CODEX_HOME and no key of its own. Null otherwise:
 * the session then runs where the workspace's choice and env say. SessionsService.create stores the
 * answer on the session, which keeps it for life; the task quota gate asks the same question of a task
 * that is about to get one.
 */
export function automaticCodexAccount(
  workspace: { env?: unknown; codexAccount?: string | null } | null | undefined,
  runnerEngines: unknown,
  planUsage: unknown,
  now: Date,
): string | null {
  if (workspace?.codexAccount) return null;
  if (runAccount('codex', workspace?.env, null, runnerEngines) !== DEFAULT_ACCOUNT) return null;
  const accounts = sanitizeRunnerEngines(runnerEngines)?.find((engine) => engine.engine === 'codex')?.accounts;
  return roomiestCodexAccount(accounts, isObject(planUsage) ? (planUsage as PlanUsage) : null, now);
}

/**
 * Where a built-in Codex session goes when its account's usage limit ends a turn: another of the
 * runner's accounts that can run now (codexAccountToMoveTo) — when its workspace leaves the account to
 * Orbit, on the same condition as automaticCodexAccount: it picked none, and its env selects no other
 * CODEX_HOME and no key of its own. `from` is the account the session ran on, as dispatch resolved it.
 * Null when the session stays and waits for that account's reset: a workspace pinned to an account, a
 * runner with no second account, or no other account with room.
 */
export function codexAccountAfterUsageLimit(
  session: { codexAccount?: string | null },
  workspace: { env?: unknown; codexAccount?: string | null } | null | undefined,
  runnerEngines: unknown,
  planUsage: unknown,
  now: Date,
): { from: string; to: string } | null {
  if (workspace?.codexAccount) return null;
  if (runAccount('codex', workspace?.env, null, runnerEngines) !== DEFAULT_ACCOUNT) return null;
  const from = runAccount('codex', workspace?.env, { codexAccount: session.codexAccount }, runnerEngines);
  if (!from) return null;
  const accounts = codexAccountsOf(runnerEngines);
  const to = codexAccountToMoveTo(accounts, isObject(planUsage) ? (planUsage as PlanUsage) : null, now, from);
  return to ? { from, to } : null;
}

/**
 * The transcript line for a Codex session moved off an account whose usage limit it hit — the twin of
 * pool-select.ts poolSwitchNotice, in the same words, and like it never a possessive on a label. Without
 * it the quota gauge jumping between two turns reads as a broken gauge.
 */
export function codexAccountSwitchNotice(move: { from: string; to: string }, runnerEngines: unknown): string {
  const accounts = codexAccountsOf(runnerEngines);
  const label = (id: string) =>
    id === DEFAULT_ACCOUNT ? 'Default' : accounts?.find((account) => account.id === id)?.name || `Account ${id}`;
  return `Switched to ${label(move.to)} — the usage limit on ${label(move.from)} is reached`;
}

const codexAccountsOf = (runnerEngines: unknown) =>
  sanitizeRunnerEngines(runnerEngines)?.find((engine) => engine.engine === 'codex')?.accounts;

/** The accounts a workspace pins its sessions to, one per engine that keeps accounts. */
export interface WorkspaceAccountChoices {
  codexAccount?: string | null;
  claudeAccount?: string | null;
}
