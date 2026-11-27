package io.orbitd.android.core.guests

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.SessionFacts
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.core.realtime.SseFrame
import io.orbitd.android.directory.SessionDisplay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer

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
    val facts: JsonObject = JsonObject(emptyMap()),
) {
    /** How the session stands, read from the row's own fields the way the guest view reads its head. */
    val state: GuestState get() = GuestState(runStatus = status, sessionState = sessionState, lifecycleState = lifecycleState,
        phase = SessionFacts.phase(facts), released = SessionFacts.released(facts), lastTurnOutcome = SessionFacts.lastTurnOutcome(facts),
        waitingOn = SessionFacts.waitingOn(facts), endReason = SessionFacts.endReason(facts), workFinished = SessionFacts.workFinished(facts),
        activity = SessionDisplay.facts(facts).activity, pendingApprovals = SessionDisplay.facts(facts).pendingApprovals,
        runningBgCount = SessionDisplay.facts(facts).runningBgCount)
}

/** The head fields the guest door answers beside its events, and whether the agent waits on its owner. */
data class GuestState(
    val runState: String? = null,
    val runStatus: String? = null,
    val sessionState: String? = null,
    val lifecycleState: String? = null,
    val waitingOnOwner: Boolean = false,
    // The session facts (contracts/session-state.contract.json); null from an older server or a word this build does not know.
    val phase: String? = null,
    val released: Boolean? = null,
    val lastTurnOutcome: String? = null,
    val waitingOn: String? = null,
    val endReason: String? = null,
    val workFinished: Boolean? = null,
    // What a mark reads beside the facts, where the payload sends it.
    val activity: String? = null,
    val pendingApprovals: Int = 0,
    val runningBgCount: Int = 0,
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
        phase = SessionFacts.phase(obj), released = SessionFacts.released(obj), lastTurnOutcome = SessionFacts.lastTurnOutcome(obj),
        waitingOn = SessionFacts.waitingOn(obj), endReason = SessionFacts.endReason(obj), workFinished = SessionFacts.workFinished(obj),
        activity = SessionDisplay.facts(obj).activity, pendingApprovals = SessionDisplay.facts(obj).pendingApprovals,
        runningBgCount = SessionDisplay.facts(obj).runningBgCount,
    )

    fun list(bytes: ByteArray): List<GuestSessionSummary> = (root(bytes)["sessions"] as? JsonArray).orEmpty()
        .filterIsInstance<JsonObject>().mapNotNull { row ->
            val id = row.string("id") ?: return@mapNotNull null
            GuestSessionSummary(id, row.string("title").orEmpty(), row.string("ownerName").orEmpty(), row.string("status"),
                row.string("sessionState"), row.string("lifecycleState"), row.string("addedAt").orEmpty(), row.string("lastTurnAt"), row)
        }

    fun session(bytes: ByteArray): GuestSession = root(bytes).let {
        GuestSession(it.string("title").orEmpty(), it.string("ownerName").orEmpty(), state(it), events(it), it.bool("hasMore") ?: false)
    }

    fun now(bytes: ByteArray): GuestSessionNow = root(bytes).let { GuestSessionNow(it.string("title"), state(it), events(it), it.long("after")) }

    fun page(bytes: ByteArray): GuestEventPage = root(bytes).let { GuestEventPage(events(it), it.bool("hasMore") ?: false) }

    /** A `head` frame's payload: the title, when it has one, and the state as `events?after=` states it. */
    fun head(obj: JsonObject): Pair<String?, GuestState> = obj.string("title") to state(obj)

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

/** One image a guest attaches to their next message (`POST /guest-sessions/:id/attachments`, one `file` part): its attachment id. Only
 * PNG, JPEG, WebP or GIF up to 5 MB ([GuestImages]); a 404 is "not shared with you", as on every guest route. Web parity:
 * `uploadGuestAttachment`. */
suspend fun OrbitApi.uploadGuestAttachment(handle: SessionHandle, id: String, name: String, mime: String, bytes: ByteArray): String {
    val multipart = MultipartBody.Builder().setType(MultipartBody.FORM)
        .addFormDataPart("file", name, bytes.toRequestBody(mime.toMediaType())).build()
    val encoded = Buffer().apply { multipart.writeTo(this) }.readByteArray()
    val answer = Wire.decode(request(handle, ApiRequest(guestPath(id, "attachments"), HttpMethod.POST, body = encoded,
        contentType = multipart.contentType().toString())).body, JsonObject.serializer())
    return (answer["id"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: error("Upload response has no attachment id.")
}

/** A guest's message — its words and the images attached to it ([attachmentIds], from [uploadGuestAttachment]), no mode, model or
 * effort (§5) — a turn of the owner's session, which restarts it when it has ended. [content] may be empty when images go with it.
 * Web parity: `sendGuestTurn`. */
suspend fun OrbitApi.sendGuestTurn(handle: SessionHandle, id: String, clientTurnId: String, content: String,
    attachmentIds: List<String> = emptyList()): GuestTurnAccepted =
    GuestWire.accepted(request(handle, ApiRequest(guestPath(id, "turns"), HttpMethod.POST,
        body = buildJsonObject {
            put("clientTurnId", clientTurnId); put("content", content)
            if (attachmentIds.isNotEmpty()) putJsonArray("attachmentIds") { attachmentIds.forEach { add(it) } }
        }.toString().encodeToByteArray())).body)

/** The guest stream (`GET /guest-sessions/:id/stream`, docs/session-viewer-stream-design.md §3): the events after [sinceSeq] — the
 * newest page when it is 0 — then live ones, deltas included, `head` frames for the state, and a `gone` frame when access ends.
 * Web parity: `useSessionStream` on the guest stream. */
fun interface GuestStream {
    /** Returns when the server ends the stream; throws when it cannot be opened or drops. [onOpen] follows the headers. */
    suspend fun open(id: String, sinceSeq: Long, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit)
}

/** The guest stream's request: [sinceSeq] when there is one, and the listed reads' payload cap. */
fun guestStreamRequest(id: String, sinceSeq: Long) = ApiRequest(guestPath(id, "stream"),
    query = (if (sinceSeq > 0) listOf("sinceSeq" to "$sinceSeq") else emptyList()) + ("maxPayload" to "$GUEST_MAX_PAYLOAD"))

/** The guest stream over this account's own SSE transport ([AuthSession.stream], `EventTransport`). */
fun AuthSession.guestStream(handle: SessionHandle) = GuestStream { id, sinceSeq, onOpen, onFrame ->
    stream(handle, guestStreamRequest(id, sinceSeq), onOpen, onFrame)
}
