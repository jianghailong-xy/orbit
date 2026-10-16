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

/** What a message sent into a running turn has come to, and where it is drawn meanwhile (OrbitKit `SteerDelivery`). */
internal object SteerDelivery {
    /** The runner's word that the engine dropped a steer unread at its sender's request: nothing will ever read it. */
    const val WITHDRAWN = "withdrawn"
    /** It missed the turn it was aimed at and was handed back to run as the next one. */
    const val REQUEUED = "requeued"

    /** Whether this delivery ends a steer's wait: read into the turn, or provably or possibly never (web `SETTLED_STEER_DELIVERY`). */
    fun settles(delivery: String?) = delivery == "acknowledged" || delivery == "failed" || delivery == "unconfirmed"

    /** How a steer on its way into the turn stands, in every client's words: the engine has it, or nothing has taken it yet. */
    fun label(delivery: String?) = if (delivery == "written") "Waiting to be read" else "Sending…"

    /** Whether to offer taking a steer back: its runner said the engine can drop it unread, and nothing has read, failed or withdrawn
     * it since (OrbitKit `SteerDelivery.offersWithdraw(delivery:withdrawable:)`). */
    fun offersWithdraw(delivery: String?, withdrawable: Boolean) =
        withdrawable && (delivery == null || delivery == "enqueued" || delivery == "written")

    /** Whether this runtime takes a message into a running turn at all, whatever its runner declared (shared
     * `runtimeTakesMidTurnSteer`): Claude and Codex. Kimi, DeepSeek Harness, OpenCode and Antigravity never — a message sent there
     * mid-turn queues. The server still asks the runner, and refuses one too old. */
    fun runtimeTakesMidTurnSteer(runtime: String) = runtime == "claude" || runtime == "codex"

    /** The payload keys a turn carries its Orbit cards under (`TurnCards`), on its echo and its queued row alike. */
    val cardKeys = listOf("openItemDelivery", "taskStart", "projectStarted", "confirmationReviewRequest", "confirmationReturn",
        "sessionMessage", "sessionReplies")

    /** Whether an echo is the reader's own words and nothing else's (OrbitKit `SteerDelivery.isReadersOwn`, web `readersOwnWords`):
     * no card Orbit draws it as — a delivery, a brief, a review's turn, another session's message or its replies — and no wake. */
    fun readersOwn(event: RunEvent): Boolean = cardKeys.none { event.fields[it].let { value -> value != null && value != JsonNull } } &&
        transcriptCards(event).isEmpty() && queuedWake(event.fields.string("text").orEmpty()) == null

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
