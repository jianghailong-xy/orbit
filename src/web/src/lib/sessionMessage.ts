import type { SessionMessageCard } from '@orbit/shared';

/**
 * Another Orbit session's message, as the control plane recorded who sent it beside the turn's echo
 * (`sessionMessage`, apiserver sessions/session-message.ts) — the reading `SessionMessageCard` is
 * drawn from.
 *
 * `session_send` and `project_send` write a turn into this conversation that the account owner did
 * not type, and without this the turn was drawn as the owner's own bubble. The sender is the
 * server's to record, from the caller's own identity; a payload that is not a card parses as NOTHING
 * rather than as half a card, so every turn the owner typed — and every turn stored before the
 * payload existed — keeps the reading it has always had. Nothing is read out of the text.
 */
export function parseSessionMessage(payload: unknown): SessionMessageCard | null {
  const raw = (payload as { sessionMessage?: unknown } | null)?.sessionMessage;
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  // A card names the session that sent it: that is what makes it one.
  if (typeof card.fromSessionId !== 'string' || card.fromSessionId === '') return null;
  return {
    fromSessionId: card.fromSessionId,
    fromTitle: typeof card.fromTitle === 'string' ? card.fromTitle : '',
    fromAgentName: typeof card.fromAgentName === 'string' ? card.fromAgentName : '',
    ...(typeof card.fromTaskId === 'string' && card.fromTaskId !== '' ? { fromTaskId: card.fromTaskId } : {}),
  };
}

/** The word in front of the sending session's title, on the card's head and on the sticky bar. */
export const SESSION_MESSAGE_FROM = 'From';
/** What a session with no title is called where its title would be. */
export const SESSION_MESSAGE_UNTITLED = 'Untitled session';
/** The foot line: who this is not. */
export const SESSION_MESSAGE_NOT_YOU = 'Sent by another Orbit session, not by you';
export const SESSION_MESSAGE_OPEN_TASK = 'Its task ↗';
export const SESSION_MESSAGE_UNDELIVERED = 'The session has not confirmed it received this.';

/** The sending session as the card names it: its title, or what an untitled one is called. */
export function sessionMessageTitle(card: SessionMessageCard): string {
  return card.fromTitle.trim() || SESSION_MESSAGE_UNTITLED;
}

/**
 * What the sticky bar names this turn by: who sent it, and what it said. Not "Your question" — the
 * bar saying that above a card reading "not by you" would be the screen contradicting itself.
 */
export function sessionMessageSticky(card: SessionMessageCard, text: string): { label: string; text: string } {
  return { label: `${SESSION_MESSAGE_FROM} ${sessionMessageTitle(card)}`, text };
}
