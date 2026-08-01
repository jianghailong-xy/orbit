import type { SessionCapabilities, SessionResumeBlockedReason } from '@orbit/shared';
import {
  isSessionLive,
  sessionFilingStateOf,
  type SessionStateSource,
} from './sessionState';

export interface SessionCapabilitySource {
  capabilities?: Partial<SessionCapabilities> | null;
}

export type SessionSendDisposition = 'SEND' | 'RESUME' | 'CREATE' | 'BLOCK';

const RESUME_BLOCKED_REASONS = new Set<SessionResumeBlockedReason>([
  'TRASHED',
  'ENDING',
  'NOT_TERMINAL',
  'NOT_STARTED',
  'MISSING_CONTEXT',
  'NO_RUNNER',
  'RUNNER_OFFLINE',
]);

/** Prefer a server capability when present; otherwise retain the old client's local decision. */
export function sessionCapabilityOf(
  session: SessionCapabilitySource,
  capability: 'canSend' | 'canResume' | 'canArchive' | 'canRestore',
  fallback: boolean,
): boolean {
  const value = session.capabilities?.[capability];
  return typeof value === 'boolean' ? value : fallback;
}

export function sessionResumeBlockedReasonOf(
  session: SessionCapabilitySource,
): SessionResumeBlockedReason | null {
  const reason = session.capabilities?.resumeBlockedReason;
  return typeof reason === 'string' &&
    RESUME_BLOCKED_REASONS.has(reason as SessionResumeBlockedReason)
    ? (reason as SessionResumeBlockedReason)
    : null;
}

/** Choose the endpoint from a freshly fetched session snapshot. */
export function sessionSendDispositionOf(
  session: SessionCapabilitySource & SessionStateSource,
  legacyCanResume: boolean,
): SessionSendDisposition {
  if (sessionFilingStateOf(session) === 'TRASH') return 'BLOCK';
  if (isSessionLive(session))
    return sessionCapabilityOf(session, 'canSend', true) ? 'SEND' : 'BLOCK';
  if (!sessionCapabilityOf(session, 'canResume', legacyCanResume)) return 'CREATE';
  // canSend is the umbrella authorization. An explicit false must win even when a partial
  // rollout or future gate leaves canResume true; old payloads omit it and retain Resume.
  return session.capabilities?.canSend === false ? 'BLOCK' : 'RESUME';
}

/** Copy for a CREATE fallback whose uploaded attachments are still owned by the old session. */
export function scopedAttachmentCreateBlockedMessage(count: number): string {
  const noun = count === 1 ? 'attachment belongs' : 'attachments belong';
  return `This session can no longer be resumed, and the ${noun} to it. Open New session and re-add ${count === 1 ? 'the attachment' : 'the attachments'} before sending.`;
}

/** Detailed explanation for why the existing runner context cannot be resumed. */
export function sessionResumeBlockedMessage(
  reason: SessionResumeBlockedReason | null,
): string | null {
  switch (reason) {
    case 'TRASHED':
      return 'Restore this session to Open before resuming.';
    case 'ENDING':
      return 'This session is ending. Try again when it finishes.';
    case 'NOT_TERMINAL':
      return 'This session is still active and does not need to be resumed.';
    case 'NOT_STARTED':
      return 'This session never started, so there is no context to resume.';
    case 'MISSING_CONTEXT':
      return 'The previous session context is no longer available.';
    case 'NO_RUNNER':
      return 'No runner is assigned to this session.';
    case 'RUNNER_OFFLINE':
      return 'The assigned runner is offline.';
    default:
      return null;
  }
}

/** Send-specific copy when the authoritative umbrella capability temporarily says no. */
export function sessionSendBlockedMessage(
  reason: SessionResumeBlockedReason | null,
): string {
  switch (reason) {
    case 'TRASHED':
      return 'Restore this session to Open before sending a message.';
    case 'ENDING':
      return 'This session is ending and cannot accept messages right now.';
    case 'NO_RUNNER':
      return 'This session has no assigned runner and cannot accept messages.';
    case 'RUNNER_OFFLINE':
      return 'The assigned runner is offline, so this session cannot accept messages.';
    default:
      return 'This session cannot accept messages right now.';
  }
}
