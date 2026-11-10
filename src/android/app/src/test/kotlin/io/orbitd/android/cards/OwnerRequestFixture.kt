package io.orbitd.android.cards

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.OkHttpTransport
import io.orbitd.android.core.net.ServerAddress
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

/**
 * A loopback owner-requests server for the card and inbox tests: the requests it holds move from PENDING as the owner's doors are
 * pressed, and every call is kept with its body, through OkHttp and `AuthSession` as the app makes them.
 */
internal class OwnerRequestFixture {
    data class Call(val method: String, val path: String, val query: String?, val body: String)

    val calls = CopyOnWriteArrayList<Call>()
    val held = ConcurrentHashMap<String, JsonObject>()
    /** The secret door's refusal, when a test wants one. */
    @Volatile var refuseSecret: String? = null

    private val server = MockWebServer().apply {
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                val query = request.requestUrl!!.query
                calls += Call(request.method!!, path, query, request.body.readUtf8())
                fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
                val parts = path.removePrefix("/api/").split('/')
                return when {
                    path == "/api/auth/login" -> json(200, """{"accessToken":"or-access","refreshToken":"or-refresh","user":{"id":"u","email":"u@example.test","name":"U"}}""")
                    path == "/api/account-secrets" -> json(200, """{"secrets":[]}""")
                    parts.first() == "tasks" -> json(200, """{"id":"${parts[1]}","title":"Ship the login page"}""")
                    path == "/api/owner-requests" -> {
                        val state = request.requestUrl!!.queryParameter("state")
                        val rows = held.values.filter { row ->
                            when (state) { "open" -> row.s("state") == "PENDING"; "done" -> row.s("state") == "DONE"; "declined" -> row.s("state") == "DECLINED"; else -> true }
                        }.sortedByDescending { it.s("createdAt") }
                        json(200, buildJsonObject { put("requests", JsonArray(rows)) }.toString())
                    }
                    parts.first() == "owner-requests" && request.method == "POST" -> {
                        val id = parts[1]
                        val row = held[id] ?: return json(404, """{"message":"owner request not found"}""")
                        val body = calls.last().body.takeIf { it.isNotEmpty() }?.let { Json.parseToJsonElement(it).jsonObject } ?: JsonObject(emptyMap())
                        val ended = { state: String, extra: JsonObjectBuilder.() -> Unit -> JsonObject(row + buildJsonObject {
                            put("state", state); put("resolvedAt", Instant.now().toString()); put("resolvedByUserId", "u"); extra()
                        }) }
                        val next = when (parts.drop(2).joinToString("/")) {
                            "done" -> ended("DONE") { put("answer", body) }
                            "decline" -> ended("DECLINED") { put("resolutionNote", body["reason"]!!) }
                            "secret" -> refuseSecret?.let { return json(400, buildJsonObject { put("message", it) }.toString()) }
                                ?: JsonObject(row + buildJsonObject { putJsonObject("secretGrant") {
                                    put("state", "PENDING_DELIVERY"); put("exposure", "ENV"); put("expiresAt", Instant.now().plusSeconds(86_400).toString())
                                    put("runnerOnline", true)
                                } })
                            else -> return json(404, "{}")
                        }
                        held[id] = next
                        json(200, next.toString())
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

    fun hold(vararg rows: JsonObject) = rows.forEach { held[it.s("id")!!] = it }
    fun posts() = calls.filter { it.method == "POST" && it.path.startsWith("/api/owner-requests/") }
    fun close() = server.shutdown()

    companion object {
        const val SESSION = "01a0d6a9-d763-70e1-b4cf-8793e971b500"
        const val RUNNER = "01a0d6a9-d763-70e1-b4cf-8793e971b5aa"
        const val TASK = "01a0d6a9-d763-70e1-b4cf-8793e971b5bb"
        const val SECRET_ID = "01a0d6a9-d763-70e1-b4cf-8793e971b501"
        const val STEPS_ID = "01a0d6a9-d763-70e1-b4cf-8793e971b502"
        const val DECISION_ID = "01a0d6a9-d763-70e1-b4cf-8793e971b503"
        const val CONFIRM_ID = "01a0d6a9-d763-70e1-b4cf-8793e971b504"

        private fun JsonObject.s(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull

        private fun request(id: String, kind: String, title: String, why: String, minutesAgo: Long, extra: JsonObjectBuilder.() -> Unit) = buildJsonObject {
            put("id", id); put("kind", kind); put("state", "PENDING"); put("title", title); put("why", why)
            putJsonArray("blocksTaskIds") { add(TASK) }
            put("ifUnanswered", "The session keeps the task blocked and asks again tomorrow.")
            put("expiresAt", Instant.now().plusSeconds(3 * 86_400 + 600).toString())
            put("askedBySessionId", SESSION); put("projectId", JsonNull)
            put("createdAt", Instant.now().minusSeconds(minutesAgo * 60).toString())
            extra()
        }

        fun secret() = request(SECRET_ID, "SECRET", "Staging Stripe key", "The payment tests call Stripe's test API and need a restricted key.", 2) {
            putJsonObject("secretSpec") { put("name", "Stripe test key"); put("runnerId", RUNNER); put("envVar", "STRIPE_API_KEY") }
            put("secretScope", "TASK"); put("secretGrant", JsonNull)
        }

        fun steps() = request(STEPS_ID, "MANUAL_STEP", "Enable the billing API", "The deploy fails until the billing API is on for the project.", 14) {
            putJsonArray("steps") {
                addJsonObject { put("text", "Open the Cloud console's API library"); put("link", "https://console.cloud.google.com/apis/library") }
                addJsonObject { put("text", "Enable the Cloud Billing API") }
                addJsonObject { put("text", "Check it from a terminal"); put("command", "gcloud services list --enabled | grep billing") }
            }
        }

        fun decision() = request(DECISION_ID, "DECISION", "Which region should staging run in?", "Latency to the payment provider differs by region.", 30) {
            putJsonArray("options") {
                addJsonObject { put("label", "Singapore"); put("description", "Closest to most users") }
                addJsonObject { put("label", "Hong Kong") }
            }
            put("recommendedOption", 0)
        }

        fun confirm() = request(CONFIRM_ID, "CONFIRM", "Confirm the DNS change", "The new records point the app at the new load balancer.", 45) {}
    }
}
