/**
 * Codex plan usage by account, the apiserver's half: the per-account snapshots a heartbeat's planUsage
 * may be stored with, and which account a run spends — the one every quota gate judges.
 *
 * A runner reports Default's quota as its Codex snapshot's own windows and every other account's under
 * that snapshot's `accounts`, by the account's id (src/runner-go/codex_account_usage.go).
 */
import { codexAccountOfEnv, type PlanUsage, type PlanUsageSnapshot } from '@orbit/shared';
import { ENGINE_ACCOUNTS_MAX, sanitizeRunnerEngines } from '../common/runner-engines';
import { codexAccountOnRunner } from './codex-account';

/** An account a runner added: 4 random bytes in lowercase hex (src/runner-go/codex_account_slot.go).
 *  Default is no entry of `accounts`: it is the Codex snapshot's own windows. */
const ADDED_ACCOUNT_ID = /^[0-9a-f]{8}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `usage` with its Codex snapshot's other accounts as they are stored: each under the id of an account
 * the runner added, and each as that account's own windows only — no `accounts` of its own, and no
 * reset block, which is Default's alone (docs/codex-rate-limit-reset-contract.md §3) and the only one
 * the stored-block ordering covers (§8). An entry under any other key, or that is not an object, is
 * dropped whole; at most ENGINE_ACCOUNTS_MAX are kept, as for the accounts the engine report lists.
 */
export function sanitizePlanUsageAccounts(usage: PlanUsage): PlanUsage {
  const codex: PlanUsageSnapshot | undefined = usage.codex ?? (usage.provider === 'codex' ? usage : undefined);
  if (!codex || !('accounts' in codex)) return usage;
  const { accounts: reported, ...rest } = codex;
  const accounts: Record<string, PlanUsageSnapshot> = {};
  let kept = 0;
  for (const [id, entry] of Object.entries(isObject(reported) ? reported : {})) {
    if (kept === ENGINE_ACCOUNTS_MAX) break;
    if (!ADDED_ACCOUNT_ID.test(id) || !isObject(entry)) continue;
    const { accounts: _nested, rateLimitReset: _block, ...own } = entry as PlanUsageSnapshot;
    accounts[id] = own;
    kept += 1;
  }
  const snapshot: PlanUsageSnapshot = kept ? { ...rest, accounts } : rest;
  return usage.codex ? { ...usage, codex: snapshot } : snapshot;
}

/**
 * The Codex account a run on `provider` spends, which is the account dispatch runs it on — what
 * planUsageBlockedUntil and planUsageReported are asked about, so that one account's spent quota never
 * holds back a run on another. It is decided as dispatch decides it (resolveProviderExec): the account
 * the workspace picked (`codexAccount`, Workspace.codexAccount) when its runner reports it
 * (codexAccountOnRunner), in place of any CODEX_HOME in the workspace's env; otherwise the account that
 * env's CODEX_HOME selects, or Default. The resulting env is read as the runner reads it
 * (codexAccountOfEnv), so a run with a key of its own spends no account. Undefined for any other
 * provider: accounts are Codex's.
 */
export function runCodexAccount(
  provider: string | null | undefined,
  workspaceEnv: unknown,
  codexAccount: string | null | undefined,
  runnerEngines: unknown,
): string | null | undefined {
  if (provider !== 'codex') return undefined;
  const env = isObject(workspaceEnv) ? workspaceEnv : null;
  const picked = codexAccountOnRunner(codexAccount, runnerEngines);
  const accounts = sanitizeRunnerEngines(runnerEngines)?.find((engine) => engine.engine === 'codex')?.accounts;
  return codexAccountOfEnv(picked ? { ...(env ?? {}), CODEX_HOME: picked.codexHome } : env, accounts);
}
