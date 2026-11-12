package io.orbitd.android.cards

import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.objects
import io.orbitd.android.core.cards.strings
import io.orbitd.android.core.cards.text
import io.orbitd.android.projects.ProjectApi
import io.orbitd.android.projects.ProjectCrossings
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/**
 * The task moves a conversation draws (`GET /sessions/:id/task-moves`, board waiting-on-you-removal ②): the moves one session asked for
 * out of one project into another are one batch and one card, drawn in the session that asked and in the target project's coordinator.
 * The card is the project page's crossing card moved into the conversation: its words and its two presses are [ProjectCrossings]'s, and
 * each move, under Show all, is that page's row ([io.orbitd.android.projects.CrossingRow]) answered on its own. The batch's own answer
 * sends every move with the crossing key the card read, so a batch that changed since the read is refused whole.
 */
object TaskMoves {
    /** How many moves the card lists before Show all, and the second press before "and N more". */
    const val shown = 3

    /** A read whose batches each carry a key, a state and moves the crossing row can be drawn from; null for anything else. */
    fun batches(read: JsonElement): List<JsonObject>? {
        val batches = (read as? JsonArray)?.map { it as? JsonObject ?: return null } ?: return null
        return batches.takeIf { all -> all.all { it.text("batchKey") != null && it.text("state") != null && ProjectCrossings.rows(it["moves"] ?: JsonNull)?.isNotEmpty() == true } }
    }

    fun key(batch: JsonObject) = batch.text("batchKey").orEmpty()
    /** The address the needs-you bar counts a waiting batch under. */
    fun focusKey(batch: JsonObject) = "task-moves:${key(batch)}"
    fun moves(batch: JsonObject) = batch.objects("moves")
    fun pending(batch: JsonObject) = ProjectCrossings.isAnswerable(batch.text("state"))
    /** Whether this conversation coordinates the project the moves go into: the card then says "this project". */
    fun intoThisProject(batch: JsonObject) = "TARGET_COORDINATOR" in batch.strings("drawnAs")
    /** Whether this conversation is the one that asked. */
    fun askedHere(batch: JsonObject) = "REQUESTER" in batch.strings("drawnAs")

    private fun first(batch: JsonObject) = moves(batch).firstOrNull()
    fun fromTitle(batch: JsonObject) = first(batch)?.let { it.obj("fromProject")?.text("title") ?: ProjectCrossings.fromId(it) } ?: ProjectCrossings.unnamedProject
    fun toTitle(batch: JsonObject) = first(batch)?.let { it.obj("toProject")?.text("title") ?: ProjectCrossings.toId(it) } ?: ProjectCrossings.unnamedProject
    /** The source project's status, said only when it is not open: "(Done)". */
    fun fromStatus(batch: JsonObject) = first(batch)?.obj("fromProject")?.text("status")?.takeIf { it != "OPEN" }
        ?.let { status -> status.lowercase().replaceFirstChar { it.uppercase() } }

    /** Where they go, from where the reader is: "this project" in its coordinator, else the target by name. */
    private fun into(batch: JsonObject) = if (intoThisProject(batch)) thisProject else toTitle(batch)

    // The words. A move's own labels, consequences and Cancel are the crossing card's.
    const val thisProject = "this project"
    const val askedByThis = "Asked here"
    const val showFewer = "Show fewer"
    fun tasks(n: Int) = if (n == 1) "1 task" else "$n tasks"
    fun title(batch: JsonObject) = "Move ${tasks(moves(batch).size)} into ${into(batch)}"
    fun from(title: String) = "From $title"
    fun askedBy(session: String) = "Asked by $session"
    fun askedLine(batch: JsonObject, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String {
        val who = if (askedHere(batch)) askedByThis
            else askedBy(first(batch)?.obj("requestedBySession")?.text("title")?.trim()?.takeIf { it.isNotEmpty() } ?: io.orbitd.android.tasks.TaskDetailCopy.untitledSession)
        return listOfNotNull(who, batch.text("since")?.let { askedTime(it, zone) }).joinToString(" · ")
    }
    /** When it was asked, as the board and iOS write it: "Nov 9, 08:31". */
    fun askedTime(iso: String, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String? =
        runCatching { java.time.format.DateTimeFormatter.ofPattern("MMM d, HH:mm", java.util.Locale.US).format(Instant.parse(iso).atZone(zone)) }.getOrNull()
    /** A move's line under its title: the crossing card's two labels, and the criterion it asks to count towards. */
    fun moveLine(row: JsonObject): String {
        val criterion = row.obj("requestedCriterion") ?: return ProjectCrossings.moveSubjectLabel
        return "${ProjectCrossings.moveSubjectLabel} · ${ProjectCrossings.moveRequestedCriterionLabel}: ${criterionWords(criterion)}"
    }
    private fun criterionWords(criterion: JsonObject) = criterion.text("text")?.trim()?.takeIf { it.isNotEmpty() } ?: ProjectCrossings.moveCriterionGone
    /** A move on the second press: the criterion, and the crossing key the answer sends back for it. */
    fun keyLine(row: JsonObject) = listOfNotNull(row.obj("requestedCriterion")?.let(::criterionWords),
        "key ${ProjectCrossings.shortKey(row.text("crossingKey").orEmpty())}…").joinToString(" · ")
    fun showAll(n: Int) = "Show all $n"
    fun andMore(n: Int) = "and $n more"
    fun moves(n: Int) = if (n == 1) "move" else "$n moves"
    fun approveAsk(n: Int) = "Approve ${moves(n)}…"
    val refuseAsk get() = ProjectCrossings.refuseAsk
    fun question(n: Int, approve: Boolean) = "${if (approve) "Approve" else "Refuse"} ${if (n == 1) "task move" else "$n task moves"}?"
    fun confirmLabel(n: Int, approve: Boolean) = "${if (approve) "Approve" else "Refuse"} ${moves(n)}"
    fun consequence(approve: Boolean) = if (approve) ProjectCrossings.moveApproveConsequence else ProjectCrossings.moveDenyConsequence

    /** The one line an answered batch becomes, in the conversation where the card was. */
    fun resolvedLine(batch: JsonObject): String {
        val n = moves(batch).size
        return when (val state = batch.text("state").orEmpty()) {
            "APPLIED", "APPROVED" -> "Moved ${tasks(n)} into ${into(batch)}"
            "DENIED" -> "Refused ${if (n == 1) "a task move" else "$n task moves"} into ${into(batch)}"
            else -> "${if (n == 1) "Task move" else "$n task moves"} into ${into(batch)}: ${ProjectCrossings.label(state)}"
        }
    }
    fun resolvedTime(batch: JsonObject, now: Instant) = batch.text("decidedAt")?.let { OwnerReview.receiptTime(it, now) }

    /** Where each batch goes in a conversation: at the moment its first move was asked, by the owner requests' own rule. */
    fun place(rowTimes: List<String?>, batches: List<JsonObject>): Map<Int, List<JsonObject>> = OwnerRequests.place(rowTimes, batches) { it.text("since") }

    /** The body of the batch's answer: every move by the id its door takes, each with the crossing key the card read. */
    fun request(moves: List<JsonObject>, approve: Boolean) = buildJsonObject {
        put("decision", if (approve) "APPROVE" else "DENY")
        putJsonArray("moves") { moves.forEach { row -> addJsonObject { put("handoffId", ProjectCrossings.doorId(row)); put("crossingKey", row.text("crossingKey").orEmpty()) } } }
    }
}

/**
 * The move cards of one conversation: the read, which press is open where, and the answers. The batch's answer stands in for it as soon
 * as the door returns, and the read follows behind it; a refused answer keeps its second press open with the door's own reason.
 */
class TaskMoveStore(private val api: ProjectApi, val sessionId: String, private val scope: CoroutineScope) {
    data class State(
        /** Null until a read answered. */
        val batches: List<JsonObject>? = null,
        val failed: Boolean = false,
        /** The batch whose second press is open, and which answer it asks. */
        val asking: Pair<String, Boolean>? = null,
        /** One move's second press under Show all: its id, and which answer. */
        val askingMove: Pair<String, Boolean>? = null,
        /** The batch or move (by its key or id) whose answer is on its way. */
        val busy: String? = null,
        /** Answers the door refused, by batch key or move id. */
        val refusals: Map<String, ProjectCrossings.Refusal> = emptyMap(),
        /** The batches showing every move. */
        val expanded: Set<String> = emptySet(),
    )

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()

    fun load() {
        scope.launch {
            try {
                val batches = TaskMoves.batches(api.taskMoves(sessionId)) ?: throw io.orbitd.android.core.protocol.ProtocolException()
                mutable.update { it.copy(batches = batches, failed = false) }
            } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { mutable.update { it.copy(failed = true) } }
        }
    }

    fun ask(batch: JsonObject, approve: Boolean) = mutable.update { it.copy(asking = TaskMoves.key(batch) to approve, refusals = it.refusals - TaskMoves.key(batch)) }
    fun cancel() = mutable.update { it.copy(asking = null) }
    fun expand(batch: JsonObject, open: Boolean) = mutable.update { it.copy(expanded = if (open) it.expanded + TaskMoves.key(batch) else it.expanded - TaskMoves.key(batch)) }

    /** The batch's second press: every move it showed, with the key it showed. */
    fun answer(batch: JsonObject, approve: Boolean) {
        val key = TaskMoves.key(batch)
        if (mutable.value.busy != null) return
        mutable.update { it.copy(busy = key) }
        scope.launch {
            try {
                val answered = ProjectCrossings.rows(api.decideMoveBatch(sessionId, TaskMoves.moves(batch), approve) ?: JsonNull)
                mutable.update { state ->
                    val adopted = answered?.takeIf { it.isNotEmpty() }?.let { rows -> JsonObject(batch + buildJsonObject {
                        put("state", rows.first().text("state").orEmpty()); rows.first()["decidedAt"]?.let { put("decidedAt", it) }; put("moves", JsonArray(rows))
                    }) }
                    state.copy(busy = null, asking = null, batches = state.batches?.map { if (TaskMoves.key(it) == key && adopted != null) adopted else it })
                }
                load()
            } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
                mutable.update { it.copy(busy = null, refusals = it.refusals + (key to ProjectCrossings.refusal(error))) }
                load()
            }
        }
    }

    fun askMove(row: JsonObject, approve: Boolean) = mutable.update { it.copy(askingMove = row.text("id").orEmpty() to approve, refusals = it.refusals - row.text("id").orEmpty()) }
    fun cancelMove() = mutable.update { it.copy(askingMove = null) }

    /** One move answered on its own, through the project page's door. */
    fun answerMove(row: JsonObject, approve: Boolean) {
        val id = row.text("id").orEmpty()
        if (mutable.value.busy != null) return
        mutable.update { it.copy(busy = id) }
        scope.launch {
            try {
                api.decideCrossing(ProjectCrossings.toId(row), row, approve)
                mutable.update { it.copy(busy = null, askingMove = null) }
            } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
                mutable.update { it.copy(busy = null, refusals = it.refusals + (id to ProjectCrossings.refusal(error))) }
            }
            load()
        }
    }
}
