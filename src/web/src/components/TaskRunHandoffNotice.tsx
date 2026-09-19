import { Link } from 'react-router-dom';
import type { useToast } from '../lib/toast';
import {
  OPEN_THE_RUN,
  TASK_RUN_HANDED_OVER_BODY,
  TASK_RUN_HANDED_OVER_TITLE,
  type TaskRunConflict,
  type TaskRunConflictAction,
  readTaskRunConflict,
  sessionHref,
} from '../lib/taskRunHandoff';

/**
 * What one task's current run looks like when it is not the session you are in.
 *
 * Drawn in three places off the same two components — the composer, the transcript's auto-retry
 * card, and a task's own entry — because they are three ways of meeting one situation and a reader
 * who saw it phrased differently in each would reasonably conclude they were three situations.
 * The words and the ways out come from `lib/taskRunHandoff.ts`; this file is only how they sit.
 *
 * `OPEN_RUN` is a real link, not a button that navigates: the run has an address, and a reader who
 * wants it in another tab should be able to take it the way they take every other link in this app.
 * It degrades to nothing when the answer named no session — which no current server does, and a
 * dead control would be worse than one less way out.
 */
export function TaskRunHandoffNotice({
  conflict,
  onAction,
  className,
}: {
  conflict: TaskRunConflict;
  /** Everything that is not a link: clearing a pin, answering a confirmation. */
  onAction?: (action: TaskRunConflictAction) => void;
  className?: string;
}) {
  return (
    <div
      className={`run-handoff run-handoff-${conflict.kind.toLowerCase()}${className ? ` ${className}` : ''}`}
      data-conflict={conflict.kind}
      role="status"
    >
      <div className="run-handoff-title">{conflict.title}</div>
      <div className="run-handoff-body">{conflict.body}</div>
      <div className="run-handoff-actions">
        {conflict.actions.map((action) =>
          action.kind === 'OPEN_RUN' ? (
            action.href && (
              <Link className="run-handoff-open" key={action.kind} to={action.href}>
                {action.label}
              </Link>
            )
          ) : (
            <button
              className={action.kind === 'STOP_AND_CONTINUE' ? 'run-handoff-stop' : 'run-handoff-btn'}
              key={action.kind}
              onClick={() => onAction?.(action)}
              type="button"
            >
              {action.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * The other half, and the one that is not a refusal: the message WAS delivered, to the run that
 * has the task. Headed differently from every conflict above for that reason — a reader whose
 * message landed is being told where it went, not that something went wrong.
 */
export function TaskRunHandedOverNotice({
  sessionId,
  onDismiss,
}: {
  sessionId: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="run-handoff run-handoff-sent" data-handed-over={sessionId} role="status">
      <div className="run-handoff-title">{TASK_RUN_HANDED_OVER_TITLE}</div>
      <div className="run-handoff-body">{TASK_RUN_HANDED_OVER_BODY}</div>
      <div className="run-handoff-actions">
        <Link className="run-handoff-open" onClick={onDismiss} to={sessionHref(sessionId)}>
          {OPEN_THE_RUN}
        </Link>
      </div>
    </div>
  );
}

/** What a Run/Retry press needs of the toast layer: a plain error, and the card that names a
 *  session and doubles as the way into it. Derived from `useToast` rather than restated, so a
 *  change to either one is a compile error here instead of a drift. */
export type TaskRunConflictToast = Pick<ReturnType<typeof useToast>, 'error' | 'sessionNotice'>;

/**
 * The same refusal, reported where there is no room for a card: a task's row, a task's header.
 *
 * Those presses have nowhere to put a persistent block, so the run goes into a session card —
 * which already opens the session it names, making "open the run" the card's own click rather
 * than a control invented for it. A conflict this build cannot read falls through to the server's
 * own words, exactly as it did before.
 */
export function reportTaskRunConflict(toast: TaskRunConflictToast, error: Error): void {
  const conflict = readTaskRunConflict(error);
  if (!conflict || !conflict.sessionId) {
    toast.error(error.message);
    return;
  }
  toast.sessionNotice({
    sessionId: conflict.sessionId,
    sessionTitle: 'The run working on this task',
    event: `task-run-${conflict.kind.toLowerCase()}`,
    headline: conflict.title,
    detail: conflict.body,
    tone: conflict.kind === 'HELD' || conflict.kind === 'ENDING' ? 'info' : 'warning',
  });
}
