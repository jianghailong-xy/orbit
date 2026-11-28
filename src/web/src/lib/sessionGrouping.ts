// Session-list sectioning for the workspace console, mirroring the native `SessionTimeGrouping` /
// `SessionTagGrouping` (OrbitKit) and Android's `directoryGroups`: all three are held to
// contracts/session-list-order.fixtures.json. The time sections order each section by listedAt
// themselves, except where the caller keeps the server's order (Completed, the landings window).

import { sessionPhaseOf, sessionRunStateOf } from './sessionState';

/** A tag as the session list payload carries it (server-ordered: system first, then position). */
export interface SessionTagRef {
  id: string;
  name: string;
  color: string;
  isSystem: boolean;
  position: number;
}

export interface GroupableSession {
  id: string;
  // Set while the session is pinned to the top of the Open list.
  pinnedAt?: string | null;
  createdAt?: string | null;
  /** The order key: moves only when the session changes for its owner (contracts/session-list-order.fixtures.json). */
  listedAt?: string | null;
  /** Liveness clock. Never an order key; it moves with every streamed event. */
  lastTurnAt?: string | null;
  status?: string | null;
  runStatus?: string | null;
  pendingApprovals?: number | null;
  retryAt?: string | null;
  /** A project row's own roll-up of its members (the row has no status of its own). */
  needsYou?: boolean;
  running?: boolean;
  /** The session facts' three-state field (contracts/session-state.contract.json); absent from an older control plane. */
  phase?: string | null;
  released?: boolean | null;
  lastTurnOutcome?: string | null;
  endReason?: string | null;
  tags?: SessionTagRef[] | null;
}

export interface SessionTimeSection<T> {
  title: string;
  sessions: T[];
}

// Fixed bucket order; the titles double as the rendered section headers. Kept verbatim in sync
// with the Swift `SessionTimeGrouping.titles`.
const TIME_TITLES = ['Today', 'Yesterday', '2–7 days ago', '8–30 days ago', 'Older'];

/** Local-midnight of `d`, matching Swift's `Calendar.current.startOfDay` (also local). */
const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * 0 Today · 1 Yesterday · 2 2–7 days ago · 3 8–30 days ago · 4 Older, by the *calendar day*
 * of `listedAt ?? createdAt`. A future timestamp (clock skew) reads as Today; a missing or
 * unparseable one falls to Older. Rounding the day delta absorbs the ±1h a DST change puts into
 * the midnight-to-midnight span, so the bucket stays a true calendar-day count.
 */
const listedTime = (s: GroupableSession): number => {
  const iso = s.listedAt ?? s.createdAt;
  return iso ? new Date(iso).getTime() : Number.NaN;
};

const createdTime = (s: GroupableSession): number => {
  const t = s.createdAt ? new Date(s.createdAt).getTime() : Number.NaN;
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

/** When a row was listed: the instant its place and its time both come from (contracts/session-list-order.fixtures.json). */
export const sessionListedAt = (s: GroupableSession): string | null => s.listedAt ?? s.createdAt ?? null;

/** How long a turn has run, as the row's time while its spinner shows: "45s", "12m", "3h", "2d" (OrbitKit
 *  `RelativeTime.elapsed`, Android `TaskTime.elapsed`). */
export const sessionElapsed = (iso: string, now: number = Date.now()): string => {
  const diff = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86_400)}d`;
};

/** A failure by the state word's own rule when the session facts are present (a release is a failure only when the
 *  last turn failed and nobody asked for an end); by the legacy status from an older control plane. */
const sessionFailed = (s: GroupableSession): boolean =>
  sessionPhaseOf(s) && typeof s.released === 'boolean'
    ? sessionRunStateOf(s) === 'FAILED'
    : (s.status ?? s.runStatus) === 'FAILED';

/** Needs you: an approval, question or owner decision is waiting, or a failure no retry is armed for. */
export const sessionNeedsOwner = (s: GroupableSession): boolean =>
  (s.pendingApprovals ?? 0) > 0 || s.needsYou === true || (sessionFailed(s) && !s.retryAt);

/** Working: running or queued, or a failure the server is retrying. With the session facts, phase RUNNING (a turn
 *  or work outside one, such as a background job) or PENDING decides; without them (an older control plane) the
 *  run status does. */
export const sessionIsWorking = (s: GroupableSession): boolean => {
  const status = s.status ?? s.runStatus;
  const phase = sessionPhaseOf(s);
  const inFlight = phase ? phase === 'RUNNING' || phase === 'PENDING' : status === 'RUNNING' || status === 'PENDING';
  return s.running === true || inFlight || (status === 'FAILED' && !!s.retryAt);
};

/** listedAt descending (createdAt when null), then createdAt descending, then id ascending. */
export const compareListed = (a: GroupableSession, b: GroupableSession): number => {
  const la = Number.isNaN(listedTime(a)) ? Number.NEGATIVE_INFINITY : listedTime(a);
  const lb = Number.isNaN(listedTime(b)) ? Number.NEGATIVE_INFINITY : listedTime(b);
  if (la !== lb) return la > lb ? -1 : 1;
  const ca = createdTime(a);
  const cb = createdTime(b);
  if (ca !== cb) return ca > cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const bucketIndex = (s: GroupableSession, today: number): number => {
  const t = listedTime(s);
  if (Number.isNaN(t)) return 4;
  const days = Math.round((today - startOfDay(new Date(t))) / 86_400_000);
  if (days <= 0) return 0;
  if (days === 1) return 1;
  if (days <= 7) return 2;
  if (days <= 30) return 3;
  return 4;
};

/** The section options a list view draws with (contracts/session-list-order.fixtures.json): Pinned only in Open with
 *  no tag filter, Needs you and Working in Open, and every view but Completed ordered by listedAt. */
export const sessionListSectionOptions = (view: string, tagFiltered: boolean) => ({
  pinnedFirst: view === 'open' && !tagFiltered,
  attention: view === 'open',
  keepOrder: view === 'completed',
});

/**
 * Bucket sessions into the list's sections. When `pinnedFirst` (the Open view, where pinning
 * applies), pinned sessions lead in a "Pinned" section. When `attention`, the rest go to "Needs you",
 * then "Working", then a calendar-day bucket by `listedAt ?? createdAt`. Each section is ordered by
 * listedAt, so streamed activity (lastTurnAt) never moves a row and a pin counts only in Pinned; with
 * `keepOrder` (Completed, and the landings window; the default without `attention`) the given order
 * is kept. Empty sections are dropped. `now` is injectable.
 */
export function sessionTimeSections<T extends GroupableSession>(
  sessions: readonly T[],
  opts: { pinnedFirst?: boolean; attention?: boolean; keepOrder?: boolean; now?: Date } = {},
): SessionTimeSection<T>[] {
  const { pinnedFirst = true, attention = false, now = new Date() } = opts;
  const keepOrder = opts.keepOrder ?? !attention;
  const pinned: T[] = [];
  const needs: T[] = [];
  const working: T[] = [];
  const buckets: T[][] = [[], [], [], [], []];
  const today = startOfDay(now);

  for (const s of sessions) {
    // Only the Open view honours pins; elsewhere a (possibly stale) pinnedAt just buckets by
    // time like any other session, so no "Pinned" section appears in Completed/Trash.
    if (pinnedFirst && s.pinnedAt) pinned.push(s);
    else if (attention && sessionNeedsOwner(s)) needs.push(s);
    else if (attention && sessionIsWorking(s)) working.push(s);
    else buckets[bucketIndex(s, today)].push(s);
  }

  const ordered = (items: T[]): T[] => (keepOrder ? items : [...items].sort(compareListed));
  const out: SessionTimeSection<T>[] = [];
  const push = (title: string, items: T[]) => {
    if (items.length) out.push({ title, sessions: ordered(items) });
  };
  push('Pinned', pinned);
  push('Needs you', needs);
  push('Working', working);
  buckets.forEach((items, i) => push(TIME_TITLES[i], items));
  return out;
}

export interface SessionTagSection<T> {
  // The tag heading; null for the trailing "Untagged" bucket.
  tag: SessionTagRef | null;
  sessions: T[];
}

/**
 * Bucket a console-sorted list by each session's *primary* tag — the first entry in its
 * server-ordered `tags` (system first, lowest position) — into one section per tag, ordered as the
 * tag library is (system first, then position, then name). A multi-tag session appears once, under
 * its primary tag (the same divergence from Files.app the native list makes: one row per id keeps
 * selection unambiguous). Untagged sessions fall to a trailing section; order within each is kept.
 */
export function sessionTagSections<T extends GroupableSession>(
  sessions: readonly T[],
): SessionTagSection<T>[] {
  const groups = new Map<string, { tag: SessionTagRef; sessions: T[] }>();
  const untagged: T[] = [];
  for (const s of sessions) {
    const primary = s.tags?.[0];
    if (!primary) {
      untagged.push(s);
      continue;
    }
    let g = groups.get(primary.id);
    if (!g) {
      g = { tag: primary, sessions: [] };
      groups.set(primary.id, g);
    }
    g.sessions.push(s);
  }

  const out: SessionTagSection<T>[] = [...groups.values()]
    .sort((a, b) => {
      if (a.tag.isSystem !== b.tag.isSystem) return a.tag.isSystem ? -1 : 1;
      if (a.tag.position !== b.tag.position) return a.tag.position - b.tag.position;
      return a.tag.name < b.tag.name ? -1 : 1;
    })
    .map((g) => ({ tag: g.tag, sessions: g.sessions }));
  if (untagged.length) out.push({ tag: null, sessions: untagged });
  return out;
}

/** The sessions carrying `tagId` (the list's tag filter). */
export function sessionsWithTag<T extends GroupableSession>(
  sessions: readonly T[],
  tagId: string,
): T[] {
  return sessions.filter((s) => (s.tags ?? []).some((t) => t.id === tagId));
}
