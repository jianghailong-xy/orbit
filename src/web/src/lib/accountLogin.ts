import type { RunnerEngineAccount } from '@orbit/shared';
import {
  RUNNER_ENGINE_ACCOUNT_SIGNED_OUT_NOTE,
  RUNNER_UNIT_DAY,
  RUNNER_UNIT_DAYS,
  runnerEngineLoginExpires,
  runnerEngineSignedOutAlone,
} from './runnerCopy';

/** How far ahead of a login lapsing its row warns: Claude Code's own lead ("Your login expires in 3
 *  days · run /login to renew"), so the page says it when the CLI would. The Apple clients use the same
 *  (RunnerPageFormat.loginWarningLead). */
export const LOGIN_WARNING_LEAD_MS = 3 * 86_400_000;

/**
 * The warning under a signed-in account whose login lapses within LOGIN_WARNING_LEAD_MS, in whole days
 * rounded up the way Claude Code counts them. Null for an account not signed in, one whose login the
 * runner read no lapse for, one further off — and one already past it, which the runner reports signed
 * out.
 */
export function loginExpiresLine(
  account: Pick<RunnerEngineAccount, 'auth' | 'loginExpiresAt'> | undefined,
  now: number,
): string | null {
  if (account?.auth !== 'yes' || !account.loginExpiresAt) return null;
  const left = Date.parse(account.loginExpiresAt) - now;
  if (!(left > 0 && left <= LOGIN_WARNING_LEAD_MS)) return null;
  const days = Math.ceil(left / 86_400_000);
  return runnerEngineLoginExpires(days, days === 1 ? RUNNER_UNIT_DAY : RUNNER_UNIT_DAYS);
}

/** What a signed-out account costs, under its row: nothing runs on it until it is signed in again —
 *  and when it is the engine's only account on that machine, nothing runs on the engine there. */
export function signedOutNote(engineName: string, alone: boolean): string {
  return alone ? runnerEngineSignedOutAlone(engineName) : RUNNER_ENGINE_ACCOUNT_SIGNED_OUT_NOTE;
}
