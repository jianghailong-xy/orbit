import { compatibleUuid } from './uuid';

/** A refused CURRENT_WORK request is not a send: keep the exact draft so the person can choose
 * NEXT_TURN or retry. Only an authoritative accepted receipt clears it. */
export function composerDraftAfterSend(draft: string, accepted: boolean): string {
  return accepted ? '' : draft;
}

export interface LogicalSendToken {
  fingerprint: string;
  clientTurnId: string;
}

/**
 * Keep one idempotency key for one logical send across an uncertain HTTP failure. JSON object
 * insertion order is fixed by the caller; attachment ids are normalized there. Editing any wire
 * field changes the fingerprint and mints a new operation, while an identical retry reuses it.
 */
export function logicalSendToken(
  previous: LogicalSendToken | null,
  payload: Record<string, unknown>,
  mint: () => string = compatibleUuid,
): LogicalSendToken {
  const fingerprint = JSON.stringify(payload);
  return previous?.fingerprint === fingerprint
    ? previous
    : { fingerprint, clientTurnId: mint() };
}

/** Status-bar conflict resolution is also a logical send. Keep its operation key across an
 * uncertain resume response; changing branch/target/prompt is a different authored operation. */
export function resolveConflictLogicalSendToken(
  previous: LogicalSendToken | null,
  payload: { sessionId: string; branch: string; target: string; content: string },
  mint: () => string = compatibleUuid,
): LogicalSendToken {
  return logicalSendToken(previous, { operation: 'resolve-conflict', ...payload }, mint);
}
