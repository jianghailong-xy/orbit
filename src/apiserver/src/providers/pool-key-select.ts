import { nextUsageWindowStart } from './shared-pool';

/** A share cap is whole US dollars; the ledger counts millionths of one. */
const MICROS_PER_DOLLAR = 1_000_000;

/** What choosing reads of one key of a shared pool (migrations 0321, 0322). */
export interface PoolKeyCandidate {
  id: string;
  contributorId: string;
  enabled: boolean;
  /** What OpenAI last said about the key: ACTIVE, INVALID or DISABLED. */
  state: string;
  /** Whole US dollars a calendar month everyone but the contributor may spend on it; null = no cap. */
  shareCap: number | null;
  /** What everyone but the contributor has spent on it this month, in millionths of a dollar. */
  othersCostMicros: number;
  /** Out of budget until then — OpenAI answered `insufficient_quota` for it; null when it has not. */
  spentUntil: Date | null;
  /** Rate-limited until then — OpenAI answered 429 and the gateway's own wait was not enough to outlast
   *  it (migration 0382); null when it has not been. Short: minutes, and not a budget. */
  throttledUntil: Date | null;
  pausedUntil?: Date | null;
}

/**
 * What `key` has left for a session of `requesterId` this month, in millionths of a dollar. All of it on
 * a key of their own — the contributor's own use is never capped — and on a key with no cap.
 */
export function keyRoom(key: PoolKeyCandidate, requesterId: string): number {
  if (key.contributorId === requesterId || key.shareCap === null) return Number.POSITIVE_INFINITY;
  return key.shareCap * MICROS_PER_DOLLAR - key.othersCostMicros;
}

/** Whether OpenAI's `insufficient_quota` still has `key` out of budget at `now`. */
function spent(key: PoolKeyCandidate, now: Date): boolean {
  return key.spentUntil !== null && key.spentUntil.getTime() > now.getTime();
}

/** Whether a rate limit OpenAI answered, and the gateway could not wait out, still holds `key` at `now`. */
function throttled(key: PoolKeyCandidate, now: Date): boolean {
  return key.throttledUntil !== null && key.throttledUntil.getTime() > now.getTime();
}

/**
 * Whether a session of `requesterId` may run on `key` now: its contributor has it switched on, OpenAI has
 * neither refused it nor said it is out of budget nor rate-limited it past the gateway's own wait, and —
 * when it is somebody else's — the others have not spent its share cap this month.
 */
export function keyCanRun(key: PoolKeyCandidate, requesterId: string, now: Date): boolean {
  return key.enabled && key.state === 'ACTIVE' && !(key.pausedUntil && key.pausedUntil > now) && !spent(key, now) && !throttled(key, now) && keyRoom(key, requesterId) > 0;
}

/**
 * When `key` can run for `requesterId` again: `now` while it can; else the later of the reset OpenAI's
 * out-of-budget mark runs to, the mark a rate limit the gateway could not wait out left, and — for a cap
 * the others have spent — the first of next month, when caps count from zero. Null when waiting brings
 * nothing back: its contributor switched it off, or OpenAI refused or disabled it, and only a person can
 * change that.
 */
export function keyRunsAgainAt(key: PoolKeyCandidate, requesterId: string, now: Date): Date | null {
  if (!key.enabled || key.state !== 'ACTIVE') return null;
  let at = Math.max(now.getTime(), key.pausedUntil?.getTime() ?? 0);
  if (spent(key, now)) at = Math.max(at, key.spentUntil!.getTime());
  if (throttled(key, now)) at = Math.max(at, key.throttledUntil!.getTime());
  if (keyRoom(key, requesterId) <= 0) at = Math.max(at, nextUsageWindowStart(now).getTime());
  return new Date(at);
}

/**
 * When a session of `requesterId` can next run on one of `keys` — the pool's answer to "when does the
 * work held back on it resume", as pool-select.ts poolResumesAt is an account pool's: `now` while a key
 * can run, the earliest `keyRunsAgainAt` while every key is spent, and null when no key will come back by
 * waiting (none left, or each switched off or refused).
 */
export function poolKeysResumeAt(keys: readonly PoolKeyCandidate[], requesterId: string, now: Date): Date | null {
  const times = keys.flatMap((key) => {
    const at = keyRunsAgainAt(key, requesterId, now);
    return at ? [at.getTime()] : [];
  });
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

/**
 * The key a claim puts a session of `requesterId` on, by the rules providers/pool-select.ts chooses an
 * account pool's member by, for keys:
 *
 * - `stickyId`, the key the session already runs on, is kept while it can run, even when another has
 *   more room: moving keys gains nothing.
 * - Otherwise, with `ownKeyFirst`, a key of the requester's own that can run comes before everybody
 *   else's.
 * - Then the most room left (keyRoom), so a capped key is the last one taken.
 * - Equal room goes to the lower id, so the answer never depends on the order of the rows.
 *
 * Null when no key can run for this person: none is switched on, unrefused and in budget, or every one
 * that is belongs to somebody else and is spent to its cap.
 */
export function choosePoolKey<Key extends PoolKeyCandidate>(
  keys: readonly Key[],
  requesterId: string,
  ownKeyFirst: boolean,
  stickyId: string | null,
  now: Date,
): Key | null {
  const usable = keys.filter((key) => keyCanRun(key, requesterId, now));
  const sticky = usable.find((key) => key.id === stickyId);
  if (sticky) return sticky;
  const rank = (key: Key) => (ownKeyFirst && key.contributorId === requesterId ? 0 : 1);
  const byRoom = (a: Key, b: Key) => {
    const [left, right] = [keyRoom(a, requesterId), keyRoom(b, requesterId)];
    return left === right ? 0 : left > right ? -1 : 1;
  };
  return (
    [...usable].sort(
      (a, b) => rank(a) - rank(b) || byRoom(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0] ?? null
  );
}

/**
 * The transcript line for a session of `requesterId` moving onto key `to`, naming why it left the key it
 * ran on — the key twin of pool-select.ts poolSwitchNotice, in the same words where they mean the same
 * thing. `from` is null when that key is no longer in the pool.
 */
export function poolKeySwitchNotice(
  to: { label: string },
  from: (PoolKeyCandidate & { label: string }) | null,
  requesterId: string,
  now: Date,
): string {
  return `Switched to ${to.label} — ${from ? whyKeyLeft(from, requesterId, now) : 'the previous key is no longer in this pool'}`;
}

/** Refused first, since that one needs somebody to act; then out of budget, a spent cap as well as OpenAI's
 *  word; a key rate-limited past the gateway's own wait is none of those and says so. */
function whyKeyLeft(from: PoolKeyCandidate & { label: string }, requesterId: string, now: Date): string {
  if (from.state === 'INVALID') return `${from.label} was rejected by OpenAI`;
  if (!from.enabled || from.state === 'DISABLED') return `${from.label} is disabled`;
  if (from.pausedUntil && from.pausedUntil > now) return `${from.label} is paused`;
  if (spent(from, now) || keyRoom(from, requesterId) <= 0) return `${from.label} is out of budget`;
  if (throttled(from, now)) return `${from.label} is rate limited right now`;
  return `${from.label} is unavailable`;
}
