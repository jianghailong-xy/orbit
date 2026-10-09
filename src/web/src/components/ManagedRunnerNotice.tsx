import { Link } from 'react-router-dom';
import { MANAGED_RUNNER_COPY } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { useManagedRunnerActions, type ManagedRunner } from '../lib/managedRunner';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';
import './ManagedRunnerNotice.css';

/** The kinds that ask for somebody's attention rather than time. */
const ATTENTION = new Set(['failed', 'waitingOperator', 'removed', 'removing', 'notOffered', 'modelUnavailable']);

/**
 * The managed runner's state in the shared display's words, with only the actions the server
 * allows: Retry (POST /managed-runner/retry), Set up (POST /managed-runner/ensure), and the way to
 * the runner's runtimes when what it lacks is one signed in. Above the composer of a workspace on
 * the managed runner, and on the default landing of an account with nothing to open yet.
 */
export function ManagedRunnerNotice({ managed, className }: { managed: ManagedRunner; className?: string }) {
  const { retry, ensure } = useManagedRunnerActions();
  const { status, display } = managed;
  const tone = ATTENTION.has(display.kind) ? ' attention' : '';
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
      </div>
      {(display.retry || display.ensure || display.signIn) && (
        <div className="managed-runner-notice-actions">
          {display.signIn && status.runnerId && (
            <Link to={`/infrastructure?runner=${encodeId(status.runnerId)}`}>{MANAGED_RUNNER_COPY.signIn}</Link>
          )}
          {display.retry && (
            <Button size="small" loading={retry.isPending} onClick={() => retry.mutate(status)}>
              {MANAGED_RUNNER_COPY.retry}
            </Button>
          )}
          {display.ensure && (
            <Button size="small" variant="primary" loading={ensure.isPending} onClick={() => ensure.mutate()}>
              {MANAGED_RUNNER_COPY.ensure}
            </Button>
          )}
        </div>
      )}
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
