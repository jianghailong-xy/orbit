import {
  CaretDownOutlined,
  DesktopOutlined,
  LogoutOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Avatar, Dropdown } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import { api, clearToken, getSession } from '../api';
import { decodeId, encodeId } from '../lib/idCodec';

// Feishu-style top navigation. Each entry routes to "/<key>" (they all share the
// Tasks view for now — only the heading differs). "Runners" opens the runners
// page.
const TOP = [
  { key: 'active', icon: <UserOutlined />, label: 'Active', count: 385 },
  { key: 'skills', icon: <ThunderboltOutlined />, label: 'Skills' },
  { key: 'runners', icon: <DesktopOutlined />, label: 'Runners' },
];

// The left sidebar is user-resizable; the chosen width persists across refreshes.
const SIDEBAR_WIDTH_KEY = 'orbit:sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 264;
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
  // Extra fields returned by GET /runners, shown read-only on the runner detail page.
  hostname?: string | null;
  labels?: string[];
  version?: string | null;
  status?: string;
  lastHeartbeatAt?: string | null;
  enrolledAt?: string | null;
}

interface Agent {
  id: string;
  name: string;
  // ISO-8601 creation timestamp; the sidebar sorts on it so the list is
  // oldest-first regardless of the API's ordering.
  createdAt: string;
  // The machine this agent belongs to (null for config-only agents); an agent
  // with no runner has no console to open.
  runnerId?: string | null;
  runner?: { id: string } | null;
}

interface TaskList {
  id: string;
  title: string;
  _count?: { tasks: number };
}

function logout() {
  clearToken();
  location.href = '/login';
}

export function TasksSidePanel() {
  const loc = useLocation();
  const navigate = useNavigate();

  // The open agent comes from /agents/<id>; behind a /sessions/<id> link, resolve
  // it from that session so its row highlights there too. The session query reuses
  // TasksPage's cache (same key), so it adds no extra request.
  // Splat (`/*`) so a sub-route like /agents/<id>/new still resolves the agent;
  // a bare `/agents/:id` matches exactly and would miss /new, falling back to the
  // "Runners" highlight. params.id stays the agent id under the splat.
  const openAgentId = decodeId(useMatch('/agents/:id/*')?.params.id);
  const sessionId = decodeId(useMatch('/sessions/:id')?.params.id);
  const sessionQ = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => getSession(sessionId!),
    enabled: !!sessionId,
  });
  const activeAgentId = openAgentId ?? sessionQ.data?.agent?.id ?? null;

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
  const [archOpen, setArchOpen] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return saved > 0 ? clampWidth(saved) : DEFAULT_SIDEBAR_WIDTH;
  });

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
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // The "Agents" list is the user's agent definitions (model + tools).
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<Agent[]>('/agents') });
  // Oldest-added first, so ⌘1 always maps to the first agent created and the
  // shortcuts stay stable as newer agents append below. Sort client-side so the
  // order holds even if the API returns them unordered; ISO timestamps compare
  // lexicographically.
  const agentList = useMemo(
    () => [...(agents.data ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    [agents.data],
  );

  // User-created task lists shown in the "Task List" group below.
  const taskLists = useQuery({
    queryKey: ['task-lists'],
    queryFn: () => api<TaskList[]>('/task-lists'),
  });

  // Runners carry the computed `online` flag (set when their heartbeat is fresh).
  // An agent's dot turns green when its machine is online; poll on the same 15s
  // cadence as the Runners page so the status stays live while the sidebar is up.
  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<Runner[]>('/runners'),
    refetchInterval: 15_000,
  });
  const onlineRunnerIds = new Set((runners.data ?? []).filter((r) => r.online).map((r) => r.id));

  // Open an agent's console — the same destination the runner detail page uses.
  // Config-only agents (no runner) have no console to open.
  const openAgent = useCallback(
    (a: Agent) => {
      if (!(a.runner?.id ?? a.runnerId)) return;
      navigate(`/agents/${encodeId(a.id)}`);
    },
    [navigate],
  );

  // ⌘/Ctrl + 1‒9 opens the matching agent in the list. Skip while a text field is
  // focused so it doesn't fight the composer; preventDefault stops the browser's
  // own tab-switch on the same chord.
  useEffect(() => {
    const list = agentList;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9 || n > list.length) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      )
        return;
      e.preventDefault();
      openAgent(list[n - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [agentList, openAgent]);

  return (
    <aside className="tasks-panel" style={{ width: sidebarWidth }}>
      <div className="tp-brand">
        <span className="tp-brand-logo">🛰</span>
        <span className="tp-brand-name">Orbit</span>
      </div>

      <div className="tp-scroll">
        <div className="tp-section">
          {TOP.map((t) => (
            <div
              key={t.key}
              className={`tp-item ${sel === t.key ? 'active' : ''}`}
              onClick={() => navigate(`/${t.key}`)}
            >
              <span className="tp-ico">{t.icon}</span>
              <span className="tp-label">{t.label}</span>
              {t.count != null && <span className="tp-count">{t.count}</span>}
            </div>
          ))}
        </div>

        <div className="tp-divider" />

        <div className="tp-group">
          <div className="tp-group-head" onClick={() => setAgentsOpen((o) => !o)}>
            <span className="tp-group-name">Agents</span>
            <CaretDownOutlined className={`tp-caret ${agentsOpen ? '' : 'collapsed'}`} />
          </div>
          {agentsOpen && (
            <>
              {agentList.map((a, i) => {
                const online = onlineRunnerIds.has(a.runner?.id ?? a.runnerId ?? '');
                return (
                  <div
                    key={a.id}
                    className={`tp-item inset ${a.id === activeAgentId ? 'active' : ''}`}
                    onClick={() => openAgent(a)}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: online ? '#2ea121' : '#c0c4cc',
                        flex: 'none',
                        marginRight: 8,
                      }}
                    />
                    <span className="tp-label">{a.name}</span>
                    {i < 9 && <span className="tp-count">⌘{i + 1}</span>}
                  </div>
                );
              })}
            </>
          )}
        </div>

        <div className="tp-divider" />

        <div className="tp-group">
          <div className="tp-group-head" onClick={() => setListOpen((o) => !o)}>
            <span className="tp-group-name">Task List</span>
            <CaretDownOutlined className={`tp-caret ${listOpen ? '' : 'collapsed'}`} />
          </div>
          {listOpen && (
            <>
              {(taskLists.data ?? []).map((l) => {
                const key = encodeId(l.id);
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
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: '#c0c4cc',
                        flex: 'none',
                        marginRight: 8,
                      }}
                    />
                    <span className="tp-label">{l.title}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>

        <div className="tp-group">
          <div className="tp-group-head" onClick={() => setArchOpen((o) => !o)}>
            <span className="tp-group-name">Archived</span>
            <CaretDownOutlined className={`tp-caret ${archOpen ? '' : 'collapsed'}`} />
          </div>
        </div>
      </div>

      <div className="tp-user">
        <Dropdown
          placement="topLeft"
          menu={{
            items: [{ key: 'logout', icon: <LogoutOutlined />, label: 'Logout', onClick: logout }],
          }}
        >
          <div className="tp-user-trigger">
            <Avatar
              size={32}
              icon={<UserOutlined />}
              style={{ background: '#3370ff', flex: 'none' }}
            />
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
