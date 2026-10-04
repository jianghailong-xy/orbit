import type {
  OpenItemChat,
  OpenItemChatRefusal,
  OpenItemStage,
  ProjectOpenItemRow,
  ProjectPromotionView,
} from '@orbit/shared';
import { encodeId } from './idCodec';

/**
 * "Chat about this" on the cards that say what a project owes somebody — an exception item, the
 * pause, and a merge into main that cannot happen yet (contract §4.8, §7.5).
 *
 * WHAT IT IS. A message to the project's coordinator conversation, with the card's facts — the
 * project, the item, what failed, and where its handling stands — carried in front of what the
 * reader types. In that conversation it arms the composer, the way every other card that hands a
 * reply to the composer does; anywhere else it opens that conversation first (`coordinatorChatPath`)
 * and arms it on arrival. The native ends draw the same press on the same cards
 * (`ExceptionCards.chatBanner` / `chatContext`), and its two words for the bar are theirs.
 *
 * WHAT IT IS NOT. A door. It presses nothing on the card it sits on: a rerun, a merge into main, a
 * close and a release stay the presses — and the owner's — they were, decided by the server's
 * `actions` and by the doors behind them. Whether the chat itself can be had is decided by the server
 * too (`ProjectOpenItemRow.chat`), and when it cannot, the card says why beside the press instead of
 * hiding it.
 */

/** The press, in the word every card that hands a reply to the composer uses. */
export const CHAT_ABOUT_THIS = 'Chat about this';

/** What the composer's bar says the message is about — the native ends' own words
 *  (`ExceptionCards.chatPrefix`, `pauseChatPrefix`), and the merge card's, which they do not draw. */
export const EXCEPTION_CHAT_PREFIX = 'About this exception: ';
export const PAUSE_CHAT_PREFIX = 'About this pause: ';
export const MERGE_CHAT_PREFIX = 'About this merge: ';
/** What the armed composer asks for. A message, not an answer: no door is waiting on it. */
export const COORDINATOR_CHAT_PLACEHOLDER = 'Say what the coordinator should do…';

/** Why the press is not live, said beside it rather than in a tooltip nobody hovers. */
export const CHAT_REFUSAL_LABEL: Record<OpenItemChatRefusal, string> = {
  NO_COORDINATOR:
    'This project has no coordinator conversation to chat in — open one from the project page',
  COORDINATOR_UNAVAILABLE: 'The coordinator conversation can’t take a message right now',
  SUPERSEDED: 'A newer item took this one’s place — chat about that one',
};

/** What a chat is about: one item, or the candidate a blocked merge card is drawn from — with the
 *  item holding it, when one has been filed. */
export type CoordinatorChatSubject =
  | { kind: 'item'; row: ProjectOpenItemRow }
  | { kind: 'promotion'; promotion: ProjectPromotionView; item: ProjectOpenItemRow | null };

/**
 * The item's chat, as the server decided it — or, from a server that predates the field, the stage
 * this build can read off the row and the conversation the item was delivered to. The fallback
 * refuses only what the row itself says (a superseded item); where the message would go is then the
 * host's to know.
 */
export function itemChat(row: ProjectOpenItemRow): OpenItemChat {
  if (row.chat) return row.chat;
  const stage: OpenItemStage = row.outcome
    ? row.outcome.resolution === 'RETRIED' ? 'SUPERSEDED' : 'HANDLED'
    : row.handling ? 'HANDLING'
      : row.assignee === 'OWNER' ? 'WITH_OWNER'
        : 'WITH_COORDINATOR';
  return {
    sessionId: row.delivery.sessionId,
    stage,
    refusal: stage === 'SUPERSEDED' ? 'SUPERSEDED' : null,
  };
}

/**
 * Where a press from outside the coordinator conversation lands: that conversation, carrying what the
 * chat is about — the same transient framing the project page hands it for a start request
 * (`?intent=start-project`), so a refresh or a Back keeps the reading and the conversation arms the
 * composer once it has read the subject itself.
 */
export const CHAT_ABOUT_INTENT = 'chat-about';

export function coordinatorChatPath(sessionId: string, subject: CoordinatorChatSubject): string {
  const params = new URLSearchParams({ intent: CHAT_ABOUT_INTENT });
  if (subject.kind === 'item') params.set('item', encodeId(subject.row.itemId));
  else params.set('promotion', encodeId(subject.promotion.promotionId));
  return `/sessions/${encodeURIComponent(encodeId(sessionId))}?${params.toString()}`;
}

/** What the conversation says when the press that opened it named an item or a candidate that has
 *  moved on since: nothing is armed about something that is no longer there. */
export const CHAT_SUBJECT_GONE =
  'What you chose to chat about has moved on since — nothing was carried into the composer.';

/** The subject a `coordinatorChatPath` names, as ids — or null for any other URL. */
export function chatIntentOf(
  params: URLSearchParams,
): { itemId: string } | { promotionId: string } | null {
  if (params.get('intent') !== CHAT_ABOUT_INTENT) return null;
  const itemId = params.get('item');
  if (itemId) return { itemId };
  const promotionId = params.get('promotion');
  return promotionId ? { promotionId } : null;
}
