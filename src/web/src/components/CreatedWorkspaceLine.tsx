import { ExclamationCircleFilled, ExportOutlined, GithubOutlined, HomeOutlined, LoadingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type SessionDetail } from '../api';
import { connectGithub, githubIntegrationQuery } from '../lib/githubIntegration';
import { encodeId } from '../lib/idCodec';
import {
  CLONE_CLONING,
  CLONE_INSTALL_ON_GITHUB,
  CLONE_RECONNECT,
  CLONE_RETRY,
  CLONE_RETRY_FAILED,
  CLONE_SIGN_IN_EXPIRED,
  CLONE_WAITING,
  cloneAppRemoved,
  cloneCouldNot,
  setupGithubConnectFailed,
  CREATED_ON,
  CREATED_RENAME,
  CREATED_RENAME_FAILED,
  CREATED_RENAME_LABEL,
  CREATED_SETTINGS,
  CREATED_WORKSPACE,
} from '../lib/machineSetupCopy';
import { sessionQuery, workspacesQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { useRefreshSessionLists } from '../lib/useControlPlane';
import { cloneFailureOf, cloneNow, githubRepositoryOf, hearClone, retryClone, useCloneHeard } from '../lib/workspaceClone';
import { Input } from './ui/Input';
import './MachineSetupCard.css';

/**
 * The first line of a conversation that made its workspace (board rule 8): what was made, where, and
 * the two ways to change it. Having said that is what lets the send ask nothing more first. Rename is
 * done here; Settings is the workspace's section on its machine's page, as its sidebar row's Configure.
 */
export function CreatedWorkspaceLine({
  sessionId,
  workspace,
  machine,
  runnerId,
}: {
  sessionId: string;
  workspace: {
    id: string;
    name: string;
    workDir?: string | null;
    deletedAt?: string | null;
    /** A workspace cloned from GitHub (docs/github-workspace-design.md §8): its repository and where the clone stands. */
    repoUrl?: string | null;
    cloneState?: string | null;
    cloneError?: string | null;
  };
  machine: string;
  runnerId: string;
}) {
  const qc = useQueryClient();
  const refreshSessionLists = useRefreshSessionLists();
  const navigate = useNavigate();
  const message = useToast();
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (name: string) => api(`/workspaces/${workspace.id}`, { method: 'PATCH', body: { name } }),
    onSuccess: (_saved, name) => {
      qc.setQueryData<SessionDetail>(sessionQuery(sessionId).queryKey, (detail) =>
        detail?.workspace ? { ...detail, workspace: { ...detail.workspace, name } } : detail,
      );
      void qc.invalidateQueries({ queryKey: workspacesQuery().queryKey });
      // The session list's rows carry the name too, and the column's title reads it from them.
      refreshSessionLists();
    },
    onError: (e: Error) => message.error(CREATED_RENAME_FAILED, e.message),
  });
  // Escape leaves through the same blur as Enter, and has to leave nothing behind.
  const dropped = useRef(false);
  const save = () => {
    const name = renaming?.trim();
    setRenaming(null);
    if (dropped.current) dropped.current = false;
    else if (name && name !== workspace.name) rename.mutate(name);
  };
  // A workspace deleted since is still what this conversation made; it just has nothing to change.
  const live = !workspace.deletedAt;
  const heard = useCloneHeard(workspace.cloneState ? workspace.id : null);
  // When the detail this line draws from was read: a frame heard before it is older news than its cloneState.
  const storedAt = qc.getQueryState(sessionQuery(sessionId).queryKey)?.dataUpdatedAt || undefined;
  const clone = workspace.cloneState ? cloneNow(workspace.cloneState, heard, storedAt) : null;
  const repository = clone ? githubRepositoryOf(workspace.repoUrl) : null;
  if (clone && repository && live && clone.state !== 'READY') {
    return (
      <CloneStatusLine
        sessionId={sessionId}
        workspaceId={workspace.id}
        repository={repository}
        machine={machine}
        state={clone.state}
        progress={clone.progress}
        error={workspace.cloneError ?? null}
      />
    );
  }
  return (
    <div className="msc-created">
      <HomeOutlined className="msc-created-mark" aria-hidden="true" />
      <span>{CREATED_WORKSPACE}</span>
      {renaming !== null ? (
        <Input
          className="msc-created-name"
          size="small"
          aria-label={CREATED_RENAME_LABEL}
          autoFocus
          value={renaming}
          onChange={(e) => setRenaming(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' || e.key === 'Escape') {
              dropped.current = e.key === 'Escape';
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <b>{rename.isPending ? rename.variables : workspace.name}</b>
      )}
      <span>
        {CREATED_ON} {machine}
      </span>
      {workspace.workDir && (
        <>
          <span className="msc-created-sep">·</span>
          <code>{workspace.workDir}</code>
        </>
      )}
      {repository && (
        <>
          <span className="msc-created-sep">·</span>
          <a className="msc-created-repo" href={`https://github.com/${repository}`} target="_blank" rel="noreferrer">
            <GithubOutlined aria-hidden="true" /> {repository}
          </a>
        </>
      )}
      {live && (
        <>
          <span className="msc-created-sep">·</span>
          <button className="msc-change" type="button" onClick={() => setRenaming(workspace.name)}>
            {CREATED_RENAME}
          </button>
          <span className="msc-created-sep">·</span>
          <button
            className="msc-change"
            type="button"
            onClick={() => navigate(`/settings/workspaces/${encodeId(workspace.id)}`)}
          >
            {CREATED_SETTINGS}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The same first line while a GitHub workspace's clone has not finished (board 01, P5): Cloning with git's percentage,
 * or why it failed with the way out — Retry always (POST /workspaces/:id/clone/retry), and before it what the reason
 * asks for: the App installed again, GitHub connected again, or the workspace's settings for a folder already taken.
 */
function CloneStatusLine({
  sessionId,
  workspaceId,
  repository,
  machine,
  state,
  progress,
  error,
}: {
  sessionId: string;
  workspaceId: string;
  repository: string;
  machine: string;
  state: 'PENDING' | 'CLONING' | 'FAILED';
  progress: number | null;
  error: string | null;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const message = useToast();
  const failure = state === 'FAILED' ? cloneFailureOf(error) : null;
  // Where to install the App again: only asked for when the App is what is missing.
  const integration = useQuery({ ...githubIntegrationQuery(), enabled: failure?.kind === 'appRemoved' });
  const retry = useMutation({
    mutationFn: () => retryClone(workspaceId),
    onSuccess: () => {
      hearClone(workspaceId, { state: 'PENDING', progress: null });
      void qc.invalidateQueries({ queryKey: sessionQuery(sessionId).queryKey });
    },
    onError: (e: Error) => message.error(CLONE_RETRY_FAILED, e.message),
  });
  const reconnect = async () => {
    try {
      await connectGithub(`${window.location.pathname}${window.location.search}`);
    } catch (e) {
      message.error(setupGithubConnectFailed((e as Error).message));
    }
  };
  const retryButton = (
    <button className="msc-change" type="button" disabled={retry.isPending} onClick={() => retry.mutate()}>
      {CLONE_RETRY}
    </button>
  );
  const settings = (
    <button className="msc-change" type="button" onClick={() => navigate(`/settings/workspaces/${encodeId(workspaceId)}`)}>
      {CREATED_SETTINGS}
    </button>
  );
  if (failure) {
    // The mark rides inside the reason, so a long reason wraps with it rather than leaving it on a row of its own.
    const mark = <ExclamationCircleFilled aria-hidden="true" />;
    if (failure.kind === 'appRemoved') {
      const installUrl = integration.data?.installUrl;
      return (
        <div className="msc-created" data-clone="FAILED" data-clone-failure="appRemoved">
          <span className="msc-clone-error">
            {mark} {cloneAppRemoved(repository)}
          </span>
          {installUrl && (
            <>
              <a href={installUrl} target="_blank" rel="noreferrer">
                {CLONE_INSTALL_ON_GITHUB} <ExportOutlined />
              </a>
              <span className="msc-created-sep">·</span>
            </>
          )}
          {retryButton}
        </div>
      );
    }
    if (failure.kind === 'signInExpired') {
      return (
        <div className="msc-created" data-clone="FAILED" data-clone-failure="signInExpired">
          <span className="msc-clone-error">
            {mark} {CLONE_SIGN_IN_EXPIRED}
          </span>
          <button className="msc-change" type="button" onClick={() => void reconnect()}>
            {CLONE_RECONNECT}
          </button>
          <span className="msc-created-sep">·</span>
          {retryButton}
        </div>
      );
    }
    const why = (error ?? '').trim().replace(/\.?$/, '.');
    return (
      <div className="msc-created" data-clone="FAILED" data-clone-failure={failure.kind}>
        <span className="msc-clone-error">
          {mark} {cloneCouldNot(repository, why)}
        </span>
        {retryButton}
        <span className="msc-created-sep">·</span>
        {settings}
      </div>
    );
  }
  return (
    <div className="msc-created" data-clone={state} aria-live="polite">
      <LoadingOutlined className="msc-clone-spin" aria-hidden="true" />
      <span>{state === 'CLONING' ? CLONE_CLONING : CLONE_WAITING}</span>
      <b>{repository}</b>
      <span>
        {CREATED_ON} <b>{machine}</b>
      </span>
      {progress !== null && (
        <>
          <span
            className="msc-clone-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label={`${CLONE_CLONING} ${repository}`}
          >
            <i style={{ width: `${progress}%` }} />
          </span>
          <span className="msc-clone-pct">{`${progress}%`}</span>
        </>
      )}
    </div>
  );
}
