import {
  ApiOutlined,
  BgColorsOutlined,
  BookOutlined,
  CaretDownOutlined,
  CheckOutlined,
  CheckSquareOutlined,
  CodeOutlined,
  DesktopOutlined,
  DisconnectOutlined,
  FolderOutlined,
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
  RunnerCodexAccountRemoveState,
  RunnerEngineHealth,
  RunnerInstallState,
  RunnerModelCatalog,
  RuntimeDefaultModels,
  SlashCommandInfo,
} from '@orbit/shared';
import { api, clearToken, logoutSession } from '../api';
import { routeId, encodeId } from '../lib/idCodec';
import {
  meQuery,
  openProjectsQuery,
  sessionQuery,
  wikiSpacesQuery,
  workspaceSessionCountsQuery,
} from '../lib/queries';
import {
  groupWorkspacesByRunner,
  orderWorkspaceGroupsByRunners,
  orderWorkspaces,
  workspaceRunnerId,
} from '../lib/workspaceOrder';
import { useThemeMode, type ThemeMode } from '../lib/theme';
import {
  projectIsWorking,
  projectNeedsYouCount,
  sidebarProjects,
  type SidebarProject,
} from '../lib/projectAttention';
import { wikiProposalsToReview, wikiShown } from '../lib/wiki';

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
  {
    key: 'projects',
    icon: <ProjectOutlined />,
    label: 'Projects',
    shortcut: projectsShortcutLabel(),
  },
  // Tasks under Projects, in the iPhone drawer's order (Projects · Tasks · Wiki). It is the way into
  // the task lists too: they are picked from the Tasks page's title, as they are on the phone.
  { key: 'tasks', icon: <CheckSquareOutlined />, label: 'Tasks' },
  // The Wiki sits under Projects because it is the other thing a codebase has: Projects is the work
  // in it, and the Wiki is what the work learned. Its amber count is the proposals waiting for the
  // owner, which is the same `needs-you` pill a workspace row shows — and the same rule applies with
  // it: a row carrying an amber number shows no shortcut.
  { key: 'wiki', icon: <BookOutlined />, label: 'Wiki' },
  // No Following here: its watches are the waits agents keep for their own sessions, already shown
  // in each session's header and Watching strip, and those are what link to /following.
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

type WorkspaceStepEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'defaultPrevented' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey'
>;

/** Which way a keypress steps the open Workspace — Cmd/Ctrl + Down one row down, Cmd/Ctrl + Up one
 * row up — or null when it is not that chord, or not the sidebar's to take.
 *
 * In a text field the same chord moves the caret (to the field's start or end on a Mac, a paragraph
 * with Ctrl), so the field keeps it until the caret has nowhere further to go that way, the same wait
 * the composer's own Up recall makes for the first line. An empty field is at both ends. */
export function workspaceStepDirection(
  event: WorkspaceStepEvent,
  focused: Element | null,
): 1 | -1 | null {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return null;
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  // Already taken: the composer's slash/mention/reference menus and the search inputs move their
  // own highlight on any Up/Down, the chord included.
  if (event.defaultPrevented || event.isComposing) return null;
  const dir = event.key === 'ArrowDown' ? 1 : -1;
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
    const edge = dir === 1 ? focused.value.length : 0;
    // selectionStart is null on inputs without a caret (checkboxes and the like).
    if (
      focused.selectionStart !== null &&
      (focused.selectionStart !== edge || focused.selectionEnd !== edge)
    )
      return null;
  }
  return dir;
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
  // What Codex reset-credit admission reads about this machine: its declared capabilities and the
  // last heartbeat's lease owner and draining flag. Absent from control planes that predate it.
  capabilities?: string[];
  heartbeatLeaseOwner?: string | null;
  heartbeatDraining?: boolean | null;
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
  // The Codex account removal this runner has in flight, if any: which slot is going, and what the
  // machine said when it would not.
  codexAccountRemove?: RunnerCodexAccountRemoveState | null;
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
  counts: readonly { active: number; running?: number; jobs?: number }[],
): number {
  // A job in flight counts as live here too: its whole point is that it can start and end while
  // nobody is generating, and at the slow cadence the pulse would arrive up to fifteen seconds
  // after the work did — long enough to read as a stale mark rather than as activity.
  return counts.some(
    (count) => count.active > 0 || (count.running ?? 0) > 0 || (count.jobs ?? 0) > 0,
  )
    ? 5_000
    : 15_000;
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
  const { mode, setMode } = useThemeMode();
  // The Wiki's amber count: the proposals waiting for the owner, summed over every space (a wiki
  // belongs to the account, and Review's own page asks across all of them). Its own key root, so the
  // control plane's `wiki.changed` refresh reaches it and nothing else has to.
  const wikiSpaces = useQuery({ ...wikiSpacesQuery(), enabled: !!me.data });
  const wikiPending = (wikiSpaces.data ?? []).reduce((sum, space) => sum + (space.pendingOps ?? 0), 0);
  // No Wiki row at all for an account the server has not switched the wiki on for (WIKI_DISABLED):
  // an entry that led to a refusal would be worse than none.
  const topItems = wikiShown(wikiSpaces) ? TOP : TOP.filter((t) => t.key !== 'wiki');
  // Admins get an extra top-nav entry: user management.
  const navItems: TopNavItem[] =
    me.data?.role === 'ADMIN'
      ? [...topItems, { key: 'admin', icon: <TeamOutlined />, label: 'Admin' }]
      : topItems;

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
  //
  // Nor is the placeholder's workspace read: a workspace switch lands on one of the new
  // workspace's sessions, so the placeholder is a session of the workspace just left, and the row
  // would jump back there until the new detail arrived (and Cmd/Ctrl + Up/Down step from there).
  // While the placeholder stands, the row already active holds.
  const [heldWorkspaceId, setHeldWorkspaceId] = useState<string | null>(null);
  const activeWorkspaceId =
    openWorkspaceId ??
    (sessionId
      ? sessionQ.isPlaceholderData
        ? heldWorkspaceId
        : (sessionQ.data?.workspace?.id ?? null)
      : null);
  useEffect(() => setHeldWorkspaceId(activeWorkspaceId), [activeWorkspaceId]);

  // The open projects, which close the rail the way they close the iPhone drawer (below).
  const projects = useQuery(openProjectsQuery());
  const openProjects = useMemo(() => sidebarProjects(projects.data ?? []), [projects.data]);
  // A project's own page lights its row in that group rather than the Projects entry, which stands
  // for the index — the drawer's rule. A project the group does not list (a closed one) keeps the
  // entry lit instead, so the rail still says where you are.
  const openProjectId = routeId(useMatch('/projects/:id/*')?.params.id);
  const projectRowKey =
    openProjectId && openProjects.some((p) => encodeId(p.id) === openProjectId)
      ? `project:${openProjectId}`
      : null;

  // Workspace/session routes have no proxy parent in TOP: a resolved Workspace highlights its own
  // row, while an unresolved deep link briefly leaves the fixed nav unselected. Runner management
  // remains scoped to Runners.
  const routeKey = activeWorkspaceId
    ? '' // scoped to one workspace — its row highlights below, no top item
    : loc.pathname.startsWith('/workspaces/') ||
        loc.pathname.startsWith('/sessions/') ||
        loc.pathname.startsWith('/agents/')
      ? ''
      : loc.pathname.startsWith('/runner')
        ? 'runners'
        : loc.pathname.startsWith('/projects/')
          ? (projectRowKey ?? 'projects')
          // Every wiki route — a space, a topic, an entry's drawer, Review — is the Wiki's own
          // destination, so the row stays lit across all of them.
          : loc.pathname === '/wiki' || loc.pathname.startsWith('/wiki/')
            ? 'wiki'
            // Every task route — all tasks, one task, a list, the tasks in none — is the Tasks
            // page, whose title picks among them.
            : loc.pathname.startsWith('/tasks/') || loc.pathname.startsWith('/lists/')
              ? 'tasks'
              : loc.pathname.slice(1);
  const [sel, setSel] = useState(routeKey);
  useEffect(() => setSel(routeKey), [routeKey]);

  const [projectsOpen, setProjectsOpen] = useState(true);

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
  // Neither of the two above: sessions with a background JOB in flight. The rail was silent about
  // these — a workspace running a build or a stress test, with nobody generating in it, looked
  // exactly like one that had left a dev server up. Work in flight is activity, so the workspace
  // dot lights up brand blue here too; what still separates it from the generating dot is motion
  // (breathing, not still), never colour.
  const workspaceJobs = useMemo(
    () => new Map((sessionCounts.data ?? []).map((c) => [c.workspaceId, c.jobs ?? 0])),
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

  // ⌘/Ctrl + Up/Down steps to the Workspace above/below the open one in the list's order — the
  // session list's own Up/Down, one level up, stopping at the ends the same way. With no Workspace
  // open there is nothing to step from, so the chord stays the browser's: a long page's jump to its
  // top or bottom.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const onKey = (e: KeyboardEvent) => {
      const dir = workspaceStepDirection(e, document.activeElement);
      if (dir === null) return;
      // Taken even at the first or last row: the browser's own use of the chord would jump the
      // conversation to its top or bottom, which is not what "the Workspace above" asked for.
      e.preventDefault();
      const from = orderedWorkspaces.findIndex((a) => a.id === activeWorkspaceId);
      const next = from === -1 ? undefined : orderedWorkspaces[from + dir];
      // A row with no runner has no console, so openWorkspace ignores it; such rows sort last (the
      // Shared group), so landing on one is the end of the list.
      if (next) openWorkspace(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeWorkspaceId, orderedWorkspaces, openWorkspace]);

  const openProject = (project: SidebarProject) => {
    const key = encodeId(project.id);
    setSel(`project:${key}`);
    navigate(`/projects/${key}`);
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
          projects) have no icon form, so they fold away — expand to bring them back. The
          workspaces themselves stay as monogram avatars below. Shown only when collapsed, on desktop. */}
      <div className="tp-rail">
        {topItems.map((t) => (
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
            {t.key === 'wiki' && wikiPending > 0 && (
              <span className="tp-rail-badge needs-you">{wikiPending}</span>
            )}
          </div>
        ))}
        {/* The user's workspaces, kept reachable when collapsed: a monogram avatar each
            (workspaces have identity + exceptional/activity state + ⌘1‒9, so unlike the
            text-titled projects they read fine as icons). Same order, same shortcuts. */}
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
                jobs={workspaceJobs.get(a.id) ?? 0}
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
              {t.key === 'wiki' && wikiPending > 0 ? (
                <span
                  className="tp-count needs-you"
                  title={wikiProposalsToReview(wikiPending)}
                  aria-label={wikiProposalsToReview(wikiPending)}
                >
                  {wikiPending}
                </span>
              ) : (
                t.shortcut && (
                  <kbd
                    className="tp-count tp-nav-shortcut"
                    title={`Open ${t.label} with ${t.shortcut}`}
                  >
                    {t.shortcut}
                  </kbd>
                )
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
                jobs={workspaceJobs.get(a.id) ?? 0}
                needsYou={workspaceNeedsYou.get(a.id) ?? 0}
                shortcutLabel={workspaceShortcutLabel(index)}
                onOpen={openWorkspace}
              />
            );
          })}
        </div>

        {orderedWorkspaces.length > 0 && openProjects.length > 0 && <div className="tp-divider" />}

        {/* The open projects close the rail, as they close the iPhone drawer: the ones waiting on
            you first, then by the newest activity (lib/projectAttention `sidebarProjects`). The
            task lists that stood here are picked from the Tasks page's title now, as the phone
            picks them from its Tasks page. Closed projects are the Projects page's to list. */}
        {openProjects.length > 0 && (
          <div className="tp-group">
            <div className="tp-group-head" onClick={() => setProjectsOpen((o) => !o)}>
              <span className="tp-group-name">Projects</span>
              <span className="tp-count">{openProjects.length}</span>
              <CaretDownOutlined className={`tp-caret ${projectsOpen ? '' : 'collapsed'}`} />
            </div>
            {projectsOpen &&
              openProjects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  active={sel === `project:${encodeId(project.id)}`}
                  onOpen={openProject}
                />
              ))}
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

/**
 * One open project in the rail's Projects group. The same two facts the iPhone drawer marks a
 * project row with (OrbitKit `drawerMark`), each in the slot this rail already gives it: work in
 * flight is the breathing dot at the head, where the task-list rows drew theirs and a Workspace
 * draws its activity; the items waiting on you are the amber count at the far end, the pill a
 * Workspace counts its waiting sessions with. Both can show at once — they answer different
 * questions.
 */
export function ProjectRow({
  project,
  active,
  onOpen,
}: {
  project: SidebarProject;
  active: boolean;
  onOpen: (project: SidebarProject) => void;
}) {
  const working = projectIsWorking(project);
  const needsYou = projectNeedsYouCount(project);
  const waiting = `${needsYou} waiting on you`;
  return (
    <div className={`tp-item inset ${active ? 'active' : ''}`} onClick={() => onOpen(project)}>
      <span className={`tp-list-dot ${working ? 'running' : ''}`} title={working ? 'Running' : undefined} />
      <span className="tp-label">{project.title}</span>
      {needsYou > 0 && (
        <span className="tp-count needs-you" title={waiting} aria-label={waiting}>
          {needsYou}
        </span>
      )}
    </div>
  );
}

/** The trailing status slot shared by the expanded row and collapsed rail.
 *
 * In the expanded list — the desktop sidebar and the <=960px drawer alike — this slot is the
 * needs-you count's alone: activity and Runner availability live on the leading folder, so every
 * row's marks line up in one column whether or not a count sits at the row's far end. The compact
 * rail pins the count to the avatar's top corner and activity to its bottom one: beside it rather
 * than replaced by it, because the two answer different questions and the server leaves the
 * sessions waiting on you out of `running`/`jobs`. The rail keeps its existing Disconnect overlay
 * in that bottom corner because its avatar is a separate surface, and a count still outranks it.
 */
export function WorkspaceStateMark({
  offline,
  running,
  jobs = 0,
  needsYou,
  runnerLabel,
  compact = false,
}: {
  offline: boolean;
  running: boolean;
  /** Sessions in this workspace with a background job in flight — see `workspaceJobs`. */
  jobs?: number;
  needsYou: number;
  runnerLabel?: string;
  compact?: boolean;
}) {
  let badge: ReactNode = null;
  if (needsYou > 0) {
    const title = `${needsYou} ${needsYou === 1 ? 'session needs' : 'sessions need'} your reply`;
    badge = (
      <span
        className={compact ? 'tp-rail-badge needs-you' : 'tp-count needs-you'}
        title={title}
        aria-label={title}
      >
        {needsYou}
      </span>
    );
  }
  if (!compact) return badge;
  if (offline) {
    if (badge) return badge;
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
      <>
        <Tooltip title="Running">
          <LoadingOutlined
            className="tp-rail-running"
            spin
            aria-label="Session running"
            style={{ color: 'var(--brand)', fontSize: 16 }}
          />
        </Tooltip>
        {badge}
      </>
    );
  }
  // Below the spinner and said in the terminal glyph's own words: something is running here, but
  // nobody is generating. A left-up process does not qualify (the server counts only jobs with an
  // end) — otherwise this slot would be lit for the rest of the workspace's life.
  if (jobs > 0) {
    const title = `${jobs} background ${jobs === 1 ? 'job' : 'jobs'} running`;
    return (
      <>
        <Tooltip title={title}>
          <CodeOutlined
            // In the collapsed rail this mark sits at the avatar's corner like the spinner it
            // replaces, and the desktop rule below turns it into a quiet dot there.
            className="tp-rail-jobs status-glyph-active"
            aria-label={title}
            style={{ color: 'var(--text-3)', fontSize: 16 }}
          />
        </Tooltip>
        {badge}
      </>
    );
  }
  return badge;
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
  jobs,
  needsYou,
  shortcutLabel,
  onOpen,
}: {
  workspace: Workspace;
  runnerLabel: string;
  active: boolean;
  offline: boolean;
  running: boolean;
  jobs: number;
  needsYou: number;
  shortcutLabel?: string | null;
  onOpen: (a: Workspace) => void;
}) {
  const offlineTitle = runnerLabel ? `${runnerLabel} is offline` : 'Runner offline';
  // Disconnection remains higher priority than background activity. A needs-you count does not
  // hide it: the count sits at the row's other end, and the server leaves the sessions waiting on
  // you out of `running` and `jobs`, so a dot beside it is other work still moving. The desktop
  // sidebar and the drawer draw this same quiet mark.
  const showRunningDot = running && !offline;
  // One slot, one blue: this dot means a job is in flight here with nobody generating, which the
  // still dot above outranks when generation happens. The two differ by breathing only.
  const showJobsDot = jobs > 0 && !running && !offline;
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
        {showJobsDot && (
          <span
            className="tp-workspace-icon-jobs"
            title={`${jobs} background ${jobs === 1 ? 'job' : 'jobs'} running`}
            role="img"
            aria-label="Workspace has a background job running"
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
