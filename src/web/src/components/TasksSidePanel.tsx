import {
  BookOutlined,
  CaretDownOutlined,
  ClockCircleOutlined,
  LogoutOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Avatar, Dropdown } from 'antd';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, clearToken } from '../api';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

// Feishu-style top navigation. Each entry routes to "/<key>" (they all share the
// Tasks view for now — only the heading differs). The lists below are still a
// visual scaffold whose selection just moves the highlight.
const TOP = [
  { key: 'running', icon: <UserOutlined />, label: 'Running', count: 385 },
  { key: 'skills', icon: <ThunderboltOutlined />, label: 'Skills' },
  { key: 'schedule', icon: <BookOutlined />, label: 'Schedule' },
  { key: 'activities', icon: <ClockCircleOutlined />, label: 'Activities' },
];

const LISTS = [
  { key: 'l1', label: '#1 TEA - Migration build engine to tea-cli' },
  { key: 'l3', label: '#3 Dorado 项目152 psm 改为 data.tea.build_compliance' },
  { key: 'l4', label: '#4 Dorado 项目152 owner 变更为 jianghailong.rd' },
  { key: 'l7', label: '#7 importer not-ready sg 2026-06-12' },
  { key: 'l8', label: '#8 importer not-ready sg 2026-06-13' },
];

export interface Runner {
  id: string;
  name: string;
  online?: boolean;
}

function logout() {
  clearToken();
  location.href = '/login';
}

interface Props {
  /** Show the “add a runner” guide in the right pane. */
  onShowRegister: () => void;
  /** Return the right pane to the task list. */
  onShowTasks: () => void;
}

export function TasksSidePanel({ onShowRegister, onShowTasks }: Props) {
  const loc = useLocation();
  const navigate = useNavigate();

  // On a top-nav route the highlight follows the URL ("/" and "/tasks" both map
  // to Running); clicking an agent/list item below overrides it locally.
  const routeKey =
    loc.pathname === '/' || loc.pathname === '/tasks'
      ? 'running'
      : loc.pathname.startsWith('/agents/')
        ? loc.pathname.slice('/agents/'.length)
        : loc.pathname.slice(1);
  const [sel, setSel] = useState(routeKey);
  useEffect(() => setSel(routeKey), [routeKey]);

  const [quickOpen, setQuickOpen] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const [archOpen, setArchOpen] = useState(false);

  // The "Agents" list is the user's actually-registered runners; it refreshes so
  // online/offline tracks the runner's 30s heartbeat.
  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<Runner[]>('/runners'),
    refetchInterval: 15_000,
  });

  const pick = (key: string) => {
    setSel(key);
    onShowTasks();
  };

  // ⌘1 / ⌘2 / … (Ctrl on non-Mac) select the Nth runner under "Agents".
  const list = runners.data ?? [];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key < '1' || e.key > '9') return;
      const idx = Number(e.key) - 1;
      if (idx >= list.length) return;
      e.preventDefault();
      setSel(list[idx].id);
      onShowTasks();
      navigate(`/agents/${list[idx].id}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [list, onShowTasks, navigate]);

  return (
    <aside className="tasks-panel">
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
              onClick={() => {
                navigate(`/${t.key}`);
                onShowTasks();
              }}
            >
              <span className="tp-ico">{t.icon}</span>
              <span className="tp-label">{t.label}</span>
              {t.count != null && <span className="tp-count">{t.count}</span>}
            </div>
          ))}
        </div>

        <div className="tp-divider" />

        <div className="tp-group">
          <div className="tp-group-head" onClick={() => setQuickOpen((o) => !o)}>
            <span className="tp-group-name">Agents</span>
            <CaretDownOutlined className={`tp-caret ${quickOpen ? '' : 'collapsed'}`} />
          </div>
          {quickOpen && (
            <>
              {list.map((r, idx) => (
                <div
                  key={r.id}
                  className={`tp-item inset ${sel === r.id ? 'active' : ''}`}
                  onClick={() => {
                    setSel(r.id);
                    onShowTasks();
                    navigate(`/agents/${r.id}`);
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: r.online ? '#2ea121' : '#c0c4cc',
                      flex: 'none',
                      marginRight: 8,
                    }}
                    title={r.online ? 'Online' : 'Offline'}
                  />
                  <span className="tp-label">{r.name}</span>
                  {idx < 9 && <span className="tp-count">{isMac ? '⌘' : 'Ctrl+'}{idx + 1}</span>}
                </div>
              ))}
              <div
                className="tp-item inset"
                onClick={() => {
                  setSel('runner-new');
                  onShowRegister();
                }}
              >
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
                onClick={() => pick(l.key)}
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
    </aside>
  );
}
