package io.orbitd.android.watch

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.navigation.ObjectId
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test

/** Real loopback HTTP with AuthSession/OkHttpTransport; no fixture is claimed as deployed business evidence. */
class WatchHttpTest {
    private class Rig : AutoCloseable {
        val server = MockWebServer()
        val calls = CopyOnWriteArrayList<RecordedRequest>()
        @Volatile var row = watch()
        @Volatile var getStatus = 200
        @Volatile var mutationStatus = 200
        @Volatile var failAfterCommit = false
        @Volatile var canMutate = true
        @Volatile var revokeOnRead = false
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
        lateinit var api: WatchApi
        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    calls += request
                    val path = request.requestUrl!!.encodedPath
                    if (path == "/api/auth/login") return response(200, """{"accessToken":"watch-access","refreshToken":"watch-refresh","user":{"id":"u","email":"u@example.test","name":"U"}}""")
                    if (request.method == "GET") {
                        if (getStatus != 200) return response(getStatus, "{}")
                        val data = if (path == "/api/watches") JsonArray(listOf(row)).toString() else row.toString()
                        if (revokeOnRead) canMutate = false
                        return response(200, data)
                    }
                    if (path == "/api/watches") return response(mutationStatus, row.toString())
                    if (mutationStatus != 200) return response(mutationStatus, "{}")
                    val state = when (path.substringAfterLast('/')) { "pause" -> "PAUSED"; "resume" -> "ACTIVE"; "cancel" -> "CANCELLED"; else -> "UNKNOWN" }
                    row = JsonObject(row + mapOf("state" to JsonPrimitive(state), "updatedAt" to JsonPrimitive("2026-10-05T12:00:01Z")))
                    return response(if (failAfterCommit) 503 else 200, row.toString())
                }
            }
            server.start()
        }
        suspend fun start(): WatchApi {
            auth.login(ServerAddress.parse(server.url("/").toString(), allowLoopbackHttp = true), "u@example.test", "fixture-password")
            return WatchApi(auth, (auth.state.value as AuthState.SignedIn).handle) { canMutate }.also { api = it }
        }
        override fun close() { runBlocking { auth.logout() }; server.shutdown() }
        private fun response(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
    }

    @Test fun fourListReadsMergeCanonicalDuplicatesWithoutLosingLiveRows() = runBlocking {
        Rig().use { rig ->
            val api = rig.start()
            assertEquals(1, api.followed().size)
            val listReads = rig.calls.filter { it.requestUrl!!.encodedPath == "/api/watches" }
            assertEquals(listOf("state=ACTIVE", "state=PAUSED", null, "needsAttention=true"), listReads.map { it.requestUrl!!.query })
            assertTrue(listReads.all { it.getHeader("Authorization") == "Bearer watch-access" })
            // A deep link fetches an older watch without depending on any of the bounded lists.
            api.get(ObjectId.canonical("1")!!)
            assertEquals("/api/watches/${ObjectId.canonical("1")}", rig.calls.last().requestUrl!!.encodedPath)
        }
    }
    @Test fun pauseResumeStopRevalidateA08BindingAndRenderServerRecord() = runBlocking {
        Rig().use { rig ->
            val model = WatchModel(rig.start(), "1")
            model.load()
            listOf(CardVerb.WATCH_PAUSE to "PAUSED", CardVerb.WATCH_RESUME to "ACTIVE", CardVerb.WATCH_CANCEL to "CANCELLED").forEach { (verb, expected) ->
                model.control(model.state.value.watches.single(), verb)
                assertEquals(expected, model.state.value.watches.single().state)
                assertTrue(model.state.value.fresh)
                assertFalse(model.state.value.busy)
            }
            assertEquals(listOf("GET", "GET", "POST", "GET", "POST", "GET", "POST"), rig.calls.drop(1).map { it.method })
            val before = rig.calls.size
            model.control(model.state.value.watches.single(), CardVerb.WATCH_PAUSE)
            assertEquals(before, rig.calls.size)
            // A fresh model (activity/process recreation) restores the server conclusion, never replaying Stop.
            val restored = WatchModel(rig.api, "1"); restored.load()
            assertEquals("CANCELLED", restored.state.value.watches.single().state)
            assertEquals(3, rig.calls.count { it.method == "POST" && it.requestUrl!!.encodedPath != "/api/auth/login" })
        }
    }
    @Test fun changedBindingRefusesMutationThenRefreshesBeforeOfferingNewControls() = runBlocking {
        Rig().use { rig ->
            val model = WatchModel(rig.start(), "1"); model.load()
            val shown = model.state.value.watches.single()
            rig.row = JsonObject(rig.row + ("state" to JsonPrimitive("MATCHED")))
            model.control(shown, CardVerb.WATCH_PAUSE)
            assertEquals("MATCHED", model.state.value.watches.single().state)
            assertTrue(model.state.value.error!!.contains("changed"))
            assertFalse(rig.calls.any { it.method == "POST" && it.requestUrl!!.encodedPath.endsWith("pause") })
        }
    }
    @Test fun conflictAndLostMutationResponseReadBackWithoutRepeatingPost() = runBlocking {
        Rig().use { rig ->
            val model = WatchModel(rig.start(), "1"); model.load()
            rig.mutationStatus = 409
            model.control(model.state.value.watches.single(), CardVerb.WATCH_PAUSE)
            assertEquals("ACTIVE", model.state.value.watches.single().state)
            assertTrue(model.state.value.error!!.contains("changed"))
            rig.mutationStatus = 200; rig.failAfterCommit = true
            model.control(model.state.value.watches.single(), CardVerb.WATCH_PAUSE)
            assertEquals("PAUSED", model.state.value.watches.single().state)
            assertNotNull(model.state.value.error)
            assertEquals(2, rig.calls.count { it.method == "POST" && it.requestUrl!!.encodedPath.endsWith("pause") })
        }
    }
    @Test fun forbiddenAndGoneClearContentsWhereServerFailureKeepsReadOnlyCache() = runBlocking {
        Rig().use { rig ->
            val model = WatchModel(rig.start(), "1"); model.load()
            rig.getStatus = 503; model.load()
            assertEquals(1, model.state.value.watches.size); assertFalse(model.state.value.fresh)
            val before = rig.calls.size
            model.control(model.state.value.watches.single(), CardVerb.WATCH_CANCEL)
            assertEquals(before, rig.calls.size)
            rig.getStatus = 403; model.load()
            assertTrue(model.state.value.watches.isEmpty()); assertTrue(model.state.value.error!!.contains("permission"))
            rig.getStatus = 404; model.load()
            assertTrue(model.state.value.unavailable); assertTrue(model.state.value.watches.isEmpty())
            rig.getStatus = 200; model.load()
            assertTrue(model.state.value.fresh); assertFalse(model.state.value.unavailable)
            rig.canMutate = false
            model.control(model.state.value.watches.single(), CardVerb.WATCH_PAUSE)
            assertFalse(rig.calls.any { it.method == "POST" && it.requestUrl!!.encodedPath.endsWith("pause") })
        }
    }
    @Test fun subscriptionUsesStableDialogKeyAndKnownTaskOnlyChoicesAcrossRetry() = runBlocking {
        Rig().use { rig ->
            val api = rig.start()
            rig.mutationStatus = 503
            try { api.followTask("task", WatchProjection.followConditions[1], 259_200, "dialog-key"); fail("503") } catch (_: ApiError) {}
            rig.mutationStatus = 200
            api.followTask("task", WatchProjection.followConditions[1], 259_200, "dialog-key")
            val requests = rig.calls.filter { it.method == "POST" && it.requestUrl!!.encodedPath == "/api/watches" }
            val bodies = requests.map { Json.parseToJsonElement(it.body.clone().readUtf8()).jsonObject }
            assertEquals(2, bodies.size); assertEquals(bodies[0], bodies[1])
            assertEquals("dialog-key", bodies[0].text("idempotencyKey"))
            assertEquals("NOTIFY_USER", bodies[0].text("action"))
            assertEquals("TASK", bodies[0].objects("targets").single().text("kind"))
            assertEquals(1, bodies[0].number("predicateVersion"))
            assertEquals(259_200, bodies[0].number("ttlSeconds"))
            rig.auth.logout()
            val before = rig.calls.size
            try { api.get("1"); fail("old handle") } catch (_: SessionChanged) {}
            assertEquals(before, rig.calls.size)
        }
    }

    @Test fun permissionChangesDuringPreflightCannotSendTheMutation() = runBlocking {
        Rig().use { rig ->
            val model = WatchModel(rig.start(), "1"); model.load()
            rig.revokeOnRead = true
            model.control(model.state.value.watches.single(), CardVerb.WATCH_CANCEL)
            assertFalse(rig.canMutate)
            assertEquals("ACTIVE", model.state.value.watches.single().state)
            assertFalse(rig.calls.any { it.method == "POST" && it.requestUrl!!.encodedPath.endsWith("cancel") })
        }
    }

    companion object {
        private fun watch() = buildJsonObject {
            put("id", "1"); put("state", "ACTIVE"); put("action", "RESUME_SESSION"); put("observerSessionId", "2")
            put("generation", 0); put("updatedAt", "2026-10-05T12:00:00Z"); put("createdAt", "2026-10-05T11:00:00Z")
            put("predicate", WatchProjection.followConditions.first()); putJsonArray("targets") {}
        }
    }
}
