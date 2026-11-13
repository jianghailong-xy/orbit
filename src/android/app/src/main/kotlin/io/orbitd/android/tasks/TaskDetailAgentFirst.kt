package io.orbitd.android.tasks

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import java.time.Duration
import java.time.Instant
import java.util.Locale

// The task page led by the agent's work (docs/mocks/task-detail-agent-first, boards 04–05), as OrbitKit's
// TaskDetailAgentFirst.swift writes its rules: one status line, Now, Delivered, Done means with the brief folded,
// In the plan, Runs with as one line, and one Activity timeline. Pure functions over the server's JSON, each unit tested.

/** One entry of the Activity timeline, oldest first. */
sealed interface TaskActivityItem {
    val at: String?
    val key: String
    data class Filed(override val at: String?) : TaskActivityItem { override val key get() = "filed" }
    data class Run(val session: JsonObject) : TaskActivityItem {
        override val at get() = session.text("createdAt"); override val key get() = "run-${session.text("id")}"
    }
    data class EvidenceSubmitted(val revision: String, override val at: String?) : TaskActivityItem { override val key get() = "evidence-$revision" }
    data class EvidenceDecided(val revision: String, val accepted: Boolean, val byOwner: Boolean, override val at: String?) : TaskActivityItem {
        override val key get() = "decision-$revision"
    }
    data class Comment(val comment: JsonObject) : TaskActivityItem {
        override val at get() = comment.text("createdAt"); override val key get() = "comment-${comment.text("id")}"
    }
}

/** An evidence version's number in the task's own order, as the server writes it ("1", "2", …). */
fun evidenceRevision(row: JsonObject): String = (row["revision"] as? JsonPrimitive)?.content ?: "?"

private fun JsonObject.double(key: String) = (this[key] as? JsonPrimitive)?.doubleOrNull
private fun JsonObject.int(key: String) = (this[key] as? JsonPrimitive)?.intOrNull

// MARK: the status line

/** How long something has been going: `<1m`, `7m`, `1h 12m`, `2h`. */
fun TaskDetailLogic.elapsedLabel(iso: String?, now: Instant = Instant.now()): String? {
    val start = TaskTime.parse(iso) ?: return null
    val seconds = Duration.between(start, now).seconds
    if (seconds < 0) return null
    val minutes = seconds / 60
    if (minutes < 1) return "<1m"
    if (minutes < 60) return "${minutes}m"
    val hours = minutes / 60
    return if (minutes % 60 == 0L) "${hours}h" else "${hours}h ${minutes % 60}m"
}

/** A cost as the page prints it, or null when nothing has been booked. Half away from zero, as JavaScript's `toFixed(2)`. */
fun TaskDetailLogic.costLabel(usd: Double?): String? {
    if (usd == null || usd <= 0) return null
    if (usd < 0.01) return "<$0.01"
    return String.format(Locale.US, "$%.2f", Math.round(usd * 100) / 100.0)
}

/** What a run has cost so far (`SessionRef.costUsd`). */
fun TaskDetailLogic.runCost(session: JsonObject): Double? = session.double("costUsd")

/** What every run of the task has cost together. */
fun TaskDetailLogic.totalCost(task: JsonObject): String? = costLabel(task.objects("sessions").sumOf { runCost(it) ?: 0.0 })

/** The run going now: running first, else queued. Null when nothing is moving. */
fun TaskDetailLogic.liveRun(task: JsonObject): JsonObject? {
    val sessions = task.objects("sessions")
    return sessions.firstOrNull { resolvedRunState(it) == "RUNNING" } ?: sessions.firstOrNull { resolvedRunState(it) == "QUEUED" }
}

/** The status pill, with how long the run has been going while one is. */
fun TaskDetailLogic.headPill(task: JsonObject, now: Instant = Instant.now()): TaskPill {
    val pill = TaskListLogic.pill(task)
    if (pill.kind != PillKind.RUNNING) return pill
    val started = task.objects("sessions").firstOrNull { resolvedRunState(it) == "RUNNING" }?.text("createdAt")
    val elapsed = elapsedLabel(started, now) ?: return pill
    return TaskPill(PillKind.RUNNING, "${pill.label} · $elapsed")
}

// MARK: Now

/** The reported position (`task.progress`), or null for a task that never reported (revision 0) or reported nothing usable. */
fun TaskDetailLogic.progress(task: JsonObject): JsonObject? {
    val progress = task.obj("progress") ?: return null
    if ((progress.int("revision") ?: 0) <= 0) return null
    if (progress.int("current") == null && progress.text("phase") == null && progress.text("message") == null) return null
    return progress
}

/** `Step 3 of 5`, `Step 3`, or null without a count. */
fun TaskDetailLogic.progressStep(progress: JsonObject): String? {
    val current = progress.int("current") ?: return null
    return progress.int("total")?.let { "Step $current of $it" } ?: "Step $current"
}

/** How far along, 0…1, where a total bounds the count. */
fun TaskDetailLogic.progressFraction(progress: JsonObject): Float? {
    val current = progress.int("current") ?: return null
    val total = progress.int("total")?.takeIf { it > 0 } ?: return null
    return minOf(current, total).toFloat() / total
}

// MARK: Delivered

/** The evidence card's chip: its decision, or that none has been made yet. `accepted` null is undecided. */
fun TaskDetailLogic.evidenceOutcome(row: JsonObject): Pair<String, Boolean?> = when (row.obj("decision")?.text("decision")) {
    "CONFIRM" -> TaskDetailCopy.evidenceAccepted to true
    "SEND_BACK" -> TaskDetailCopy.evidenceSentBack to false
    else -> TaskDetailCopy.evidenceAwaiting to null
}

/** The line beside the chip: which version, and who decided it when, or when it was submitted. */
fun TaskDetailLogic.evidenceMeta(row: JsonObject, `when`: (String?) -> String): String {
    val decision = row.obj("decision") ?: return "Evidence r${evidenceRevision(row)} · submitted ${`when`(row.text("submittedAt"))}"
    val by = if (decision.text("decidedByType") == "USER") "you" else "a reviewing agent"
    val verb = if (decision.text("decision") == "CONFIRM") "accepted" else "sent back"
    return "Evidence r${evidenceRevision(row)} · $verb by $by · ${`when`(decision.text("decidedAt"))}"
}

/** One cited check, in words: the command a tool call ran, or the kind and its reference. */
fun TaskDetailLogic.evidenceCheckText(check: JsonObject): String {
    val ref = check.text("ref").orEmpty()
    return when (val kind = check.text("kind").orEmpty()) {
        "TOOL_CALL" -> check.text("command")?.trim()?.takeIf { it.isNotEmpty() } ?: "Tool call $ref"
        "COMMIT" -> "Commit ${ref.take(9)}"
        "ARTIFACT" -> "Artifact $ref"
        "FILE" -> "File $ref"
        else -> "$kind $ref"
    }
}

// MARK: In the plan

/** The plan in one sentence: whether anything still blocks the task (only when the blocked notice is not already saying so),
 * and which open task waits on it. */
fun TaskDetailLogic.planSentence(task: JsonObject): String {
    val prerequisites = task.objects("dependsOn")
    val parts = mutableListOf<String>()
    if (!TaskListLogic.isBlocked(task)) parts += when (prerequisites.size) {
        0 -> "Nothing blocks this task."
        1 -> "Its prerequisite is done."
        else -> "All ${prerequisites.size} prerequisites are done."
    }
    val waiting = task.objects("dependedOnBy").mapNotNull { it.obj("task") }.filter { it.text("status") != "DONE" && it.text("status") != "CANCELLED" }
    waiting.firstOrNull()?.let { first ->
        val title = first.text("title") ?: "Untitled task"
        parts += if (waiting.size == 1) "“$title” waits on it." else "“$title” and ${waiting.size - 1} more wait on it."
    }
    return parts.joinToString(" ")
}

// MARK: Attribution and Followed by, only when they say something

/** A crossing, a blocker, or work counting towards a project other than the one the header names. */
fun TaskDetailLogic.attributionNeedsCard(view: JsonObject, projectId: String?): Boolean {
    if (view.obj("crossing") != null || view.obj("blocker") != null) return true
    val owning = view.obj("owning") ?: return false
    return owning.text("projectId") != projectId
}

// MARK: Activity

/** Filing, runs, evidence and its decisions, and comments, oldest first. A run in the Trash is not one anybody should be sent to. */
fun TaskDetailLogic.activity(task: JsonObject, evidence: List<JsonObject>): List<TaskActivityItem> {
    val items = mutableListOf<TaskActivityItem>()
    task.text("createdAt")?.let { items += TaskActivityItem.Filed(it) }
    task.objects("sessions").filter { it.text("deletedAt") == null }.forEach { items += TaskActivityItem.Run(it) }
    evidence.forEach { row ->
        val revision = evidenceRevision(row)
        items += TaskActivityItem.EvidenceSubmitted(revision, row.text("submittedAt"))
        row.obj("decision")?.let { decision ->
            items += TaskActivityItem.EvidenceDecided(revision, decision.text("decision") == "CONFIRM", decision.text("decidedByType") == "USER",
                decision.text("decidedAt"))
        }
    }
    task.objects("comments").forEach { items += TaskActivityItem.Comment(it) }
    // Stable: entries at the same instant keep the order above.
    return items.sortedBy { TaskTime.parse(it.at) ?: Instant.MIN }
}

/** An evidence entry's words on the timeline. */
fun TaskDetailLogic.activityText(item: TaskActivityItem): String? = when (item) {
    is TaskActivityItem.EvidenceSubmitted -> "Evidence r${item.revision} submitted"
    is TaskActivityItem.EvidenceDecided -> "Evidence r${item.revision} ${if (item.accepted) "accepted" else "sent back"} by ${if (item.byOwner) "you" else "a reviewing agent"}"
    else -> null
}

// MARK: the composer

/** Whom the comment box writes to by default: the run, when one is going and has a workspace to mention — the mention delivery
 * puts it into that workspace's live run on this task. */
fun TaskDetailLogic.runRecipient(task: JsonObject): String? = if (liveRun(task) == null) null else task.obj("assignee")?.text("id")

/** The mentions a comment carries, with the run's workspace added when it goes to the run. */
fun TaskDetailLogic.mentions(mentioned: List<String>, toRun: String?): List<String> =
    if (toRun == null || toRun in mentioned) mentioned else mentioned + toRun
