import { focusManager, useQueries, useQueryClient, type Query, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { SessionListItem } from '../api';
import { LIVE_FALLBACK_MS, listPollMs } from './listBudget';
import { projectSessionsQuery, type SessionListView } from './queries';

/**
 * A workspace list's project reads are one list to the list budget (docs/list-freshness-design.md R1,
 * W4). A member's own event re-reads its project at once (useControlPlane). Besides that, while the
 * stream is live, the list's safety read re-reads a tenth of them a minute (at least one), those read
 * longest ago first, so every project is read again within about ten minutes — and not one read a
 * minute each, which on a 75-project tab was 1,340 reads in half an hour (2026-11-07). The server
 * builds every one of them: nothing about a project read is conditional.
 */
const SAFETY_SHARE = 10;

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
}): { coordinators: SessionListItem[]; contentSessions: SessionListItem[]; placing: boolean } {
  const requests = sessionProjectRequests(opts.sessions, opts);
  // While the stream is down, each read follows the shared outage backoff. While it is live, none
  // polls on its own: the safety read below takes them in turn.
  const query = (request: ProjectSessionRequest) => ({
    ...projectSessionsQuery(request),
    refetchInterval: opts.controlLive ? false as const : (q: { queryHash: string }) => listPollMs(false, q),
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
  useProjectSafetyRead(
    [...requests, ...completedFallbacks].map((request) => projectSessionsQuery(request).queryKey),
    opts.controlLive,
  );
  const rows = [...primary, ...fallback].flatMap((result) => result.data ?? []);
  // Where a coordinator the list does not hold runs decides the list's shape: the project is a row here,
  // or its members are rows of their own (owner 2026-11-07). Until its read answers, the shape may change.
  const listed = new Set(opts.sessions.flatMap((session) =>
    session.projectMembership?.role === 'COORDINATOR' ? [session.projectMembership.projectId] : []));
  return {
    coordinators: rows.filter((session) => session.projectMembership?.role === 'COORDINATOR'),
    contentSessions: primary.flatMap((result, index) => requests[index].view === opts.view ? result.data ?? [] : []),
    placing: primary.some((result, index) => result.isPending && !listed.has(requests[index].projectId))
      || fallback.some((result) => result.isPending),
  };
}

/**
 * The project reads' safety read while the stream is live (see SAFETY_SHARE): once a minute, the
 * share of them read longest ago, leaving out any read in the last half-minute (an event's). A hidden
 * tab reads nothing; back in view, the share comes due at once (R3).
 */
function useProjectSafetyRead(keys: QueryKey[], live: boolean): void {
  const qc = useQueryClient();
  const current = useRef(keys);
  current.current = keys;
  useEffect(() => {
    if (!live) return;
    const readDue = (): void => {
      if (!focusManager.isFocused()) return;
      const now = Date.now();
      const all = current.current;
      const due = all
        .map((key) => qc.getQueryCache().find({ queryKey: key, exact: true }))
        .filter((q): q is Query => q !== undefined && q.isActive() && q.state.fetchStatus === 'idle'
          && now - q.state.dataUpdatedAt >= LIVE_FALLBACK_MS / 2)
        .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt)
        .slice(0, Math.ceil(all.length / SAFETY_SHARE));
      for (const q of due) void qc.refetchQueries({ queryKey: q.queryKey, exact: true }, { cancelRefetch: false });
    };
    let timer = setInterval(readDue, LIVE_FALLBACK_MS);
    const onVisible = (): void => {
      if (!focusManager.isFocused()) return;
      clearInterval(timer);
      readDue();
      timer = setInterval(readDue, LIVE_FALLBACK_MS);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [live, qc]);
}
