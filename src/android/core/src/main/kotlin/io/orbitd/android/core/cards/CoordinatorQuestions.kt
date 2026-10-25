package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId

/**
 * What a coordinator's question becomes once it has ended — answered, here or at another end, or withdrawn (A08-13; OrbitKit
 * `CoordinatorQuestions`, contract §5.2 R10, R12). The open-items read carries each as a record (`closedQuestions`, newest first):
 * the question as it was asked, every option, what the owner chose and wrote, and where the answer went. The conversation draws it
 * where its question card was, under the same address, as a record that asks nothing: the card says what was asked and how it ended,
 * and its review replays the question with the answer ticked. An answer pressed here is drawn from what was sent until the read has
 * it. The words are iOS's (`CoordinatorQuestionsTest` reads OrbitKit's source).
 */
object CoordinatorQuestions {
    const val answeredHeading = "Answered"
    const val withdrawnHeading = "Withdrawn"
    const val provenance = "FROM COORDINATOR"
    const val recommended = "Recommended"
    const val deliveredToCoordinator = "Delivered to the current coordinator"
    const val waitingForCoordinator = "Waiting for this project’s next coordinator"
    const val freeAnswerPrompt = "Your answer"
    const val otherOption = "Other — say it in my own words"
    const val answeredByYou = "Answered by you"
    const val withdrawnByCoordinator = "Withdrawn by the coordinator"
    const val withdrawnByYou = "Withdrawn by you"
    const val coordinatorWithdrew = "The coordinator withdrew it"
    const val youWithdrew = "You withdrew it"
    const val yourNote = "Your note"
    const val viewDetails = "View details"

    /** Whether a closed question is one this build can draw: an address, the question asked, and when and how it ended. */
    fun readable(record: JsonObject): Boolean = record.text("itemId") != null && record.obj("question")?.text("question") != null &&
        record.text("resolvedAt") != null && record.text("resolution") in setOf("ANSWERED", "WITHDRAWN")

    /**
     * The records a conversation draws, oldest first by the moment each ended — the read is newest first, and two answered seconds
     * apart read top-down in the order they were answered — with [answered], the answers pressed here, standing in for any the read
     * does not carry yet. A record the read does carry is the read's.
     */
    fun receipts(items: JsonObject?, answered: Map<String, JsonObject> = emptyMap()): List<JsonObject> {
        val read = items?.objects("closedQuestions").orEmpty().filter(::readable)
        val known = read.mapNotNull { it.text("itemId") }.toSet()
        val local = answered.filterKeys { it !in known }.values.filter(::readable)
        return (read.reversed() + local).withIndex()
            .sortedWith(compareBy<IndexedValue<JsonObject>, Instant?>(nullsLast()) { parse(it.value.text("resolvedAt")) }.thenBy { it.index })
            .map { it.value }
    }

    /** The answer this device just sent, as the record the read will publish: the question it answered, what was chosen and written,
     * and where the door says it went. */
    fun answeredHere(row: JsonObject, option: Int?, text: String?, response: JsonObject?, at: Instant = Instant.now()): JsonObject = buildJsonObject {
        val moment = at.toString()
        put("itemId", row.text("itemId"))
        row.obj("question")?.let { put("question", it) }
        put("askedAt", row.text("waitingSince"))
        put("resolution", "ANSWERED"); put("resolvedBy", "USER"); put("resolvedAt", moment)
        putJsonObject("answer") {
            put("option", option?.let(::JsonPrimitive) ?: JsonNull)
            put("text", text?.trim()?.takeIf { it.isNotEmpty() }?.let(::JsonPrimitive) ?: JsonNull)
        }
        val delivered = response?.obj("delivery")?.text("sessionId")
        put("delivery", if (delivered == null) JsonNull else buildJsonObject { put("sessionId", delivered); put("at", moment) })
        put("withdrawReason", JsonNull)
    }

    fun withdrawn(record: JsonObject) = record.text("resolution") == "WITHDRAWN"

    fun recordHeading(record: JsonObject) = if (withdrawn(record)) withdrawnHeading else answeredHeading

    /** The question's opening as one run of plain text — the Markdown's marks gone, its lines joined — which the card cuts at two. */
    fun lead(question: JsonObject?): String = CardPreviews.plainText(question?.text("question"))
        .replace(Regex("(?m)^[ \\t]*(?:•|[0-9]{1,9}[.)])[ \\t]+"), "")
        .replace(Regex("\\s+"), " ").trim()

    private fun options(record: JsonObject) = record.obj("question")?.objects("options").orEmpty()

    /** The option the owner chose, when it is one the question offered. */
    fun chosenOption(record: JsonObject): Int? = record.obj("answer")?.number("option")?.takeIf { it in options(record).indices }

    /** What the owner wrote, trimmed; null when they wrote nothing. */
    private fun words(record: JsonObject): String? = record.obj("answer")?.text("text")?.trim()?.takeIf { it.isNotEmpty() }

    /** The card's answer line: the chosen option's label, or the owner's own words in quotes; null when withdrawn. */
    fun answerLine(record: JsonObject): String? {
        if (withdrawn(record)) return null
        chosenOption(record)?.let { return options(record)[it].text("label").orEmpty() }
        return words(record)?.let { "“$it”" }
    }

    /** The note under the answer line, in quotes: what the owner wrote beside the option they chose. */
    fun noteLine(record: JsonObject): String? =
        if (withdrawn(record) || chosenOption(record) == null) null else words(record)?.let { "“$it”" }

    /** The orange line an answer carries while no coordinator has had it. */
    fun waitingLine(record: JsonObject): String? =
        if (withdrawn(record) || record.obj("delivery") != null) null else waitingForCoordinator

    /** Who took a withdrawn question back. */
    fun withdrewLine(record: JsonObject): String? =
        if (!withdrawn(record)) null else if (record.text("resolvedBy") == "USER") youWithdrew else coordinatorWithdrew

    /** The reason it was withdrawn with, in quotes. */
    fun withdrawReasonLine(record: JsonObject): String? =
        if (!withdrawn(record)) null else record.text("withdrawReason")?.trim()?.takeIf { it.isNotEmpty() }?.let { "“$it”" }

    /** When it ended: the clock on the day, the date as well after (the receipts' rule). */
    fun time(record: JsonObject, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? =
        record.text("resolvedAt")?.let { OwnerReview.receiptTime(it, now, zone) }

    /** The sheet's line beside FROM COORDINATOR: "asked 08:10". */
    fun askedAtLine(record: JsonObject, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? =
        record.text("askedAt")?.let { OwnerReview.receiptTime(it, now, zone) }?.let { "asked $it" }

    /** Whether the sheet ticks the Other row: words alone, on a question that offered options. */
    fun choseOther(record: JsonObject): Boolean =
        !withdrawn(record) && options(record).isNotEmpty() && chosenOption(record) == null && words(record) != null

    /** The note the sheet puts inside the chosen option, under "Your note". */
    fun note(record: JsonObject): String? = if (chosenOption(record) != null && !withdrawn(record)) words(record) else null

    /** The words under the ticked Other row, or in the read-only "Your answer" box of a question asked without options. */
    fun ownWords(record: JsonObject): String? = if (chosenOption(record) == null && !withdrawn(record)) words(record) else null

    /** The sheet footer's first line, where Send answer was: who ended it, and when. */
    fun footerLine(record: JsonObject, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val who = if (!withdrawn(record)) answeredByYou else if (record.text("resolvedBy") == "USER") withdrawnByYou else withdrawnByCoordinator
        return time(record, now, zone)?.let { "$who · $it" } ?: who
    }

    /** The footer's second line: where the answer went, or the reason it was withdrawn with. */
    fun footerDetail(record: JsonObject): String? =
        if (withdrawn(record)) withdrawReasonLine(record) else if (record.obj("delivery") != null) deliveredToCoordinator else waitingForCoordinator

    private fun parse(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }
}
