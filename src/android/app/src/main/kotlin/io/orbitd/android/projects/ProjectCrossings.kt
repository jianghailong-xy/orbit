package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.tasks.TaskDetailCopy
import kotlinx.serialization.json.*

/** Cross-project crossings on the project page — OrbitKit `ProjectCrossings` (iOS 4dddff557), the web's `ProjectCrossingsCard.tsx`:
 * work an agent wants to take over a project's line (a task filed under another project, a dependency on another project's task, or
 * a task moved into another project), every one waiting on the account owner, in either direction. Answering takes two presses: the
 * first only asks; the second names the subject and both ends, says what follows, and sends the crossing key back, so a list that
 * changed between the read and the press cannot turn one considered answer into an answer about somebody else's work. A yes to a
 * move IS the move, so a move says so in its own words, never in a filing's. */
object ProjectCrossings {
    const val moveKind = "MOVE_TASK"

    const val title = "Cross-project crossings"
    const val unreadable = "Crossings could not be loaded"
    /** A project end the server sent no title for. */
    const val unnamedProject = "unnamed project"
    const val arrow = " → "
    const val approveAsk = "Approve…"
    const val refuseAsk = "Refuse…"
    const val cancel = "Cancel"
    /** The head over the second press's crossing key. */
    const val crossingKeyLabel = "Crossing"
    /** The head of a refused answer, over the server's code and reason. */
    const val notRecorded = "That answer was not recorded"
    fun waiting(count: Int) = "$count waiting"
    fun reasonGiven(reason: String) = "Reason given: $reason"
    /** The part of the crossing key the second press shows. */
    fun shortKey(key: String) = key.take(12)

    // A move.
    const val moveSubjectLabel = "Task to move"
    const val moveRequestedCriterionLabel = "Target criterion requested"
    const val moveWithdrawnCriterionLabel = "Source criterion it serves now"
    const val moveWithdrawnCriterionNote = "Confirming the move withdraws this declaration."
    const val moveCriterionGone = "The target project no longer states this criterion."
    const val moveApproveConsequence =
        "Confirming is the move: the task joins the target project as soon as you answer, and nobody has to send the request again."
    const val moveDenyConsequence =
        "Refusing is final for this request, and the task stays where it is. If you change your mind, move the task yourself."
    // A filing, and a dependency.
    const val fileApproveConsequence = "The writer may then file this work under the target project. It is not filed by this answer."
    const val fileDenyConsequence = "Refusing is final for this crossing. If you change your mind, file the work yourself."

    /** What a row cannot be answered without: which row, its two ends, what it is, where it stands and the key an answer echoes. A
     * list with a row short of one fails as a read — an older server's row with less on it is still a row. */
    fun rows(read: JsonElement): List<JsonObject>? {
        val rows = (read as? JsonArray)?.map { it as? JsonObject ?: return null } ?: return null
        return rows.takeIf { all -> all.all { row -> listOf("id", "fromProjectId", "toProjectId", "kind", "crossingKey", "state").all { row.text(it) != null } } }
    }
    fun isMove(row: JsonObject) = row.text("kind") == moveKind
    /** What a state is called; a state nobody wrote a label for reads as its own code. */
    fun label(state: String) = TaskDetailCopy.crossingStateLabel[state] ?: state
    /** What follows from the row's state, in the words for its kind. */
    fun meaning(row: JsonObject): String {
        val state = row.text("state").orEmpty()
        return (if (isMove(row)) TaskDetailCopy.moveTaskStateMeaning else TaskDetailCopy.crossingStateMeaning)[state] ?: state
    }
    /** A crossing that is still a question is the only one that can be answered. */
    fun isAnswerable(state: String?) = state == "PENDING"
    /** The questions oldest first, then everything else newest first (web's `orderCrossings`). */
    fun ordered(rows: List<JsonObject>): List<JsonObject> {
        val (pending, answered) = rows.partition { isAnswerable(it.text("state")) }
        return pending.sortedBy { it.text("requestedAt").orEmpty() } + answered.sortedByDescending { it.text("requestedAt").orEmpty() }
    }
    fun waitingCount(rows: List<JsonObject>) = rows.count { isAnswerable(it.text("state")) }

    // Ids and names: the id a person can read and paste — Base62 when the server sent it.
    fun fromId(row: JsonObject) = row.text("fromProjectPublicId") ?: row.text("fromProjectId").orEmpty()
    fun toId(row: JsonObject) = row.text("toProjectPublicId") ?: row.text("toProjectId").orEmpty()
    fun subjectId(row: JsonObject) = row.text("subjectTaskPublicId") ?: row.text("subjectTaskId")
    /** A move's task as it reads now; the row's own title is the one it had when the move was asked. */
    fun subjectTitle(row: JsonObject) = row.obj("subjectTask")?.text("title") ?: row.text("title").orEmpty()
    /** The id the decision door is addressed by. */
    fun doorId(row: JsonObject) = row.text("publicId") ?: row.text("id").orEmpty()

    /** What the second press is agreeing to: the answer, the subject, both ends — by title, by id when the server sent none — and what follows. */
    data class Prompt(val verb: String, val from: String, val to: String, val subject: String, val consequence: String)
    fun prompt(row: JsonObject, approve: Boolean): Prompt {
        val verb = if (approve) "Approve" else "Refuse"
        val from = row.obj("fromProject")?.text("title") ?: fromId(row)
        val to = row.obj("toProject")?.text("title") ?: toId(row)
        return if (isMove(row)) Prompt(verb, from, to, subjectTitle(row), if (approve) moveApproveConsequence else moveDenyConsequence)
            else Prompt(verb, from, to, row.text("title").orEmpty(), if (approve) fileApproveConsequence else fileDenyConsequence)
    }
    /** The second press's question, naming the subject and both ends. */
    fun question(prompt: Prompt) = "${prompt.verb} moving “${prompt.subject}” from ${prompt.from} to ${prompt.to}?"
    /** The press that sends the answer. */
    fun confirmLabel(prompt: Prompt) = "Yes, ${prompt.verb.lowercase()}"
    /** The body of the press: the answer, and the key of the crossing it was given on. */
    fun request(row: JsonObject, approve: Boolean) = buildJsonObject {
        put("decision", if (approve) "APPROVE" else "DENY"); put("acknowledgedCrossingKey", row.text("crossingKey").orEmpty())
    }

    /** Why the door did not take an answer: its own code when it sent one, and its sentence. */
    data class Refusal(val code: String?, val message: String)
    fun refusal(error: Throwable) = Refusal((error as? ApiError)?.code, failureReason(error))
}
