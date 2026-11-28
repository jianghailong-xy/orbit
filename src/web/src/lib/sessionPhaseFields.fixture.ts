import type { SessionStateSource } from './sessionState';

/**
 * Session payloads for plan step 5.2's tests (sessionPhaseFields.test.ts, WorkspaceView.sessionPhaseWording.test.tsx):
 * each is what a current server sends — the legacy fields unchanged beside `phase`, `released`, `lastTurnOutcome` and
 * `waitingOn` (contracts/session-state.contract.json) — and `olderServer` strips the four to give what a control plane
 * that predates them sends.
 */
export type Payload = SessionStateSource & {
  id: string;
  engineTurnActive?: boolean;
  runningSubagentCount?: number;
  queuedReason?: string | null;
  pendingApprovals?: number;
  runningBgCount?: number;
  runningBgJobCount?: number;
  startedAt?: string | null;
  capabilities?: {
    canSend?: boolean;
    canResume?: boolean;
    resumeBlockedReason?: string | null;
  };
};

/**
 * What the server sends as `activity` (sessionActivitySql, apiserver/src/sessions/task-work-carrier.ts): TURN for every
 * row stored PENDING or RUNNING; for a row stored AWAITING_INPUT, the first wake source it has (TURN for the engine's
 * own turn or a sub-agent, BACKGROUND_JOB, WAITING); null for every other status. Mirror of that rule, so a fixture
 * never invents an activity the server would not send.
 */
export const serverActivity = (
  status: string,
  wake: 'TURN' | 'BACKGROUND_JOB' | 'WAITING' | null = null,
): 'TURN' | 'BACKGROUND_JOB' | 'WAITING' | null =>
  status === 'PENDING' || status === 'RUNNING' ? 'TURN' : status === 'AWAITING_INPUT' ? wake : null;

/** Whether `payload` carries the activity the server would send for its stored status (the guard of the fixtures). */
export const carriesServerActivity = (payload: Payload): boolean =>
  (payload.status !== 'RUNNING' && payload.status !== 'PENDING') || payload.activity === 'TURN';

export const held = { canSend: true, canResume: false, resumeBlockedReason: 'NOT_TERMINAL' };
export const resumable = { canSend: true, canResume: true, resumeBlockedReason: null };

/** The eight situations of the task, plus the two where the new fields and the old run state disagree. */
export const SITUATIONS: Record<string, Payload> = {
  'held idle': {
    id: 's', status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
    phase: 'IDLE', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: null, capabilities: held,
  },
  'released by a failed turn': {
    id: 's', status: 'FAILED', runStatus: 'FAILED', runState: 'FAILED', startedAt: '2026-11-22T00:00:00Z',
    phase: 'IDLE', released: true, lastTurnOutcome: 'FAILED', waitingOn: null, capabilities: resumable,
  },
  'released by End': {
    id: 's', status: 'CANCELLED', runStatus: 'CANCELLED', runState: 'ENDED', endReason: 'ended',
    phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null, capabilities: resumable,
  },
  // A move to another workspace let it go (endReason moved): drawn as held idle, resumed on the next message.
  'released by a move': {
    id: 's', status: 'CANCELLED', runStatus: 'CANCELLED', runState: 'ENDED', endReason: 'moved',
    phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null, capabilities: resumable,
  },
  'a task run that finished': {
    id: 's', status: 'SUCCEEDED', runStatus: 'SUCCEEDED', runState: 'SUCCEEDED', endReason: 'task_done',
    phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null, capabilities: resumable,
    // The server's releaseFinishedTheWork, which every payload carries beside the facts above.
    workFinished: true,
  },
  'running a job with no turn': {
    id: 's', status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
    activity: 'BACKGROUND_JOB', runningBgCount: 1, runningBgJobCount: 1,
    phase: 'RUNNING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: null, capabilities: held,
  },
  'waiting on an approval': {
    id: 's', status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING', pendingApprovals: 1, activity: 'TURN',
    phase: 'RUNNING', released: false, lastTurnOutcome: null, waitingOn: 'PERSON', capabilities: held,
  },
  'on hold': {
    id: 's', status: 'PENDING', runStatus: 'PENDING', runState: 'QUEUED', error: 'Account paused until 2099-01-01',
    queuedReason: null, activity: 'TURN',
    phase: 'PENDING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: 'HOLD', capabilities: held,
  },
  'will wake': {
    id: 's', status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', activity: 'WAITING',
    phase: 'IDLE', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: 'WAKE', capabilities: held,
  },
  'a running turn': {
    id: 's', status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING', activity: 'TURN',
    phase: 'RUNNING', released: false, lastTurnOutcome: null, waitingOn: null, capabilities: held,
  },
  'a queued turn': {
    id: 's', status: 'PENDING', runStatus: 'PENDING', runState: 'QUEUED', activity: 'TURN',
    phase: 'PENDING', released: false, lastTurnOutcome: null, waitingOn: null, capabilities: held,
  },
  // Parked (stored AWAITING_INPUT) while the engine runs its own turn: the server says activity TURN, phase RUNNING.
  'parked with the engine\'s own turn': {
    id: 's', status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', activity: 'TURN',
    engineTurnActive: true,
    phase: 'RUNNING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: null, capabilities: held,
  },
  'parked with a sub-agent running': {
    id: 's', status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', activity: 'TURN',
    runningSubagentCount: 1,
    phase: 'RUNNING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: null, capabilities: held,
  },
  'interrupted': {
    id: 's', status: 'INTERRUPTED', runStatus: 'INTERRUPTED', runState: 'INTERRUPTED',
    phase: 'IDLE', released: false, lastTurnOutcome: 'INTERRUPTED', waitingOn: null, capabilities: held,
  },
  // An End asked of a session parked after an interrupted turn: the legacy run state already says ENDED, but no
  // runner has let go yet (INTERRUPTED is a held status), so the server answers ENDING until the release lands.
  'ending after an interrupted turn': {
    id: 's', status: 'INTERRUPTED', runStatus: 'INTERRUPTED', runState: 'ENDED', endReason: 'ended',
    phase: 'IDLE', released: false, lastTurnOutcome: 'INTERRUPTED', waitingOn: null,
    capabilities: { canSend: false, canResume: false, resumeBlockedReason: 'ENDING' },
  },
  // An end was asked for and the runner never confirmed it, so the reaper released it with the old FAILED word: an end,
  // not a failure (design §12).
  'ended, runner never confirmed': {
    id: 's', status: 'FAILED', runStatus: 'FAILED', runState: 'FAILED', endReason: 'ended', error: 'cancel not honored',
    startedAt: '2026-11-22T00:00:00Z',
    phase: 'IDLE', released: true, lastTurnOutcome: 'FAILED', waitingOn: null, capabilities: resumable,
  },
  // A plain conversation an old server stored SUCCEEDED (decision D2: never succeeded, and not finished either).
  'old plain row stored SUCCEEDED': {
    id: 's', status: 'SUCCEEDED', runStatus: 'SUCCEEDED', runState: 'SUCCEEDED', startedAt: '2026-11-22T00:00:00Z',
    phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null, capabilities: resumable,
  },
  // A failed release with an automatic retry armed: released, and something will wake it. Waiting for that retry is
  // PENDING (the owner, 2026-11-26), waiting on the wake.
  'released with a retry armed': {
    id: 's', status: 'FAILED', runStatus: 'FAILED', runState: 'FAILED', retryAt: '2099-01-01T00:00:00Z',
    startedAt: '2026-11-22T00:00:00Z',
    phase: 'PENDING', released: true, lastTurnOutcome: 'FAILED', waitingOn: 'WAKE', capabilities: resumable,
  },
  // A spent quota parked at AWAITING_INPUT with the retry armed for its reset: held, no turn queued, PENDING on the wake.
  'parked with a retry armed': {
    id: 's', status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', activity: 'WAITING',
    retryAt: '2099-01-01T00:00:00Z',
    phase: 'PENDING', released: false, lastTurnOutcome: 'FAILED', waitingOn: 'WAKE', capabilities: held,
  },
  // The same with an owner decision open (a coordinator): PERSON outranks the wake, and the armed retry still says it
  // is no queued turn.
  'parked with a retry armed, an answer owed': {
    id: 's', status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', activity: 'WAITING',
    retryAt: '2099-01-01T00:00:00Z', pendingApprovals: 1,
    phase: 'PENDING', released: false, lastTurnOutcome: 'FAILED', waitingOn: 'PERSON', capabilities: held,
  },
};

/** The same payload from a control plane that predates the four fields (and `workFinished`, which came after them). */
export const olderServer = (payload: Payload): Payload => {
  const { phase: _p, released: _r, lastTurnOutcome: _o, waitingOn: _w, workFinished: _f, ...rest } = payload;
  return rest;
};

