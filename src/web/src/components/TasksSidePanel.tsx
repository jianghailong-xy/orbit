import {
  BgColorsOutlined,
  CaretDownOutlined,
  CheckOutlined,
  DesktopOutlined,
  InboxOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { Avatar, Dropdown } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import type { PlanUsage, SlashCommandInfo } from '@orbit/shared';
import { api, clearToken } from '../api';
import { decodeId, encodeId } from '../lib/idCodec';
import { meQuery, sessionQuery, sessionsQuery } from '../lib/queries';
import { useThemeMode, type ThemeMode } from '../lib/theme';

// Feishu-style top navigation. Each entry routes to "/<key>" (they all share the
// Tasks view for now — only the heading differs). "Runners" opens the runners
// page.
const TOP = [
  { key: 'active', icon: <UserOutlined />, label: 'Active' },
  { key: 'runners', icon: <DesktopOutlined />, label: 'Runners' },
  { key: 'skills', icon: <ThunderboltOutlined />, label: 'Skills' },
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

export interface Runner {
  id: string;
  name: string;
  displayName?: string | null;
  online?: boolean;
  maxConcurrent?: number;
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
}

interface Agent {
  id: string;
  name: string;
  // ISO-8601 creation timestamp; the sidebar falls back to it (oldest-first) for
  // agents that have never been dragged into a custom slot.
  createdAt: string;
  // Drag-to-reorder slot (0-based). null until the user reorders, so it sorts last.
  position?: number | null;
  // The machine this agent belongs to (null for config-only agents); an agent
  // with no runner has no console to open.
  runnerId?: string | null;
  runner?: { id: string } | null;
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

function logout() {
  clearToken();
  location.href = '/login';
}

export function TasksSidePanel({ open = false }: { open?: boolean }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // The signed-in user, for the footer avatar + name. Shares its key with the account
  // page (and the BootGate pre-warm) so it reads straight from cache.
  const me = useQuery(meQuery());
  const { mode, setMode } = useThemeMode();
  // Admins get an extra top-nav entry into the user-management area.
  const navItems =
    me.data?.role === 'ADMIN'
      ? [...TOP, { key: 'admin', icon: <TeamOutlined />, label: 'Admin' }]
      : TOP;
  // A small drag threshold so a plain click still opens an agent; only real movement
  // starts a reorder drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // The open agent comes from /agents/<id>; behind a /sessions/<id> link, resolve
  // it from that session so its row highlights there too. The session query reuses
  // the console's cache (same key via sessionQuery), so it adds no extra request.
  // Splat (`/*`) so a sub-route like /agents/<id>/new still resolves the agent;
  // a bare `/agents/:id` matches exactly and would miss /new, falling back to the
  // "Runners" highlight. params.id stays the agent id under the splat.
  const openAgentId = decodeId(useMatch('/agents/:id/*')?.params.id);
  const sessionId = decodeId(useMatch('/sessions/:id')?.params.id);
  const sessionQ = useQuery({
    ...sessionQuery(sessionId),
    // Keep the previous session's data while the next one loads so activeAgentId
    // never blips to null between sessions — otherwise the highlight flickers to
    // the top "Runners" item and back on each ArrowUp/ArrowDown.
    placeholderData: keepPreviousData,
  });
  // Only resolve the agent from session data while we're actually on a session
  // route. keepPreviousData (above) keeps the last session's data around to avoid
  // flicker between sessions, but that stale data would otherwise keep an agent
  // row highlighted after navigating away to a list or top-nav route.
  const activeAgentId = openAgentId ?? (sessionId ? sessionQ.data?.agent?.id : null) ?? null;

  // On a top-nav route the highlight follows the URL ("/" and "/tasks" both map
  // to Active); the runner-centric routes (/runners, /runner, /agents, /sessions)
  // keep "Runners" highlighted. Clicking a list item below overrides it locally.
  const routeKey =
    loc.pathname === '/' || loc.pathname === '/tasks'
      ? 'active'
      : activeAgentId
        ? '' // scoped to one agent — its row highlights below, no top item
        : loc.pathname.startsWith('/agents/') ||
            loc.pathname.startsWith('/sessions/') ||
            loc.pathname.startsWith('/runner')
          ? 'runners'
          : loc.pathname.startsWith('/lists/')
            ? loc.pathname.slice('/lists/'.length)
            : loc.pathname.slice(1);
  const [sel, setSel] = useState(routeKey);
  useEffect(() => setSel(routeKey), [routeKey]);

  const [agentsOpen, setAgentsOpen] = useState(true);
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

  // The "Agents" list is the user's agent definitions (model + tools).
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<Agent[]>('/agents') });
  // Custom drag order (position) first; agents never dragged (position null) fall to
  // the end, ordered oldest-first. ⌘N maps to this final order. Sort client-side so it
  // holds even if the API returns them unordered, mirroring the server's ordering.
  const agentList = useMemo(
    () =>
      [...(agents.data ?? [])].sort((a, b) => {
        const pa = a.position ?? null;
        const pb = b.position ?? null;
        if (pa !== null && pb !== null) return pa - pb;
        if (pa !== null) return -1;
        if (pb !== null) return 1;
        return a.createdAt < b.createdAt ? -1 : 1;
      }),
    [agents.data],
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

  // Runners carry the computed `online` flag (set when their heartbeat is fresh).
  // An agent's dot turns green when its machine is online; poll on the same 15s
  // cadence as the Runners page so the status stays live while the sidebar is up.
  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<Runner[]>('/runners'),
    refetchInterval: 15_000,
  });
  const onlineRunnerIds = new Set((runners.data ?? []).filter((r) => r.online).map((r) => r.id));

  // Task count for the "未分组" (no-list) bucket. Reuses the ['tasks'] cache the main
  // view populates, so it adds no extra network request.
  const tasks = useQuery({
    queryKey: ['tasks'],
    queryFn: () => api<any[]>('/tasks'),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((t: any) => t.running || t.queued) ? 5_000 : 15_000,
  });
  const unlistedCount = (tasks.data ?? []).filter((t: any) => !t.listId).length;

  // The "Active" badge must match what ActiveSessionsView lists — live sessions only:
  // RUNNING or PENDING, including system/task-execution sessions (NOT the total task
  // count). Shares the ['sessions', null, 'active'] cache that view fills, so it adds no
  // extra request.
  const activeSessions = useQuery({
    ...sessionsQuery({ view: 'active' }),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((s: any) => s.status === 'RUNNING' || s.status === 'PENDING')
        ? 5_000
        : 15_000,
  });
  const activeCount = (activeSessions.data ?? []).filter(
    (s: any) => s.status === 'RUNNING' || s.status === 'PENDING',
  ).length;
  // "Needs you": active sessions blocked on a pending approval the user must act on
  // (Allow/Deny on a permission card). Surfaces ActiveSessionsView's "Needs you" group
  // up into the nav so it's visible from any page. Same cache, no extra request.
  const needsReplyCount = (activeSessions.data ?? []).filter(
    (s: any) => (s.pendingApprovals ?? 0) > 0,
  ).length;
  // The same "needs you" signal decomposed per agent: how many of each agent's active
  // sessions are blocked on an approval. Lets an agent row show its own attention count
  // (and hide its ⌘ shortcut) so you can jump straight to the agent that needs you.
  // Same active-sessions cache, no extra request; keyed by nested agent.id (flat
  // agentId as fallback). System/host sessions carry no agent and roll up only into Active.
  const agentNeedsYou = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of (activeSessions.data ?? []) as any[]) {
      if ((s.pendingApprovals ?? 0) <= 0) continue;
      const id = s.agent?.id ?? s.agentId;
      if (!id) continue;
      m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  }, [activeSessions.data]);

  // Open an agent's console — the same destination the runner detail page uses.
  // Config-only agents (no runner) have no console to open.
  const openAgent = useCallback(
    (a: Agent) => {
      if (!(a.runner?.id ?? a.runnerId)) return;
      navigate(`/agents/${encodeId(a.id)}`);
    },
    [navigate],
  );

  // Drag-to-reorder: optimistically stamp the new positions onto the cached list so
  // the order (and ⌘N labels) update instantly, persist via POST /agents/reorder,
  // then re-sync with the server's truth (also rolls back on failure).
  const onAgentDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const oldIndex = agentList.findIndex((a) => a.id === active.id);
      const newIndex = agentList.findIndex((a) => a.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(agentList, oldIndex, newIndex);
      const order = new Map(next.map((a, i) => [a.id, i]));
      qc.setQueryData<Agent[]>(['agents'], (prev) =>
        prev?.map((a) => {
          const p = order.get(a.id);
          return p === undefined ? a : { ...a, position: p };
        }),
      );
      void api('/agents/reorder', { method: 'POST', body: { ids: next.map((a) => a.id) } })
        .catch(() => {})
        .finally(() => void qc.invalidateQueries({ queryKey: ['agents'] }));
    },
    [agentList, qc],
  );

  // ⌘/Ctrl + 1‒9 opens the matching agent in the list. The modifier chord never
  // produces text input, so it fires even while a text field is focused;
  // preventDefault stops the browser's own tab-switch on the same chord.
  useEffect(() => {
    const list = agentList;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9 || n > list.length) return;
      e.preventDefault();
      openAgent(list[n - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [agentList, openAgent]);

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

      {/* Collapsed-only icon rail: the fixed top-nav as icons, carrying the Active
          "needs you" (or live) count so the core "it's your turn" signal survives a
          collapse. The dynamic lists (agents, task lists) have no icon form, so they
          fold away — expand to bring them back. Shown only when collapsed, on desktop. */}
      <div className="tp-rail">
        {TOP.map((t) => {
          const isActive = t.key === 'active';
          const needsYou = isActive && needsReplyCount > 0;
          const count = isActive ? (needsYou ? needsReplyCount : activeCount) : null;
          return (
            <div
              key={t.key}
              className={`tp-rail-item ${sel === t.key ? 'active' : ''}`}
              onClick={() => navigate(`/${t.key}`)}
              title={needsYou ? `${needsReplyCount} session(s) need your reply` : t.label}
            >
              <span className="tp-ico">{t.icon}</span>
              {count != null && count > 0 && (
                <span className={`tp-rail-badge${needsYou ? ' needs-you' : ''}`}>{count}</span>
              )}
            </div>
          );
        })}
        {/* The user's agents, kept reachable when collapsed: a monogram avatar each
            (agents are entities with identity + online state + ⌘1‒9, so unlike the
            text-titled task lists they read fine as icons). Same order, same shortcuts. */}
        {agentList.length > 0 && <div className="tp-rail-divider" />}
        {agentList.map((a, i) => {
          const online = onlineRunnerIds.has(a.runner?.id ?? a.runnerId ?? '');
          return (
            <div
              key={a.id}
              className={`tp-rail-item ${a.id === activeAgentId ? 'active' : ''}`}
              onClick={() => openAgent(a)}
              title={i < 9 ? `${a.name}  ⌘${i + 1}` : a.name}
            >
              <span className="tp-rail-avatar">{(a.name.trim()[0] ?? '?').toUpperCase()}</span>
              <span className={`tp-rail-adot ${online ? 'online' : ''}`} />
            </div>
          );
        })}
      </div>

      <div className="tp-scroll">
        <div className="tp-section">
          {navItems.map((t) => {
            // "Active" shows its live session total. But when some of those sessions are
            // blocked on an approval the user must act on, the count flips to that
            // "needs you" number in an amber attention badge — so "it's your turn" reads
            // from any page (the highlighted number = sessions awaiting you, not the total
            // running). Other nav items carry no count.
            const isActive = t.key === 'active';
            const needsYou = isActive && needsReplyCount > 0;
            const count = isActive ? (needsYou ? needsReplyCount : activeCount) : null;
            return (
              <div
                key={t.key}
                className={`tp-item ${sel === t.key ? 'active' : ''}`}
                onClick={() => navigate(`/${t.key}`)}
              >
                <span className="tp-ico">{t.icon}</span>
                <span className="tp-label">{t.label}</span>
                {count != null && (
                  <span
                    className={`tp-count${needsYou ? ' needs-you' : ''}`}
                    title={needsYou ? `${needsReplyCount} session(s) need your reply` : undefined}
                  >
                    {count}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="tp-divider" />

        <div className="tp-group">
          <div className="tp-group-head" onClick={() => setAgentsOpen((o) => !o)}>
            <span className="tp-group-name">Agents</span>
            {agentList.length > 0 && <span className="tp-count">{agentList.length}</span>}
            <CaretDownOutlined className={`tp-caret ${agentsOpen ? '' : 'collapsed'}`} />
          </div>
          {agentsOpen && (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onAgentDragEnd}
            >
              <SortableContext
                items={agentList.map((a) => a.id)}
                strategy={verticalListSortingStrategy}
              >
                {agentList.map((a, i) => (
                  <SortableAgentRow
                    key={a.id}
                    agent={a}
                    index={i}
                    active={a.id === activeAgentId}
                    online={onlineRunnerIds.has(a.runner?.id ?? a.runnerId ?? '')}
                    needsYou={agentNeedsYou.get(a.id) ?? 0}
                    onOpen={openAgent}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>

        <div className="tp-divider" />

        {/* "No list" is the complement of the lists below — tasks in no list at all.
            It's a peer of the Task List group, not a child of it, so it never reads
            as "a list called No list". Only shown when such tasks actually exist
            (agent-created, or detached when a list was deleted); the usual case is
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
              title="Tasks not in any list (includes agent-created tasks and ones detached when a list was deleted)"
            >
              <span className="tp-ico">
                <InboxOutlined />
              </span>
              <span className="tp-label">No list</span>
              <span className="tp-count">{unlistedCount}</span>
            </div>
          </div>
        )}

        <div className="tp-group">
          <div className="tp-group-head" onClick={() => setListOpen((o) => !o)}>
            <span className="tp-group-name">Task List</span>
            {activeLists.length > 0 && <span className="tp-count">{activeLists.length}</span>}
            <CaretDownOutlined className={`tp-caret ${listOpen ? '' : 'collapsed'}`} />
          </div>
          {listOpen && <>{activeLists.map(renderListRow)}</>}
        </div>

        <div className="tp-group">
          <div className="tp-group-head" onClick={() => setCompletedOpen((o) => !o)}>
            <span className="tp-group-name">Completed</span>
            {completedLists.length > 0 && <span className="tp-count">{completedLists.length}</span>}
            <CaretDownOutlined className={`tp-caret ${completedOpen ? '' : 'collapsed'}`} />
          </div>
          {completedOpen && <>{completedLists.map(renderListRow)}</>}
        </div>
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

// One draggable agent row. The drag listeners sit on the whole row; the sensor's
// activation distance keeps a plain click opening the agent instead of starting a drag.
function SortableAgentRow({
  agent,
  index,
  active,
  online,
  needsYou,
  onOpen,
}: {
  agent: Agent;
  index: number;
  active: boolean;
  online: boolean;
  needsYou: number;
  onOpen: (a: Agent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: agent.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`tp-item inset ${active ? 'active' : ''}`}
      onClick={() => onOpen(agent)}
      {...attributes}
      {...listeners}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: online ? 'var(--success-solid)' : 'var(--dot-idle)',
          flex: 'none',
          marginRight: 8,
        }}
      />
      <span className="tp-label">{agent.name}</span>
      {/* When one of this agent's sessions is waiting on you, the right slot shows an
          amber attention count instead of the ⌘ shortcut — the "it's your turn" signal
          wins over the discoverability hint. Falls back to the shortcut when nothing's
          waiting. */}
      {needsYou > 0 ? (
        <span className="tp-count needs-you" title={`${needsYou} session(s) need your reply`}>
          {needsYou}
        </span>
      ) : (
        index < 9 && <span className="tp-count">⌘{index + 1}</span>
      )}
    </div>
  );
}
