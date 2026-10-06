package io.orbitd.android.management

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class ProviderManagementTest {
    @Test fun poolRolesNeverBorrowInstanceAdminAndUnknownRolesFailClosed() {
        val member = ProviderAccess(pool("MEMBER"))
        assertFalse(member.admin); assertFalse(member.owner); assertFalse(member.canAddKey)
        assertFalse(member.canAddAccount)
        assertTrue(member.canSwitch(key(you = true)))
        assertFalse(member.canManage(key(you = false)))
        val admin = ProviderAccess(pool("ADMIN"))
        assertTrue(admin.canAddKey); assertTrue(admin.canAddAccount)
        assertTrue(admin.canManage(key(you = false)))
        assertFalse(admin.canSwitch(key(you = false)))
        val unknown = ProviderAccess(pool("FUTURE"))
        assertFalse(unknown.canAddKey); assertFalse(unknown.canManage(key(you = true)))
    }

    @Test fun accountContributorAloneCanSignInAgainAndCreatorCannotBeRemoved() {
        val own = json("""{"userId":"viewer","fingerprint":"…AB12","state":"SIGNED_OUT"}""")
        val other = json("""{"userId":"other","fingerprint":"…AB13"}""")
        val member = ProviderAccess(pool("MEMBER"))
        assertTrue(member.ownsAccount(own)); assertFalse(member.ownsAccount(other))
        assertTrue(member.canRemoveAccount(own)); assertFalse(member.canRemoveAccount(other))
        val admin = ProviderAccess(pool("ADMIN"))
        assertTrue(admin.canRemoveAccount(other)); assertFalse(admin.ownsAccount(other))
        assertFalse(admin.ownsAccount(json("""{"fingerprint":"…AB14"}""")))
        assertFalse(admin.canRemovePerson(json("""{"userId":"owner","creator":true}""")))
        assertFalse(admin.canChangeRole(json("""{"userId":"owner","creator":true}""")))
        assertFalse(ProviderAccess(JsonObject(pool("ADMIN") + ("shared" to JsonPrimitive(false))))
            .canChangeRole(json("""{"userId":"other"}""")))
    }

    @Test fun cappedKeysDoNotCapContributorsAndMissingUsageNeverBecomesZero() {
        assertEquals("At monthly cap", providerKeyStatus(key(false)))
        assertEquals("Available", providerKeyStatus(key(true)))
        assertEquals("Invalid — replace the rejected key", providerKeyStatus(JsonObject(key(true) + ("state" to JsonPrimitive("INVALID")))))
        assertEquals("Status unknown", providerKeyStatus(JsonObject(key(true) + ("state" to JsonPrimitive("NEW")))))
        assertEquals("Usage not reported", providerUsage(null))
        assertTrue(providerUsage(json("""{"primary":{"utilization":100,"resetsAt":"2026-10-08T10:00:00Z"}}""")).contains("100% used"))
    }

    @Test fun skillsMatchSwiftGroupsSharedLastAndSearchDescriptionsAcrossOfflineRunners() {
        val runners = listOf(json("""{"id":"r","name":"Remote","online":false,"skills":[{"name":"notes","description":"Project planning","agentId":"w"},{"name":"global"}],"commands":[{"name":"build","agentId":"w"}]}"""))
        val workspaces = listOf(json("""{"id":"w","name":"Alpha"}"""))
        val groups = skillsGroups(runners, workspaces, "")
        assertEquals(listOf("Alpha", "Shared"), groups.map { it.title })
        assertEquals(2, groups.first().skills.size + groups.first().commands.size)
        assertFalse(groups.first().online)
        assertEquals("notes", skillsGroups(runners, workspaces, " PLANNING ").single().skills.single().text("name"))
        assertTrue(skillsGroups(runners, workspaces, "missing").isEmpty())
    }

    @Test fun realHttpRechecksPermissionAndNeverSendsWriteAfterRoleRevocation() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(login))
            val session = session(OkHttpTransport())
            session.login(ServerAddress.parse(server.url("/").toString(), true), "fixture@example.test", "fixture")
            server.takeRequest()
            val state = ProviderResource(ManagementApi(session, (session.state.value as AuthState.SignedIn).handle), "p", true)
            server.enqueue(MockResponse().setBody(pool("ADMIN").toString()))
            state.load()
            assertTrue(state.fresh)
            server.enqueue(MockResponse().setBody(pool("MEMBER").toString()))
            assertFalse(state.rule("membersCanAdd", true))
            assertFalse(state.fresh)
            assertTrue(state.error.orEmpty().contains("permissions changed"))
            val requests = listOf(server.takeRequest(), server.takeRequest())
            assertTrue(requests.all { it.method == "GET" && it.path == "/api/providers/shared-pools/p" })
            assertTrue(requests.all { it.getHeader("Authorization") == "Bearer fixture-access" })
            assertEquals(3, server.requestCount)
            session.logout()
        }
    }

    @Test fun realHttpReplacementUsesPutAndPauseKeepsLoginPrefixAndExplicitNull() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(login))
            val session = session(OkHttpTransport())
            session.login(ServerAddress.parse(server.url("/").toString(), true), "fixture@example.test", "fixture")
            server.takeRequest()
            val current = JsonObject(pool("ADMIN") + mapOf("keys" to JsonArray(listOf(key(true))), "logins" to JsonArray(listOf(json("""{"userId":"viewer","fingerprint":"…AB12","state":"SIGNED_OUT"}""")))))
            val state = ProviderResource(ManagementApi(session, (session.state.value as AuthState.SignedIn).handle), "p", true)
            server.enqueue(MockResponse().setBody(current.toString()))
            state.load(); server.takeRequest()
            repeat(3) { server.enqueue(MockResponse().setBody(current.toString())) }
            assertTrue(state.keyAction("k", "replace", json("""{"apiKey":"fixture-replacement-not-real"}""")))
            assertEquals("GET", server.takeRequest().method)
            val replace = server.takeRequest()
            assertEquals("PUT", replace.method)
            assertEquals("/api/providers/shared-pools/p/keys/k/secret", replace.path)
            assertEquals("fixture-replacement-not-real", Json.parseToJsonElement(replace.body.readUtf8()).jsonObject.text("apiKey"))
            server.takeRequest()
            repeat(3) { server.enqueue(MockResponse().setBody(current.toString())) }
            assertTrue(state.pauseMember("login:…AB12", null))
            server.takeRequest()
            val pause = server.takeRequest()
            assertEquals(listOf("api", "providers", "pools", "p", "members", "login:…AB12", "pause"), pause.requestUrl!!.pathSegments)
            assertEquals(JsonNull, Json.parseToJsonElement(pause.body.readUtf8()).jsonObject["durationMinutes"])
            server.takeRequest()
            session.logout()
        }
    }

    @Test fun forbiddenClearsSensitiveSnapshotAndNoActionRunsUntilRecovery() = runTest {
        var denied = false
        val calls = mutableListOf<HttpRequest>()
        val session = session(HttpTransport { request ->
            calls += request
            ApiResponse(if (denied) 403 else 200, (if (request.api.path == listOf("auth", "login")) login else pool("ADMIN").toString()).encodeToByteArray())
        })
        session.login(ServerAddress.parse("https://fixture.example"), "fixture@example.test", "fixture")
        val state = ProviderResource(ManagementApi(session, (session.state.value as AuthState.SignedIn).handle), "p", true)
        state.load(); assertNotNull(state.pool)
        denied = true; state.load()
        assertNull(state.pool); assertFalse(state.fresh)
        val size = calls.size
        assertFalse(state.rule("membersCanAdd", true)); assertEquals(size, calls.size)
        denied = false; state.load(); assertTrue(state.fresh)
        session.logout()
    }

    @Test fun backgroundingDuringPreflightCancelsWriteAndLateReadsCannotRestoreFreshness() = runTest {
        var gate: CompletableDeferred<Unit>? = null
        val entered = CompletableDeferred<Unit>()
        val calls = mutableListOf<HttpRequest>()
        val session = session(HttpTransport { request ->
            calls += request
            gate?.let { entered.complete(Unit); it.await() }
            ApiResponse(200, (if (request.api.path == listOf("auth", "login")) login else pool("ADMIN").toString()).encodeToByteArray())
        })
        session.login(ServerAddress.parse("https://fixture.example"), "fixture@example.test", "fixture")
        val state = ProviderResource(ManagementApi(session, (session.state.value as AuthState.SignedIn).handle), "p", true)
        state.load()
        gate = CompletableDeferred()
        val write = async { state.rule("membersCanAdd", true) }
        entered.await(); state.pause(); gate!!.complete(Unit)
        assertFalse(write.await()); assertFalse(state.fresh)
        assertFalse(calls.any { it.api.method == HttpMethod.PATCH })
        session.logout()
    }

    @Test fun pendingDeviceFlowSurvivesBrowserPauseAndCannotStartTwice() = runTest {
        val calls = mutableListOf<HttpRequest>()
        val session = session(HttpTransport { request ->
            calls += request
            val response = when {
                request.api.path == listOf("auth", "login") -> login
                request.api.path.last() == "codex-login" -> if (request.api.method == HttpMethod.POST)
                    """{"status":"PENDING","userCode":"TEST","verificationUrl":"https://example.test/device","expiresAt":"2026-10-08T10:00:00Z"}"""
                    else """{"status":"CONFIRMED"}"""
                else -> pool("ADMIN").toString()
            }
            ApiResponse(200, response.encodeToByteArray())
        })
        session.login(ServerAddress.parse("https://fixture.example"), "fixture@example.test", "fixture")
        val state = ProviderResource(ManagementApi(session, (session.state.value as AuthState.SignedIn).handle), "p", true)
        state.load(); assertTrue(state.startLogin())
        val count = calls.size
        assertFalse(state.startLogin()); assertEquals(count, calls.size)
        state.pause(); assertFalse(state.pollLogin()); assertEquals("PENDING", state.attempt?.text("status"))
        state.resume(); state.load(); assertTrue(state.pollLogin())
        assertEquals("CONFIRMED", state.attempt?.text("status"))
        assertEquals(1, calls.count { it.api.path.last() == "codex-login" && it.api.method == HttpMethod.POST })
        session.logout()
    }

    private fun key(you: Boolean) = json("""{"id":"k","enabled":true,"state":"ACTIVE","shareCap":10,"usage":{"othersCostUsd":10},"contributor":{"userId":"viewer","you":$you}}""")
    private fun pool(role: String) = json("""{"id":"p","engine":"codex","viewerRole":"$role","shared":true,"membersCanAdd":false,"membersCanAddAccounts":false,"people":[{"userId":"owner","creator":true},{"userId":"viewer","you":true}]}""")
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
}

private const val login = """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"viewer","name":"Fixture","email":"fixture@example.test"}}"""
private fun session(transport: HttpTransport) = AuthSession(transport,
    object : CredentialStore {
        private var stored: StoredSession? = null
        override suspend fun load() = stored
        override suspend fun save(session: StoredSession) { stored = session }
        override suspend fun clear() { stored = null }
    }, object : InstanceStore { override suspend fun load(): String? = null; override suspend fun save(server: String) {} },
    object : SessionDataStore {
        override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) {}
        override suspend fun clearAll() {}
    }, "test", allowLoopbackHttp = true)
