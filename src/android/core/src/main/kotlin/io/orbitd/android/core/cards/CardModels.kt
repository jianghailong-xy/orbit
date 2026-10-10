package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.SessionSnapshot
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
fun JsonObject.obj(key: String): JsonObject? = get(key) as? JsonObject
fun JsonObject.objects(key: String): List<JsonObject> = (get(key) as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
fun JsonObject.strings(key: String): List<String> = (get(key) as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
fun JsonObject.flag(key: String): Boolean = (get(key) as? JsonPrimitive)?.booleanOrNull == true
fun JsonObject.number(key: String): Int? = (get(key) as? JsonPrimitive)?.intOrNull
internal val emptyObject = JsonObject(emptyMap())

@Serializable
data class ApprovalDto(val id: String, val sessionId: String? = null, val toolName: String,
    val input: JsonObject = emptyObject, val status: String, val expiresAt: String? = null)
@Serializable
data class QuestionOption(val label: String, val description: String? = null)
@Serializable
data class CardQuestion(val question: String, val header: String? = null,
    val options: List<QuestionOption> = emptyList(), val multiSelect: Boolean = false)
@Serializable
data class ApprovalDecision(val behavior: String, val message: String? = null,
    val answers: Map<String, List<String>>? = null, val rememberRules: List<PermissionRule>? = null)
@Serializable
data class EvidenceDecision(val decidingSessionId: String, val evidenceRevision: String, val decision: String, val note: String? = null)
@Serializable
data class CriteriaDecision(val commitToken: String, val decision: String, val baseSeal: String)
@Serializable
data class OwnerAnswer(val key: String, val option: Int? = null, val text: String? = null)
@Serializable
data class ProjectStartSettings(val line: String, val automatic: Boolean, val maxConcurrentTasks: Int,
    val mergeCheckCommand: String?, val projectBranchName: String? = null)

enum class CardFamily {
    TOOL, QUESTION, PLAN, CREATE, BATCH, DAG, BLOCKER, PROVIDER,
    EVIDENCE, OWNER_CONFIRMATION, REVIEW, CRITERIA_CHANGE, ACCEPTANCE, START,
    OWNER_QUESTION, EXCEPTION, PROMOTION, WIKI, SESSION_REQUEST, BACKGROUND,
    /** A revision waiting for its project's paused coordinator, or sent to it once back (`CoordinatorQueue`). */
    COORDINATOR_QUEUE,
}

enum class CardVerb(val label: String) {
    ALLOW("Allow"), DENY("Deny"), REMEMBER("Allow & remember"), ANSWER("Submit"),
    APPROVE_PLAN("Approve & run"), KEEP_PLANNING("Keep planning"), CREATE_TASK("Create task"),
    CREATE_PROJECT("Create project"), CREATE_BATCH("Create tasks"), CHANGE_DAG("Apply changes"),
    RESOLVE_BLOCKER("Resolve blocker"), CHAT("Chat about this"), CONFIRM_EVIDENCE("Confirm done"),
    SEND_BACK("Send back"), CONFIRM_OWNER("Confirm done"), APPROVE_CRITERIA("Approve changes"),
    REJECT_CRITERIA("Keep current criteria"), CONFIRM_CRITERIA("Confirm criteria"), START("Start project"),
    OWNER_ANSWER("Send answer"), RETURN_COORDINATOR("Ask the coordinator again"), RESUME("Resume"),
    MARK_HANDLED("Mark as handled"), RETRY_TASK("Retry task"), CANCEL_TASK("Cancel task"),
    CONFIRM_MERGE("Merge"), DECLINE_MERGE("Not now"), CANCEL_MERGE("Cancel merge"),
    WIKI_ACCEPT("Accept"), WIKI_EDIT("Save edit"), WIKI_REJECT("Reject"), WIKI_CONFIRM("Confirm entry"),
    WIKI_REVERT("Revert run"), WIKI_REJECT_ENTRY("Reject entry"), PLAN_CONFIRM("Confirm plan"), PLAN_ACCEPT("Accept proposal"), PLAN_REJECT("Reject proposal"),
    WIKI_RECONFIRM("Re-confirm entry"), WIKI_AMEND("Amend entry"), WIKI_RETIRE("Retire entry"),
    WATCH_PAUSE("Pause watch"), WATCH_RESUME("Resume watch"), WATCH_CANCEL("Cancel watch"),
    REOPEN_TASK("Reopen"), DECIDE_MYSELF("Decide it myself"),
}

/** The server address and the exact version drawn. No action is inferred from an event's prose. */
data class InteractionCard(
    val key: String, val family: CardFamily, val title: String, val source: JsonObject,
    val sessionId: String, val projectId: String? = null, val objectId: String,
    val binding: String, val actions: List<CardVerb> = emptyList(), val status: String? = null,
    val context: JsonObject = emptyObject,
)

data class CardInput(val text: String = "", val selections: Map<String, List<String>> = emptyMap(),
    val custom: Map<String, String> = emptyMap(), val ownerAnswers: List<OwnerAnswer> = emptyList(),
    val option: Int? = null, val settings: ProjectStartSettings? = null,
    val edited: JsonObject? = null, val reason: String? = null, val triggerId: String? = null)

fun approvalFamily(tool: String): CardFamily = when (tool) {
    "AskUserQuestion" -> CardFamily.QUESTION
    "ExitPlanMode" -> CardFamily.PLAN
    "orbit_task_create", "orbit_project_create" -> CardFamily.CREATE
    "orbit_task_batch" -> CardFamily.BATCH
    "orbit_dag_change" -> CardFamily.DAG
    "orbit_blocker_resolve" -> CardFamily.BLOCKER
    "orbit_provider_create", "orbit_provider_update", "orbit_provider_delete" -> CardFamily.PROVIDER
    else -> CardFamily.TOOL
}

fun approvalQuestions(input: JsonObject): List<CardQuestion> = input.objects("questions").mapNotNull {
    runCatching { Wire.json.decodeFromJsonElement(CardQuestion.serializer(), it) }.getOrNull()
        ?.takeIf { q -> q.question.isNotBlank() }
}

/** A source read, not a UI flag, grants each door. Unknown states/actions stay read-only. */
object CardCatalog {
    /** [engine] is the CLI running the session: the server says it (`engine`); a reader that knows better from the account's keys,
     * on a server that doesn't, says it here. */
    fun session(id: String, snapshot: SessionSnapshot, now: java.time.Instant = java.time.Instant.now(),
        engine: String? = snapshot.detail.text("engine")): List<InteractionCard> = buildList {
        val detail = snapshot.detail
        val wireId = detail.text("id") ?: id
        val projectId = detail.text("projectId") ?: detail.obj("project")?.text("id")
        snapshot.approvals.forEach { raw ->
            val approval = runCatching { Wire.json.decodeFromJsonElement(ApprovalDto.serializer(), raw) }.getOrNull() ?: return@forEach
            if (approval.sessionId != null && approval.sessionId != wireId) return@forEach
            val family = approvalFamily(approval.toolName)
            val unexpired = approval.expiresAt == null || runCatching { java.time.Instant.parse(approval.expiresAt) > now }.getOrDefault(false)
            val actions = if (approval.status != "PENDING" || !unexpired) emptyList() else when (family) {
                CardFamily.QUESTION -> listOf(CardVerb.ANSWER, CardVerb.CHAT)
                CardFamily.PLAN -> listOf(CardVerb.APPROVE_PLAN, CardVerb.KEEP_PLANNING)
                CardFamily.CREATE -> listOf(if (approval.toolName == "orbit_task_create") CardVerb.CREATE_TASK else CardVerb.CREATE_PROJECT, CardVerb.CHAT)
                CardFamily.BATCH -> listOf(CardVerb.CREATE_BATCH, CardVerb.CHAT)
                CardFamily.DAG -> listOf(CardVerb.CHANGE_DAG, CardVerb.CHAT)
                CardFamily.BLOCKER -> listOf(CardVerb.RESOLVE_BLOCKER, CardVerb.CHAT)
                // One of Orbit's own asks (iOS `Approvals.isOrbitAsk`): saying no is a conversation, and there is no standing yes.
                // DeepSeek Harness answers each ask once and keeps no rule (iOS cef6c8e0d): there, a card is Allow and Deny alone.
                else -> if (approval.toolName == ApprovalRules.mergeCheckChange) listOf(CardVerb.ALLOW, CardVerb.CHAT) else listOf(CardVerb.ALLOW, CardVerb.DENY) +
                    if (!DshRuntime.rememberOffered(engine) || ApprovalRules.remember(approval.toolName, approval.input).isEmpty()) emptyList()
                    else listOf(CardVerb.REMEMBER)
            }
            val title = when (family) {
                CardFamily.QUESTION -> "Your input is needed"
                CardFamily.PLAN -> "Plan ready for review"
                CardFamily.CREATE -> if (approval.toolName == "orbit_task_create") "Create this task?" else "Create this project?"
                CardFamily.BATCH -> "Create these tasks?"
                CardFamily.DAG -> "Change dependencies?"
                CardFamily.BLOCKER -> "Resolve this blocker?"
                else -> approval.toolName
            }
            add(InteractionCard("approval:${approval.id}", family, title, raw, id, projectId, approval.id,
                approval.input.toString(), actions, if (unexpired) approval.status else "Expired"))
        }
        val standing = snapshot.standing
        (standing["evidenceDecisions"] as? JsonObject)?.let { queue ->
            queue.objects("pending").forEach { row ->
                val task = row.text("taskId") ?: return@forEach
                val revision = row.text("evidenceRevision") ?: return@forEach
                val ownerCard = row.obj("ownerCard")
                if (ownerCard != null) { if (ownerCard.text("sessionId") != wireId) return@forEach }
                else if (projectId == null || row.text("projectId") != projectId) return@forEach
                val deciding = ownerCard?.text("decidingSessionId") ?: queue.text("decidingSessionId") ?: return@forEach
                val allowed = row.obj("decidability")?.flag("decidable") == true && row.obj("independence")?.flag("independent") == true
                add(InteractionCard("evidence:$task:$revision", CardFamily.EVIDENCE, "Completion evidence", row, id,
                    projectId, task, "$revision:$deciding", if (allowed) listOf(CardVerb.CONFIRM_EVIDENCE, CardVerb.SEND_BACK) else emptyList(),
                    context = buildJsonObject { put("decidingSessionId", deciding) }))
            }
            // A revision waiting for this project's paused coordinator, then the line it becomes once sent to it: drawn where its
            // evidence card would be, under that card's address, so one turns into the next in place (`CoordinatorQueue`).
            queue.objects("waitingOnCoordinator").forEach { row ->
                val task = row.text("taskId") ?: return@forEach
                val revision = row.text("evidenceRevision") ?: return@forEach
                if (projectId == null || row.text("projectId") != projectId) return@forEach
                val deciding = queue.text("decidingSessionId") ?: return@forEach
                val allowed = row.obj("decidability")?.flag("decidable") == true && row.obj("independence")?.flag("independent") == true
                add(InteractionCard("evidence:$task:$revision", CardFamily.COORDINATOR_QUEUE, CoordinatorQueue.title, row, id,
                    projectId, task, "$revision:$deciding", if (allowed) listOf(CardVerb.DECIDE_MYSELF) else emptyList(),
                    context = buildJsonObject {
                        put("decidingSessionId", deciding); put("coordinatorQueue", "waiting")
                        put("coordinator", JsonObject(detail.filterKeys { it in CoordinatorQueue.coordinatorFields }))
                    }))
            }
            queue.objects("sentToCoordinator").forEach { row ->
                val task = row.text("taskId") ?: return@forEach
                val revision = row.text("evidenceRevision") ?: return@forEach
                if (projectId == null || row.text("projectId") != projectId) return@forEach
                add(InteractionCard("evidence:$task:$revision", CardFamily.COORDINATOR_QUEUE, CoordinatorQueue.sent, row, id, projectId,
                    task, "sent:${row.text("deliveredAt")}", context = buildJsonObject { put("coordinatorQueue", "sent") }))
            }
            queue.objects("decided").forEach { receipt ->
                add(receipt(CardFamily.EVIDENCE, "Evidence decision recorded", receipt, id, receipt.text("taskId") ?: "", receipt.text("evidenceRevision") ?: ""))
            }
        }
        (standing["ownerConfirmation"] as? JsonObject)?.let { view ->
            val task = view.text("taskId") ?: return@let
            // Where a request stands (OrbitKit `OwnerConfirmations.standing`): answered, then returned by its reviewer, then
            // waiting. An answer and a return are drawn where the card was — under its address — as the record it became.
            val decisions = view.objects("decisions").filter { it.text("sessionId") == wireId }
            val returns = OwnerReview.returnsIn(view, wireId)
            val settled = (decisions + returns).mapNotNull { it.text("requestId") }.toSet()
            view.obj("waiting")?.takeIf { it.text("sessionId") == wireId && it.text("requestId") !in settled }?.let { waiting ->
                val requestId = waiting.text("requestId") ?: return@let
                val review = waiting.obj("review")
                val binding = "$requestId:${review?.text("state")}:${review?.obj("review")?.text("recordId")}"
                val allowed = view.text("completionCriterion") == "OWNER_CONFIRMED" && view.text("status") in setOf("OPEN", "IN_PROGRESS", "FAILED")
                add(InteractionCard("owner:$task:$requestId", CardFamily.OWNER_CONFIRMATION, OwnerReview.heading, view, id, projectId, task,
                    binding, if (allowed) listOf(CardVerb.CONFIRM_OWNER, CardVerb.SEND_BACK) else emptyList(), context = ownerContext("question", view)))
            }
            decisions.forEach { decided ->
                val decisionId = decided.text("id") ?: return@forEach
                // Reopen task, once the review found problems after the confirmation and the task has settled (§9 L4).
                val reopen = OwnerReview.readable(decided["review"])?.obj("problems") != null && OwnerReview.reopenOffered(view.text("status"))
                add(InteractionCard("owner:$task:${decided.text("requestId") ?: decisionId}", CardFamily.OWNER_CONFIRMATION,
                    if (decided.text("decision") == "CONFIRM") OwnerReview.confirmedHeading else OwnerReview.sentBackHeading, decided, id, projectId, task,
                    "$decisionId:${decided.obj("review")?.obj("problems")?.text("recordId")}:${view.text("status")}",
                    if (reopen) listOf(CardVerb.REOPEN_TASK) else emptyList(), "Recorded", ownerContext("receipt", view)))
            }
            returns.forEach { returned ->
                val requestId = returned.text("requestId") ?: return@forEach
                add(InteractionCard("owner:$task:$requestId", CardFamily.OWNER_CONFIRMATION, OwnerReview.heading, returned, id, projectId, task,
                    "$requestId:returned", status = "Recorded", context = ownerContext("returned", view)))
            }
        }
        if (projectId != null) addAll(project(id, projectId, standing))
    }

    private fun receipt(family: CardFamily, title: String, source: JsonObject, session: String, id: String, revision: String) =
        InteractionCard("receipt:$family:$id:$revision", family, title, source, session, objectId = id, binding = revision, status = "Recorded")

    /** Which of the owner card's three shapes this is — the question, the receipt a decision left, the record a reviewer's return
     * left — beside the confirmation read it was drawn from (`OwnerReview`). */
    private fun ownerContext(kind: String, view: JsonObject) = buildJsonObject { put("ownerCard", kind); put("view", view) }

    fun project(session: String, project: String, standing: Map<String, JsonElement>): List<InteractionCard> = buildList {
        val document = standing["project"] as? JsonObject
        if (document == null || document.text("id") != project) return@buildList
        (standing["criteriaDecisions"] as? JsonObject)?.let { queue ->
            queue.objects("pending").forEach { row ->
                val intent = row.text("intentId") ?: return@forEach
                val allowed = row.obj("decidability")?.flag("decidable") == true && row.text("commitToken") != null &&
                    row.text("currentSeal") != null && row.text("baselineSeal") == row.text("currentSeal") && row["proposed"] is JsonArray && row.obj("diff") != null
                add(InteractionCard("criteria:$intent", CardFamily.CRITERIA_CHANGE, "Change the criteria?", row, session, project, intent,
                    "${row.text("commitToken")}:${row.text("currentSeal")}", if (allowed) listOf(CardVerb.APPROVE_CRITERIA, CardVerb.REJECT_CRITERIA) else emptyList()))
            }
            queue.objects("settled").forEach { add(receipt(CardFamily.CRITERIA_CHANGE, "Criteria decision recorded", it, session, it.text("intentId") ?: "", "")) }
        }
        val confirmation = standing["acceptanceConfirmation"] as? JsonObject
        val digest = confirmation?.obj("currentVersion")?.text("digest")
        val openItems = standing["openItems"] as? JsonObject
        val startItem = openItems?.obj("startRequest")
        if (confirmation != null && digest != null && startItem == null &&
            (document.objects("acceptanceCriteriaItems").isNotEmpty() || confirmation.obj("confirmation") != null)) {
            val actions = if (confirmation.text("state") in setOf("UNCONFIRMED", "STALE") && document.objects("acceptanceCriteriaItems").isNotEmpty())
                listOf(CardVerb.CONFIRM_CRITERIA) else emptyList()
            add(InteractionCard("acceptance:$project:$digest", CardFamily.ACCEPTANCE, "Project criteria", confirmation, session, project, project,
                digest, actions, confirmation.text("state"), document))
        }
        startItem?.let { row ->
            val request = row.obj("startRequest") ?: return@let
            val itemId = row.text("itemId") ?: return@let
            val unstarted = document.containsKey("startedAt") && document["startedAt"] == JsonNull
            val allowed = unstarted && digest != null && digest == request.text("criteriaDigest") && request.obj("settings") != null &&
                document.objects("acceptanceCriteriaItems").isNotEmpty()
            add(InteractionCard("start:$itemId", CardFamily.START, "Start this project?", row, session, project, itemId,
                "${request.text("criteriaDigest")}:${request.text("planDigest")}", if (allowed) listOf(CardVerb.START) else emptyList(),
                context = document))
        }
        openItems?.objects("needsYou")?.forEach { row ->
            val itemId = row.text("itemId") ?: return@forEach
            val kind = row.text("kind")
            if (kind in setOf("PROMOTION_APPROVAL", "START_REQUEST")) return@forEach
            val verbs = row.strings("actions")
            val owned = row.text("assignee") == "OWNER"
            val actions = buildList {
                if (!owned) return@buildList
                if (kind == "COORDINATOR_QUESTION" && "ANSWER" in verbs && row.obj("question") != null) add(CardVerb.OWNER_ANSWER)
                if ("ASK_COORDINATOR_AGAIN" in verbs) add(CardVerb.RETURN_COORDINATOR)
                if ("RESUME" in verbs && row.text("fuseEpisodeId") != null) add(CardVerb.RESUME)
                if ("RETRY" in verbs && row.text("taskId") != null) add(CardVerb.RETRY_TASK)
                if ("CANCEL_TASK" in verbs && row.text("taskId") != null) add(CardVerb.CANCEL_TASK)
                if (kind in setOf("INTEGRATION_CONFLICT", "INTEGRATION_CHECK_FAILED", "INTEGRATION_ERROR", "TASK_FAILED")) add(CardVerb.MARK_HANDLED)
            }
            add(InteractionCard("item:$itemId", if (kind == "COORDINATOR_QUESTION") CardFamily.OWNER_QUESTION else CardFamily.EXCEPTION,
                if (kind == "FUSE_PAUSED") "Project paused" else row.text("title") ?: "Project item", row, session, project, itemId,
                // Returning an OPEN item resets this public timestamp; later escalation reuses its itemId.
                "${row["question"]}:${row["actions"]}:${row["assignee"]}:${row["taskId"]}:${row["fuseEpisodeId"]}:${row["waitingSince"]}", actions))
        }
        (standing["promotion"] as? JsonObject)?.let { row ->
            val promotion = row.text("promotionId") ?: return@let
            // One line per moment (iOS 6b4bef713): a candidate is a card while it asks, merges or is blocked. A merge that happened is
            // the record the merged read draws, and one still being checked or already answered asks nothing.
            if (PromotionCards.stage(row) !in setOf(PromotionStage.ASKING_YOU, PromotionStage.MERGING, PromotionStage.BLOCKED)) return@let
            val actions = when (row.text("state")) {
                "READY" -> if (row.text("sourceSha") != null) listOf(CardVerb.CONFIRM_MERGE, CardVerb.DECLINE_MERGE) else emptyList()
                "CONFIRMED", "RECHECKING" -> listOf(CardVerb.CANCEL_MERGE)
                else -> emptyList()
            }
            // While it merges, the card says where the merge's own job stands (`PromotionCards`).
            val merging = PromotionCards.isMerging(row)
            add(InteractionCard("promotion:$promotion", CardFamily.PROMOTION, if (merging) PromotionCards.mergingTitle(row) else "Merge to ${row.text("upstreamRef") ?: "main"}", row,
                session, project, promotion, "${row.text("sourceSha")}:${row.text("state")}", actions, if (merging) PromotionCards.mergingStatusLine(row) else row.text("state")))
        }
    }
}

/**
 * An Automatic project's completion evidence while its coordinator is paused — a usage limit, a 429, an expired sign-in, a runner
 * that went away, a retry it is parked on — or not yet handed it (project 34cygPTQe5LPUT7tdUAzG; the pending read's
 * `waitingOnCoordinator` and `sentToCoordinator`, read for the coordinator's own conversation). Such a revision waits for the
 * coordinator, not for the owner: it is drawn where its evidence card would be and asks nothing — no needs-you count reads this
 * family — until Decide it myself opens the evidence card it still is. Once handed over it is one line saying when. The words are
 * the project's, the same on every client.
 */
object CoordinatorQueue {
    const val title = "Waiting for the coordinator"
    const val explanation = "It goes to the coordinator when it’s back. You can still decide now."
    const val decideHere = "It gets this when it’s back. Decide here only if you don’t want to wait."
    const val back = "Coordinator is back · it gets this when its current turn ends"
    const val sent = "Sent to the coordinator"
    private const val paused = "Coordinator paused"

    /** What the waiting card reads of the coordinator's own session to say why it waits: its run, what it failed with or last
     * said, and the retry it is parked on. */
    val coordinatorFields = setOf("status", "runState", "error", "lastAssistantText", "retryAt")

    /** "Coordinator paused · weekly limit · resets 19:00" for the quota [window] that ran out, else "Coordinator paused · retries
     * 19:00"; without a [time] it names none. */
    fun pausedLine(window: String?, time: String?): String = when {
        window != null -> listOfNotNull(paused, window, time?.let { "resets $it" }).joinToString(" · ")
        time != null -> "$paused · retries $time"
        else -> paused
    }

    /** "Sent to the coordinator · 20:05". */
    fun sentLine(time: String?): String = listOfNotNull(sent, time).joinToString(" · ")

    /** Whether the coordinator is still paused, as the server reads it (`conversationIsPaused`): its run failed, or it waits on a
     * retry it armed. A revision still waiting for one that is neither goes to it when its current turn ends. */
    fun isPaused(coordinator: JsonObject): Boolean =
        coordinator.text("retryAt") != null || (coordinator.text("runState") ?: coordinator.text("status")) == "FAILED"

    fun isSent(card: InteractionCard) = card.family == CardFamily.COORDINATOR_QUEUE && card.context.text("coordinatorQueue") == "sent"

    /** Whether [card] is a waiting revision that Decide it myself opened (`decideMyself`). */
    fun isDecidingMyself(card: InteractionCard) = card.context.flag("decidingMyself")

    /** What Decide it myself opens: the evidence card the revision still is — Confirm done and Chat about this, the same request
     * as the same deciding session — still saying what it waits for. Null for a card that offers no such press. */
    fun decideMyself(card: InteractionCard): InteractionCard? = if (CardVerb.DECIDE_MYSELF !in card.actions) null
        else card.copy(family = CardFamily.EVIDENCE, actions = listOf(CardVerb.CONFIRM_EVIDENCE, CardVerb.SEND_BACK),
            context = JsonObject(card.context + ("decidingMyself" to JsonPrimitive(true))))
}
