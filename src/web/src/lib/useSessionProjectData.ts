import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SessionListItem } from '../api';
import { listPollMs } from './listBudget';
import { projectPlacementQuery, type ProjectPlacement, type SessionListView } from './queries';

const NO_ANSWERS: readonly ProjectPlacement[] = [];

/** The projects a workspace list shows, by id: the ones its rows are members of. A Trash list, or a
 *  list that draws no project rows, places none. */
export function sessionProjectIds(
  sessions: readonly SessionListItem[],
  opts: { view: SessionListView; enabled: boolean },
): string[] {
  if (!opts.enabled || opts.view === 'trash') return [];
  const ids = new Set<string>();
  for (const session of sessions) {
    const id = session.projectMembership?.projectId;
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * What a workspace list places its project rows with, for every project it shows, in one read
 * (`GET /sessions/project-placement`, projectPlacementQuery): where each one's coordinator runs, Open
 * or Completed, which decides whether the project is a row here or its members are rows of their own
 * (owner 2026-11-07); the members waiting on the owner in other workspaces, which the row's line
 * names; and each project's session count.
 *
 * This was one or two reads a project — Open, then Completed for a coordinator the Open read did not
 * find — so a page load of thirty projects made some sixty, each built in full by the server
 * (2026-11-21). The list budget (docs/list-freshness-design.md R1–R3, W4) now holds for one read:
 * - an event about one of its projects or their sessions reads it once a coalescing window
 *   (useControlPlane schedulePlacement), and no other event does;
 * - otherwise the safety read, once a minute while the stream is live, answered 304 when nothing moved;
 * - while the stream is down, the shared outage backoff;
 * - a hidden tab reads nothing, and back in view reads once what came due (useControlPlane catchUp).
 *
 * The project page keeps its own reads of the project's whole member list (projectSessionsQuery).
 */
export function useSessionProjectData(opts: {
  sessions: readonly SessionListItem[];
  view: SessionListView;
  enabled: boolean;
  controlLive: boolean;
}): {
  coordinators: SessionListItem[];
  contentSessions: SessionListItem[];
  sessionCounts: ReadonlyMap<string, number>;
  placing: boolean;
} {
  const projectIds = sessionProjectIds(opts.sessions, opts);
  const view = opts.view === 'completed' ? 'completed' : 'open';
  const enabled = projectIds.length > 0;
  const placement = useQuery({
    ...projectPlacementQuery({ view, projectIds }),
    enabled,
    refetchInterval: (query) => listPollMs(opts.controlLive, query),
    // A project joining the list re-keys the read: the rows already placed stay where they are meanwhile.
    placeholderData: keepPreviousData,
  });
  const answers = enabled ? placement.data ?? NO_ANSWERS : NO_ANSWERS;
  // One object per answer, so a list keyed on these reads the same while the answer does
  // (docs/session-list-scale-design.md §4).
  const read = useMemo(() => ({
    coordinators: answers.flatMap((answer) => answer.coordinator ? [answer.coordinator] : []),
    contentSessions: answers.flatMap((answer) => answer.waiting),
    sessionCounts: new Map(answers.map((answer) => [answer.projectId, answer.sessionCount])) as ReadonlyMap<string, number>,
  }), [answers]);
  const answered = new Set(answers.map((answer) => answer.projectId));
  // Where a coordinator the list does not hold runs decides the list's shape. Until the read answers
  // for its project, the shape may change.
  const listed = new Set(opts.sessions.flatMap((session) =>
    session.projectMembership?.role === 'COORDINATOR' ? [session.projectMembership.projectId] : []));
  const unanswered = placement.isPending || placement.isPlaceholderData;
  return {
    ...read,
    placing: enabled && unanswered && projectIds.some((id) => !listed.has(id) && !answered.has(id)),
  };
}
