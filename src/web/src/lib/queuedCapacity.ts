import type { SessionSlotWait } from '@orbit/shared';
import type { QueuedGate } from './runnerSlots';
import { sessionRunStateOf, type SessionStateSource } from './sessionState';

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
  runNowAvailable?: boolean;
  runNowRefusal?: string | null;
}

export interface RunningOverLimit {
  active: number;
  limit: number;
  runnerName: string | null;
}

export const RUN_NOW = 'Run now';
export const RUN_NOW_FAILED = "Couldn't run now";
export const EXTRA_SESSIONS_ON_DEMAND = 'Extra sessions on demand';

const ordinalRules = new Intl.PluralRules('en', { type: 'ordinal' });

export function runNowNote(
  gate: CapacityGate,
  machine: string | null | undefined,
  runnerActive?: number,
  runnerLimit?: number,
): string | null {
  if (!isCapacityHeld(gate)) return null;
  if (gate.runNowRefusal) return gate.runNowRefusal;
  if (gate.runNowAvailable !== true) return null;
  const runnerFull = gate.queuedReason === 'runner_at_capacity';
  const active = runnerFull ? gate.queuedActive ?? runnerActive : runnerActive;
  const limit = runnerFull ? gate.queuedLimit ?? runnerLimit : runnerLimit;
  if (active == null || limit == null) return 'Starts this turn now. The limit stays the same.';
  const next = active + 1;
  const category = ordinalRules.select(next);
  const suffix = category === 'one' ? 'st' : category === 'two' ? 'nd' : category === 'few' ? 'rd' : 'th';
  const where = machine?.trim() ? `on ${machine.trim()}` : 'on this runner';
  return `Starts it as the ${next}${suffix} session ${where}. This turn only; the limit stays ${limit}.`;
}

export function runningOverLimitTag({ active, limit }: RunningOverLimit): string {
  return `over limit · ${active}/${limit}`;
}

export function runningOverLimitHint({ runnerName }: RunningOverLimit): string {
  const runner = runnerName?.trim();
  return runner ? `Started over ${runner}'s limit by you` : "Started over the runner's limit by you";
}

export const RUNNER_FULL_TITLE = 'Runner full';
export const RUNNER_FULL_TAG = 'runner full';
export const RUN_FULL_TITLE = 'Run full';
export const RUN_FULL_TAG = 'run full';
export const BATCH_FULL_TITLE = 'Batch full';
export const BATCH_FULL_TAG = 'batch full';
/**
 * The session list's line for any of the three (board session-row-runner-full, owner's pick C): what
 * the row is doing in plain words. The row's own time already counts the wait (lastTurnAt is when it
 * went PENDING), so the line adds no clock; which gate is full is the row's tooltip, where there is one.
 */
export const CAPACITY_HELD_LINE = 'Waiting for a free slot';

/** A claimed session as the runner keeps it waiting for its slot (enginePhase `waiting_for_slot`). */
export interface SlotWaitSource extends SessionStateSource {
  enginePhase?: string | null;
  enginePhaseSince?: string | null;
  runClaimedAt?: string | null;
  slotWait?: SessionSlotWait | null;
}

/**
 * The full runner's gate for a claimed session it keeps waiting for a slot: a full runner gives such a claim back, and
 * the session waits queued behind it (runner_at_capacity); the claim it could not give back — a message already handed
 * out under it, another process's lease — is named instead (enginePhase `waiting_for_slot`, with the runner's counts).
 * Either way it is the same wait, so it is said in the same words, by the same tag: `Queued · runner full`, the
 * popover's counts and "This message is sent as soon as one frees up." Null for every other session.
 */
export function slotWaitGate(session?: SlotWaitSource | null): CapacityGate | null {
  if (!session || session.enginePhase !== 'waiting_for_slot' || sessionRunStateOf(session) !== 'RUNNING') return null;
  const counts = session.slotWait;
  return {
    queuedReason: 'runner_at_capacity',
    queuedActive: counts?.active ?? null,
    queuedLimit: counts?.limit ?? null,
    queuedHeldByJobs: counts?.heldByJobs ?? null,
    lastTurnAt: session.enginePhaseSince ?? session.runClaimedAt ?? null,
  };
}

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

/** The list row's tooltip: the popover's title, sentence and wait, one per line. */
export function capacityHeldHint(gate: CapacityGate, machine: string | null | undefined, now: number): string {
  const waited = capacityHeldWaited(gate, now);
  return [capacityHeldTitle(gate), capacityHeldMessageText(gate, machine), waited].filter(Boolean).join('\n');
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

/**
 * The popover's sentence said of a scheduled run waiting for its first turn (board scheduled-run-not-started ③):
 * `HPC is running 20 of 20 sessions. The run starts as soon as one finishes.`
 */
export function capacityHeldRunText(gate: CapacityGate, machine?: string | null): string {
  return capacityHeldMessageText(gate, machine).replace('This message is sent', 'The run starts');
}
