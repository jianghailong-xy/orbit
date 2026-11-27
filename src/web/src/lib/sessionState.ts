import {
  SESSION_PHASES,
  SESSION_TURN_OUTCOMES,
  SESSION_WAITING_ON,
  type SessionActivity,
  type SessionPhase,
  type SessionTurnOutcome,
  type SessionWaitingOn,
} from '@orbit/shared';
import { sessionDisplayState } from './sessionDisplay';

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
  'INTERRUPTED',
  'SUCCEEDED',
  'FAILED',
  // The one neutral terminal state. See SessionRunState in shared/src/enums.ts for why
  // the old CANCELLED/DORMANT/ENDED trio collapsed into it.
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
  /** When the server will re-send the message this run's failure killed. See sessionRetryPending. */
  retryAt?: string | null;
  /** When the engine first spoke for the current run. See sessionIsStarting. */
  engineStartedAt?: string | null;
  /** What that engine is doing while engineStartedAt is still null. See startingTitle. */
  enginePhase?: string | null;
  /** The run's SOURCE (project-source-contract §6.1). See sessionSourceRefused. */
  sourceState?: string | null;
  sourceRefusalCode?: string | null;
  /** What the session is doing beyond its status (SessionActivity, decided by the server). See
   *  sessionActivityOf. Absent from an older control plane. */
  activity?: string | null;
  /** The three-state field and the facts beside it (contracts/session-state.contract.json), decided by the
   *  server. Absent from an older control plane; see sessionPhaseOf, sessionReleasedOf. */
  phase?: string | null;
  released?: boolean | null;
  /** `LANDING` for a landing container, whose release with no end reason finished its work. */
  sessionKind?: string | null;
  lastTurnOutcome?: string | null;
  waitingOn?: string | null;
  /** The server's answer to "did this release finish the work" (releaseFinishedTheWork); absent from an older control plane. */
  workFinished?: boolean | null;
}

const SESSION_PHASE_SET: ReadonlySet<string> = new Set(SESSION_PHASES);
const SESSION_WAITING_ON_SET: ReadonlySet<string> = new Set(SESSION_WAITING_ON);
const SESSION_TURN_OUTCOME_SET: ReadonlySet<string> = new Set(SESSION_TURN_OUTCOMES);
const knownValue = <T extends string>(value: unknown, allowed: ReadonlySet<string>): T | null =>
  typeof value === 'string' && allowed.has(value) ? (value as T) : null;

/** What the session is doing (`phase`: PENDING, RUNNING, IDLE), or null from an older control plane. A value
 *  this client does not know reads as absent (the contract's lists can grow). RUNNING covers work outside a
 *  turn: a background job, a sub-agent, the engine's own turn. */
export const sessionPhaseOf = (session: SessionStateSource): SessionPhase | null =>
  knownValue<SessionPhase>(session.phase, SESSION_PHASE_SET);

/** Who or what the session waits on (`waitingOn`: PERSON, HOLD, WAKE), or null: nothing, or an older
 *  control plane (tell the two apart with sessionPhaseOf). */
export const sessionWaitingOnOf = (session: SessionStateSource): SessionWaitingOn | null =>
  knownValue<SessionWaitingOn>(session.waitingOn, SESSION_WAITING_ON_SET);

/**
 * Whether phase PENDING is an armed retry waiting to re-send the session rather than a queued turn (the owner,
 * 2026-11-26: waiting for retry is PENDING, held or released). The server says so with `waitingOn` WAKE, which a
 * queued turn never carries; behind an answer owed (PERSON) it is the armed `retryAt` on a run that is not queued.
 */
export const sessionWaitsOnRetry = (session: SessionStateSource): boolean => {
  if (sessionPhaseOf(session) !== 'PENDING') return false;
  const waitingOn = sessionWaitingOnOf(session);
  if (waitingOn === 'WAKE') return true;
  if (waitingOn !== 'PERSON' || !session.retryAt) return false;
  const runStatus = sessionRunStatusOf(session);
  return runStatus !== 'PENDING' && runStatus !== 'QUEUED';
};

/** How the last turn ended (`lastTurnOutcome`), or null before any turn recorded one or from an older server. */
export const sessionLastTurnOutcomeOf = (session: SessionStateSource): SessionTurnOutcome | null =>
  knownValue<SessionTurnOutcome>(session.lastTurnOutcome, SESSION_TURN_OUTCOME_SET);

/**
 * Whether no runner holds the session, so the next message has to revive it (`released`, decided by the
 * server from the release column). A control plane too old to send it is read off the legacy fields exactly
 * as before: a run state that is not live. The server's field always wins when present; it is never rebuilt
 * from `status`.
 */
export const sessionReleasedOf = (session: SessionStateSource): boolean =>
  typeof session.released === 'boolean' ? session.released : !legacySessionLive(session);

/**
 * Whether this run's SOURCE was refused — the run never became one.
 *
 * Terminal (SR34): the pin is closed to a second resolution and the recovery is a NEW run, so
 * nothing about this one will ever move. A session can carry this while its row still says RUNNING
 * — the run's own status is settled by the control plane a moment later, and rows predating that
 * fix are still out there — and every surface that would otherwise say "Starting" (the engine is
 * coming up) or "Running" (it is working) about such a session is saying something untrue, about a
 * wait nobody is in. So this is read wherever a session's STATE is worded or drawn, and such a run
 * wears the words a failed one wears.
 *
 * Both spellings count: the refusal is frozen as `sourceState` REFUSED with the code beside it, and
 * a payload from between the two (or a projection that carries only one of the columns) names the
 * same fact.
 */
export const sessionSourceRefused = (session: {
  sourceState?: string | null;
  sourceRefusalCode?: string | null;
}): boolean =>
  (session.sourceState ?? '').toUpperCase() === 'REFUSED' || (session.sourceRefusalCode ?? '') !== '';

/** The state a row, a header or a glyph should READ for this session (see sessionSourceRefused). */
export const sessionReadingState = (session: SessionStateSource): SessionRunState =>
  sessionSourceRefused(session) ? 'FAILED' : sessionRunStateOf(session);

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
  if (state === 'COMPLETED') return 'SUCCEEDED';
  // The legacy vocabulary still splits the neutral terminals; the run states no longer do.
  if (state === 'CANCELLED' || state === 'DORMANT') return 'ENDED';
  return state;
};

/**
 * Resolve the run outcome without consulting lifecycle timestamps. `runState` is authoritative;
 * raw runner fields come next, and the old mixed `sessionState` is used only when no raw status
 * exists. That ordering prevents a stale legacy COMPLETED value from overriding CANCELLED.
 */
export function sessionRunStateOf(session: SessionStateSource): SessionRunState {
  const fromFields = runStateFromPhaseFields(session);
  if (fromFields) return fromFields;
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
      // A bare INTERRUPTED means a turn was stopped, not the session; it stays live.
      if (runStatus === 'INTERRUPTED' && reason === '') return 'INTERRUPTED';
      // Every deliberate end settles here regardless of endReason: nothing the user can
      // do next depends on which one it was. The reason itself is prose, not a state —
      // sessionEndedBanner is where it gets spelled out.
      return 'ENDED';
    default:
      // Unknown future/legacy raw values must not accidentally look live or queued.
      return 'ENDED';
  }
}

/** Whether a released session finished its work: its task ended DONE, or it is a landing that settled
 *  (the server's releaseFinishedTheWork). The only release worded "Finished" (decision D2). */
export const sessionFinishedTheWork = (session: SessionStateSource): boolean =>
  typeof session.workFinished === 'boolean'
    ? session.workFinished
    : session.released === true &&
      ((session.endReason ?? '') === 'task_done' ||
        ((session.sessionKind ?? '') === 'LANDING' && !session.endReason));

/**
 * Whether phase RUNNING is a dispatched turn rather than work outside one. The server's `activity` cannot tell
 * them apart: it answers TURN for every stored PENDING or RUNNING row and also for a parked session whose engine
 * runs its own turn or a sub-agent. The legacy run status can: a dispatched turn is stored RUNNING, work outside a
 * turn is stored AWAITING_INPUT (or INTERRUPTED) with an activity. This is the ONE legacy read left in this
 * function, kept until the server sends a turn-in-flight fact. With no run status at all (or one this client does
 * not know), no activity or TURN is a dispatched turn and any other activity is work outside one.
 */
function dispatchedTurnInFlight(session: SessionStateSource): boolean {
  const runStatus = sessionRunStatusOf(session);
  if (runStatus === 'RUNNING' || runStatus === 'PENDING' || runStatus === 'QUEUED') return true;
  if (runStatus === 'AWAITING_INPUT') return false;
  // A status word this client does not know: the server sends activity TURN for every dispatched turn, so no
  // activity or TURN is a turn in flight; any other activity is work outside one (Apple and Android read it so).
  return !session.activity || session.activity === 'TURN';
}

/**
 * The run state a payload with the new fields reads as (contracts/session-state.contract.json), or null from an
 * older control plane, which keeps the legacy reading below. A release is a failure only when the last turn failed
 * and nobody asked for an end (decision D9); it finished the work only by sessionFinishedTheWork; any other release
 * ended. A held session is queued, running, or parked: RUNNING with `activity` set is work outside a turn (a job, a
 * sub-agent, the engine's own turn), which the parked branches of every surface already draw.
 */
function runStateFromPhaseFields(session: SessionStateSource): SessionRunState | null {
  const phase = sessionPhaseOf(session);
  if (!phase || typeof session.released !== 'boolean') return null;
  const outcome = sessionLastTurnOutcomeOf(session);
  if (session.released) {
    if (!session.endReason && outcome === 'FAILED') return 'FAILED';
    return sessionFinishedTheWork(session) ? 'SUCCEEDED' : 'ENDED';
  }
  // A held session waiting on its armed retry has no turn queued: it reads parked, as it did before the retry.
  if (phase === 'PENDING' && !sessionWaitsOnRetry(session)) return 'QUEUED';
  if (phase === 'RUNNING') return dispatchedTurnInFlight(session) ? 'RUNNING' : 'AWAITING_INPUT';
  return outcome === 'INTERRUPTED' ? 'INTERRUPTED' : 'AWAITING_INPUT';
}

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

const SESSION_ACTIVITIES: ReadonlySet<string> = new Set<SessionActivity>(['TURN', 'BACKGROUND_JOB', 'WAITING']);

/**
 * What a parked session is still doing, as the server decided it (`activity`, SessionActivity): a turn
 * the engine started for itself or a sub-agent (TURN), a `bg_run` job it will be woken by
 * (BACKGROUND_JOB), or a watch, scheduled wake-up or auto-retry that will resume it (WAITING). Null when
 * it is not parked, or parked with nothing in flight — the only AWAITING_INPUT that is really waiting
 * on its next message. Read this rather than the run state alone wherever "is it idle?" is the question.
 */
export const sessionActivityOf = (session: SessionStateSource): SessionActivity | null => {
  if (sessionRunStateOf(session) !== 'AWAITING_INPUT') return null;
  const value = (session.activity ?? '').toUpperCase();
  if (SESSION_ACTIVITIES.has(value)) return value as SessionActivity;
  // The server's `waitingOn` says the same of a parked session a watch, wake-up or retry will give a turn.
  return sessionWaitingOnOf(session) === 'WAKE' ? 'WAITING' : null;
};

/** The words for a parked session's activity, shared by every surface that says it. */
export const SESSION_ACTIVITY_WORD: Record<SessionActivity, string> = {
  TURN: 'Running',
  BACKGROUND_JOB: 'Running in background',
  WAITING: 'Waiting to resume',
};

/** How a run stands, in the words a run's badge uses for anyone's run (TaskDetailPanel) rather than
 *  the owner's own header, which asks its reader for a reply. */
const SESSION_RUN_WORD: Record<SessionRunState, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  AWAITING_INPUT: 'Awaiting reply',
  // Decision D2: a session never "succeeds". The one release that finished its work is a task's run that
  // ended DONE, or a settled landing (sessionFinishedTheWork).
  SUCCEEDED: 'Finished',
  FAILED: 'Failed',
  INTERRUPTED: 'Interrupted',
  ENDED: 'Ended',
};

/**
 * A session's state in one word, for a reader who is not its owner (a shared session's header).
 * A filed session says where it is filed, Completed, as the app's own header does; until then it
 * says how its latest run stands.
 */
export function sessionStateWord(session: SessionStateSource, opts: { canReply?: boolean } = {}): string {
  // With the facts, the state word is `phase` alone (lib/sessionDisplay), and a filed session says Completed after
  // it rather than instead of it (the caller draws that and the marks). What follows is an older control plane's.
  const shown = sessionDisplayState(session);
  if (shown) return shown.word;
  if (sessionLifecycleStateOf(session) === 'COMPLETED') return sessionLifecycleLabel('COMPLETED');
  // Parked is not idle: say what it is still doing (sessionActivityOf).
  const activity = sessionActivityOf(session);
  if (activity) return SESSION_ACTIVITY_WORD[activity];
  // Really idle. "Awaiting reply" asks its reader for one, which only someone who can send it can give;
  // a public link's reader cannot (`canReply: false`), so it is told whose move it is.
  const state = sessionRunStateOf(session);
  if (state === 'AWAITING_INPUT' && opts.canReply === false) return 'Waiting for owner';
  return SESSION_RUN_WORD[state];
}

/**
 * @deprecated New UI should use sessionRunStateOf and sessionLifecycleStateOf separately.
 * This compatibility helper now reflects only the run dimension.
 */
export function sessionStateOf(session: SessionStateSource): SessionStateValue {
  const state = sessionRunStateOf(session);
  return state === 'SUCCEEDED' ? 'COMPLETED' : state;
}

/**
 * How long past its due moment an armed retry is still believed. AutoRetryService sweeps every
 * 30s and re-arms each time it defers, so a retry that is actually going to happen is never more
 * than a sweep or two stale — but the sweeper is single-replica, and a session left saying
 * "Retrying" forever because nobody ever came for it would be a worse lie than the one this fixes.
 * Past this the row falls back to the failure it already is, with no watchdog needed to do it.
 */
const RETRY_STALE_MS = 2 * 60_000;

/**
 * Whether this session's failure is one the server intends to undo by itself: a spent quota, a
 * provider that couldn't answer, a runner that vanished mid-turn. All three settle the run FAILED
 * on the spot — the turn IS over, its slot has to go back, and the list must not show it as idly
 * waiting on its user — and all three arm `retryAt` in the same breath, which is what makes that
 * FAILED a prediction rather than an outcome. So the row is drawn as Retrying until the wait ends:
 * the retry runs, or AutoRetryService gives up and clears `retryAt` (see its `disarm`).
 *
 * Deliberately FAILED-only. The quota case can also park at AWAITING_INPUT, where nothing claims
 * the session is over and a reset hours out would read absurdly as "Retrying"; there the armed
 * retry is detail for the card, not a correction to the state.
 */
export const sessionRetryPending = (session: SessionStateSource, now = Date.now()): boolean => {
  if (sessionRunStateOf(session) !== 'FAILED') return false;
  if (!session.retryAt) return false;
  const at = Date.parse(session.retryAt);
  // A retry that is due right now (what the reaper arms for a vanished runner) is pending too:
  // the sweep that fires it is seconds away, and the card says "re-sending your message".
  return Number.isFinite(at) && at > now - RETRY_STALE_MS;
};

/**
 * Whether this session holds a slot but its runtime is not up yet.
 *
 * RUNNING is acquired by the claim that wins the row; the runtime that serves it is created
 * afterwards — a git worktree checkout, a CLI cold start, an MCP handshake. That gap is seconds,
 * and drawing it as Running claims the agent is working on a prompt it has not read. It is not
 * queueing either: nothing is contended, nothing the user can do shortens it, and the slot is
 * already spent — so it is its own state, and only the engine's own first event ends it.
 *
 * Strictly `null`, never `undefined`: a control plane too old to send the field says nothing
 * about the runtime, and guessing "starting" there would park every running session under a
 * startup label forever. Absent means "keep the two-state behaviour".
 */
export const sessionIsStarting = (session: SessionStateSource): boolean =>
  sessionRunStateOf(session) === 'RUNNING' && session.engineStartedAt === null;

/** The legacy reading of "held": the run states that accept another turn without a revive. Only for a
 *  payload without `released` (sessionReleasedOf). */
function legacySessionLive(session: SessionStateSource): boolean {
  return ['QUEUED', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'].includes(sessionRunStateOf(session));
}

/** Whether the session can accept another turn without reviving or recreating it: a runner still holds it.
 *  The send-versus-resume choice, the wait after End and the polling stops all read this. */
export const isSessionLive = (session: SessionStateSource): boolean => !sessionReleasedOf(session);

export const isSessionTerminal = (session: SessionStateSource): boolean => sessionReleasedOf(session);

/** Whether something is executing or queued for this session now. With `phase`, anything but IDLE: a turn, the
 *  engine's own turn, a sub-agent or a background job (decision D8), except a retry waiting to re-send it, which
 *  can be hours out on a spent quota. From an older control plane: a dispatched turn, or one the engine started for
 *  itself while parked (activity TURN). */
export const isSessionWorking = (session: SessionStateSource): boolean => {
  const phase = sessionPhaseOf(session);
  if (phase) return phase !== 'IDLE' && !sessionWaitsOnRetry(session);
  return isSessionBusy(session) || sessionActivityOf(session) === 'TURN';
};

/** Whether a turn is queued and nothing executes yet (`phase` PENDING, not a retry's); from an older control plane,
 *  the raw status PENDING. */
export const isSessionQueued = (session: SessionStateSource): boolean => {
  const phase = sessionPhaseOf(session);
  return phase ? phase === 'PENDING' && !sessionWaitsOnRetry(session) : sessionRunStatusOf(session) === 'PENDING';
};

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
      base =
        (session.endReason ?? '').toLowerCase() === 'task_done'
          ? 'The linked task is done, so the session finished.'
          : 'Session finished.';
      break;
    case 'FAILED':
      // Not "Session failed" while the server is going to re-send it: the card above this line
      // is counting down to exactly that, and two lines contradicting each other is how the
      // reader learns to trust neither. What survives is the half that is still true and still
      // useful — they can jump in now instead of waiting for the retry.
      base = sessionRetryPending(session)
        ? 'Retrying automatically.'
        : session.error?.toLowerCase().includes('offline')
          ? 'Session interrupted.'
          : 'Session failed.';
      break;
    case 'INTERRUPTED':
      base = 'Session interrupted.';
      break;
    // One neutral terminal state, so this is the only place the end reason is still
    // spelled out. Prose can afford the distinction a glyph cannot.
    case 'ENDED':
      switch ((session.endReason ?? '').toLowerCase()) {
        case 'completed':
          base = 'Session completed.';
          break;
        case 'cancelled':
        case 'task_cancelled':
          base = 'Session cancelled.';
          break;
        case 'task_done':
        case 'orphaned':
          base = 'The linked task is done, so the session ended.';
          break;
        case 'idle':
          base = 'Session ended automatically after a long idle period.';
          break;
        default:
          base = 'Session ended.';
      }
      break;
    default:
      base = 'Session ended.';
  }
  return base + suffix;
}
