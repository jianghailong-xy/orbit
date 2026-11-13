import type { ExternalMessageFrom } from '@orbit/shared';

/**
 * Somebody outside Orbit who sent a turn: a member of a connected Feishu group whose words the bot
 * handed to one of the owner's sessions (docs/feishu-bot-design.md §8.2). The server records it from
 * the event Feishu delivered — on the `user` event's payload (`externalSender`) and on the session row
 * beside `lastUserText` (`lastUserFromExternal`) — and a client draws it as `From Feishu · <name>`:
 * over the words in the conversation, and in front of them on the row, where "You:" would put a group
 * member's request in the owner's mouth.
 *
 * Somebody the owner invited to reply in the session (ORBIT_GUEST, docs/session-guests-design.md §3)
 * is another Orbit account, recorded the same way and drawn as `From <name>` in the same two places.
 *
 * Every word is copied verbatim by the native clients (OrbitKit, Android); their parity tests read
 * this file, so the declarations below stay literal.
 */
export const EXTERNAL_SENDER_FROM_FEISHU = 'From Feishu';
export const EXTERNAL_SENDER_NAME_SEPARATOR = ' · ';
export const EXTERNAL_SENDER_FROM_GUEST = 'From';

/**
 * The sender a payload or a row carries, or null. Anything that is not one — absent, from an older
 * server, or of a source this client does not know — reads as null, so the turn keeps the reading it
 * has always had.
 */
export function parseExternalSender(raw: unknown): ExternalMessageFrom | null {
  if (!raw || typeof raw !== 'object') return null;
  const from = raw as Record<string, unknown>;
  const name = typeof from.name === 'string' && from.name.trim() !== '' ? from.name.trim() : null;
  // A guest is an Orbit account, which always has a name: one without it is not a guest this client can name.
  if (from.source === 'ORBIT_GUEST') return name ? { source: 'ORBIT_GUEST', name } : null;
  if (from.source !== 'FEISHU') return null;
  return { source: 'FEISHU', name };
}

/** `From <name>` for a guest; `From Feishu · <name>`, or `From Feishu` when Feishu would not say the name. */
export function externalSenderLabel(from: ExternalMessageFrom): string {
  if (from.source === 'ORBIT_GUEST') return `${EXTERNAL_SENDER_FROM_GUEST} ${from.name}`;
  return from.name ? `${EXTERNAL_SENDER_FROM_FEISHU}${EXTERNAL_SENDER_NAME_SEPARATOR}${from.name}` : EXTERNAL_SENDER_FROM_FEISHU;
}
