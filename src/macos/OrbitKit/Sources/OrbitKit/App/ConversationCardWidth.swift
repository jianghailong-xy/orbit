import Foundation

/// The one width every card in a conversation draws at, in points (docs/mocks/chat-card-width, owner
/// approved; the web's `--chat-card-max: 720px`). A column wider than this ends every card on one
/// line; a narrower one, a phone's, is filled by each card. Prose, tool output and code are not
/// cards and keep the column. Cards on the project page and in sheets are not in a conversation.
public enum ConversationCardWidth {
    public static let max: CGFloat = 720
}
