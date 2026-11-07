package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.auth.SecureStorageException
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

internal fun JsonObject.text(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull
internal fun JsonObject.number(key: String) = (get(key) as? JsonPrimitive)?.longOrNull

const val SENTINEL_SEQ = 9_007_199_254_740_991L
private val liveTypes = setOf("text_delta", "thinking_delta", "tool_output", "approval_request",
    "approval_resolved", "queued_turns_changed", "background_output", "task_progress", "resync", "ping")

@Serializable
data class RunEvent(
    val type: String,
    val seq: Long = 0,
    val payload: JsonElement = JsonNull,
    val turnId: String? = null,
    val ts: String? = null,
    val truncated: Boolean = false,
) {
    val durable: Boolean get() = type !in liveTypes && seq in 1 until SENTINEL_SEQ
    val fields: JsonObject get() = payload as? JsonObject ?: JsonObject(emptyMap())
    companion object {
        fun decode(frame: SseFrame): RunEvent = Wire.decode(frame.data.encodeToByteArray(), serializer())
    }
}

@Serializable
data class EventPage(val events: List<RunEvent>, val hasMore: Boolean = false, val after: Long? = null,
    val before: Long? = null, val anchor: RecordAnchor? = null)

@Serializable
data class RecordAnchor(val kind: String, val id: String, val seq: Long)

@Serializable
data class ControlEvent(val type: String, val sessionId: String = "", val data: JsonObject = JsonObject(emptyMap()))

/** The lists the store reads as its directory ([RealtimeRest.directory]). */
internal enum class DirectoryList {
    WORKSPACES, FOLDERS, TAGS, RUNNERS, OPEN;
    companion object { val ALL: Set<DirectoryList> = entries.toSet() }
}

/** What an account event moves of the store's lists (docs/list-freshness-design.md §4 R5). A session's, an approval's or a background
 * job's moves its row in Open and nothing else the store reads; each library event its own list, and `agent.changed` the workspaces.
 * Runners have no event: a connect reads them. Any other type — a task's, a project's, a watch's, the wiki's, or one this build does
 * not know — reads none of them. */
internal fun directoryListsMovedBy(type: String): Set<DirectoryList> = when {
    type.startsWith("session.") || type.startsWith("approval.") || type == "background.task" -> setOf(DirectoryList.OPEN)
    type == "tag.changed" -> setOf(DirectoryList.TAGS)
    type == "folder.changed" -> setOf(DirectoryList.FOLDERS)
    type == "agent.changed" -> setOf(DirectoryList.WORKSPACES)
    else -> emptySet()
}

/** The account events that move [RealtimeState.invalidationRevision]: every type of src/shared/src/realtime.ts `ControlEventType` this
 * build knows, but `wiki.changed`, which by contract asks for the wiki to be read again and nothing else, and `notification`, which
 * carries nothing yet. A type this build does not know asks for no read at all (R5). */
internal val INVALIDATING_EVENTS = setOf("session.created", "session.updated", "session.ended", "session.error", "approval.requested",
    "approval.resolved", "background.task", "task.changed", "agent.changed", "task.list.changed", "tag.changed", "folder.changed",
    "provider.changed", "project.criteria_decisions.changed", "project.changed", "watch.changed")

/** `sessions.list_changed` (docs/realtime-control-plane-stream.md §4.8): the Open list may read differently. Sent only to a stream that
 * declared [LIST_CHANGED_HINT]; answered with one `since=` read of the Open list, never by itself a change. */
internal const val LIST_CHANGED = "sessions.list_changed"
/** The `hints=` value of `GET /api/events` that declares this build understands [LIST_CHANGED] (`CONTROL_HINT_LIST_CHANGED`). */
internal const val LIST_CHANGED_HINT = "list_changed"

/** Whether an account event can move what the open conversation reads — its snapshot ([RealtimeRest.session]) and its reader's cards:
 * one about this session, or a project or task event of the project it belongs to. `task.changed` names no project, so it concerns
 * the session when the session created the task (the envelope's sessionId), when it is the session's own task, or when it asks for a
 * full resync. Ids are compared in either spelling (UUID or public). */
internal fun ControlEvent.concerns(session: SessionState?): Boolean {
    val id = session?.id ?: return false
    if (sameId(sessionId, id)) return true
    val detail = session.snapshot?.detail ?: return false
    val project = detail.text("projectId") ?: (detail["project"] as? JsonObject)?.text("id")
    return when {
        type.startsWith("project.") -> project != null && sameId(data.text("id"), project)
        type == "task.changed" -> {
            val task = detail.text("taskId")
            (data["resync"] as? JsonPrimitive)?.contentOrNull == "true" || task != null &&
                (sameId(data.text("taskId"), task) || (data["taskIds"] as? JsonArray).orEmpty().any { sameId((it as? JsonPrimitive)?.contentOrNull, task) })
        }
        else -> false
    }
}

private fun sameId(a: String?, b: String?): Boolean = a != null && b != null && a.isNotEmpty() && (a == b || canonicalId(a)?.let { it == canonicalId(b) } == true)

/** A UUID or its public Base62 spelling, as a lower-case UUID; null for anything else. */
private fun canonicalId(value: String): String? {
    if (uuid.matches(value)) return value.lowercase()
    if (value.length > 22 || value.any { it !in base62 }) return null
    var number = java.math.BigInteger.ZERO
    val radix = java.math.BigInteger.valueOf(62)
    value.forEach { number = number * radix + java.math.BigInteger.valueOf(base62.indexOf(it).toLong()) }
    if (number.bitLength() > 128) return null
    val hex = number.toString(16).padStart(32, '0')
    return "${hex.take(8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
}
private const val base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

enum class ConnectionState { STOPPED, CONNECTING, CONNECTED, BACKOFF }
enum class FailureReason { NETWORK, HTTP, PROTOCOL, STORAGE }
data class RealtimeError(val reason: FailureReason, val httpStatus: Int? = null) {
    companion object {
        internal fun from(error: Exception) = when (error) {
            is ApiError -> RealtimeError(FailureReason.HTTP, error.status)
            is ProtocolException -> RealtimeError(FailureReason.PROTOCOL)
            is SecureStorageException -> RealtimeError(FailureReason.STORAGE)
            else -> RealtimeError(FailureReason.NETWORK)
        }
    }
}

/** Full REST objects preserve capabilities, explicit nulls, and future directory fields. */
@Serializable
data class DirectorySnapshot(
    val workspaces: List<JsonObject> = emptyList(),
    val sessions: Map<String, List<JsonObject>> = emptyMap(),
    val folders: List<JsonObject> = emptyList(),
    val tags: List<JsonObject> = emptyList(),
    val runners: List<JsonObject> = emptyList(),
)

/** Live-only authority is never loaded from a disk cache. A failed refresh leaves it stale,
 * not empty/resolved; consumers must require fresh before offering an action on a card. */
data class SessionSnapshot(
    val detail: JsonObject,
    val approvals: List<JsonObject>,
    /** `GET …/turns?view=active`: the user turns no transcript event draws yet, each with its `placement` — the accepted head, the
     * queue behind it and steers — and the receipts of steers that never made it (`delivery`). */
    val queuedTurns: List<JsonObject>,
    val background: List<JsonObject>,
    val standing: Map<String, JsonElement>,
)

data class SessionState(
    val id: String,
    val transcript: Transcript = Transcript(),
    val snapshot: SessionSnapshot? = null,
    val fresh: Boolean = false,
    val connection: ConnectionState = ConnectionState.STOPPED,
    val error: RealtimeError? = null,
    val accessDenied: Boolean = false,
    /** The transcript is the device's own copy from when the session was selected (RealtimeCache), not since re-seeded from
     * the server's tail: what a reader draws first came off the disk. D09 P02 tells its warm-cache case apart by it. */
    val seededFromCache: Boolean = false,
    /** How many snapshot reads have landed for this selection. The reader's cards read again behind each one, and on nothing else
     * of the store's: an account event about another session moves neither. */
    val snapshotReads: Long = 0,
)

data class RealtimeState(
    val handle: SessionHandle? = null,
    val directory: DirectorySnapshot? = null,
    val directoryRefreshing: Boolean = false,
    /** A read that left on this connection has landed, none has failed since, and none asked for since is still out. An account
     * event does not withdraw it: the directory is read again behind the rows it moves. */
    val directoryFresh: Boolean = false,
    /** [directory] is the copy this device's cache restored, and no read from the server has replaced it yet. */
    val directoryCached: Boolean = false,
    /** This device's copy has been read, whether or not there was one: until then no rows says nothing yet. */
    val directoryRestored: Boolean = false,
    val directoryError: RealtimeError? = null,
    val session: SessionState? = null,
    val controlConnection: ConnectionState = ConnectionState.STOPPED,
    val controlError: RealtimeError? = null,
    /** Changes on every control reconnect, and once for each burst of account events ([RealtimeStore.EVENT_WINDOW_MS]) that held one
     * of [INVALIDATING_EVENTS], including empty sessionId events. Business pages use it to re-read their own authoritative REST state. */
    val invalidationRevision: Long = 0,
    /** How many account events of each type this handle's stream has delivered, and how many times the stream has
     * (re)connected. A page that owns a model re-reads it on the event types that concern it (iOS `AppModel.apply`)
     * and on every connect, which replays nothing; counts only grow, so no event is lost to a conflated read. */
    val accountEvents: Map<String, Long> = emptyMap(),
    val controlConnects: Long = 0,
)

class ReconnectPolicy(private val jitter: () -> Double = { Math.random() }) {
    private var failures = 0
    fun healthy() { failures = 0 }
    fun delayMs(failed: Boolean): Long {
        if (!failed) return 300
        val base = minOf(15_000L, 1_000L shl minOf(failures++, 4))
        return (base * (0.8 + 0.2 * jitter().coerceIn(0.0, 1.0))).toLong()
    }
}
