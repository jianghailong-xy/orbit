import {
  DeleteOutlined,
  EditOutlined,
  HolderOutlined,
  KeyOutlined,
  MoreOutlined,
  PlusOutlined,
  RightOutlined,
  WarningFilled,
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
import { useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import type { Runner } from '../components/TasksSidePanel';
import { useRunnerTokenRotation } from '../components/RunnerTokenRotation';
import { Button } from '../components/ui/Button';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { Dialog } from '../components/ui/Dialog';
import { Input } from '../components/ui/Input';
import { Menu, type MenuItem } from '../components/ui/Menu';
import { Spinner } from '../components/ui/Spinner';
import {
  latestRunnerVersion,
  listAttentionLine,
  runnerAttention,
  type AttentionItem,
  type AttentionWorkspace,
} from '../lib/runnerAttention';
import { publishedRunnerVersionQuery, workspacesQuery } from '../lib/queries';
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
  const [confirm, confirmation] = useConfirm();
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
  // What the third line is read from: each runner's workspaces, and the newest release anyone can see.
  const workspaces = (useQuery(workspacesQuery()).data ?? []) as Array<
    AttentionWorkspace & { runnerId?: string | null }
  >;
  const publishedVersion = useQuery(publishedRunnerVersionQuery()).data;
  const latestVersion = latestRunnerVersion(publishedVersion, list);
  const nowMs = Date.now();

  const [renaming, setRenaming] = useState<Runner | null>(null);
  const [renameVal, setRenameVal] = useState('');
  // The ⋯ button the rename was asked from, where focus returns once the dialog closes.
  const [renameFrom, setRenameFrom] = useState<RefObject<HTMLButtonElement | null> | undefined>();
  const renameInput = useRef<HTMLInputElement>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const rotation = useRunnerTokenRotation();

  const renameMut = useMutation({
    mutationFn: ({ id, displayName }: { id: string; displayName: string }) =>
      api(`/runners/${id}`, { method: 'PATCH', body: { displayName } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runners'] });
      setRenaming(null);
    },
    onError: (e: Error) => message.error("Couldn't rename the runner", e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/runners/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runners'] }),
    onError: (e: Error) => message.error("Couldn't delete the runner", e.message),
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
      message.error("Couldn't reorder the runners", e.message);
    },
    onSuccess: (data) => qc.setQueryData(['runners'], data),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['runners'] }),
  });

  const submitRename = () => {
    if (renaming) renameMut.mutate({ id: renaming.id, displayName: renameVal.trim() });
  };

  const open = (r: Runner) => navigate(`/runners/${encodeId(r.id)}`);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || reorderMut.isPending) return;
    const oldIndex = list.findIndex((runner) => runner.id === active.id);
    const newIndex = list.findIndex((runner) => runner.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    reorderMut.mutate(arrayMove(list, oldIndex, newIndex).map((runner) => runner.id));
  };

  // `trigger` is the card's ⋯ button: what a dialog opened from the menu gives focus back to.
  const menu = (r: Runner, trigger: RefObject<HTMLButtonElement | null>): MenuItem[] => [
    {
      key: 'rename',
      icon: <EditOutlined />,
      label: 'Rename',
      onSelect: () => {
        setRenameVal(r.displayName || r.name);
        setRenameFrom(trigger);
        setRenaming(r);
      },
    },
    {
      key: 'rotate',
      icon: <KeyOutlined />,
      label: 'Rotate token',
      onSelect: () => rotation.confirmRotate(r, trigger),
    },
    { type: 'separator', key: 'divider' },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: 'Delete',
      danger: true,
      onSelect: () =>
        void confirm({
          title: `Delete “${r.displayName || r.name}”?`,
          description:
            'This removes the runner from your account. Re-register the machine to add it back.',
          confirmText: 'Delete',
          danger: true,
          cancelText: 'Cancel',
          onConfirm: () => deleteMut.mutateAsync(r.id),
          returnFocus: trigger,
        }),
    },
  ];

  const registerBtn = (
    <Button variant="primary" icon={<PlusOutlined />} onClick={() => navigate('/runners/register')}>
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
          <Spinner />
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
                  attention={runnerAttention({
                    runner,
                    workspaces: workspaces.filter((workspace) => workspace.runnerId === runner.id),
                    nowMs,
                    latestVersion,
                  })}
                  menuItems={(trigger) => menu(runner, trigger)}
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

      <Dialog
        className="runner-dialog"
        title="Rename runner"
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        initialFocus={renameInput}
        returnFocus={renameFrom}
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
            <Button variant="primary" loading={renameMut.isPending} onClick={submitRename}>
              Save
            </Button>
          </>
        }
      >
        <Input
          ref={renameInput}
          value={renameVal}
          onChange={(e) => setRenameVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitRename();
          }}
          placeholder={renaming?.name}
          maxLength={60}
        />
        <div style={{ marginTop: 8, color: 'var(--text-3)', fontSize: 12 }}>
          Leave empty to use the machine name{renaming ? ` (${renaming.name})` : ''}.
        </div>
      </Dialog>

      {confirmation}
      {rotation.dialogs}
    </>
  );
}

function SortableRunnerCard({
  runner,
  attention,
  menuItems,
  menuOpen,
  dragDisabled,
  onOpen,
  onMenuOpenChange,
}: {
  runner: Runner;
  attention: AttentionItem[];
  /** The card's menu, given the ⋯ button it opens from. */
  menuItems: (trigger: RefObject<HTMLButtonElement | null>) => MenuItem[];
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
  const kebab = useRef<HTMLButtonElement>(null);
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
  const attentionLine = listAttentionLine(attention);
  const attentionTone = attention.slice(0, 2).some((item) => item.tone === 'bad')
    ? 'bad'
    : 'warn';

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
        {attentionLine && (
          <div className={`runner-attention ${attentionTone}`}>
            <WarningFilled />
            <span>{attentionLine}</span>
          </div>
        )}
      </div>
      {runner.version && <span className="runner-version">{runner.version}</span>}
      <Menu
        align="end"
        open={menuOpen}
        onOpenChange={onMenuOpenChange}
        items={menuItems(kebab)}
        trigger={
          <button ref={kebab} type="button" className="runner-kebab" title="More actions" aria-label="More actions">
            <MoreOutlined />
          </button>
        }
      />
      <RightOutlined className="runner-chevron" />
    </div>
  );
}
