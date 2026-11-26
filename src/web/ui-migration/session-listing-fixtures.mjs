import { base62ToUuid, uuidToBase62 } from '@orbit/shared';
import { buildSessionListing, decodeListingCursor, listingPage } from '../../apiserver/src/sessions/session-listing.ts';

// GET /sessions/listing (docs/session-list-scale-design.md §3.2) answered for the browser fixtures by the
// server's own rules — src/apiserver/src/sessions/session-listing.ts, which its pg spec holds to
// contracts/session-listing.fixtures.json — over the rows a fixture answers GET /sessions with, so a fixture
// that lists sessions answers both reads alike. The rules take uuids, as the server's do; the fixtures' ids
// are base62 ones (an id that is not one is given a uuid of its own here).

const synthetic = new Map();
const back = new Map();
const uuid = (id) => {
  if (!id) return null;
  let value = synthetic.get(id);
  if (value) return value;
  try {
    value = base62ToUuid(id);
  } catch {
    value = `00000000-0000-4000-8000-${String(synthetic.size + 1).padStart(12, '0')}`;
  }
  synthetic.set(id, value);
  back.set(value, id);
  return value;
};
const fixtureId = (value) => back.get(value) ?? uuidToBase62(value);
const date = (at) => (at ? new Date(at) : null);
const lifecycleOf = (row) => (row.lifecycleState === 'COMPLETED' ? 'completed' : row.lifecycleState === 'TRASH' ? 'trash' : 'open');
const workspaceOf = (row) => row.workspace?.id ?? row.workspaceId ?? null;

/** What the sidebar's workspace row counts as waiting on you (WorkspaceView sessionNeedsYou), by default. */
const needsYouByDefault = (row) => (row.pendingApprovals ?? 0) > 0 && row.waitingKind !== 'START_REQUEST';

/**
 * One page of `rows`' listing for the read `searchParams` asks: `rows` every session the fixture has (any
 * workspace, any lifecycle: a project's coordinator is found wherever it is), `folders` the owner's folders.
 */
export function answerListing(rows, folders, searchParams, { needsYou = needsYouByDefault } = {}) {
  const workspaceId = searchParams.get('workspaceId');
  const view = searchParams.get('view') === 'completed' ? 'completed' : 'open';
  const folderId = searchParams.get('folderId') || null;
  const limit = Math.min(Number(searchParams.get('limit') || 40), 200);
  const after = searchParams.get('after');
  const inScope = rows.filter((row) => workspaceOf(row) === workspaceId && lifecycleOf(row) === view &&
    row.runSource !== 'SCHEDULE' && row.runSource !== 'SCHEDULE_CHANGE');
  const byId = new Map(rows.map((row) => [uuid(row.id), row]));
  const coordinators = new Map();
  for (const row of rows) {
    const membership = row.projectMembership;
    if (membership?.role !== 'COORDINATOR' || lifecycleOf(row) === 'trash') continue;
    coordinators.set(uuid(membership.projectId), {
      id: uuid(row.id), workspaceId: uuid(workspaceOf(row)), folderId: uuid(row.folderId ?? null),
      pinnedAt: date(row.pinnedAt), createdAt: date(row.createdAt),
    });
  }
  for (const row of inScope) {
    const project = uuid(row.projectMembership?.projectId ?? null);
    if (project && !coordinators.has(project)) coordinators.set(project, null);
  }
  const ids = (list) => new Set(list.map((row) => uuid(row.id)));
  const built = buildSessionListing({
    view,
    workspaceId: uuid(workspaceId),
    folderId: uuid(folderId),
    sessions: inScope.map((row) => ({
      id: uuid(row.id), folderId: uuid(row.folderId ?? null), pinnedAt: date(row.pinnedAt), listedAt: date(row.listedAt),
      createdAt: date(row.createdAt), lastTurnAt: date(row.lastTurnAt), completedAt: date(row.completedAt ?? row.archivedAt),
      projectId: uuid(row.projectMembership?.projectId ?? null),
    })),
    coordinators,
    folders: folders.filter((folder) => folder.workspaceId === workspaceId).map((folder) => ({ id: uuid(folder.id), name: folder.name })),
    activity: {
      needsYou: ids(inScope.filter(needsYou)),
      running: ids(inScope.filter((row) => row.status === 'RUNNING')),
      jobs: ids(inScope.filter((row) => (row.runningBgJobCount ?? 0) > 0)),
    },
  });
  const cursor = after ? decodeListingCursor(after) : null;
  const restarted = !!cursor && cursor.order !== built.order;
  const { page, next } = listingPage(built.entries, restarted ? null : cursor, limit, built.order);
  const entries = page.map((entry) => entry.kind === 'session'
    ? { kind: 'session', session: byId.get(entry.id) }
    : {
        kind: 'project',
        projectId: fixtureId(entry.id),
        placedAt: entry.placedAtDate.toISOString(),
        spokeAt: entry.spokeAtDate.toISOString(),
        memberCount: entry.memberCount,
        running: entry.running,
        jobs: entry.jobs,
        coordinator: entry.coordinatorId ? byId.get(entry.coordinatorId) ?? null : null,
      });
  const withFolders = !folderId && (!cursor || restarted);
  return {
    ...(withFolders ? { folders: built.folders.map((tally) => ({ ...tally, folderId: fixtureId(tally.folderId) })) } : {}),
    entries,
    next,
    ...(restarted ? { restarted: true } : {}),
  };
}

/** Each project's answer in GET /sessions/project-placement over `rows`, for the projects `searchParams` names. */
export function answerPlacement(rows, searchParams, { needsYou = needsYouByDefault } = {}) {
  const view = searchParams.get('view') === 'completed' ? 'completed' : 'open';
  const projectIds = (searchParams.get('projectIds') ?? '').split(',').filter(Boolean);
  return {
    projects: projectIds.map((projectId) => {
      const members = rows.filter((row) => row.projectMembership?.projectId === projectId);
      const coordinator = members.find((row) => row.projectMembership.role === 'COORDINATOR' && lifecycleOf(row) !== 'trash') ?? null;
      const inView = members.filter((row) => lifecycleOf(row) === view);
      return { projectId, coordinator, waiting: inView.filter(needsYou), sessionCount: inView.length };
    }),
  };
}
