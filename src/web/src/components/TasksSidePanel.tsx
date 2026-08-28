import {
  ApiOutlined,
  BgColorsOutlined,
  CaretDownOutlined,
  CheckOutlined,
  DesktopOutlined,
  DisconnectOutlined,
  FolderOutlined,
  InboxOutlined,
  LoadingOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ProjectOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Avatar, Dropdown, Tooltip } from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import type {
  PlanUsage,
  RunnerEngineHealth,
  RunnerInstallState,
  RunnerModelCatalog,
  RuntimeDefaultModels,
  SlashCommandInfo,
} from '@orbit/shared';
import { api, clearToken, logoutSession } from '../api';
import { routeId, encodeId } from '../lib/idCodec';
import { workspaceSessionCountsQuery, meQuery, sessionQuery } from '../lib/queries';
import {
  groupWorkspacesByRunner,
  orderWorkspaceGroupsByRunners,
  orderWorkspaces,
  workspaceRunnerId,
} from '../lib/workspaceOrder';
import { useThemeMode, type ThemeMode } from '../lib/theme';
import { taskPagePath, type TaskPage } from '../lib/taskPages';
import { judgmentInboxPath, type JudgmentInboxPage } from '../lib/judgments';
import {
  projectAcceptanceInboxPath,
  type ProjectAcceptanceInboxPage,
} from '../lib/projectAcceptance';
import { outcomeInboxPath, type OutcomeHumanInbox } from '../lib/outcomeSurfaces';

const IS_MAC_PLATFORM =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

/** Projects is a global destination: Cmd/Ctrl + P opens it from every routed view. */
export function projectsShortcutLabel(isMac = IS_MAC_PLATFORM): string {
  return isMac ? '⌘P' : 'Ctrl P';
}

type ProjectsShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'preventDefault' | 'shiftKey'
>;

type NavActivationEvent = Pick<KeyboardEvent, 'key' | 'preventDefault'>;

/** A div-based legacy nav row still behaves like the link its ARIA role promises. */
export function handleNavActivation(
  event: NavActivationEvent,
  open: () => void,
): boolean {
  if (event.key !== 'Enter') return false;
  event.preventDefault();
  open();
  return true;
}

/** Framework-independent handler for the Projects keyboard contract. */
export function handleProjectsShortcut(
  event: ProjectsShortcutEvent,
  openProjects: () => void,
): boolean {
  if (
    !(event.metaKey || event.ctrlKey) ||
    event.altKey ||
    event.shiftKey ||
    event.key.toLowerCase() !== 'p'
  ) {
    return false;
  }
  // Take the chord from the browser's Print command before changing routes.
  event.preventDefault();
  openProjects();
  return true;
}

interface TopNavItem {
  key: string;
  icon: ReactNode;
  label: string;
  shortcut?: string;
}

// Fixed product destinations (Admin is appended for admins below). Individual Workspace rows are
// primary destinations in their own right, so there is no proxy Workspaces parent here.
const TOP: TopNavItem[] = [
  { key: 'judgments', icon: <InboxOutlined />, label: '待我判定' },
  {
    key: 'projects',
    icon: <ProjectOutlined />,
    label: 'Projects',
    shortcut: projectsShortcutLabel(),
  },
  { key: 'runners', icon: <DesktopOutlined />, label: 'Runners' },
  // Providers is for everyone: each user manages their own (BYOK) list; admins additionally
  // manage the shared ones on the same page.
  { key: 'providers', icon: <ApiOutlined />, label: 'Providers' },
];

// The left sidebar is user-resizable; the chosen width persists across refreshes.
const SIDEBAR_WIDTH_KEY = 'orbit:sidebar-width';
// Whether the user collapsed the panel to its icon rail; persisted like the width.
const SIDEBAR_COLLAPSED_KEY = 'orbit:sidebar-collapsed';
const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;
const clampWidth = (w: number): number =>
  Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w));

/** The first nine Workspace rows own the matching global Cmd/Ctrl + number shortcut. */
export function workspaceShortcutLabel(index: number, isMac = IS_MAC_PLATFORM): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= 9) return null;
  return isMac ? `⌘${index + 1}` : `Ctrl ${index + 1}`;
}

export interface Runner {
  id: string;
  name: string;
  displayName?: string | null;
  online?: boolean;
  maxConcurrent?: number;
  // Persisted order of runner groups/cards; null until assigned by migration or a reorder.
  position?: number | null;
  // Live sessions currently occupying this runner's slots (of maxConcurrent).
  activeSessions?: number;
  // Extra fields returned by GET /runners, shown read-only on the runner detail page.
  hostname?: string | null;
  labels?: string[];
  version?: string | null;
  status?: string;
  lastHeartbeatAt?: string | null;
  enrolledAt?: string | null;
  // Slash commands / skills the runner reported, for the composer's `/` autocomplete.
  commands?: SlashCommandInfo[];
  skills?: SlashCommandInfo[];
  // Provider quota for the account(s) this runner uses.
  planUsage?: PlanUsage | null;
  // Runtime model catalog reported by the runner.
  modelCatalog?: RunnerModelCatalog | null;
  // Effective default model reported by each built-in runtime on this runner.
  runtimeDefaultModels?: RuntimeDefaultModels;
  // Whether this runner's process is root, which costs it one permission mode: claude refuses
  // Bypass under root and exits before its first message. undefined/null = a runner too old to
  // report it, which stays unrestricted.
  runsAsRoot?: boolean | null;
  // Per-engine health this runner reported (installed / version / signed in). null when it has
  // never reported — which is not the same as "nothing installed", so the two stay distinct.
  engines?: RunnerEngineHealth[] | null;
  // The engine install this runner has in flight, if any.
  install?: RunnerInstallState | null;
}

interface Workspace {
  id: string;
  name: string;
  // ISO-8601 creation timestamp; the sidebar falls back to it (oldest-first) for
  // workspaces that have never been dragged into a custom slot.
  createdAt: string;
  // Drag-to-reorder slot (0-based). null until the user reorders, so it sorts last.
  position?: number | null;
  // The machine this workspace belongs to (null for config-only workspaces); a workspace
  // with no runner has no console to open. GET /workspaces embeds the runner's name/
  // displayName so the sidebar can paint the inline runner metadata before its second query lands.
  runnerId?: string | null;
  runner?: { id: string; name?: string; displayName?: string | null } | null;
}

export function workspaceCountsPollInterval(
  counts: readonly { active: number; running?: number }[],
): number {
  return counts.some((count) => count.active > 0 || (count.running ?? 0) > 0) ? 5_000 : 15_000;
}

/** Show Offline only from an authoritative Runner snapshot. `undefined` means the runner query is
 * still loading (or an older payload omitted the flag), while a null id is a config-only Workspace;
 * neither should flash a false disconnection warning. */
export function workspaceRunnerIsOffline(
  runnerId: string | null,
  runnerOnline: boolean | undefined,
): boolean {
  return runnerId !== null && runnerOnline === false;
}

interface TaskList {
  id: string;
  title: string;
  _count?: { tasks: number };
  // How many of the list's tasks are executing right now (have a PENDING/RUNNING
  // session). >0 turns the list's dot into a pulsing blue "running" indicator.
  runningTasks?: number;
  // True once the list is finished: it has tasks and every one is DONE. Turns the
  // dot green and mutes the title.
  completed?: boolean;
}

async function logout() {
  await logoutSession(); // revoke the refresh token server-side (best-effort) before clearing
  clearToken();
  location.href = '/login';
}

export function TasksSidePanel({ open = false }: { open?: boolean }) {
  const loc = useLocation();
  const navigate = useNavigate();
  // The signed-in user, for the footer avatar + name. Shares its key with the account
  // page (and the BootGate pre-warm) so it reads straight from cache.
  const me = useQuery(meQuery());
  const judgments = useQuery({
    queryKey: ['judgments', 'open', 'nav-count'],
    queryFn: () => api<JudgmentInboxPage>(judgmentInboxPath({ status: 'OPEN', limit: 1 })),
    refetchInterval: 15_000,
  });
  const projectAcceptance = useQuery({
    queryKey: ['project-acceptance', 'pending', 'nav-count'],
    queryFn: () => api<ProjectAcceptanceInboxPage>(projectAcceptanceInboxPath(1)),
    refetchInterval: 15_000,
  });
  const outcomeDecisions = useQuery({
    queryKey: ['outcomes', 'inbox', 'nav-count'],
    queryFn: () => api<OutcomeHumanInbox>(outcomeInboxPath(1)),
    refetchInterval: 15_000,
  });
  const openJudgmentCount = (judgments.data?.total ?? 0)
    + (projectAcceptance.data?.total ?? 0)
    + (outcomeDecisions.data?.total ?? 0);
  const { mode, setMode } = useThemeMode();
  // Admins get an extra top-nav entry: user management.
  const navItems: TopNavItem[] =
    me.data?.role === 'ADMIN'
      ? [...TOP, { key: 'admin', icon: <TeamOutlined />, label: 'Admin' }]
      : TOP;

  // The open workspace comes from /workspaces/<id>; behind a /sessions/<id> link, resolve
  // it from that session so its row highlights there too. The session query reuses
  // the console's cache (same key via sessionQuery), so it adds no extra request.
  // Splat (`/*`) so a sub-route like /workspaces/<id>/new still resolves the workspace;
  // a bare `/workspaces/:id` matches exactly and would miss /new, falling back to the
  // "Runners" highlight. params.id stays the workspace id under the splat.
  // `agents` is the pre-rename URL people still have bookmarked.
  const workspacesMatch = useMatch('/workspaces/:id/*');
  const agentsMatch = useMatch('/agents/:id/*');
  const openWorkspaceId = routeId((workspacesMatch ?? agentsMatch)?.params.id);
  const sessionId = routeId(useMatch('/sessions/:id')?.params.id);
  const sessionQ = useQuery({
    ...sessionQuery(sessionId),
    // Keep the previous session's data while the next one loads so activeWorkspaceId
    // never blips to null between sessions — otherwise the active Workspace row briefly goes
    // dark on each ArrowUp/ArrowDown.
    placeholderData: keepPreviousData,
  });
  // Only resolve the workspace from session data while we're actually on a session
  // route. keepPreviousData (above) keeps the last session's data around to avoid
  // flicker between sessions, but that stale data would otherwise keep a workspace
  // row highlighted after navigating away to a list or top-nav route.
  const activeWorkspaceId = openWorkspaceId ?? (sessionId ? sessionQ.data?.workspace?.id : null) ?? null;

  // Workspace/session routes have no proxy parent in TOP: a resolved Workspace highlights its own
  // row, while an unresolved deep link briefly leaves the fixed nav unselected. Runner management
  // remains scoped to Runners.
  const routeKey = activeWorkspaceId
    ? '' // scoped to one workspace — its row highlights below, no top item
    : loc.pathname.startsWith('/workspaces/') ||
        loc.pathname.startsWith('/sessions/') ||
        loc.pathname.startsWith('/agents/')
      ? ''
      : loc.pathname.startsWith('/judgments')
        ? 'judgments'
        : loc.pathname.startsWith('/runner')
          ? 'runners'
          : loc.pathname.startsWith('/projects/')
            ? 'projects'
            : loc.pathname.startsWith('/lists/')
              ? loc.pathname.slice('/lists/'.length)
              : loc.pathname.slice(1);
  const [sel, setSel] = useState(routeKey);
  useEffect(() => setSel(routeKey), [routeKey]);

  const [listOpen, setListOpen] = useState(true);
  const [completedOpen, setCompletedOpen] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return saved > 0 ? clampWidth(saved) : DEFAULT_SIDEBAR_WIDTH;
  });

  // Collapse the whole panel to a slim icon rail (desktop) — hands the content
  // region the full width back. Persisted so the choice survives a refresh.
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
  );
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  }, []);
  // Cmd/Ctrl + Backslash toggles the sidebar — the VS Code / Linear / Notion convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);

  // True only while the right-edge handle is being dragged. The width transition
  // (see .app-nav in index.css) is suppressed during a drag via the .resizing class
  // so the panel tracks the cursor instead of lagging behind by the transition.
  const [resizing, setResizing] = useState(false);

  // Drag the right-edge handle to resize; the final width is saved on release.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    // The panel hugs the viewport's left edge, so clientX is the target width.
    let next = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      next = clampWidth(ev.clientX);
      setSidebarWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setResizing(true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Runners carry both their persisted display order and the computed `online` flag. Poll on the
  // same 15s cadence as the Runners page so ordering and status stay in sync while the sidebar is up.
  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<Runner[]>('/runners'),
    refetchInterval: 15_000,
  });
  const runnerOnlineById = useMemo(
    () => new Map((runners.data ?? []).map((runner) => [runner.id, runner.online])),
    [runners.data],
  );
  // Runner id → display name (displayName || name), matching how the rest of the app labels a
  // machine. Reuses the already-loaded ['runners'] cache, so the group headers cost no extra request.
  const runnerLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of runners.data ?? []) m.set(r.id, r.displayName || r.name);
    return m;
  }, [runners.data]);

  // The "Workspaces" list is the user's workspace definitions (model + tools).
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => api<Workspace[]>('/workspaces') });
  // Base workspace order; the existing runner order remains a stable sort key, but runner is now
  // metadata rather than a visible/collapsible parent. Flattening every group keeps all workspaces
  // present as one compact list while preserving the familiar order and ⌘1‒9 shortcuts.
  const workspaceList = useMemo(() => orderWorkspaces(workspaces.data ?? []), [workspaces.data]);
  const orderedWorkspaces = useMemo(
    () =>
      orderWorkspaceGroupsByRunners(
        groupWorkspacesByRunner(workspaceList),
        runners.data ?? [],
      ).flatMap((group) => group.workspaces),
    [workspaceList, runners.data],
  );

  // User-created task lists shown in the "Task List" group below. Poll so the
  // per-list running indicator stays live: 5s while anything is running (mirrors the
  // task detail panel's busy-poll cadence), 15s when idle (same as the runner poll).
  const taskLists = useQuery({
    queryKey: ['task-lists'],
    queryFn: () => api<TaskList[]>('/task-lists'),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((l) => (l.runningTasks ?? 0) > 0) ? 5_000 : 15_000,
  });

  // Split lists into the active "Task List" group and the finished "Completed"
  // group. A list lands in Completed only once every task is DONE and nothing is
  // still running — a running task means work is in flight, so it stays active.
  const { activeLists, completedLists } = useMemo(() => {
    const active: TaskList[] = [];
    const completed: TaskList[] = [];
    for (const l of taskLists.data ?? []) {
      if (l.completed && (l.runningTasks ?? 0) === 0) completed.push(l);
      else active.push(l);
    }
    return { activeLists: active, completedLists: completed };
  }, [taskLists.data]);

  // Task count for the "No list" bucket. Ask the paged endpoint for one row plus the
  // aggregate instead of downloading every unlisted task into the sidebar.
  const unlistedTasks = useQuery({
    queryKey: ['tasks', 'unlisted-count'],
    queryFn: () => api<TaskPage>(taskPagePath({ limit: 1, listId: 'none' })),
    refetchInterval: 15_000,
  });
  const unlistedCount = unlistedTasks.data?.counts?.total ?? 0;

  // Per-workspace Open-session tallies, counted server-side. Polls faster while anything is live.
  // This used to fetch every open session and tally them here, which on an account with
  // thousands of sessions was the app's heaviest request — and it ran on a 5–15s loop for two
  // badges per workspace. Sessions with no workspace still belong to no row, as before.
  const sessionCounts = useQuery({
    ...workspaceSessionCountsQuery(),
    // Keep this small aggregate polling even with the control-plane stream connected: the
    // engineTurnActive/runningSubagents transitions behind `running` are intentionally finer than
    // its coarse session.updated events, so SSE alone cannot keep the spinner truthful.
    refetchInterval: (q) => workspaceCountsPollInterval(q.state.data ?? []),
  });
  // The "needs you" signal per workspace: how many of its Open sessions are blocked on an approval.
  // Lets a workspace row show its own attention count so you can jump straight to the workspace
  // that needs you.
  const workspaceNeedsYou = useMemo(
    () => new Map((sessionCounts.data ?? []).map((c) => [c.workspaceId, c.needsYou])),
    [sessionCounts.data],
  );
  // Unlike `active` (which also includes queued sessions), `running` mirrors the blue working
  // spinner in the Session list. A queued-only, online workspace keeps the normal empty slot.
  const workspaceRunning = useMemo(
    () => new Map((sessionCounts.data ?? []).map((c) => [c.workspaceId, c.running ?? 0])),
    [sessionCounts.data],
  );

  // Open a workspace's console — the same destination the runner detail page uses.
  // Config-only workspaces (no runner) have no console to open.
  const openWorkspace = useCallback(
    (a: Workspace) => {
      if (!(a.runner?.id ?? a.runnerId)) return;
      navigate(`/workspaces/${encodeId(a.id)}`);
    },
    [navigate],
  );

  const openTopNav = useCallback(
    (key: string) => navigate(`/${key}`),
    [navigate],
  );

  // Cmd/Ctrl + P opens Projects from every route. Like the other modifier shortcuts, it remains
  // active while an input is focused; preventDefault in the handler suppresses browser Print.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      handleProjectsShortcut(event, () => openTopNav('projects'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openTopNav]);

  // ⌘/Ctrl + 1‒9 opens the matching workspace in the list. The modifier chord never
  // produces text input, so it fires even while a text field is focused;
  // preventDefault stops the browser's own tab-switch on the same chord.
  useEffect(() => {
    const list = orderedWorkspaces;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9 || n > list.length) return;
      e.preventDefault();
      openWorkspace(list[n - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [orderedWorkspaces, openWorkspace]);

  const renderListRow = (l: TaskList) => {
    const key = encodeId(l.id);
    const running = (l.runningTasks ?? 0) > 0;
    // A running task means work is still in flight, so it outranks the
    // completed state even if every other task is already DONE.
    const completed = !running && !!l.completed;
    return (
      <div
        key={l.id}
        className={`tp-item inset ${sel === key ? 'active' : ''}`}
        onClick={() => {
          setSel(key);
          navigate(`/lists/${key}`);
        }}
      >
        <span
          className={`tp-list-dot ${running ? 'running' : completed ? 'done' : ''}`}
          title={
            running
              ? `${l.runningTasks} task(s) running`
              : completed
                ? 'All tasks done'
                : undefined
          }
        />
        <span className={`tp-label ${completed ? 'done' : ''}`}>{l.title}</span>
      </div>
    );
  };

  return (
    <aside
      className={`app-nav${open ? ' open' : ''}${collapsed ? ' collapsed' : ''}${resizing ? ' resizing' : ''}`}
      style={{ width: collapsed ? undefined : sidebarWidth }}
    >
      <div className="tp-brand">
        <span className="tp-brand-logo">
          <svg width={22} height={22} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="og-nav" x1="14" y1="12" x2="50" y2="54" gradientUnits="userSpaceOnUse">
                <stop stopColor="#5b8bff" />
                <stop offset="1" stopColor="#3370ff" />
              </linearGradient>
            </defs>
            <g transform="rotate(-26 32 32)">
              <ellipse cx="32" cy="32" rx="28" ry="12.5" stroke="url(#og-nav)" strokeWidth="3.4" opacity="0.6" />
              <circle cx="56" cy="25.6" r="5.4" fill="url(#og-nav)" />
            </g>
            <rect x="19" y="20" width="26" height="24" rx="6" fill="url(#og-nav)" />
            <path d="M25 27.5 L30 32 L25 36.5" stroke="#fff" strokeWidth="2.9" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="33" y1="35.8" x2="39.5" y2="35.8" stroke="#fff" strokeWidth="2.9" strokeLinecap="round" />
          </svg>
        </span>
        <span className="tp-brand-name">Orbit</span>
        <button
          type="button"
          className="tp-collapse-btn"
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </button>
      </div>

      {/* Collapsed-only icon rail: the fixed top-nav as icons. The dynamic lists (workspaces,
          task lists) have no icon form, so they fold away — expand to bring them back. The
          workspaces themselves stay as monogram avatars below. Shown only when collapsed, on desktop. */}
      <div className="tp-rail">
        {TOP.map((t) => (
          <div
            key={t.key}
            className={`tp-rail-item ${sel === t.key ? 'active' : ''}`}
            onClick={() => openTopNav(t.key)}
            onKeyDown={(event) => handleNavActivation(event, () => openTopNav(t.key))}
            role="link"
            tabIndex={0}
            aria-current={sel === t.key ? 'page' : undefined}
            title={`${t.label}${t.shortcut ? `  ${t.shortcut}` : ''}`}
          >
            <span className="tp-ico">{t.icon}</span>
            {t.key === 'judgments' && openJudgmentCount > 0 && (
              <span className="tp-rail-badge needs-you" aria-label={`${openJudgmentCount} open judgments`}>
                {openJudgmentCount > 99 ? '99+' : openJudgmentCount}
              </span>
            )}
          </div>
        ))}
        {/* The user's workspaces, kept reachable when collapsed: a monogram avatar each
            (workspaces have identity + exceptional/activity state + ⌘1‒9, so unlike the
            text-titled task lists they read fine as icons). Same order, same shortcuts. */}
        {orderedWorkspaces.length > 0 && <div className="tp-rail-divider" />}
        {orderedWorkspaces.map((a, i) => {
          const runnerId = workspaceRunnerId(a);
          const shortcutLabel = workspaceShortcutLabel(i);
          const runnerLabel =
            (runnerId ? runnerLabels.get(runnerId) : null) ??
            a.runner?.displayName ??
            a.runner?.name ??
            'Shared';
          return (
            <div
              key={a.id}
              className={`tp-rail-item ${a.id === activeWorkspaceId ? 'active' : ''}`}
              onClick={() => openWorkspace(a)}
              title={`${a.name} · ${runnerLabel}${shortcutLabel ? `  ${shortcutLabel}` : ''}`}
            >
              <span className="tp-rail-avatar">{(a.name.trim()[0] ?? '?').toUpperCase()}</span>
              <WorkspaceStateMark
                compact
                offline={workspaceRunnerIsOffline(
                  runnerId,
                  runnerId ? runnerOnlineById.get(runnerId) : undefined,
                )}
                running={(workspaceRunning.get(a.id) ?? 0) > 0}
                needsYou={workspaceNeedsYou.get(a.id) ?? 0}
                runnerLabel={runnerLabel}
              />
            </div>
          );
        })}
      </div>

      <div className="tp-scroll">
        <div className="tp-section">
          {navItems.map((t) => (
            <div
              key={t.key}
              className={`tp-item ${sel === t.key ? 'active' : ''}`}
              onClick={() => openTopNav(t.key)}
              onKeyDown={(event) => handleNavActivation(event, () => openTopNav(t.key))}
              role="link"
              tabIndex={0}
              aria-current={sel === t.key ? 'page' : undefined}
            >
              <span className="tp-ico">{t.icon}</span>
              <span className="tp-label">{t.label}</span>
              {t.key === 'judgments' && openJudgmentCount > 0 && (
                <span className="tp-count needs-you" aria-label={`${openJudgmentCount} open judgments`}>
                  {openJudgmentCount}
                </span>
              )}
              {t.shortcut && (
                <kbd
                  className="tp-count tp-nav-shortcut"
                  title={`Open ${t.label} with ${t.shortcut}`}
                >
                  {t.shortcut}
                </kbd>
              )}
            </div>
          ))}
        </div>

        <div className="tp-divider" />

        <div className="tp-group">
          {orderedWorkspaces.map((a, index) => {
            const runnerId = workspaceRunnerId(a);
            const runnerLabel =
              (runnerId ? runnerLabels.get(runnerId) : null) ??
              a.runner?.displayName ??
              a.runner?.name ??
              'Shared';
            return (
              <WorkspaceRow
                key={a.id}
                workspace={a}
                runnerLabel={runnerLabel}
                active={a.id === activeWorkspaceId}
                offline={workspaceRunnerIsOffline(
                  runnerId,
                  runnerId ? runnerOnlineById.get(runnerId) : undefined,
                )}
                running={(workspaceRunning.get(a.id) ?? 0) > 0}
                needsYou={workspaceNeedsYou.get(a.id) ?? 0}
                shortcutLabel={workspaceShortcutLabel(index)}
                onOpen={openWorkspace}
              />
            );
          })}
        </div>

        {orderedWorkspaces.length > 0 &&
          (unlistedCount > 0 || activeLists.length > 0 || completedLists.length > 0) && (
            <div className="tp-divider" />
          )}

        {/* "No list" is the complement of the lists below — tasks in no list at all.
            It's a peer of the Task List group, not a child of it, so it never reads
            as "a list called No list". Only shown when such tasks actually exist
            (workspace-created, or detached when a list was deleted); the usual case is
            none, and then it stays out of the way entirely. An icon (not a status
            dot) marks it as a view rather than a list. */}
        {unlistedCount > 0 && (
          <div className="tp-group">
            <div
              className={`tp-item ${sel === 'none' ? 'active' : ''}`}
              onClick={() => {
                setSel('none');
                navigate('/lists/none');
              }}
              title="Tasks not in any list (includes workspace-created tasks and ones detached when a list was deleted)"
            >
              <span className="tp-ico">
                <InboxOutlined />
              </span>
              <span className="tp-label">No list</span>
              <span className="tp-count">{unlistedCount}</span>
            </div>
          </div>
        )}

        {activeLists.length > 0 && (
          <div className="tp-group">
            <div className="tp-group-head" onClick={() => setListOpen((o) => !o)}>
              <span className="tp-group-name">Task List</span>
              <span className="tp-count">{activeLists.length}</span>
              <CaretDownOutlined className={`tp-caret ${listOpen ? '' : 'collapsed'}`} />
            </div>
            {listOpen && <>{activeLists.map(renderListRow)}</>}
          </div>
        )}

        {completedLists.length > 0 && (
          <div className="tp-group">
            <div className="tp-group-head" onClick={() => setCompletedOpen((o) => !o)}>
              <span className="tp-group-name">Completed</span>
              <span className="tp-count">{completedLists.length}</span>
              <CaretDownOutlined className={`tp-caret ${completedOpen ? '' : 'collapsed'}`} />
            </div>
            {completedOpen && <>{completedLists.map(renderListRow)}</>}
          </div>
        )}
      </div>

      <div className="tp-user">
        <Dropdown
          placement="topLeft"
          menu={{
            items: [
              {
                key: 'appearance',
                icon: <BgColorsOutlined />,
                label: 'Appearance',
                children: (
                  [
                    { key: 'system', label: 'System' },
                    { key: 'light', label: 'Light' },
                    { key: 'dark', label: 'Dark' },
                  ] as { key: ThemeMode; label: string }[]
                ).map((it) => ({
                  key: `theme-${it.key}`,
                  label: it.label,
                  icon:
                    mode === it.key ? (
                      <CheckOutlined />
                    ) : (
                      <span style={{ display: 'inline-block', width: 14 }} />
                    ),
                  onClick: () => setMode(it.key),
                })),
              },
              {
                key: 'profile',
                icon: <UserOutlined />,
                label: 'Profile',
                onClick: () => navigate('/settings/profile'),
              },
              {
                key: 'settings',
                icon: <SettingOutlined />,
                label: 'Settings',
                onClick: () => navigate('/settings'),
              },
              { type: 'divider' },
              { key: 'logout', icon: <LogoutOutlined />, label: 'Logout', onClick: logout },
            ],
          }}
        >
          <div className="tp-user-trigger">
            <Avatar
              size={32}
              icon={<UserOutlined />}
              style={{ background: 'var(--brand)', flex: 'none' }}
            />
            {me.data && (
              <span className="tp-user-name">{me.data.name || me.data.email}</span>
            )}
          </div>
        </Dropdown>
      </div>

      <div
        className="tp-resizer"
        role="separator"
        aria-orientation="vertical"
        onMouseDown={startResize}
      />
    </aside>
  );
}

/** The trailing status slot shared by the expanded row and collapsed rail.
 *
 * Attention wins first. In the expanded list, Runner availability lives on the leading folder;
 * this slot therefore stays empty for offline and merely suppresses a stale spinner. The compact
 * rail keeps its existing Disconnect overlay here because its avatar is a separate surface.
 */
export function WorkspaceStateMark({
  offline,
  running,
  needsYou,
  runnerLabel,
  compact = false,
}: {
  offline: boolean;
  running: boolean;
  needsYou: number;
  runnerLabel?: string;
  compact?: boolean;
}) {
  if (needsYou > 0) {
    const title = `${needsYou} ${needsYou === 1 ? 'session needs' : 'sessions need'} your reply`;
    return (
      <span
        className={compact ? 'tp-rail-badge needs-you' : 'tp-count needs-you'}
        title={title}
        aria-label={title}
      >
        {needsYou}
      </span>
    );
  }
  if (offline) {
    if (!compact) return null;
    const title = runnerLabel ? `${runnerLabel} is offline` : 'Runner offline';
    return (
      <Tooltip title={title}>
        <DisconnectOutlined
          className="tp-rail-offline"
          aria-label={title}
          style={{ color: 'var(--text-3)', fontSize: 16 }}
        />
      </Tooltip>
    );
  }
  if (running) {
    return (
      <Tooltip title="Running">
        <LoadingOutlined
          className={compact ? 'tp-rail-running' : 'tp-workspace-running'}
          spin
          aria-label="Session running"
          style={{ color: 'var(--brand)', fontSize: 16 }}
        />
      </Tooltip>
    );
  }
  return null;
}

// A compact, permanently visible workspace row. Its folder occupies the same icon column as the
// fixed first-level destinations above, so Workspace names share their label alignment. Runner is
// descriptive metadata on the same line, not a disclosure parent the user has to remember.
export function WorkspaceRow({
  workspace,
  runnerLabel,
  active,
  offline,
  running,
  needsYou,
  shortcutLabel,
  onOpen,
}: {
  workspace: Workspace;
  runnerLabel: string;
  active: boolean;
  offline: boolean;
  running: boolean;
  needsYou: number;
  shortcutLabel?: string | null;
  onOpen: (a: Workspace) => void;
}) {
  const offlineTitle = runnerLabel ? `${runnerLabel} is offline` : 'Runner offline';
  // Attention and disconnection remain higher priority than background activity. CSS reveals this
  // quiet mark on the expanded desktop sidebar; the mobile drawer keeps its trailing spinner.
  const showRunningDot = running && !offline && needsYou === 0;
  return (
    <div
      className={`tp-item ${active ? 'active' : ''}`}
      onClick={() => onOpen(workspace)}
    >
      <span
        className="tp-ico tp-workspace-icon"
        role={offline ? 'img' : undefined}
        aria-label={offline ? offlineTitle : undefined}
      >
        <FolderOutlined aria-hidden="true" />
        {offline && (
          <Tooltip title={offlineTitle}>
            <DisconnectOutlined
              className="tp-workspace-icon-offline"
              aria-hidden="true"
            />
          </Tooltip>
        )}
        {showRunningDot && (
          <span
            className="tp-workspace-icon-running"
            title="Running"
            role="img"
            aria-label="Workspace has a running session"
          />
        )}
      </span>
      <span className="tp-label tp-workspace-label">
        <span className="tp-workspace-name">{workspace.name}</span>
        <span className="tp-workspace-separator" aria-hidden="true">
          ·
        </span>
        <span className="tp-workspace-runner" title={runnerLabel}>
          {runnerLabel}
        </span>
      </span>
      {needsYou === 0 && shortcutLabel && (
        <kbd
          className="tp-count tp-workspace-shortcut"
          title={`Open workspace with ${shortcutLabel}`}
        >
          {shortcutLabel}
        </kbd>
      )}
      <WorkspaceStateMark
        offline={offline}
        running={running}
        needsYou={needsYou}
        runnerLabel={runnerLabel}
      />
    </div>
  );
}
