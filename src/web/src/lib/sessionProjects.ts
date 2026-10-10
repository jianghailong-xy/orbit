// Project rows in the session list (docs/session-list-projects-design.md §4, §6, §7).
// Session readings come from the same functions the ordinary rows use.
import {
  INTEGRATION_CLAIM_STALE_MS,
  type CoordinatorLeadKind,
  type ProjectListIntegration,
  type ProjectSidebarTaskCounts,
  type ProjectStartSettings,
  type SessionProjectMembership,
} from '@orbit/shared';
import type { SessionFolder } from '../api';
import { JOB_PHASES, JOB_WORDS } from '../components/ProjectPanoramaHeader';
import { elapsedLabel, type SidebarProject } from './projectAttention';
import { mainBranchName, runLineMain } from './projectStart';
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
  /** The page's subtitle before its members have been read: no count it cannot vouch for yet. */
  pageSubtitleLoading: 'Project',
  /** The progress line of a project whose task counts no read has given: its status. */
  pageStatus: (status: string) => ({ OPEN: 'Open', DONE: 'Done', CANCELLED: 'Cancelled' } as Record<string, string>)[status] ?? status,
  pageEmpty: 'No sessions',
  pageUnread: 'Couldn’t load sessions',
  retry: 'Retry',
  coordinatorSection: 'Coordinator',
  pageProgress: (done: number, total: number, running: number) => `${done}/${total} done · ${running} running`,
  // A project nobody has started, and its start row (docs/mocks/project-start-sessions-page).
  pageNotStarted: (tasks: number) => `Not started · ${tasks} ${tasks === 1 ? 'task' : 'tasks'}`,
  startAsked: (ago: string) => `asked ${ago}`,
  /** Directly into the main branch the start opens with (`startMainBranch`), or the suggestion's own
   *  where no integration read is at hand. */
  startSuggestion: (
    settings: Pick<ProjectStartSettings, 'line' | 'automatic' | 'maxConcurrentTasks' | 'upstreamRef'>,
    main: string = mainBranchName(settings.upstreamRef),
  ) =>
    `${settings.line === 'MAIN' ? runLineMain(main) : 'Project branch'} · Automatic ${settings.automatic ? 'on' : 'off'} · ${settings.maxConcurrentTasks} at a time`,
  startReview: 'Review and start',
  startNotAsked: 'The coordinator hasn’t asked yet',
  startHint: 'Opens the start card: the criteria, the plan and how it runs.',
} as const;

// Capitalized COORDINATOR_LEAD_COPY; literals also let OrbitKit read the shared wording.
export const SESSION_PROJECT_COORDINATOR_COPY: Record<CoordinatorLeadKind, string> = {
  INTEGRATION_CONFLICT: 'Resolving a merge conflict',
  INTEGRATION_CHECK_FAILED: 'Checks failed',
  INTEGRATION_ERROR: 'Handling an integration error',
  TASK_FAILED: 'Handling a failed task',
  DELIVERY_REVIEW: 'Reviewing a delivery',
};

/** A runner that has stopped reporting, in this row's own scale: "no report for 11m", or
 *  "no report yet" for a claim nothing has come back from. The same fact the project page's row
 *  states as `LANDING_NO_REPORT`, and never a verdict about the work — a timeout is the job's own,
 *  and the server words it in the landing's `blockingReason`. OrbitKit: `SessionProjectCopy.landingSilentWord`. */
export function landingSilentWord(minutes: number | null): string {
  return minutes === null ? 'no report yet' : `no report for ${minutes}m`;
}

/** The project page's landing line, shortened for a row that is not redrawn every second:
 *  "Merge to main · queued · 13m", "Landing · checking · 4m · <task>". Null when nothing is in
 *  flight; a server that sends only the count gets "Landing · N jobs".
 *
 *  A job whose runner has stopped reporting says so in the state slot — "no report for 11m", or
 *  "no report yet" for one that has never reported (`LANDING_NO_REPORT`, the same claim lease the
 *  project page's row reads it with). That is a fact about the REPORTS: this line never calls a
 *  silent job a timed-out one, because a timeout is the job's own verdict and lives in the server's
 *  `blockingReason` (`LandTaskStatus` prints it as it is). OrbitKit's `SessionProjectCopy.landingLine`
 *  is this line's other half. */
export function sessionProjectLandingLine(
  integration: ProjectListIntegration | null | undefined,
  now: number,
): SessionProjectLine | null {
  const count = integration?.activeJobCount ?? 0;
  const job = integration?.inFlight;
  if (!job) return count > 0 ? { text: `Landing · ${count} ${count === 1 ? 'job' : 'jobs'}`, tone: 'queued' } : null;
  const heartbeat = Date.parse(job.heartbeatAt ?? '');
  const reported = Number.isFinite(heartbeat);
  // The runner has gone quiet — the same claim lease the project page's landing row reads the same
  // fact with (`LANDING_NO_REPORT`): how long it has been silent, never a verdict about the work.
  const silent = job.state === 'RUNNING' && (!reported || now - heartbeat > INTEGRATION_CLAIM_STALE_MS);
  const running = job.state === 'RUNNING' && !silent;
  const word = (job.kind && JOB_WORDS[job.kind as keyof typeof JOB_WORDS]) || 'Integration';
  const state = job.state !== 'RUNNING' ? 'queued'
    : silent ? landingSilentWord(reported ? Math.max(0, Math.floor((now - heartbeat) / 60_000)) : null)
      : (job.phase && JOB_PHASES[job.phase as keyof typeof JOB_PHASES]) || 'running';
  return {
    text: [count > 1 ? `${word} ${count} jobs` : word, state, elapsedLabel(job.startedAt, now),
      count > 1 ? null : job.taskTitle].filter(Boolean).join(' · '),
    tone: running ? 'running' : 'queued',
  };
}

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
    const landing = sessionProjectLandingLine(summary?.integration, opts.now ?? Date.now());
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
    } else if (coordinator && coordinatorLine && !opts.runnerOffline && opts.motion(coordinator) === 'spinner') {
      line = coordinatorLine;
      target = { kind: 'session', id: coordinator.id };
    } else if (landing) {
      line = landing;
      target = coordinator ? { kind: 'session', id: coordinator.id } : { kind: 'project', id: projectId };
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
