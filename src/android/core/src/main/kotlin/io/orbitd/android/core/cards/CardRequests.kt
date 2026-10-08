package io.orbitd.android.core.cards

import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

/** Every business door has its own body. These are also used by Tasks/Projects/Wiki surfaces. */
object CardRequests {
    fun build(card: InteractionCard, verb: CardVerb, input: CardInput = CardInput()): ApiRequest {
        require(verb in card.actions) { "This action is no longer available." }
        val row = card.source
        val project = card.projectId
        fun required(key: String) = requireNotNull(row.text(key)) { "The card is incomplete. Refresh it." }
        fun note(max: Int = 4000) = input.text.trim().also { require(it.isNotEmpty() && it.length <= max) { "Enter a reason (up to $max characters)." } }
        fun request(path: List<String>, body: JsonObject = emptyObject, method: HttpMethod = HttpMethod.POST) =
            ApiRequest(path, method, body = body.toString().encodeToByteArray())
        fun projectPath(vararg parts: String) = listOf("projects", requireNotNull(project)) + parts
        fun encoded(body: String) = Wire.json.parseToJsonElement(body).jsonObject
        if (card.family in setOf(CardFamily.TOOL, CardFamily.QUESTION, CardFamily.PLAN, CardFamily.CREATE,
                CardFamily.BATCH, CardFamily.DAG, CardFamily.BLOCKER, CardFamily.PROVIDER)) {
            val tool = required("toolName")
            val original = row.obj("input") ?: emptyObject
            val answers = if (verb == CardVerb.ANSWER) {
                val questions = approvalQuestions(original)
                require(questions.isNotEmpty() && questions.size == (original["questions"] as? JsonArray)?.size &&
                    questions.map { it.question }.distinct().size == questions.size) { "The questions could not be read." }
                questions.associate { q ->
                    val selected = input.selections[q.question].orEmpty()
                    require(selected.all { chosen -> q.options.any { it.label == chosen } })
                    val custom = input.custom[q.question]?.trim().orEmpty()
                    require(q.multiSelect || selected.size <= 1 && (selected.isEmpty() || custom.isEmpty()))
                    val values = selected.distinct() + listOfNotNull(custom.takeIf { it.isNotEmpty() })
                    require(values.isNotEmpty()) { "Answer every question." }
                    q.question to values
                }
            } else null
            val rules = if (verb == CardVerb.REMEMBER) ApprovalRules.remember(tool, original).also { require(it.isNotEmpty()) } else null
            val behavior = if (verb in setOf(CardVerb.DENY, CardVerb.KEEP_PLANNING, CardVerb.CHAT)) "deny" else "allow"
            val body = ApprovalDecision(behavior, if (verb == CardVerb.CHAT) note() else null, answers, rules)
            return request(listOf("sessions", card.sessionId, "approvals", card.objectId, "decision"), encoded(Wire.json.encodeToString(body)))
        }
        return when (verb) {
            CardVerb.CONFIRM_EVIDENCE, CardVerb.SEND_BACK -> if (card.family == CardFamily.EVIDENCE) {
                val body = EvidenceDecision(requireNotNull(card.context.text("decidingSessionId")), required("evidenceRevision"),
                    if (verb == CardVerb.SEND_BACK) "SEND_BACK" else "CONFIRM", if (verb == CardVerb.SEND_BACK) note() else null)
                request(listOf("tasks", card.objectId, "evidence", "decision"), encoded(Wire.json.encodeToString(body)))
            } else owner(card, verb, input)
            CardVerb.CONFIRM_OWNER -> owner(card, verb, input)
            CardVerb.APPROVE_CRITERIA, CardVerb.REJECT_CRITERIA -> request(projectPath("acceptance", "criteria-decisions", card.objectId),
                encoded(Wire.json.encodeToString(CriteriaDecision(required("commitToken"), if (verb == CardVerb.APPROVE_CRITERIA) "APPROVE" else "REJECT", required("currentSeal")))))
            CardVerb.CONFIRM_CRITERIA -> request(projectPath("acceptance", "confirmation"), buildJsonObject { put("criteriaDigest", card.binding) })
            CardVerb.START -> {
                val original = requireNotNull(row.obj("startRequest"))
                val settings = input.settings ?: Wire.json.decodeFromJsonElement(ProjectStartSettings.serializer(), requireNotNull(original.obj("settings")))
                require(settings.line in setOf("MAIN", "PROJECT_BRANCH") && settings.maxConcurrentTasks in 1..100)
                val body = buildJsonObject {
                    put("criteriaDigest", requireNotNull(original.text("criteriaDigest")))
                    put("requestId", card.objectId)
                    put("line", settings.line); put("automatic", settings.automatic); put("maxConcurrentTasks", settings.maxConcurrentTasks)
                    put("mergeCheckCommand", settings.mergeCheckCommand?.trim()?.takeIf { it.isNotBlank() }?.let(::JsonPrimitive) ?: JsonNull)
                    if (settings.line == "PROJECT_BRANCH") settings.projectBranchName?.trim()?.takeIf { it.isNotBlank() }?.let { put("projectBranchName", it) }
                }
                request(projectPath("start"), body)
            }
            CardVerb.OWNER_ANSWER -> {
                val q = requireNotNull(row.obj("question"))
                require(input.option == null || input.option in q.objects("options").indices)
                require(input.option != null || input.text.isNotBlank()) { "Choose an option or enter an answer." }
                request(projectPath("open-items", card.objectId, "answer"), buildJsonObject {
                    input.option?.let { put("option", it) }
                    input.text.trim().takeIf { it.isNotEmpty() }?.let { put("text", it) }
                })
            }
            CardVerb.RETURN_COORDINATOR -> request(projectPath("open-items", card.objectId, "return-to-coordinator"))
            CardVerb.RESUME -> request(projectPath("fuse", required("fuseEpisodeId"), "resume"))
            CardVerb.MARK_HANDLED -> request(projectPath("open-items", card.objectId, "resolve"), buildJsonObject { put("note", note(2000)) })
            CardVerb.RETRY_TASK -> request(listOf("tasks", required("taskId"), "execute"), buildJsonObject {
                put("triggerId", requireNotNull(input.triggerId).also { require(it.isNotBlank()) })
            })
            CardVerb.CANCEL_TASK -> request(listOf("tasks", required("taskId")), buildJsonObject { put("status", "CANCELLED") }, HttpMethod.PATCH)
            CardVerb.CONFIRM_MERGE -> request(projectPath("promotions", card.objectId, "confirm"), buildJsonObject { put("sourceSha", required("sourceSha")) })
            CardVerb.DECLINE_MERGE -> request(projectPath("promotions", card.objectId, "decline"))
            CardVerb.CANCEL_MERGE -> request(projectPath("promotions", card.objectId, "cancel"))
            CardVerb.WIKI_ACCEPT, CardVerb.WIKI_EDIT, CardVerb.WIKI_REJECT, CardVerb.WIKI_RECONFIRM, CardVerb.WIKI_AMEND, CardVerb.WIKI_RETIRE -> request(listOf("wiki", "changesets", required("changesetId"), "decide"), buildJsonObject {
                putJsonArray("decisions") { add(buildJsonObject {
                    put("opId", card.objectId)
                    put("action", when (verb) { CardVerb.WIKI_ACCEPT -> "accept"; CardVerb.WIKI_EDIT -> "edit"; CardVerb.WIKI_RECONFIRM -> "reconfirm"; CardVerb.WIKI_AMEND -> "amend"; CardVerb.WIKI_RETIRE -> "retire"; else -> "reject" })
                    if (verb in setOf(CardVerb.WIKI_EDIT, CardVerb.WIKI_AMEND)) put("edited", requireNotNull(input.edited).also { require(it.isNotEmpty()) { "Enter an edit before saving." } })
                    if (verb == CardVerb.WIKI_REJECT) put("reason", requireNotNull(input.reason).also { require(it in wikiRejectReasons) })
                    if (input.text.isNotBlank()) put("note", input.text.trim())
                }) }
            })
            CardVerb.WIKI_CONFIRM -> request(listOf("wiki", "entries", card.objectId, "confirm"))
            CardVerb.WIKI_REJECT_ENTRY -> request(listOf("wiki", "entries", card.objectId, "reject"), buildJsonObject {
                put("reason", requireNotNull(input.reason).also { require(it in wikiRejectReasons) })
            })
            CardVerb.WIKI_REVERT -> request(listOf("wiki", "changesets", card.objectId, "revert"))
            CardVerb.PLAN_CONFIRM -> request(listOf("wiki", "spaces", required("spaceId"), "plan", "versions", required("version"), "confirm"))
            CardVerb.PLAN_ACCEPT, CardVerb.PLAN_REJECT -> request(listOf("wiki", "plan-proposals", card.objectId, "decide"), buildJsonObject {
                put("action", if (verb == CardVerb.PLAN_ACCEPT) "accept" else "reject")
                if (input.text.isNotBlank()) put("note", input.text.trim())
            })
            CardVerb.WATCH_PAUSE, CardVerb.WATCH_RESUME, CardVerb.WATCH_CANCEL -> request(listOf("watches", card.objectId,
                when (verb) { CardVerb.WATCH_PAUSE -> "pause"; CardVerb.WATCH_RESUME -> "resume"; else -> "cancel" }))
            else -> error("Unsupported card action")
        }
    }

    private fun owner(card: InteractionCard, verb: CardVerb, input: CardInput): ApiRequest {
        require(card.family == CardFamily.OWNER_CONFIRMATION)
        val waiting = requireNotNull(card.source.obj("waiting"))
        val review = waiting.obj("review")
        val confirm = verb == CardVerb.CONFIRM_OWNER
        val body = buildJsonObject {
            put("decision", if (confirm) "CONFIRM" else "SEND_BACK")
            put("requestId", requireNotNull(waiting.text("requestId")))
            if (confirm) {
                val shown = review?.text("state") in setOf("REVIEWED", "OUTDATED")
                put("reviewRecordId", if (shown) review?.obj("review")?.get("recordId") ?: JsonNull else JsonNull)
                val questions = reviewQuestions(review)
                val answers = questions.map { q ->
                    val key = requireNotNull(q.text("key"))
                    val chosen = input.ownerAnswers.firstOrNull { it.key == key } ?: OwnerAnswer(key, q.number("recommendedOption"))
                    require(chosen.option == null || chosen.option in q.objects("options").indices)
                    require(chosen.option != null || !chosen.text.isNullOrBlank()) { "Answer every review question." }
                    buildJsonObject {
                        put("key", key)
                        if (chosen.option != null) put("option", chosen.option) else put("text", chosen.text!!.trim())
                    }
                }
                if (answers.isNotEmpty()) put("answers", JsonArray(answers))
            } else put("note", input.text.trim().also { require(it.isNotEmpty() && it.length <= 4000) { "Enter a reason (up to 4000 characters)." } })
        }
        return ApiRequest(listOf("tasks", card.objectId, "owner-confirmation"), HttpMethod.POST, body = body.toString().encodeToByteArray())
    }
    fun reviewQuestions(review: JsonObject?): List<JsonObject> =
        if (review?.text("state") == "REVIEWED") review.obj("review")?.objects("needsYou").orEmpty() else emptyList()

    val wikiRejectReasons = setOf("not_true", "not_useful", "duplicate", "too_specific")
}
