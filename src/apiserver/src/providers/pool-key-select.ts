/** A share cap is whole US dollars; the ledger counts millionths of one. */
const MICROS_PER_DOLLAR = 1_000_000;

/** What choosing reads of one key of a shared pool (migration 0320). */
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
}

/**
 * What `key` has left for a session of `requesterId` this month, in millionths of a dollar. All of it on
 * a key of their own — the contributor's own use is never capped — and on a key with no cap.
 */
export function keyRoom(key: PoolKeyCandidate, requesterId: string): number {
  if (key.contributorId === requesterId || key.shareCap === null) return Number.POSITIVE_INFINITY;
  return key.shareCap * MICROS_PER_DOLLAR - key.othersCostMicros;
}

/**
 * Whether a session of `requesterId` may run on `key` now: its contributor has it switched on, OpenAI has
 * not refused it, and — when it is somebody else's — the others have not spent its share cap this month.
 */
export function keyCanRun(key: PoolKeyCandidate, requesterId: string): boolean {
  return key.enabled && key.state === 'ACTIVE' && keyRoom(key, requesterId) > 0;
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
 * Null when no key can run for this person: none is switched on and unrefused, or every one that is
 * belongs to somebody else and is spent to its cap.
 */
export function choosePoolKey<Key extends PoolKeyCandidate>(
  keys: readonly Key[],
  requesterId: string,
  ownKeyFirst: boolean,
  stickyId: string | null,
): Key | null {
  const usable = keys.filter((key) => keyCanRun(key, requesterId));
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
