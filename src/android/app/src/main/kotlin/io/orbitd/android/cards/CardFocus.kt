package io.orbitd.android.cards

import androidx.compose.runtime.mutableStateMapOf
import io.orbitd.android.core.cards.InteractionCard
import io.orbitd.android.navigation.ObjectId

/** Which card a conversation is being opened onto (iOS `ConsoleModel.focus(ownerItem:)`): asked for before the
 * navigation that shows the conversation, spent by the card host once that card is drawn and brought into
 * view. A card's address is its key — `item:<itemId>` for an owner item, `start:<itemId>` for a start
 * request, `promotion:<id>` for a merge to main (a project has at most one live candidate, so any
 * promotion card answers a promotion focus). It changes where the conversation is scrolled to, nothing else. */
object CardFocus {
    /** Not a card's address: whichever card the conversation first asks the owner about (owner 2026-11-14, a project row whose
     * line says a member waits on you). Brought in top first, so a card taller than the screen shows its header and title. */
    const val WAITING = "waiting"
    private val pending = mutableStateMapOf<String, String>()
    private fun session(id: String) = ObjectId.canonical(id) ?: id

    /** When each WAITING request was made, by wall clock: a request lapses [WAITING_EXPIRES_MS] after it, whatever the reader does. */
    private val askedAt = HashMap<String, Long>()
    /** The clock the lapse reads; a test sets its own. */
    var now: () -> Long = { System.currentTimeMillis() }

    fun request(sessionId: String, cardKey: String) { pending[session(sessionId)] = cardKey; askedAt[session(sessionId)] = now() }
    /** The address a conversation is being opened onto, if one still stands: a [WAITING] request that found no card has lapsed. */
    fun pending(sessionId: String): String? {
        val id = session(sessionId)
        val key = pending[id] ?: return null
        if (key == WAITING && now() - (askedAt[id] ?: now()) >= WAITING_EXPIRES_MS) return null
        return key
    }
    fun spend(sessionId: String) { pending.remove(session(sessionId)) }

    /** How long a request to open at a waiting card stands with no such card drawn (web `WAITING_REVEAL_EXPIRES_MS`): a question
     * answered elsewhere before the open is never drawn, and a request left standing would fire on a later card and carry a reader
     * who by then reads something else away from it. */
    const val WAITING_EXPIRES_MS = 10_000L
    /** How long the card a conversation was opened at (or a record jumped to) is held in place with nothing moving it (web
     * `LANDING_QUIET_MS`): long enough for the rest of the first page, receipts and translations to land above it. */
    const val HOLD_QUIET_MS = 5_000L

    /** The card a conversation was opened at, held where it was brought to. [tick] counts the re-applications asked for, [at] is when
     * it was last brought in (or the conversation last moved around it). */
    data class Held(val key: String, val waiting: Boolean, val tick: Int = 0, val at: Long = 0)
    private val held = mutableStateMapOf<String, Held>()
    fun hold(sessionId: String, cardKey: String, waiting: Boolean) { held[session(sessionId)] = Held(cardKey, waiting, at = now()) }
    fun held(sessionId: String): Held? = held[session(sessionId)]
    /** The conversation changed around the held card: ask it to put itself back — unless nothing has moved it for [HOLD_QUIET_MS], which lets it go. */
    fun reapply(sessionId: String) {
        val id = session(sessionId)
        val current = held[id] ?: return
        held[id] = if (now() - current.at >= HOLD_QUIET_MS) return release(sessionId) else current.copy(tick = current.tick + 1, at = now())
    }
    /** The reader took the scroller, jumped to the tail, or left. */
    fun release(sessionId: String) { held.remove(session(sessionId)) }
    /** The address [focus] names among [cards], drawn in this order: [WAITING] is the first that asks for an answer. */
    fun resolve(focus: String?, cards: List<InteractionCard>): String? =
        if (focus == WAITING) cards.firstOrNull { it.actions.isNotEmpty() }?.key else focus
    fun matches(focus: String, cardKey: String) =
        focus == cardKey || (focus.startsWith("promotion:") && cardKey.startsWith("promotion:"))
}
