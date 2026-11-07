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
 * A read that builds pays the full read's database cost; what the delta saves there is the wire,
 * the decode and the client's per-poll rework. A snapshot also keeps the data version read before
 * its rows were built, and a read that finds that version still standing is answered with an empty
 * delta without building anything (`unchanged`).
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
  /** The scoped data version (`openListEtag`) read before these rows were built, if the read had one. */
  version?: string;
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
    /** What of a row counts as a change; the whole row unless the caller says otherwise. */
    fingerprint: (row: T) => unknown = (row) => row,
    /** The version read before `rows` were built, which `unchanged` compares the next read's with. */
    version?: string,
  ): OpenListDelta<T> {
    const now = this.now();
    this.sweep(now);
    const order = rows.map((row) => row.id);
    const hashes = new Map(rows.map((row) => [row.id, hashRow(fingerprint(row))]));
    const cursor = cursorOf(scope, order, hashes);

    let snapshots = this.owners.get(ownerId);
    const usable = this.held(snapshots, scope, since, now);

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
    // A device on the same list may have recorded another version under this cursor. Each was read
    // before its own build of these same rows, so either is safe to keep; this read's replaces it.
    snapshots.delete(cursor);
    snapshots.set(cursor, { scope, order, hashes, version, usedAt: now });
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

  /**
   * Whether the list `since` names still stands: its snapshot is held for this owner and scope and
   * was built at `version`, which the caller read just now, before building anything. The caller
   * then answers an empty delta under the same cursor and builds nothing. The stored version was
   * read before the snapshot's rows were built, so it can lag them (one more build later) but never
   * cover a write they miss. A hit marks the snapshot used, as a read marks its base, so a list
   * that stays unchanged keeps its cursor past the TTL.
   */
  unchanged(ownerId: string, scope: string, since: string, version: string): boolean {
    const now = this.now();
    this.sweep(now);
    const snapshots = this.owners.get(ownerId);
    const base = this.held(snapshots, scope, since, now);
    if (!snapshots || !base || base.version !== version) return false;
    snapshots.delete(since);
    base.usedAt = now;
    snapshots.set(since, base);
    return true;
  }

  /** The snapshot `since` names, if it is this scope's and has not expired. */
  private held(snapshots: Map<string, Snapshot> | undefined, scope: string, since: string | undefined, now: number) {
    const base = since ? snapshots?.get(since) : undefined;
    return base && base.scope === scope && now - base.usedAt <= this.ttlMs ? base : undefined;
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
