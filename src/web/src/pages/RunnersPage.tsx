import {
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  HolderOutlined,
  KeyOutlined,
  MoreOutlined,
  PlusOutlined,
  RightOutlined,
} from '@ant-design/icons';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Dropdown, Input, Modal, Spin, type MenuProps } from 'antd';
import { useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { copyText } from '../lib/clipboard';
import { encodeId } from '../lib/idCodec';
import type { Runner } from '../components/TasksSidePanel';
import { useToast } from '../lib/toast';

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
// manage the workspaces that run under it.
export function RunnersPage() {
  const navigate = useNavigate();
  const { modal } = AntdApp.useApp();
  const message = useToast();
  const qc = useQueryClient();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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

  const reorderMut = useMutation({
    mutationFn: (ids: string[]) =>
      api<Runner[]>('/runners/reorder', { method: 'POST', body: { ids } }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ['runners'] });
      const previous = qc.getQueryData<Runner[]>(['runners']);
      if (previous) {
        const rank = new Map(ids.map((id, index) => [id, index]));
        qc.setQueryData<Runner[]>(
          ['runners'],
          [...previous]
            .sort(
              (a, b) =>
                (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
            )
            .map((runner, position) => ({ ...runner, position })),
        );
      }
      return { previous };
    },
    onError: (e: Error, _ids, context) => {
      if (context?.previous) qc.setQueryData(['runners'], context.previous);
      message.error(e.message || 'Reorder failed');
    },
    onSuccess: (data) => qc.setQueryData(['runners'], data),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['runners'] }),
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

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || reorderMut.isPending) return;
    const oldIndex = list.findIndex((runner) => runner.id === active.id);
    const newIndex = list.findIndex((runner) => runner.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    reorderMut.mutate(arrayMove(list, oldIndex, newIndex).map((runner) => runner.id));
  };

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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={list.map((runner) => runner.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="runners-list">
              {list.map((runner) => (
                <SortableRunnerCard
                  key={runner.id}
                  runner={runner}
                  menuItems={menu(runner)}
                  menuOpen={menuOpenId === runner.id}
                  dragDisabled={reorderMut.isPending}
                  onOpen={() => open(runner)}
                  onMenuOpenChange={(open) => setMenuOpenId(open ? runner.id : null)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
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

function SortableRunnerCard({
  runner,
  menuItems,
  menuOpen,
  dragDisabled,
  onOpen,
  onMenuOpenChange,
}: {
  runner: Runner;
  menuItems: MenuProps['items'];
  menuOpen: boolean;
  dragDisabled: boolean;
  onOpen: () => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: runner.id, disabled: dragDisabled });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
  };
  const state = !runner.online
    ? 'offline'
    : runner.status === 'DRAINING'
      ? 'draining'
      : 'online';
  const dotColor =
    state === 'online'
      ? 'var(--success-solid)'
      : state === 'draining'
        ? 'var(--warning-solid)'
        : 'var(--dot-idle)';
  const stateLabel = state === 'online' ? 'Online' : state === 'draining' ? 'Draining' : 'Offline';
  const max = runner.maxConcurrent ?? 0;
  const active = runner.activeSessions ?? 0;
  const showUtil = state !== 'offline' && max > 0;
  const tags = [runner.hostname, runner.labels?.length ? runner.labels.join(', ') : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`runner-card ${menuOpen ? 'menu-open' : ''} ${isDragging ? 'dragging' : ''}`}
      onClick={onOpen}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="runner-drag-handle"
        title="Drag to reorder"
        aria-label={`Reorder ${runner.displayName || runner.name}`}
        disabled={dragDisabled}
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        <HolderOutlined />
      </button>
      <span className="runner-dot" style={{ background: dotColor }} title={stateLabel} />
      <div className="runner-meta">
        <div className="runner-name">{runner.displayName || runner.name}</div>
        <div className="runner-sub">
          {showUtil
            ? `${stateLabel} · ${active} / ${max} running`
            : runner.lastHeartbeatAt
              ? `${stateLabel} · last seen ${fmtAgo(runner.lastHeartbeatAt)}`
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
      {runner.version && <span className="runner-version">{runner.version}</span>}
      <Dropdown
        trigger={['click']}
        placement="bottomRight"
        open={menuOpen}
        onOpenChange={onMenuOpenChange}
        menu={{ items: menuItems }}
      >
        <span className="runner-kebab" title="More actions" onClick={(e) => e.stopPropagation()}>
          <MoreOutlined />
        </span>
      </Dropdown>
      <RightOutlined className="runner-chevron" />
    </div>
  );
}
