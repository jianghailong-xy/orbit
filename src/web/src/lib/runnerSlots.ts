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

export function pendingSlotDescription(active: number, maxConcurrent?: number | null): string {
  return typeof maxConcurrent === 'number' && maxConcurrent > 0 && active >= maxConcurrent
    ? `Runner at capacity (${active}/${maxConcurrent}). This session starts as soon as a slot frees up.`
    : 'This session starts as soon as a slot frees up.';
}
