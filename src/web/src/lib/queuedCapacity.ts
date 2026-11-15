import type { QueuedGate } from './runnerSlots';

/**
 * What a queued message says while a full runner, run or batch holds it (docs/mocks/queued-card-runner-full,
 * approved as recommended): `Queued · runner full` on each turn still waiting for its own turn, the way
 * `Queued · runner updating` is said (board queued-card-runner-updating), and a popover that counts how the
 * slots are taken. A runner counts a session against its maxConcurrent while it runs a turn OR while a
 * background job of its own still runs (src/runner-go/session_pool.go), so a runner can be full with fewer
 * turns than slots: the server reports those slots apart as queuedHeldByJobs.
 *
 * The native clients say the same words (OrbitKit QueuedCapacity, Android QueuedCapacity), held to this
 * file by their parity tests.
 */

/** The gate, with the slots background jobs hold and the clock the wait counts from. */
export interface CapacityGate extends QueuedGate {
  /** Of queuedActive, the slots background jobs hold; beside runner_at_capacity only. */
  queuedHeldByJobs?: number | null;
  /** When the session went PENDING: the wait's clock. */
  lastTurnAt?: string | null;
}

export const RUNNER_FULL_TITLE = 'Runner full';
export const RUNNER_FULL_TAG = 'runner full';
export const RUN_FULL_TITLE = 'Run full';
export const RUN_FULL_TAG = 'run full';
export const BATCH_FULL_TITLE = 'Batch full';
export const BATCH_FULL_TAG = 'batch full';

/** Whether a full runner, run or batch holds this queued session. */
export function isCapacityHeld(gate?: QueuedGate | null): boolean {
  const reason = gate?.queuedReason;
  return reason === 'runner_at_capacity' || reason === 'tree_at_capacity' || reason === 'batch_at_capacity';
}

/** The popover's title: `Runner full`, `Run full` or `Batch full`. */
export function capacityHeldTitle(gate: QueuedGate): string {
  switch (gate.queuedReason) {
    case 'tree_at_capacity':
      return RUN_FULL_TITLE;
    case 'batch_at_capacity':
      return BATCH_FULL_TITLE;
    default:
      return RUNNER_FULL_TITLE;
  }
}

/** The foot-row tag's words: `runner full`, `run full` or `batch full`. */
export function capacityHeldTag(gate: QueuedGate): string {
  switch (gate.queuedReason) {
    case 'tree_at_capacity':
      return RUN_FULL_TAG;
    case 'batch_at_capacity':
      return BATCH_FULL_TAG;
    default:
      return RUNNER_FULL_TAG;
  }
}

const sessions = (n: number) => (n === 1 ? '1 session' : `${n} sessions`);

/** `(13/13)`, or nothing where the server sent no numbers. */
function counted(gate: QueuedGate): string {
  return typeof gate.queuedActive === 'number' && typeof gate.queuedLimit === 'number'
    ? ` (${gate.queuedActive}/${gate.queuedLimit})`
    : '';
}

/**
 * The popover's sentence (board ③ and ⑤): `HPC is using all 16 slots: 10 sessions are running a turn and
 * 6 hold a slot with a background job. This message is sent as soon as one frees up.` Without slots held
 * by a job (or from a runner too old to report them): `HPC is running 16 of 16 sessions. This message is
 * sent as soon as one finishes.`
 */
export function capacityHeldMessageText(gate: CapacityGate, machine?: string | null): string {
  if (gate.queuedReason === 'tree_at_capacity') {
    return `This run is already using all its slots${counted(gate)}. This message is sent as soon as one of its sessions finishes.`;
  }
  if (gate.queuedReason === 'batch_at_capacity') {
    return `This batch is running its maximum${counted(gate)}. This message is sent as soon as one of its sessions finishes.`;
  }
  const who = machine?.trim() || 'The runner';
  const active = gate.queuedActive;
  const limit = gate.queuedLimit;
  const held = gate.queuedHeldByJobs ?? 0;
  if (typeof active !== 'number' || typeof limit !== 'number') {
    return `${who} is using all its slots. This message is sent as soon as one frees up.`;
  }
  if (held > 0) {
    const turns = Math.max(0, active - held);
    const running = turns === 1 ? '1 session is running a turn' : `${turns} sessions are running a turn`;
    return `${who} is using all ${limit} slots: ${running} and ${held} ${held === 1 ? 'holds' : 'hold'} a slot with a background job. This message is sent as soon as one frees up.`;
  }
  return `${who} is running ${active} of ${sessions(limit)}. This message is sent as soon as one finishes.`;
}

/** `Waiting 15 min`, from when the session went PENDING; null with no clock to read. */
export function capacityHeldWaited(gate: CapacityGate, now: number): string | null {
  const at = gate.lastTurnAt ? Date.parse(gate.lastTurnAt) : NaN;
  if (!Number.isFinite(at) || at > now) return null;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'Waiting less than a minute';
  if (minutes < 60) return `Waiting ${minutes} min`;
  const rest = minutes % 60;
  return `Waiting ${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
}
