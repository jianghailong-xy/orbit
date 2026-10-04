package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.auth.SecureStorageException
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.Serializable
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
data class EventPage(val events: List<RunEvent>, val hasMore: Boolean = false, val after: Long? = null)

@Serializable
data class ControlEvent(val type: String, val sessionId: String = "", val data: JsonObject = JsonObject(emptyMap()))

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
)

data class RealtimeState(
    val handle: SessionHandle? = null,
    val directory: DirectorySnapshot? = null,
    val directoryRefreshing: Boolean = false,
    val directoryFresh: Boolean = false,
    val directoryError: RealtimeError? = null,
    val session: SessionState? = null,
    val controlConnection: ConnectionState = ConnectionState.STOPPED,
    val controlError: RealtimeError? = null,
    /** Changes on every control reconnect and non-ping event, including empty sessionId events.
     * Business pages use it to re-read their own authoritative REST state. */
    val invalidationRevision: Long = 0,
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
