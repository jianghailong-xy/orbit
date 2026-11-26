/**
 * Why a task's run ended the way it did, as the status pill of the task run sidebar says it
 * (docs/task-run-sidebar-design.md: `Failed · check exited 1`). One table for every client, so the
 * web column and the phones' task card name the same cause in the same words.
 *
 * The cause is read from the run's own outcome, newest fact first: the acceptance rounds Orbit ran
 * (migration 1672), the session's error sentence, then how its last turn ended or why it was ended.
 */

/** The causes a pill can name. */
export type TaskStatusReasonKey =
  | 'CHECK_EXITED'
  | 'RUN_STOPPED'
  | 'RUN_INTERRUPTED'
  | 'OVER_BUDGET'
  | 'RUNNER_LOST'
  | 'RUN_FAILED';

/** The words for each cause, after the status and a ` · `. `CHECK_EXITED` takes the code. */
export const TASK_STATUS_REASON_COPY = {
  CHECK_EXITED: (exitCode: number) => `check exited ${exitCode}`,
  RUN_STOPPED: 'run stopped',
  RUN_INTERRUPTED: 'run interrupted',
  OVER_BUDGET: 'over budget',
  RUNNER_LOST: 'runner lost',
  RUN_FAILED: 'run failed',
} as const satisfies Record<TaskStatusReasonKey, string | ((exitCode: number) => string)>;

/** What a cause is read from: one run of the task, as GET /tasks/:id lists it. */
export interface TaskStatusReasonInput {
  /** The run's acceptance rounds, newest first. */
  acceptanceRounds?: ReadonlyArray<{ exitCode: number | null; expectedExitCode: number }> | null;
  /** The session's error sentence, when it has one. */
  error?: string | null;
  /** `session.end_reason` (a SessionEndReason value). */
  endReason?: string | null;
  /** How the session's last turn ended (SessionTurnOutcome). */
  lastTurnOutcome?: string | null;
}

export type TaskStatusReason = { key: 'CHECK_EXITED'; exitCode: number } | { key: Exclude<TaskStatusReasonKey, 'CHECK_EXITED'> };

/** What the runner reports for a command that returned no code of its own (a timeout kill, a signal). */
const NO_COMPARABLE_EXIT_CODE = -1;

/** The apiserver's run outcome for a disagreeing round (tasks/executable-acceptance-round.ts). */
const ACCEPTANCE_SENTENCE = /^acceptance command exited (-?\d+); expected (-?\d+)$/;

/** Why this run failed, or null when nothing it carries names a cause. */
export function taskFailureReason(run: TaskStatusReasonInput | null | undefined): TaskStatusReason | null {
  if (!run) return null;
  const newest = run.acceptanceRounds?.[0];
  if (newest && newest.exitCode !== newest.expectedExitCode) {
    return { key: 'CHECK_EXITED', exitCode: newest.exitCode ?? NO_COMPARABLE_EXIT_CODE };
  }
  const error = run.error?.trim() ?? '';
  const acceptance = ACCEPTANCE_SENTENCE.exec(error);
  if (acceptance) return { key: 'CHECK_EXITED', exitCode: Number(acceptance[1]) };
  // The reaper's sentence for a run whose runner stopped answering (realtime/reaper.service.ts).
  if (/\brunner (offline|lost)\b/i.test(error)) return { key: 'RUNNER_LOST' };
  if (/\b(over|exceeded (its|the)) budget\b|\bbudget exceeded\b/i.test(error)) return { key: 'OVER_BUDGET' };
  const endReason = String(run.endReason ?? '').toLowerCase();
  if (run.lastTurnOutcome === 'CANCELLED' || endReason === 'cancelled' || endReason === 'task_cancelled') {
    return { key: 'RUN_STOPPED' };
  }
  if (run.lastTurnOutcome === 'INTERRUPTED') return { key: 'RUN_INTERRUPTED' };
  if (error || run.lastTurnOutcome === 'FAILED') return { key: 'RUN_FAILED' };
  return null;
}

/** The cause in words: `check exited 1`, `runner lost`. */
export function taskStatusReasonText(reason: TaskStatusReason): string {
  return reason.key === 'CHECK_EXITED'
    ? TASK_STATUS_REASON_COPY.CHECK_EXITED(reason.exitCode)
    : TASK_STATUS_REASON_COPY[reason.key];
}
