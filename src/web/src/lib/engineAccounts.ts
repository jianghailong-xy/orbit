import type { LoginEngine, PlanUsage, PlanUsageSnapshot, RunnerEngineAccount } from '@orbit/shared';
import { codexAccountSnapshot } from '@orbit/shared';
import { planUsageSnapshotForProvider } from './planUsage';

/**
 * The engines whose CLI keeps one login per config directory, so one machine can sign in several
 * accounts of them — the web's copy of the runner's registry (src/runner-go/account_slot.go) and the
 * apiserver's (common/runner-engines.ts). Everything account-shaped on this page is gated on it
 * rather than on an engine name, so the next engine is a line here and a descriptor on the runner.
 */
export const ACCOUNT_ENGINES: readonly LoginEngine[] = ['claude', 'codex'];

export function engineKeepsAccounts(engine: string | null | undefined): engine is LoginEngine {
  return !!engine && (ACCOUNT_ENGINES as readonly string[]).includes(engine);
}

/** The directory one account's login lives in — a CODEX_HOME, a CLAUDE_CONFIG_DIR. */
export function accountDir(account: RunnerEngineAccount): string {
  return account.home ?? account.codexHome ?? '';
}

/**
 * One account's own quota: its entry under that engine snapshot's `accounts`, with Default's being
 * the snapshot's own windows (codexAccountSnapshot, src/shared/src/planUsage.ts — the same split for
 * every engine whose CLI keeps accounts, whatever its name).
 */
export function accountPlanUsage(
  usage: PlanUsage | null | undefined,
  engine: LoginEngine,
  accountId: string,
): PlanUsageSnapshot | null {
  const snapshot = planUsageSnapshotForProvider(usage, engine);
  return (snapshot && codexAccountSnapshot(snapshot, accountId)) ?? null;
}
