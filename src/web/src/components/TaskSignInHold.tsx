import type { TaskSignInHold } from '@orbit/shared';
import { Link } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';
import { Badge } from './ui/Badge';

/**
 * A task the auto-run sweep holds because its engine is signed out on its runner (`hold` on the task
 * read): the row still reads Ready by every other fact, so it says Held, why, and where to sign in.
 * The server computes the hold by the sweep's own rule; nothing here re-derives it.
 */

/** "Held: Claude Code is signed out on mac". */
export function heldReason(hold: TaskSignInHold): string {
  return `Held: ${hold.engineLabel} is signed out on ${hold.runnerName}`;
}

/** The machine's Settings page with that engine's sign-in open: the app's one sign-in flow. */
export function signInHref(hold: Pick<TaskSignInHold, 'runnerId' | 'engine'>): string {
  return `/settings/machines/${encodeId(hold.runnerId)}?engine=${encodeURIComponent(hold.engine)}`;
}

/** The Held pill, its reason and Sign in, for a task row. A press on Sign in is not a press on the row. */
export function TaskSignInHoldNote({ hold }: { hold: TaskSignInHold }) {
  const reason = heldReason(hold);
  return (
    <span className="task-sign-in-hold" data-testid="task-sign-in-hold">
      <Badge tone="gold" title={reason}>
        Held
      </Badge>{' '}
      <span className="task-sign-in-hold-reason">{reason}</span>{' '}
      <Link
        className="task-sign-in-hold-action"
        to={signInHref(hold)}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        Sign in
      </Link>
    </span>
  );
}
