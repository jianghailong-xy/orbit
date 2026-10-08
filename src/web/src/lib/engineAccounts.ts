import type { AccountEngine, LoginEngine, PlanUsage, PlanUsageSnapshot, RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import { ACCOUNT_ENGINES as SHARED_ACCOUNT_ENGINES, codexAccountSnapshot, isAccountEngine } from '@orbit/shared';
import type { Runner } from '../components/TasksSidePanel';
import { planUsageSnapshotForProvider } from './planUsage';

/**
 * The engines whose CLI keeps one login per config directory, so one machine can sign in several
 * accounts of them — the web's copy of the runner's registry (src/runner-go/account_slot.go) and the
 * apiserver's (common/runner-engines.ts), which @orbit/shared keeps for every client. Everything
 * account-shaped on this page is gated on it rather than on an engine name, so the next engine is a
 * line there and a descriptor on the runner.
 */
export const ACCOUNT_ENGINES: readonly AccountEngine[] = SHARED_ACCOUNT_ENGINES;

export function engineKeepsAccounts(engine: string | null | undefined): engine is AccountEngine {
  return isAccountEngine(engine);
}

/** What a runner declares once it signs an Antigravity account the control plane names into that
 *  account's own Gemini directory (runner antigravity_account_slot.go). Without it a named sign-in
 *  would replace Default's, so nothing offers to add one — and, there being nothing to carry between
 *  them, it is also all a session needs to move from one Antigravity account to another. */
export const ANTIGRAVITY_ACCOUNT_LOGIN_CAPABILITY = 'antigravity-account-login/v1';

/** Whether "Add account" can add an Antigravity account on this runner: each is a Google sign-in, so
 *  it takes a runner that can relay one (`googleLogin` — not a macOS one, not an old one, which say
 *  why instead) and that keeps it in an account of its own. */
export function addsAntigravityAccounts(runner: Pick<Runner, 'antigravity' | 'capabilities'>): boolean {
  return (
    runner.antigravity?.googleLogin === 'available' &&
    runner.antigravity.supported !== false &&
    !!runner.capabilities?.includes(ANTIGRAVITY_ACCOUNT_LOGIN_CAPABILITY)
  );
}

/**
 * Antigravity's Default on a runner that runs agy on its own GEMINI_API_KEY: the engine answers signed
 * in (on the key, `authSource` env_key) while Default, which is the runner's Google sign-in and
 * nothing else, answers no. A session on it runs on that key, so it is neither signed out nor short of
 * quota: every page shows it as the engine's own row always has ("env key"), and no count of
 * signed-out accounts includes it.
 */
export function runsOnEnvKey(
  health: Pick<RunnerEngineHealth, 'engine' | 'auth' | 'authSource'> | null | undefined,
  account: Pick<RunnerEngineAccount, 'id' | 'auth'>,
): boolean {
  return (
    health?.engine === 'antigravity' &&
    account.id === 'default' &&
    account.auth !== 'yes' &&
    health.auth === 'yes' &&
    health.authSource !== 'google'
  );
}

/** What an account is called wherever one is named: what the user called it — Default too, once
 *  renamed in Orbit — else "Default", or the slot's own id when the name it was added under is gone.
 *  The apiserver's accountLabel names it the same way in a session's transcript. */
export function accountNameOf(account: Pick<RunnerEngineAccount, 'id' | 'name'>): string {
  return account.name || (account.id === 'default' ? 'Default' : `Account ${account.id}`);
}

/** What "+ Account" calls a new account until the user names it: its number on the machine, Default
 *  being the first — or the next number free, so it never takes a name an account already goes by. */
export function defaultAccountName(accounts: Pick<RunnerEngineAccount, 'id' | 'name'>[]): string {
  const taken = new Set(accounts.map(accountNameOf));
  let n = Math.max(accounts.length, 1) + 1;
  while (taken.has(`Account ${n}`)) n++;
  return `Account ${n}`;
}

/** The directory one account's login lives in — a CODEX_HOME, a CLAUDE_CONFIG_DIR, an Antigravity
 *  Google sign-in's Gemini directory. */
export function accountDir(account: RunnerEngineAccount): string {
  return account.home ?? account.codexHome ?? '';
}

/**
 * One account's own quota: its entry under that engine snapshot's `accounts`, with Default's being
 * the snapshot's own windows (codexAccountSnapshot, src/shared/src/planUsage.ts — the same split for
 * every engine whose CLI keeps accounts, whatever its name). Antigravity's travels with its engine's
 * health rather than in the heartbeat's planUsage, so a reader passes the runner's planUsage with it
 * folded in (withEnginePlanUsage).
 */
export function accountPlanUsage(
  usage: PlanUsage | null | undefined,
  engine: LoginEngine,
  accountId: string,
): PlanUsageSnapshot | null {
  const snapshot = planUsageSnapshotForProvider(usage, engine);
  return (snapshot && codexAccountSnapshot(snapshot, accountId)) ?? null;
}
