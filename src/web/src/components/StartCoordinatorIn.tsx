import { RightOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ENGINE_CLI_NAMES, isEngine } from '@orbit/shared';
import { api } from '../api';
import {
  START_COORDINATOR_COPY,
  coordinatorWorkspaceRows,
  startCoordinatorAction,
  startCoordinatorParagraphs,
  startCoordinatorTitle,
  type OutgoingCoordinator,
  type PickerWorkspace,
} from '../lib/coordinatorWorkspace';
import { encodeId } from '../lib/idCodec';
import { runnersQuery, workspacesQuery } from '../lib/queries';
import { ENGINE_PRESET } from '../lib/sessionProviderChoices';
import { useToast } from '../lib/toast';
import { ProviderTile } from './ProviderGallery';
import { useConfirm } from './ui/ConfirmDialog';
import { Dialog } from './ui/Dialog';

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
 * `workspaceId` names where the new one opens ("Start a new coordinator in…"); the project is
 * coordinated from there afterwards. Without it the replacement opens where the last one ran.
 *
 * On a conversation that is still open the server COMPLETES it before the new one is created, which
 * is the whole reason the caller asks first: this request ends a conversation that may be mid-turn.
 */
export function replaceProjectCoordinator(projectId: string, workspaceId?: string): Promise<CoordinatorResult> {
  return api<CoordinatorResult>(`/projects/${encodeURIComponent(projectId)}/coordinator/replace`, { method: 'POST', body: workspaceId ? { workspaceId } : {} });
}

const providerName = (slug: string): string => (isEngine(slug) ? ENGINE_CLI_NAMES[slug] : slug);

/**
 * Pick the workspace a project's next coordinator opens in. The current one is listed too (marked
 * Current): picking it is the plain Start a new coordinator. A workspace a new conversation cannot
 * open in is greyed with the reason; an offline runner only carries a pill, as in Move.
 */
export function CoordinatorWorkspaceDialog({
  projectTitle,
  currentWorkspaceId,
  onPick,
  onClose,
}: {
  projectTitle: string;
  currentWorkspaceId: string | null;
  onPick: (workspace: { workspaceId: string; name: string; current: boolean }) => void;
  onClose: () => void;
}) {
  const workspaces = useQuery(workspacesQuery());
  const runners = useQuery(runnersQuery());
  const online = runners.data
    ? new Set(runners.data.filter((r: { online?: boolean }) => r.online).map((r: { id: string }) => r.id))
    : null;
  const rows = coordinatorWorkspaceRows(
    (workspaces.data ?? []) as PickerWorkspace[],
    currentWorkspaceId,
    online,
    providerName,
  );

  return (
    <Dialog open onClose={onClose} width={460} className="move-dialog" title={START_COORDINATOR_COPY.pickerTitle}>
      <div className="move-dialog-sub">{projectTitle}</div>
      <div className="move-dialog-list">
        {rows.map((row) => (
          <button
            key={row.workspaceId}
            type="button"
            className={`move-dialog-option target${row.reason ? ' off' : ''}`}
            disabled={row.reason != null}
            onClick={() => onPick({ workspaceId: row.workspaceId, name: row.name, current: row.current })}
          >
            <span className="move-dialog-tile">
              <ProviderTile slug={ENGINE_PRESET[row.provider] ?? row.provider} label={providerName(row.provider)} size={22} />
            </span>
            <span className="move-dialog-name">
              {row.name}
              <small>{row.detail}</small>
            </span>
            {row.current && <span className="move-dialog-pill">{START_COORDINATOR_COPY.current}</span>}
            {row.runnerOffline && <span className="move-dialog-pill">{START_COORDINATOR_COPY.runnerOffline}</span>}
            {!row.reason && !row.current && <RightOutlined className="move-dialog-chev" />}
          </button>
        ))}
      </div>
      <p className="move-dialog-foot">{START_COORDINATOR_COPY.pickerFoot}</p>
    </Dialog>
  );
}

/**
 * Ask, then start a project's next coordinator in a named workspace, and go to it. The question
 * says where the old conversation stays and what moves with the new one; the press completes an
 * open conversation, so it is the destructive button.
 */
export function useStartCoordinatorIn(projectId: string | null) {
  const [confirm, confirmation] = useConfirm();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const message = useToast();
  const start = useMutation({
    mutationKey: ['project', projectId, 'coordinator', 'replace'],
    mutationFn: (workspaceId: string) => replaceProjectCoordinator(projectId as string, workspaceId),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
      navigate(coordinatorSessionPath(result.sessionId));
    },
  });

  const ask = (args: {
    to: { workspaceId: string; name: string };
    project: string;
    from: string | null;
    outgoing: OutgoingCoordinator;
    onStarted?: () => void;
  }): void => {
    if (!projectId) return;
    void confirm({
      width: 480,
      title: startCoordinatorTitle(args.to.name),
      description: (
        <div className="move-confirm-body">
          {startCoordinatorParagraphs({ project: args.project, to: args.to.name, from: args.from, outgoing: args.outgoing }).map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      ),
      confirmText: startCoordinatorAction(args.to.name, args.outgoing),
      cancelText: START_COORDINATOR_COPY.keep,
      danger: args.outgoing === 'open',
      onConfirm: async () => {
        try {
          await start.mutateAsync(args.to.workspaceId);
          args.onStarted?.();
        } catch (error) {
          message.error("Couldn't start a new coordinator", error instanceof Error ? error.message : undefined);
        }
      },
    });
  };

  return { ask, confirmation, pending: start.isPending };
}
