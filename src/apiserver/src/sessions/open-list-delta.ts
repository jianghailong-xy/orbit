import { createHash } from 'node:crypto';

/**
 * The Open list as a delta against a list the caller already holds (`GET /sessions?view=open&since=`).
 *
 * The native clients poll the Open list every few seconds, and while anything on the account is
 * running it changes between almost every two polls, so the ETag/304 never matches and each poll
 * downloads the whole list (~1.5 MB for a few hundred sessions) to learn that one row moved.
 *
 * A row is far more than the `session` table: runner liveness, tags, the queue gate, the share
 * globe, approvals and background-job freshness are joined or derived at read time, some of them
 * from `now`. No column-level clock can say which rows moved, so the delta is taken where the list
 * is already whole — on the mapped rows, by content. A cursor names a snapshot of what the caller
 * was last sent (each row's content hash, and the order); the next read is the same full query,
 * answered with only the rows whose hash moved, the ids that left, and the order when it changed.
 * The database cost is the full read's; what this saves is the wire, the decode and the client's
 * per-poll rework.
 *
 * Snapshots live in this process only. A cursor this process does not hold — too old, evicted,
 * issued before a restart, or for another scope — is answered with the whole list (`full: true`)
 * and a fresh cursor, so a client can always recover by doing exactly what it did before.
 *
 * The cursor is the snapshot's own content hash, so devices on one account that hold the same list
 * hold the same cursor and share one snapshot instead of filling the owner's slots with copies.
 */
export type OpenListDelta<T> =
  | { full: true; sessions: T[]; cursor: string }
  | {
      full: false;
      upserts: T[];
      removedIds: string[];
      /** Every id, in list order — present only when the order differs from the cursor's. */
      order?: string[];
      cursor: string;
    };

type Snapshot = {
  scope: string;
  order: string[];
  hashes: Map<string, string>;
  usedAt: number;
};

export class OpenListDeltaStore {
  /** ownerId → cursor → snapshot, each inner map kept in least-recently-used order. */
  private readonly owners = new Map<string, Map<string, Snapshot>>();
  private readonly perOwner: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(opts: { perOwner?: number; ttlMs?: number; now?: () => number } = {}) {
    // A handful of devices per account, each a cursor or two behind the newest.
    this.perOwner = opts.perOwner ?? 16;
    // Well past a backgrounded app's poll gap; a client back after longer gets one full read.
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  answer<T extends { id: string }>(
    ownerId: string,
    scope: string,
    rows: T[],
    since: string | undefined,
  ): OpenListDelta<T> {
    const now = this.now();
    this.sweep(now);
    const order = rows.map((row) => row.id);
    const hashes = new Map(rows.map((row) => [row.id, hashRow(row)]));
    const cursor = cursorOf(scope, order, hashes);

    let snapshots = this.owners.get(ownerId);
    const base = since ? snapshots?.get(since) : undefined;
    const usable = base && base.scope === scope && now - base.usedAt <= this.ttlMs ? base : undefined;

    if (!snapshots) {
      snapshots = new Map();
      this.owners.set(ownerId, snapshots);
    }
    // Re-insert to mark both as recently used. The base stays too: a client whose response was
    // lost retries with the same cursor, and a second device may still be on it.
    if (usable) {
      snapshots.delete(since!);
      usable.usedAt = now;
      snapshots.set(since!, usable);
    }
    snapshots.delete(cursor);
    snapshots.set(cursor, { scope, order, hashes, usedAt: now });
    while (snapshots.size > this.perOwner) snapshots.delete(snapshots.keys().next().value!);

    if (!usable) return { full: true, sessions: rows, cursor };

    const upserts = rows.filter((row) => usable.hashes.get(row.id) !== hashes.get(row.id));
    const removedIds = usable.order.filter((id) => !hashes.has(id));
    const sameOrder =
      usable.order.length === order.length && usable.order.every((id, i) => id === order[i]);
    return sameOrder
      ? { full: false, upserts, removedIds, cursor }
      : { full: false, upserts, removedIds, order, cursor };
  }

  /** Drop expired snapshots, and owners left with none — at most once a minute. */
  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [ownerId, snapshots] of this.owners) {
      for (const [cursor, snapshot] of snapshots) {
        if (now - snapshot.usedAt > this.ttlMs) snapshots.delete(cursor);
      }
      if (snapshots.size === 0) this.owners.delete(ownerId);
    }
  }
}

function hashRow(row: unknown): string {
  return createHash('sha1').update(JSON.stringify(row)).digest('base64');
}

function cursorOf(scope: string, order: string[], hashes: Map<string, string>): string {
  const h = createHash('sha256').update(scope);
  for (const id of order) h.update(`\n${id}:${hashes.get(id)}`);
  return h.digest('base64url').slice(0, 22);
}
