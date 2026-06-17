import {
  CaretDownOutlined,
  DesktopOutlined,
  LogoutOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Avatar, Dropdown, Input, Modal } from 'antd';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, clearToken } from '../api';

// Feishu-style top navigation. Each entry routes to "/<key>" (they all share the
// Tasks view for now — only the heading differs). "Runners" opens the runners
// page; the lists below are still a visual scaffold whose selection just moves
// the highlight.
const TOP = [
  { key: 'active', icon: <UserOutlined />, label: 'Active', count: 385 },
  { key: 'skills', icon: <ThunderboltOutlined />, label: 'Skills' },
  { key: 'runners', icon: <DesktopOutlined />, label: 'Runners' },
];

const LISTS = [
  { key: 'l1', label: '#1 TEA - Migration build engine to tea-cli' },
  { key: 'l3', label: '#3 Dorado 项目152 psm 改为 data.tea.build_compliance' },
  { key: 'l4', label: '#4 Dorado 项目152 owner 变更为 jianghailong.rd' },
  { key: 'l7', label: '#7 importer not-ready sg 2026-06-12' },
  { key: 'l8', label: '#8 importer not-ready sg 2026-06-13' },
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
}

interface Agent {
  id: string;
  name: string;
}

function logout() {
  clearToken();
  location.href = '/login';
}

export function TasksSidePanel() {
  const loc = useLocation();
  const navigate = useNavigate();

  // On a top-nav route the highlight follows the URL ("/" and "/tasks" both map
  // to Active); the runner-centric routes (/runners, /runner, /agents, /sessions)
  // keep "Runners" highlighted. Clicking a list item below overrides it locally.
  const routeKey =
    loc.pathname === '/' || loc.pathname === '/tasks'
      ? 'active'
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

  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [agentName, setAgentName] = useState('');

  const createAgentMut = useMutation({
    mutationFn: (name: string) => api('/agents', { method: 'POST', body: { name } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      setCreatingAgent(false);
      setAgentName('');
    },
    onError: (e: Error) => message.error(e.message || 'Create failed'),
  });

  const submitAgent = () => {
    const name = agentName.trim();
    if (name) createAgentMut.mutate(name);
  };

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
              {(agents.data ?? []).map((a) => (
                <div key={a.id} className="tp-item inset">
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
                  <span className="tp-label">{a.name}</span>
                </div>
              ))}
              <div className="tp-item inset" onClick={() => setCreatingAgent(true)}>
                <span className="tp-ico">
                  <PlusOutlined />
                </span>
                <span className="tp-label">Add</span>
              </div>
            </>
          )}
        </div>

        <div className="tp-divider" />

        <div className="tp-group">
          <div className="tp-group-head" onClick={() => setListOpen((o) => !o)}>
            <span className="tp-group-name">Task List</span>
            <CaretDownOutlined className={`tp-caret ${listOpen ? '' : 'collapsed'}`} />
          </div>
          {listOpen &&
            LISTS.map((l) => (
              <div
                key={l.key}
                className={`tp-item inset ${sel === l.key ? 'active' : ''}`}
                onClick={() => {
                  setSel(l.key);
                  navigate(`/lists/${l.key}`);
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
                <span className="tp-label">{l.label}</span>
              </div>
            ))}
        </div>

        <div className="tp-group">
          <div className="tp-group-head" onClick={() => setArchOpen((o) => !o)}>
            <span className="tp-group-name">Archived</span>
            <CaretDownOutlined className={`tp-caret ${archOpen ? '' : 'collapsed'}`} />
          </div>
        </div>

        <div className="tp-newgroup">
          <PlusOutlined />
          <span>New Group</span>
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

      <Modal
        title="New agent"
        open={creatingAgent}
        okText="Create"
        cancelText="Cancel"
        okButtonProps={{ disabled: !agentName.trim() }}
        confirmLoading={createAgentMut.isPending}
        onOk={submitAgent}
        onCancel={() => {
          setCreatingAgent(false);
          setAgentName('');
        }}
        destroyOnClose
      >
        <Input
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          onPressEnter={submitAgent}
          placeholder="Agent name"
          maxLength={60}
          autoFocus
        />
      </Modal>
    </aside>
  );
}
