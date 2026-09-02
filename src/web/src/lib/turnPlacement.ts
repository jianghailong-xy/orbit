import type { SessionTurnPlacement } from '@orbit/shared';

export type TurnPlacement = SessionTurnPlacement;

interface TurnPlacementResponse {
  placement: SessionTurnPlacement;
}

/**
 * The server decides placement while holding the Session row lock. Missing/unknown placement is a
 * protocol error: guessing from local status recreates the send/dequeue race this receipt closes.
 */
export function turnPlacementOf(response: TurnPlacementResponse): TurnPlacement {
  if (
    response.placement === 'accepted' ||
    response.placement === 'queued' ||
    response.placement === 'steer'
  )
    return response.placement;
  throw new Error('Session turn response omitted a valid server placement');
}
