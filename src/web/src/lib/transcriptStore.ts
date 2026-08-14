/**
 * Persistent (L2) transcript cache, backed by IndexedDB.
 *
 * WorkspaceView already keeps an in-memory L1 (`transcriptCache`, a Map): switching back to a session
 * visited earlier in the same page load paints from it synchronously, in the same commit, with no
 * request at all. That Map dies on reload, so a refresh, a new tab, or coming back tomorrow re-pays
 * the whole tail page. This store is the same cache with a longer life — L1 stays exactly as it is
 * (IndexedDB is async and could not paint in that commit; replacing L1 with it would make the
 * fastest path slower), and this only fills the gap L1 leaves behind.
 *
 * What makes this safe enough to be worth doing: `run_event` is append-only and `seq` is unique and
 * monotonic, so a stored transcript can never disagree with the server — only fall behind. The SSE
 * already resumes from a cursor (`sessionEventsUrl(id, sinceSeq)`), so "read the highest stored seq,
 * resume the stream there" recovers the gap with no invalidation policy to get wrong. That is the
 * same contract L1 runs on; this changes the storage medium, not the semantics.
 *
 * Deliberately NOT persisted: the React Query control-plane reads (session list, workspaces, runners).
 * Those carry run status, unread and pending-approval counts — replaying them from disk trades one
 * ~58KB request for a window where the UI confidently shows an ended session as RUNNING.
 *
 * Every failure mode here degrades to a miss. A browser with IndexedDB disabled, a private window,
 * a quota eviction mid-write, a schema we don't recognise: all of them must land the caller back on
 * the network path it would have taken anyway, never on an error.
 */

const DB_NAME = 'orbit-transcript-v1';
const DB_VERSION = 1;
const EVENTS_STORE = 'events';
const SESSIONS_STORE = 'sessions';
const META_STORE = 'meta';
const USER_KEY = 'lastUserId';

/**
 * Sessions kept on disk, evicted least-recently-opened first. Fifty is far more than anyone
 * revisits between reloads, and bounds the store without needing byte accounting (which would
 * mean stringifying every payload just to measure it).
 */
export const MAX_STORED_SESSIONS = 50;

/**
 * Events kept per session. A tail page is 200; this leaves room for several "load earlier" pages
 * to survive a reload, while stopping one long-lived session from growing without bound. Trimming
 * keeps the NEWEST events and moves the older-pagination boundary with them, so what's left is a
 * contiguous window ending at the tail — never a hole.
 */
import { decodeId } from './idCodec';

export const MAX_STORED_EVENTS = 1000;

/** The subset of the web `RunEvent` that survives a structured clone unchanged. */
export interface StoredEvent {
  seq: number;
  type: string;
  payload: unknown;
  turnId?: string | null;
  ts?: string;
  truncated?: boolean;
}

/** One session's stored window — mirrors WorkspaceView's TranscriptCacheEntry. */
export interface TranscriptSnapshot {
  events: StoredEvent[];
  /** seq of the earliest stored event (null = nothing stored). */
  oldestSeq: number | null;
  /** Older events exist before `oldestSeq` on the server. */
  hasMoreOlder: boolean;
}

/** The contiguous seq range already written for a session, so a flush only writes what's new. */
export interface WrittenRange {
  min: number;
  max: number;
}

// ── Pure policy (exported for tests) ────────────────────────────────────────────────────────

/**
 * Which of `events` still need writing, given what has already been written for this session.
 *
 * Both ends matter: the SSE appends above `max`, and "load earlier" prepends below `min`. A
 * high-water mark alone would silently drop every page the user scrolled back through.
 */
export function eventsToPersist(
  events: StoredEvent[],
  written: WrittenRange | null,
): StoredEvent[] {
  if (!written) return events;
  return events.filter((e) => e.seq < written.min || e.seq > written.max);
}

/** The seq range spanned by `events`, or null when there are none. */
export function rangeOf(events: StoredEvent[]): WrittenRange | null {
  if (events.length === 0) return null;
  let min = events[0].seq;
  let max = events[0].seq;
  for (const e of events) {
    if (e.seq < min) min = e.seq;
    if (e.seq > max) max = e.seq;
  }
  return { min, max };
}

/**
 * Cap a snapshot at `limit` events, keeping the newest.
 *
 * Trimming has to move `oldestSeq` up to whatever is actually kept and force `hasMoreOlder` on,
 * or a reload would think it already held the start of the conversation and "load earlier" would
 * never fetch the events the trim just dropped — a hole the user could not scroll past.
 */
export function trimForStorage(
  snapshot: TranscriptSnapshot,
  limit: number = MAX_STORED_EVENTS,
): TranscriptSnapshot {
  const sorted = [...snapshot.events].sort((a, b) => a.seq - b.seq);
  if (sorted.length <= limit) {
    return { events: sorted, oldestSeq: snapshot.oldestSeq, hasMoreOlder: snapshot.hasMoreOlder };
  }
  const kept = sorted.slice(-limit);
  return { events: kept, oldestSeq: kept[0].seq, hasMoreOlder: true };
}

/**
 * Every key this store writes is the UUID spelling, whatever spelling the caller happens to be
 * holding.
 *
 * The server is moving to base62 public ids on the wire (docs/public-id-migration-design.md), which
 * makes the id a caller has a moving target. A cache keyed by whichever spelling was current when
 * a row was written would orphan every transcript stored before the switch: the tab refetches the
 * whole tail, and the user reports "it got slower after the update" with no failing request behind
 * it to find. Normalizing here rather than at each call site is what makes that impossible — a
 * caller cannot key this store wrong by not having thought about it.
 *
 * Total by construction: an id that decodes to neither spelling is used as-is, because a cache
 * miss is a survivable outcome and a throw on the boot path is not.
 */
export const storageKey = (id: string): string => decodeId(id) ?? id;

/** Session ids to drop, least-recently-opened first, so at most `max` remain. */
export function sessionsToEvict(
  rows: { sessionId: string; lastOpenedAt: number }[],
  max: number = MAX_STORED_SESSIONS,
): string[] {
  if (rows.length <= max) return [];
  return [...rows]
    .sort((a, b) => a.lastOpenedAt - b.lastOpenedAt)
    .slice(0, rows.length - max)
    .map((r) => r.sessionId);
}

// ── IndexedDB plumbing ──────────────────────────────────────────────────────────────────────

let userId: string | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;
/** Per-session ranges already on disk this page load — the diff basis for eventsToPersist. */
const written = new Map<string, WrittenRange>();
/** Snapshots waiting for the next idle flush, newest wins. */
const pending = new Map<string, TranscriptSnapshot>();
let flushHandle: ReturnType<typeof setTimeout> | null = null;

/**
 * Bind the store to the signed-in user, or disable it entirely with null. Every key is prefixed
 * with this id, so a second account on the same browser cannot read the first one's transcripts
 * even before the wipe below runs.
 */
export function setTranscriptUser(raw: string | null): void {
  // Normalized BEFORE the equality check: the same user arriving in the other spelling must read
  // as the same user, or every switch would close the connection and drop the derived state.
  const id = raw === null ? null : storageKey(raw);
  if (id === userId) return;
  userId = id;
  // The previous user's derived state must not survive into this one's session.
  written.clear();
  pending.clear();
  const previous = dbPromise;
  dbPromise = null;
  // Close the handle rather than just dropping it: a leaked connection would block any later
  // deleteDatabase (the sign-out wipe) for the lifetime of the tab.
  if (previous) void previous.then((db) => db?.close()).catch(() => undefined);
}

function idb(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null; // some privacy modes throw on access rather than returning undefined
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const factory = idb();
  if (!factory || !userId) return Promise.resolve(null);
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EVENTS_STORE)) {
        const store = db.createObjectStore(EVENTS_STORE, { keyPath: ['userId', 'sessionId', 'seq'] });
        store.createIndex('bySession', ['userId', 'sessionId']);
      }
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        const store = db.createObjectStore(SESSIONS_STORE, { keyPath: ['userId', 'sessionId'] });
        store.createIndex('byUser', 'userId');
      }
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null); // another tab holds an old version open
    req.onsuccess = () => {
      const db = req.result;
      // A quota eviction or a browser-side close must not leave a dead handle cached.
      db.onclose = () => {
        dbPromise = null;
      };
      void wipeIfUserChanged(db).then(() => resolve(db));
    };
  }).catch(() => null);
  return dbPromise;
}

/**
 * Clear everything when the signed-in user differs from the one the store was last written for.
 *
 * The keys are already user-scoped, so this isn't about correctness — it's so switching accounts
 * on a shared browser doesn't leave the previous person's conversations sitting on the disk.
 * Signing out wipes the whole database (see clearTranscriptStore); this covers the path where the
 * token is simply replaced by another user's without a sign-out in between.
 */
async function wipeIfUserChanged(db: IDBDatabase): Promise<void> {
  try {
    const tx = db.transaction([META_STORE], 'readonly');
    const last = await request<string | undefined>(tx.objectStore(META_STORE).get(USER_KEY));
    if (last === userId) return;
    const clear = db.transaction([EVENTS_STORE, SESSIONS_STORE, META_STORE], 'readwrite');
    clear.objectStore(EVENTS_STORE).clear();
    clear.objectStore(SESSIONS_STORE).clear();
    clear.objectStore(META_STORE).put(userId, USER_KEY);
    await new Promise<void>((resolve) => {
      clear.oncomplete = () => resolve();
      clear.onerror = () => resolve();
      clear.onabort = () => resolve();
    });
  } catch {
    // Leave the store as-is; a failed wipe must not stop the app from booting.
  }
}

/**
 * The stored window for a session, or null on any miss — no entry, no store, a read that threw.
 * Callers treat null as "not cached" and fall through to the network.
 */
export async function loadTranscript(id: string): Promise<TranscriptSnapshot | null> {
  const sessionId = storageKey(id);
  try {
    const db = await openDb();
    if (!db || !userId) return null;
    // Both requests are issued against the transaction before anything is awaited. An IndexedDB
    // transaction goes inactive at the first microtask checkpoint, so awaiting the first one and
    // then touching `tx` again would throw TransactionInactiveError.
    const tx = db.transaction([EVENTS_STORE, SESSIONS_STORE], 'readonly');
    const metaReq = request<{ oldestSeq: number | null; hasMoreOlder: boolean } | undefined>(
      tx.objectStore(SESSIONS_STORE).get([userId, sessionId]),
    );
    const rowsReq = request<(StoredEvent & { userId: string; sessionId: string })[]>(
      tx.objectStore(EVENTS_STORE).index('bySession').getAll(IDBKeyRange.only([userId, sessionId])),
    );
    const [meta, rows] = await Promise.all([metaReq, rowsReq]);
    if (!meta || rows.length === 0) return null;
    const events: StoredEvent[] = rows
      .map(({ seq, type, payload, turnId, ts, truncated }) => ({
        seq,
        type,
        payload,
        turnId,
        ts,
        // Preserved deliberately: a payload stored while clipped to a preview must still know to
        // refetch itself whole when the card is expanded (see EventFullCtx).
        truncated,
      }))
      .sort((a, b) => a.seq - b.seq);
    const range = rangeOf(events);
    if (range) written.set(sessionId, range);
    return { events, oldestSeq: meta.oldestSeq, hasMoreOlder: meta.hasMoreOlder };
  } catch {
    return null;
  }
}

/**
 * Queue a session's current window for persistence. Returns immediately: this is called from the
 * SSE handler on every appended event, so the write is batched into an idle callback instead of
 * opening a transaction per token. Losing the last few events to a closed tab costs nothing — the
 * stream resumes from the highest stored seq and replays them.
 */
export function saveTranscript(id: string, snapshot: TranscriptSnapshot): void {
  if (!userId || !idb()) return;
  pending.set(storageKey(id), snapshot);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushHandle !== null) return;
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
    .requestIdleCallback;
  if (idle) {
    // The cast keeps the two handle types interchangeable for cancellation; we never cancel, so
    // only the "already scheduled" check reads it.
    flushHandle = idle(() => {
      flushHandle = null;
      void flush();
    }, { timeout: 2000 }) as unknown as ReturnType<typeof setTimeout>;
    return;
  }
  flushHandle = setTimeout(() => {
    flushHandle = null;
    void flush();
  }, 1000);
}

async function flush(): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();
  try {
    const db = await openDb();
    if (!db || !userId) return;
    const uid = userId;
    const tx = db.transaction([EVENTS_STORE, SESSIONS_STORE], 'readwrite');
    const events = tx.objectStore(EVENTS_STORE);
    const sessions = tx.objectStore(SESSIONS_STORE);
    for (const [sessionId, raw] of batch) {
      const snapshot = trimForStorage(raw);
      // Drop anything older than the window we mean to keep. Without this the per-session cap
      // would not hold: trimming only decides what gets *written*, so rows persisted before the
      // session outgrew the cap would stay on disk and come back on the next getAll — a window
      // wider than `oldestSeq` claims, which is the one thing the pagination boundary must not lie
      // about. A no-op in the common case, where nothing has been trimmed away.
      if (snapshot.oldestSeq != null) {
        events.delete(
          IDBKeyRange.bound([uid, sessionId, -Infinity], [uid, sessionId, snapshot.oldestSeq], false, true),
        );
      }
      // `put`, not `add`: two tabs streaming the same session write the same (session, seq) rows,
      // and rewriting one identically is the correct outcome.
      for (const e of eventsToPersist(snapshot.events, written.get(sessionId) ?? null)) {
        events.put({ ...e, userId: uid, sessionId });
      }
      const range = rangeOf(snapshot.events);
      if (range) written.set(sessionId, range);
      sessions.put({
        userId: uid,
        sessionId,
        oldestSeq: snapshot.oldestSeq,
        hasMoreOlder: snapshot.hasMoreOlder,
        lastOpenedAt: Date.now(),
      });
    }
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
    await evict(db, uid);
  } catch {
    // A failed write is a future cache miss, nothing more.
  }
}

/** Drop the least-recently-opened sessions once the store is over MAX_STORED_SESSIONS. */
async function evict(db: IDBDatabase, uid: string): Promise<void> {
  try {
    const read = db.transaction([SESSIONS_STORE], 'readonly');
    const rows = await request<{ sessionId: string; lastOpenedAt: number }[]>(
      read.objectStore(SESSIONS_STORE).index('byUser').getAll(IDBKeyRange.only(uid)),
    );
    const doomed = sessionsToEvict(rows);
    if (doomed.length === 0) return;
    const tx = db.transaction([EVENTS_STORE, SESSIONS_STORE], 'readwrite');
    for (const sessionId of doomed) {
      tx.objectStore(SESSIONS_STORE).delete([uid, sessionId]);
      tx.objectStore(EVENTS_STORE).delete(
        IDBKeyRange.bound([uid, sessionId, -Infinity], [uid, sessionId, Infinity]),
      );
      written.delete(sessionId);
    }
  } catch {
    // Over quota is self-correcting — the browser evicts the whole store before we would.
  }
}

/**
 * Delete everything, called on sign-out. This is a privacy boundary, not a cache concern: without
 * it, signing out of a shared browser leaves the full text of every conversation readable on disk.
 */
export function clearTranscriptStore(): void {
  written.clear();
  pending.clear();
  const factory = idb();
  const previous = dbPromise;
  dbPromise = null;
  userId = null;
  if (!factory) return;
  const drop = (): void => {
    try {
      const req = factory.deleteDatabase(DB_NAME);
      // Another tab still holds the database open. It will be deleted once that tab lets go;
      // meanwhile this tab's keys are already unreachable (userId is null), so there is nothing
      // to wait for and nothing more to do.
      req.onblocked = () => undefined;
    } catch {
      // Nothing else to try; the next sign-in's user check wipes the contents instead.
    }
  };
  // Our own open connection blocks the delete indefinitely, and the next open() would then queue
  // behind it forever — sign out, sign back in, and the store would hang rather than miss. Close
  // first, then delete.
  if (previous) void previous.then((db) => db?.close()).then(drop, drop);
  else drop();
}
