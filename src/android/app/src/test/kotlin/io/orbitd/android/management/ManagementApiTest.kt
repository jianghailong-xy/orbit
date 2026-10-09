package io.orbitd.android.management

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test

class ManagementApiTest {
    @Test fun controlledHttpKeepsInstancePrefixMemberIdentityAndEmptyDeleteResponse() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(login))
            val session = session()
            session.login(ServerAddress.parse(server.url("/orbit/").toString(), true), "fixture@example.test", "fixture")
            val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
            server.takeRequest()
            server.enqueue(MockResponse().setBody("{\"ok\":true}"))
            api.post("providers/pools/pool/members/login:…AB12/pause", buildJsonObject { put("durationMinutes", 15) })
            val pause = server.takeRequest()
            assertEquals(listOf("orbit", "api", "providers", "pools", "pool", "members", "login:…AB12", "pause"), pause.requestUrl!!.pathSegments)
            assertEquals("Bearer fixture-access", pause.getHeader("Authorization"))
            assertEquals("15", Json.parseToJsonElement(pause.body.readUtf8()).jsonObject["durationMinutes"]!!.jsonPrimitive.content)
            server.enqueue(MockResponse().setResponseCode(204))
            assertEquals(JsonNull, api.delete("providers/pools/pool/codex-login", listOf("fingerprint" to "…AB12")))
            val remove = server.takeRequest()
            assertEquals("DELETE", remove.method)
            assertEquals("…AB12", remove.requestUrl!!.queryParameter("fingerprint"))
            server.enqueue(MockResponse().setResponseCode(403).setBody("{}"))
            try { api.get("admin/users"); fail("403 must remain a permission failure") } catch (error: ApiError) { assertEquals(403, error.status) }
            server.takeRequest()
            server.enqueue(MockResponse().setBody("{}"))
            session.logout()
            server.takeRequest()
            try { api.patch("users/me", buildJsonObject { put("name", "stale account") }); fail("Old handle cannot write") }
            catch (_: SessionChanged) { }
            assertEquals(5, server.requestCount)
        }
    }

    @Test fun managementNeverAcceptsAbsoluteCredentialDestinations() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(login))
            val session = session()
            session.login(ServerAddress.parse(server.url("/").toString(), true), "fixture@example.test", "fixture")
            val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
            listOf("https://other.example/users/me", "//other.example/users/me", "users/me?token=secret").forEach {
                try { api.get(it); fail("Absolute/query path must fail before transport") } catch (_: IllegalArgumentException) { }
            }
            assertEquals(1, server.requestCount)
            server.enqueue(MockResponse().setBody("{}")); session.logout()
        }
    }

    private fun session() = AuthSession(OkHttpTransport(), object : CredentialStore {
        private var stored: StoredSession? = null
        override suspend fun load() = stored
        override suspend fun save(session: StoredSession) { stored = session }
        override suspend fun clear() { stored = null }
    }, object : InstanceStore {
        override suspend fun load(): String? = null
        override suspend fun save(server: String) = Unit
    }, object : SessionDataStore {
        override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) = Unit
        override suspend fun clearAll() = Unit
    }, "a13-test", allowLoopbackHttp = true)

    private val login = """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"fixture-user","email":"fixture@example.test","name":"Fixture"}}"""
}
