package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.ObjectId
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.*

/** One card's worth of crossings: rows from one project, of one kind, asked while the card was still open (`CrossingCards.batches`). */
data class CrossingBatch(val rows: List<JsonObject>) {
    val first get() = rows.first()
    /** `crossing-batch-` + the first row's id, the same on every client. */
    val id get() = "crossing-batch-" + ProjectCrossings.doorId(first)
    val kind get() = first.text("kind").orEmpty()
    /** Where the card is placed in the conversation. */
    val moment get() = first.text("requestedAt")
    val pending get() = rows.filter { ProjectCrossings.isAnswerable(it.text("state")) }
    val live get() = pending.isNotEmpty()
    val verdict: CrossingCards.Verdict? get() = when {
        live -> null
        rows.all { it.text("state") in setOf("APPROVED", "APPLIED") } -> CrossingCards.Verdict.APPROVED
        rows.all { it.text("state") == "DENIED" } -> CrossingCards.Verdict.REFUSED
        else -> CrossingCards.Verdict.MIXED
    }
    /** The latest answer among the rows. */
    val decidedAt get() = rows.mapNotNull { it.text("decidedAt") }.maxWithOrNull(CrossingCards.byTime)
}

/** A receipt under an answered card: "Decision recorded" ([head]) and who answered and when ([outcome]). */
data class CrossingReceipt(val head: String?, val outcome: String, val verdict: CrossingCards.Verdict) {
    val line get() = listOfNotNull(head, outcome).joinToString(" · ")
}

/**
 * Cross-project requests (moves, filings, dependencies) as a decision card in the conversation that coordinates their target project,
 * the same family as the criteria decision ("Weaken this ruler?": compact card → review → receipt). The rows are the project page's
 * ([ProjectCrossings]); this groups them into cards and words each card. Held to the shared spec of task 34vT0PEhdlq1lILqsg2WG, which
 * the web and iOS cards follow too.
 */
object CrossingCards {
    enum class Verdict { APPROVED, REFUSED, MIXED }
    /** Who answered a batch, as this process knows it. */
    enum class Answerer { HERE, ELSEWHERE }

    const val fromOrbit = "From Orbit — not the requesting agent."
    const val toThisProject = "To this project"
    const val decisionRecorded = "Decision recorded"
    const val approve = "Approve"
    const val refuse = "Refuse"
    const val batchMoveConsequence =
        "Confirming is the move: the tasks join the target project as soon as you answer, and nobody has to send the request again."

    /** ISO instants by time where they parse, as strings where they don't. */
    internal val byTime = Comparator<String> { a, b ->
        val x = runCatching { Instant.parse(a) }.getOrNull(); val y = runCatching { Instant.parse(b) }.getOrNull()
        if (x != null && y != null) x.compareTo(y) else a.compareTo(b)
    }

    /** The rows that ask [projectId], as cards, oldest first: by source project and kind, a row joining the batch before it while that
     * batch was still open when the row was asked (a member unanswered then, or answered after it). */
    fun batches(rows: List<JsonObject>, projectId: String): List<CrossingBatch> {
        val asked = rows.filter { ObjectId.same(it.text("toProjectId"), projectId) || ObjectId.same(it.text("toProjectPublicId"), projectId) }
        return asked.groupBy { (ObjectId.canonical(it.text("fromProjectId").orEmpty()) ?: it.text("fromProjectId")) to it.text("kind") }.values.flatMap { group ->
            val batches = mutableListOf<MutableList<JsonObject>>()
            group.sortedWith(compareBy(byTime) { it.text("requestedAt").orEmpty() }).forEach { row ->
                val at = row.text("requestedAt").orEmpty()
                val open = batches.lastOrNull()?.any { member -> member.text("decidedAt").let { it == null || byTime.compare(it, at) > 0 } } == true
                if (open) batches.last() += row else batches += mutableListOf(row)
            }
            batches.map { CrossingBatch(it) }
        }.sortedWith(compareBy(byTime) { it.moment.orEmpty() })
    }

    private fun many(batch: CrossingBatch) = batch.rows.size != 1

    fun title(batch: CrossingBatch) = when (batch.kind) {
        ProjectCrossings.moveKind -> if (many(batch)) "Move these tasks here?" else "Move this task here?"
        "DEPEND_ON_TASK" -> if (many(batch)) "Allow these dependencies?" else "Allow this dependency?"
        else -> if (many(batch)) "File these tasks here?" else "File this task here?"
    }

    fun badge(batch: CrossingBatch): String = when (batch.verdict) {
        null -> when (batch.kind) { ProjectCrossings.moveKind -> "move"; "DEPEND_ON_TASK" -> "depend"; else -> "file" }
        Verdict.APPROVED -> if (batch.kind == ProjectCrossings.moveKind) "moved" else "approved"
        Verdict.REFUSED -> "refused"
        Verdict.MIXED -> "answered"
    }

    fun noun(batch: CrossingBatch) =
        if (batch.kind == "DEPEND_ON_TASK") (if (many(batch)) "dependencies" else "dependency") else if (many(batch)) "tasks" else "task"

    fun listHead(batch: CrossingBatch) = when (batch.kind) {
        ProjectCrossings.moveKind -> "Tasks to move"
        "DEPEND_ON_TASK" -> "Tasks waited on"
        else -> "Tasks to file"
    }

    fun sourceTitle(batch: CrossingBatch) = batch.first.obj("fromProject")?.text("title")?.takeIf { it.isNotBlank() } ?: ProjectCrossings.unnamedProject

    /** "for criteria 4–11", "for criteria 4, 6, 9", "for criterion 4", or null when no row asks for a criterion. */
    fun criteria(batch: CrossingBatch): String? {
        val keys = batch.rows.mapNotNull { it.obj("requestedCriterion")?.text("key") }.distinct()
        if (keys.isEmpty()) return null
        if (keys.size == 1) return "for criterion ${keys.single()}"
        val numbers = keys.map { it.toIntOrNull() }
        val range = if (numbers.all { it != null }) {
            val sorted = numbers.filterNotNull().sorted()
            if (sorted.zipWithNext().all { (a, b) -> b == a + 1 }) "${sorted.first()}–${sorted.last()}" else sorted.joinToString(", ")
        } else keys.sorted().joinToString(", ")
        return "for criteria $range"
    }

    /** "8 tasks from Runner v1 · for criteria 4–11". */
    fun summary(batch: CrossingBatch) =
        listOfNotNull("${batch.rows.size} ${noun(batch)} from ${sourceTitle(batch)}", criteria(batch)).joinToString(" · ")

    fun link(batch: CrossingBatch) = if (batch.live) CardPreviews.viewDetailsAndAct else CardPreviews.viewDetails

    /** "move · 8 waiting", under the review's title while it asks. */
    fun waitingLine(batch: CrossingBatch) = "${badge(batch)} · ${ProjectCrossings.waiting(batch.pending.size)}"

    /** The subject a row names: a move's or a dependency's task as it reads now, a filing's title. */
    fun subject(row: JsonObject) = if (row.text("kind") == "FILE_TASK") row.text("title").orEmpty() else ProjectCrossings.subjectTitle(row)

    /** The lines under a row's subject: the criteria it asks for and serves now, and where it stands once answered. */
    fun rowNotes(row: JsonObject): List<String> = buildList {
        row.obj("requestedCriterion")?.let { criterion ->
            add("${ProjectCrossings.moveRequestedCriterionLabel}: ${criterion.text("key").orEmpty()}" +
                if (criterion.text("text") == null) " — ${ProjectCrossings.moveCriterionGone}" else "")
        }
        row.obj("withdrawnCriterion")?.let { add("${ProjectCrossings.moveWithdrawnCriterionLabel}: ${it.text("key").orEmpty()}") }
        row.text("state")?.takeUnless(ProjectCrossings::isAnswerable)?.let { add(ProjectCrossings.label(it)) }
    }

    /** "That answer was not recorded CODE", the door's sentence under it. */
    fun refusalHead(refusal: ProjectCrossings.Refusal) = ProjectCrossings.notRecorded + (refusal.code?.let { " $it" } ?: "")

    /** Each distinct reason once, quoted. */
    fun reasons(batch: CrossingBatch) = batch.rows.mapNotNull { it.text("reason")?.trim()?.takeIf(String::isNotEmpty) }.distinct().map { "“$it”" }

    fun consequence(batch: CrossingBatch) = when {
        batch.kind != ProjectCrossings.moveKind -> ProjectCrossings.fileApproveConsequence
        many(batch) -> batchMoveConsequence
        else -> ProjectCrossings.moveApproveConsequence
    }

    /** "Show 5 more" past the first three rows. */
    const val shownRows = 3
    fun showMore(batch: CrossingBatch) = (batch.rows.size - shownRows).takeIf { it > 0 }?.let { "Show $it more" }

    /** "1 answer was not recorded", "3 answers were not recorded". */
    fun notRecorded(count: Int) = if (count == 1) "1 answer was not recorded" else "$count answers were not recorded"

    /** One body per row still waiting, each with its own crossing key: what Approve or Refuse sends. */
    fun requests(batch: CrossingBatch, approve: Boolean) = batch.pending.map { ProjectCrossings.doorId(it) to ProjectCrossings.request(it, approve) }

    /** Who answered: this process when it pressed; another end when it saw the batch waiting and did not press; otherwise the owner,
     * who alone can answer — read back as history. */
    fun answerer(seenLive: Boolean, pressed: Boolean) = if (seenLive && !pressed) Answerer.ELSEWHERE else Answerer.HERE

    /** The receipt under an answered card, or null while it still asks. The time is the batch's latest answer, the press's otherwise. */
    fun receipt(batch: CrossingBatch, answerer: Answerer, pressedAt: Instant? = null, now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault()): CrossingReceipt? {
        val verdict = batch.verdict ?: return null
        val verb = when (verdict) { Verdict.APPROVED -> "Approved"; Verdict.REFUSED -> "Refused"; Verdict.MIXED -> "Answered" }
        if (answerer == Answerer.ELSEWHERE) return CrossingReceipt(null, "$verb at another end", verdict)
        val time = listOfNotNull(batch.decidedAt, pressedAt?.toString()).firstNotNullOfOrNull { OwnerReview.receiptTime(it, now, zone) }
        return CrossingReceipt(decisionRecorded, "✓ $verb by you" + (time?.let { " at $it" } ?: ""), verdict)
    }

    /** Where each card goes in a conversation, as its owner requests do (`OwnerRequests.place`): after the last row stamped at or before
     * the batch's moment, or -1 ahead of every row. */
    fun place(rowTimes: List<String?>, batches: List<CrossingBatch>): Map<Int, List<CrossingBatch>> {
        val times = rowTimes.map { it?.let { t -> runCatching { Instant.parse(t) }.getOrNull() } }
        return batches.mapNotNull { batch ->
            val at = batch.moment?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return@mapNotNull null
            times.indexOfLast { it != null && !it.isAfter(at) } to batch
        }.groupBy({ it.first }, { it.second })
    }
}
