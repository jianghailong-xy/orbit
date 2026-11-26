/**
 * Whether a chat door filed this session's opening turn itself (SessionsService.writeChat): a wiki chat
 * (`wiki_chat_space_id`, wiki contract `chat.create.makes`) or a Drive chat (`opened_by` DRIVE_CHAT,
 * drive/drive-chat.ts). Its opening turn is the owner's message under the client's UUID, filed with the session, so no
 * seeder lays an `initial-` turn beside it, and it is listed and withdrawn no more than that seed is.
 */
export function chatFiledItsOpening(session: { wikiChatSpaceId: string | null; openedBy: string }): boolean {
  return session.wikiChatSpaceId != null || session.openedBy === 'DRIVE_CHAT';
}
