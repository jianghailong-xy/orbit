"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_RUNNER_OFFLINE_AFTER_MS = void 0;
exports.deriveSessionCapabilities = deriveSessionCapabilities;
exports.withSessionState = withSessionState;
exports.withSessionCapabilities = withSessionCapabilities;
const runtime_provider_1 = require("../common/runtime-provider");
const shared_1 = require("@orbit/shared");
/** Runners heartbeat every 30s; three missed heartbeats makes resume unavailable. */
exports.SESSION_RUNNER_OFFLINE_AFTER_MS = 90_000;
const TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
/**
 * Single source of truth for both resume authorization and action affordances sent to
 * clients. Keep this pure so list/detail/realtime and the mutation guard cannot drift.
 */
function deriveSessionCapabilities(session, nowMs = Date.now()) {
    const lifecycleState = (0, shared_1.deriveSessionLifecycleState)(session);
    const terminal = TERMINAL_RUN_STATUSES.has(String(session.status).toUpperCase());
    let resumeBlockedReason = null;
    if (lifecycleState === shared_1.SessionLifecycleState.TRASH) {
        resumeBlockedReason = 'TRASHED';
    }
    else if (!terminal && session.cancelRequestedAt != null) {
        resumeBlockedReason = 'ENDING';
    }
    else if (!terminal) {
        resumeBlockedReason = 'NOT_TERMINAL';
    }
    else if (session.startedAt == null) {
        resumeBlockedReason = 'NOT_STARTED';
    }
    else if (session.numTurns > 0 && !session.runtimeSessionId) {
        resumeBlockedReason = 'MISSING_CONTEXT';
    }
    else if (!(session.assignedRunnerId ?? session.assignedRunner?.id)) {
        resumeBlockedReason = 'NO_RUNNER';
    }
    else {
        const heartbeat = session.assignedRunner?.lastHeartbeatAt;
        const heartbeatMs = heartbeat instanceof Date ? heartbeat.getTime() : heartbeat ? Date.parse(heartbeat) : NaN;
        const runnerOnline = session.assignedRunner != null &&
            session.assignedRunner.status !== 'OFFLINE' &&
            Number.isFinite(heartbeatMs) &&
            heartbeatMs >= nowMs - exports.SESSION_RUNNER_OFFLINE_AFTER_MS;
        if (!runnerOnline)
            resumeBlockedReason = 'RUNNER_OFFLINE';
    }
    const canResume = resumeBlockedReason == null;
    const ending = !terminal && session.cancelRequestedAt != null;
    const trashed = lifecycleState === shared_1.SessionLifecycleState.TRASH;
    const canComplete = lifecycleState === shared_1.SessionLifecycleState.OPEN;
    return {
        canSend: !trashed && !ending && (!terminal || canResume),
        canResume,
        resumeBlockedReason,
        canComplete,
        // Old clients still read this during the compatibility window.
        canArchive: canComplete,
        canRestore: lifecycleState !== shared_1.SessionLifecycleState.OPEN,
    };
}
/**
 * Preserve legacy fields while adding orthogonal execution + lifecycle state. Kept
 * server-side so every Session payload is augmented consistently without changing the
 * persisted Prisma model.
 */
function withSessionState(session) {
    const completedAt = session.completedAt ?? session.archivedAt ?? null;
    return {
        ...session,
        completedAt,
        // Compatibility fields are projections of canonical state, never a second source of truth.
        archivedAt: completedAt,
        runStatus: session.status,
        sessionState: (0, shared_1.deriveSessionState)(session),
        runState: (0, shared_1.deriveSessionRunState)(session),
        lifecycleState: (0, shared_1.deriveSessionLifecycleState)(session),
        filingState: (0, shared_1.deriveSessionFilingState)(session),
    };
}
/** Add lifecycle state and server-derived capabilities to a complete session row. */
function withSessionCapabilities(session, nowMs = Date.now()) {
    const semantics = derivePermissionSemanticsForSession(session);
    return {
        ...withSessionState(session),
        capabilities: deriveSessionCapabilities(session, nowMs),
        ...(semantics ? { permissionSemantics: semantics } : {}),
    };
}
/**
 * What the session's permission mode actually means on the runtime that runs it.
 *
 * Only derived for built-in providers: a custom (BYOK) slug borrows a runtime that this row alone
 * does not name, and claiming "you will be asked" for a session that might be running on Codex is
 * exactly the false assurance this field exists to remove. Omitted rather than guessed.
 */
function derivePermissionSemanticsForSession(session) {
    if (session.provider == null || session.providerBuiltin !== true)
        return undefined;
    return (0, shared_1.derivePermissionSemantics)((0, runtime_provider_1.normalizeRuntimeProvider)(session.provider, true), session.permissionMode);
}
//# sourceMappingURL=session-state.js.map