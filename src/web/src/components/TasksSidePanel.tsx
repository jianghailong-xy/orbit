import {
  CaretDownOutlined,
  DeleteOutlined,
  EditOutlined,
  LogoutOutlined,
  MoreOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Avatar, Dropdown, Input, Modal, type MenuProps } from 'antd';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, clearToken } from '../api';
import { encodeId } from '../lib/idCodec';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

// Feishu-style top navigation. Each entry routes to "/<key>" (they all share the
// Tasks view for now — only the heading differs). The lists below are still a
// visual scaffold whose selection just moves the highlight.
const TOP = [
  { key: 'active', icon: <UserOutlined />, label: 'Active', count: 385 },
  { key: 'skills', icon: <ThunderboltOutlined />, label: 'Skills' },
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

function logout() {
  clearToken();
  location.href = '/login';
}

interface Props {
  /** Runner the right pane is currently showing (resolved by the parent from
   *  the /agents or /sessions URL), so the sidebar highlights it. */
  activeRunnerId?: string | null;
}

export function TasksSidePanel({ activeRunnerId }: Props) {
  const loc = useLocation();
  const navigate = useNavigate();

  // On a top-nav route the highlight follows the URL ("/" and "/tasks" both map
  // to Active); clicking an agent/list item below overrides it locally.
  const routeKey =
    loc.pathname === '/' || loc.pathname === '/tasks'
      ? 'active'
      : loc.pathname.startsWith('/agents/') || loc.pathname.startsWith('/sessions/')
        ? (activeRunnerId ?? '')
        : loc.pathname.startsWith('/lists/')
          ? loc.pathname.slice('/lists/'.length)
          : loc.pathname.slice(1);
  const [sel, setSel] = useState(routeKey);
  useEffect(() => setSel(routeKey), [routeKey]);

  const [quickOpen, setQuickOpen] = useState(true);
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

  // The "Agents" list is the user's actually-registered runners; it refreshes so
  // online/offline tracks the runner's 30s heartbeat.
  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<Runner[]>('/runners'),
    refetchInterval: 15_000,
  });

  // Per-row "⋮" menu: Rename / Delete. `menuOpenId` keeps the trigger visible
  // (the kebab is hover-only) while its dropdown is open.
  const { modal, message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Runner | null>(null);
  const [renameVal, setRenameVal] = useState('');

  const renameMut = useMutation({
    mutationFn: ({ id, displayName }: { id: string; displayName: string }) =>
      api(`/runners/${id}`, { method: 'PATCH', body: { displayName } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runners'] });
      setRenaming(null);
    },
    onError: (e: Error) => message.error(e.message || 'Rename failed'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/runners/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runners'] }),
    onError: (e: Error) => message.error(e.message || 'Delete failed'),
  });

  const submitRename = () => {
    if (renaming) renameMut.mutate({ id: renaming.id, displayName: renameVal.trim() });
  };

  const runnerMenu = (r: Runner): MenuProps['items'] => [
    {
      key: 'rename',
      icon: <EditOutlined />,
      label: 'Rename',
      onClick: ({ domEvent }) => {
        domEvent.stopPropagation();
        setRenameVal(r.displayName || r.name);
        setRenaming(r);
      },
    },
    { type: 'divider' },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: 'Delete',
      danger: true,
      onClick: ({ domEvent }) => {
        domEvent.stopPropagation();
        modal.confirm({
          title: `Delete “${r.displayName || r.name}”?`,
          content:
            'This removes the runner from your account. Re-register the machine to add it back.',
          okText: 'Delete',
          okButtonProps: { danger: true },
          cancelText: 'Cancel',
          onOk: () => deleteMut.mutateAsync(r.id),
        });
      },
    },
  ];

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
      navigate(`/agents/${encodeId(list[idx].id)}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [list, navigate]);

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
          <div className="tp-group-head" onClick={() => setQuickOpen((o) => !o)}>
            <span className="tp-group-name">Agents</span>
            <CaretDownOutlined className={`tp-caret ${quickOpen ? '' : 'collapsed'}`} />
          </div>
          {quickOpen && (
            <>
              {list.map((r, idx) => (
                <div
                  key={r.id}
                  className={`tp-item inset ${sel === r.id ? 'active' : ''} ${
                    menuOpenId === r.id ? 'menu-open' : ''
                  }`}
                  onClick={() => {
                    setSel(r.id);
                    navigate(`/agents/${encodeId(r.id)}`);
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
                  <span className="tp-label">{r.displayName || r.name}</span>
                  {idx < 9 && <span className="tp-count">{isMac ? '⌘' : 'Ctrl+'}{idx + 1}</span>}
                  <Dropdown
                    trigger={['click']}
                    placement="bottomRight"
                    open={menuOpenId === r.id}
                    onOpenChange={(o) => setMenuOpenId(o ? r.id : null)}
                    menu={{ items: runnerMenu(r) }}
                  >
                    <span
                      className="tp-kebab"
                      title="More actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreOutlined />
                    </span>
                  </Dropdown>
                </div>
              ))}
              <div
                className="tp-item inset"
                onClick={() => navigate('/runner')}
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
        title="Rename runner"
        open={renaming !== null}
        okText="Save"
        cancelText="Cancel"
        confirmLoading={renameMut.isPending}
        onOk={submitRename}
        onCancel={() => setRenaming(null)}
        destroyOnClose
      >
        <Input
          value={renameVal}
          onChange={(e) => setRenameVal(e.target.value)}
          onPressEnter={submitRename}
          placeholder={renaming?.name}
          maxLength={60}
          autoFocus
        />
        <div style={{ marginTop: 8, color: '#8f959e', fontSize: 12 }}>
          Leave empty to use the machine name{renaming ? ` (${renaming.name})` : ''}.
        </div>
      </Modal>
    </aside>
  );
}
