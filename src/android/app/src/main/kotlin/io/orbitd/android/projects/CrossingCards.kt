package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.ObjectId
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.*

/** One card's worth of crossings: rows from one project, of one kind, asked while the card was still open (`CrossingCards.batches`).
 * [inTarget] is false in the session that ASKED for a move batch (`CrossingCards.batch(read)`): there "here" is not the project the
 * tasks go into, and the copy names it instead. */
data class CrossingBatch(val rows: List<JsonObject>, val inTarget: Boolean = true) {
    val first get() = rows.first()
    /** `crossing-batch-` + the first row's id, the same on every client. */
    val id get() = "crossing-batch-" + ProjectCrossings.doorId(first)
    val kind get() = first.text("kind").orEmpty()
    /** Where the card is placed in the conversation. */
    val moment get() = first.text("requestedAt")
    /** A move with no target takes its tasks out of their project; the session read is the only one that serves it. */
    val out get() = kind == ProjectCrossings.moveKind && ProjectCrossings.hasNoTarget(first)
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

    /** Who wrote the card, not where the tasks come from: the From/To lines under it say that. */
    const val fromOrbit = "Written by Orbit — not the requesting agent."
    const val toThisProject = "To this project"
    const val decisionRecorded = "Decision recorded"
    const val approve = "Approve"
    const val refuse = "Refuse"
    const val batchMoveConsequence =
        "Confirming is the move: the tasks join the target project as soon as you answer, and nobody has to send the request again."
    /** [ProjectCrossings.moveOutApproveConsequence], said of more than one task. */
    const val batchMoveOutConsequence =
        "Confirming takes the tasks out of this project as soon as you answer; no project's acceptance counts them any more."

    /** ISO instants by time where they parse, as strings where they don't. */
    internal val byTime = Comparator<String> { a, b ->
        val x = runCatching { Instant.parse(a) }.getOrNull(); val y = runCatching { Instant.parse(b) }.getOrNull()
        if (x != null && y != null) x.compareTo(y) else a.compareTo(b)
    }

    /** The rows that ask [projectId], as cards, oldest first: by source project and kind, a row joining the batch before it while that
     * batch was still open when the row was asked (a member unanswered then, or answered after it). */
    fun batches(rows: List<JsonObject>, projectId: String): List<CrossingBatch> {
        val asked = rows.filter { ObjectId.same(it.text("toProjectId"), projectId) || ObjectId.same(it.text("toProjectPublicId"), projectId) }
        // A move batch is answered through the session's batch door, which takes one asker's moves out of one project into another:
        // grouping moves by asker as well keeps one card one answer (iOS `CrossingBatches.batches`).
        return asked.groupBy { Triple(ObjectId.canonical(it.text("fromProjectId").orEmpty()) ?: it.text("fromProjectId"), it.text("kind"), asker(it)) }.values.flatMap { group ->
            val batches = mutableListOf<MutableList<JsonObject>>()
            group.sortedWith(compareBy(byTime) { it.text("requestedAt").orEmpty() }).forEach { row ->
                val at = row.text("requestedAt").orEmpty()
                val open = batches.lastOrNull()?.any { member -> member.text("decidedAt").let { it == null || byTime.compare(it, at) > 0 } } == true
                if (open) batches.last() += row else batches += mutableListOf(row)
            }
            batches.map { CrossingBatch(it) }
        }.sortedWith(compareBy(byTime) { it.moment.orEmpty() })
    }

    /** Who asked a move, as one id however it is spelled; null for every other kind. */
    private fun asker(row: JsonObject): String? = if (row.text("kind") != ProjectCrossings.moveKind) null else
        (row.obj("requestedBySession")?.text("id") ?: row.text("requestedBySessionId"))?.let { ObjectId.canonical(it) ?: it }

    /** The same card for a batch a session is served directly (`GET /sessions/:id/task-moves`): the moves it asked for, or the moves
     * into a project it coordinates. Its id is the first row's door, as the project read spells the same batch, so a session at both
     * ends draws ONE card. Null for a read with no moves, and for anything that is not a move (iOS `CrossingBatches.batch(from:)`). */
    fun batch(read: JsonObject): CrossingBatch? {
        val rows = ProjectCrossings.rows(read["moves"] ?: JsonNull)?.takeIf { it.isNotEmpty() } ?: return null
        if (rows.any { it.text("kind") != ProjectCrossings.moveKind }) return null
        return CrossingBatch(rows.sortedWith(compareBy(byTime) { it.text("requestedAt").orEmpty() }),
            inTarget = "TARGET_COORDINATOR" in read.strings("drawnAs"))
    }

    /** The cards a conversation draws, oldest first: the crossings into the project it coordinates ([project]), and the move batches
     * the session read serves ([session]). A batch both reads serve is one card, the project read's: same id, or the same waiting rows
     * in a card the project read grouped from an earlier first row (iOS `ConsoleModel.crossingBatches`). */
    fun merged(project: List<CrossingBatch>, session: List<CrossingBatch>): List<CrossingBatch> {
        val seen = project.map { it.id }.toSet()
        val drawn = project.flatMap { batch -> batch.pending.map(ProjectCrossings::doorId) }.toSet()
        val extra = session.filter { batch -> batch.id !in seen && (batch.pending.isEmpty() || !batch.pending.map(ProjectCrossings::doorId).all(drawn::contains)) }
        return (project + extra).sortedWith(compareBy(byTime) { it.moment.orEmpty() })
    }

    private fun many(batch: CrossingBatch) = batch.rows.size != 1

    /** The project the batch goes into, by name: what the asking session's card says where the target's conversation says "this project". */
    fun targetTitle(batch: CrossingBatch) = batch.first.obj("toProject")?.text("title")?.takeIf { it.isNotBlank() } ?: ProjectCrossings.unnamedProject
    /** "this project" in the target's conversation; the target's name in the asking session; "No project" for a move out. */
    fun toText(batch: CrossingBatch) = if (batch.out) noProject else if (batch.inTarget) thisProject else targetTitle(batch)
    const val thisProject = "this project"
    const val noProject = "No project"

    /** The heading: the question while it asks, what happened once it is answered. */
    fun title(batch: CrossingBatch): String = batch.verdict?.let { answeredTitle(batch, it) } ?: when {
        batch.out -> if (many(batch)) "Take these tasks out of the project?" else "Take this task out of the project?"
        else -> question(batch)
    }

    /** An answered card's heading, in the past tense; a mixed answer says only that. */
    fun answeredTitle(batch: CrossingBatch, verdict: Verdict): String {
        val noun = if (batch.kind == "DEPEND_ON_TASK") (if (many(batch)) "Dependencies" else "Dependency") else if (many(batch)) "Tasks" else "Task"
        return when (verdict) {
            Verdict.MIXED -> if (many(batch)) "Requests answered" else "Request answered"
            Verdict.REFUSED -> when {
                batch.out -> "$noun kept in the project"
                batch.kind == ProjectCrossings.moveKind -> if (many(batch)) "Moves refused" else "Move refused"
                batch.kind == "DEPEND_ON_TASK" -> "$noun refused"
                else -> if (many(batch)) "Filings refused" else "Filing refused"
            }
            Verdict.APPROVED -> when {
                batch.out -> "$noun taken out of the project"
                batch.kind == ProjectCrossings.moveKind -> if (batch.inTarget) "$noun moved here" else "$noun moved into ${targetTitle(batch)}"
                batch.kind == "DEPEND_ON_TASK" -> "$noun allowed"
                else -> "$noun filed here"
            }
        }
    }

    private fun question(batch: CrossingBatch) = if (batch.kind == ProjectCrossings.moveKind && !batch.inTarget)
        (if (many(batch)) "Move these tasks into ${targetTitle(batch)}?" else "Move this task into ${targetTitle(batch)}?")
    else when (batch.kind) {
        ProjectCrossings.moveKind -> if (many(batch)) "Move these tasks here?" else "Move this task here?"
        "DEPEND_ON_TASK" -> if (many(batch)) "Allow these dependencies?" else "Allow this dependency?"
        else -> if (many(batch)) "File these tasks here?" else "File this task here?"
    }

    fun badge(batch: CrossingBatch): String = when (batch.verdict) {
        null -> when (batch.kind) { ProjectCrossings.moveKind -> "move"; "DEPEND_ON_TASK" -> "depend"; else -> "file" }
        Verdict.APPROVED -> if (batch.out) "taken out" else if (batch.kind == ProjectCrossings.moveKind) "moved" else "approved"
        Verdict.REFUSED -> "refused"
        Verdict.MIXED -> "answered"
    }

    fun noun(batch: CrossingBatch) =
        if (batch.kind == "DEPEND_ON_TASK") (if (many(batch)) "dependencies" else "dependency") else if (many(batch)) "tasks" else "task"

    fun listHead(batch: CrossingBatch) = if (batch.out) "Tasks to take out" else when (batch.kind) {
        ProjectCrossings.moveKind -> "Tasks to move"
        "DEPEND_ON_TASK" -> "Tasks waited on"
        else -> "Tasks to file"
    }

    fun sourceTitle(batch: CrossingBatch) = batch.first.obj("fromProject")?.text("title")?.takeIf { it.isNotBlank() } ?: ProjectCrossings.unnamedProject

    /** A criterion's 1-based position in its project's list, as the server numbers it; null from an older server or once it is gone. */
    private fun ordinal(criterion: JsonObject) = (criterion["ordinal"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

    /** What a person calls a criterion: "Criterion 4", or its words when the server sends no number. Never its key, which is an
     *  opaque id. Null when it has neither (deleted). */
    fun criterionName(criterion: JsonObject): String? =
        ordinal(criterion)?.let { "Criterion $it" } ?: criterion.text("text")?.trim()?.takeIf { it.isNotEmpty() }

    /** "4–11" when the numbers are a run, else "4, 6, 9". */
    fun criteriaRange(ordinals: Collection<Int>): String {
        val sorted = ordinals.distinct().sorted()
        return if (sorted.size > 1 && sorted.zipWithNext().all { (a, b) -> b == a + 1 }) "${sorted.first()}–${sorted.last()}"
        else sorted.joinToString(", ")
    }

    /** "for criteria 4–11", "for criteria 4, 6, 9", "for criterion 4" — by number, falling back to a criterion's words where the
     *  number is missing — or null when no row asks for a criterion it can name. */
    fun criteria(batch: CrossingBatch): String? {
        val criteria = batch.rows.mapNotNull { it.obj("requestedCriterion") }.distinctBy { it.text("key") }
        val ordinals = criteria.mapNotNull(::ordinal).distinct()
        val words = criteria.filter { ordinal(it) == null }.mapNotNull { it.text("text")?.trim()?.takeIf(String::isNotEmpty) }.map { "“$it”" }
        val named = ordinals.size + words.size
        if (named == 0) return null
        val parts = listOfNotNull(ordinals.takeIf { it.isNotEmpty() }?.let(::criteriaRange)) + words
        return "for ${if (named == 1) "criterion" else "criteria"} ${parts.joinToString(", ")}"
    }

    /** "8 tasks from Runner v1 · for criteria 4–11"; a move out says what it takes out of where, then what became of them. */
    fun summary(batch: CrossingBatch): String {
        val what = "${batch.rows.size} ${noun(batch)}"
        if (batch.out) return when (batch.verdict) {
            null -> "$what to take out of ${sourceTitle(batch)}"
            Verdict.APPROVED -> "$what taken out of ${sourceTitle(batch)}"
            Verdict.REFUSED -> "$what kept in ${sourceTitle(batch)}"
            Verdict.MIXED -> "$what from ${sourceTitle(batch)}"
        }
        return listOfNotNull("$what from ${sourceTitle(batch)}", criteria(batch)).joinToString(" · ")
    }

    /** The two buttons, in the words of what they do: a move out takes its tasks out or keeps them here. */
    fun approveLabel(batch: CrossingBatch) = if (!batch.out) approve else if (many(batch)) "Take them out" else "Take it out"
    fun refuseLabel(batch: CrossingBatch) = if (!batch.out) refuse else if (many(batch)) "Keep them here" else "Keep it here"

    fun link(batch: CrossingBatch) = if (batch.live) CardPreviews.viewDetailsAndAct else CardPreviews.viewDetails

    /** "move · 8 waiting", under the review's title while it asks. */
    fun waitingLine(batch: CrossingBatch) = "${badge(batch)} · ${ProjectCrossings.waiting(batch.pending.size)}"

    /** The subject a row names: a move's or a dependency's task as it reads now, a filing's title. */
    fun subject(row: JsonObject) = if (row.text("kind") == "FILE_TASK") row.text("title").orEmpty() else ProjectCrossings.subjectTitle(row)

    /** The lines under a row's subject: the criteria it asks for and serves now, and where it stands once answered — unless every
     *  row of its batch went the same way ([showState] false), which the receipt says once. */
    fun rowNotes(row: JsonObject, showState: Boolean = true): List<String> = buildList {
        row.obj("requestedCriterion")?.let { criterion ->
            add("${ProjectCrossings.moveRequestedCriterionLabel}: ${criterionName(criterion) ?: ProjectCrossings.moveCriterionGone}")
        }
        row.obj("withdrawnCriterion")?.let(::criterionName)?.let { add("${ProjectCrossings.moveWithdrawnCriterionLabel}: $it") }
        if (showState) row.text("state")?.takeUnless(ProjectCrossings::isAnswerable)?.let { add(ProjectCrossings.label(it)) }
    }

    /** "That answer was not recorded CODE", the door's sentence under it. */
    fun refusalHead(refusal: ProjectCrossings.Refusal) = ProjectCrossings.notRecorded + (refusal.code?.let { " $it" } ?: "")

    /** Whether a batch's rows name their own state: while it asks, or once it was answered both ways. */
    fun showsRowStates(batch: CrossingBatch) = batch.verdict == null || batch.verdict == Verdict.MIXED

    /** The label over the quoted reasons: they are the agent's words, under a card Orbit wrote. */
    fun reasonsHead(count: Int) = if (count == 1) "Reason given by the requesting agent" else "Reasons given by the requesting agent"

    /** Each distinct reason once, quoted. */
    fun reasons(batch: CrossingBatch) = batch.rows.mapNotNull { it.text("reason")?.trim()?.takeIf(String::isNotEmpty) }.distinct().map { "“$it”" }

    fun consequence(batch: CrossingBatch) = when {
        batch.out -> if (many(batch)) batchMoveOutConsequence else ProjectCrossings.moveOutApproveConsequence
        batch.kind != ProjectCrossings.moveKind -> ProjectCrossings.fileApproveConsequence
        many(batch) -> batchMoveConsequence
        else -> ProjectCrossings.moveApproveConsequence
    }

    /** "Show 5 more" past the first three rows. */
    const val shownRows = 3
    fun showMore(batch: CrossingBatch) = (batch.rows.size - shownRows).takeIf { it > 0 }?.let { "Show $it more" }

    /** "1 answer was not recorded", "3 answers were not recorded". */
    fun notRecorded(count: Int) = if (count == 1) "1 answer was not recorded" else "$count answers were not recorded"

    /** The ONE body a move batch's Approve or Refuse sends to `POST /sessions/:id/task-moves/decision`: every move still waiting, each
     * with the crossing key the card read. The server writes nothing if any key names another crossing. */
    fun moveRequest(batch: CrossingBatch, approve: Boolean) = buildJsonObject {
        put("decision", if (approve) "APPROVE" else "DENY")
        putJsonArray("moves") { batch.pending.forEach { row -> addJsonObject {
            put("handoffId", ProjectCrossings.doorId(row)); put("crossingKey", row.text("crossingKey").orEmpty())
        } } }
    }

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
