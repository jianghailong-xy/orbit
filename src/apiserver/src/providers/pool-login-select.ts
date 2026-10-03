import { quotaExpiresAt, quotaNearLimit, type PlanUsageSnapshot, type PlanUsageWindow } from '@orbit/shared';
import { accountName, windowName } from './codex-login-gateway';

/**
 * Which of the ChatGPT accounts a Codex pool of one's own holds (migrations 0323/0324) a session runs on —
 * the login twin of pool-select.ts, which chooses an account pool's member, and of pool-key-select.ts,
 * which chooses a shared pool's key, by the same rules where they mean the same thing. The claim chooses
 * and records the choice on the session (QueueService.resolveLoginPool, `pool_codex_account_id`); the
 * gateway sends on whatever that says, and moves nobody.
 */

/** What choosing reads of one account: whether OpenAI still takes it, until when the backend said its
 *  usage limit is reached (`spent_until`), and the last window reading its answers carried (`usage`, a
 *  Codex snapshot), both written by the pool gateway. */
export interface LoginAccount {
  accountId: string;
  email: string | null;
  /** ACTIVE, or SIGNED_OUT once OpenAI refused it. */
  state: string;
  spentUntil: Date | null;
  usage: PlanUsageSnapshot | null;
}

/** A window counts as used up at 100% — the line pool-select.ts draws too. */
const SPENT_UTILIZATION = 100;

/**
 * The windows of a reading that are used up and not yet reset, the 5-hour (primary) one first. One that
 * named no reset counts — nothing says it has reset (pool-select.ts isSpent).
 */
function spentWindows(usage: PlanUsageSnapshot | null, now: Date): PlanUsageWindow[] {
  return [usage?.primary, usage?.secondary].filter(
    (w): w is PlanUsageWindow =>
      !!w && w.utilization >= SPENT_UTILIZATION && !(Date.parse(w.resetsAt ?? '') <= now.getTime()),
  );
}

/**
 * Whether a session can run on `account` now: OpenAI still takes it, the usage limit the backend named is
 * not still ahead, and no window of its last reading is used up — a reading that says a window is full
 * keeps the next run off an account the backend would only refuse.
 */
export function loginCanRun(account: LoginAccount, now: Date): boolean {
  return (
    account.state === 'ACTIVE' &&
    !(account.spentUntil && account.spentUntil.getTime() > now.getTime()) &&
    spentWindows(account.usage, now).length === 0
  );
}

/**
 * When `account` can take a session again: `now` while it can, else once everything holding it has
 * passed — the backend's limit and every used-up window, so the latest of them. Null when waiting brings
 * nothing back: OpenAI signed it out, which only its owner's signing in again undoes, or a used-up window
 * named no reset.
 */
export function loginRunsAgainAt(account: LoginAccount, now: Date): Date | null {
  if (account.state !== 'ACTIVE') return null;
  const resets = spentWindows(account.usage, now).map((w) => Date.parse(w.resetsAt ?? ''));
  if (resets.some(Number.isNaN)) return null;
  return new Date(Math.max(now.getTime(), account.spentUntil?.getTime() ?? 0, ...resets));
}

/**
 * When work on a Codex pool of one's own can go again, for the brakes that hold work back rather than send
 * it (QueueService.accountPoolResumesAt) and the retry a failed turn arms (QueueService.loginPoolRetryAt):
 * `now` while one of its accounts can run, else the first of them to come back — one account freeing up is
 * enough for work to continue. Null when none comes back by waiting: the pool holds no account, or OpenAI
 * signed every one of them out.
 */
export function loginPoolResumesAt(accounts: readonly LoginAccount[], now: Date): Date | null {
  const times = accounts.flatMap((account) => {
    const at = loginRunsAgainAt(account, now);
    return at ? [at.getTime()] : [];
  });
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

/**
 * The account a claim puts a session of a login pool on, `accounts` being the pool's, oldest first:
 *
 * - `stickyId`, the account the session already runs on, is kept for as long as it can run, even when
 *   another would be taken first: moving accounts mid-conversation gains nothing.
 * - Otherwise one that can run, as pool-select.ts takes an account pool's members: none nearly spent
 *   (80% of a 5-hour window, 90% of a longer one) before one that is, then the one whose quota resets
 *   soonest (quotaExpiresAt) — what an account has left when its weekly window resets is lost — then the
 *   most room in its 5-hour window, an account with no reading after one with room. The rest of a tie
 *   goes to the older account.
 * - When none can run, the session stays on its own account: its run meets the limit or the refusal there,
 *   and the retry it arms waits for the first account to come back (QueueService.loginPoolRetryAt), whose
 *   claim then moves it. A session on none of the pool's accounts goes to the one that comes back first,
 *   else the oldest.
 *
 * Null only when the pool holds no account.
 */
export function chooseLoginAccount<Account extends LoginAccount>(
  accounts: readonly Account[],
  stickyId: string | null,
  now: Date,
): Account | null {
  const usable = accounts.filter((account) => loginCanRun(account, now));
  const chosen =
    usable.find((account) => account.accountId === stickyId) ?? [...usable].sort((a, b) => byChoice(a, b, now))[0];
  if (chosen) return chosen;
  const own = accounts.find((account) => account.accountId === stickyId);
  if (own) return own;
  const back = accounts.flatMap((account) => {
    const at = loginRunsAgainAt(account, now);
    return at ? [{ account, at: at.getTime() }] : [];
  });
  return back.sort((a, b) => a.at - b.at)[0]?.account ?? accounts[0] ?? null;
}

/**
 * The transcript line for a session moving onto account `to`, naming why it left the account it ran on —
 * pool-select.ts poolSwitchNotice's words, for ChatGPT accounts. `from` is null when that account is no
 * longer in the pool.
 */
export function loginSwitchNotice(to: LoginAccount, from: LoginAccount | null, now: Date): string {
  const why = from ? whyLeft(from, now) : 'the previous account is no longer in this pool';
  return `Switched to ${accountName(to)} — ${why}`;
}

/**
 * The line for a session of the pool's owner moving off ChatGPT account `from` onto API key `to` of the
 * same pool (migration 0358), none of its accounts being able to run: loginSwitchNotice's words, with the
 * key named by its label as pool-key-select.ts names one. `from` is null when that account is no longer in
 * the pool.
 */
export function loginToKeySwitchNotice(to: { label: string }, from: LoginAccount | null, now: Date): string {
  const why = from ? whyLeft(from, now) : 'the previous account is no longer in this pool';
  return `Switched to ${to.label} — ${why}`;
}

/**
 * The line for a session moving back off an API key onto ChatGPT account `to`, which can run again:
 * nothing is wrong with the key — a session runs on the pool's ChatGPT accounts first. `byOwner` says
 * whose session it is: the owner's own, whose accounts they are, or one of the people they added, for
 * whom they are the pool's.
 */
export function keyToLoginSwitchNotice(to: LoginAccount, byOwner = true): string {
  return `Switched to ${accountName(to)} — ${byOwner ? 'your ChatGPT accounts come first' : "the pool's ChatGPT accounts come first"}`;
}

/** Signed out first, since only its owner can undo that; then the used-up window, as the gateway names it. */
function whyLeft(from: LoginAccount, now: Date): string {
  const name = accountName(from);
  if (from.state !== 'ACTIVE') return `${name} was signed out by OpenAI`;
  const window = windowName(spentWindows(from.usage, now)[0] ?? null);
  return window ? `the ${window} window on ${name} is spent` : `the usage limit on ${name} is reached`;
}

/**
 * None nearly spent before one that is, then soonest-expiring quota first, then least 5-hour utilization,
 * no reading last. Two accounts expiring at Infinity, or both unread, subtract to NaN, which falls through
 * to 0: the sort keeps the pool's own order, oldest first.
 */
function byChoice(a: LoginAccount, b: LoginAccount, now: Date): number {
  const used = (account: LoginAccount) => account.usage?.primary?.utilization ?? Number.POSITIVE_INFINITY;
  return (
    Number(quotaNearLimit(a.usage, now)) - Number(quotaNearLimit(b.usage, now)) ||
    quotaExpiresAt(a.usage, now) - quotaExpiresAt(b.usage, now) ||
    used(a) - used(b) ||
    0
  );
}
