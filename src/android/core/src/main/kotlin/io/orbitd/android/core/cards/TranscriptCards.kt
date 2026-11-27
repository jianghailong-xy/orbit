package io.orbitd.android.core.cards

import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*

/**
 * An exception item's delivery to the coordinator (`openItemDelivery`), as its card says it — OrbitKit's `OpenItemDeliveryCard`, word for
 * word, which the web's `OpenItemDeliveryCard.tsx` is held to. Nothing here is derived from the prose the agent read: every line comes from
 * the payload, and that prose stays one disclosure away. The card points at the item's own card, where its doors are pressed (board
 * card-ui-polish ②), rather than naming doors nobody can press here.
 */
object OpenItemDeliveryCopy {
    /** How many conflicting files the card lists before folding the rest away. */
    const val filesShown = 3
    /** The header every delivery is drawn under — what the turn is, before what it is about. */
    const val header = "Exception item"
    const val taskLabel = "Task"
    const val openTask = "Open the task ↗"
    const val openSession = "Open the failed session ↗"
    const val openLanding = "Open the landing ↗"
    /** The link to the item's own card, and what it says in a conversation that does not hold that card. */
    const val goToItemCard = "Go to the item card ↑"
    const val itemCardNotHere = "The item card is not in this conversation."
    /** The foot line: when the item was sent to the coordinator, in the person's own words. */
    const val sentToCoordinator = "Sent to the coordinator"
    const val undelivered = "The session has not confirmed it received this."
    /** The fold the paragraph the agent read stays behind — and, since the agent is the only reader of the item's id, the id with it. */
    const val rawSummary = "What the coordinator was told"

    /** What opened the item, named the way the rest of the product names it; a kind the web has no word for is the header's. */
    fun kindLabel(kind: String?): String = when (kind) {
        "INTEGRATION_CONFLICT" -> "Merge conflict"
        "INTEGRATION_CHECK_FAILED" -> "Checks failed"
        "INTEGRATION_ERROR" -> "Integration error"
        "TASK_FAILED" -> "Task failed"
        "PROMOTION_APPROVAL" -> "Merge approval"
        "COORDINATOR_QUESTION" -> "Question"
        "FUSE_PAUSED" -> "Project paused"
        else -> header
    }

    /** Why an attempt failed, in the words a reader acts on. */
    fun how(how: String?): String = when (how) {
        "ACCEPTANCE_EXIT_MISMATCH" -> "The acceptance command disagreed with what the task declared"
        "RUN_FAILED" -> "A turn of the run failed"
        "RUNNER_FINALIZED_FAILED" -> "The runner finished the run as failed"
        "REAPED_API_ERROR" -> "The run stopped on an API or sign-in error and was reaped"
        "ATTEMPT_LOST_RUNNER_OFFLINE" -> "Its runner went offline and the attempt was taken back"
        "ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED" -> "Its runtime never started and the attempt was taken back"
        "REPORTED_FAILED" -> "Somebody filed it as failed"
        else -> "The task failed"
    }

    /** The one line that says what happened, out of the kind's own fields; null for a kind whose fields say nothing the title did not.
     * A conflict names the branch by its name and leaves the agent's "will not retry" half in the disclosure. */
    fun headline(card: JsonObject): String? {
        val targetRef = card.text("targetRef")?.takeIf { it.isNotEmpty() }
        val target = targetRef?.let { " into $it" }.orEmpty()
        val failure = card.obj("failure")
        when (card.text("kind")) {
            "TASK_FAILED" -> if (failure != null && failure.number("attempt") != null && failure.number("limit") != null) {
                val exit = failure.number("exitCode")?.let { " — exit $it, expected ${failure.number("expectedExitCode") ?: 0}" }.orEmpty()
                return "${how(failure.text("how"))}$exit · attempt ${failure.number("attempt")} of ${failure.number("limit")} in this chain."
            }
            "INTEGRATION_CONFLICT" -> {
                val branch = targetRef?.removePrefix("refs/heads/").orEmpty()
                return if (branch.isNotEmpty()) "git refused the merge into $branch; $branch did not move."
                else "git refused the merge; the target branch did not move."
            }
            "INTEGRATION_CHECK_FAILED" -> card.obj("check")?.takeIf { !it.text("name").isNullOrEmpty() }?.let { check ->
                return "Check ${check.text("name")} exited ${check.number("exitCode") ?: "?"} where ${check.number("expectedExitCode") ?: "?"} " +
                    "was declared; the target branch did not move."
            }
            "INTEGRATION_ERROR" ->
                return "The integration job ended with ${card.text("errorCode")?.takeIf { it.isNotEmpty() } ?: "an error"}$target; the target branch did not move."
        }
        return null
    }

    /** What the platform already knew about the landing when it handed the item over, and whether that is a landing: no receipt is no
     * EVIDENCE, never "it did not land". */
    fun landingLine(card: JsonObject): Pair<String, Boolean>? {
        val landing = card.obj("landing") ?: return null
        val receipts = landing.number("receipts") ?: return null
        val upstream = landing.text("upstream") ?: "main"
        val integration = landing.text("integration") ?: "main"
        return when (landing.text("state")) {
            "ON_UPSTREAM" -> "Already on $upstream — a merge receipt records this work there." to true
            "ON_INTEGRATION_LINE" -> "On $integration, not yet on $upstream — a merge receipt records it on the project branch." to true
            "NOT_KNOWN" -> (if (receipts == 0) "No merge receipt for this work — Orbit cannot tell whether it has landed."
                else "$receipts merge receipt${if (receipts == 1) "" else "s"}, none naming $upstream — Orbit cannot tell whether this work has landed.") to false
            else -> null
        }
    }

    /** "Show 2 more files" / "Show fewer files"; null when every file is already on screen. */
    fun filesToggle(total: Int, expanded: Boolean): String? =
        if (total <= filesShown) null else if (expanded) "Show fewer files" else "Show ${total - filesShown} more files"

    /** "Sent to the coordinator · 3m ago", or null for a delivery with no clock. */
    fun meta(ts: String?, now: java.time.Instant = java.time.Instant.now()): String? =
        ts?.let { BackgroundWakeCard.relative(it, now) }?.let { "$sentToCoordinator · $it" }

    /** "Item 34ShSQc0zVFxWSokxZive", the id line inside the disclosure, in the public spelling the caller hands in. */
    fun rawItemId(publicId: String) = "Item $publicId"
}

/** Only the protocol's explicit projections produce cards. Agent prose cannot grant an action. */
fun transcriptCards(event: RunEvent): List<InteractionCard> = buildList {
    val payload = event.fields
    fun addProjection(field: String, title: String, family: CardFamily, required: List<String>) {
        val source = payload.obj(field) ?: return
        if (required.any { source.text(it).isNullOrBlank() }) return
        add(InteractionCard("record:${event.seq}:$field", family, title, source, "", objectId = "${event.seq}", binding = "", status = "Recorded"))
    }
    if (event.type == "user") {
        watchWake(payload.text("text").orEmpty())?.let { wake ->
            val title = when (wake.text("state")) { "MATCHED" -> "Watch triggered"; "EXPIRED" -> "Watch expired"; "REVOKED" -> "Watch stopped: access lost"; else -> "Watch stopped: every target is gone" }
            add(InteractionCard("record:${event.seq}:watch", CardFamily.BACKGROUND, title, wake, "", objectId = wake.text("watchId")!!, binding = "", status = "Recorded"))
        }
        // An Orbit workflow's end is its own strip (board docs/mocks/subagent-workflow part 4 ②), drawn before any other news the note carries.
        payload.text("controlPlaneNote")?.takeIf { WorkflowFinished.parse(it) != null }?.let { note ->
            add(InteractionCard("record:${event.seq}:workflow", CardFamily.BACKGROUND, "Workflow finished",
                buildJsonObject { put("note", note) }, "", objectId = "${event.seq}", binding = "", status = "Recorded"))
        }
        // A SubAgent's end: Orbit's turn, never the reader's bubble or the From Orbit line, and drawn as nothing — its card is the end
        // (docs/mocks/subagent-card-and-end-line). A wakeup the same note carries keeps its own line.
        payload.text("controlPlaneNote")?.takeIf { SubagentFinished.parse(it) != null }?.let { note ->
            add(InteractionCard("record:${event.seq}:subagent", CardFamily.BACKGROUND, "SubAgent ended",
                buildJsonObject { put("note", note) }, "", objectId = "${event.seq}", binding = "", status = "Recorded"))
        }
        // A background job's news or a wakeup coming due: Orbit's turn. Only the wakeup draws a line; a job's end, new output or stall
        // draws nothing, as its card says it (board C1, BgJob.wakeupsOnly).
        backgroundWake(payload.text("controlPlaneNote").orEmpty())?.let { wake ->
            add(InteractionCard("record:${event.seq}:wake", CardFamily.BACKGROUND, "Background update", wake, "", objectId = "${event.seq}", binding = "", status = "Recorded"))
        }
        // A failed landing handed to this task's own session (revision 42, W6): its card, never the reader's bubble. The server sends
        // the turn's words alone, so the card is read back from them (`LandingFixTurns`).
        payload.text("text")?.takeIf { LandingFixTurns.parse(it) != null }?.let { text ->
            add(InteractionCard("record:${event.seq}:landingFix", CardFamily.SESSION_REQUEST, LandingFixCopy.FROM_ORBIT_LANDING,
                buildJsonObject { put("text", text) }, "", objectId = "${event.seq}", binding = "", status = "Recorded"))
        }
        addProjection("confirmationReviewRequest", "Review requested", CardFamily.REVIEW, listOf("requestId", "taskId", "title", "runSessionId"))
        addProjection("confirmationReturn", "Sent back by the reviewer", CardFamily.REVIEW, listOf("requestId", "reason"))
        // The owner's answers handed to the reviewer once they confirmed (contract §7 Q5): "You confirmed", with at least one answer.
        if (payload.obj("confirmationAnswers")?.let(OwnerReview::confirmationAnswers)?.isNotEmpty() == true) {
            addProjection("confirmationAnswers", OwnerReview.youConfirmed, CardFamily.REVIEW, listOf("taskId", "title", "decidedAt"))
        }
        // Five more of Orbit's own turns (docs/mocks/orbit-turn-cards/, `OrbitTurnCards`): each its card, never the reader's bubble.
        fun addTurnCard(field: String, title: String, family: CardFamily, valid: (JsonObject) -> Boolean) {
            val source = payload.obj(field)?.takeIf(valid) ?: return
            add(InteractionCard("record:${event.seq}:$field", family, title, source, "", objectId = "${event.seq}", binding = "", status = "Recorded"))
        }
        addTurnCard("evidenceReview", OrbitTurnCards.evidenceToReview, CardFamily.REVIEW, OrbitTurnCards::isEvidenceReview)
        addTurnCard("evidenceSendBack", OrbitTurnCards.evidenceSentBack, CardFamily.REVIEW, OrbitTurnCards::isEvidenceSendBack)
        addTurnCard("runQuestion", OrbitTurnCards.questionFromRun, CardFamily.SESSION_REQUEST, OrbitTurnCards::isRunQuestion)
        addTurnCard("runNotice", OrbitTurnCards.noticeFromRun, CardFamily.SESSION_REQUEST, OrbitTurnCards::isRunNotice)
        addTurnCard("sessionOpening", "Orbit started this session", CardFamily.SESSION_REQUEST, OrbitTurnCards::isSessionOpening)
        addProjection("taskStart", "Task started", CardFamily.SESSION_REQUEST, listOf("taskId", "title"))
        // A payload that is not a card parses as nothing and leaves the turn the bubble it was (OrbitKit `ProjectStarted.parse`).
        addTurnCard("projectStarted", ProjectStartedCopy.startedLabel, CardFamily.SESSION_REQUEST) { ProjectStarted.parse(it) != null }
        addProjection("openItemDelivery", "Project item delivered", CardFamily.SESSION_REQUEST, listOf("itemId", "kind", "title"))
        // The owner's answer handed to the coordinator: one line that opens to the words the agent read (`OwnerAnswerLine`).
        payload.obj("ownerAnswer")?.takeIf(OwnerAnswerLine::isCard)?.let { answer ->
            add(InteractionCard("record:${event.seq}:ownerAnswer", CardFamily.SESSION_REQUEST, CoordinatorQueue.sent, answer, "",
                objectId = "${event.seq}", binding = "", status = "Recorded"))
        }
        // A fact told to this session — the coordinator told of one, or a session the answer to its criteria proposal: one line, its
        // sentence, that opens to the words the agent read (`CoordinatorDeliveryLine`).
        payload.obj("coordinatorDelivery")?.let { delivery -> CoordinatorDeliveryLine.parse(delivery)?.let { card ->
            add(InteractionCard("record:${event.seq}:coordinatorDelivery", CardFamily.SESSION_REQUEST, CoordinatorDeliveryLine.sentence(card),
                delivery, "", objectId = "${event.seq}", binding = "", status = "Recorded"))
        } }
        addProjection("sessionMessage", "Message from another session", CardFamily.SESSION_REQUEST, listOf("fromSessionId"))
        payload.objects("sessionReplies").forEach { row ->
            if (row.text("requestId").isNullOrBlank() || row.text("fromSessionId").isNullOrBlank() ||
                row.text("outcome") !in setOf("REPLIED", "NO_REPLY", "RECIPIENT_ENDED", "EXPIRED", "UNDELIVERED")) return@forEach
            add(InteractionCard("record:${event.seq}:reply:${row.text("requestId")}", CardFamily.SESSION_REQUEST,
                "Session reply · ${row.text("outcome")}", row, "", objectId = row.text("requestId")!!, binding = "", status = "Recorded"))
        }
    }
    if (event.type == "background_task") add(InteractionCard("record:${event.seq}:background", CardFamily.BACKGROUND,
        "Background work", payload, "", objectId = payload.text("taskId") ?: "${event.seq}", binding = "", status = payload.text("status")))
}
