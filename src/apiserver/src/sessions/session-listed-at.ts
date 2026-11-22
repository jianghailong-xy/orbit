import { openingTurnKey } from './orbit-authored-turn';

/**
 * `session.listed_at` (migration 1434): where a session sits in its owner's session list. `last_turn_at` is the
 * liveness clock — every persisted event, claim and state move rewrites it — so a list sorted by it reshuffled each
 * time a session waiting on CI printed a line. This one moves only when the session changes for its owner:
 *
 *  - it is created (the column default);
 *  - a person sends it a message: the owner's doors, a guest, a Feishu sender (`createTurn`/`resume`/`interrupt`
 *    with `listed`, which also marks the turn `by_person`);
 *  - a turn ends on the owner: a person's turn answered with nothing queued behind it (`answeredPerson`, at
 *    turn-complete), a permission card or question raised (runner `approvals`), an owner request filed;
 *  - it ends or is completed (the `session_listed_at_settle` trigger on status / completed_at).
 *
 * Streamed events, tool calls, background-job output, wake-up and notification turns, queue claims and runner
 * handshakes leave it alone.
 */

/** The ended turn was a person's: sent by one, or the opening of a session a person opened with their own prompt. */
export function answeredPerson(
  session: { openedBy: string; promptByOrbit: boolean; taskId: string | null; parentSessionId: string | null },
  turn: { clientTurnId: string; byPerson: boolean } | null,
  sessionId: string,
): boolean {
  if (!turn) return false;
  if (turn.byPerson) return true;
  // The opening is seeded when the session is first claimed, not by the door that opened it, so it carries no mark:
  // it is a person's when a person opened the session and wrote its prompt. A task's run (its brief) and a SubAgent
  // (its caller's) are not.
  return turn.clientTurnId === openingTurnKey(sessionId)
    && (session.openedBy === 'PERSON' || session.openedBy === 'FEISHU')
    && !session.promptByOrbit
    && session.taskId == null
    && session.parentSessionId == null;
}
