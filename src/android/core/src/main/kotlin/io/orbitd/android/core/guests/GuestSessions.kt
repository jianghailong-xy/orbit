package io.orbitd.android.core.guests

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

// The guest's side of session guests (docs/session-guests-design.md §4, §7): Shared with me and the guest door, as OrbitKit's
// SessionGuests.swift reads them. Every head field is optional on the wire: an older or newer control plane missing one must not fail
// the read.

/** One row of the guest's Shared with me (`GET /guest-sessions`), `@orbit/shared`'s `GuestSessionSummary`. */
data class GuestSessionSummary(
    val id: String,
    val title: String,
    val ownerName: String,
    val status: String? = null,
    val sessionState: String? = null,
    val lifecycleState: String? = null,
    val addedAt: String = "",
    val lastTurnAt: String? = null,
) {
    /** How the session stands, read from the row's own fields the way the guest view reads its head. */
    val state: GuestState get() = GuestState(runStatus = status, sessionState = sessionState, lifecycleState = lifecycleState)
}

/** The head fields the guest door answers beside its events, and whether the agent waits on its owner. */
data class GuestState(
    val runState: String? = null,
    val runStatus: String? = null,
    val sessionState: String? = null,
    val lifecycleState: String? = null,
    val waitingOnOwner: Boolean = false,
)

/** The guest view's root (`GET /guest-sessions/:id`): who shared it, how it stands, and the newest page of its transcript. */
data class GuestSession(val title: String, val ownerName: String, val state: GuestState, val events: List<RunEvent>, val hasMore: Boolean)

/** What `events?after=` answers: the head as it stands now, the events newer than the seq asked after, and `after` — where the rest
 * start, null once these reach the newest. */
data class GuestSessionNow(val title: String?, val state: GuestState, val events: List<RunEvent>, val after: Long?)

/** An older page of the guest's transcript (`events?before=`). */
data class GuestEventPage(val events: List<RunEvent>, val hasMore: Boolean)

/** What a guest's message answers: its turn, and whether it restarted an ended session. */
data class GuestTurnAccepted(val turnId: String?, val revived: Boolean)

/** Reads the door's answers field by field, so a missing or mistyped field is a default, never a failed read. */
object GuestWire {
    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    private fun JsonObject.bool(key: String): Boolean? = (get(key) as? JsonPrimitive)?.booleanOrNull
    private fun JsonObject.long(key: String): Long? = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull

    private fun root(bytes: ByteArray): JsonObject = Wire.decode(bytes, JsonObject.serializer())

    private fun events(obj: JsonObject): List<RunEvent> = (obj["events"] as? JsonArray).orEmpty().mapNotNull { event ->
        runCatching { Wire.json.decodeFromJsonElement(RunEvent.serializer(), event) }.getOrNull()
    }

    fun state(obj: JsonObject) = GuestState(
        runState = obj.string("runState"),
        runStatus = obj.string("runStatus") ?: obj.string("status"),
        sessionState = obj.string("sessionState"),
        lifecycleState = obj.string("lifecycleState") ?: obj.string("filingState"),
        waitingOnOwner = obj.bool("waitingOnOwner") ?: false,
    )

    fun list(bytes: ByteArray): List<GuestSessionSummary> = (root(bytes)["sessions"] as? JsonArray).orEmpty()
        .filterIsInstance<JsonObject>().mapNotNull { row ->
            val id = row.string("id") ?: return@mapNotNull null
            GuestSessionSummary(id, row.string("title").orEmpty(), row.string("ownerName").orEmpty(), row.string("status"),
                row.string("sessionState"), row.string("lifecycleState"), row.string("addedAt").orEmpty(), row.string("lastTurnAt"))
        }

    fun session(bytes: ByteArray): GuestSession = root(bytes).let {
        GuestSession(it.string("title").orEmpty(), it.string("ownerName").orEmpty(), state(it), events(it), it.bool("hasMore") ?: false)
    }

    fun now(bytes: ByteArray): GuestSessionNow = root(bytes).let { GuestSessionNow(it.string("title"), state(it), events(it), it.long("after")) }

    fun page(bytes: ByteArray): GuestEventPage = root(bytes).let { GuestEventPage(events(it), it.bool("hasMore") ?: false) }

    fun accepted(bytes: ByteArray): GuestTurnAccepted = root(bytes).let { GuestTurnAccepted(it.string("turnId"), it.bool("revived") ?: false) }
}

/** The largest payload a listed event carries before it comes back `truncated` (the reader's own `maxPayload`). */
const val GUEST_MAX_PAYLOAD = 2048

private fun guestPath(id: String, vararg rest: String) = listOf("guest-sessions", id) + rest

/** Shared with me: every session this account was invited to reply in. Web parity: `listGuestSessions`. */
suspend fun OrbitApi.guestSessions(handle: SessionHandle): List<GuestSessionSummary> =
    GuestWire.list(request(handle, ApiRequest(listOf("guest-sessions"))).body)

/** The guest view's root: the head and the newest [limit] events. A 404 is "not shared with you" — removed, left, Trash and deleted
 * all read the same. Web parity: `getGuestSession`. */
suspend fun OrbitApi.guestSession(handle: SessionHandle, id: String, limit: Int = GuestFollow.TAIL_PAGE): GuestSession =
    GuestWire.session(request(handle, ApiRequest(guestPath(id),
        query = listOf("limit" to "$limit", "maxPayload" to "$GUEST_MAX_PAYLOAD"))).body)

/** What the conversation added since [after], and how it stands now. Web parity: `getGuestEventsAfter`. */
suspend fun OrbitApi.guestEventsAfter(handle: SessionHandle, id: String, after: Long, limit: Int = GuestFollow.PAGE_SIZE): GuestSessionNow =
    GuestWire.now(request(handle, ApiRequest(guestPath(id, "events"),
        query = listOf("after" to "$after", "limit" to "$limit", "maxPayload" to "$GUEST_MAX_PAYLOAD"))).body)

/** The page just older than [before]. Web parity: `getGuestEventPage`. */
suspend fun OrbitApi.guestEventsBefore(handle: SessionHandle, id: String, before: Long, limit: Int = GuestFollow.PAGE_SIZE): GuestEventPage =
    GuestWire.page(request(handle, ApiRequest(guestPath(id, "events"),
        query = listOf("before" to "$before", "limit" to "$limit", "maxPayload" to "$GUEST_MAX_PAYLOAD"))).body)

/** One event whole, for a card that came back `truncated`. Web parity: `getGuestEventFull`. */
suspend fun OrbitApi.guestEventFull(handle: SessionHandle, id: String, seq: Long): RunEvent =
    Wire.decode(request(handle, ApiRequest(guestPath(id, "events", "$seq"), maxResponseBytes = 40L * 1024 * 1024)).body, RunEvent.serializer())

/** A guest's message — text only, no mode, model, effort or attachment (§5) — a turn of the owner's session, which restarts it when
 * it has ended. Web parity: `sendGuestTurn`. */
suspend fun OrbitApi.sendGuestTurn(handle: SessionHandle, id: String, clientTurnId: String, content: String): GuestTurnAccepted =
    GuestWire.accepted(request(handle, ApiRequest(guestPath(id, "turns"), HttpMethod.POST,
        body = buildJsonObject { put("clientTurnId", clientTurnId); put("content", content) }.toString().encodeToByteArray())).body)
