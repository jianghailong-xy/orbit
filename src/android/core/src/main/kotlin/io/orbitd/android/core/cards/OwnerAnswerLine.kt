package io.orbitd.android.core.cards

import io.orbitd.android.core.realtime.RunEvent
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The owner's answer handed to the coordinator (`ownerAnswer`, apiserver `readOwnerAnswerCard`): its words are written for the agent —
 * `From Orbit · owner answer: you asked "…"`, the question replayed and the answer with its ISO moment — so it is never the owner's own
 * bubble (web `OwnerAnswerLine.tsx`, OrbitKit `OwnerAnswer.swift`). Where the conversation holds the ended question it answers
 * ([question]), the turn is that question's own card, Answered (docs/mocks/owner-answer-sent-card/merged.html); otherwise it is one
 * line, "Sent to the coordinator · 08:29", that opens to those words. The same four fields make a card on every client; a payload that
 * is not one is no card, and the turn keeps its old reading.
 */
object OwnerAnswerLine {
    /** The heading over the words the coordinator was handed, once the line is opened. */
    const val told = "What the coordinator was told"
    /** What the line says when the session has not confirmed it received the answer. */
    const val undelivered = "The session has not confirmed it received this."
    private val kinds = setOf("COORDINATOR_QUESTION", "DONE_REQUEST")

    /** The item, what it was, the conversation and when it was told, each a string — and the moment has to read as one. */
    fun isCard(card: JsonObject): Boolean {
        fun string(key: String) = (card[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        return listOf("itemId", "sessionId", "deliveredAt").none { string(it).isNullOrEmpty() } && string("kind") in kinds &&
            runCatching { Instant.parse(string("deliveredAt")) }.isSuccess
    }

    /** "Sent to the coordinator · 08:29": the line a revision handed to its coordinator leaves, on the receipts' clock. */
    fun line(card: JsonObject, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
        CoordinatorQueue.sentLine(card.text("deliveredAt")?.let { OwnerReview.receiptTime(it, now, zone) })

    /** The question [card] hands over the answer to, by its item. A Not yet… to a request to record the project done has no question
     * card to be, and names none (web `answersHandedOver`). */
    fun question(card: JsonObject): String? = card.text("itemId").takeIf { card.text("kind") == "COORDINATOR_QUESTION" }

    /** The question a turn hands its coordinator the owner's answer to: only a user turn carrying a whole card names one. */
    fun question(event: RunEvent): String? =
        event.fields.obj("ownerAnswer")?.takeIf { event.type == "user" && isCard(it) }?.let(::question)
}
