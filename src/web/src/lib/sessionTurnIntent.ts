import type { SessionTurnIntent } from '@orbit/shared';

/** Composer default only. The POST always carries this explicit value and placement still comes
 * exclusively from the server's row-locked receipt. */
export function defaultSessionTurnIntent(input: {
  live: boolean;
  status: string | null;
  numTurns: number;
}): SessionTurnIntent {
  return input.live
    && (input.status === 'RUNNING' || (input.status === 'PENDING' && input.numTurns === 0))
    ? 'CURRENT_WORK'
    : 'NEXT_TURN';
}
