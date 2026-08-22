"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.controlTypeFor = controlTypeFor;
exports.isUserScopedType = isUserScopedType;
exports.errorPayloadOf = errorPayloadOf;
exports.backgroundPayloadOf = backgroundPayloadOf;
exports.approvalIdOf = approvalIdOf;
const shared_1 = require("@orbit/shared");
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
function controlTypeFor(t) {
    switch (t) {
        case shared_1.RunEventType.SESSION_CREATED:
            return shared_1.ControlEventType.SESSION_CREATED;
        case shared_1.RunEventType.SESSION_ENDED:
            return shared_1.ControlEventType.SESSION_ENDED;
        case shared_1.RunEventType.STATUS:
        case shared_1.RunEventType.TURN_END:
            return shared_1.ControlEventType.SESSION_UPDATED;
        case shared_1.RunEventType.ERROR:
            return shared_1.ControlEventType.SESSION_ERROR;
        case shared_1.RunEventType.APPROVAL_REQUEST:
            return shared_1.ControlEventType.APPROVAL_REQUESTED;
        case shared_1.RunEventType.APPROVAL_RESOLVED:
            return shared_1.ControlEventType.APPROVAL_RESOLVED;
        case shared_1.RunEventType.BACKGROUND_TASK:
            return shared_1.ControlEventType.BACKGROUND_TASK;
        case shared_1.RunEventType.TASK_CHANGED:
            return shared_1.ControlEventType.TASK_CHANGED;
        case shared_1.RunEventType.AGENT_CHANGED:
            return shared_1.ControlEventType.AGENT_CHANGED;
        case shared_1.RunEventType.SESSION_UPDATED:
            return shared_1.ControlEventType.SESSION_UPDATED;
        case shared_1.RunEventType.QUEUED_TURNS_CHANGED:
            // A turn was queued or withdrawn. Forwarded as a plain session update because that is what
            // it is to a list: the row's status and preview line both change with it. Nothing else
            // announces a send to the owner's OTHER clients — a queued turn has no transcript event
            // until the runner leases it — so without this a message sent on web reached the phone's
            // list only when the runner got round to its first event, which for a message queued behind
            // a running turn is the far side of that whole turn.
            return shared_1.ControlEventType.SESSION_UPDATED;
        case shared_1.RunEventType.TASK_LIST_CHANGED:
            return shared_1.ControlEventType.TASK_LIST_CHANGED;
        case shared_1.RunEventType.TAG_CHANGED:
            return shared_1.ControlEventType.TAG_CHANGED;
        case shared_1.RunEventType.PROVIDER_CHANGED:
            return shared_1.ControlEventType.PROVIDER_CHANGED;
        default:
            return null;
    }
}
/** The user-scoped library events: they carry no session, so `toControlEvent` routes them by owner
 *  id and ships an empty `sessionId` (see the ControlEvent doc comment). */
function isUserScopedType(t) {
    return (t === shared_1.ControlEventType.TASK_LIST_CHANGED ||
        t === shared_1.ControlEventType.TAG_CHANGED ||
        t === shared_1.ControlEventType.PROVIDER_CHANGED);
}
/** `data` for `session.error`. Decision Q3: errors carry their own event. `recoverable` is only
 *  true when the runner explicitly flags a mid-turn (non-fatal) error; default false. */
function errorPayloadOf(payload) {
    const message = payload.message ?? payload.error ?? payload.text ?? 'run error';
    return { message: String(message), recoverable: payload.recoverable === true };
}
/** `data` for `background.task`. The runner's BACKGROUND_TASK payload names the process via
 *  `command` (see the transcript reducer); fall back to `name`. */
function backgroundPayloadOf(payload) {
    const exit = payload.exitCode ?? payload.exit_code;
    return {
        name: String(payload.command ?? payload.name ?? 'background task'),
        status: String(payload.status ?? 'unknown'),
        ...(typeof exit === 'number' ? { exitCode: exit } : {}),
    };
}
/** The decided approval's id, from an APPROVAL_REQUEST/RESOLVED payload (`payload.id`). */
function approvalIdOf(payload) {
    return String(payload.id ?? payload.approvalId ?? '');
}
//# sourceMappingURL=control-events.js.map