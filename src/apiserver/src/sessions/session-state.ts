import { SessionState, deriveSessionState } from '@orbit/shared';

/** The raw fields required to augment a Prisma/API session row. */
export interface RawSessionStateFields {
  status: string;
  endReason?: string | null;
  archivedAt?: Date | string | null;
  deletedAt?: Date | string | null;
}

/**
 * Preserve the legacy `status` field while exposing its explicit `runStatus` alias and
 * the authoritative product-level `sessionState`. Kept server-side so every Session
 * payload is augmented in the same shape without changing the persisted Prisma model.
 */
export function withSessionState<T extends RawSessionStateFields>(
  session: T,
): T & { runStatus: T['status']; sessionState: SessionState } {
  return {
    ...session,
    runStatus: session.status,
    sessionState: deriveSessionState(session),
  };
}
