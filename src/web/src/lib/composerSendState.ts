import { ApiError } from '../api';
import { compatibleUuid } from './uuid';

/** A refused request is not a send: keep the exact draft so the person can retry it. Only an
 * authoritative accepted receipt clears it — including the receipt of a refused CURRENT_WORK
 * re-filed as NEXT_TURN, which is still in flight at the moment this runs. */
export function composerDraftAfterSend(draft: string, accepted: boolean): string {
  return accepted ? '' : draft;
}

/**
 * Whether this failed send is the one refusal that has an obvious landing of its own.
 *
 * The server takes CURRENT_WORK inside the Session row lock and refuses it — 409, this code —
 * when there is no live turn left to join: the target's lease expired, it completed, or the
 * runtime does not take steer at all. That refusal is a rollback, so nothing was placed and the
 * message still has somewhere to go: the next turn, which is where the runner already re-files a
 * steer it can prove never arrived (`steer_requeue`). Asking the person to pick here would make
 * this the one point on that path where a timing accident is theirs to resolve.
 *
 * By code, never by prose or by status alone: several unrelated 409s reach the same handler, and
 * only this one is both certain that nothing was written and certain of what to do instead.
 */
export function isCurrentWorkUnavailable(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 409
    && error.code === 'CURRENT_WORK_UNAVAILABLE';
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
