import { LANDING_FIX_TURN_KEY_PREFIX } from './watch-turn-key';

/**
 * Which platform turns may revive an ended session (docs/project-integration-line-contract.md §0.3 G6,
 * §12.5 W6, ruling R3).
 *
 * G6: a turn the platform writes into a session goes through `createTurn`, and a session that has ended
 * refuses it — the platform does not revive a conversation to tell it something. One exception, and only
 * one: a failed landing handed to its task's own work session (`landing-fix:v1:<jobId>`) revives that
 * session through the resume path when it ended because its task was done (`end_reason = 'task_done'`).
 * Any other way of ending — a person ended it, cancelled it, completed it, moved it to Trash, or its run
 * failed — is refused, although `resume` itself would revive most of them.
 *
 * `platform-turn-revival-census.spec.ts` holds the list to that one prefix, and holds every `resume`
 * caller in the product to the key it writes.
 */
export const REVIVING_PLATFORM_TURN_PREFIXES: readonly string[] = [LANDING_FIX_TURN_KEY_PREFIX];

/** The one way of ending a platform turn may revive (§12.5 W6). */
export const PLATFORM_REVIVABLE_END_REASON = 'task_done';

/** A session's ending, as the revival rule reads it. */
export interface RevivableSession {
  finishedAt: Date | null;
  endReason: string | null;
  deletedAt: Date | null;
}

/**
 * Whether a platform turn under `clientTurnId` may be delivered to this ended session by reviving it:
 * a reviving prefix, and a session that finished because its task was done and is not in Trash.
 */
export function platformTurnRevives(clientTurnId: string, session: RevivableSession): boolean {
  return REVIVING_PLATFORM_TURN_PREFIXES.some((prefix) => clientTurnId.startsWith(prefix))
    && session.finishedAt !== null
    && session.endReason === PLATFORM_REVIVABLE_END_REASON
    && session.deletedAt === null;
}
