package io.orbitd.android.core.cards

/**
 * The one width every card in a conversation draws at, in dp (docs/mocks/chat-card-width, owner approved; the web's
 * `--chat-card-max: 720px`, OrbitKit's `ConversationCardWidth.max`). A column wider than this ends every card on one line; a narrower
 * one, a phone's, is filled by each card. Prose, tool output and code are not cards and keep the column. Cards on the project page
 * and in sheets are not in a conversation.
 */
object ConversationCardWidth {
    const val DP = 720
}
