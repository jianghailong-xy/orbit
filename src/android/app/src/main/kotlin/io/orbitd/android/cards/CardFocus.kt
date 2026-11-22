package io.orbitd.android.cards

import androidx.compose.runtime.mutableStateMapOf
import io.orbitd.android.core.cards.InteractionCard
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.navigation.ObjectId

/** Which card a conversation is being opened onto (iOS `ConsoleModel.focus(ownerItem:)`): asked for before the
 * navigation that shows the conversation, spent by the card host once that card is drawn and brought into
 * view. A card's address is its key — `item:<itemId>` for an owner item, `start:<itemId>` for a start
 * request, `promotion:<id>` for a merge to main (a project has at most one live candidate, so any
 * promotion card answers a promotion focus), [ownerRequest] for a request the conversation filed. It changes where
 * the conversation is scrolled to, nothing else. */
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
    /** An owner request's card, under either spelling of its id. */
    fun ownerRequest(id: String) = "$OWNER_REQUEST${OwnerRequests.key(id)}"
    const val OWNER_REQUEST = "owner-request:"

    /** How long a request to open at a waiting card stands with no such card drawn (web `WAITING_REVEAL_EXPIRES_MS`): a question
     * answered elsewhere before the open is never drawn, and a request left standing would fire on a later card and carry a reader
     * who by then reads something else away from it. */
    const val WAITING_EXPIRES_MS = 10_000L
    /** How long the card a conversation was opened at (or a record jumped to) is held in place with nothing moving it (web
     * `LANDING_QUIET_MS`): long enough for the rest of the first page, receipts and translations to land above it. */
    const val HOLD_QUIET_MS = 5_000L

    /** The card a conversation was opened at, held where it was brought to: [top] is where it stood in the window then, [at] when it
     * was last put there (or brought in). */
    data class Held(val key: String, val waiting: Boolean, val top: Float, val at: Long)
    private val held = mutableStateMapOf<String, Held>()
    /** Where each drawn card stands in the window, as the last layout said (not state: nothing redraws for it). */
    private val standing = HashMap<String, Float>()
    fun report(sessionId: String, cardKey: String, top: Float) { standing[session(sessionId) + "/" + cardKey] = top }
    fun position(sessionId: String, cardKey: String): Float? = standing[session(sessionId) + "/" + cardKey]
    fun hold(sessionId: String, cardKey: String, waiting: Boolean) {
        held[session(sessionId)] = Held(cardKey, waiting, position(sessionId, cardKey) ?: return, now())
    }
    fun held(sessionId: String): Held? = held[session(sessionId)]
    /** The conversation changed around the held card. False when nothing has moved it for [HOLD_QUIET_MS], which lets it go. A card
     * already in place leaves the quiet running: only [moved] restarts it (web `keepLanding`). */
    fun reapply(sessionId: String): Boolean {
        val current = held[session(sessionId)] ?: return false
        if (now() - current.at < HOLD_QUIET_MS) return true
        release(sessionId); return false
    }
    /** A put-back moved the card: the quiet starts again. */
    fun moved(sessionId: String) {
        val id = session(sessionId)
        held[id]?.let { held[id] = it.copy(at = now()) }
    }
    /** The reader took the scroller, jumped to the tail, or left. */
    fun release(sessionId: String) { held.remove(session(sessionId)) }
    /** The address [focus] names among [cards], drawn in this order: [WAITING] is the first that asks for an answer. */
    fun resolve(focus: String?, cards: List<InteractionCard>): String? =
        if (focus == WAITING) cards.firstOrNull { it.actions.isNotEmpty() }?.key else focus
    fun matches(focus: String, cardKey: String) =
        focus == cardKey || (focus.startsWith("promotion:") && cardKey.startsWith("promotion:"))
}
