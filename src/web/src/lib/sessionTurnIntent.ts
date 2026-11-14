import type { SessionTurnIntent } from '@orbit/shared';

/** Composer default only. The POST always carries this explicit value and placement still comes
 * exclusively from the server's row-locked receipt. While a message already waits for the next
 * turn, a new one joins it there: steering it into the current turn would jump the queue. */
export function defaultSessionTurnIntent(input: {
  live: boolean;
  status: string | null;
  numTurns: number;
  nextTurnQueued?: boolean;
}): SessionTurnIntent {
  return input.live
    && !input.nextTurnQueued
    && (input.status === 'RUNNING' || (input.status === 'PENDING' && input.numTurns === 0))
    ? 'CURRENT_WORK'
    : 'NEXT_TURN';
}
