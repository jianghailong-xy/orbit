package io.orbitd.android.management

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

@OptIn(ExperimentalCoroutinesApi::class)
class PersonalSettingsTest {
    @Test fun staleOrLoadingSnapshotCannotWriteAndLateResumeCannotReauthorize() = runTest {
        val response = CompletableDeferred<JsonElement>()
        val record = PersonalRecord { response.await() }
        var writes = 0
        assertFalse(record.mutate { writes++ })
        val loading = launch { record.load() }; runCurrent()
        assertTrue(record.busy)
        assertFalse(record.mutate { writes++ })
        record.invalidate()
        response.complete(buildJsonObject { put("role", "ADMIN") })
        loading.join()
        assertFalse(record.ready)
        assertNull(record.value)
        assertEquals(0, writes)
        record.load()
        assertTrue(record.ready)
    }

    @Test fun lostMutationResponseRequiresReadRecoveryAndForbiddenClearsSensitiveSnapshot() = runTest {
        var forbidden = false
        val record = PersonalRecord {
            if (forbidden) throw ApiError.parse(403, "{}".toByteArray())
            buildJsonObject { put("role", "ADMIN") }
        }
        record.load()
        var writes = 0
        assertFalse(record.mutate { writes++; throw NetworkException() })
        assertTrue(record.stale)
        assertFalse(record.mutate { writes++ })
        assertEquals(1, writes)
        record.load()
        assertTrue(record.ready)
        forbidden = true
        record.load()
        assertNull(record.value)
        assertFalse(record.ready)
        assertTrue(record.error!!.contains("403"))
    }

    @Test fun refreshWaitsForMutationAndBackgroundRoleChangeCannotRestoreAdminSnapshot() = runTest {
        var role = "ADMIN"
        val events = mutableListOf<String>()
        val record = PersonalRecord {
            events += "read:$role"
            buildJsonObject { put("role", role) }
        }
        record.load()
        val write = CompletableDeferred<Unit>()
        val mutation = async { record.mutate { events += "write:start"; write.await(); events += "write:end" } }
        runCurrent()
        val refresh = launch { record.load() }
        runCurrent()
        assertFalse(record.ready)
        assertEquals(listOf("read:ADMIN", "write:start"), events)
        record.invalidate() // App goes to the background while an administrator is demoted elsewhere.
        role = "MEMBER"
        write.complete(Unit)
        mutation.await(); refresh.join()
        assertFalse(record.ready)
        record.load() // Resume performs a fresh authority read.
        assertTrue(record.ready)
        assertEquals("MEMBER", record.value!!.jsonObject.text("role"))
        assertTrue(events.indexOf("write:end") < events.indexOf("read:MEMBER"))
    }

    @Test fun acknowledgedMutationWithFailedRefreshDoesNotClaimFreshSuccess() = runTest {
        var loadCount = 0
        val record = PersonalRecord {
            if (++loadCount > 1) throw NetworkException()
            JsonObject(emptyMap())
        }
        record.load()
        var accepted = false
        assertFalse(record.mutate { accepted = true })
        assertTrue(accepted)
        assertFalse(record.ready)
        assertTrue(record.stale)
    }

    @Test fun memberCannotReadAdminUsersAndLiveRoleRefreshControlsEntry() = runBlocking {
        MockWebServer().use { server ->
            val api = start(server)
            server.enqueue(MockResponse().setBody("""{"id":"fixture-user","role":"MEMBER"}"""))
            val member = adminSnapshot(api)
            assertTrue(member.list("users").isEmpty())
            assertEquals("/api/users/me", server.takeRequest().path)
            assertEquals(2, server.requestCount)
            server.enqueue(MockResponse().setBody("""{"id":"fixture-user","role":"ADMIN"}"""))
            server.enqueue(MockResponse().setBody("""[{"id":"other","role":"MEMBER"}]"""))
            assertEquals("other", adminSnapshot(api).list("users").single().text("id"))
            server.takeRequest()
            assertEquals("/api/admin/users", server.takeRequest().path)
            server.enqueue(MockResponse().setBody("""{"id":"fixture-user","role":"ADMIN"}"""))
            server.enqueue(MockResponse().setResponseCode(403).setBody("{}"))
            try { adminSnapshot(api); fail("Server revocation must win over the visible role") }
            catch (e: ApiError) { assertEquals(403, e.status) }
        }
    }

    @Test fun controlledHttpAvatarAndShareRightsUseAuthenticatedContractsWithoutOptimisticWrites() = runBlocking {
        MockWebServer().use { server ->
            val api = start(server)
            val me = """{"id":"fixture-user","name":"Before","role":"MEMBER","preferences":{"defaultPermissionMode":"auto","notifyAgentMessage":false}}"""
            server.enqueue(MockResponse().setBody(me))
            val record = PersonalRecord { api.get("users/me") }; record.load(); server.takeRequest()
            server.enqueue(MockResponse().setBody(me))
            server.enqueue(MockResponse().setBody(me))
            assertTrue(record.mutate { api.patch("users/me/preferences", buildJsonObject { put("theme", "dark") }) })
            val patch = server.takeRequest()
            assertEquals("PATCH", patch.method)
            assertEquals("/api/users/me/preferences", patch.path)
            assertEquals("""{"theme":"dark"}""", patch.body.readUtf8())
            server.takeRequest()
            server.enqueue(MockResponse().setBody(me))
            val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 7)
            personalUploadAvatar(api, jpeg)
            val avatar = server.takeRequest()
            assertEquals("PUT", avatar.method)
            assertEquals("/api/users/me/avatar", avatar.path)
            assertEquals("Bearer fixture-access", avatar.getHeader("Authorization"))
            assertTrue(avatar.getHeader("Content-Type")!!.startsWith("multipart/form-data; boundary=orbit-avatar-"))
            val bytes = avatar.body.readByteArray()
            assertTrue(bytes.toString(Charsets.ISO_8859_1).contains("name=\"file\"; filename=\"avatar.jpg\""))
            assertTrue(bytes.toList().windowed(jpeg.size).any { it == jpeg.toList() })
            server.enqueue(MockResponse().setBody("{}"))
            api.put(sharingPath("TASK", "test-task"), sharingExpiry(null))
            val share = server.takeRequest()
            assertEquals("PUT", share.method)
            assertEquals("/api/tasks/test-task/share", share.path)
            assertEquals("""{"expiresAt":null}""", share.body.readUtf8())
            server.enqueue(MockResponse().setResponseCode(404).setBody("{}"))
            assertFalse(record.mutate { api.delete("share-links/not-owned") })
            assertNull(record.value)
            assertFalse(record.ready)
        }
    }

    @Test fun malformedShareSuccessCannotAssertPrivateOrEmptyState() {
        val empty = JsonObject(emptyMap())
        listOf<JsonElement>(JsonNull, empty, JsonArray(emptyList()), buildJsonObject { put("links", JsonNull) }).forEach {
            try { sharingList(it); fail("Malformed list must fail") } catch (_: IllegalStateException) { }
        }
        assertTrue(sharingList(buildJsonObject { put("links", JsonArray(emptyList())) }).list("links").isEmpty())
        try { sharingRead(empty, "TASK", "one"); fail("Absent link is not a private link") } catch (_: IllegalArgumentException) { }
        assertEquals(JsonNull, sharingRead(buildJsonObject { put("link", JsonNull) }, "TASK", "one")["link"])
        val link = buildJsonObject {
            put("id", "link"); put("kind", "TASK"); put("token", "token"); put("state", "ACTIVE")
            put("include", buildJsonObject { put("commentsAndFiles", true) })
            put("root", buildJsonObject { put("id", "another") })
        }
        try { sharingRead(buildJsonObject { put("link", link) }, "TASK", "one"); fail("Wrong resource must fail") }
        catch (_: IllegalArgumentException) { }
        assertEquals(link, sharingRead(buildJsonObject { put("link", link) }, "TASK", "another")["link"])
        val canonical = io.orbitd.android.navigation.ObjectId.canonical("another")!!
        assertEquals(link, sharingRead(buildJsonObject { put("link", link) }, "TASK", canonical)["link"])
    }

    @Test fun shareStatesExpiryAndNestedLayersMatchOwnerContract() {
        fun link(state: String) = buildJsonObject { put("state", state) }
        assertTrue(sharingCanTurnOff(link("ACTIVE")))
        assertTrue(sharingCanTurnOff(link("PAUSED")))
        assertFalse(sharingCanTurnOff(link("ENDED")))
        assertFalse(sharingCanTurnOff(link("FUTURE")))
        assertEquals("https://one.example/orbit/s/a%2Fb", sharingPublicUrl("https://one.example/orbit/", "a/b"))
        assertEquals("2026-10-12T12:00:00Z", sharingExpiry(7, Instant.parse("2026-10-05T12:00:00Z")).text("expiresAt"))
        assertEquals(JsonNull, sharingExpiry(null)["expiresAt"])
        val include = buildJsonObject { put("taskPages", false); put("conversations", true) }
        assertFalse(sharingLayerEnabled("PROJECT", "conversations", include))
        assertFalse(sharingLayerEnabled("PROJECT", "commentsAndFiles", include))
        assertTrue(sharingLayerEnabled("TASK", "conversations", include))
    }

    private suspend fun start(server: MockWebServer): ManagementApi {
        server.enqueue(MockResponse().setBody("""{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"fixture-user","email":"fixture@example.test","name":"Fixture"}}"""))
        val session = AuthSession(OkHttpTransport(), object : CredentialStore {
            override suspend fun load(): StoredSession? = null
            override suspend fun save(session: StoredSession) = Unit
            override suspend fun clear() = Unit
        }, object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) = Unit
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) = Unit
            override suspend fun clearAll() = Unit
        }, "a13-test", allowLoopbackHttp = true)
        session.login(ServerAddress.parse(server.url("/").toString(), true), "fixture@example.test", "fixture")
        server.takeRequest()
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
}
