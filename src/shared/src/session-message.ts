/**
 * What a `user` event carries beside its text when the turn is another Orbit session's message —
 * `session_send` or `project_send` (docs/session-request-reply-contract.md §2.3).
 *
 * Those two doors write a turn into somebody else's conversation, and until this existed the turn
 * was `{ clientTurnId, content }` and nothing else: the recipient read another agent's words as the
 * account owner's, and a client drew them as the owner's own bubble because it had nothing else to
 * draw them from. The sender is recorded on the turn by the server, from the caller's own identity
 * (`conversation_turn.sender_session_id`), and read out of that column when the runner's echo of the
 * turn is stored — never out of anything a caller sent.
 *
 * A snapshot of the sending session as it stood when the echo was stored. Absent — not empty — on
 * every turn somebody other than a session wrote: the account owner, a headless credential, the
 * platform's own deliveries.
 */
export interface SessionMessageCard {
  /** The sending session, in the uuid spelling every other read of one uses. */
  fromSessionId: string;
  fromTitle: string;
  /** The sending session's workspace — the agent, in the clients' words. */
  fromAgentName: string;
  /** The task the sending session runs, absent when it runs none. */
  fromTaskId?: string;
}
