package io.orbitd.android.management

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList

class WorkspaceRunnerTest {
    @Test fun remoteStateUsesServerOnlineHeartbeatAndDrainingWithoutInferringUnknownSuccess() {
        val now = Instant.parse("2026-10-04T12:00:00Z").toEpochMilli()
        val online = runner(now)
        assertNull(WorkspaceRunnerPolicy.remoteRefusal(online, now))
        assertNotNull(WorkspaceRunnerPolicy.remoteRefusal(online, now + 90_001))
        assertNotNull(WorkspaceRunnerPolicy.remoteRefusal(online, now - 90_001))
        assertNotNull(WorkspaceRunnerPolicy.remoteRefusal(JsonObject(online - "lastHeartbeatAt"), now))
        assertNotNull(WorkspaceRunnerPolicy.remoteRefusal(JsonObject(online + ("online" to JsonPrimitive(false))), now))
        assertNotNull(WorkspaceRunnerPolicy.remoteRefusal(JsonObject(online + ("heartbeatDraining" to JsonPrimitive(true))), now))
    }

    @Test fun destructiveAccountActionsUseDeclaredEngineCapabilityAndNeverRemoveDefault() {
        val current = runner()
        assertNull(WorkspaceRunnerPolicy.removalRefusal(current, "codex", "aabbccdd"))
        assertNotNull(WorkspaceRunnerPolicy.removalRefusal(current, "codex", "default"))
        assertNotNull(WorkspaceRunnerPolicy.removalRefusal(current, "claude", "aabbccdd"))
        assertNotNull(WorkspaceRunnerPolicy.removalRefusal(current, "codex", "../../other"))
        assertNotNull(WorkspaceRunnerPolicy.removalRefusal(current, "kimi", "aabbccdd"))
        assertNotNull(WorkspaceRunnerPolicy.loginRefusal(current, "antigravity"))
        assertNotNull(WorkspaceRunnerPolicy.loginRefusal(current, "opencode"))
    }

    @Test fun workspaceDraftHonorsSwiftBlankSemanticsAndAutomaticIsExplicitNull() {
        val original = Json.parseToJsonElement("""{"name":"Original","appendSystemPrompt":"retain me","workDir":"/repo","effort":"high","enabled":true,"modelRouting":false,"codexAccount":"default"}""").jsonObject
        val patch = WorkspaceRunnerPolicy.workspacePatch(original, " Renamed ", "", "", "", false, true)
        assertEquals("Renamed", patch.text("name"))
        assertFalse(patch.containsKey("appendSystemPrompt")); assertFalse(patch.containsKey("workDir"))
        assertEquals("", patch.text("effort")); assertEquals(JsonPrimitive(false), patch["enabled"])
        assertEquals(JsonNull, WorkspaceRunnerPolicy.accountPatch(original, "codex", null)["codexAccount"])
        assertTrue(WorkspaceRunnerPolicy.accountPatch(original, "codex", "default").isEmpty())
        val automatic = JsonObject(original + ("codexAccount" to JsonNull))
        assertEquals(JsonPrimitive("default"), WorkspaceRunnerPolicy.accountPatch(automatic, "codex", "default")["codexAccount"])
        try { WorkspaceRunnerPolicy.accountPatch(original, "codex", "/tmp/creds"); fail() } catch (_: IllegalArgumentException) { }
    }

    @Test fun quotasKeepSlotAndAutomaticIdentityFromA07InsteadOfBorrowingDefault() {
        val record = Json.parseToJsonElement("""{"planUsage":{"codex":{"primary":{"utilization":90},"accounts":{"aabbccdd":{"primary":{"utilization":12}}}}}}""").jsonObject
        assertEquals(12, WorkspaceRunnerPolicy.quota(record, "codex", "aabbccdd")!!["primary"]!!.jsonObject["utilization"]!!.jsonPrimitive.int)
        assertEquals(90, WorkspaceRunnerPolicy.quota(record, "codex", "default")!!["primary"]!!.jsonObject["utilization"]!!.jsonPrimitive.int)
        assertNull(WorkspaceRunnerPolicy.quota(record, "codex", "automatic"))
        assertNull(WorkspaceRunnerPolicy.quota(record, "codex", "deadbeef"))
    }

    @Test fun realHttpUserAndAdminUseSameOwnerScopedRemotePathsAndFreshCapabilityCheck() = runBlocking {
        for (role in listOf("MEMBER", "ADMIN")) {
            Fixture(role).use { fixture ->
                val api = fixture.login()
                val actions = WorkspaceRunnerActions(api)
                actions.startLogin("r", "codex", accountName = "Testing")
                actions.removeAccount("r", "codex", "aabbccdd")
                actions.remote("r", "refresh-models")
                val mutations = fixture.calls.filter { it.path?.startsWith("/api/runners/") == true }
                assertEquals(listOf("/api/runners/r/login", "/api/runners/r/accounts/codex/aabbccdd", "/api/runners/r/refresh-models"), mutations.map { it.path })
                assertTrue(mutations.all { it.getHeader("Authorization") == "Bearer fixture-access" })
                assertEquals(listOf("POST", "DELETE", "POST"), mutations.map { it.method })
                assertEquals("Testing", Json.parseToJsonElement(mutations[0].body.readUtf8()).jsonObject.text("accountName"))
                assertEquals(3, fixture.calls.count { it.path == "/api/runners" })
            }
        }
    }

    @Test fun capabilityWithdrawalOrOfflineBetweenScreenReadAndConfirmationSendsNoMutation() = runBlocking {
        Fixture().use { fixture ->
            val actions = WorkspaceRunnerActions(fixture.login())
            val before = actions.runner("r")
            assertNull(WorkspaceRunnerPolicy.removalRefusal(before, "codex", "aabbccdd"))
            fixture.runner = JsonObject(fixture.runner + ("capabilities" to JsonArray(emptyList())))
            try { actions.removeAccount("r", "codex", "aabbccdd"); fail() } catch (_: IllegalStateException) { }
            fixture.runner = JsonObject(fixture.runner + ("online" to JsonPrimitive(false)))
            try { actions.remote("r", "engine-update"); fail() } catch (_: IllegalStateException) { }
            assertFalse(fixture.calls.any { it.path?.startsWith("/api/runners/r/") == true })
        }
    }

    @Test fun canonicalDeepLinkFindsBase62RunnerWithoutMistakingItForMissingOwnership() = runBlocking {
        Fixture().use { fixture ->
            assertEquals("r", WorkspaceRunnerActions(fixture.login()).runner(ObjectId.canonical("r")!!).text("id"))
        }
    }

    @Test fun controlledHttp403404AndExpiredLoginNeverBecomeSuccessfulWrites() = runBlocking {
        Fixture().use { fixture ->
            val actions = WorkspaceRunnerActions(fixture.login())
            fixture.denyStatus = 403
            try { actions.remote("r", "refresh-models"); fail() } catch (error: ApiError) { assertEquals(403, error.status) }
            fixture.denyStatus = 404
            try { actions.remote("r", "refresh-models"); fail() } catch (error: ApiError) { assertEquals(404, error.status) }
            fixture.denyStatus = 401
            try { actions.remote("r", "refresh-models"); fail() } catch (_: Exception) { }
            assertTrue(fixture.session.state.value is AuthState.SignedOut)
            assertFalse(fixture.calls.any { it.path?.startsWith("/api/runners/r/") == true })
        }
    }

    @Test fun controlledHttpPermissionRecoveryReadsAgainAndCheckoutCleanupRevalidatesBoundRunner() = runBlocking {
        Fixture().use { fixture ->
            val api = fixture.login()
            val actions = WorkspaceRunnerActions(api)
            fixture.denyStatus = 403
            try { actions.cleanUpWorkspace("w"); fail() } catch (_: ApiError) { }
            fixture.denyStatus = null
            actions.cleanUpWorkspace("w")
            val write = fixture.calls.last()
            assertEquals("/api/workspaces/w/repo-cleanup", write.path)
            assertEquals("POST", write.method)
            fixture.runner = JsonObject(fixture.runner + ("online" to JsonPrimitive(false)))
            val before = fixture.calls.count { it.method == "POST" }
            try { actions.cleanUpWorkspace("w"); fail() } catch (_: IllegalStateException) { }
            assertEquals(before, fixture.calls.count { it.method == "POST" })
        }
    }

    private class Fixture(private val role: String = "MEMBER") : AutoCloseable {
        val server = MockWebServer()
        val calls = CopyOnWriteArrayList<RecordedRequest>()
        @Volatile var runner = runner()
        @Volatile var denyStatus: Int? = null
        val session = AuthSession(OkHttpTransport(), object : CredentialStore {
            private var stored: StoredSession? = null
            override suspend fun load() = stored
            override suspend fun save(session: StoredSession) { stored = session }
            override suspend fun clear() { stored = null }
        }, object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) { }
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) { }
            override suspend fun clearAll() { }
        }, "a13-test", true)

        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    calls += request
                    if (request.path == "/api/auth/login") return MockResponse().setBody("""{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"u","name":"Test user","email":"fixture@example.test","role":"$role"}}""")
                    if (request.path == "/api/auth/logout") return MockResponse().setBody("{}")
                    denyStatus?.let { return MockResponse().setResponseCode(it).setBody("{}") }
                    val body = when (request.path) {
                        "/api/runners" -> "[$runner]"
                        "/api/workspaces/w" -> """{"id":"w","runnerId":"r","repoHealth":{"state":"merge"}}"""
                        else -> "{}"
                    }
                    return MockResponse().setBody(body)
                }
            }
            server.start()
        }

        suspend fun login(): ManagementApi {
            val handle = session.login(ServerAddress.parse(server.url("/").toString(), true), "fixture@example.test", "fixture-password")
            return ManagementApi(session, handle)
        }
        override fun close() { runBlocking { session.logout() }; server.close() }
    }

    companion object {
        private fun runner(now: Long = System.currentTimeMillis()) = buildJsonObject {
            put("id", "r"); put("online", true); put("status", "ONLINE"); put("heartbeatDraining", false)
            put("lastHeartbeatAt", Instant.ofEpochMilli(now).toString())
            putJsonArray("capabilities") { add("codex-account-remove/v1") }
            putJsonArray("engines") { add(buildJsonObject { put("engine", "codex"); put("installed", true); put("auth", "yes") }) }
        }
    }
}
