/**
 * Plan usage by account, the apiserver's half: the per-account snapshots a heartbeat's planUsage may
 * be stored with, and which account a run spends — the one every quota gate judges.
 *
 * A runner reports Default's quota as that engine's snapshot's own windows and every other account's
 * under that snapshot's `accounts`, by the account's id (src/runner-go/{codex,claude}_account_usage.go).
 */
import type { PlanUsage, PlanUsageSnapshot } from '@orbit/shared';
import { ENGINE_ACCOUNTS_MAX, sanitizeRunnerEngines } from '../common/runner-engines';
import { accountDir, accountOfEnv } from '@orbit/shared';
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

/** The accounts a workspace pins its sessions to, one per engine that keeps accounts. */
export interface WorkspaceAccountChoices {
  codexAccount?: string | null;
  claudeAccount?: string | null;
}
