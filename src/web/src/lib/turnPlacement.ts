export type TurnPlacement = 'accepted' | 'queued' | 'steer';

interface TurnPlacementResponse {
  kind?: string;
  placement?: string;
}

/**
 * The server decides placement while holding the Session row lock. The local idle bit remains
 * only as a rolling-upgrade fallback for responses from a server that predates that decision.
 */
export function turnPlacementOf(
  response: TurnPlacementResponse,
  idleFallback: boolean,
): TurnPlacement {
  if (
    response.placement === 'accepted' ||
    response.placement === 'queued' ||
    response.placement === 'steer'
  )
    return response.placement;
  if (response.kind === 'steer') return 'steer';
  return idleFallback ? 'accepted' : 'queued';
}
