// Project rows in the session list (docs/session-list-projects-design.md §4, §6, §7).
// Session readings come from the same functions the ordinary rows use.
import type { CoordinatorLeadKind, ProjectSidebarTaskCounts, SessionProjectMembership } from '@orbit/shared';
import type { SessionFolder } from '../api';
import { elapsedLabel, type SidebarProject } from './projectAttention';
import type { SessionListView } from './queries';
import { sessionFolderListing, type FolderSessionReadings, type SessionFolderRow } from './sessionFolders';
import type { GroupableSession } from './sessionGrouping';

export interface SessionProjectSession extends GroupableSession {
  title?: string | null;
  folderId?: string | null;
  projectMembership?: SessionProjectMembership | null;
  ownerItems?: readonly { since: string }[];
}

export interface SessionProjectLine {
  text: string;
  tone: 'preview' | 'running' | 'approval' | 'queued' | 'background' | 'watching' | 'review';
}

export interface SessionProjectRow<T> extends GroupableSession {
  projectId: string;
  title: string;
  status: SessionProjectMembership['projectStatus'];
  members: T[];
  sessionCount: number;
  coordinator: T | null;
  folderId: string | null;
  needsYou: boolean;
  running: boolean;
  jobs: boolean;
  indicator: 'needs-you' | 'running' | 'jobs' | null;
  line: SessionProjectLine;
  target: { kind: 'session' | 'project'; id: string };
  taskCounts?: ProjectSidebarTaskCounts;
  runningCount: number;
}

export type SessionProjectEntry<T> =
  | (T & { kind: 'session' })
  | (SessionProjectRow<T> & { kind: 'project' });

export interface SessionProjectListing<T> {
  folders: SessionFolderRow[];
  projects: SessionProjectRow<T>[];
  sessions: T[];
  entries: SessionProjectEntry<T>[];
}

export const listShowsProjects = (view: SessionListView, byTag: boolean, searching = false): boolean =>
  view !== 'trash' && !byTag && !searching;

export const SESSION_PROJECT_COPY = {
  progress: (done: number, total: number) => `${done}/${total}`,
  progressHint: (sessions: number, running: number) => `${sessions} sessions · ${running} running`,
  waitingSession: (text: string, title: string) => `${text} · ${title}`,
  noCoordinator: 'No coordinator',
  openSession: 'Open Session',
  openCoordinator: 'Open Coordinator',
  sessions: 'Sessions',
  openProject: 'Open Project',
  pin: 'Pin',
  unpin: 'Unpin',
  move: 'Move…',
  pageSubtitle: (sessions: number) => `Project · ${sessions} sessions`,
  coordinatorSection: 'Coordinator',
  pageProgress: (done: number, total: number, running: number) => `${done}/${total} done · ${running} running`,
} as const;

// Capitalized COORDINATOR_LEAD_COPY; literals also let OrbitKit read the shared wording.
export const SESSION_PROJECT_COORDINATOR_COPY: Record<CoordinatorLeadKind, string> = {
  INTEGRATION_CONFLICT: 'Resolving a merge conflict',
  INTEGRATION_CHECK_FAILED: 'Checks failed',
  INTEGRATION_ERROR: 'Handling an integration error',
  TASK_FAILED: 'Handling a failed task',
  DELIVERY_REVIEW: 'Reviewing a delivery',
};

const instant = (at: string | null | undefined): number => {
  const ms = Date.parse(at ?? '');
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/** The owner item's own wait is authoritative; old summaries only have last activity. */
const waitingInstant = (session: SessionProjectSession): number => {
  const items = (session.ownerItems ?? []).map((item) => instant(item.since)).filter(Number.isFinite);
  return items.length ? Math.min(...items) : instant(session.lastTurnAt ?? session.createdAt);
};

/** Split one view of one workspace. Supplemental coordinators affect placement and wording only:
 *  a coordinator from another workspace/view never inflates this view's activity or folder count. */
export function sessionProjectListing<T extends SessionProjectSession>(
  sessions: readonly T[],
  folders: readonly SessionFolder[],
  projects: readonly SidebarProject[],
  opts: {
    view: SessionListView;
    byTag: boolean;
    searching?: boolean;
    folderId?: string | null;
    runnerOffline?: boolean;
    now?: number;
    coordinators?: readonly T[];
    /** Same-view sessions across workspaces, used for the waiting line and tooltip count. */
    contentSessions?: readonly T[];
    line: (session: T) => SessionProjectLine;
  } & FolderSessionReadings<T>,
): SessionProjectListing<T> {
  const flat = (rows: T[], folderRows: SessionFolderRow[] = []): SessionProjectListing<T> => ({
    folders: folderRows,
    projects: [],
    sessions: rows,
    entries: rows.map((session) => ({ ...session, kind: 'session' })),
  });
  if (!listShowsProjects(opts.view, opts.byTag, opts.searching)) return flat([...sessions]);

  const groups = new Map<string, T[]>();
  const coordinators = new Map<string, T>();
  for (const session of [...(opts.coordinators ?? []), ...sessions]) {
    if (session.projectMembership?.role === 'COORDINATOR') {
      coordinators.set(session.projectMembership.projectId, session);
    }
  }
  for (const session of sessions) {
    const id = session.projectMembership?.projectId;
    if (!id) continue;
    const members = groups.get(id);
    if (members) members.push(session);
    else groups.set(id, [session]);
  }
  const assigned = sessions.map((session) => {
    const id = session.projectMembership?.projectId;
    return id ? { ...session, folderId: coordinators.get(id)?.folderId ?? null } : session;
  });
  const folderListing = sessionFolderListing(assigned, folders, opts);
  const knownFolders = new Set(folders.map((folder) => folder.id));
  const inScope = (folderId: string | null | undefined) => opts.folderId
    ? folderId === opts.folderId
    : !folderId || !knownFolders.has(folderId);
  const loose = sessions.filter((session) => !session.projectMembership && inScope(session.folderId));
  if (!groups.size) return flat(loose, opts.folderId ? [] : folderListing.folders);

  const summaries = new Map(projects.map((project) => [project.id, project]));
  const rows: SessionProjectRow<T>[] = [];
  for (const [projectId, members] of groups) {
    const coordinator = coordinators.get(projectId) ?? null;
    const folderId = coordinator?.folderId ?? null;
    if (!inScope(folderId)) continue;
    const summary = summaries.get(projectId);
    const membership = members[0].projectMembership!;
    const content = opts.contentSessions ? [...new Map([
      ...opts.contentSessions.filter((session) => session.projectMembership?.projectId === projectId),
      ...members,
    ].map((session) => [session.id, session])).values()] : members;
    const lines = new Map(content.map((session) => [session.id, opts.line(session)]));
    const coordinatorLine = coordinator ? (lines.get(coordinator.id) ?? opts.line(coordinator)) : null;
    const waiting = content.filter((session) => lines.get(session.id)?.tone === 'approval');
    waiting.sort((a, b) => {
      const left = waitingInstant(a);
      const right = waitingInstant(b);
      if (left !== right) {
        if (!Number.isFinite(left)) return 1;
        if (!Number.isFinite(right)) return -1;
        return left - right;
      }
      return a.id.localeCompare(b.id);
    });
    let line: SessionProjectLine;
    let target: SessionProjectRow<T>['target'];
    if (coordinatorLine?.tone === 'approval') {
      line = coordinatorLine;
      target = { kind: 'session', id: coordinator!.id };
    } else if (waiting.length) {
      const lead = waiting[0];
      line = { text: SESSION_PROJECT_COPY.waitingSession(lines.get(lead.id)!.text, lead.title ?? ''), tone: 'approval' };
      target = { kind: 'session', id: lead.id };
    } else if (coordinator && summary?.attention?.coordinatorItems) {
      const held = summary.attention.coordinatorItems;
      const copy = SESSION_PROJECT_COORDINATOR_COPY[held.leadKind];
      line = { text: [copy, elapsedLabel(held.oldestWaitingSince, opts.now ?? Date.now())].filter(Boolean).join(' · '), tone: 'running' };
      target = { kind: 'session', id: coordinator.id };
    } else if (coordinatorLine) {
      line = coordinatorLine;
      target = { kind: 'session', id: coordinator!.id };
    } else {
      line = { text: SESSION_PROJECT_COPY.noCoordinator, tone: 'preview' };
      target = { kind: 'project', id: projectId };
    }
    const latest = members.reduce((newest, session) => instant(session.lastTurnAt ?? session.createdAt) > instant(newest.lastTurnAt ?? newest.createdAt) ? session : newest);
    const motions = opts.runnerOffline ? [] : members.map(opts.motion);
    const needsYou = members.some((session) => lines.get(session.id)?.tone === 'approval');
    const running = motions.includes('spinner');
    const jobs = motions.includes('pulse');
    rows.push({
      id: projectId,
      projectId,
      title: summary?.title ?? membership.projectTitle,
      status: summary?.status ?? membership.projectStatus,
      members: [...members],
      sessionCount: new Set([...content.map((session) => session.id), ...(coordinator ? [coordinator.id] : [])]).size,
      coordinator,
      folderId,
      pinnedAt: coordinator?.pinnedAt ?? null,
      lastTurnAt: latest.lastTurnAt ?? latest.createdAt,
      createdAt: coordinator?.createdAt ?? latest.createdAt,
      needsYou,
      running,
      jobs,
      indicator: needsYou ? 'needs-you' : running ? 'running' : jobs ? 'jobs' : null,
      line,
      target,
      taskCounts: summary?.taskCounts,
      runningCount: summary?.buckets.running ?? motions.filter((motion) => motion === 'spinner').length,
    });
  }
  const entries: SessionProjectEntry<T>[] = [
    ...loose.map((session) => ({ ...session, kind: 'session' as const })),
    ...rows.map((project) => ({ ...project, kind: 'project' as const })),
  ];
  entries.sort((a, b) => {
    if (opts.view === 'open' && !!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
    const left = instant(a.lastTurnAt ?? a.createdAt);
    const right = instant(b.lastTurnAt ?? b.createdAt);
    return left === right ? 0 : left > right ? -1 : 1;
  });
  return { folders: opts.folderId ? [] : folderListing.folders, projects: rows, sessions: loose, entries };
}
