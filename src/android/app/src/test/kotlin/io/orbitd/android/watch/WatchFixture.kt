package io.orbitd.android.watch

import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.*
import java.io.File
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.concurrent.CopyOnWriteArrayList

/** Watches the way `GET /watches` sends them — a JSON object through the real decoder — so no test can hold a
 * shape the wire never has (OrbitKit `WatchTestFixtures`). */
internal object WatchFixture {
    /** The clock every projection test reads against. */
    val now: Instant = Instant.parse("2026-09-14T10:00:00Z")

    private val iso = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /** A timestamp `seconds` before `now`; a negative number is after it. */
    fun ago(seconds: Double): String = iso.format(now.minusMillis((seconds * 1000).toLong()))
    fun ago(seconds: Int): String = ago(seconds.toDouble())

    fun all(leaf: String) = buildJsonObject { put("kind", "ALL"); put("over", "ALL_TARGETS"); put("leaf", leaf) }
    fun any(leaf: String) = buildJsonObject { put("kind", "ANY"); put("over", "ALL_TARGETS"); put("leaf", leaf) }
    fun composite(kind: String, vararg operands: JsonObject) = buildJsonObject { put("kind", kind); put("operands", JsonArray(operands.toList())) }

    fun target(id: String, kind: String = "TASK", state: String = "OBSERVED", title: String? = null, status: JsonObject? = null) = buildJsonObject {
        put("targetKind", kind); put("targetResourceId", id); put("state", state); put("targetEpoch", 0); put("lastEvaluatedAt", null as String?)
        title?.let { put("targetTitle", it) }
        status?.let { put("targetStatus", it) }
    }

    fun status(status: String, running: Boolean = false, queued: Boolean = false) =
        buildJsonObject { put("status", status); put("running", running); put("queued", queued) }

    /** `n` task targets, the first `met` of them SATISFIED. */
    fun tasks(n: Int, met: Int = 0) = (0 until n).map { target("T$it", state = if (it < met) "SATISFIED" else "OBSERVED") }

    fun delivery(state: String, action: String = "RESUME_SESSION", attempts: Int = 0, lastError: String? = null) = buildJsonObject {
        put("id", "D-$state-$attempts"); put("action", action); put("state", state); put("attempts", attempts)
        put("nextAttemptAt", null as String?); put("lastError", lastError); put("deliveredAt", null as String?)
        put("deadLetteredAt", null as String?); put("createdAt", ago(60)); put("updatedAt", ago(30))
    }

    fun match(generation: Int = 1, deliveries: List<JsonObject>) = buildJsonObject {
        put("id", "M$generation"); put("generation", generation); put("matchedAt", ago(60))
        put("reason", "ALL TASK_TERMINAL 2/2"); put("predicateVersion", 1)
        putJsonObject("perTargetSnapshot") { put("evaluatedAt", ago(60)); putJsonArray("targets") {} }
        put("deliveries", JsonArray(deliveries))
    }

    /** An unmatched end's delivery: the wire flattens the delivery's own fields beside `kind`. */
    fun end(kind: String, delivery: JsonObject) = JsonObject(delivery + mapOf("kind" to JsonPrimitive(kind), "expirySnapshot" to JsonNull))

    fun json(id: String = "W1", state: String = "ACTIVE", action: String = "RESUME_SESSION", observer: String? = "S1",
        predicate: JsonObject = all("TASK_TERMINAL"), targets: List<JsonObject> = tasks(2), matches: List<JsonObject> = emptyList(),
        endDeliveries: List<JsonObject> = emptyList(), generation: Int = 0, lastEvaluatedAt: String? = ago(20),
        createdAt: String = ago(600), expiresAt: String = ago(-3_600), predicateVersion: Int = 1) = buildJsonObject {
        put("id", id); put("observerType", if (observer == null) "USER" else "SESSION"); put("observerSessionId", observer)
        put("predicateVersion", predicateVersion); put("predicate", predicate); put("mode", "ONE_SHOT"); put("action", action)
        put("state", state); put("generation", generation); put("expiresAt", expiresAt); put("nextEvaluateAt", null as String?)
        put("lastEvaluatedAt", lastEvaluatedAt); put("idempotencyKey", null as String?); put("createdAt", createdAt)
        put("updatedAt", createdAt); put("targets", JsonArray(targets)); put("matches", JsonArray(matches))
        put("expiryDeliveries", JsonArray(endDeliveries))
    }

    fun watch(id: String = "W1", state: String = "ACTIVE", action: String = "RESUME_SESSION", observer: String? = "S1",
        predicate: JsonObject = all("TASK_TERMINAL"), targets: List<JsonObject> = tasks(2), matches: List<JsonObject> = emptyList(),
        endDeliveries: List<JsonObject> = emptyList(), generation: Int = 0, lastEvaluatedAt: String? = ago(20),
        createdAt: String = ago(600), expiresAt: String = ago(-3_600), predicateVersion: Int = 1): Watch =
        server(json(id, state, action, observer, predicate, targets, matches, endDeliveries, generation, lastEvaluatedAt, createdAt, expiresAt,
            predicateVersion).toString())

    /** A row exactly as a server sent it, through the real decoder. */
    fun server(json: String): Watch = requireNotNull(Watch.decode(Wire.json.parseToJsonElement(json))) { "not a watch: $json" }

    private fun repoFile(relative: String): File = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .map { File(it, relative) }.firstOrNull { it.isFile }
        ?: error("$relative was not found above ${System.getProperty("user.dir")}. If it moved, point this check at its new home — don't delete the check.")

    /** `contracts/watch.contract.json`, found by walking up rather than by counting `..`. Never a skip. */
    fun contract(): JsonObject = Wire.json.parseToJsonElement(repoFile("contracts/watch.contract.json").readText()).jsonObject

    /** `src/shared/src/watch-strip.fixture.json`: the strip's sentences both clients are proved against. */
    fun strip(): JsonObject = Wire.json.parseToJsonElement(repoFile("src/shared/src/watch-strip.fixture.json").readText()).jsonObject

    /** Captured from a real apiserver: a Match whose queued wake was withdrawn before a runner took it. */
    const val WITHDRAWN_WAKE_JSON = """
    {"id":"34Oaok4mTYwXssYuZtrVT","observerType":"SESSION","observerSessionId":"34OaohdITbxmALi8Uc0e8","predicateVersion":1,
     "predicate":{"kind":"ALL","leaf":"TASK_TERMINAL","over":"ALL_TARGETS"},"mode":"ONE_SHOT","action":"RESUME_SESSION","state":"MATCHED",
     "generation":1,"debounceSeconds":null,"wakeBudget":null,"holding":true,"windowOpenedAt":null,"windowClosesAt":null,"windowCrossings":0,
     "expiresAt":"2026-09-14T10:06:59.570Z","nextEvaluateAt":null,"lastEvaluatedAt":"2026-09-14T09:06:59.570Z","idempotencyKey":null,
     "createdAt":"2026-09-14T09:06:59.570Z","updatedAt":"2026-09-14T09:06:59.570Z",
     "targets":[{"targetKind":"TASK","targetResourceId":"34OaoimYU7A8ltmI7bR20","state":"SATISFIED","targetEpoch":0,
       "lastEvaluatedAt":"2026-09-14T09:06:59.570Z","targetResourcePublicId":"34OaoimYU7A8ltmI7bR20"}],
     "matches":[{"id":"34OaokHe7NBnv0o4KO9NB","generation":1,"matchedAt":"2026-09-14T09:06:59.570Z","reason":"ALL TASK_TERMINAL 1/1",
       "predicateVersion":1,"perTargetSnapshot":{"targets":[{"id":"34OaoimYU7A8ltmI7bR20","kind":"TASK","epoch":0,"state":"SATISFIED",
         "leaves":{"TASK_TERMINAL":true},"changed":true,"observed":{"status":"CANCELLED"},"publicId":"34OaoimYU7A8ltmI7bR20"}],
         "evaluatedAt":"2026-09-14T09:06:59.570Z"},
       "deliveries":[{"id":"34OaokTFL8pJizFAA6UBK","action":"RESUME_SESSION","state":"DEAD_LETTER","attempts":0,
         "nextAttemptAt":"2026-09-14T09:06:59.570Z",
         "lastError":"WAKE_WITHDRAWN: the wake was withdrawn from the observer session's queue before a runner took it",
         "deliveredAt":null,"deadLetteredAt":"2026-09-14T09:07:02.218Z","createdAt":"2026-09-14T09:06:59.821Z",
         "updatedAt":"2026-09-14T09:07:02.218Z","publicId":"34OaokTFL8pJizFAA6UBK"}],"publicId":"34OaokHe7NBnv0o4KO9NB"}],
     "expiryDeliveries":[],"publicId":"34Oaok4mTYwXssYuZtrVT","observerSessionPublicId":"34OaohdITbxmALi8Uc0e8"}
    """

    /** The same capture's dead letter: a wake refused because its observer session no longer belonged to the owner. */
    const val PERMISSION_REVOKED_JSON = """
    {"id":"34OaSJLp3jawfjGbKI8GJ","observerType":"SESSION","observerSessionId":"34OaSIlShOFrsffZ7e6A7","predicateVersion":1,
     "predicate":{"kind":"ALL","leaf":"TASK_TERMINAL","over":"ALL_TARGETS"},"mode":"ONE_SHOT","action":"RESUME_SESSION","state":"MATCHED",
     "generation":1,"debounceSeconds":null,"wakeBudget":null,"holding":true,"windowOpenedAt":null,"windowClosesAt":null,"windowCrossings":0,
     "expiresAt":"2026-09-14T09:52:15.031Z","nextEvaluateAt":null,"lastEvaluatedAt":"2026-09-14T08:52:15.972Z","idempotencyKey":null,
     "createdAt":"2026-09-14T08:52:15.031Z","updatedAt":"2026-09-14T08:52:15.972Z",
     "targets":[{"targetKind":"TASK","targetResourceId":"34OaSIxS5CsitlDZTFr4A","state":"SATISFIED","targetEpoch":0,
       "lastEvaluatedAt":"2026-09-14T08:52:15.972Z","targetResourcePublicId":"34OaSIxS5CsitlDZTFr4A"}],
     "matches":[{"id":"7QkwVAba7ITZgBu2HQDFbM","generation":1,"matchedAt":"2026-09-14T08:52:15.972Z","reason":"ALL TASK_TERMINAL 1/1",
       "predicateVersion":1,"perTargetSnapshot":{"targets":[{"id":"34OaSIxS5CsitlDZTFr4A","kind":"TASK","epoch":0,"state":"SATISFIED",
         "leaves":{"TASK_TERMINAL":true},"changed":true,"observed":{"status":"CANCELLED"},"publicId":"34OaSIxS5CsitlDZTFr4A"}],
         "evaluatedAt":"2026-09-14T08:52:15.972Z"},
       "deliveries":[{"id":"3hTepmtGWlbs68R1D2ByDE","action":"RESUME_SESSION","state":"DEAD_LETTER","attempts":1,
         "nextAttemptAt":"2026-09-14T08:52:20.643Z",
         "lastError":"PERMISSION_REVOKED: the observer session no longer belongs to the watch's owner, so it was not woken",
         "deliveredAt":null,"deadLetteredAt":"2026-09-14T08:52:24.159Z","createdAt":"2026-09-14T08:52:15.972Z",
         "updatedAt":"2026-09-14T08:52:24.159Z","publicId":"3hTepmtGWlbs68R1D2ByDE"}],"publicId":"7QkwVAba7ITZgBu2HQDFbM"}],
     "expiryDeliveries":[],"publicId":"34OaSJLp3jawfjGbKI8GJ","observerSessionPublicId":"34OaSIlShOFrsffZ7e6A7"}
    """
}

/** A controlled `/api` in front of a real `AuthSession`: every request is journaled, and `respond` answers it.
 * Requests run on the caller's thread, so a test reads what the store did as soon as the call returns. */
internal class FakeWatchServer {
    data class Call(val method: String, val path: String, val query: String?, val body: String?) {
        val line get() = "$method $path" + (query?.let { "?$it" } ?: "")
    }

    val calls = CopyOnWriteArrayList<Call>()
    /** Status and body for a request; a status of -1 is a dropped connection. */
    @Volatile var respond: (Call) -> Pair<Int, String> = { 200 to "[]" }
    /** A gate a request waits at before it is answered, to land two requests in a chosen order. */
    @Volatile var hold: (Call) -> CompletableDeferred<Unit>? = { null }

    /** The account stream: each (re)connect opens and takes the events [event] queued; a session's stream stays quiet. */
    private val frames = Channel<String>(Channel.UNLIMITED)
    fun event(type: String) { frames.trySend("""{"type":"$type","sessionId":"","data":{}}""") }
    private val events = object : EventTransport {
        override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) {
            if (request.api.path != listOf("events")) awaitCancellation()
            onOpen()
            for (frame in frames) onFrame(SseFrame(frame, null, null))
        }
    }

    val auth = AuthSession(HttpTransport { request ->
        val api = request.api
        if (api.path == listOf("auth", "login")) return@HttpTransport ApiResponse(200,
            """{"accessToken":"watch-access","refreshToken":"watch-refresh","user":{"id":"u1","email":"a@example.test","name":"A"}}""".encodeToByteArray())
        val call = Call(api.method.name, "/api/" + api.path.joinToString("/"),
            api.query.takeIf { it.isNotEmpty() }?.joinToString("&") { "${it.first}=${it.second}" }, api.body?.decodeToString())
        calls += call
        hold(call)?.await()
        val (status, body) = respond(call)
        if (status == -1) throw NetworkException()
        ApiResponse(status, body.encodeToByteArray())
    }, object : CredentialStore {
        private var saved: StoredSession? = null
        override suspend fun load() = saved
        override suspend fun save(session: StoredSession) { saved = session }
        override suspend fun clear() { saved = null }
    }, object : InstanceStore {
        override suspend fun load(): String? = null
        override suspend fun save(server: String) {}
    }, object : SessionDataStore {
        override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) {}
        override suspend fun clearAll() {}
    }, "test", dispatcher = Dispatchers.Unconfined, eventTransport = events)

    suspend fun signIn(): SessionHandle = auth.login(ServerAddress.parse("https://fixture.test"), "a@example.test", "fixture-password")

    val lines: List<String> get() = calls.map { it.line }

    /** The four list reads answered from one list of watch rows, filtered as the server filters them. */
    fun serve(rows: () -> List<JsonObject>, single: (String) -> Pair<Int, String>? = { null },
        control: (String, String) -> Pair<Int, String>? = { _, _ -> null }) {
        respond = { call ->
            val parts = call.path.removePrefix("/api/").split('/')
            when {
                parts == listOf("watches") && call.method == "GET" -> 200 to JsonArray(rows().filter { row ->
                    when (call.query) {
                        "state=ACTIVE" -> row["state"]?.jsonPrimitive?.content == "ACTIVE"
                        "state=PAUSED" -> row["state"]?.jsonPrimitive?.content == "PAUSED"
                        "needsAttention=true" -> false
                        else -> true
                    }
                }).toString()
                parts.size == 2 && parts[0] == "watches" && call.method == "GET" -> single(parts[1])
                    ?: rows().firstOrNull { it["id"]?.jsonPrimitive?.content == parts[1] }?.let { 200 to it.toString() } ?: (404 to """{"message":"Watch not found"}""")
                parts.size == 3 && parts[0] == "watches" && call.method == "POST" -> control(parts[1], parts[2]) ?: (404 to "{}")
                else -> 404 to "{}"
            }
        }
    }
}
