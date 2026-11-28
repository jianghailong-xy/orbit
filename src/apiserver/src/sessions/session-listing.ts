import { BadRequestException } from '@nestjs/common';
import { base62ToUuid, SESSION_PHASES, uuidToBase62 } from '@orbit/shared';

/**
 * `GET /sessions/listing` (docs/session-list-scale-design.md §3.2): one workspace's session list as
 * top-level entries, one page at a time, with its folder rows' tallies. The rules are the web's —
 * `sessionProjectListing` (src/web/src/lib/sessionProjects.ts) and `sessionFolderListing`
 * (lib/sessionFolders.ts) — moved here so a client no longer reads the whole list to group it, and
 * contracts/session-listing.fixtures.json holds both sides to the same answers.
 *
 * Pure: SessionsService.sessionListing reads the inputs and builds the rows of the page it cuts.
 */

export type ListingView = 'open' | 'completed';

/** One session in the list's scope, as narrow as the rules need. */
export interface ListingSession {
  id: string;
  folderId: string | null;
  pinnedAt: Date | null;
  listedAt: Date | null;
  createdAt: Date;
  lastTurnAt: Date | null;
  /** COALESCE(completed_at, archived_at): what GET /sessions?view=completed orders by. */
  completedAt: Date | null;
  /** The project its membership names (any role), or null. */
  projectId: string | null;
  /** What its list row says, which places it in the Open view's attention sections (`listingRowNeedsOwner`,
   *  `listingRowIsWorking`); absent, it is in neither. */
  row?: ListingRowFacts | null;
}

/**
 * The fields of a session's list row (GET /sessions) that the web's attention sections read: `sessionNeedsOwner`
 * and `sessionIsWorking` in src/web/src/lib/sessionGrouping.ts, whose rules are ported here as they stand.
 */
export interface ListingRowFacts {
  pendingApprovals?: number | null;
  /** The row's status word (legacySessionStatus). */
  status?: string | null;
  retryAt?: Date | string | null;
  phase?: string | null;
  released?: boolean | null;
  lastTurnOutcome?: string | null;
  endReason?: string | null;
}

const knownPhase = (phase: string | null | undefined): string | null =>
  typeof phase === 'string' && (SESSION_PHASES as readonly string[]).includes(phase) ? phase : null;

/** `sessionFailed`: with the phase fields, a release by a failed turn nobody asked to end; else the status word. */
const rowFailed = (row: ListingRowFacts): boolean =>
  knownPhase(row.phase) && typeof row.released === 'boolean'
    ? row.released && !row.endReason && row.lastTurnOutcome === 'FAILED'
    : row.status === 'FAILED';

/** `sessionNeedsOwner`: an approval, question or owner decision is waiting, or a failure no retry is armed for. */
export const listingRowNeedsOwner = (row: ListingRowFacts): boolean =>
  (row.pendingApprovals ?? 0) > 0 || (rowFailed(row) && !row.retryAt);

/** `sessionIsWorking`: phase RUNNING or PENDING (the status word without the phase fields), or a failure the server
 *  is retrying. */
export const listingRowIsWorking = (row: ListingRowFacts): boolean => {
  const phase = knownPhase(row.phase);
  const inFlight = phase ? phase === 'RUNNING' || phase === 'PENDING' : row.status === 'RUNNING' || row.status === 'PENDING';
  return inFlight || (row.status === 'FAILED' && !!row.retryAt);
};

/** A project's coordinator, in either lifecycle but never in Trash, as `GET /sessions/project-placement` finds it. */
export interface ListingCoordinator {
  id: string;
  workspaceId: string | null;
  folderId: string | null;
  pinnedAt: Date | null;
  createdAt: Date;
}

export interface ListingFolder {
  id: string;
  name: string;
}

/** What `workspaceSessionCounts` counts a session as; a session it counts nowhere is absent. */
export interface ListingActivity {
  needsYou: ReadonlySet<string>;
  running: ReadonlySet<string>;
  /** Background jobs in flight, quiet or not: the tally's `jobs` and `stalledJobs` together. */
  jobs: ReadonlySet<string>;
}

export interface ListingFolderTally {
  folderId: string;
  /** The rows its page lists: a project is one row however many members it holds. */
  rowCount: number;
  needsYou: number;
  running: boolean;
  jobs: boolean;
}

/**
 * Which order the entries are in: `sectioned` (Open: by section, then listedAt ?? createdAt, as the web's
 * `sessionTimeSections` sorts each section with `compareListed`), `placed` (Completed with a project held:
 * listedAt ?? createdAt, a session before a project at the same place) or `completed` (Completed with none held,
 * GET /sessions?view=completed's: COALESCE(completed_at, archived_at), NULLS LAST). See buildSessionListing.
 */
export type ListingOrder = 'sectioned' | 'placed' | 'completed';

/**
 * The Open view's section an entry is drawn in, as the web's `sessionTimeSections` (attention on) files it:
 * 0 Pinned, 1 Needs you, 2 Working, 3 the rest (by day). Every entry of the Completed view is 3.
 */
export type ListingSection = 0 | 1 | 2 | 3;

interface EntryKey {
  order: ListingOrder;
  section: ListingSection;
  /** The entry's place in its order: placement under `placed`, completion under `completed` (-Infinity for none). */
  placedAt: number;
  /** 0 a session, 1 a project: under `placed`, at the same place a session comes first, as the web's stable sort
   *  leaves it. `sectioned` does not read it: `compareListed` goes on to createdAt and id. */
  rank: 0 | 1;
  createdAt: number;
  id: string;
}

export type ListingEntryKey =
  | (EntryKey & { kind: 'session'; rank: 0 })
  | (EntryKey & {
      kind: 'project';
      rank: 1;
      placedAtDate: Date;
      spokeAtDate: Date;
      memberCount: number;
      coordinatorId: string | null;
      /** Whether a member it holds runs / has a background job moving: workspaceSessionCounts' predicates, as a
       *  folder row's. False without `activity`. */
      running: boolean;
      jobs: boolean;
    });

const time = (at: Date | null | undefined): number => {
  const ms = at ? at.getTime() : Number.NaN;
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/** The section (Open only), then the place DESC, a session before a project (not under `sectioned`), created_at
 *  DESC, id ASC. Both keys must be of one order. */
export function compareListingKeys(a: EntryKey, b: EntryKey): number {
  if (a.section !== b.section) return a.section - b.section;
  if (a.placedAt !== b.placedAt) return a.placedAt > b.placedAt ? -1 : 1;
  if (a.order !== 'sectioned' && a.rank !== b.rank) return a.rank - b.rank;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Folders by name as Finder orders names, the id settling a tie: the web's `compareFolders`. */
const compareFolders = (a: ListingFolder, b: ListingFolder): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Every top-level entry of the list in order, and its folder rows.
 *
 * - A session is held by its project's entry when that project's coordinator runs in this workspace or
 *   it has none; a member whose coordinator runs elsewhere is its own entry.
 * - A project entry is filed in its coordinator's folder, a session in its own; a folder that is not a
 *   live folder of this workspace counts as none.
 * - Without `folderId`, the entries in no live folder; with it, the entries filed in it.
 * - With `activity`, a project entry says whether a member it holds runs or has a job moving, which the
 *   members' own rows said when the client grouped them.
 * - In Open, the entries go by the sections the web draws them in (`ListingSection`), each in the order above:
 *   Pinned; Needs you, a session its row puts there (`listingRowNeedsOwner`) or a project a member it holds
 *   waits on you in (pendingApprovals, the web's project row); Working, a session its row puts there
 *   (`listingRowIsWorking`) or a project whose `running` is set; then the rest. So the first page holds every
 *   row the web draws above the days, however long ago it was listed.
 */
export function buildSessionListing(input: {
  view: ListingView;
  workspaceId: string;
  folderId: string | null;
  sessions: readonly ListingSession[];
  coordinators: ReadonlyMap<string, ListingCoordinator | null>;
  folders: readonly ListingFolder[];
  activity: ListingActivity | null;
}): { order: ListingOrder; entries: ListingEntryKey[]; folders: ListingFolderTally[] } {
  const { view, workspaceId, folderId, coordinators } = input;
  const heldBy = (session: ListingSession): string | null => {
    const id = session.projectId;
    if (!id) return null;
    const home = coordinators.get(id)?.workspaceId;
    return home && home !== workspaceId ? null : id;
  };
  const filedIn = (session: ListingSession): string | null => {
    const held = heldBy(session);
    return held ? (coordinators.get(held)?.folderId ?? null) : session.folderId;
  };
  const known = new Set(input.folders.map((folder) => folder.id));
  const inScope = (id: string | null) => folderId ? id === folderId : !id || !known.has(id);
  const sectionOf = (pinnedAt: Date | null, needsYou: boolean, working: boolean): ListingSection =>
    view !== 'open' ? 3 : pinnedAt != null ? 0 : needsYou ? 1 : working ? 2 : 3;
  // The order switches on whether anything is held, as the web's does (src/web/src/lib/sessionProjects.ts
  // `sessionProjectListing`): with no project group anywhere in the view — every folder counted — it keeps the
  // list's own order, which for Completed is GET /sessions?view=completed's; with one, it sorts every entry by
  // listedAt ?? createdAt. Open is always drawn in sections.
  const order: ListingOrder = view === 'open' ? 'sectioned'
    : input.sessions.some((session) => heldBy(session) !== null) ? 'placed' : 'completed';
  const sessionPlace = (session: ListingSession) =>
    order === 'completed' ? time(session.completedAt) : time(session.listedAt ?? session.createdAt);

  const entries: ListingEntryKey[] = [];
  const groups = new Map<string, ListingSession[]>();
  for (const session of input.sessions) {
    const held = heldBy(session);
    if (held) {
      const members = groups.get(held);
      if (members) members.push(session);
      else groups.set(held, [session]);
    } else if (inScope(session.folderId)) {
      entries.push({
        kind: 'session', order, rank: 0, id: session.id,
        section: sectionOf(session.pinnedAt, !!session.row && listingRowNeedsOwner(session.row),
          !!session.row && listingRowIsWorking(session.row)),
        placedAt: sessionPlace(session), createdAt: time(session.createdAt),
      });
    }
  }
  for (const [projectId, members] of groups) {
    const coordinator = coordinators.get(projectId) ?? null;
    if (!inScope(coordinator?.folderId ?? null)) continue;
    // The member listed last places the entry; the one that spoke last dates it (`sessionProjectListing`).
    const latest = members.reduce((newest, s) => time(s.listedAt ?? s.createdAt) > time(newest.listedAt ?? newest.createdAt) ? s : newest);
    const spoke = members.reduce((newest, s) => time(s.lastTurnAt ?? s.createdAt) > time(newest.lastTurnAt ?? newest.createdAt) ? s : newest);
    const placedAtDate = latest.listedAt ?? latest.createdAt;
    const activity = input.activity;
    const running = !!activity && members.some((s) => activity.running.has(s.id));
    const jobs = !!activity && members.some((s) => activity.jobs.has(s.id));
    entries.push({
      kind: 'project', order, rank: 1, id: projectId,
      // A member with a background job in flight is working too (its row spins on `phase` RUNNING).
      section: sectionOf(coordinator?.pinnedAt ?? null, members.some((s) => (s.row?.pendingApprovals ?? 0) > 0), running || jobs),
      placedAt: time(placedAtDate), createdAt: time(coordinator?.createdAt ?? latest.createdAt),
      placedAtDate, spokeAtDate: spoke.lastTurnAt ?? spoke.createdAt,
      memberCount: members.length, coordinatorId: coordinator?.id ?? null,
      running,
      jobs,
    });
  }
  entries.sort(compareListingKeys);

  const folders: ListingFolderTally[] = [];
  if (!folderId) {
    const inside = new Map<string, ListingSession[]>();
    for (const session of input.sessions) {
      const id = filedIn(session);
      if (!id || !known.has(id)) continue;
      const list = inside.get(id);
      if (list) list.push(session);
      else inside.set(id, [session]);
    }
    for (const folder of [...input.folders].sort(compareFolders)) {
      const filed = inside.get(folder.id) ?? [];
      // Open shows every folder, the empty ones too; Completed only those a session of it is in.
      if (view === 'completed' && filed.length === 0) continue;
      const rows = new Set(filed.map((session) => {
        const held = heldBy(session);
        return held ? `project:${held}` : session.id;
      }));
      const activity = input.activity;
      folders.push({
        folderId: folder.id,
        rowCount: rows.size,
        needsYou: activity ? filed.filter((session) => activity.needsYou.has(session.id)).length : 0,
        running: activity ? filed.some((session) => activity.running.has(session.id)) : false,
        jobs: activity ? filed.some((session) => activity.jobs.has(session.id)) : false,
      });
    }
  }
  return { order, entries, folders };
}

/** The `after` of the page that follows `entry`: its sort key, opaque to the client. */
export function encodeListingCursor(entry: EntryKey): string {
  return [entry.order === 'completed' ? 'c' : entry.order === 'placed' ? 'p' : 's', entry.section, entry.placedAt, entry.rank, entry.createdAt,
    uuidToBase62(entry.id)].join('.');
}

/** A cursor this read wrote, or a 400. */
export function decodeListingCursor(after: string): EntryKey {
  const parts = after.split('.');
  const order = parts[0] === 'c' ? 'completed' : parts[0] === 'p' ? 'placed' : parts[0] === 's' ? 'sectioned' : null;
  const [section, placedAt, rank, createdAt] = parts.slice(1, 5).map(Number);
  let id: string | undefined;
  try {
    id = parts.length === 6 && /^[0-9A-Za-z]{1,22}$/.test(parts[5]) ? base62ToUuid(parts[5]) : undefined;
  } catch {
    id = undefined;
  }
  // Under `completed` a session with neither clock sorts last (NULLS LAST): its place is -Infinity.
  const placeOk = Number.isFinite(placedAt) || (order === 'completed' && placedAt === Number.NEGATIVE_INFINITY);
  if (!id || !order || ![0, 1, 2, 3].includes(section) || (rank !== 0 && rank !== 1)
    || !placeOk || !Number.isFinite(createdAt)) {
    throw new BadRequestException('after is not a cursor this list wrote');
  }
  return { order, section: section as ListingSection, placedAt, rank, createdAt, id };
}

/** The page after `after` (from the top without one): the entries strictly after its key, so a page
 *  neither skips nor repeats an entry however many share a place, and `next` when more follow. A cursor
 *  written under the other order (the list's order switched between two pages) starts again from the
 *  top: its key places nothing in this order, and a page never mixes the two. SessionsService.sessionListing
 *  answers that page `restarted: true`. */
export function listingPage<T extends EntryKey>(
  entries: readonly T[],
  after: EntryKey | null,
  limit: number,
  order: ListingOrder,
): { page: T[]; next: string | null } {
  const from = after && after.order === order ? after : null;
  const start = from ? entries.findIndex((entry) => compareListingKeys(entry, from) > 0) : 0;
  const rest = start < 0 ? [] : entries.slice(start);
  const page = rest.slice(0, limit);
  return { page, next: rest.length > limit ? encodeListingCursor(page[page.length - 1]) : null };
}
