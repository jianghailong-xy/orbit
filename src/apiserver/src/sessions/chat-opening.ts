import type { SessionChatOrigin } from '@orbit/shared';

/**
 * Whether a chat door filed this session's opening turn itself (SessionsService.writeChat): a wiki chat
 * (`wiki_chat_space_id`, wiki contract `chat.create.makes`) or a Drive chat (`opened_by` DRIVE_CHAT,
 * drive/drive-chat.ts). Its opening turn is the owner's message under the client's UUID, filed with the session, so no
 * seeder lays an `initial-` turn beside it, and it is listed and withdrawn no more than that seed is.
 */
export function chatFiledItsOpening(session: { wikiChatSpaceId: string | null; openedBy: string }): boolean {
  return session.wikiChatSpaceId != null || session.openedBy === 'DRIVE_CHAT';
}

/**
 * Which chat door opened a session, for the origin tag its header and its list row draw (@orbit/shared
 * SESSION_ORIGIN_TAGS: From Wiki, From Drive, From Scheduled); null for every other session. The Scheduled page's chat
 * is marked by `schedule_chat_at` (migration 1760) and has no run source of its own.
 */
export function sessionChatOrigin(session: {
  wikiChatSpaceId: string | null;
  openedBy: string;
  scheduleChatAt: Date | null;
}): SessionChatOrigin | null {
  if (session.wikiChatSpaceId) return 'WIKI_CHAT';
  if (session.openedBy === 'DRIVE_CHAT') return 'DRIVE_CHAT';
  if (session.scheduleChatAt) return 'SCHEDULE_CHAT';
  return null;
}
