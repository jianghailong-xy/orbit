import { normalizeRuntimeProvider } from '../common/runtime-provider';
import {
  derivePermissionSemantics,
  type PermissionSemantics,
  type SessionCapabilities,
  SessionFilingState,
  SessionLifecycleState,
  type SessionResumeBlockedReason,
  SessionRunState,
  RunStatus,
  SessionState,
  deriveSessionFilingState,
  deriveSessionLifecycleState,
  deriveSessionRunState,
  deriveSessionState,
} from '@orbit/shared';
import { runnerIsOnline, type RunnerBeats } from '../runners/runner-presence';
import { isReleased } from '../common/session-release';
import { legacySessionStatus, type LandingSettlement, type LegacyStatusFacts } from './session-legacy-words';

/** A session row's filing facts and why it was ended. */
export interface SessionFilingFields {
  endReason?: string | null;
  completedAt?: Date | string | null;
  /** @deprecated Rolling-version compatibility mirror of completedAt. */
  archivedAt?: Date | string | null;
  deletedAt?: Date | string | null;
}

/** The raw fields required to augment a Prisma/API session row: the facts the legacy words are derived from
 *  (session-legacy-words.ts) and the filing facts. */
export interface RawSessionStateFields extends LegacyStatusFacts, Omit<SessionFilingFields, 'endReason'> {}

/** Complete server-side input needed to derive action capabilities.
 *  The provider/permission trio is optional so callers that only carry lifecycle state (and the
 *  specs built around them) keep compiling; permission semantics are simply omitted then. */
export interface SessionCapabilityFields extends SessionFilingFields {
  status?: string;
  provider?: string | null;
  providerBuiltin?: boolean | null;
  permissionMode?: string | null;
  /** Its runner reported Codex's sandbox cannot start there, so Codex Auto runs with it off. */
  codexSandboxUnavailable?: boolean | null;
  finishedAt: Date | string | null;
  cancelRequestedAt: Date | string | null;
  startedAt: Date | string | null;
  numTurns: number;
  runtimeSessionId: string | null;
  assignedRunnerId?: string | null;
  /** Its liveness as runners/runner-presence.ts reads it: a row read with RUNNER_BEATS, or a list
   *  row whose `lastHeartbeatAt` already carries the reading. */
  assignedRunner:
    | ({
        id?: string;
        status: string;
      } & RunnerBeats)
    | null;
}

/**
 * Single source of truth for both resume authorization and action affordances sent to
 * clients. Keep this pure so list/detail/realtime and the mutation guard cannot drift.
 */
export function deriveSessionCapabilities(
  session: SessionCapabilityFields,
  nowMs: number = Date.now(),
): SessionCapabilities {
  const lifecycleState = deriveSessionLifecycleState(session);
  const terminal = isReleased(session);
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
  } else if (!runnerIsOnline(session.assignedRunner, nowMs)) {
    resumeBlockedReason = 'RUNNER_OFFLINE';
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

/** The word as a payload carries it: assignable to the column's Prisma type and the protocol's. */
export type LegacyStatusWord = `${RunStatus}`;

/**
 * Preserve legacy fields while adding orthogonal execution + lifecycle state. Kept
 * server-side so every Session payload is augmented consistently. `status` and `runStatus` are
 * the words derived from the session's facts (session-legacy-words.ts), not a stored word; the
 * stored `turnState` and `phase` never ride along (a payload's `phase` is the one
 * session-phase.ts reads, merged in by the caller). `landing` is a LANDING container's row.
 */
export function withSessionState<T extends RawSessionStateFields>(
  session: T,
  landing?: LandingSettlement | null,
): Omit<T, 'status' | 'turnState' | 'phase'> & {
  status: LegacyStatusWord;
  runStatus: LegacyStatusWord;
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
  const { turnState: _turnState, phase: _phase, ...wire } = session as T & { phase?: unknown };
  const status = legacySessionStatus(session, landing) as LegacyStatusWord;
  const worded = { ...session, status, runStatus: status };
  return {
    ...(wire as unknown as Omit<T, 'status' | 'turnState' | 'phase'>),
    completedAt,
    // Compatibility fields are projections of canonical state, never a second source of truth.
    archivedAt: completedAt,
    status,
    runStatus: status,
    sessionState: deriveSessionState(worded),
    runState: deriveSessionRunState(worded),
    lifecycleState: deriveSessionLifecycleState(session),
    filingState: deriveSessionFilingState(session),
  };
}

/** Add lifecycle state and server-derived capabilities to a complete session row. */
export function withSessionCapabilities<T extends SessionCapabilityFields & RawSessionStateFields>(
  session: T,
  nowMs: number = Date.now(),
  landing?: LandingSettlement | null,
): ReturnType<typeof withSessionState<T>> & {
  capabilities: SessionCapabilities;
  permissionSemantics?: PermissionSemantics;
} {
  const semantics = derivePermissionSemanticsForSession(session);
  return {
    ...withSessionState(session, landing),
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
    undefined,
    undefined,
    undefined,
    session.codexSandboxUnavailable,
  );
}
