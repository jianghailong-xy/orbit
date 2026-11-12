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
    /** `owner-request`: the request, and its kind (DECISION, SECRET, MANUAL_STEP, CONFIRM or WIKI_CREATE), which names the notification's action. */
    val ownerRequestId: String? = null,
    val ownerRequestKind: String? = null,
) {
    val isOwnerItem get() = kind in ownerItemKinds
    val isReminder get() = kind == "approval" || isOwnerItem
    val isOwnerRequest get() = kind == OWNER_REQUEST
    /** An owner request's primary action (`orbit://owner-request/<id>`): the inbox, its card open on its input. Neither it nor
     * Later ends the request; the tap on the notification itself opens the session that asked, as [link] says. */
    val ownerRequestLink: String? get() = ownerRequestId?.takeIf { isOwnerRequest }?.let { "orbit://owner-request/$it" }

    /** The existing ACTION_VIEW/OrbitLinks entry retains authentication and the caller's stack. */
    val link: String? get() = when {
        kind == "project-done" -> projectId?.let { "orbit://project/$it" }
        kind == "watch-matched" -> watchId?.let { "orbit://watch/$it" }
        // About a machine: its sign-in lapsed, or its Claude connection to Anthropic is in a region Anthropic does not offer Claude in.
        kind == "engine-signed-out" || kind == "claude-region-blocked" -> runnerId?.let { "orbit://runner/$it" }
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
        private val kinds = PushPayload.ownerItemKinds + setOf("project-done", "approval", "finished", "failed", "agent-message",
            "engine-signed-out", "confirmation-problems", "watch-matched", "wiki-review-mode-manual",
            "wiki-review-mode-tiered", "wiki-maintenance-failing", "loop-missed", "wakeup-dropped", "claude-region-blocked",
            PushPayload.OWNER_REQUEST)

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
                number("generation"), id("wikiSpaceID"), ownerRequestId = id("ownerRequestID"), ownerRequestKind = string("ownerRequestKind"))
            if (type == PushType.ALERT) {
                require(!payload.title.isNullOrBlank() && payload.body != null && payload.kind in kinds)
                when (payload.kind) {
                    // A wakeup loop that stopped running, and a wakeup dropped with its FAILED session, are about that session.
                    "approval", "finished", "failed", "loop-missed", "wakeup-dropped" -> require(payload.sessionId != null)
                    "project-done" -> require(payload.projectId != null)
                    "agent-message" -> Unit // Headless orbit notify deliberately names no session.
                    // A session filed an owner request: about that session, and the request its actions open.
                    PushPayload.OWNER_REQUEST -> require(payload.sessionId != null && payload.ownerRequestId != null)
                    "confirmation-problems" -> require(payload.sessionId != null && payload.taskId != null && payload.recordId != null)
                    // A confirmed region flip is about its runner's Claude Code, as a sign-out is about its runner's engine.
                    "engine-signed-out", "claude-region-blocked" -> require(payload.runnerId != null && !payload.engine.isNullOrBlank())
                    "watch-matched" -> require(payload.watchId != null && (payload.generation ?: 0) > 0)
                    in PushPayload.ownerItemKinds -> require(payload.projectId != null && payload.openItemId != null)
                    else -> require(payload.wikiSpaceId != null)
                }
            }
            PushMessage(type, binding, event, key, sent, payload)
        } catch (_: Exception) { null }
    }
}
