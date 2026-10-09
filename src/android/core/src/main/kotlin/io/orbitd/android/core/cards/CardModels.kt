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
    fun session(id: String, snapshot: SessionSnapshot, now: java.time.Instant = java.time.Instant.now()): List<InteractionCard> = buildList {
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
                else -> if (approval.toolName == ApprovalRules.mergeCheckChange) listOf(CardVerb.ALLOW, CardVerb.CHAT) else listOf(CardVerb.ALLOW, CardVerb.DENY) +
                    if (ApprovalRules.remember(approval.toolName, approval.input).isEmpty()) emptyList() else listOf(CardVerb.REMEMBER)
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
            queue.objects("decided").forEach { receipt ->
                add(receipt(CardFamily.EVIDENCE, "Evidence decision recorded", receipt, id, receipt.text("taskId") ?: "", receipt.text("evidenceRevision") ?: ""))
            }
        }
        (standing["ownerConfirmation"] as? JsonObject)?.let { view ->
            val task = view.text("taskId") ?: return@let
            view.obj("waiting")?.takeIf { it.text("sessionId") == wireId }?.let { waiting ->
                val requestId = waiting.text("requestId") ?: return@let
                val review = waiting.obj("review")
                val binding = "$requestId:${review?.text("state")}:${review?.obj("review")?.text("recordId")}"
                val allowed = view.text("completionCriterion") == "OWNER_CONFIRMED" && view.text("status") in setOf("OPEN", "IN_PROGRESS", "FAILED")
                add(InteractionCard("owner:$task:$requestId", CardFamily.OWNER_CONFIRMATION, "Confirm done?", view, id, projectId, task,
                    binding, if (allowed) listOf(CardVerb.CONFIRM_OWNER, CardVerb.SEND_BACK) else emptyList()))
            }
            view.objects("decisions").filter { it.text("sessionId") == wireId }.forEach {
                add(receipt(CardFamily.OWNER_CONFIRMATION, "Owner decision recorded", it, id, task, it.text("id") ?: ""))
            }
            view.objects("reviewerReturns").filter { it.text("sessionId") == wireId }.forEach {
                add(receipt(CardFamily.REVIEW, "Returned by reviewer", it, id, task, it.text("requestId") ?: ""))
            }
        }
        if (projectId != null) addAll(project(id, projectId, standing))
    }

    private fun receipt(family: CardFamily, title: String, source: JsonObject, session: String, id: String, revision: String) =
        InteractionCard("receipt:$family:$id:$revision", family, title, source, session, objectId = id, binding = revision, status = "Recorded")

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
