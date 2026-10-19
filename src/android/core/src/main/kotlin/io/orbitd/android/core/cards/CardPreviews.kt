package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId

/** The tone a card's preview is drawn in (iOS `ApprovalTone`). */
enum class PreviewTone { BLUE, PURPLE, ORANGE }

/** A long decision card as the conversation shows it: its heading, its summary in a few lines, and the press that opens it whole
 * (A08-2; iOS `ApprovalReviewLayout`'s compact preview). A dimmed one is no longer a question, and only opens to be read. */
data class CardPreview(val title: String, val summary: String, val tone: PreviewTone, val dimmed: Boolean = false, val badge: String? = null) {
    val label: String get() = if (dimmed) CardPreviews.viewDetails else CardPreviews.viewDetailsAndAct
}

/** What this window pressed in an open review: the card as it was drawn, the press, what was picked or typed with it and when —
 * and, once the door answered, what it said ([state]), kept whatever the reads do to the card after it. */
data class CardPress(val card: InteractionCard, val verb: CardVerb, val input: CardInput, val at: Instant, val state: CardActionState? = null)

/** A review's record (`CardPreviews.record`): its title, and the footer where its buttons were — a round [icon], who did what and
 * when, and what came of it where this window knows. */
data class CardRecord(val title: String, val icon: Icon, val line: String, val detail: String?) {
    enum class Icon { CHECK, KEPT, REFUSED }
}

/**
 * Which cards are previews in the conversation, and what a preview says (A08-2; iOS 629e8b87d, 5a2458531). The rule is by kind,
 * never by length: a question, a plan, a batch or a restructure the server previewed, a blocker to resolve, an owner confirmation
 * and the record a reviewer's return left, a criteria decision, the project's criteria, its start, a coordinator's question and a
 * merge to main open into a full-height review where they are answered. Everything else — a tool call, a provider write, a single
 * create, the merge-check change, evidence, an exception, every receipt — stays whole in the conversation.
 */
object CardPreviews {
    const val viewDetails = "View details"
    const val viewDetailsAndAct = "View details & act"
    const val close = "Close"
    const val sending = "Sending your answer…"
    const val sendingTitle = "Sending"
    const val decisionRecorded = "Decision recorded"
    const val answeredTitle = "Answered"
    const val sentToTheAgent = "Sent to the agent"
    const val runningThePlan = "The agent is running the plan"
    const val goesOnPlanning = "The agent goes on planning"
    const val yourAnswer = "YOUR ANSWER"
    const val requestClosed = "Request closed"
    const val noLongerWaiting = "This request is no longer waiting for an answer."
    const val noLongerOnOffer = "This merge is no longer on offer"

    /** The status a card keeps once the server stopped publishing it (`SessionCards`' stale copies). */
    const val stale = "No longer pending · check the server record"

    fun preview(card: InteractionCard): CardPreview? {
        if (card.key.startsWith("receipt:")) return null
        val input = card.source.obj("input") ?: emptyObject
        // A copy kept after the server stopped publishing it asks nothing any more.
        val gone = card.status == stale
        return when (card.family) {
            CardFamily.QUESTION -> {
                val questions = approvalQuestions(input)
                CardPreview("A question for you", "${questions.size} question${if (questions.size == 1) "" else "s"}\n${questions.firstOrNull()?.question.orEmpty()}",
                    PreviewTone.BLUE, gone)
            }
            CardFamily.PLAN -> CardPreview("Review this plan", plainText(input.text("plan") ?: "Plan ready for review."), PreviewTone.PURPLE, gone)
            CardFamily.BATCH -> input.obj("preview")?.let { preview ->
                CardPreview(batchTitle(preview.number("taskCount") ?: preview.objects("tasks").size), batchImpactLines(preview).joinToString(" · "),
                    PreviewTone.ORANGE, gone)
            }
            CardFamily.DAG -> input.obj("preview")?.let { preview ->
                CardPreview("Restructure dependencies in ${preview.text("listTitle") ?: "this list"}?",
                    "${preview.objects("ops").size} changes · ${preview.number("edgesBefore") ?: 0} → ${preview.number("edgesAfter") ?: 0} edges",
                    PreviewTone.ORANGE, gone)
            }
            CardFamily.BLOCKER -> CardPreview("Resolve blocker", input.obj("blocker")?.text("requiredAction").orEmpty(), PreviewTone.ORANGE, gone)
            CardFamily.OWNER_CONFIRMATION -> when (card.context.text("ownerCard")) {
                "question" -> CardPreview(OwnerReview.heading, ownerSummary(card), PreviewTone.BLUE, gone || card.actions.isEmpty())
                "returned" -> CardPreview(OwnerReview.heading, ownerSummary(card), PreviewTone.BLUE, dimmed = true)
                else -> null
            }
            CardFamily.CRITERIA_CHANGE -> CardPreview("Weaken this ruler?", changeSummary(card.source.obj("diff")), PreviewTone.ORANGE,
                gone || card.actions.isEmpty(), if (card.actions.isEmpty()) null else "criteria")
            CardFamily.ACCEPTANCE -> {
                val changes = card.source.obj("changesSinceConfirmed")
                val items = card.context.objects("acceptanceCriteriaItems").size
                if (card.source.text("state") == "STALE" && changes != null && card.context["startedAt"].let { it != null && it != JsonNull })
                    CardPreview("Confirm the new criteria?", "What changed · ${listOf("added", "stricter", "revised").sumOf { changes.objects(it).size }}",
                        PreviewTone.BLUE, gone || card.actions.isEmpty())
                else CardPreview("When is this project done?", "${card.context.text("title").orEmpty()} · $items criteria", PreviewTone.BLUE,
                    gone || card.actions.isEmpty())
            }
            CardFamily.START -> {
                val items = card.context.objects("acceptanceCriteriaItems").size
                val plan = card.context.obj("plan")
                val tasks = plan?.number("taskCount") ?: plan?.objects("marks")?.count { it.text("kind") == "TASK" } ?: 0
                CardPreview("Start this project?", "${card.context.text("title").orEmpty()} · $items criteria · $tasks tasks", PreviewTone.BLUE, gone)
            }
            CardFamily.OWNER_QUESTION -> {
                val open = !gone && card.source.text("assignee") == "OWNER"
                CardPreview("The coordinator has a question", if (open) card.source.obj("question")?.text("question") ?: card.source.text("detailLine").orEmpty()
                    else "This question is no longer open.", PreviewTone.BLUE, !open)
            }
            CardFamily.PROMOTION -> promotion(card, gone)
            else -> null
        }
    }

    /** "Create 3 tasks?" — iOS writes the plural whatever the count (`ToolApprovalCard.reviewTitle`). */
    fun batchTitle(count: Int) = "Create $count tasks?"

    private fun ownerSummary(card: InteractionCard) = (card.context.obj("view") ?: card.source).text("title") ?: card.objectId

    /** "2 reworded, 1 dropped, 1 added, 5 unchanged" (OrbitKit `CriteriaDecisions.changeSummary`). */
    fun changeSummary(diff: JsonObject?): String {
        if (diff == null || diff.objects("entries").isEmpty()) return "nothing this reader could read"
        val moved = buildList {
            (diff.number("changedCount") ?: 0).takeIf { it > 0 }?.let { add("$it reworded") }
            (diff.number("removedCount") ?: 0).takeIf { it > 0 }?.let { add("$it dropped") }
            (diff.number("newCount") ?: 0).takeIf { it > 0 }?.let { add("$it added") }
        }
        return "${if (moved.isEmpty()) "nothing moves" else moved.joinToString(", ")}, ${diff.number("sameCount") ?: 0} unchanged"
    }

    /** The merge to main as the conversation previews it (OrbitKit `PromotionCards.previewTitle`, `previewCounts`, `previewChecks`). */
    private fun promotion(card: InteractionCard, gone: Boolean): CardPreview {
        val view = card.source
        val into = PromotionCards.shortRef(view.text("upstreamRef") ?: "main")
        val state = view.text("state")
        val title = when {
            gone -> noLongerOnOffer
            state == "READY" -> "Merge to $into"
            state in setOf("CONFIRMED", "RECHECKING") -> "${PromotionCards.mergingActionLabel(view)} · $into"
            state == "BLOCKED" -> "Merge to $into blocked"
            state == "MERGED" -> "✓ Merged into $into"
            else -> noLongerOnOffer
        }
        val tasks = view.objects("tasks").size.takeIf { it > 0 } ?: view.strings("taskIds").size
        val taskCount = "$tasks task${if (tasks == 1) "" else "s"}"
        val counts = view.number("commitsAhead")?.let { "$it commit${if (it == 1) "" else "s"} · $taskCount" } ?: taskCount
        val checks = view.objects("checks")
        val checked = when {
            checks.isEmpty() -> "No checks recorded"
            checks.any { it.flag("timedOut") } -> "Checks timed out"
            checks.all { it.flag("passed") } -> "✓ Checks passed"
            else -> "✕ Checks failed"
        }
        val summary = listOf(PromotionCards.shortRef(view.text("sourceRef").orEmpty()), counts, if (state == "READY") checked else null)
            .filterNot { it.isNullOrBlank() }.joinToString("\n")
        val asking = !gone && state == "READY"
        return CardPreview(title, summary, PreviewTone.ORANGE, !asking, if (asking) "Needs you" else null)
    }

    /** A field written as Markdown, as plain text that keeps its lines (OrbitKit `OwnerConfirmations.plainText`). */
    fun plainText(markdown: String?): String {
        var text = markdown?.takeIf { it.isNotEmpty() } ?: return ""
        fun replace(pattern: String, with: String) { text = Regex(pattern).replace(text, with) }
        replace("\\r\\n?", "\n")
        replace("(?m)^[ \\t]*(?:`{3,}|~{3,}).*$", "")
        replace("(?m)^[ \\t]*(?:(?:\\*[ \\t]*){3,}|(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,})$", "")
        replace("(?m)^[ \\t]*=+[ \\t]*$", "")
        replace("(?m)^[ \\t]{0,3}#{1,6}[ \\t]+", "")
        replace("(?m)[ \\t]+#+[ \\t]*$", "")
        replace("(?m)^[ \\t]*(?:>[ \\t]?)+", "")
        replace("(?m)^([ \\t]*)[-*+][ \\t]+", "$1• ")
        replace("!\\[([^\\]]*)\\]\\([^)]*\\)", "$1")
        replace("\\[([^\\]]*)\\]\\([^)]*\\)", "$1")
        replace("\\[([^\\]]*)\\]\\[[^\\]]*\\]", "$1")
        replace("<((?:https?|mailto):[^>\\s]+)>", "$1")
        replace("(`+)([^`]*?)\\1", "$2")
        replace("(\\*{1,3})(\\S(?:[^*]*\\S)?)\\1", "$2")
        replace("~~(\\S(?:[^~]*\\S)?)~~", "$1")
        replace("(^|[^\\p{L}\\p{N}_])(_{1,2})(\\S(?:[^_]*\\S)?)\\2(?![\\p{L}\\p{N}_])", "$1$3")
        text = text.replace("`", "")
        replace("(?m)[ \\t]+$", "")
        replace("\\n{3,}", "\n\n")
        return text.trim()
    }

    // The record (the owner's boards record-1…8): once this window's own press is recorded the review stays open, its card read-only
    // as it was asked, and where its buttons were, who did what and when. It lives only while the review is open.

    enum class Phase { CARD, SENDING, RECORDED, CLOSED }

    private val allows = setOf(CardVerb.ALLOW, CardVerb.REMEMBER, CardVerb.ANSWER, CardVerb.APPROVE_PLAN, CardVerb.CREATE_TASK,
        CardVerb.CREATE_PROJECT, CardVerb.CREATE_BATCH, CardVerb.CHANGE_DAG, CardVerb.RESOLVE_BLOCKER)
    private val denies = setOf(CardVerb.DENY, CardVerb.KEEP_PLANNING, CardVerb.CHAT)

    /**
     * What the review draws for a card after [pressed] was sent from it. An approval is "Sending your answer…" while it goes, then
     * its record — but only when the decision the server recorded is this press's: when another end answered first, the card
     * stays and says what was recorded. A Chat about this or a Deny that went through closes the review, as it did before. A
     * decision card is its record once the server took it. Anything uncertain, refused or not pressed here is the card itself.
     */
    fun phase(card: InteractionCard, state: CardActionState, pressed: CardVerb?): Phase {
        if (pressed == null || state.uncertain) return Phase.CARD
        if (card.key.startsWith("approval:")) {
            if (state.busy) return Phase.SENDING
            if (!state.settled) return Phase.CARD
            val recorded = state.response?.text("status")
            return when {
                recorded == "ALLOWED" && pressed in allows || recorded == "DENIED" && pressed == CardVerb.KEEP_PLANNING -> Phase.RECORDED
                recorded == "DENIED" && pressed in denies -> Phase.CLOSED
                else -> Phase.CARD
            }
        }
        val decision = card.family in setOf(CardFamily.CRITERIA_CHANGE, CardFamily.ACCEPTANCE, CardFamily.START) ||
            card.family == CardFamily.OWNER_CONFIRMATION && pressed == CardVerb.CONFIRM_OWNER
        return if (decision && state.settled && !state.busy) Phase.RECORDED else Phase.CARD
    }

    /**
     * The record [card] became under this window's [pressed], sent [at] and answered with [state]: the review's title and the
     * footer where its buttons were. The time is the server's where its answer says it, the press's otherwise; a detail this
     * window cannot know — a seal the answer did not carry, a report with no time — is left out rather than guessed.
     */
    fun record(card: InteractionCard, pressed: CardVerb, state: CardActionState, at: Instant, now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault()): CardRecord {
        val response = state.response ?: emptyObject
        fun time(iso: String?) = listOfNotNull(iso, at.toString()).firstNotNullOfOrNull { OwnerReview.receiptTime(it, now, zone) }.orEmpty()
        fun byYou(verb: String, iso: String? = response.text("decidedAt")) = "$verb by you · ${time(iso)}"
        if (card.key.startsWith("approval:")) return when {
            pressed == CardVerb.KEEP_PLANNING ->
                CardRecord(answeredTitle, CardRecord.Icon.KEPT, "Kept planning · by you · ${time(response.text("decidedAt"))}", goesOnPlanning)
            card.family == CardFamily.QUESTION -> CardRecord(answeredTitle, CardRecord.Icon.CHECK, byYou("Answered"), sentToTheAgent)
            card.family == CardFamily.PLAN -> CardRecord(answeredTitle, CardRecord.Icon.CHECK, byYou("Approved"), runningThePlan)
            else -> CardRecord(answeredTitle, CardRecord.Icon.CHECK, byYou("Approved"), sentToTheAgent)
        }
        return when (card.family) {
            CardFamily.OWNER_CONFIRMATION -> CardRecord(OwnerReview.confirmedHeading, CardRecord.Icon.CHECK, byYou(OwnerReview.confirmedHeading),
                (card.context.obj("view") ?: card.source).obj("waiting")?.obj("report")?.text("reportedAt")
                    ?.let { OwnerReview.receiptTime(it, now, zone) }?.let { "Recorded on the $it report" })
            CardFamily.START -> {
                val count = response.number("criteriaCount") ?: card.context.objects("acceptanceCriteriaItems").size
                val seal = response.text("criteriaDigest") ?: card.source.obj("startRequest")?.text("criteriaDigest")
                CardRecord(decisionRecorded, CardRecord.Icon.CHECK, byYou("Started", response.text("startedAt")),
                    seal?.let { "On ${criteriaCount(count)} at seal ${shortSeal(it)}" })
            }
            CardFamily.ACCEPTANCE -> {
                val version = response.obj("currentVersion")
                val count = version?.objects("material")?.takeIf { it.isNotEmpty() }?.size ?: card.context.objects("acceptanceCriteriaItems").size
                // What changed is the card's as it was asked: once confirmed, the server has nothing changed left to say.
                val changes = changesLine(card.source.obj("changesSinceConfirmed")?.takeIf { card.source.text("state") == "STALE" })
                CardRecord(decisionRecorded, CardRecord.Icon.CHECK, byYou("Confirmed", response.obj("confirmation")?.text("confirmedAt")),
                    "${criteriaCount(count)} at seal ${shortSeal(version?.text("digest") ?: card.binding)}" + (changes?.let { " — $it" } ?: ""))
            }
            // The criteria decision ("Weaken this ruler?"): its two answers, and the seals the server says they left.
            else -> {
                val base = response.text("baseSeal") ?: card.source.text("currentSeal")
                if (pressed == CardVerb.REJECT_CRITERIA) CardRecord(decisionRecorded, CardRecord.Icon.REFUSED, byYou("Refused"),
                    base?.let { "The criteria stay at seal ${shortSeal(it)}" })
                else CardRecord(decisionRecorded, CardRecord.Icon.CHECK, byYou("Approved"),
                    response.text("resultingSeal")?.let { resulting -> base?.let { "Re-sealed: ${shortSeal(it)} → ${shortSeal(resulting)}" } })
            }
        }
    }

    /** "1 new, 1 stricter": what moved since the criteria were last confirmed, by kind (OrbitKit `CriteriaChanges.summary`). */
    private fun changesLine(changes: JsonObject?): String? = changes?.let { moved ->
        listOf("added" to "new", "stricter" to "stricter", "revised" to "changed", "removed" to "removed")
            .mapNotNull { (key, word) -> moved.objects(key).size.takeIf { it > 0 }?.let { "$it $word" } }.joinToString(", ").ifEmpty { null }
    }

    /** "1 criterion", "3 criteria" (OrbitKit `ReviewRecords`). */
    private fun criteriaCount(count: Int) = "$count ${if (count == 1) "criterion" else "criteria"}"

    /** A seal as the cards name it (`StartProjectCopy.shortSeal`, OrbitKit `CriteriaDecisions.shortSeal`). */
    private fun shortSeal(seal: String) = if (seal.isEmpty()) "(unreadable)" else seal.take(12)
}
