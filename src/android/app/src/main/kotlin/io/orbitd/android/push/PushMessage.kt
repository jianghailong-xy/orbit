package io.orbitd.android.push

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.ObjectId
import java.time.Instant
import kotlinx.serialization.json.*

enum class PushType { ALERT, SYNC }

data class PushPayload(
    val title: String? = null,
    val body: String? = null,
    val category: String? = null,
    val threadId: String? = null,
    val kind: String? = null,
    val badge: Int? = null,
    val clearSessions: Set<String> = emptySet(),
    val sessionId: String? = null,
    val projectId: String? = null,
    val openItemId: String? = null,
    val taskId: String? = null,
    val recordId: String? = null,
    val runnerId: String? = null,
    val engine: String? = null,
    val watchId: String? = null,
    val generation: Int? = null,
    val wikiSpaceId: String? = null,
    /** `owner-request`: the request, and its kind (DECISION, SECRET, MANUAL_STEP, CONFIRM, WIKI_CREATE or BROWSER_SIGN_IN), which names the notification's action. */
    val ownerRequestId: String? = null,
    val ownerRequestKind: String? = null,
    /** `terminal-login`: the terminal sign-in waiting for the owner's Approve (docs/terminal-session-design.md). */
    val terminalLoginId: String? = null,
    /** `crossing-request`: the cross-project request waiting on the owner's decision. */
    val handoffId: String? = null,
    /** `schedule`: the schedule an alert is about, and which of its alerts it is (a finding, a failure, a hold...). */
    val scheduleId: String? = null,
    val scheduleKind: String? = null,
    /** `condition`: the condition that cannot be read (docs/condition-triggers-design.md §5.3); its Waiting on you item is
     * [ownerRequestId] when it filed one. */
    val conditionId: String? = null,
    /** `account-needs-action`: the account_health row Check again takes. A key or pool login names no runner. */
    val accountHealthId: String? = null,
) {
    val isOwnerItem get() = kind in ownerItemKinds
    val isReminder get() = kind == "approval" || isOwnerItem
    val isOwnerRequest get() = kind == OWNER_REQUEST
    val isTerminalLogin get() = kind == TERMINAL_LOGIN
    /** A decision only the owner can make, raised outside the owner items: a crossing request, a coordinator's confirmation hold. */
    val isOwnerDecision get() = kind == CROSSING_REQUEST || kind == CONFIRMATION_RAISED
    /** An owner request's primary action (`orbit://owner-request/<id>`): the conversation that asked, opened on the request's card
     * with its input focused ([io.orbitd.android.cards.OwnerRequestLinks]). Neither it nor Later ends the request; the tap on the
     * notification itself opens that conversation too, as [link] says. */
    val ownerRequestLink: String? get() = ownerRequestId?.takeIf { isOwnerRequest }?.let { "orbit://owner-request/$it" }

    /** The existing ACTION_VIEW/OrbitLinks entry retains authentication and the caller's stack. */
    val link: String? get() = when {
        // A project done, and a pending item of a project nobody has (the orphan sweep, owner with no coordinator): its project.
        kind == "project-done" || kind == "project-orphan" -> projectId?.let { "orbit://project/$it" }
        // A terminal asking to be approved: Machines & models' Needs you section, its card lit (OrbitLinks).
        kind == TERMINAL_LOGIN -> terminalLoginId?.let { "orbit://terminal-login/$it" }
        kind == "watch-matched" -> watchId?.let { "orbit://watch/$it" }
        // A scheduled task's alert: its run's session when it names one, else the schedule's detail on the Scheduled page.
        kind == SCHEDULE -> sessionId?.let { "orbit-session:$it" } ?: scheduleId?.let { "orbit://schedule/$it" }
        // A condition that cannot be read: the conversation it came from, which draws its card, else the card in Waiting on you.
        kind == CONDITION -> sessionId?.let { "orbit-session:$it" } ?: ownerRequestId?.let { "orbit://owner-request/$it" }
        // About a machine: its sign-in lapsed, its Claude connection to Anthropic is in a region Anthropic does not offer Claude in,
        // or it drains for an update with the owner's work waiting on it.
        kind == "engine-signed-out" || kind == "claude-region-blocked" || kind == "runner-updating" -> runnerId?.let { "orbit://runner/$it" }
        // An account the provider refused: its machine's page, or for a key or pool login the Providers screen, where its row is.
        kind == ACCOUNT_NEEDS_ACTION -> runnerId?.let { "orbit://runner/$it" } ?: PROVIDERS_LINK
        // A merge into main waiting on the owner opens its project's sessions page, where its card is, as that project's root
        // (iOS 6b4bef713 `Notifications.intent`). Every other owner item opens the conversation, and so does a merge naming no project.
        kind == "approve-merge-to-main" && projectId != null -> "orbit://project/$projectId"
        sessionId != null -> "orbit-session:$sessionId" +
            (if (kind == "confirmation-problems" && recordId != null) "?at=$recordId" else "")
        projectId != null -> "orbit-project:$projectId"
        taskId != null -> "orbit-task:$taskId"
        // A space, never an entry: the URI handed to A12 (task comment 34aIrgslPhvEl3IPNty9m). Until its
        // OrbitLinks branch is integrated, the tap opens Orbit without navigating, as iOS does.
        wikiSpaceId != null -> "orbit://wiki/$wikiSpaceId"
        else -> null
    }

    companion object {
        /** The five owner items' pushes (§7.6 V12): the fifth, work that reached main without the owner's confirmation (§10.7, owner
         * 2026-10-28), is pushed once and routed like a question — to the conversation its card is in, else its project. */
        val ownerItemKinds = setOf("approve-merge-to-main", "coordinator-question", "escalated-to-you", "fuse-paused",
            "landed-without-confirmation")
        const val OWNER_REQUEST = "owner-request"
        const val TERMINAL_LOGIN = "terminal-login"
        const val CROSSING_REQUEST = "crossing-request"
        const val CONFIRMATION_RAISED = "confirmation-raised"
        const val SCHEDULE = "schedule"
        /** A condition that cannot be read (apiserver `notifyCondition`). A condition that fires rings as its run's `schedule` push. */
        const val CONDITION = "condition"
        /** An account the provider refused, or that failed to start runs three times (docs/account-health-owner-surface-contract.md §1). */
        const val ACCOUNT_NEEDS_ACTION = "account-needs-action"
        /** Settings' Providers screen (keys and pools): where a key's or pool login's blocked row is. */
        const val PROVIDERS_LINK = "orbit://settings/providers"
    }
}

data class PushMessage(
    val type: PushType,
    val registrationKey: String,
    val eventId: String,
    val notificationKey: String,
    val sentAt: String,
    val payload: PushPayload,
) {
    val link get() = payload.link

    companion object {
        private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
        private val kinds = PushPayload.ownerItemKinds + setOf("project-done", "project-orphan", "approval", "finished", "failed", "agent-message",
            "engine-signed-out", "confirmation-problems", "watch-matched", "wiki-review-mode-manual",
            "wiki-review-mode-tiered", "wiki-maintenance-failing", "loop-missed", "wakeup-dropped", "claude-region-blocked",
            "runner-updating", PushPayload.OWNER_REQUEST, PushPayload.TERMINAL_LOGIN, PushPayload.CROSSING_REQUEST,
            PushPayload.CONFIRMATION_RAISED, PushPayload.SCHEDULE, PushPayload.CONDITION, PushPayload.ACCOUNT_NEEDS_ACTION)

        /** No unknown version, malformed identifier, or partial route can become a notification. */
        fun parse(data: Map<String, String>): PushMessage? = try {
            require(data["version"] == "1")
            val type = when (data["type"]) { "alert" -> PushType.ALERT; "sync" -> PushType.SYNC; else -> error("type") }
            // Binding keys are opaque: never base62-convert or otherwise rewrite them.
            val binding = data.getValue("registrationKey").also { require(uuid.matches(it)) }
            val event = data.getValue("eventId").also { require(uuid.matches(it)) }
            val key = data.getValue("notificationKey").also { require(it.isNotBlank() && it.length <= 512 && it.none(Char::isISOControl)) }
            val sent = data.getValue("sentAt").also { Instant.parse(it) }
            val raw = data.getValue("payload").also { require(it.length <= 8192) }
            val json = Wire.json.parseToJsonElement(raw) as? JsonObject ?: error("payload")
            fun string(name: String): String? = json[name]?.let {
                val value = it as? JsonPrimitive ?: error(name)
                require(value.isString)
                value.content
            }
            fun id(name: String): String? = string(name)?.let { ObjectId.canonical(it) ?: error(name) }
            fun number(name: String): Int? = json[name]?.let {
                val value = it as? JsonPrimitive ?: error(name)
                require(!value.isString)
                value.intOrNull?.also { n -> require(n >= 0) } ?: error(name)
            }
            val clear = json["clearSessions"]?.let { value ->
                (value as? JsonArray ?: error("clearSessions")).map {
                    val rawId = (it as? JsonPrimitive)?.takeIf { v -> v.isString }?.content ?: error("clearSessions")
                    ObjectId.canonical(rawId) ?: error("clearSessions")
                }.toSet()
            }.orEmpty()
            val payload = PushPayload(string("title"), string("body"), string("category"), string("threadId"),
                string("kind"), number("badge"), clear, id("sessionID"), id("projectID"), id("openItemID"),
                id("taskID"), id("recordID"), id("runnerID"), string("engine"), id("watchID"),
                number("generation"), id("wikiSpaceID"), ownerRequestId = id("ownerRequestID"), ownerRequestKind = string("ownerRequestKind"),
                terminalLoginId = id("terminalLoginID"), handoffId = id("handoffID"), scheduleId = id("scheduleID"),
                scheduleKind = string("scheduleKind"), conditionId = id("conditionID"), accountHealthId = string("accountHealthID"))
            if (type == PushType.ALERT) {
                require(!payload.title.isNullOrBlank() && payload.body != null && payload.kind in kinds)
                when (payload.kind) {
                    // A wakeup loop that stopped running, and a wakeup dropped with its FAILED session, are about that session.
                    "approval", "finished", "failed", "loop-missed", "wakeup-dropped" -> require(payload.sessionId != null)
                    "project-done", "project-orphan" -> require(payload.projectId != null)
                    "agent-message" -> Unit // Headless orbit notify deliberately names no session.
                    // A session filed an owner request: about that session, and the request its actions open.
                    PushPayload.OWNER_REQUEST -> require(payload.sessionId != null && payload.ownerRequestId != null)
                    // A terminal asking to be approved names the request and the machine it asks for.
                    PushPayload.TERMINAL_LOGIN -> require(payload.terminalLoginId != null && payload.runnerId != null)
                    // A crossing request names the project that lists it and the request; its card's conversation only when it has one.
                    PushPayload.CROSSING_REQUEST -> require(payload.projectId != null && payload.handoffId != null)
                    // A coordinator raising a task for the owner's confirmation: the run's session, its task, the review record.
                    PushPayload.CONFIRMATION_RAISED -> require(payload.sessionId != null && payload.taskId != null && payload.recordId != null)
                    // A scheduled task's alert names its schedule; the run's session only when it opens one.
                    PushPayload.SCHEDULE -> require(payload.scheduleId != null)
                    // A condition that cannot be read names the condition; its session and item only when it has them.
                    PushPayload.CONDITION -> require(payload.conditionId != null)
                    // An account row: the health row Check again takes; the machine only when the account is a machine's sign-in.
                    PushPayload.ACCOUNT_NEEDS_ACTION -> require(!payload.accountHealthId.isNullOrBlank())
                    "confirmation-problems" -> require(payload.sessionId != null && payload.taskId != null && payload.recordId != null)
                    // A confirmed region flip is about its runner's Claude Code, as a sign-out is about its runner's engine.
                    "engine-signed-out", "claude-region-blocked" -> require(payload.runnerId != null && !payload.engine.isNullOrBlank())
                    // A runner draining for its update with the owner's work waiting: about the machine, no engine.
                    "runner-updating" -> require(payload.runnerId != null)
                    "watch-matched" -> require(payload.watchId != null && (payload.generation ?: 0) > 0)
                    in PushPayload.ownerItemKinds -> require(payload.projectId != null && payload.openItemId != null)
                    else -> require(payload.wikiSpaceId != null)
                }
            }
            PushMessage(type, binding, event, key, sent, payload)
        } catch (_: Exception) { null }
    }
}
