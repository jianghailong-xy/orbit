import { sessionRunStatusOf } from './sessionState';

export interface SlotSession {
  runStatus?: string | null;
  /** Legacy alias retained for payloads from older servers. */
  status?: string | null;
}

export interface RunnerSlotUsage {
  active: number;
  atCapacity: boolean;
}

// maxConcurrent limits turns that are actively executing. A warm or cold
// AWAITING_INPUT session remains resumable, but it does not hold an active slot.
export function activeSlotCount(sessions: readonly SlotSession[]): number {
  return sessions.filter((session) => sessionRunStatusOf(session) === 'RUNNING').length;
}

export function runnerSlotUsage(
  sessions: readonly SlotSession[],
  maxConcurrent?: number | null,
): RunnerSlotUsage {
  const active = activeSlotCount(sessions);
  return {
    active,
    atCapacity:
      typeof maxConcurrent === 'number' && maxConcurrent > 0 && active >= maxConcurrent,
  };
}

export const PENDING_SLOT_LABEL = 'Waiting for slot';
export const PENDING_SLOT_TITLE = 'Waiting for a free slot';

/** Which gate the server found holding a queued session, with the numbers it judged on. */
export interface QueuedGate {
  queuedReason?: string | null;
  queuedActive?: number | null;
  queuedLimit?: number | null;
}

/**
 * Why this session has not started, in the user's terms.
 *
 * The server names the gate, because only it can: a session can sit queued while the runner it
 * belongs to is half idle — its own run is full, or the batch it was dispatched with is — and
 * from one agent's page of the list there is no way to tell. Falls back to the runner-capacity
 * reading for payloads from a server that predates the field.
 */
export function pendingSlotDescription(
  active: number,
  maxConcurrent?: number | null,
  gate?: QueuedGate | null,
): string {
  const starts = 'This session starts as soon as a slot frees up.';
  const counted =
    typeof gate?.queuedActive === 'number' && typeof gate?.queuedLimit === 'number'
      ? ` (${gate.queuedActive}/${gate.queuedLimit})`
      : '';
  switch (gate?.queuedReason) {
    case 'tree_at_capacity':
      // Deliberately says "run", not "tree": the user started one piece of work that spawned
      // helpers, and that whole thing is what is full — not the machine.
      return `This run is already using all its slots${counted}. The next sub-session starts as one finishes.`;
    case 'batch_at_capacity':
      return `This batch is running its maximum${counted}. ${starts}`;
    case 'runner_at_capacity':
      return `Runner at capacity${counted}. ${starts}`;
  }
  return typeof maxConcurrent === 'number' && maxConcurrent > 0 && active >= maxConcurrent
    ? `Runner at capacity (${active}/${maxConcurrent}). ${starts}`
    : starts;
}
