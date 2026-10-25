package io.orbitd.android.core.cards

import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The owner's answer handed to the coordinator (`ownerAnswer`, apiserver `readOwnerAnswerCard`): its words are written for the agent —
 * `From Orbit · owner answer: you asked "…"`, the question replayed and the answer with its ISO moment — so it is drawn as one line,
 * "Sent to the coordinator · 08:29", that opens to those words, instead of the owner's own bubble (web `OwnerAnswerLine.tsx`, OrbitKit
 * `OwnerAnswer.swift`). The same four fields make a card on every client; a payload that is not one is no card, and the turn keeps its
 * old reading.
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
}
