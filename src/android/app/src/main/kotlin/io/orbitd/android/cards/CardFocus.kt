package io.orbitd.android.cards

import androidx.compose.runtime.mutableStateMapOf
import io.orbitd.android.navigation.ObjectId

/** Which card a conversation is being opened onto (iOS `ConsoleModel.focus(ownerItem:)`): asked for before the
 * navigation that shows the conversation, spent by the card host once that card is drawn and brought into
 * view. A card's address is its key — `item:<itemId>` for an owner item, `start:<itemId>` for a start
 * request, `promotion:<id>` for a merge to main (a project has at most one live candidate, so any
 * promotion card answers a promotion focus). It changes where the conversation is scrolled to, nothing else. */
object CardFocus {
    private val pending = mutableStateMapOf<String, String>()
    private fun session(id: String) = ObjectId.canonical(id) ?: id

    fun request(sessionId: String, cardKey: String) { pending[session(sessionId)] = cardKey }
    fun pending(sessionId: String): String? = pending[session(sessionId)]
    fun spend(sessionId: String) { pending.remove(session(sessionId)) }
    fun matches(focus: String, cardKey: String) =
        focus == cardKey || (focus.startsWith("promotion:") && cardKey.startsWith("promotion:"))
}
