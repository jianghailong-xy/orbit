package io.orbitd.android.management

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

/** Controlled HTTP over the real OkHttp + AuthSession stack: the endpoints and bodies iOS sends, and nothing more. */
class ManagementHttpTest {
    private fun body(request: RecordedRequest) = Json.parseToJsonElement(request.body.readUtf8())
    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
    private val runner = """{"id":"r1","name":"box","online":true,"lastHeartbeatAt":"2026-10-07T12:00:00Z","maxConcurrent":4}"""

    @Test fun runnerPressesUseTheIosEndpointsAndReadAgainAfterEachWrite() = runBlocking {
        MockWebServer().use { server ->
            val api = start(server)
            val model = RunnersModel(api)
            server.enqueue(json("[$runner,{\"id\":\"r2\",\"name\":\"two\"}]")); server.enqueue(json("[]"))
            model.load()
            assertEquals("/api/runners", server.takeRequest().path); assertEquals("/api/workspaces", server.takeRequest().path)
            assertEquals(listOf("r1", "r2"), model.runners.map { it.text("id") })
            // Reorder: the rows move at once, and the server's order settles it.
            server.enqueue(json("[{\"id\":\"r2\",\"name\":\"two\"},$runner]"))
            model.reorder(listOf("r2", "r1"))
            val reorder = server.takeRequest()
            assertEquals("POST" to "/api/runners/reorder", reorder.method to reorder.path)
            assertEquals(buildJsonObject { put("ids", buildJsonArray { add("r2"); add("r1") }) }, body(reorder))
            assertEquals(listOf("r2", "r1"), model.runners.map { it.text("id") })
            // Keep Free Off is an explicit null; an account pause resumes with an explicit null too.
            server.enqueue(json("{}")); server.enqueue(json("[$runner]")); server.enqueue(json("[]"))
            assertNull(model.press { api.patch("runners/r1", buildJsonObject { put("minFreeDiskMb", JsonNull) }) })
            assertEquals("""{"minFreeDiskMb":null}""", server.takeRequest().body.readUtf8())
            server.takeRequest(); server.takeRequest()
            server.enqueue(json("{}")); server.enqueue(json("[$runner]")); server.enqueue(json("[]"))
            model.press { api.post("runners/r1/accounts/claude/1fda3f43/pause", buildJsonObject { put("durationMinutes", JsonNull) }) }
            val pause = server.takeRequest()
            assertEquals("/api/runners/r1/accounts/claude/1fda3f43/pause", pause.path)
            assertEquals("""{"durationMinutes":null}""", pause.body.readUtf8())
            server.takeRequest(); server.takeRequest()
            // A refused press says why in the server's words and changes nothing.
            server.enqueue(json("""{"statusCode":400,"message":"runner is offline"}""").setResponseCode(400))
            assertEquals("runner is offline", model.press { api.post("runners/r1/engine-update") })
            assertEquals("/api/runners/r1/engine-update", server.takeRequest().path)
            // A removal the machine refused comes back as a failed state, not as a success.
            server.enqueue(json("""{"engine":"claude","account":"1fda3f43","status":"failed","message":"in use by a session"}"""))
            val removal = api.delete("runners/r1/accounts/claude/1fda3f43") as JsonObject
            assertEquals("in use by a session", removal.str("message"))
            assertEquals("DELETE", server.takeRequest().method)
            // Approving a machine with no browser.
            server.enqueue(json("""{"userCode":"ABCDE-FGH23","name":"ci","hostname":"ci-01","status":"PENDING","nameConflict":true}"""))
            assertEquals("ci", api.get("runners/device/${RunnerPage.deviceCode("abcde fgh23")}").jsonObject.text("name"))
            assertEquals("/api/runners/device/ABCDE-FGH23", server.takeRequest().path)
            assertEquals(13, server.requestCount)
        }
    }

    @Test fun releaseVersionIsReadWithoutTheAccountsCredential() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"version":" 0.1.197 "}"""))
            assertEquals("0.1.197", runnerReleaseVersion(server.url("/orbit/").toString()))
            val read = server.takeRequest()
            assertEquals("/orbit/dl/version.json", read.path)
            assertNull("The public manifest never receives a bearer", read.getHeader("Authorization"))
            server.enqueue(MockResponse().setResponseCode(404))
            assertNull(runnerReleaseVersion(server.url("/").toString()))
        }
    }

    @Test fun workspaceDoneSendsWhatUpdateAgentRequestSends() {
        val saved = buildJsonObject { put("name", "app"); put("appendSystemPrompt", "be brief"); put("workDir", "/srv/app"); put("modelRouting", false) }
        assertEquals(buildJsonObject { put("name", "App"); put("effort", "high"); put("enabled", true) },
            workspacePatch(saved, "  App ", "high", "", "", true, false))
        assertEquals(buildJsonObject { put("name", "app"); put("appendSystemPrompt", "x"); put("effort", ""); put("workDir", "/w"); put("enabled", false); put("modelRouting", true) },
            workspacePatch(saved, "app", "", "x", "/w", false, true))
    }

    @Test fun shareAndPoolWritesKeepTheirIosShapes() = runBlocking {
        MockWebServer().use { server ->
            val api = start(server)
            server.enqueue(json("""{"id":"l","token":"t","kind":"SESSION","state":"ACTIVE","root":{"id":"s"},"include":{"toolOutput":true}}"""))
            api.put(sharingPath("SESSION", "s"), JsonObject(emptyMap()))
            assertEquals("PUT /api/sessions/s/share {}", server.takeRequest().let { "${it.method} ${it.path} ${it.body.readUtf8()}" })
            server.enqueue(json("""{"count":1}"""))
            api.post("share-links/turn-off", buildJsonObject { put("shareLinkIds", buildJsonArray { add("l") }) })
            assertEquals("""{"shareLinkIds":["l"]}""", server.takeRequest().body.readUtf8())
            // Sharing a pool adds each address on its own, with no role: the server's MEMBER default.
            server.enqueue(json("{}"))
            api.post("providers/shared-pools/p/people", buildJsonObject { put("email", "a@x.test") })
            assertEquals("""{"email":"a@x.test"}""", server.takeRequest().body.readUtf8())
            server.enqueue(MockResponse().setResponseCode(204))
            api.delete("providers/pools/p/codex-login")
            assertEquals("DELETE /api/providers/pools/p/codex-login", server.takeRequest().let { "${it.method} ${it.path}" })
        }
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
