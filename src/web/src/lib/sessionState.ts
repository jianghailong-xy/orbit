/**
 * A session has two independent product dimensions:
 *
 * - runState says what happened to the latest run;
 * - lifecycleState says where the conversation lives in the sidebar.
 *
 * Keep every compatibility inference in this module so UI code never has to guess that a
 * Completed session succeeded (or that a successful session must already be Completed).
 */
export const SESSION_RUN_STATES = [
  'QUEUED',
  'RUNNING',
  'AWAITING_INPUT',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'DORMANT',
  'INTERRUPTED',
  'ENDED',
] as const;

export type SessionRunState = (typeof SESSION_RUN_STATES)[number];

export const SESSION_LIFECYCLE_STATES = ['OPEN', 'COMPLETED', 'TRASH'] as const;
export type SessionLifecycleState = (typeof SESSION_LIFECYCLE_STATES)[number];

/** Legacy mixed lifecycle values retained while older payloads remain in caches/deployments. */
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
  runState?: string | null;
  lifecycleState?: string | null;
  /** Legacy API name retained for rolling upgrades. ARCHIVED normalizes to COMPLETED. */
  filingState?: string | null;
  /** Legacy mixed product lifecycle. */
  sessionState?: string | null;
  runStatus?: string | null;
  /** Legacy name for runStatus, retained by the API during migration. */
  status?: string | null;
  endReason?: string | null;
  completedAt?: unknown;
  /** Legacy API timestamp retained for rolling upgrades. */
  archivedAt?: unknown;
  deletedAt?: unknown;
  error?: string | null;
}

const SESSION_RUN_STATE_SET = new Set<string>(SESSION_RUN_STATES);
const SESSION_LIFECYCLE_STATE_SET = new Set<string>(SESSION_LIFECYCLE_STATES);
const SESSION_STATE_SET = new Set<string>(SESSION_STATES);

const normalizedValue = <T extends string>(value: unknown, allowed: ReadonlySet<string>): T | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.toUpperCase();
  return allowed.has(normalized) ? (normalized as T) : null;
};

export const hasAuthoritativeRunState = (
  session: SessionStateSource,
): session is SessionStateSource & { runState: SessionRunState } =>
  normalizedValue<SessionRunState>(session.runState, SESSION_RUN_STATE_SET) !== null;

export const hasAuthoritativeLifecycleState = (
  session: SessionStateSource,
): boolean => {
  const raw = session.lifecycleState ?? session.filingState;
  return (
    normalizedValue<SessionLifecycleState>(raw, SESSION_LIFECYCLE_STATE_SET) !== null ||
    (typeof raw === 'string' && raw.toUpperCase() === 'ARCHIVED')
  );
};

/** Kept for compatibility with callers/tests during the API migration. */
export const hasAuthoritativeSessionState = (
  session: SessionStateSource,
): session is SessionStateSource & { sessionState: SessionStateValue } =>
  normalizedValue<SessionStateValue>(session.sessionState, SESSION_STATE_SET) !== null;

/** The raw runner state. New payloads call it runStatus; old servers only expose status. */
export const sessionRunStatusOf = (session: SessionStateSource): string =>
  (session.runStatus ?? session.status ?? '').toUpperCase();

const legacySessionRunState = (session: SessionStateSource): SessionRunState | null => {
  const state = normalizedValue<SessionStateValue>(session.sessionState, SESSION_STATE_SET);
  if (!state || state === 'DELETED') return null;
  return state === 'COMPLETED' ? 'SUCCEEDED' : state;
};

/**
 * Resolve the run outcome without consulting lifecycle timestamps. `runState` is authoritative;
 * raw runner fields come next, and the old mixed `sessionState` is used only when no raw status
 * exists. That ordering prevents a stale legacy COMPLETED value from overriding CANCELLED.
 */
export function sessionRunStateOf(session: SessionStateSource): SessionRunState {
  const explicit = normalizedValue<SessionRunState>(session.runState, SESSION_RUN_STATE_SET);
  if (explicit) return explicit;

  const runStatus = sessionRunStatusOf(session);
  if (!runStatus) return legacySessionRunState(session) ?? 'ENDED';
  const reason = (session.endReason ?? '').toLowerCase();
  switch (runStatus) {
    case 'PENDING':
    case 'QUEUED':
      return 'QUEUED';
    case 'RUNNING':
      return 'RUNNING';
    case 'AWAITING_INPUT':
      return 'AWAITING_INPUT';
    case 'SUCCEEDED':
    case 'COMPLETED':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    case 'INTERRUPTED':
    case 'CANCELLED':
      if (reason === 'orphaned') return 'ENDED';
      if (
        reason === 'completed' ||
        reason === 'deleted' ||
        reason === 'cancelled' ||
        reason === 'task_cancelled'
      )
        return 'CANCELLED';
      if (runStatus === 'INTERRUPTED' && reason === '') return 'INTERRUPTED';
      return 'DORMANT';
    default:
      // Unknown future/legacy raw values must not accidentally look live or queued.
      return 'ENDED';
  }
}

/**
 * Filing a live session into Completed recycles its runtime, so the run settles CANCELLED with
 * endReason 'completed' — the same raw pair a batch-stop produces. It's a deliberate wrap-up, not
 * a stop, so the UI names and draws it as Completed. Kept out of {@link sessionRunStateOf} on
 * purpose: the run states are a shared wire vocabulary, and this is presentation only.
 */
export const isRunCompletedByUser = (session: SessionStateSource): boolean =>
  sessionRunStateOf(session) === 'CANCELLED' &&
  (session.endReason ?? '').toLowerCase() === 'completed';

export type SessionLifecycleView = 'open' | 'completed' | 'trash';
type LegacySessionListView = 'active' | 'archived' | 'deleted';

/** Resolve the product lifecycle location, independently of how its latest run ended. */
export function sessionLifecycleStateOf(
  session: SessionStateSource,
  options: { listView?: SessionLifecycleView; legacyView?: LegacySessionListView } = {},
): SessionLifecycleState {
  const raw = session.lifecycleState ?? session.filingState;
  const explicit = normalizedValue<SessionLifecycleState>(
    raw,
    SESSION_LIFECYCLE_STATE_SET,
  );
  if (explicit) return explicit;
  // Older API payloads called Completed ARCHIVED. Keep that translation at the boundary so
  // the rest of the Web app has one lifecycle vocabulary.
  if (typeof raw === 'string' && raw.toUpperCase() === 'ARCHIVED') return 'COMPLETED';
  if (session.deletedAt != null) return 'TRASH';
  if (session.completedAt != null || session.archivedAt != null) return 'COMPLETED';
  if (options.listView === 'trash' || options.legacyView === 'deleted') return 'TRASH';
  if (options.listView === 'completed' || options.legacyView === 'archived') return 'COMPLETED';
  return 'OPEN';
}

export const sessionLifecycleLabel = (state: SessionLifecycleState): string =>
  state === 'COMPLETED' ? 'Completed' : state === 'TRASH' ? 'Trash' : 'Open';

/**
 * @deprecated New UI should use sessionRunStateOf and sessionLifecycleStateOf separately.
 * This compatibility helper now reflects only the run dimension.
 */
export function sessionStateOf(session: SessionStateSource): SessionStateValue {
  const state = sessionRunStateOf(session);
  return state === 'SUCCEEDED' ? 'COMPLETED' : state;
}

/** States that can accept another turn without reviving/recreating the session. */
export const isSessionLive = (session: SessionStateSource): boolean =>
  ['QUEUED', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'].includes(sessionRunStateOf(session));

export const isSessionTerminal = (session: SessionStateSource): boolean => !isSessionLive(session);

/** Task execution is busy only while waiting for a runner or actively generating. */
export const isSessionBusy = (session: SessionStateSource): boolean =>
  ['QUEUED', 'RUNNING'].includes(sessionRunStateOf(session));

/** Active-turn capacity follows the raw execution state, not the product run outcome. */
export const sessionHoldsRunnerSlot = (session: SessionStateSource): boolean =>
  sessionRunStatusOf(session) === 'RUNNING';

/** Human-facing copy for an ended session. The run outcome and lifecycle location stay separate. */
export function sessionEndedBanner(
  session: SessionStateSource,
  resumable: boolean,
  runnerOnline: boolean,
  resumeBlockedMessage?: string | null,
): string {
  const state = sessionRunStateOf(session);
  const lifecycle = sessionLifecycleStateOf(session);
  const suffix =
    lifecycle === 'COMPLETED' && resumable
      ? ' Sending a message will resume this session in Open.'
      : resumable
        ? ' Send a message to resume this session.'
        : resumeBlockedMessage
          ? ` ${resumeBlockedMessage}${runnerOnline ? ' Sending a message starts a new session.' : ''}`
          : runnerOnline
            ? ' Sending a message starts a new session.'
            : ' Runner offline — bring it online to resume.';

  let base: string;
  switch (state) {
    case 'SUCCEEDED':
      base = 'Session succeeded.';
      break;
    case 'FAILED':
      base = session.error?.toLowerCase().includes('offline')
        ? 'Session interrupted.'
        : 'Session failed.';
      break;
    case 'CANCELLED':
      base = isRunCompletedByUser(session) ? 'Session completed.' : 'Session cancelled.';
      break;
    case 'INTERRUPTED':
      base = 'Session interrupted.';
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
