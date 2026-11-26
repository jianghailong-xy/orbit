import { base62ToUuid } from '@orbit/shared';
import type { SessionListingPage } from '../lib/sessionListingData';

// GET /sessions/listing answered in a test from the rows the test answers GET /sessions with, by the server's own
// rules (src/apiserver/src/sessions/session-listing.ts, held to contracts/session-listing.fixtures.json by its pg
// spec). A test passes the rules in — `import * as listingRules from '../../../apiserver/src/sessions/session-listing'`
// — so this helper, which the web build type-checks, does not reach into the server's tree itself. The rules take
// uuids, as the server's do: a test's id is decoded where it is a public id, and given a uuid of its own otherwise.

interface Key { order: string; id: string }
interface Built {
  order: string;
  entries: Array<Key & {
    kind: 'session' | 'project';
    placedAtDate?: Date;
    spokeAtDate?: Date;
    memberCount?: number;
    coordinatorId?: string | null;
    running?: boolean;
    jobs?: boolean;
  }>;
  folders: Array<{ folderId: string; rowCount: number; needsYou: number; running: boolean; jobs: boolean }>;
}
/** What a test hands in of session-listing.ts. */
export interface ListingRules {
  buildSessionListing: (input: never) => Built;
  listingPage: (entries: never, after: never, limit: number, order: never) => { page: Built['entries']; next: string | null };
  decodeListingCursor: (after: string) => Key;
}

interface Row {
  id: string;
  workspace?: { id?: string | null } | null;
  workspaceId?: string | null;
  folderId?: string | null;
  pinnedAt?: string | null;
  listedAt?: string | null;
  createdAt?: string | null;
  lastTurnAt?: string | null;
  completedAt?: string | null;
  archivedAt?: string | null;
  lifecycleState?: string | null;
  runSource?: string | null;
  status?: string | null;
  pendingApprovals?: number | null;
  runningBgJobCount?: number | null;
  waitingKind?: string | null;
  projectMembership?: { projectId: string; role: string } | null;
}

const toUuid = new Map<string, string>();
const fromUuid = new Map<string, string>();
const uuid = (id: string | null | undefined): string | null => {
  if (!id) return null;
  let value = toUuid.get(id);
  if (value) return value;
  try {
    value = base62ToUuid(id);
  } catch {
    value = `00000000-0000-4000-8000-${String(toUuid.size + 1).padStart(12, '0')}`;
  }
  toUuid.set(id, value);
  fromUuid.set(value, id);
  return value;
};
const testId = (value: string): string => fromUuid.get(value) ?? value;

const date = (at: string | null | undefined): Date | null => (at ? new Date(at) : null);
const lifecycleOf = (row: Row) => (row.lifecycleState === 'COMPLETED' ? 'completed' : row.lifecycleState === 'TRASH' ? 'trash' : 'open');
const workspaceOf = (row: Row) => row.workspace?.id ?? row.workspaceId ?? null;

/** One page of `rows`' listing for the read `path` asks (`/sessions/listing?…`). */
export function answerListing(
  rules: ListingRules,
  rows: readonly Row[],
  folders: ReadonlyArray<{ id: string; workspaceId: string; name: string }>,
  path: string,
): SessionListingPage {
  const q = new URL(path, 'http://test').searchParams;
  const workspaceId = q.get('workspaceId');
  const view = q.get('view') === 'completed' ? 'completed' : 'open';
  const folderId = q.get('folderId') || null;
  const limit = Number(q.get('limit') || 40);
  const after = q.get('after');
  const inScope = rows.filter((row) => workspaceOf(row) === workspaceId && lifecycleOf(row) === view &&
    row.runSource !== 'SCHEDULE' && row.runSource !== 'SCHEDULE_CHANGE');
  const byId = new Map(rows.map((row) => [uuid(row.id)!, row]));
  const coordinators = new Map<string, unknown>();
  for (const row of rows) {
    const membership = row.projectMembership;
    if (membership?.role !== 'COORDINATOR' || lifecycleOf(row) === 'trash') continue;
    coordinators.set(uuid(membership.projectId)!, {
      id: uuid(row.id), workspaceId: uuid(workspaceOf(row)), folderId: uuid(row.folderId), pinnedAt: date(row.pinnedAt),
      createdAt: date(row.createdAt) ?? new Date(0),
    });
  }
  for (const row of inScope) {
    const project = uuid(row.projectMembership?.projectId);
    if (project && !coordinators.has(project)) coordinators.set(project, null);
  }
  const ids = (list: readonly Row[]) => new Set(list.map((row) => uuid(row.id)));
  const built = rules.buildSessionListing({
    view,
    workspaceId: uuid(workspaceId),
    folderId: uuid(folderId),
    sessions: inScope.map((row) => ({
      id: uuid(row.id), folderId: uuid(row.folderId), pinnedAt: date(row.pinnedAt), listedAt: date(row.listedAt),
      createdAt: date(row.createdAt) ?? new Date(0), lastTurnAt: date(row.lastTurnAt),
      completedAt: date(row.completedAt ?? row.archivedAt), projectId: uuid(row.projectMembership?.projectId),
    })),
    coordinators,
    folders: folders.filter((folder) => folder.workspaceId === workspaceId).map((folder) => ({ id: uuid(folder.id), name: folder.name })),
    activity: {
      needsYou: ids(inScope.filter((row) => (row.pendingApprovals ?? 0) > 0 && row.waitingKind !== 'START_REQUEST')),
      running: ids(inScope.filter((row) => row.status === 'RUNNING')),
      jobs: ids(inScope.filter((row) => (row.runningBgJobCount ?? 0) > 0)),
    },
  } as never);
  const cursor = after ? rules.decodeListingCursor(after) : null;
  const restarted = !!cursor && cursor.order !== built.order;
  const { page, next } = rules.listingPage(built.entries as never, (restarted ? null : cursor) as never, limit, built.order as never);
  const withFolders = !folderId && (!cursor || restarted);
  return {
    ...(withFolders ? { folders: built.folders.map((tally) => ({ ...tally, folderId: testId(tally.folderId) })) } : {}),
    entries: page.map((entry) => entry.kind === 'session'
      ? { kind: 'session' as const, session: byId.get(entry.id) as never }
      : {
          kind: 'project' as const,
          projectId: testId(entry.id),
          placedAt: entry.placedAtDate!.toISOString(),
          spokeAt: entry.spokeAtDate!.toISOString(),
          memberCount: entry.memberCount!,
          running: entry.running,
          jobs: entry.jobs,
          coordinator: (entry.coordinatorId ? byId.get(entry.coordinatorId) ?? null : null) as never,
        }),
    next,
    ...(restarted ? { restarted: true as const } : {}),
  };
}
