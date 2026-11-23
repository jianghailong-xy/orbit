package io.orbitd.android.core.cards

import java.time.Instant
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Records belong to the conversation in which they happened; open work crosses the handoff. */
object CoordinatorCleanStart {
    sealed interface Placement {
        data object Hidden : Placement
        data object Head : Placement
        data class After(val index: Int) : Placement
    }
    data class Counts(val decisions: Int, val merges: Int)

    private fun parse(value: String?) = value?.let { runCatching { Instant.parse(it) }.getOrNull() }

    fun drawn(createdAt: String?, stamp: String?): Boolean {
        val moment = parse(stamp) ?: return false
        return parse(createdAt)?.let { moment >= it } ?: true
    }

    fun place(createdAt: String?, rowTimes: List<String?>, stamp: String): Placement {
        if (!drawn(createdAt, stamp)) return Placement.Hidden
        val moment = parse(stamp)!!
        val index = rowTimes.indexOfLast { parse(it)?.let { row -> row <= moment } == true }
        return if (index < 0) Placement.Head else Placement.After(index)
    }

    fun counts(createdAt: String?, decisionStamps: List<String?>, mergeStamps: List<String?>): Counts {
        val start = parse(createdAt) ?: return Counts(0, 0)
        fun before(stamps: List<String?>) = stamps.count { parse(it)?.let { at -> at < start } == true }
        return Counts(before(decisionStamps), before(mergeStamps))
    }

    fun historyBefore(decisions: Int, merges: Int): String? = if (decisions == 0 && merges == 0) null else
        "$decisions ${if (decisions == 1) "decision" else "decisions"} and $merges ${if (merges == 1) "merge" else "merges"} before this conversation"
    const val openPrevious = "Open previous coordinator"

    fun drawsRecord(createdAt: String?, stamp: String?): Boolean = parse(createdAt) == null || drawn(createdAt, stamp)

    /** An unknown session creation time preserves the existing rail, including retained cards. */
    fun drawsCard(createdAt: String?, card: InteractionCard): Boolean {
        if (parse(createdAt) == null) return true
        val stamp = when {
            card.family == CardFamily.QUESTION_RECORD -> card.source.text("resolvedAt")
            card.key.startsWith("receipt:") && card.family in setOf(CardFamily.CRITERIA_CHANGE, CardFamily.EVIDENCE) -> card.source.text("decidedAt")
            card.key.startsWith("receipt:") && card.family == CardFamily.ACCEPTANCE -> card.source.text("confirmedAt")
            card.family == CardFamily.ACCEPTANCE && card.source.text("state") == "CONFIRMED" -> card.source.obj("confirmation")?.text("confirmedAt")
            card.family == CardFamily.PROMOTION && PromotionCards.stage(card.source) == PromotionStage.BLOCKED -> card.source.text("decidedAt")
            else -> return true
        }
        return drawn(createdAt, stamp)
    }

    fun history(createdAt: String?, standing: Map<String, JsonElement>, merged: List<JsonObject>): Counts {
        val decisions = CoordinatorQuestions.receipts(standing["openItems"] as? JsonObject).map { it.text("resolvedAt") } +
            (standing["criteriaDecisions"] as? JsonObject)?.objects("settled").orEmpty().map { it.text("decidedAt") } +
            (standing["evidenceDecisions"] as? JsonObject)?.objects("decided").orEmpty().map { it.text("decidedAt") } +
            listOf((standing["acceptanceConfirmation"] as? JsonObject)?.obj("confirmation")?.text("confirmedAt"))
        return counts(createdAt, decisions, PromotionCards.receipts(merged).map { it.moment })
    }
}
