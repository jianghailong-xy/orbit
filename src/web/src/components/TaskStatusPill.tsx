import { LoadingOutlined } from '@ant-design/icons';
import type { TaskRunReason } from '@orbit/shared';
import { sessionDisplayState, sessionDisplayText, sessionMarks } from '../lib/sessionDisplay';
import { SessionMarkChips, SessionStateGlyph } from './SessionStateDisplay';

const STATUS_PILL: Record<string, { cls: string; label: string }> = {
  DONE: { cls: 'done', label: 'Done' },
  IN_PROGRESS: { cls: 'ongoing', label: 'In progress' },
  OPEN: { cls: 'todo', label: 'Open' },
  FAILED: { cls: 'failed', label: 'Failed' },
  CANCELLED: { cls: 'cancelled', label: 'Cancelled' },
};

const PHASE_CLS = { PENDING: 'queued', RUNNING: 'running', IDLE: 'todo' } as const;

export function taskStatusLabel(status: string, running?: boolean, queued?: boolean, queuedOnHold?: boolean): string {
  if (running) return 'Running';
  if (queued) return queuedOnHold ? 'On hold' : 'Queued';
  return STATUS_PILL[status]?.label ?? status;
}

/**
 * A task row's live run as the session facts lib/sessionDisplay reads. A server that says whether the task's queued run
 * is held (`queuedOnHold`) has the facts. A task's row carries the run as `running` / `queued`, `runReason` and
 * `queuedOnHold`: a WAITING run is parked on a watch, a wake-up or a retry (Idle, no mark), a BACKGROUND_JOB one
 * wears Background, a held queue On hold. The run's other facts are not on the row. Null with no live run, and from an
 * older server.
 */
function taskRunSource(running?: boolean, queued?: boolean, queuedOnHold?: boolean, runReason?: TaskRunReason | null) {
  if (!(running || queued) || typeof queuedOnHold !== 'boolean') return null;
  const waiting = running && runReason === 'WAITING';
  return {
    phase: waiting ? 'IDLE' : running ? 'RUNNING' : 'PENDING',
    released: false,
    waitingOn: waiting ? 'WAKE' : !running && queuedOnHold ? 'HOLD' : null,
    activity: runReason,
  };
}

/** What the pill says, as one line for an accessible name: the live run's state and marks, else its legacy word. */
export function taskStatusPillText({
  status,
  running,
  queued,
  queuedOnHold,
  runReason,
}: {
  status: string;
  running?: boolean;
  queued?: boolean;
  queuedOnHold?: boolean;
  runReason?: TaskRunReason | null;
}): string {
  const run = taskRunSource(running, queued, queuedOnHold, runReason);
  return (run && sessionDisplayText(run)) ?? taskStatusLabel(status, running, queued);
}

/**
 * Shared task lifecycle pill. Live session state wins over the stored task lifecycle so the
 * dependency graph and the task list describe a running/queued task in the same way.
 */
export function TaskStatusPill({
  status,
  running,
  queued,
  queuedOnHold,
  runReason,
}: {
  status: string;
  running?: boolean;
  queued?: boolean;
  /** The queued run is held (the server's `queuedOnHold`); absent from an older server, which reads "Queued". */
  queuedOnHold?: boolean;
  /** Why the row's `running` run is running (the server's `runReason`): WAITING is a parked run something will wake. */
  runReason?: TaskRunReason | null;
}) {
  // With the facts, the pill says the live run's state, with that state's icon and its marks beside it
  // (lib/sessionDisplay). From an older server, the pill as before.
  const run = taskRunSource(running, queued, queuedOnHold, runReason);
  if (run) {
    const shown = sessionDisplayState(run);
    const marks = sessionMarks(run);
    if (shown) {
      const pill = (
        <span className={`status-pill ${PHASE_CLS[shown.phase]}`}>
          <SessionStateGlyph state={shown} size={12} />
          {shown.word}
        </span>
      );
      return marks && marks.length > 0 ? (
        <span className="task-status-pill-run">
          {pill}
          <SessionMarkChips marks={marks} />
        </span>
      ) : pill;
    }
  }
  if (running) {
    return (
      <span className="status-pill running">
        <LoadingOutlined spin />
        Running
      </span>
    );
  }
  if (queued) {
    return (
      <span className="status-pill queued">
        <span className="status-dot" />
        {queuedOnHold ? 'On hold' : 'Queued'}
      </span>
    );
  }
  const s = STATUS_PILL[status] ?? { cls: 'todo', label: status };
  return (
    <span className={`status-pill ${s.cls}`}>
      <span className="status-dot" />
      {s.label}
    </span>
  );
}
