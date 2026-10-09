package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * The review on an owner-confirmation card (A08-1; OrbitKit `OwnerConfirmationReview`, contract
 * docs/owner-confirmation-review-contract.md §5–§9): what the card's review bar draws for one review, what a press says
 * about it, and what a receipt lists afterwards. Read off `GET /tasks/:taskId/owner-confirmation`'s `waiting.review`, a
 * decision's `review`, and `reviewerReturns` — held to `src/shared/src/owner-confirmation-review.fixture.json`, the cases
 * the web and the Apple clients are proved against.
 */
object OwnerReview {
    // The words (OrbitKit `OwnerConfirmations`, web `OwnerConfirmationReview.tsx`).
    const val heading = "Confirm this task is done?"
    const val provenance = "From Orbit"
    const val yours = "You decide when this is done"
    const val sendBackHint = "Your next message goes to this agent. The task stays open."
    const val underReview = "Under review"
    const val reviewHeading = "REVIEW"
    const val reviewerFallback = "Reviewer"
    const val reviewingSincePrefix = "Reviewing since"
    const val reviewWillAsk = "Orbit will ask you once the review is in. You can still confirm now."
    const val reviewWillShowHere = "It will show here when it comes in."
    const val reviewNeedsYou = "Needs you: "
    const val reviewNothingNeedsYou = "nothing needs you"
    const val reviewChecked = "Checked"
    const val reviewNotChecked = "Not checked"
    const val reviewLeftOpen = "Left open"
    const val reviewProblem = "Problem"
    const val notReviewed = "Not reviewed"
    const val notReviewedTail = " Only the agent that did the work has checked this."
    const val notReviewedReviewerEnded = "The reviewer’s session ended before it answered."
    const val notReviewedReviewerStopped = "The reviewer stopped without answering."
    const val notReviewedCoordinatorPaused = "This project’s coordinator is paused."
    const val notReviewedAutomaticOff = "Automatic was switched off for this project."
    const val notReviewedNoCoordinator = "This project has no coordinator conversation."
    const val notReviewedUnreachable = "The reviewer could not be reached."
    const val reviewOutdated = "Outdated"
    const val reviewEarlierReport = "Written for an earlier report."
    const val showOldReview = "Show the old review"
    const val returnedToAgent = "Returned to the agent"
    const val returnedFooter = "The agent got this as its next message. You were not asked."
    const val sentBackByReviewer = "Sent back by the reviewer"
    const val reviewEvidence = "Evidence"
    const val answersSentWithConfirm = "Your answers are sent with Confirm done."
    const val yourAnswers = "Your answers"
    const val answerNotShown = "Not shown to you — the recommended answer was recorded."
    const val beforeReview = "Before the review came in"
    const val reviewRequested = "Review requested"
    const val openTaskSession = "Open task session"
    const val confirmedHeading = "Confirmed done"
    const val sentBackHeading = "Asked for more"
    const val showWhatSettledIt = "Show what counted as done"
    const val hideWhatSettledIt = "Hide what counted as done"
    const val recommended = "Recommended"
    const val otherOwnWords = "Other — say it in my own words"
    const val notRecorded = "Not recorded"
    const val notRecordedStale = "Not recorded: this card is out of date"

    /** The door's refusals that mean "this card is out of date" (`OWNER_CONFIRMATION_STALE_CODES`). */
    val staleCodes = listOf("OWNER_CONFIRMATION_STALE", "OWNER_CONFIRMATION_NOTHING_TO_SEND_BACK", "OWNER_CONFIRMATION_TASK_SETTLED",
        "OWNER_CONFIRMATION_REVIEW_STALE", "OWNER_CONFIRMATION_ANSWERS_REQUIRED")
    fun refusalTitle(code: String?) = if (code != null && code in staleCodes) notRecordedStale else notRecorded

    private val states = setOf("UNDER_REVIEW", "REVIEWED", "NOT_REVIEWED", "OUTDATED", "RETURNED")

    /** The review as this build can read it, or null: an unknown state, or a missing field the server always sends, costs the
     * bar and never the card. */
    fun readable(review: JsonElement?): JsonObject? {
        val value = review as? JsonObject ?: return null
        if (value.text("state") !in states || value.text("reviewId") == null || value.obj("reviewer") == null ||
            value.text("since") == null || value.text("dueAt") == null || value.number("windowSeconds") == null) return null
        return value
    }

    // the bar, as data

    enum class Place { CARD, RECEIPT }

    /** One line of the bar, in the order it is drawn (`ReviewBar.Line`). */
    data class Line(val kind: String, val text: String, val icon: String? = null, val warn: Boolean? = null,
        val row: String? = null, val label: String? = null, val keys: List<String>? = null) {
        fun json() = buildJsonObject {
            put("kind", kind); icon?.let { put("icon", it) }; put("text", text); warn?.let { put("warn", it) }
            row?.let { put("row", it) }; label?.let { put("label", it) }; keys?.let { k -> putJsonArray("keys") { k.forEach { add(it) } } }
        }
    }

    /** What the bar draws for one review (`ReviewBar`): the heading's reviewer, time and commit, its lines, the old review behind
     * `Show the old review`, and whether it offers Reopen task. */
    data class Bar(val reviewer: String, val time: String?, val sha: String?, val shaStruck: Boolean, val lines: List<Line>,
        val folded: List<Line> = emptyList(), val reopen: Boolean = false) {
        fun json() = buildJsonObject {
            put("reviewer", reviewer); put("time", time); put("sha", sha); put("shaStruck", shaStruck)
            put("lines", JsonArray(lines.map { it.json() })); put("folded", JsonArray(folded.map { it.json() })); put("reopen", reopen)
        }
    }

    fun reviewerName(title: String?): String = title?.trim()?.ifEmpty { null } ?: reviewerFallback

    /** A review window as `No answer within <window>.` says it: `30 min`, `2 h`, `1 h 30 min`. */
    fun windowWords(seconds: Int): String {
        val minutes = maxOf(1, Math.round(seconds / 60.0).toInt())
        val hours = minutes / 60
        val rest = minutes % 60
        if (hours == 0) return "$rest min"
        return if (rest == 0) "$hours h" else "$hours h $rest min"
    }

    /** Why nobody reviewed it, then who has checked it; a reason this build does not know says the second half alone. */
    fun notReviewedNote(reason: String?, windowSeconds: Int): String {
        val why = when (reason) {
            "TIMED_OUT" -> "No answer within ${windowWords(windowSeconds)}."
            "REVIEWER_ENDED" -> notReviewedReviewerEnded
            "REVIEWER_STOPPED" -> notReviewedReviewerStopped
            "COORDINATOR_PAUSED" -> notReviewedCoordinatorPaused
            "AUTOMATIC_OFF" -> notReviewedAutomaticOff
            "NO_COORDINATOR" -> notReviewedNoCoordinator
            "UNREACHABLE" -> notReviewedUnreachable
            else -> ""
        }
        return "$why$notReviewedTail".trim()
    }

    fun problemsFoundLine(problems: Int) = if (problems == 1) "1 problem found after you confirmed" else "$problems problems found after you confirmed"

    /** What the bar draws for one review, where it is drawn (§6 H3, §8 B6, §9 L3). [clock] writes an instant as the card writes
     * its times, and answers null for one it cannot read. */
    fun bar(review: JsonObject, place: Place, clock: (String) -> String?): Bar {
        fun bar(time: String?, sha: String?, lines: List<Line>, shaStruck: Boolean = false, folded: List<Line> = emptyList(), reopen: Boolean = false) =
            Bar(reviewerName(review.obj("reviewer")?.text("title")), time, shortSha(sha), shaStruck, lines, folded, reopen)
        // Under a receipt, problems found after the confirmation outrank whatever state the review is in.
        val found = review.obj("problems")
        if (place == Place.RECEIPT && found != null) {
            return bar(found.text("recordedAt")?.let(clock), found.text("reviewedSha"),
                listOf(Line("HEADLINE", problemsFoundLine(found.objects("problems").size), warn = true)) + problemRows(found.objects("problems")), reopen = true)
        }
        val record = review.obj("review")
        return when (review.text("state")) {
            "UNDER_REVIEW" -> bar(null, null, listOf(
                Line("STATUS", review.text("since")?.let(clock)?.let { "$reviewingSincePrefix $it" } ?: underReview, icon = "CLOCK", warn = false),
                Line("NOTE", if (place == Place.CARD) reviewWillAsk else reviewWillShowHere)))
            "NOT_REVIEWED" -> bar(null, null, listOf(
                Line("STATUS", notReviewed, icon = "DASH", warn = false),
                Line("NOTE", notReviewedNote(review.text("notReviewedReason"), review.number("windowSeconds") ?: 0))))
            "RETURNED" -> {
                val returned = review.obj("returned")
                val lines = buildList {
                    add(Line("STATUS", returnedToAgent, warn = false))
                    returned?.text("reason")?.takeIf { it.isNotBlank() }?.let { add(Line("QUOTE", it)) }
                    addAll(problemRows(returned?.objects("problems").orEmpty()))
                    add(Line("FOOTER", returnedFooter))
                }
                bar(returned?.text("recordedAt")?.let(clock), returned?.text("reviewedSha"), lines)
            }
            "OUTDATED" -> {
                val outdated = review.obj("outdated")
                val reviewed = shortSha(record?.text("reviewedSha"))
                val now = shortSha(outdated?.text("branchSha"))
                val note = when {
                    outdated?.text("cause") == "NEWER_REPORT" -> reviewEarlierReport
                    reviewed != null && now != null -> "Written for $reviewed. The branch is at $now now, so this says nothing about the last commit."
                    else -> null
                }
                bar(record?.text("recordedAt")?.let(clock), record?.text("reviewedSha"),
                    listOfNotNull(Line("STATUS", reviewOutdated, warn = true), note?.let { Line("NOTE", it) }),
                    shaStruck = true, folded = recordLines(review, answers = false))
            }
            else -> bar(record?.text("recordedAt")?.let(clock), record?.text("reviewedSha"), recordLines(review, answers = place == Place.CARD))
        }
    }

    /** A REVIEW record's lines in their order: Orbit's first line, the card's answers, the lists, the reviewer's quote. */
    private fun recordLines(review: JsonObject, answers: Boolean): List<Line> {
        val record = review.obj("review") ?: return emptyList()
        return buildList {
            headline(review, record)?.let { add(it) }
            if (answers && record.objects("needsYou").isNotEmpty()) add(Line("ANSWERS", ""))
            listOf(Triple("CHECKED", reviewChecked, "checked"), Triple("NOT_CHECKED", reviewNotChecked, "notChecked"),
                Triple("LEFT_OPEN", reviewLeftOpen, "leftOpen")).forEach { (row, label, key) ->
                val items = record.objects(key)
                if (items.isNotEmpty()) add(Line("ROW", items.joinToString(" · ") { it.text("text").orEmpty() }, row = row, label = label,
                    keys = items.map { it.text("key").orEmpty() }))
            }
            record.text("judgment")?.takeIf { it.isNotBlank() }?.let { add(Line("QUOTE", it)) }
        }
    }

    /** The record's own headline: the server's, unless that one is about problems found later; otherwise worked out here. */
    private fun headline(review: JsonObject, record: JsonObject): Line? {
        val server = review.obj("headline")?.takeIf { it.text("kind") in setOf("NEEDS_YOU", "NOTHING_NEEDS_YOU") }
        return when {
            server?.text("kind") == "NEEDS_YOU" -> needsYouLine(server.text("text").orEmpty(), server.number("more") ?: 0)
            server != null -> nothingNeedsYouLine(server.number("notChecked") ?: 0)
            record.objects("needsYou").isNotEmpty() -> needsYouLine(record.objects("needsYou").first().text("text").orEmpty(), record.objects("needsYou").size - 1)
            else -> nothingNeedsYouLine(record.objects("notChecked").size)
        }
    }
    private fun needsYouLine(text: String, more: Int) = Line("HEADLINE", if (more > 0) "$reviewNeedsYou$text (+$more more)" else "$reviewNeedsYou$text", warn = true)
    private fun nothingNeedsYouLine(notChecked: Int) = Line("HEADLINE", "$notChecked not checked · $reviewNothingNeedsYou", warn = false)

    /** One row per problem: each is a thing to fix, not one of a list. */
    private fun problemRows(problems: List<JsonObject>) = problems.map {
        Line("ROW", it.text("text").orEmpty(), row = "PROBLEM", label = reviewProblem, keys = listOf(it.text("key").orEmpty()))
    }

    private fun shortSha(sha: String?) = sha?.takeIf { it.isNotEmpty() }?.take(7)

    /** Every item the bar's rows can name, by key: the review's lists, its questions and either kind of problem. */
    fun itemsByKey(review: JsonObject): Map<String, JsonObject> = buildMap {
        review.obj("review")?.let { record ->
            (record.objects("checked") + record.objects("notChecked") + record.objects("leftOpen") + record.objects("needsYou"))
                .forEach { item -> item.text("key")?.let { put(it, item) } }
        }
        (review.obj("returned")?.objects("problems").orEmpty() + review.obj("problems")?.objects("problems").orEmpty())
            .forEach { item -> item.text("key")?.let { put(it, item) } }
    }

    // the owner's answers (§7)

    /** The questions the card asks: those of a review it draws as REVIEWED. An outdated review's old questions are not answerable. */
    fun questions(review: JsonObject?): List<JsonObject> =
        if (review?.text("state") == "REVIEWED") review.obj("review")?.objects("needsYou").orEmpty() else emptyList()

    /** What a question is answered with now: the owner's choice, or its recommendation untouched. */
    fun choice(question: JsonObject, choices: List<OwnerAnswer>): OwnerAnswer {
        val key = question.text("key").orEmpty()
        return choices.lastOrNull { it.key == key } ?: OwnerAnswer(key, question.number("recommendedOption"))
    }

    /** What a confirmation from the card says about the review it drew (§7 Q3): the record it showed — the old one, for an outdated
     * review — and an answer to each of that record's questions, exactly one of `option` and `text`. */
    fun answered(review: JsonObject?, choices: List<OwnerAnswer>): Pair<JsonElement, List<JsonObject>> {
        if (review?.text("state") !in setOf("REVIEWED", "OUTDATED")) return JsonNull to emptyList()
        val answers = questions(review).map { question ->
            val chosen = choice(question, choices)
            buildJsonObject {
                put("key", question.text("key").orEmpty())
                if (chosen.option != null) put("option", chosen.option) else put("text", chosen.text.orEmpty().trim())
            }
        }
        return (review!!.obj("review")?.get("recordId") ?: JsonNull) to answers
    }

    /** Whether every question has an answer the door would take: an Other with no words has none, and Confirm done waits (§6 H4). */
    fun complete(review: JsonObject?, choices: List<OwnerAnswer>): Boolean =
        questions(review).all { question -> choice(question, choices).let { it.option != null || !it.text.isNullOrBlank() } }

    /** The receipt's `Your answers`: each question, then what was chosen or said (§7 Q5); the flag marks an answer an app
     * recorded for the owner without showing them the question. */
    fun answerLines(decided: JsonObject): List<Pair<String, Boolean>> {
        val questions = decided.obj("review")?.obj("review")?.objects("needsYou").orEmpty().associateBy { it.text("key") }
        return decided.objects("answers").map { answer ->
            val key = answer.text("key").orEmpty()
            val question = questions[key]
            val option = answer.number("option")
            val said = if (option != null) question?.objects("options")?.getOrNull(option)?.text("label") ?: "${option + 1}"
                else answer.text("text").orEmpty()
            "${question?.text("text") ?: key} — $said" to (answer.text("source") == "NOT_SHOWN")
        }
    }

    /** Whether the review's first record came in after the decision: `Before the review came in`. */
    fun cameInAfter(decided: JsonObject): Boolean {
        val review = decided.obj("review") ?: return false
        val at = parse(decided.text("decidedAt")) ?: return false
        val first = listOf(review.obj("review")?.text("recordedAt"), review.obj("returned")?.text("recordedAt"),
            review.obj("problems")?.text("recordedAt")).mapNotNull(::parse).minOrNull() ?: return false
        return first > at
    }

    /** The receipt's line: which answer, by whom, and when. */
    fun receiptLine(decided: JsonObject, time: String?): String {
        val action = if (decided.text("decision") == "CONFIRM") confirmedHeading else sentBackHeading
        return if (time == null) "$action by you" else "$action by you · $time"
    }

    /** The moment as every review surface writes it: "16:00", or "9/10 16:00" on another day — a fixed 24-hour clock in the
     * device's zone (OrbitKit `receiptTime`); null for an instant it cannot read. */
    fun receiptTime(iso: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? {
        val at = parse(iso)?.atZone(zone) ?: return null
        val clock = "%02d:%02d".format(at.hour, at.minute)
        return if (at.toLocalDate() == ZonedDateTime.ofInstant(now, zone).toLocalDate()) clock else "${at.monthValue}/${at.dayOfMonth} $clock"
    }

    /** Whether a receipt's Reopen task may be offered: the bar found problems, and the task has settled. */
    fun reopenOffered(status: String?) = status in setOf("DONE", "CANCELLED", "FAILED")

    /** The reports of this session's run that its reviewer sent back: each was a card here, and is drawn as the record it became. */
    fun returnsIn(view: JsonObject?, sessionId: String): List<JsonObject> =
        view?.objects("reviewerReturns").orEmpty().filter { it.text("sessionId") == sessionId && readable(it["review"]) != null }

    private fun parse(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }
}
