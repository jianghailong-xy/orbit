import { LoadingOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../lib/queries';
import { CLONE_WAIT_STARTS, cloneWaitTitle } from '../lib/runnerSlots';
import { cloneNow, githubRepositoryOf, useCloneHeard } from '../lib/workspaceClone';
import './MachineSetupCard.css';

/** The session's workspace as the detail carries it: enough to say which repository is cloning. */
export interface CloneWaitWorkspace {
  id: string;
  repoUrl?: string | null;
  cloneState?: string | null;
}

/**
 * Where a held session's clone stands, or null when this is not a GitHub clone still under way (then the
 * plain queued words stand). Failed is not drawn here: RunNeverStartedCard says why, with Retry.
 */
export function useCloneWait(sessionId: string | null | undefined, workspace: CloneWaitWorkspace | null | undefined) {
  const qc = useQueryClient();
  const heard = useCloneHeard(workspace?.cloneState ? workspace.id : null);
  if (!sessionId || !workspace?.cloneState) return null;
  const storedAt = qc.getQueryState(sessionQuery(sessionId).queryKey)?.dataUpdatedAt || undefined;
  const clone = cloneNow(workspace.cloneState, heard, storedAt);
  const repository = githubRepositoryOf(workspace.repoUrl);
  if (!clone || !repository || (clone.state !== 'PENDING' && clone.state !== 'CLONING')) return null;
  return { state: clone.state, progress: clone.progress, repository };
}

/**
 * The waiting card of a session held by its workspace's clone (board docs/mocks/clone-progress-wait-card ②): what is
 * cloning, git's percentage once it has said one, and where. The full-height card and the one under a transcript
 * both draw it.
 */
export function CloneWaitNotice({
  clone,
  machine,
  spinner = true,
}: {
  clone: NonNullable<ReturnType<typeof useCloneWait>>;
  machine: string;
  /** Off where the card's own dots already say it is waiting. */
  spinner?: boolean;
}) {
  const title = cloneWaitTitle(clone.state, clone.repository);
  return (
    <>
      <div className="chat-queued-title">
        {spinner && clone.progress === null && <><LoadingOutlined className="msc-clone-spin" aria-hidden="true" />{' '}</>}
        {title}
      </div>
      {clone.progress !== null && (
        <div className="chat-clone-meter" aria-live="polite">
          <span
            className="msc-clone-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={clone.progress}
            aria-label={title}
          >
            <i style={{ width: `${clone.progress}%` }} />
          </span>
          <span className="msc-clone-pct">{`${clone.progress}%`}</span>
        </div>
      )}
      <div className="chat-queued-desc chat-clone-desc">
        On <b>{machine}</b>. {CLONE_WAIT_STARTS}
      </div>
    </>
  );
}
