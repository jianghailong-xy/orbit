import { useState } from 'react';
import { RightOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ENGINE_CLI_NAMES, isEngine, type SessionMoveTargets } from '@orbit/shared';
import { api, endSession, getSession, getSessionMoveTargets, moveSession } from '../api';
import {
  CHANGE_COPY,
  changeMoveParagraphs,
  changeNewAction,
  changeNewParagraphs,
  changeRowsFromTargets,
  changeRowsFromWorkspaces,
  changeTitle,
  type ChangeRow,
  type OutgoingCoordinator,
  type PickerWorkspace,
} from '../lib/coordinatorWorkspace';
import { encodeId } from '../lib/idCodec';
import { runnersQuery, workspacesQuery } from '../lib/queries';
import { moveFilesSentence, movedToWorkspaceToast, runWorkspaceMove, type MovePhase } from '../lib/sessionFolders';
import { ENGINE_PRESET } from '../lib/sessionProviderChoices';
import { isSessionTerminal } from '../lib/sessionState';
import { useToast } from '../lib/toast';
import { useRefreshSessionLists } from '../lib/useControlPlane';
import { ProviderTile } from './ProviderGallery';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Spinner } from './ui/Spinner';

/** What `POST /projects/:id/coordinator` and its `/replace` answer with: the conversation the
 *  project is now coordinated from, and the workspace it runs in. */
export interface CoordinatorResult {
  sessionId: string;
  created: boolean;
  workspaceId: string | null;
}

/** Where a resolved coordinator is read. Through `encodeId`, like every other link in the app, so
 *  a response carrying the raw UUID and one carrying the short public id land on one route. */
export const coordinatorSessionPath = (sessionId: string): string =>
  `/sessions/${encodeURIComponent(encodeId(sessionId))}`;

/**
 * Leave this project's coordinator conversation behind and open its next one.
 *
 * A different route from the open, not a flag on it: `openProjectCoordinator` is what every link to
 * a coordinator presses, and it RESOLVES — pressing it on a finished conversation hands that same
 * conversation back. Only this one replaces, and it is reachable only from a button that says it will.
 *
 * `workspaceId` names where the new one opens (Change's "Start a new one there"); the project is
 * coordinated from there afterwards. Without it the replacement opens where the last one ran.
 *
 * On a conversation that is still open the server COMPLETES it before the new one is created, which
 * is the whole reason the caller asks first: this request ends a conversation that may be mid-turn.
 */
export function replaceProjectCoordinator(projectId: string, workspaceId?: string): Promise<CoordinatorResult> {
  return api<CoordinatorResult>(`/projects/${encodeURIComponent(projectId)}/coordinator/replace`, { method: 'POST', body: workspaceId ? { workspaceId } : {} });
}

const providerName = (slug: string): string => (isEngine(slug) ? ENGINE_CLI_NAMES[slug] : slug);

/** The coordinator as the project page's status read has it — only what Change needs. */
export interface ChangeCoordinator {
  /** The conversation that can come along: one that exists and is not in Trash. */
  sessionId: string | null;
  outgoing: OutgoingCoordinator;
  workspaceId: string | null;
  workspaceName: string | null;
}

/**
 * Change (docs/mocks/coordinator-move-workspace/04-change): where a project is coordinated from.
 * Lists the owner's workspaces, each saying whether the coordinator conversation comes along; a
 * pick asks once — Move conversation or Start a new one there where both work, only the new start
 * where the conversation cannot come — and then does it. The project follows either way, on the
 * server: a coordinator's move moves its project's coordination, and a replacement names it.
 */
export function CoordinatorChangeDialog({
  projectId,
  projectTitle,
  coordinator,
  onClose,
}: {
  projectId: string;
  projectTitle: string;
  coordinator: ChangeCoordinator;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const message = useToast();
  const refreshSessionLists = useRefreshSessionLists();
  const [picked, setPicked] = useState<ChangeRow | null>(null);
  const [phase, setPhase] = useState<MovePhase | 'starting' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const sessionId = coordinator.sessionId;
  const targetsQ = useQuery({
    queryKey: ['session', sessionId, 'move-targets'],
    queryFn: () => getSessionMoveTargets(sessionId as string),
    enabled: !!sessionId,
    staleTime: 0,
  });
  const workspaces = useQuery({ ...workspacesQuery(), enabled: !sessionId });
  const runners = useQuery({ ...runnersQuery(), enabled: !sessionId });

  // Read defensively: an older server answers move-targets with something that isn't this shape.
  const answer: SessionMoveTargets | undefined =
    targetsQ.data && Array.isArray(targetsQ.data.targets) ? targetsQ.data : undefined;
  const from = coordinator.workspaceName;
  const rows: ChangeRow[] | null = sessionId
    ? answer && coordinator.workspaceId
      ? changeRowsFromTargets(answer, { id: coordinator.workspaceId, name: from ?? '' }, providerName)
      : null
    : workspaces.data
      ? changeRowsFromWorkspaces(
          workspaces.data as PickerWorkspace[],
          coordinator.workspaceId,
          runners.data ? new Set(runners.data.filter((r: { online?: boolean }) => r.online).map((r: { id: string }) => r.id)) : null,
          providerName,
        )
      : null;
  const loadError = sessionId ? targetsQ.error : workspaces.error;
  const busy = phase !== null;

  const settle = (): void => {
    refreshSessionLists();
    void qc.invalidateQueries({ queryKey: ['project', projectId] });
    void qc.invalidateQueries({ queryKey: ['workspaces'] });
    if (sessionId) void qc.invalidateQueries({ queryKey: ['session', sessionId] });
  };

  const moveConversation = async (to: ChangeRow): Promise<void> => {
    if (!sessionId || !answer) return;
    setFailure(null);
    const why = await runWorkspaceMove({
      endingFirst: answer.needsEnd,
      end: () => endSession(sessionId),
      ended: async () => isSessionTerminal(await getSession(sessionId)),
      // Into the target's No Folder: the project page does not file conversations.
      move: () => moveSession(sessionId, { folderId: null, workspaceId: to.workspaceId }),
      phase: setPhase,
    });
    setPhase(null);
    settle();
    if (why) {
      setFailure(why);
      void targetsQ.refetch();
      return;
    }
    message.success(movedToWorkspaceToast(to.name));
    onClose();
  };

  const startThere = async (to: ChangeRow): Promise<void> => {
    setFailure(null);
    setPhase('starting');
    try {
      const result = await replaceProjectCoordinator(projectId, to.workspaceId);
      settle();
      onClose();
      navigate(coordinatorSessionPath(result.sessionId));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'something went wrong');
    } finally {
      setPhase(null);
    }
  };

  const progress = phase && (
    <div className="move-dialog-progress" role="status">
      <Spinner size="small" aria-hidden />
      {phase === 'ending' ? 'Ending the session…' : phase === 'moving' ? 'Moving…' : 'Starting…'}
    </div>
  );

  if (picked) {
    const canMove = picked.way === 'move' && !!answer;
    const paragraphs = canMove
      ? changeMoveParagraphs({
          to: picked.name,
          from: from ?? '',
          needsEnd: answer!.needsEnd,
          files: moveFilesSentence(answer!, from ?? ''),
        })
      : changeNewParagraphs({ to: picked.name, from, outgoing: coordinator.outgoing, reason: picked.reason });
    return (
      <Dialog
        open
        onClose={() => (busy ? undefined : setPicked(null))}
        busy={busy}
        closable={!busy}
        width={520}
        className="coordinator-change-confirm"
        title={changeTitle(projectTitle, picked.name)}
        footer={
          <>
            <Button disabled={busy} onClick={() => setPicked(null)}>{CHANGE_COPY.cancel}</Button>
            {canMove ? (
              <>
                <Button disabled={busy} onClick={() => void startThere(picked)}>{CHANGE_COPY.startThere}</Button>
                <Button variant="primary" disabled={busy} onClick={() => void moveConversation(picked)}>
                  {CHANGE_COPY.move}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                danger={coordinator.outgoing === 'open'}
                disabled={busy}
                onClick={() => void startThere(picked)}
              >
                {changeNewAction(picked.name, coordinator.outgoing)}
              </Button>
            )}
          </>
        }
      >
        <div className="move-confirm-body">
          {paragraphs.map((p) => <p key={p}>{p}</p>)}
        </div>
        {progress}
        {failure && <div className="move-dialog-error">{failure}</div>}
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} width={480} className="move-dialog" title={CHANGE_COPY.title}>
      <div className="move-dialog-sub">{CHANGE_COPY.sub(projectTitle, from)}</div>
      {rows == null ? (
        <div className="move-dialog-note">
          {loadError ? `Couldn’t load the workspaces: ${(loadError as Error).message}.` : 'Loading workspaces…'}
        </div>
      ) : (
        <div className="move-dialog-list">
          {rows.map((row) => (
            <button
              key={row.workspaceId}
              type="button"
              className={`move-dialog-option target${row.way ? '' : ' off'}`}
              disabled={!row.way}
              onClick={() => setPicked(row)}
            >
              <span className="move-dialog-tile">
                <ProviderTile slug={ENGINE_PRESET[row.provider] ?? row.provider} label={providerName(row.provider)} size={22} />
              </span>
              <span className="move-dialog-name">
                {row.name}
                <small>{row.detail}</small>
              </span>
              {row.current && <span className="move-dialog-pill">{CHANGE_COPY.current}</span>}
              {row.runnerOffline && <span className="move-dialog-pill">{CHANGE_COPY.runnerOffline}</span>}
              {row.way && (
                <span className={`move-dialog-way ${row.way}`}>
                  {row.way === 'move' ? CHANGE_COPY.comesAlong : CHANGE_COPY.newConversation}
                </span>
              )}
              {row.way && <RightOutlined className="move-dialog-chev" />}
            </button>
          ))}
        </div>
      )}
      <p className="move-dialog-foot">{CHANGE_COPY.foot}</p>
    </Dialog>
  );
}
