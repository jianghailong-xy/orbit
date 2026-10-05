import { useQueries } from '@tanstack/react-query';
import type { SessionListItem } from '../api';
import { PROJECT_SESSION_REFRESH_MS, projectSessionsQuery, type SessionListView } from './queries';

export interface ProjectSessionRequest {
  projectId: string;
  view: SessionListView;
}

/** Only projects already represented in the workspace list can need supplemental members.
 *  No waiting count is available across workspaces, so an absent local waiting target needs
 *  a project-scoped snapshot too. Eligibility depends on the local rows, never the supplement. */
export function sessionProjectRequests(
  sessions: readonly SessionListItem[],
  opts: { view: SessionListView; enabled: boolean; needsYou: (session: SessionListItem) => boolean },
): ProjectSessionRequest[] {
  if (!opts.enabled || opts.view === 'trash') return [];
  const groups = new Map<string, SessionListItem[]>();
  for (const session of sessions) {
    const id = session.projectMembership?.projectId;
    if (!id) continue;
    const group = groups.get(id);
    if (group) group.push(session);
    else groups.set(id, [session]);
  }
  const requests: ProjectSessionRequest[] = [];
  for (const [projectId, members] of groups) {
    const missingCoordinator = !members.some((session) => session.projectMembership?.role === 'COORDINATOR');
    if (missingCoordinator || !members.some(opts.needsYou)) requests.push({ projectId, view: opts.view });
    if (missingCoordinator && opts.view !== 'open') requests.push({ projectId, view: 'open' });
  }
  return requests;
}

/** Read just the missing project words without widening the workspace list's scope. A
 *  coordinator may have been completed, so look there only after its Open snapshot ruled
 *  one out. The same query factory also serves the project-session page. */
export function useSessionProjectData(opts: {
  sessions: readonly SessionListItem[];
  view: SessionListView;
  enabled: boolean;
  controlLive: boolean;
  needsYou: (session: SessionListItem) => boolean;
}): { coordinators: SessionListItem[]; contentSessions: SessionListItem[] } {
  const requests = sessionProjectRequests(opts.sessions, opts);
  const query = (request: ProjectSessionRequest) => ({
    ...projectSessionsQuery(request),
    // A lifecycle-ended frame can name a member never loaded in this view and carries no
    // project id. A slow scoped snapshot catches it without refetching on unrelated events.
    refetchInterval: opts.controlLive ? PROJECT_SESSION_REFRESH_MS : 4000,
  });
  const primary = useQueries({ queries: requests.map(query) });
  const completedFallbacks = requests.filter((request, index) => request.view === 'open' &&
    !requests.some((other) => other.projectId === request.projectId && other.view === 'completed') &&
    !opts.sessions.some((session) => session.projectMembership?.projectId === request.projectId &&
      session.projectMembership?.role === 'COORDINATOR') &&
    primary[index].isSuccess &&
    !primary[index].data?.some((session) => session.projectMembership?.role === 'COORDINATOR'),
  ).map((request) => ({ ...request, view: 'completed' as const }));
  const fallback = useQueries({ queries: completedFallbacks.map(query) });
  const rows = [...primary, ...fallback].flatMap((result) => result.data ?? []);
  return {
    coordinators: rows.filter((session) => session.projectMembership?.role === 'COORDINATOR'),
    contentSessions: primary.flatMap((result, index) => requests[index].view === opts.view ? result.data ?? [] : []),
  };
}
