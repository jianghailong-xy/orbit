package io.orbitd.android.core.cards

import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * A turn Orbit wrote to tell a session about a committed fact (`coordinatorDelivery`, apiserver `readCoordinatorDeliveryCards`): a fact a
 * project's coordinator is told — every notification `buildCoordinatorDeliveryMessage` writes — or the owner's answer to a session's
 * criteria proposal. Its words are written for the agent, a headline and then paragraphs of protocol, so it is drawn as one line —
 * "Evidence revision 1 submitted: <task> · Sent to the coordinator · 08:29" — that opens to those words, instead of the owner's own
 * bubble (web `CoordinatorDeliveryLine.tsx`, OrbitKit `CoordinatorDelivery`).
 *
 * The fields are `CoordinatorDeliveryCard`'s in `@orbit/shared`, in its order: what the line says ([kind]), the task the fact names, the
 * evidence revision, what the fact counts, when this conversation was handed it, and whether this conversation is the project's
 * coordinator ([toCoordinator]) — false for the owner's answer to a criteria proposal a task's run filed, whose line says "Sent to this
 * session" instead.
 */
data class CoordinatorDelivery(val kind: String, val task: Task?, val revision: Long?, val count: Long?, val deliveredAt: String,
    val toCoordinator: Boolean = true) {
    /** The task the fact is about, by the title the coordinator was told. */
    data class Task(val id: String, val title: String)
}

/**
 * The line's words, and the reading of a payload into a card — a copy of the web's `lib/coordinatorDelivery.ts`, held to it entry by
 * entry by `CoordinatorDeliveryCopyParityTest`. A payload that is not a card is no card, and the turn keeps its old reading.
 */
object CoordinatorDeliveryLine {
    /** What the sticky bar calls the turn once it has been scrolled past: the reply under it answers it (web `COORDINATOR_DELIVERY_STICKY_LABEL`). */
    const val stickyLabel = "From Orbit"
    /** The link at the foot of the opened line, to the task the fact names (web `COORDINATOR_DELIVERY_ITS_TASK`). */
    const val itsTask = "Its task ↗"
    /** Where the line says it was sent when this conversation is not the project's coordinator — the owner's answer to a criteria
     * proposal a task's run filed (web `COORDINATOR_DELIVERY_SENT_TO_SESSION`) — and the heading its words open under
     * (`COORDINATOR_DELIVERY_SESSION_TOLD`). */
    const val sentToThisSession = "Sent to this session"
    const val toldThisSession = "What this session was told"

    /** The fields of `CoordinatorDeliveryCard`, in its order: the card above is built in this order. */
    val fields = listOf("kind", "task", "revision", "count", "deliveredAt", "toCoordinator")

    /** `COORDINATOR_DELIVERY_KINDS`, in its order: one per sentence a line can say. */
    val kinds = listOf(
        "EVIDENCE_SUBMITTED", "EVIDENCE_MOVED_IN", "DEPENDENT_READY", "TASK_DISPATCH_REFUSED", "PROJECT_BLOCKER_RAISED",
        "TASK_RUN_STOPPED", "CRITERION_UNLANDED", "ACCEPTANCE_LANDED", "ACCEPTANCE_LANDED_HELD", "ACCEPTANCE_LANDED_DONE", "LOOKS_FINISHED",
        "SETTLED_UNMERGED", "CRITERIA_APPROVED", "CRITERIA_REJECTED",
    )

    /**
     * What each line says, by kind (web `COORDINATOR_DELIVERY_SENTENCES`): `{task}` is the title of the task the fact names, `{revision}`
     * the evidence revision, `{count}` what the fact counts as [counts] says it. A kind needs exactly the fields its sentence names.
     */
    val sentences: Map<String, String> = linkedMapOf(
        "EVIDENCE_SUBMITTED" to "Evidence revision {revision} submitted: {task}",
        "EVIDENCE_MOVED_IN" to "Evidence revision {revision} moved in: {task}",
        "DEPENDENT_READY" to "Can start now: {task}",
        "TASK_DISPATCH_REFUSED" to "Could not start: {task}",
        "PROJECT_BLOCKER_RAISED" to "Blocker raised: {task}",
        "TASK_RUN_STOPPED" to "Run stopped: {task}",
        "CRITERION_UNLANDED" to "Work not on main yet: {count}",
        "ACCEPTANCE_LANDED" to "{count} landed",
        "ACCEPTANCE_LANDED_HELD" to "{count} landed, Done held back",
        "ACCEPTANCE_LANDED_DONE" to "{count} landed, recorded Done",
        "LOOKS_FINISHED" to "Looks finished, not recorded Done",
        "SETTLED_UNMERGED" to "Settled with work not on main: {count}",
        "CRITERIA_APPROVED" to "Criteria proposal approved",
        "CRITERIA_REJECTED" to "Criteria proposal rejected",
    )

    /** How `{count}` is said, by what is counted (web `COORDINATOR_DELIVERY_COUNTS`): the first when there is one, the second (with `{n}`) otherwise. */
    private val tasks = "1 task" to "{n} tasks"
    private val criteria = "The only criterion" to "All {n} criteria"
    private val commits = "1 commit" to "{n} commits"
    val counts: Map<String, Pair<String, String>> = linkedMapOf(
        "CRITERION_UNLANDED" to tasks,
        "ACCEPTANCE_LANDED" to criteria,
        "ACCEPTANCE_LANDED_HELD" to criteria,
        "ACCEPTANCE_LANDED_DONE" to criteria,
        "SETTLED_UNMERGED" to commits,
    )

    /**
     * The card a payload is, read as the web's `parseCoordinatorDelivery` reads it: a kind every client knows, a moment that reads as
     * one, and each field the kind's sentence names — a task with an id and a title, a revision or a count that is a positive whole
     * number. A field the sentence does not name is left out; a payload missing one it does name is no card, never half a line. Only the
     * server's own `false` says this conversation is not the coordinator: a card stored before [CoordinatorDelivery.toCoordinator] existed
     * was drawn as the coordinator's, and reads as it was.
     */
    fun parse(card: JsonObject): CoordinatorDelivery? {
        fun string(value: Any?) = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
        val kind = string(card["kind"])?.takeIf { it in kinds } ?: return null
        val deliveredAt = string(card["deliveredAt"])?.takeIf { runCatching { Instant.parse(it) }.isSuccess } ?: return null
        val sentence = sentences.getValue(kind)
        val task = (card["task"] as? JsonObject)?.let { task ->
            val id = string(task["id"])?.takeIf { it.isNotEmpty() }
            val title = string(task["title"])?.takeIf { it.isNotBlank() }
            if (id != null && title != null) CoordinatorDelivery.Task(id, title) else null
        }
        val revision = positive(card["revision"])
        val count = positive(card["count"])
        if ("{task}" in sentence && task == null) return null
        if ("{revision}" in sentence && revision == null) return null
        if ("{count}" in sentence && count == null) return null
        return CoordinatorDelivery(
            kind,
            task.takeIf { "{task}" in sentence },
            revision.takeIf { "{revision}" in sentence },
            count.takeIf { "{count}" in sentence },
            deliveredAt,
            (card["toCoordinator"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull != false,
        )
    }

    fun isCard(card: JsonObject): Boolean = parse(card) != null

    /** A whole number above zero, as JSON writes one: the web's `Number.isSafeInteger(value) && value > 0` over a number, never a string. */
    private fun positive(value: Any?): Long? {
        val number = (value as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull() ?: return null
        return if (number > 0 && number <= MAX_SAFE_INTEGER && number == Math.floor(number)) number.toLong() else null
    }

    private const val MAX_SAFE_INTEGER = 9007199254740991.0

    /** The sentence the line says, before "Sent to the coordinator · 08:29" — the title last, so its words are never a placeholder. */
    fun sentence(card: CoordinatorDelivery): String {
        val counted = counts[card.kind]
        val count = if (counted != null && card.count != null) {
            (if (card.count == 1L) counted.first else counted.second).replaceFirst("{n}", card.count.toString())
        } else ""
        return sentences.getValue(card.kind)
            .replaceFirst("{revision}", card.revision?.toString().orEmpty())
            .replaceFirst("{count}", count)
            .replaceFirst("{task}", card.task?.title.orEmpty())
    }

    /** The sentence for a payload, or nothing for one that is no card. */
    fun sentence(card: JsonObject): String = parse(card)?.let { sentence(it) }.orEmpty()

    /** "Sent to the coordinator · 08:29": the words and the clock every line handed to the coordinator says (`OwnerAnswerLine.line`) —
     * or "Sent to this session · 08:29" where this conversation is not the project's coordinator, on the same clock. */
    fun sent(card: CoordinatorDelivery, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val time = OwnerReview.receiptTime(card.deliveredAt, now, zone)
        return if (card.toCoordinator) CoordinatorQueue.sentLine(time) else listOfNotNull(sentToThisSession, time).joinToString(" · ")
    }

    /** The heading over the words, once the line is opened: what the coordinator was told, or what this session was told. */
    fun told(card: CoordinatorDelivery): String = if (card.toCoordinator) OwnerAnswerLine.told else toldThisSession
}
