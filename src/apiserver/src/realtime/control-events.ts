import {
  ControlBackgroundTask,
  ControlEventType,
  ControlSessionError,
  RunEventType,
} from '@orbit/shared';

/**
 * Pure mapping helpers for the user-scoped control-plane stream (GET /api/events). Kept free
 * of Prisma/RxJS so the run-event → control-event translation is unit-testable on its own.
 * The DB-augmented parts (session summary, pending-approval count, owner resolution) live in
 * RealtimeService. See docs/realtime-control-plane-stream.md.
 */

/**
 * The coarse subset of per-session run events the control plane forwards, and the control-event
 * type each maps to. Everything else (transcript bodies: text/thinking deltas, assistant,
 * tool_use/result, background_output, ...) returns null and is dropped before the (async) owner
 * resolution, keeping the always-on connection cheap.
 */
export function controlTypeFor(t: RunEventType): ControlEventType | null {
  switch (t) {
    case RunEventType.SESSION_CREATED:
      return ControlEventType.SESSION_CREATED;
    case RunEventType.SESSION_ENDED:
      return ControlEventType.SESSION_ENDED;
    case RunEventType.STATUS:
    case RunEventType.TURN_END:
      return ControlEventType.SESSION_UPDATED;
    case RunEventType.ERROR:
      return ControlEventType.SESSION_ERROR;
    case RunEventType.APPROVAL_REQUEST:
      return ControlEventType.APPROVAL_REQUESTED;
    case RunEventType.APPROVAL_RESOLVED:
      return ControlEventType.APPROVAL_RESOLVED;
    case RunEventType.BACKGROUND_TASK:
      return ControlEventType.BACKGROUND_TASK;
    default:
      return null;
  }
}

/** `data` for `session.error`. Decision Q3: errors carry their own event. `recoverable` is only
 *  true when the runner explicitly flags a mid-turn (non-fatal) error; default false. */
export function errorPayloadOf(payload: Record<string, unknown>): ControlSessionError {
  const message = payload.message ?? payload.error ?? payload.text ?? 'run error';
  return { message: String(message), recoverable: payload.recoverable === true };
}

/** `data` for `background.task`. The runner's BACKGROUND_TASK payload names the process via
 *  `command` (see the transcript reducer); fall back to `name`. */
export function backgroundPayloadOf(payload: Record<string, unknown>): ControlBackgroundTask {
  const exit = payload.exitCode ?? payload.exit_code;
  return {
    name: String(payload.command ?? payload.name ?? 'background task'),
    status: String(payload.status ?? 'unknown'),
    ...(typeof exit === 'number' ? { exitCode: exit } : {}),
  };
}

/** The decided approval's id, from an APPROVAL_REQUEST/RESOLVED payload (`payload.id`). */
export function approvalIdOf(payload: Record<string, unknown>): string {
  return String(payload.id ?? payload.approvalId ?? '');
}
