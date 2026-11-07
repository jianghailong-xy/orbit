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
  /**
   * The sending session's stored mode (`from-mode` in the block), absent on an event stored before the
   * card carried it.
   */
  fromMode?: string;
  /**
   * The sender runs narrower than the session it wrote to, by the server's own comparison: what the
   * block says in a sentence. Absent when it does not.
   */
  fromModeNarrower?: true;
  /**
   * The request this message is, when the sender asked for a reply (`expectReply`,
   * docs/session-request-reply-contract.md §3) — the request's public id, absent on every message
   * that asked for none. Its state is not here: a stored event never changes, and the state does, so
   * a client reads it from `GET /session-requests/:id` (`SessionRequestView`).
   */
  requestId?: string;
}

/**
 * Who sent the message a session row previews (`lastUserText`), when it was another Orbit session's
 * — `session_send`, `project_send` or `session_interrupt` (docs/session-list-projects-design.md §3.5).
 * The same two facts the conversation's card draws "From <title>" with (`SessionMessageCard`'s
 * `fromSessionId` and `fromTitle`), read from the same place, as they stood when `lastUserText` was
 * written. The rows carry it as `lastUserFrom`, null when the account owner (or the platform) wrote
 * the message, and it is written and cleared together with `lastUserText`.
 */
export interface SessionMessageFrom {
  /** The sending session, in the uuid spelling every other read of one uses. */
  sessionId: string;
  title: string;
}

/**
 * Who outside Orbit sent a turn (docs/feishu-bot-design.md §8.2): a member of a connected Feishu group, whose words
 * the bot handed to one of the owner's sessions. The server records it from the event Feishu delivered, never from a
 * request body. The bot owner's own words in a group are the owner's, and carry none.
 *
 * Said in three places from the turn's one record: on the `user` event's payload (`externalSender`), where the
 * conversation draws "From Feishu · <name>" over the words; on a session row beside `lastUserText`
 * (`lastUserFromExternal`), written and cleared with it, where the row says "From Feishu · <name>: …"; and to the
 * runner on delivery, which tells the agent the message is not the account owner's.
 */
export interface ExternalMessageFrom {
  /** Where the sender is: the one source there is so far. */
  source: 'FEISHU';
  /** The sender's name as Feishu gave it when the turn was written; null when Feishu would not say. */
  name: string | null;
}

/** The sources `ExternalMessageFrom.source` takes, for a reader that has to check a payload. */
export const EXTERNAL_MESSAGE_SOURCES = ['FEISHU'] as const;
