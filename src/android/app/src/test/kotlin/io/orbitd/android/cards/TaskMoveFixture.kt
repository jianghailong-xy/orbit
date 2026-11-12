package io.orbitd.android.cards

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.OkHttpTransport
import io.orbitd.android.core.net.ServerAddress
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

/**
 * A loopback server for the move card: one session's batch of task moves (`GET /sessions/:id/task-moves`), its batch door and each
 * crossing's own door, which move the rows on as the server does — a batch answered whole, or refused whole when a key it sent is not
 * the row's ([mismatch]: `APPROVAL_TARGET_MISMATCH`, nothing written).
 */
internal class TaskMoveFixture(count: Int = 8, drawnAs: List<String> = listOf("TARGET_COORDINATOR")) {
    data class Call(val method: String, val path: String, val body: String)

    val calls = CopyOnWriteArrayList<Call>()
    @Volatile var rows: List<JsonObject> = (1..count).map { move(it) }
    @Volatile var drawnAs: List<String> = drawnAs
    /** Answer the batch door with the 409 a stale key gets. */
    @Volatile var mismatch = false

    fun batches(): JsonArray = buildJsonArray {
        rows.groupBy { it.s("state") + "|" + (it.s("decidedAt") ?: "") }.forEach { (group, moves) ->
            addJsonObject {
                put("batchKey", "batch-${group.hashCode().toUInt()}"); put("requestedBySessionId", ASKER)
                put("fromProjectId", FROM); put("toProjectId", TO); put("state", moves.first().s("state")!!)
                put("since", moves.first().s("requestedAt")!!); moves.first()["decidedAt"]?.let { put("decidedAt", it) }
                putJsonArray("drawnAs") { drawnAs.forEach { add(it) } }
                put("moves", JsonArray(moves))
            }
        }
    }

    private val server = MockWebServer().apply {
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                val body = request.body.readUtf8()
                calls += Call(request.method!!, path, body)
                fun json(code: Int, text: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(text)
                return when {
                    path == "/api/auth/login" -> json(200, """{"accessToken":"or-access","refreshToken":"or-refresh","user":{"id":"u","email":"u@example.test","name":"U"}}""")
                    path == "/api/sessions/$SESSION/task-moves" && request.method == "GET" -> json(200, batches().toString())
                    path == "/api/sessions/$SESSION/task-moves/decision" -> {
                        val sent = Json.parseToJsonElement(body).jsonObject
                        if (mismatch) return json(409, """{"statusCode":409,"code":"APPROVAL_TARGET_MISMATCH","message":"the crossing key names another crossing; nothing was written"}""")
                        val state = if (sent["decision"]!!.jsonPrimitive.content == "APPROVE") "APPLIED" else "DENIED"
                        val ids = sent["moves"]!!.jsonArray.map { it.jsonObject["handoffId"]!!.jsonPrimitive.content }.toSet()
                        val at = Instant.now().toString()
                        rows = rows.map { if (it.s("id") in ids) answered(it, state, at) else it }
                        json(200, JsonArray(rows.filter { it.s("id") in ids }).toString())
                    }
                    path.startsWith("/api/projects/") && path.endsWith("/decision") -> {
                        val id = path.split('/')[5]
                        val sent = Json.parseToJsonElement(body).jsonObject
                        val state = if (sent["decision"]!!.jsonPrimitive.content == "APPROVE") "APPLIED" else "DENIED"
                        rows = rows.map { if (it.s("id") == id) answered(it, state, Instant.now().toString()) else it }
                        json(200, rows.first { it.s("id") == id }.toString())
                    }
                    else -> json(404, "{}")
                }
            }
        }
        start()
    }

    val auth = AuthSession(OkHttpTransport(), object : CredentialStore {
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
    }, "test", allowLoopbackHttp = true)

    suspend fun signIn(): SessionHandle =
        auth.login(ServerAddress.parse(server.url("/").toString(), allowLoopbackHttp = true), "u@example.test", "fixture-password")

    fun posts() = calls.filter { it.method == "POST" && !it.path.endsWith("/login") }
    fun close() = server.shutdown()

    companion object {
        const val SESSION = "34vTCaZ1bH4wJbLBaiihA"
        const val ASKER = "34uAskerSession0000001"
        const val FROM = "34uFromProject00000001"
        const val TO = "34vUNVEqe1OFz1uHNULOO"
        val TITLES = listOf(
            "An apiserver never stops gracefully: every restart cuts what is in flight",
            "A later `sudo orbit …` runs the account’s own binary as root",
            "Merged event commits queue on Postgres’s global NOTIFY lock",
            "The runner reconnect storm after a deploy",
            "Heartbeat gaps read as offline",
            "Upgrade the runner without dropping a turn",
            "Parked sessions wake twice",
            "The landing check times out on cold caches",
        )
        val CRITERIA = (4..11).map { "Criterion $it: the runner link survives what used to cut it (case $it)" }

        private fun JsonObject.s(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull

        fun move(i: Int, asked: Instant = Instant.parse("2026-11-09T00:31:00Z")) = buildJsonObject {
            val id = "34uMove0000000000000%03d".format(i)
            put("id", id); put("kind", "MOVE_TASK"); put("state", "PENDING"); put("fromProjectId", FROM); put("toProjectId", TO)
            put("title", TITLES[(i - 1) % TITLES.size]); put("crossingKey", "%064x".format(java.math.BigInteger.valueOf(0xd81f99d9L * i)))
            put("subjectTaskId", "34uTask0000000000000%03d".format(i)); put("requestedBySessionId", ASKER)
            put("requestedAt", asked.plusSeconds(i.toLong()).toString()); put("decidedAt", JsonNull)
            putJsonObject("fromProject") { put("title", "Runner link v1: runner ↔ control plane over WebSocket"); put("status", "DONE") }
            putJsonObject("toProject") { put("title", "Runner link hardening"); put("status", "OPEN") }
            putJsonObject("subjectTask") { put("id", "34uTask0000000000000%03d".format(i)); put("title", TITLES[(i - 1) % TITLES.size]) }
            putJsonObject("requestedBySession") { put("id", ASKER); put("title", "Runner link v1 coordinator") }
            putJsonObject("requestedCriterion") { put("key", "crit-$i"); put("text", CRITERIA[(i - 1) % CRITERIA.size]) }
            put("withdrawnCriterion", JsonNull)
        }

        fun answered(row: JsonObject, state: String, at: String) = JsonObject(row + buildJsonObject {
            put("state", state); put("decidedAt", at); put("decidedBy", "USER")
        })
    }
}
