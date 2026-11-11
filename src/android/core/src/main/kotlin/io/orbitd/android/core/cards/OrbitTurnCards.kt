package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import java.time.Instant

/**
 * Five more of Orbit's own turns, drawn as what they are rather than as the reader's bubble or an empty one with the block folded
 * under it (docs/mocks/orbit-turn-cards/; web `OrbitTurnCards.tsx`, OrbitKit `OrbitTurnCards.swift`): a revision handed to the
 * session that dispatched its task, a send-back's note handed to the run, a task run's question and its notice to the coordinator,
 * and the opening of a session Orbit opened. Each is read off the `user` event's payload field of the same name
 * (shared `orbit-turn-cards.ts`); the words are web's, word for word.
 */
object OrbitTurnCards {
    const val evidenceToReview = "Evidence to review"
    const val evidenceSentBack = "Evidence sent back"
    const val questionFromRun = "Question from a task run"
    const val noticeFromRun = "Notice from a task run"
    const val sessionTold = "What this session was told"
    const val runTold = "What the run was told"
    const val coordinatorTold = "What the coordinator was told"
    const val showAll = "Show all"
    const val showLess = "Show less"
    const val showBrief = "Show brief"
    const val hideBrief = "Hide brief"
    const val aTaskRun = "A task run"
    const val noticeState = "Nothing to reply to. It did not reach you."

    /** How a state line reads: its words and the tone they are drawn in. */
    enum class Tone { PLAIN, WARNING, SUCCESS }
    data class StateLine(val text: String, val tone: Tone = Tone.PLAIN)

    private fun instant(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }
    private fun time(iso: String?, now: Instant): String = iso?.let { OwnerReview.receiptTime(it, now) } ?: ""

    // ── Evidence to review ───────────────────────────────────────────────────────────────────────

    fun isEvidenceReview(card: JsonObject) = listOf("taskId", "title", "revision", "state").none { card.text(it).isNullOrBlank() }

    /** Blue while it waits for a decision; grey once there is nothing to decide. */
    fun evidenceReviewOpen(card: JsonObject) = card.text("state") == "OPEN"

    fun evidenceReviewMeta(card: JsonObject, now: Instant = Instant.now()): String =
        "Revision ${card.text("revision")}" + (card.text("dueAt")?.let { " · Due ${time(it, now)}" } ?: "")

    fun evidenceReviewState(card: JsonObject, now: Instant = Instant.now()): StateLine = when (card.text("state")) {
        "SUPERSEDED" -> StateLine("Revision ${card.text("latestRevision")} replaced it. Nothing to decide.")
        "DECIDED" -> if (card.text("decision") == "CONFIRM") StateLine("Confirmed.", Tone.SUCCESS) else StateLine("Sent back.")
        "CLOSED" -> StateLine("The task is closed. Nothing to decide.")
        else -> {
            val due = instant(card.text("dueAt"))
            when {
                due == null -> StateLine("This session decides it.")
                now.isBefore(due) -> StateLine("This session decides it. If it hasn't by ${time(card.text("dueAt"), now)}, you're asked.")
                else -> StateLine("You were asked at ${time(card.text("dueAt"), now)}.", Tone.WARNING)
            }
        }
    }

    // ── Evidence sent back ───────────────────────────────────────────────────────────────────────

    fun isEvidenceSendBack(card: JsonObject) = listOf("taskId", "title", "revision", "by").none { card.text(it).isNullOrBlank() }

    /** Who sent it back, after "Revision N · by ": you, the session by its title, or "a session" when it cannot be named. */
    fun sentBackBy(card: JsonObject): String = when {
        card.text("by") == "OWNER" -> "you"
        else -> card.text("byTitle")?.takeIf { it.isNotBlank() } ?: "a session"
    }

    fun sentBackPrefix(card: JsonObject) = "Revision ${card.text("revision")} · by "

    // ── Question from a task run ─────────────────────────────────────────────────────────────────

    fun isRunQuestion(card: JsonObject) = listOf("requestId", "runSessionId", "replyBy").none { card.text(it).isNullOrBlank() }

    fun runTaskTitle(card: JsonObject): String = card.text("taskTitle")?.takeIf { it.isNotBlank() } ?: aTaskRun

    fun answered(card: JsonObject) = card.text("answeredBy") == "SESSION" || card.text("answeredBy") == "OWNER"

    /** One question as the card lists it: each option, whether it was picked, and any answer in the person's own words. */
    data class Option(val label: String, val picked: Boolean)
    data class Question(val text: String, val options: List<Option>, val ownWords: List<String>)

    fun runQuestions(card: JsonObject): List<Question> {
        val answers = card.obj("answers")
        return card.objects("questions").mapNotNull { row ->
            val text = row.text("question") ?: return@mapNotNull null
            val labels = row.objects("options").mapNotNull { it.text("label") }
            val picked = answers?.strings(text).orEmpty()
            Question(text, labels.map { Option(it, it in picked) }, picked.filter { it !in labels })
        }
    }

    fun runQuestionState(card: JsonObject, now: Instant = Instant.now()): StateLine = when (card.text("answeredBy")) {
        "SESSION" -> StateLine("Answered by this session.", Tone.SUCCESS)
        "OWNER" -> StateLine("Answered by you.", Tone.SUCCESS)
        else -> {
            val replyBy = instant(card.text("replyBy"))
            when {
                card.text("state") == "OPEN" && replyBy != null && now.isBefore(replyBy) -> StateLine(
                    "The run is waiting. This session answers it; if it hasn't by ${time(card.text("replyBy"), now)}, you're asked.")
                card.text("approvalStatus") == "PENDING" -> StateLine("Passed to you at ${time(card.text("replyBy"), now)}.", Tone.WARNING)
                else -> StateLine("Closed without an answer.")
            }
        }
    }

    // ── Notice from a task run ───────────────────────────────────────────────────────────────────

    fun isRunNotice(card: JsonObject) = listOf("requestId", "runSessionId").none { card.text(it).isNullOrBlank() }

    // ── Session opening ──────────────────────────────────────────────────────────────────────────

    fun isSessionOpening(card: JsonObject) =
        card.text("kind") in setOf("COORDINATOR", "JUDGMENT", "DISPATCH", "MENTION", "OTHER")

    /** The opening's sentence, split around its target so the target can be drawn as a link: (before, target title or null). */
    fun openingSentence(card: JsonObject): Pair<String, String?> {
        val target = card.obj("target")?.text("title")?.takeIf { it.isNotBlank() }
        val lead = when (card.text("kind")) {
            "COORDINATOR" -> "Orbit started this session as the coordinator of "
            "JUDGMENT" -> "Orbit started this session to judge "
            "DISPATCH" -> "Orbit started this session to dispatch the list "
            "MENTION" -> "Orbit started this session for your mention on "
            else -> null
        }
        return if (lead == null || target == null) "Orbit started this session" to null else lead to target
    }

    /** Where the opening's target opens: a project's page, a task's, a list's. */
    fun openingLink(card: JsonObject): String? {
        val target = card.obj("target") ?: return null
        val id = target.text("id") ?: return null
        return when (target.text("kind")) {
            "PROJECT" -> "orbit-project:$id"
            "TASK" -> "orbit-task:$id"
            "LIST" -> "orbit-list:$id"
            else -> null
        }
    }

    /** The owner's own comment a mention's reply was opened for, shown as theirs. */
    fun openingMention(card: JsonObject): String? = card.text("mention")?.takeIf { card.text("kind") == "MENTION" && it.isNotBlank() }
}
