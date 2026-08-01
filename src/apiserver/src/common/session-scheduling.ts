import { RunStatus } from '@prisma/client';

/**
 * A runner slot represents active execution, not a resident (warm) runtime process.
 * Keep this separate from the broader "open/live session" sets used by streaming,
 * cancellation and resumability.
 */
export const ACTIVE_TURN_STATUSES: RunStatus[] = [RunStatus.RUNNING];

/** Non-terminal sessions retained across runner restart (active ones plus cold/warm state). */
export const OPEN_SESSION_STATUSES: RunStatus[] = [
  RunStatus.PENDING,
  RunStatus.RUNNING,
  RunStatus.AWAITING_INPUT,
  RunStatus.INTERRUPTED,
];

/** Queueing work onto an idle interactive session requires a fresh runner slot. */
export function statusAfterTurnEnqueued(status: RunStatus): RunStatus {
  return status === RunStatus.AWAITING_INPUT || status === RunStatus.INTERRUPTED
    ? RunStatus.PENDING
    : status;
}

/** Keep an already-held slot only when another executable turn is already queued. */
export function statusAfterTurnCompleted(hasPendingExecutableTurn: boolean): RunStatus {
  return hasPendingExecutableTurn ? RunStatus.RUNNING : RunStatus.AWAITING_INPUT;
}

/** Losing a runner is fatal only while that runner is actively executing work. */
export function runnerOfflineIsFatal(status: RunStatus): boolean {
  return status === RunStatus.RUNNING;
}
