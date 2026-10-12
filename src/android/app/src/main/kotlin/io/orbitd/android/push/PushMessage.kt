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
) {
    val isOwnerItem get() = kind in ownerItemKinds
    val isReminder get() = kind == "approval" || isOwnerItem

    /** The existing ACTION_VIEW/OrbitLinks entry retains authentication and the caller's stack. */
    val link: String? get() = when {
        kind == "watch-matched" -> watchId?.let { "orbit://watch/$it" }
        kind == "engine-signed-out" -> runnerId?.let { "orbit://runner/$it" }
        sessionId != null -> "orbit-session:$sessionId" +
            (if (kind == "confirmation-problems" && recordId != null) "?at=$recordId" else "")
        projectId != null -> "orbit-project:$projectId"
        taskId != null -> "orbit-task:$taskId"
        // wikiSpaceID is a space, not an entry. A12 must supply its existing-entry extension.
        else -> null
    }

    companion object {
        val ownerItemKinds = setOf("approve-merge-to-main", "coordinator-question", "escalated-to-you", "fuse-paused")
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
        private val kinds = PushPayload.ownerItemKinds + setOf("approval", "finished", "failed", "agent-message",
            "engine-signed-out", "confirmation-problems", "watch-matched", "wiki-review-mode-manual",
            "wiki-review-mode-tiered", "wiki-maintenance-failing")

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
                number("generation"), id("wikiSpaceID"))
            if (type == PushType.ALERT) {
                require(!payload.title.isNullOrBlank() && payload.body != null && payload.kind in kinds)
                when (payload.kind) {
                    "approval", "finished", "failed" -> require(payload.sessionId != null)
                    "agent-message" -> Unit // Headless orbit notify deliberately names no session.
                    "confirmation-problems" -> require(payload.sessionId != null && payload.taskId != null && payload.recordId != null)
                    "engine-signed-out" -> require(payload.runnerId != null && !payload.engine.isNullOrBlank())
                    "watch-matched" -> require(payload.watchId != null && (payload.generation ?: 0) > 0)
                    in PushPayload.ownerItemKinds -> require(payload.projectId != null && payload.openItemId != null)
                    else -> require(payload.wikiSpaceId != null)
                }
            }
            PushMessage(type, binding, event, key, sent, payload)
        } catch (_: Exception) { null }
    }
}
