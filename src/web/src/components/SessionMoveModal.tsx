import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { App as AntApp, Modal, Spin } from 'antd';
import {
  CheckOutlined,
  FolderAddOutlined,
  FolderOutlined,
  InboxOutlined,
  LeftOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionMoveFolder, SessionMoveTarget, SessionMoveTargets } from '@orbit/shared';
import {
  createSessionFolder,
  endSession,
  getSession,
  getSessionMoveTargets,
  moveSession,
  type SessionFolder,
} from '../api';
import {
  MOVE_COPY,
  FOLDER_COPY,
  folderNameDraft,
  folderNameFailure,
  foldersByName,
  moveConfirmAction,
  moveConfirmParagraphs,
  moveConfirmTitle,
  moveFailureText,
  moveTargetFolders,
  moveTargetFooter,
  moveTargetRows,
  movedToFolderToast,
  movedToWorkspaceToast,
  runWorkspaceMove,
  type MovePhase,
} from '../lib/sessionFolders';
import { ENGINE_PRESET } from '../lib/sessionProviderChoices';
import { isSessionTerminal } from '../lib/sessionState';
import { useToast } from '../lib/toast';
import { PROVIDER_OPTIONS } from '../lib/workspaceDefaults';
import { ProviderTile } from './ProviderGallery';

/** The session the dialog moves, as the list or the open conversation has it. */
export interface MoveDialogSession {
  id: string;
  title?: string | null;
  folderId?: string | null;
  projectId?: string;
}

const providerName = (slug: string): string =>
  PROVIDER_OPTIONS.find((o) => o.value === slug)?.label ?? slug;

/** The key the dialog reads its other workspaces under. Under the session's own key, so a
 *  reconnect's refetch of every open session reaches it too. */
export const moveTargetsKey = (sessionId: string) => ['session', sessionId, 'move-targets'] as const;

/**
 * Move (docs/session-folders-move-design.md §4, §5): file a session in one of its workspace's
 * folders, or move it to another workspace and one of that workspace's folders. The same panel the
 * iOS list opens: the first group files immediately and closes; the second opens a workspace's step,
 * whose folder pick asks for confirmation (End and Move for an idle session) before the move. Whether
 * a session can move, and where to, is the server's answer (`move-targets`), shown as it is.
 */
export function SessionMoveModal({
  open,
  session,
  workspace,
  folders,
  onClose,
}: {
  open: boolean;
  session: MoveDialogSession | null;
  /** The workspace the session is in now. */
  workspace: { id: string; name: string } | null;
  /** That workspace's folders, in any order. */
  folders: SessionFolder[];
  onClose: () => void;
}) {
  const { modal } = AntApp.useApp();
  const message = useToast();
  const qc = useQueryClient();
  // The workspace step on screen; null for the first one.
  const [step, setStep] = useState<SessionMoveTarget | null>(null);
  // Folders made from a workspace step, until the server's answer lists them.
  const [made, setMade] = useState<SessionMoveFolder[]>([]);
  // New Folder…'s inline name field, on whichever step is showing.
  const [naming, setNaming] = useState<{ draft: string; error: string | null; saving: boolean } | null>(null);
  // A move under way: filing in a folder, or End and Move's two steps. Everything waits for it.
  const [phase, setPhase] = useState<MovePhase | 'filing' | null>(null);
  const sessionId = session?.id ?? '';
  const targetsQ = useQuery({
    queryKey: moveTargetsKey(sessionId),
    queryFn: () => getSessionMoveTargets(sessionId),
    enabled: open && !!session,
    staleTime: 0,
  });

  useEffect(() => {
    if (open) return;
    setStep(null);
    setMade([]);
    setNaming(null);
    setPhase(null);
  }, [open]);

  if (!session || !workspace) return null;

  const busy = phase !== null;
  // Read defensively: an older server answers the route with something that isn't this shape.
  const answer = targetsQ.data && Array.isArray(targetsQ.data.targets) ? targetsQ.data : undefined;
  const byName = foldersByName(folders);
  // A session whose folder isn't among the workspace's (deleted since the row was read) is in no
  // folder, which is where the list shows it.
  const currentFolderId = byName.some((f) => f.id === session.folderId) ? (session.folderId ?? null) : null;
  const counts = new Map((answer?.folders ?? []).map((f) => [f.id, f.sessionCount] as const));

  const refreshAfterMove = (): void => {
    void qc.invalidateQueries({ queryKey: ['sessions'] });
    if (session.projectId) void qc.invalidateQueries({ queryKey: ['project-sessions', session.projectId] });
    void qc.invalidateQueries({ queryKey: ['session-counts'] });
    void qc.invalidateQueries({ queryKey: ['session', session.id], exact: true });
    void qc.invalidateQueries({ queryKey: ['session-folders'] });
  };

  // First group: file the session in a folder of its own workspace, or in none. Immediate, like
  // the iOS panel — the row moves at once and the dialog closes with a toast saying where to.
  const fileIn = async (folder: { id: string; name: string } | null): Promise<void> => {
    const destination = folder?.id ?? null;
    if (destination === currentFolderId) {
      onClose();
      return;
    }
    const origin = byName.find((f) => f.id === currentFolderId) ?? null;
    setPhase('filing');
    const previous = qc.getQueriesData<any[]>({ queryKey: ['sessions'] });
    qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, (old) =>
      Array.isArray(old) ? old.map((s) => (s.id === session.id ? { ...s, folderId: destination } : s)) : old,
    );
    try {
      await moveSession(session.id, { folderId: destination });
      message.success(movedToFolderToast(folder, origin));
      onClose();
    } catch (error) {
      previous.forEach(([key, value]) => qc.setQueryData(key, value));
      message.error("Couldn't move the session", moveFailureText(error));
    } finally {
      setPhase(null);
      refreshAfterMove();
    }
  };

  // A workspace step's folder pick: confirm, then move — ending the session first when it is idle.
  const runMove = async (target: SessionMoveTarget, folder: { id: string } | null, needsEnd: boolean): Promise<void> => {
    setPhase(needsEnd ? 'ending' : 'moving');
    const failure = await runWorkspaceMove({
      endingFirst: needsEnd,
      end: () => endSession(session.id),
      ended: async () => isSessionTerminal(await getSession(session.id)),
      move: () => moveSession(session.id, { folderId: folder?.id ?? null, workspaceId: target.workspaceId }),
      phase: setPhase,
    });
    setPhase(null);
    refreshAfterMove();
    void qc.invalidateQueries({ queryKey: ['workspaces'] });
    if (failure) {
      message.error("Couldn't move the session", failure);
      void targetsQ.refetch();
      return;
    }
    message.success(movedToWorkspaceToast(target.name));
    onClose();
  };

  const confirmMove = (target: SessionMoveTarget, folder: { id: string } | null, current: SessionMoveTargets): void => {
    modal.confirm({
      title: moveConfirmTitle(target),
      content: (
        <div className="move-confirm-body">
          {moveConfirmParagraphs(current, target, workspace.name).map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      ),
      okText: moveConfirmAction(current),
      cancelText: 'Cancel',
      onOk: () => {
        void runMove(target, folder, current.needsEnd);
      },
    });
  };

  // New Folder…: on the first step it is made in this workspace and the session goes into it; on a
  // workspace step it is made there and the move into it is confirmed.
  const createFolder = async (): Promise<void> => {
    if (!naming || naming.saving) return;
    const name = folderNameDraft(naming.draft);
    if (!name) return;
    const where = step ? { id: step.workspaceId, name: step.name } : workspace;
    setNaming({ ...naming, saving: true, error: null });
    let folder: SessionFolder;
    try {
      folder = await createSessionFolder({ workspaceId: where.id, name });
    } catch (error) {
      setNaming({ draft: naming.draft, saving: false, error: folderNameFailure(error, name, where.name, 'created') });
      return;
    }
    qc.setQueryData<SessionFolder[]>(['session-folders'], (old) => (old ? [...old, folder] : old));
    void qc.invalidateQueries({ queryKey: ['session-folders'] });
    setNaming(null);
    if (step) {
      setMade((m) => [...m, { id: folder.id, name: folder.name, sessionCount: 0 }]);
      if (answer) confirmMove(step, folder, answer);
    } else {
      void fileIn(folder);
    }
  };

  const nameField = naming && (
    <>
      <div className="move-dialog-option editing">
        <span className="move-dialog-icon folder">
          <FolderAddOutlined />
        </span>
        <input
          className={`folder-name-input${naming.error ? ' error' : ''}`}
          autoFocus
          maxLength={60}
          placeholder={FOLDER_COPY.namePlaceholder}
          aria-label="New folder name"
          value={naming.draft}
          readOnly={naming.saving}
          onChange={(e) => setNaming({ ...naming, draft: e.target.value, error: null })}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void createFolder();
            } else if (e.key === 'Escape') {
              // Cancels the name, not the dialog.
              e.stopPropagation();
              setNaming(null);
            }
          }}
        />
      </div>
      {naming.error && <div className="move-dialog-error">{naming.error}</div>}
    </>
  );
  const newFolderOption = !naming && (
    <MoveOption
      className="new"
      icon={<FolderAddOutlined />}
      label={MOVE_COPY.newFolder}
      disabled={busy}
      onClick={() => setNaming({ draft: '', error: null, saving: false })}
    />
  );

  const firstStep = (
    <>
      <div className="move-dialog-group">{MOVE_COPY.folderGroup(workspace.name)}</div>
      <div className="move-dialog-list">
        <MoveOption
          icon={<InboxOutlined />}
          label={MOVE_COPY.noFolder}
          checked={currentFolderId === null}
          disabled={busy}
          onClick={() => void fileIn(null)}
        />
        {byName.map((f) => (
          <MoveOption
            key={f.id}
            folder
            icon={<FolderOutlined />}
            label={f.name}
            count={counts.get(f.id)}
            checked={f.id === currentFolderId}
            disabled={busy}
            onClick={() => void fileIn(f)}
          />
        ))}
        {nameField}
        {newFolderOption}
      </div>
      {targetsQ.isPending ? (
        <>
          <div className="move-dialog-group">{MOVE_COPY.anotherWorkspaceGroup}</div>
          <div className="move-dialog-note">{MOVE_COPY.loadingWorkspaces}</div>
        </>
      ) : targetsQ.isError ? (
        <>
          <div className="move-dialog-group">{MOVE_COPY.anotherWorkspaceGroup}</div>
          <div className="move-dialog-note">
            Couldn’t load the other workspaces: {(targetsQ.error as Error).message}.
          </div>
        </>
      ) : answer && answer.targets.length > 0 ? (
        <>
          <div className="move-dialog-group">{MOVE_COPY.anotherWorkspaceGroup}</div>
          <div className="move-dialog-list">
            {moveTargetRows(answer, providerName).map((row) => (
              <button
                key={row.target.workspaceId}
                type="button"
                className={`move-dialog-option target${row.enabled ? '' : ' off'}`}
                disabled={!row.enabled || busy}
                onClick={() => {
                  setNaming(null);
                  setMade([]);
                  setStep(row.target);
                }}
              >
                <span className="move-dialog-tile">
                  <ProviderTile
                    slug={ENGINE_PRESET[row.target.provider] ?? row.target.provider}
                    label={providerName(row.target.provider)}
                    size={22}
                  />
                </span>
                <span className="move-dialog-name">
                  {row.target.name}
                  <small>{row.detail}</small>
                </span>
                {row.enabled && !row.target.runnerOnline && (
                  <span className="move-dialog-pill">{MOVE_COPY.runnerOffline}</span>
                )}
                {row.enabled && <RightOutlined className="move-dialog-chev" />}
              </button>
            ))}
          </div>
          {answer.reason && <div className="move-dialog-note">{answer.reason}</div>}
        </>
      ) : null}
    </>
  );

  const targetStep = step && (
    <>
      <div className="move-dialog-group">{MOVE_COPY.folderGroup(step.name)}</div>
      <div className="move-dialog-list">
        <MoveOption
          icon={<InboxOutlined />}
          label={MOVE_COPY.noFolder}
          disabled={busy || !answer}
          onClick={() => answer && confirmMove(step, null, answer)}
        />
        {moveTargetFolders(step, made).map((f) => (
          <MoveOption
            key={f.id}
            folder
            icon={<FolderOutlined />}
            label={f.name}
            count={f.sessionCount}
            disabled={busy || !answer}
            onClick={() => answer && confirmMove(step, f, answer)}
          />
        ))}
        {nameField}
        {newFolderOption}
      </div>
      <p className="move-dialog-foot">{moveTargetFooter(step)}</p>
    </>
  );

  return (
    <Modal
      open={open}
      onCancel={busy ? undefined : onClose}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      footer={null}
      width={460}
      className="move-dialog"
      title={
        step ? (
          <span className="move-dialog-title">
            <button
              type="button"
              className="move-dialog-back"
              aria-label="Back"
              disabled={busy}
              onClick={() => {
                setNaming(null);
                setStep(null);
              }}
            >
              <LeftOutlined />
            </button>
            {step.name}
          </span>
        ) : (
          MOVE_COPY.title
        )
      }
      destroyOnHidden
    >
      <div className="move-dialog-sub">{session.title || 'Untitled session'}</div>
      {step ? targetStep : firstStep}
      {phase && phase !== 'filing' && (
        <div className="move-dialog-progress" role="status">
          <Spin size="small" />
          {phase === 'ending' ? MOVE_COPY.ending : MOVE_COPY.moving}
        </div>
      )}
    </Modal>
  );
}

function MoveOption({
  icon,
  label,
  count,
  checked = false,
  folder = false,
  className = '',
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  checked?: boolean;
  folder?: boolean;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`move-dialog-option ${className}`}
      aria-pressed={checked}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={`move-dialog-icon${folder ? ' folder' : ''}`}>{icon}</span>
      <span className="move-dialog-name">{label}</span>
      {count !== undefined && <span className="move-dialog-count">{count}</span>}
      {checked && <CheckOutlined className="move-dialog-check" />}
    </button>
  );
}
