import { Link } from 'react-router-dom';
import {
  MANAGED_RUNNER_COPY,
  MANAGED_RUNNER_NEXT_TRY_COPY,
  managedRunnerNextTry,
  type ManagedRunnerNextTry,
  type ManagedRunnerStatus,
} from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { useManagedRunnerActions, type ManagedRunner } from '../lib/managedRunner';
import { Button } from './ui/Button';
import { useConfirm } from './ui/ConfirmDialog';
import { Spinner } from './ui/Spinner';
import './ManagedRunnerNotice.css';

/** "Attempt 6 · next automatic try at Oct 9, 8:30 AM", under the cause of a runner restarting or failed with a next try. */
export function nextTryLine(next: ManagedRunnerNextTry): string {
  const when = next.at
    ? MANAGED_RUNNER_NEXT_TRY_COPY.at(next.at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
    : MANAGED_RUNNER_NEXT_TRY_COPY.due;
  return `${MANAGED_RUNNER_NEXT_TRY_COPY.attempt(next.attempt)} · ${when}`;
}

/** The kinds that ask for somebody's attention rather than time. */
const ATTENTION = new Set(['failed', 'waitingOperator', 'removed', 'removing', 'notOffered', 'modelUnavailable']);

/**
 * The managed runner's state in the shared display's words, with only the actions the server
 * allows: Retry (POST /managed-runner/retry; Retry now while an automatic try is scheduled anyway), Set up (POST /managed-runner/ensure), and the way to
 * the runner's runtimes when what it lacks is one signed in. Above the composer of a workspace on
 * the managed runner, and on the default landing of an account with nothing to open yet.
 */
export function ManagedRunnerNotice({
  managed,
  className,
  confirmEnsure = false,
  onEnsured,
}: {
  managed: ManagedRunner;
  className?: string;
  /**
   * Ask before Set up (D3 of docs/managed-runner-existing-account-entry-design.md): an account that already
   * has a runner or a workspace is told what it adds. The new account's landing sets up at one click.
   */
  confirmEnsure?: boolean;
  /** The server's answer to Set up, when it took it. */
  onEnsured?: (status: ManagedRunnerStatus) => void;
}) {
  const { retry, ensure } = useManagedRunnerActions();
  const [confirm, confirmation] = useConfirm();
  const { status, display } = managed;
  const setUp = () => ensure.mutate(undefined, { onSuccess: (answer) => onEnsured?.(answer) });
  const pressSetUp = () => {
    if (!confirmEnsure) return setUp();
    void confirm({
      title: MANAGED_RUNNER_COPY.confirm.title,
      description: MANAGED_RUNNER_COPY.confirm.body,
      cancelText: MANAGED_RUNNER_COPY.confirm.cancel,
      confirmText: MANAGED_RUNNER_COPY.confirm.confirm,
      onConfirm: setUp,
    });
  };
  const tone = ATTENTION.has(display.kind) ? ' attention' : '';
  // A stopped instance restarting, or failed with its slow retry scheduled: the attempt and when it is tried again.
  const next = managedRunnerNextTry(status);
  return (
    <div
      className={`managed-runner-notice${tone}${className ? ` ${className}` : ''}`}
      role="status"
      data-kind={display.kind}
    >
      {display.moving ? (
        <Spinner size="small" aria-hidden />
      ) : (
        <span className="managed-runner-notice-dot" aria-hidden />
      )}
      <div className="managed-runner-notice-text">
        <div className="managed-runner-notice-title">{display.title}</div>
        <div className="managed-runner-notice-detail">{display.detail}</div>
        {next && <div className="managed-runner-notice-next">{nextTryLine(next)}</div>}
      </div>
      {(display.retry || display.ensure || display.signIn) && (
        <div className="managed-runner-notice-actions">
          {display.signIn && status.runnerId && (
            <Link to={`/settings/machines/${encodeId(status.runnerId)}`}>{MANAGED_RUNNER_COPY.signIn}</Link>
          )}
          {display.retry && (
            <Button size="small" loading={retry.isPending} onClick={() => retry.mutate(status)}>
              {next ? MANAGED_RUNNER_NEXT_TRY_COPY.retryNow : MANAGED_RUNNER_COPY.retry}
            </Button>
          )}
          {display.ensure && (
            <Button size="small" variant="primary" loading={ensure.isPending} onClick={pressSetUp}>
              {MANAGED_RUNNER_COPY.ensure}
            </Button>
          )}
        </div>
      )}
      {confirmation}
    </div>
  );
}

/**
 * The default landing of an account with no runner and no workspace while managed runners are on:
 * its managed runner's state instead of the registration guide, which stays one link away.
 */
export function ManagedRunnerLanding({ managed }: { managed: ManagedRunner }) {
  return (
    <main className="app-main">
      <div className="app-view app-view--doc managed-runner-landing">
        <ManagedRunnerNotice managed={managed} />
        <Link className="managed-runner-landing-register" to="/runners/register">
          {MANAGED_RUNNER_COPY.registerOwn}
        </Link>
      </div>
    </main>
  );
}
