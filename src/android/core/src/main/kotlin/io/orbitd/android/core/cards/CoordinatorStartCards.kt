package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

// The three cards a coordinator conversation draws after a project starts (board docs/mocks/ios-project-page-and-coordinator-cards/
// board-4): the criteria decision's receipt, the receipt the start left, and Project started. Every word is OrbitKit's
// (`CriteriaDecisions`, `AcceptanceConfirmations`, `ProjectStartedCard`), which is web's; the shared fixtures
// criteria-decision-receipt.fixture.json and coordinator-start-cards.fixture.json hold the three clients to the same cases.

/** One run of a criterion's words: what stayed, what the change dropped (struck through) and what it brought (underlined). */
data class CriterionRun(val side: Side, val text: String) {
    enum class Side { KEPT, REMOVED, ADDED }
}

/**
 * The receipt an answered criteria proposal leaves (OrbitKit `CriteriaDecisionReceiptCard`, web `CriteriaDecisionReceipt`): orange like
 * the question it answers (decision D1 A), the verdict and its check mark green, and under it, folded, what the answer was about.
 */
object CriteriaReceipt {
    const val heading = "Decision recorded"
    const val provenance = "From Orbit"
    const val approvedLead = "What this approved"
    const val refusedLead = "What this refused"
    const val unchangedOne = "criterion unchanged"
    const val unchangedMany = "criteria unchanged"
    const val noBeforeWords = "This is the proposal’s own wording. The words it replaced were never stored, so what is here is one side of " +
        "the change and not a before-and-after."
    const val nothingApplied = "None of this was applied — the criteria on record stayed exactly as they were."
    const val droppedWordsGone = "its words are not on record"
    const val legend = "struck through is dropped · underlined is added"
    const val methodLabel = "how it is judged"
    const val rewordedWord = "reworded"
    const val droppedWord = "dropped"
    const val addedWord = "added"
    const val rewordedLabel = "reworded by this proposal"
    const val addedLabel = "new in this proposal"
    const val droppedLabel = "dropped by this proposal"
    private const val nothingMoves = "nothing moves"

    /** The tones it is drawn in: the frame and head in the warning tone, the verdict in the success tone. */
    enum class Tone { WARNING, SUCCESS }
    val tone = Tone.WARNING
    val verdictTone = Tone.SUCCESS

    /** "✓ Approved by you at 11/19 23:45" (OrbitKit `receiptLine`): the date before the clock when it is not today (D4 A). */
    fun line(settled: JsonObject, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val verdict = if (settled.text("decision") == "APPROVE") "Approved" else "Refused"
        val at = settled.text("decidedAt").orEmpty()
        return "✓ $verdict by you at ${OwnerReview.receiptTime(at, now, zone, locale) ?: at}"
    }

    /** One criterion the fold lists: the server's ordinal (none on a dropped one), its words, its badge, and its procedure where that moved. */
    data class Row(val ordinal: Int?, val words: List<CriterionRun>, val badge: String, val method: List<CriterionRun>? = null) {
        val text: String get() = words.joinToString("") { it.text }
    }

    /** The fold "What this approved · …": its closed line, the legend where a row is struck through, the moved rows, the untouched ones
     * behind their own fold (a stored diff only), and the quiet note under them. */
    data class Fold(val summary: String, val legend: String?, val rows: List<Row>, val unchangedLine: String?, val unchanged: List<Row>,
        val note: String?)

    private fun lead(settled: JsonObject) = if (settled.text("decision") == "APPROVE") approvedLead else refusedLead

    private fun changeWord(change: String?) = when (change) { "REWORDED" -> rewordedWord; "ADDED" -> addedWord; else -> droppedWord }

    /** The proposal's closed line when the record kept no diff (web `settledSummary`). */
    fun summary(settled: JsonObject): String {
        val lead = lead(settled)
        val proposal = settled.obj("proposal") ?: return lead
        val counts = listOfNotNull(
            proposal.number("rewordedCount")?.takeIf { it > 0 }?.let { "$it $rewordedWord" },
            proposal.number("droppedCount")?.takeIf { it > 0 }?.let { "$it $droppedWord" },
            proposal.number("addedCount")?.takeIf { it > 0 }?.let { "$it $addedWord" },
        )
        val changed = proposal.objects("changed")
        val only = changed.singleOrNull()
        val moved = if (only != null && only.number("ordinal") != null) "criterion ${only.number("ordinal")} ${changeWord(only.text("change"))}"
            else counts.ifEmpty { listOf(nothingMoves) }.joinToString(", ")
        val unchanged = proposal.number("unchangedCount") ?: 0
        return "$lead · $moved · $unchanged ${if (unchanged == 1) unchangedOne else unchangedMany}"
    }

    /** The fold, or null where the record says nothing of what was answered — an empty fold promises something behind it. */
    fun fold(settled: JsonObject): Fold? {
        val stored = settled.obj("diff")
        val diff = stored?.takeIf { it.text("state") == "SNAPSHOT" }?.obj("diff")
        if (diff != null) {
            val entries = diff.objects("entries")
            val rows = entries.filter { it.text("change") != "SAME" }.map { entry ->
                val change = entry.text("change")
                val fields = entry.strings("changed")
                val plain = (entry.obj("proposed") ?: entry.obj("onRecord"))?.text("text").orEmpty()
                Row(entry.number("ordinal"),
                    if (change == "CHANGED" && "text" in fields) runs(entry, "text") else listOf(CriterionRun(CriterionRun.Side.KEPT, plain)),
                    when (change) { "CHANGED" -> rewordedLabel; "NEW" -> addedLabel; "REMOVED" -> droppedLabel; else -> "" },
                    if ("verificationMethod" in fields) runs(entry, "verificationMethod") else null)
            }
            val same = entries.filter { it.text("change") == "SAME" }.map {
                Row(it.number("ordinal"), listOf(CriterionRun(CriterionRun.Side.KEPT, it.obj("proposed")?.text("text").orEmpty())), "")
            }
            return Fold("${lead(settled)} · ${CardPreviews.changeSummary(diff)}",
                legend.takeIf { entries.any { it.text("change") == "CHANGED" } }, rows,
                same.takeIf { it.isNotEmpty() }?.let { unchangedLine(it.size) }, same,
                nothingApplied.takeIf { settled.text("decision") != "APPROVE" })
        }
        val proposal = settled.obj("proposal") ?: return null
        val changed = proposal.objects("changed")
        val placed = changed.filter { it.number("ordinal") != null }.map {
            Row(it.number("ordinal"), listOf(CriterionRun(CriterionRun.Side.KEPT, it.text("text").orEmpty())), changeWord(it.text("change")))
        }
        val dropped = changed.filter { it.number("ordinal") == null }.map {
            Row(null, listOf(CriterionRun(CriterionRun.Side.KEPT, droppedWordsGone)), changeWord(it.text("change")))
        }
        return Fold(summary(settled), null, placed + dropped, null, emptyList(),
            (if (settled.text("decision") != "APPROVE") "$nothingApplied " else "") + noBeforeWords)
    }

    /** "2 criteria are unchanged by this proposal" (OrbitKit `unchangedLine`). */
    fun unchangedLine(count: Int) = "$count ${if (count == 1) "criterion is unchanged by this proposal" else "criteria are unchanged by this proposal"}"

    /** The server's cut of one rewritten field, or — from a server older than the cut — both versions whole (OrbitKit `rewriteRuns`). */
    private fun runs(entry: JsonObject, field: String): List<CriterionRun> {
        entry.objects("rewrites").firstOrNull { it.text("field") == field }?.objects("segments")?.takeIf { it.isNotEmpty() }?.let { cut ->
            return cut.map { CriterionRun(when (it.text("side")) {
                "REMOVED" -> CriterionRun.Side.REMOVED; "ADDED" -> CriterionRun.Side.ADDED; else -> CriterionRun.Side.KEPT }, it.text("text").orEmpty()) }
        }
        val was = entry.obj("onRecord")?.text(field).orEmpty()
        val now = entry.obj("proposed")?.text(field).orEmpty()
        return listOfNotNull(was.takeIf { it.isNotEmpty() }?.let { CriterionRun(CriterionRun.Side.REMOVED, it) },
            now.takeIf { it.isNotEmpty() }?.let { CriterionRun(CriterionRun.Side.ADDED, it) })
    }
}

/**
 * The record a confirmation of the project's criteria leaves (OrbitKit `AcceptanceConfirmationReceiptCard`, web
 * `AcceptanceConfirmationReceipt`): blue, a green tick, what it was — "You started the project on 5 criteria", or what a later
 * confirmation confirmed — the settings a start was pressed with, who and when, and the fold of what was confirmed.
 */
object StartReceipt {
    const val heading = "Decision recorded"

    /** The record the acceptance read publishes (`acceptanceConfirmation.confirmation`), or null. */
    fun of(standing: JsonObject?): JsonObject? = standing?.obj("confirmation")?.takeIf { it.text("confirmedAt") != null && it.text("criteriaDigest") != null }

    fun count(confirmation: JsonObject) = confirmation.objects("criteriaMaterial").size

    /** A start says it started the project; any other confirmation says what it confirmed (OrbitKit `receiptLine`). */
    fun line(confirmation: JsonObject): String =
        if (confirmation.obj("startedWith") != null) CardPreviews.startedLine(count(confirmation))
        else CardPreviews.reconfirmedLine(count(confirmation), confirmation.obj("changes"))

    /** "by you at 11/16 23:45"; "by you" where the moment cannot be read (OrbitKit `receiptStamp`). */
    fun stamp(time: String?) = if (time == null) "by you" else "by you at $time"

    fun stamp(confirmation: JsonObject, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()) =
        stamp(confirmation.text("confirmedAt")?.let { OwnerReview.receiptTime(it, now, zone, locale) })

    /** What a start was pressed with, as it recorded it, and which of those settings were not the coordinator's suggestion. */
    fun startedSettings(confirmation: JsonObject): JsonObject? = confirmation.obj("startedWith")?.obj("settings")
    fun startedDiffers(confirmation: JsonObject): List<String> = confirmation.obj("startedWith")?.strings("differsFromRequest").orEmpty()

    /** The fold: what this confirmed, numbered, with its note and seal (`CardPreviews.receipt`). */
    fun fold(confirmation: JsonObject): AcceptanceReceipt? = CardPreviews.receipt(confirmation, count(confirmation), confirmation.text("criteriaDigest"))
}

/** An open task nothing starts but the coordinator. */
data class ProjectStartedTask(val id: String, val title: String)

/** One project start, as the control plane recorded it beside the turn (`projectStarted`; OrbitKit `ProjectStarted`, web
 * `parseProjectStarted`). A payload that is not a card parses as nothing. */
data class ProjectStarted(val by: String, val projectId: String, val projectTitle: String, val criteriaCount: Int?,
    val held: List<ProjectStartedTask>, val heldCount: Int, val settings: JsonObject?, val differsFromRequest: List<String>) {
    companion object {
        private val settingKeys = listOf("line", "automatic", "maxConcurrentTasks", "mergeCheckCommand")

        fun parse(card: JsonObject?): ProjectStarted? {
            card ?: return null
            val by = card.text("by")?.takeIf { it == "CONFIRMATION" || it == "SWITCH" } ?: return null
            val projectId = card.text("projectId")?.takeIf { it.isNotEmpty() } ?: return null
            val title = (card["projectTitle"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            val held = card.objects("held").mapNotNull { row ->
                val id = row.text("id")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                ProjectStartedTask(id, row.text("title") ?: return@mapNotNull null)
            }
            val settings = card.obj("settings")?.takeIf(::readable)
            return ProjectStarted(by, projectId, title, count(card["criteriaCount"]), held,
                maxOf(count(card["heldCount"]) ?: 0, held.size), settings,
                if (settings == null) emptyList() else settingKeys.filter { it in card.strings("differsFromRequest") })
        }

        /** Settings this build can read, or none: drawn whole or not at all. */
        private fun readable(s: JsonObject) = s.text("line") in setOf("PROJECT_BRANCH", "MAIN") &&
            (s["automatic"] as? JsonPrimitive)?.booleanOrNull != null && count(s["maxConcurrentTasks"]) != null &&
            (s["mergeCheckCommand"].let { it == null || it is JsonNull || (it as? JsonPrimitive)?.isString == true })

        private fun count(value: JsonElement?) = (value as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it >= 0 }
    }
}

/** What the Project started card says (OrbitKit `ProjectStartedCard`, web `ProjectStartedCard.tsx`). */
object ProjectStartedCopy {
    const val tasksShown = 3
    const val startedLabel = "Project started"
    const val switchedOnLabel = "Project switched on"
    const val kindConfirmation = "Criteria confirmed"
    const val kindSwitch = "Automatic on"
    const val noneHeld = "Every open task starts on its own."
    const val notification = "a notification, not an interruption"
    const val undelivered = "The session has not confirmed it received this."
    const val told = "What the coordinator was told"
    const val showFewer = "Show fewer"

    fun label(by: String) = if (by == "CONFIRMATION") startedLabel else switchedOnLabel
    fun kind(by: String) = if (by == "CONFIRMATION") kindConfirmation else kindSwitch
    fun heldLead(count: Int) = if (count == 1) "1 task is set to start by hand, so it waits for the coordinator:"
        else "$count tasks are set to start by hand, so they wait for the coordinator:"
    fun lead(card: ProjectStarted) = if (card.heldCount == 0) noneHeld else heldLead(card.heldCount)
    fun startedBy(card: ProjectStarted): String = when {
        card.by == "SWITCH" -> "Switched on by you"
        card.criteriaCount == null -> "Started by you"
        card.criteriaCount == 1 -> "Started by you, confirming 1 criterion"
        else -> "Started by you, confirming ${card.criteriaCount} criteria"
    }
    fun showMore(count: Int) = "Show $count more"
    fun moreInProject(count: Int) = "$count more in the project ↗"
    fun tasksToggle(card: ProjectStarted, expanded: Boolean): String? =
        if (card.held.size <= tasksShown) null else if (expanded) showFewer else showMore(card.held.size - tasksShown)
    /** The tasks the message did not list, which only the project page names. */
    fun unlisted(card: ProjectStarted) = card.heldCount - card.held.size
    /** "Started by you, confirming 5 criteria · a notification, not an interruption · 3m ago". */
    fun meta(card: ProjectStarted, relative: String? = null) = listOfNotNull(startedBy(card), notification, relative).joinToString(" · ")
}
