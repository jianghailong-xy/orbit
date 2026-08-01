/**
 * User-facing session lifecycle returned by the control plane. `runStatus` remains the
 * runner's execution state; this value is what labels, glyphs and navigation behaviour use.
 */
export const SESSION_STATES = [
  'QUEUED',
  'RUNNING',
  'AWAITING_INPUT',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'DORMANT',
  'INTERRUPTED',
  'ENDED',
  'DELETED',
] as const;

export type SessionStateValue = (typeof SESSION_STATES)[number];

export interface SessionStateSource {
  sessionState?: string | null;
  runStatus?: string | null;
  /** Legacy name for runStatus, retained by the API during migration. */
  status?: string | null;
  endReason?: string | null;
  archivedAt?: unknown;
  deletedAt?: unknown;
  error?: string | null;
}

const SESSION_STATE_SET = new Set<string>(SESSION_STATES);
export const hasAuthoritativeSessionState = (
  session: SessionStateSource,
): session is SessionStateSource & { sessionState: SessionStateValue } =>
  typeof session.sessionState === 'string' && SESSION_STATE_SET.has(session.sessionState);

/** The raw runner state. New payloads call it runStatus; old servers only expose status. */
export const sessionRunStatusOf = (session: SessionStateSource): string =>
  (session.runStatus ?? session.status ?? '').toUpperCase();

/**
 * Resolve the user-facing state. New `sessionState` is authoritative even when legacy fields
 * disagree. The rest of the function is deliberately the only place the web app reconstructs
 * state from `status`/`endReason`/filing timestamps for compatibility with older servers.
 *
 * `legacyCompleted` is only needed for old archived-list rows, which historically omitted
 * archivedAt. It is ignored as soon as the server supplies sessionState.
 */
export function sessionStateOf(
  session: SessionStateSource,
  options: { legacyCompleted?: boolean } = {},
): SessionStateValue {
  if (hasAuthoritativeSessionState(session)) return session.sessionState;

  const runStatus = sessionRunStatusOf(session);
  const reason = (session.endReason ?? '').toLowerCase();
  if (session.deletedAt != null) return 'DELETED';
  if ((session.archivedAt != null || options.legacyCompleted) && runStatus !== 'FAILED')
    return 'COMPLETED';

  switch (runStatus) {
    case 'RUNNING':
      return 'RUNNING';
    case 'AWAITING_INPUT':
      return 'AWAITING_INPUT';
    case 'SUCCEEDED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'INTERRUPTED':
    case 'CANCELLED':
      if (reason === 'orphaned') return 'ENDED';
      if (reason === 'completed' || reason === 'deleted' || reason === 'cancelled')
        return 'CANCELLED';
      if (runStatus === 'INTERRUPTED' && reason === '') return 'INTERRUPTED';
      return 'DORMANT';
    case 'PENDING':
      return 'QUEUED';
    default:
      // Unknown future/legacy raw values must not accidentally look live or queued.
      return 'ENDED';
  }
}

/** States that can accept another turn without reviving/recreating the session. */
export const isSessionLive = (session: SessionStateSource): boolean =>
  ['QUEUED', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'].includes(sessionStateOf(session));

export const isSessionTerminal = (session: SessionStateSource): boolean => !isSessionLive(session);

/** Task execution is busy only while waiting for a runner or actively generating. */
export const isSessionBusy = (session: SessionStateSource): boolean =>
  ['QUEUED', 'RUNNING'].includes(sessionStateOf(session));

/** Active-turn capacity follows the raw execution state, not the user-facing filing state. */
export const sessionHoldsRunnerSlot = (session: SessionStateSource): boolean =>
  sessionRunStatusOf(session) === 'RUNNING';

/** Human-facing copy for an ended session. State selects the outcome; reason only enriches dormancy. */
export function sessionEndedBanner(
  session: SessionStateSource,
  resumable: boolean,
  runnerOnline: boolean,
): string {
  const state = sessionStateOf(session);
  const suffix = resumable
    ? ' Send a message to resume this session.'
    : runnerOnline
      ? ' Sending a message starts a new session.'
      : ' Runner offline — bring it online to resume.';

  let base: string;
  switch (state) {
    case 'COMPLETED':
      base = 'Session completed.';
      break;
    case 'FAILED':
      base = session.error?.toLowerCase().includes('offline')
        ? 'Session interrupted.'
        : 'Session failed.';
      break;
    case 'CANCELLED':
      base = 'Session cancelled.';
      break;
    case 'INTERRUPTED':
      base = 'Session interrupted.';
      break;
    case 'DELETED':
      base = 'Session deleted.';
      break;
    case 'ENDED':
      base =
        session.endReason === 'orphaned'
          ? 'Session ended (the linked task is done).'
          : 'Session ended.';
      break;
    case 'DORMANT':
      base =
        session.endReason === 'idle'
          ? 'Session ended automatically after a long idle period.'
          : session.endReason === 'task_done'
            ? 'The linked task is done, so the session ended automatically.'
            : 'Session ended.';
      break;
    default:
      base = 'Session ended.';
  }
  return base + suffix;
}
