import { normalizeRuntimeProvider } from '../common/runtime-provider';
import {
  derivePermissionSemantics,
  type PermissionSemantics,
  type SessionCapabilities,
  SessionFilingState,
  SessionLifecycleState,
  type SessionResumeBlockedReason,
  SessionRunState,
  SessionState,
  deriveSessionFilingState,
  deriveSessionLifecycleState,
  deriveSessionRunState,
  deriveSessionState,
} from '@orbit/shared';

/** Runners heartbeat every 30s; three missed heartbeats makes resume unavailable. */
export const SESSION_RUNNER_OFFLINE_AFTER_MS = 90_000;

/** The raw fields required to augment a Prisma/API session row. */
export interface RawSessionStateFields {
  status: string;
  endReason?: string | null;
  completedAt?: Date | string | null;
  /** @deprecated Rolling-version compatibility mirror of completedAt. */
  archivedAt?: Date | string | null;
  deletedAt?: Date | string | null;
}

/** Complete server-side input needed to derive action capabilities.
 *  The provider/permission trio is optional so callers that only carry lifecycle state (and the
 *  specs built around them) keep compiling; permission semantics are simply omitted then. */
export interface SessionCapabilityFields extends RawSessionStateFields {
  provider?: string | null;
  providerBuiltin?: boolean | null;
  permissionMode?: string | null;
  cancelRequestedAt: Date | string | null;
  startedAt: Date | string | null;
  numTurns: number;
  runtimeSessionId: string | null;
  assignedRunnerId?: string | null;
  assignedRunner:
    | {
        id?: string;
        status: string;
        lastHeartbeatAt: Date | string | null;
      }
    | null;
}

const TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/**
 * Single source of truth for both resume authorization and action affordances sent to
 * clients. Keep this pure so list/detail/realtime and the mutation guard cannot drift.
 */
export function deriveSessionCapabilities(
  session: SessionCapabilityFields,
  nowMs: number = Date.now(),
): SessionCapabilities {
  const lifecycleState = deriveSessionLifecycleState(session);
  const terminal = TERMINAL_RUN_STATUSES.has(String(session.status).toUpperCase());
  let resumeBlockedReason: SessionResumeBlockedReason | null = null;

  if (lifecycleState === SessionLifecycleState.TRASH) {
    resumeBlockedReason = 'TRASHED';
  } else if (!terminal && session.cancelRequestedAt != null) {
    resumeBlockedReason = 'ENDING';
  } else if (!terminal) {
    resumeBlockedReason = 'NOT_TERMINAL';
  } else if (session.startedAt == null) {
    resumeBlockedReason = 'NOT_STARTED';
  } else if (session.numTurns > 0 && !session.runtimeSessionId) {
    resumeBlockedReason = 'MISSING_CONTEXT';
  } else if (!(session.assignedRunnerId ?? session.assignedRunner?.id)) {
    resumeBlockedReason = 'NO_RUNNER';
  } else {
    const heartbeat = session.assignedRunner?.lastHeartbeatAt;
    const heartbeatMs =
      heartbeat instanceof Date ? heartbeat.getTime() : heartbeat ? Date.parse(heartbeat) : NaN;
    const runnerOnline =
      session.assignedRunner != null &&
      session.assignedRunner.status !== 'OFFLINE' &&
      Number.isFinite(heartbeatMs) &&
      heartbeatMs >= nowMs - SESSION_RUNNER_OFFLINE_AFTER_MS;
    if (!runnerOnline) resumeBlockedReason = 'RUNNER_OFFLINE';
  }

  const canResume = resumeBlockedReason == null;
  const ending = !terminal && session.cancelRequestedAt != null;
  const trashed = lifecycleState === SessionLifecycleState.TRASH;
  const canComplete = lifecycleState === SessionLifecycleState.OPEN;
  return {
    canSend: !trashed && !ending && (!terminal || canResume),
    canResume,
    resumeBlockedReason,
    canComplete,
    // Old clients still read this during the compatibility window.
    canArchive: canComplete,
    canRestore: lifecycleState !== SessionLifecycleState.OPEN,
  };
}

/**
 * Preserve legacy fields while adding orthogonal execution + lifecycle state. Kept
 * server-side so every Session payload is augmented consistently without changing the
 * persisted Prisma model.
 */
export function withSessionState<T extends RawSessionStateFields>(
  session: T,
): T & {
  runStatus: T['status'];
  sessionState: SessionState;
  runState: SessionRunState;
  lifecycleState: SessionLifecycleState;
  /** @deprecated Compatibility representation of lifecycleState. */
  filingState: SessionFilingState;
  completedAt: Date | string | null;
  /** @deprecated Compatibility alias of completedAt. */
  archivedAt: Date | string | null;
} {
  const completedAt = session.completedAt ?? session.archivedAt ?? null;
  return {
    ...session,
    completedAt,
    // Compatibility fields are projections of canonical state, never a second source of truth.
    archivedAt: completedAt,
    runStatus: session.status,
    sessionState: deriveSessionState(session),
    runState: deriveSessionRunState(session),
    lifecycleState: deriveSessionLifecycleState(session),
    filingState: deriveSessionFilingState(session),
  };
}

/** Add lifecycle state and server-derived capabilities to a complete session row. */
export function withSessionCapabilities<T extends SessionCapabilityFields>(
  session: T,
  nowMs: number = Date.now(),
): ReturnType<typeof withSessionState<T>> & {
  capabilities: SessionCapabilities;
  permissionSemantics?: PermissionSemantics;
} {
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
function derivePermissionSemanticsForSession(
  session: SessionCapabilityFields,
): PermissionSemantics | undefined {
  if (session.provider == null || session.providerBuiltin !== true) return undefined;
  return derivePermissionSemantics(
    normalizeRuntimeProvider(session.provider, true),
    session.permissionMode,
  );
}
