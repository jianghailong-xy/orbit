// Session-list sectioning for the agent console, mirroring the native `SessionTimeGrouping` /
// `SessionTagGrouping` (OrbitKit) so the web list and the iOS drawer render the same shape from the
// same server-sorted input. Both groupers are pure and take an already console-sorted list
// (pinned-first, then most-recent activity) — they only bucket, never reorder within a bucket.

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
  // Set while the session is pinned to the top of the Active list.
  pinnedAt?: string | null;
  createdAt?: string | null;
  lastTurnAt?: string | null;
  tags?: SessionTagRef[] | null;
}

export interface SessionTimeSection<T> {
  title: string;
  sessions: T[];
}

// Fixed bucket order; the titles double as the rendered section headers. Kept verbatim in sync
// with the Swift `SessionTimeGrouping.titles`.
const TIME_TITLES = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];

/** Local-midnight of `d`, matching Swift's `Calendar.current.startOfDay` (also local). */
const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * 0 Today · 1 Yesterday · 2 Previous 7 Days · 3 Previous 30 Days · 4 Older, by the *calendar day*
 * of `lastTurnAt ?? createdAt`. A future timestamp (clock skew) reads as Today; a missing or
 * unparseable one falls to Older. Rounding the day delta absorbs the ±1h a DST change puts into
 * the midnight-to-midnight span, so the bucket stays a true calendar-day count.
 */
const bucketIndex = (s: GroupableSession, today: number): number => {
  const iso = s.lastTurnAt ?? s.createdAt;
  if (!iso) return 4;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 4;
  const days = Math.round((today - startOfDay(new Date(t))) / 86_400_000);
  if (days <= 0) return 0;
  if (days === 1) return 1;
  if (days <= 7) return 2;
  if (days <= 30) return 3;
  return 4;
};

/**
 * Bucket a console-sorted list into the recency sections. When `pinnedFirst` (the Active view,
 * where pinning applies), pinned sessions are lifted into a leading "Pinned" section in their given
 * order; every other session buckets by calendar day. Order within each bucket is preserved (so
 * recency still holds) and empty buckets are dropped. `now` is injectable for deterministic tests.
 */
export function sessionTimeSections<T extends GroupableSession>(
  sessions: readonly T[],
  opts: { pinnedFirst?: boolean; now?: Date } = {},
): SessionTimeSection<T>[] {
  const { pinnedFirst = true, now = new Date() } = opts;
  const pinned: T[] = [];
  const buckets: T[][] = [[], [], [], [], []];
  const today = startOfDay(now);

  for (const s of sessions) {
    // Only the Active view honours pins; elsewhere a (possibly stale) pinnedAt just buckets by
    // time like any other session, so no "Pinned" section appears in Completed/System/Trash.
    if (pinnedFirst && s.pinnedAt) pinned.push(s);
    else buckets[bucketIndex(s, today)].push(s);
  }

  const out: SessionTimeSection<T>[] = [];
  if (pinned.length) out.push({ title: 'Pinned', sessions: pinned });
  buckets.forEach((items, i) => {
    if (items.length) out.push({ title: TIME_TITLES[i], sessions: items });
  });
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
