import { DeleteOutlined, EditOutlined, MoreOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Dropdown, Input, Modal, Spin, type MenuProps } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import type { Runner } from '../components/TasksSidePanel';

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

  return (
    <>
      <h1 className="page-title">Runners</h1>

      {runners.isLoading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : list.length === 0 ? (
        <div className="runners-empty">No runners yet — register a machine to get started.</div>
      ) : (
        <div className="runners-list">
          {list.map((r) => (
            <div
              key={r.id}
              className={`runner-card ${menuOpenId === r.id ? 'menu-open' : ''}`}
              onClick={() => open(r)}
            >
              <span
                className="runner-dot"
                style={{ background: r.online ? '#2ea121' : '#c0c4cc' }}
                title={r.online ? 'Online' : 'Offline'}
              />
              <div className="runner-meta">
                <div className="runner-name">{r.displayName || r.name}</div>
                <div className="runner-sub">
                  {r.online ? 'Online' : 'Offline'}
                  {typeof r.maxConcurrent === 'number' ? ` · ${r.maxConcurrent} slots` : ''}
                </div>
              </div>
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
            </div>
          ))}
        </div>
      )}

      <div className="tasks-toolbar">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/runners/register')}>
          Register Runner
        </Button>
      </div>

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
    </>
  );
}
