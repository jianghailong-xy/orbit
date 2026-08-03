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

/**
 * PENDING -> RUNNING must go through QueueService.trySessionClaim.
 *
 * Migration 0080 installs a BEFORE UPDATE trigger on `session` that silently drops that exact
 * transition for an OpenCode row unless the transaction set the `orbit.runner_supports_opencode`
 * GUC — which only the claim path does. A second writer would therefore no-op without raising.
 * Add new work-dispatch paths to the queue, not beside it.
 */

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
