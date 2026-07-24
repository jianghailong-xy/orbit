import {
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  MoreOutlined,
  PlusOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Dropdown, Input, Modal, Spin, type MenuProps } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { copyText } from '../lib/clipboard';
import { encodeId } from '../lib/idCodec';
import type { Runner } from '../components/TasksSidePanel';

// Compact relative time for heartbeats (which arrive every ~30s, so seconds matter).
const fmtAgo = (d?: string | null): string => {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

// The runner list used to live in the left sidebar; it now has its own page so
// "Runners" can sit in the top nav alongside Active/Skills. Selecting a runner
// opens its detail/settings page at /runners/<id> (its own route) — where you
// manage the agents that run under it.
export function RunnersPage() {
  const navigate = useNavigate();
  const { modal, message } = AntdApp.useApp();
  const qc = useQueryClient();

  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<Runner[]>('/runners'),
    refetchInterval: 15_000,
  });
  const list = runners.data ?? [];

  const [renaming, setRenaming] = useState<Runner | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  // The freshly minted token from a rotation, shown exactly once.
  const [revealed, setRevealed] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

  const rotateMut = useMutation({
    mutationFn: ({ id }: { id: string; name: string }) =>
      api<{ token: string }>(`/runners/${id}/rotate-token`, { method: 'POST' }),
    onSuccess: (data, vars) => {
      setCopied(false);
      setRevealed({ name: vars.name, token: data.token });
    },
    onError: (e: Error) => message.error(e.message || 'Rotate failed'),
  });

  const submitRename = () => {
    if (renaming) renameMut.mutate({ id: renaming.id, displayName: renameVal.trim() });
  };

  const copyToken = () => {
    if (!revealed) return;
    void copyText(revealed.token).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const open = (r: Runner) => navigate(`/runners/${encodeId(r.id)}`);

  const menu = (r: Runner): MenuProps['items'] => [
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
    {
      key: 'rotate',
      icon: <KeyOutlined />,
      label: 'Rotate token',
      onClick: ({ domEvent }) => {
        domEvent.stopPropagation();
        modal.confirm({
          title: `Rotate token for “${r.displayName || r.name}”?`,
          content:
            'This immediately invalidates the runner’s current credential. The runner will go offline until you set the new token as runnerToken in its ~/.orbit/config.json and restart it.',
          okText: 'Rotate token',
          cancelText: 'Cancel',
          onOk: () => rotateMut.mutateAsync({ id: r.id, name: r.displayName || r.name }),
        });
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

  const registerBtn = (
    <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/runners/register')}>
      Register Runner
    </Button>
  );

  return (
    <>
      <div className="runners-head">
        <h1 className="page-title">Runners</h1>
        {list.length > 0 && registerBtn}
      </div>

      {runners.isLoading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : list.length === 0 ? (
        <div className="runners-empty">
          <div>No runners yet — register a machine to get started.</div>
          <div style={{ marginTop: 16 }}>{registerBtn}</div>
        </div>
      ) : (
        <div className="runners-list">
          {list.map((r) => {
            const state = !r.online ? 'offline' : r.status === 'DRAINING' ? 'draining' : 'online';
            const dotColor =
              state === 'online' ? 'var(--success-solid)' : state === 'draining' ? 'var(--warning-solid)' : 'var(--dot-idle)';
            const stateLabel =
              state === 'online' ? 'Online' : state === 'draining' ? 'Draining' : 'Offline';
            const max = r.maxConcurrent ?? 0;
            const active = r.activeSessions ?? 0;
            const showUtil = state !== 'offline' && max > 0;
            const tags = [r.hostname, r.labels?.length ? r.labels.join(', ') : null]
              .filter(Boolean)
              .join(' · ');
            return (
              <div
                key={r.id}
                className={`runner-card ${menuOpenId === r.id ? 'menu-open' : ''}`}
                onClick={() => open(r)}
              >
                <span className="runner-dot" style={{ background: dotColor }} title={stateLabel} />
                <div className="runner-meta">
                  <div className="runner-name">{r.displayName || r.name}</div>
                  <div className="runner-sub">
                    {showUtil
                      ? `${stateLabel} · ${active} / ${max} running`
                      : r.lastHeartbeatAt
                        ? `${stateLabel} · last seen ${fmtAgo(r.lastHeartbeatAt)}`
                        : stateLabel}
                  </div>
                  {showUtil && (
                    <div
                      className={`runner-util ${active >= max ? 'full' : ''}`}
                      title={`${active} of ${max} slots in use`}
                    >
                      <span
                        className="runner-util-fill"
                        style={{ width: `${Math.min(100, (active / max) * 100)}%` }}
                      />
                    </div>
                  )}
                  {tags && <div className="runner-tags">{tags}</div>}
                </div>
                {r.version && <span className="runner-version">{r.version}</span>}
                <Dropdown
                  trigger={['click']}
                  placement="bottomRight"
                  open={menuOpenId === r.id}
                  onOpenChange={(o) => setMenuOpenId(o ? r.id : null)}
                  menu={{ items: menu(r) }}
                >
                  <span
                    className="runner-kebab"
                    title="More actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreOutlined />
                  </span>
                </Dropdown>
                <RightOutlined className="runner-chevron" />
              </div>
            );
          })}
        </div>
      )}

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
        <div style={{ marginTop: 8, color: 'var(--text-3)', fontSize: 12 }}>
          Leave empty to use the machine name{renaming ? ` (${renaming.name})` : ''}.
        </div>
      </Modal>

      <Modal
        title="New runner token"
        open={revealed !== null}
        onCancel={() => setRevealed(null)}
        footer={[
          <Button key="done" type="primary" onClick={() => setRevealed(null)}>
            Done
          </Button>,
        ]}
        destroyOnClose
      >
        <div style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 12 }}>
          Copy this token now — it won’t be shown again. Set it as <code>runnerToken</code> in{' '}
          <code>~/.orbit/config.json</code> on <b>{revealed?.name}</b>, then restart the runner.
        </div>
        <div className="runner-token-box">{revealed?.token}</div>
        <Button
          icon={copied ? <CheckOutlined /> : <CopyOutlined />}
          onClick={copyToken}
          style={{ marginTop: 12 }}
        >
          {copied ? 'Copied' : 'Copy token'}
        </Button>
      </Modal>
    </>
  );
}
