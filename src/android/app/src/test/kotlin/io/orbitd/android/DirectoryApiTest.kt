package io.orbitd.android

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.directory.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DirectoryApiTest {
    @Test fun lifecycleAndFolderMutationsUseAuthenticatedRealContractPathsAndExplicitNull() = runTest {
        val calls = mutableListOf<HttpRequest>()
        val session = fixtureSession(HttpTransport { request ->
            calls += request
            ApiResponse(200, if (request.api.path == listOf("auth", "login")) login.encodeToByteArray() else "{}".encodeToByteArray())
        })
        session.login(ServerAddress.parse("https://one.example"), "fixture@example.test", "fixture-password")
        val handle = (session.state.value as AuthState.SignedIn).handle
        val api = DirectoryApi(session, handle)
        api.rename("s", " Name "); api.pin("s", true); api.pin("s", false)
        api.complete("s"); api.restore("s"); api.delete("s", false); api.delete("s", true)
        api.createFolder("w", " Folder "); api.renameFolder("f", "Renamed"); api.deleteFolder("f")
        api.move("s", null, null); api.move("s", "w2", "f2"); api.setTags("s", setOf("tag")); api.createTag("Focus")
        val mutations = calls.drop(1)
        assertTrue(mutations.all { it.accessToken == "fixture-access" && it.server.value == "https://one.example" })
        assertEquals(listOf(HttpMethod.PATCH, HttpMethod.POST, HttpMethod.DELETE, HttpMethod.POST,
            HttpMethod.POST, HttpMethod.DELETE, HttpMethod.DELETE, HttpMethod.POST, HttpMethod.PATCH,
            HttpMethod.DELETE, HttpMethod.POST, HttpMethod.POST, HttpMethod.PUT, HttpMethod.POST), mutations.map { it.api.method })
        assertEquals(listOf("sessions", "s", "purge"), mutations[6].api.path)
        val noFolder = Json.parseToJsonElement(mutations[10].api.body!!.decodeToString()).jsonObject
        assertEquals(JsonNull, noFolder["folderId"])
        assertFalse(noFolder.containsKey("workspaceId"))
        assertEquals("w2", Json.parseToJsonElement(mutations[11].api.body!!.decodeToString()).jsonObject["workspaceId"]!!.jsonPrimitive.content)
        assertEquals("#3B82F6", Json.parseToJsonElement(mutations[13].api.body!!.decodeToString()).jsonObject["color"]!!.jsonPrimitive.content)
        session.logout()
        try { api.rename("s", "stale"); fail("Old account handle must fail") } catch (_: SessionChanged) { }
    }

    @Test fun searchKeepsServerSnippetsCountAndNamesOnlyNoticeAndPermissionFailure() = runTest {
        var forbidden = false
        val calls = mutableListOf<HttpRequest>()
        val session = fixtureSession(HttpTransport { request ->
            calls += request
            when {
                request.api.path == listOf("auth", "login") -> ApiResponse(200, login.encodeToByteArray())
                forbidden -> ApiResponse(403, "{}".encodeToByteArray())
                else -> ApiResponse(200, """{"q":"中 文","contentSearched":false,"total":9,"hits":[{"id":"s","title":"Found","status":"ENDED","agent":{"id":"w","name":"Workspace"},"snippet":"message match","matchField":"message"}]}""".encodeToByteArray())
            }
        })
        session.login(ServerAddress.parse("https://one.example"), "fixture@example.test", "fixture-password")
        val api = DirectoryApi(session, (session.state.value as AuthState.SignedIn).handle)
        val result = api.search("中 文")
        assertEquals(9, result.total); assertFalse(result.contentSearched)
        assertEquals("message match", result.hits.single().snippet)
        assertEquals("中 文", calls.last().api.query.first { it.first == "q" }.second)
        forbidden = true
        try { api.moveTargets("s"); fail("403 must not become empty data") } catch (error: ApiError) {
            assertEquals("You don't have permission to access this item.", directoryError(error))
        }
        session.logout()
    }
}

private const val login = """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"user","name":"Fixture","email":"fixture@example.test"}}"""
private fun fixtureSession(transport: HttpTransport) = AuthSession(transport,
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
    }, "test")
