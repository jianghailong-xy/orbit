package io.orbitd.android.reader

import androidx.compose.runtime.Immutable
import io.orbitd.android.core.cards.queuedWake
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.*

/**
 * A steer of the reader's that nothing has read yet (docs/mocks/steer-tray, decided 2026-10-16; OrbitKit
 * `TranscriptState.unreadSteers`, web `Transcript.tsx`'s `UnreadSteer`): its echo, the latest word on its delivery — absent,
 * `enqueued`, `written` or `requeued` — and whether its runner said the engine can drop it unread (`withdrawable`). It is not part of
 * the conversation until the engine reads it, so the transcript leaves it out and the tray above the composer holds it.
 */
@Immutable
internal data class UnreadSteer(val event: RunEvent, val delivery: String?, val withdrawable: Boolean)

/** A window's events in the order the transcript draws them, and the reader's steers they leave to the tray, in the order sent. */
internal class SteerPlacement(val drawn: List<RunEvent>, val unread: List<UnreadSteer>)

/** How a message came out, as the latest word on it says: its `delivery`, and the [reason] given with it — a `user_delivery`'s, or the
 * server's durable receipt's (`deliveryReason`). */
@Immutable
internal data class SteerOutcome(val delivery: String?, val reason: String? = null)

/** What a message sent into a running turn has come to, and where it is drawn meanwhile (OrbitKit `SteerDelivery`). */
internal object SteerDelivery {
    /** The runner's word that the engine dropped a steer unread at its sender's request: nothing will ever read it. */
    const val WITHDRAWN = "withdrawn"
    /** It missed the turn it was aimed at and was handed back to run as the next one. */
    const val REQUEUED = "requeued"
    /** Under a steer that never reached the engine: its words back in the composer, under any draft. Nothing is sent. */
    const val PUT_BACK = "Put back in the composer"
    /** A Put back whose turn, known only from the server's receipt, the server would not discard: the words are in the composer even so. */
    const val COULDNT_DISCARD = "Couldn't discard the message"

    /** Whether this delivery ends a steer's wait: read into the turn, or provably or possibly never (web `SETTLED_STEER_DELIVERY`). */
    fun settles(delivery: String?) = delivery == "acknowledged" || delivery == "failed" || delivery == "unconfirmed"

    /** How a steer stands, in every client's words (web `steerDeliveryState`, OrbitKit `SteerDelivery.state(_:)`): nothing has taken it
     * yet, the engine has it, it was read, it was handed back to run as the next turn — or, in the warning tone ([undelivered]), it never
     * reached the engine, or nobody can say the engine read it. */
    fun label(delivery: String?) = when (delivery) {
        "written" -> "Waiting to be read"
        "acknowledged" -> "Read in this turn"
        REQUEUED -> "Queued for next turn instead"
        "failed" -> "Not delivered"
        "unconfirmed" -> "Couldn't confirm it was read"
        else -> "Sending…"
    }

    /** Whether a steer's state is said in the warning tone (web's `failed` tone): it did not land, or nobody can say it did. */
    fun undelivered(delivery: String?) = delivery == "failed" || delivery == "unconfirmed"

    /** Why a steer did not land, in the sender's words rather than the protocol's (web `deliveryFailureExplanation`): what stopped reading
     * it. The server's own [reason] stands in for a [code] these words do not cover. */
    fun failureExplanation(code: String?, reason: String?): String? = when (code) {
        "CURRENT_WORK_TARGET_COMPLETED" -> "The turn finished before it was read."
        "CURRENT_WORK_INTERRUPTED" -> "The turn was interrupted before it was read."
        "CURRENT_WORK_SESSION_ENDED", "CURRENT_WORK_SESSION_FINALIZED" -> "The session ended before it was read."
        "CURRENT_WORK_SESSION_REAPED" -> "The runner disappeared while it was being delivered."
        "CURRENT_WORK_RUNTIME_REJECTED" -> "The engine rejected it."
        else -> reason
    }

    /** Whether to offer taking a steer back: its runner said the engine can drop it unread, and nothing has read, failed or withdrawn
     * it since (OrbitKit `SteerDelivery.offersWithdraw(delivery:withdrawable:)`). */
    fun offersWithdraw(delivery: String?, withdrawable: Boolean) =
        withdrawable && (delivery == null || delivery == "enqueued" || delivery == "written")

    /** Whether this runtime takes a message into a running turn at all, whatever its runner declared (shared
     * `runtimeTakesMidTurnSteer`): Claude and Codex. Kimi, DeepSeek Harness, OpenCode and Antigravity never — a message sent there
     * mid-turn queues. The server still asks the runner, and refuses one too old. */
    fun runtimeTakesMidTurnSteer(runtime: String) = runtime == "claude" || runtime == "codex"

    /** The payload keys a turn carries its Orbit cards under (`TurnCards`), on its echo and its queued row alike. */
    val cardKeys = listOf("openItemDelivery", "ownerAnswer", "taskStart", "projectStarted", "confirmationReviewRequest",
        "confirmationReturn", "sessionMessage", "sessionReplies")

    /** Whether an echo is the reader's own words and nothing else's (OrbitKit `SteerDelivery.isReadersOwn`, web `readersOwnWords`):
     * no card Orbit draws it as — a delivery, a brief, a review's turn, another session's message or its replies — and no wake. */
    fun readersOwn(event: RunEvent): Boolean = cardKeys.none { event.fields[it].let { value -> value != null && value != JsonNull } } &&
        transcriptCards(event).isEmpty() && queuedWake(event.fields.string("text").orEmpty()) == null

    /** Whether an echo is one of the reader's steers: sent into a running turn, and the reader's own words ([readersOwn]). */
    fun readersSteer(event: RunEvent) = event.type == "user" && event.fields["steer"] == JsonPrimitive(true) && readersOwn(event)

    /**
     * The latest word on how each message came out, by its turn: its echo's `delivery`, then each `user_delivery` naming it, in the order
     * they happened (web `Transcript.tsx`'s `delivery` and `deliveryReason`). Where the window holds a turn's echo but no runner's word that
     * it failed or went unconfirmed, the server's durable receipt ([receipts], `GET …/turns?view=active`'s `delivery`) has the last word,
     * as no runner event will come to say so (web `transcriptEventsWithDurableDeliveryReceipts`).
     */
    fun outcomes(events: List<RunEvent>, receipts: List<JsonObject> = emptyList()): Map<String, SteerOutcome> {
        val latest = HashMap<String, SteerOutcome>()
        val echoed = HashSet<String>()
        val told = HashSet<String>()
        events.forEach { event ->
            when (event.type) {
                "user" -> event.turnId?.let(::key)?.let { turn -> echoed += turn; latest[turn] = SteerOutcome(event.fields.string("delivery")) }
                "user_delivery" -> {
                    val turn = (event.fields.string("turnId") ?: event.turnId)?.let(::key) ?: return@forEach
                    val delivery = event.fields.string("delivery") ?: return@forEach
                    latest[turn] = SteerOutcome(delivery, event.fields.string("reason"))
                    if (undelivered(delivery)) told += turn
                }
            }
        }
        receipts.forEach { row ->
            val turn = row.string("turnId")?.let(::key) ?: return@forEach
            val delivery = row.string("delivery")
            if (undelivered(delivery) && turn in echoed && turn !in told) latest[turn] = SteerOutcome(delivery, row.string("deliveryReason"))
        }
        return latest
    }

    /**
     * Where each of the reader's steers is drawn. One nothing has read yet is not drawn at all: it waits in the tray. Once its delivery
     * settles it is drawn at that point — `acknowledged` after the output the engine wrote before reading it, `failed` or `unconfirmed`
     * where that became known, the server's durable receipt ([receipts], `GET …/turns?view=active`'s `delivery`) at the end, where no
     * runner event will come to say so. One the engine dropped unread (`withdrawn`) is never drawn; one handed back (`requeued`) waits
     * as queued until its turn arrives as a message of its own, which is drawn instead. A steer Orbit filed, another session's message
     * and a wake are drawn where their echo lands, as they always were.
     */
    fun place(events: List<RunEvent>, receipts: List<JsonObject> = emptyList()): SteerPlacement {
        class Held(val event: RunEvent, var delivery: String?)
        val held = LinkedHashMap<String, Held>()
        // The echoes not drawn where they were sent, and the one drawn at the delivery that settled it, by that delivery's place.
        val away = HashSet<Long>()
        val settled = HashMap<Int, RunEvent>()
        events.forEachIndexed { index, event ->
            when (event.type) {
                "user" -> {
                    val turn = event.turnId?.let(::key) ?: return@forEachIndexed
                    // A steer still waiting that this turn's echo now speaks for — handed back and arriving as a message of its own,
                    // or sent in again — is drawn as that echo, never as well.
                    held.remove(turn)
                    if (waitsUnread(event)) { held[turn] = Held(event, event.fields.string("delivery")); away += event.seq }
                }
                "user_delivery" -> {
                    val turn = (event.fields.string("turnId") ?: event.turnId)?.let(::key) ?: return@forEachIndexed
                    val waiting = held[turn] ?: return@forEachIndexed
                    val delivery = event.fields.string("delivery") ?: return@forEachIndexed
                    when {
                        delivery == WITHDRAWN -> held.remove(turn)
                        settles(delivery) -> { held.remove(turn); settled[index] = waiting.event }
                        else -> waiting.delivery = delivery
                    }
                }
            }
        }
        if (away.isEmpty()) return SteerPlacement(events, emptyList())
        val late = receipts.mapNotNull { row ->
            if (!settles(row.string("delivery"))) null else row.string("turnId")?.let { held.remove(key(it))?.event }
        }
        val drawn = ArrayList<RunEvent>(events.size)
        events.forEachIndexed { index, event ->
            if (event.type != "user" || event.seq !in away) drawn += event
            settled[index]?.let(drawn::add)
        }
        return SteerPlacement(drawn + late, held.values.map { UnreadSteer(it.event, it.delivery, it.event.fields["withdrawable"] == JsonPrimitive(true)) })
    }

    /** A steer the reader typed, named by its turn, that its echo does not already say was read, lost or withdrawn. */
    private fun waitsUnread(event: RunEvent): Boolean {
        if (event.fields["steer"] != JsonPrimitive(true) || event.turnId == null) return false
        val delivery = event.fields.string("delivery")
        return !settles(delivery) && delivery != WITHDRAWN && readersOwn(event)
    }

    private fun key(turnId: String) = ObjectId.canonical(turnId) ?: turnId
}
