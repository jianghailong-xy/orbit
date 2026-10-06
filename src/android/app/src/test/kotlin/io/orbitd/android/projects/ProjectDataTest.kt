package io.orbitd.android.projects

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.directory.DirectoryApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class ProjectDataTest {
    private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject
    private val now = Instant.parse("2026-10-05T00:00:00Z")

    @Test fun indexDistinguishesOwnerAttentionFromPlatformWorkAndQuietTasks() {
        val ordinary = obj("""{"id":"project","title":"Project","status":"OPEN","_count":{"tasks":2},"buckets":{"ready":2},"lastActivityAt":"2026-10-04T23:00:00Z"}""")
        assertEquals(ProjectLane.READY, projectLane(ordinary, now))
        assertEquals(ProjectLane.RUNNING, projectLane(JsonObject(ordinary + ("integration" to obj("""{"activeJobCount":1}"""))), now))
        assertEquals(ProjectLane.ATTENTION, projectLane(JsonObject(ordinary + ("attention" to obj("""{"startRequest":{"waitingSince":"2026-10-04T00:00:00Z"}}"""))), now))
        assertEquals(ProjectLane.ATTENTION, projectLane(JsonObject(ordinary + ("lastActivityAt" to JsonPrimitive("2026-10-01T00:00:00Z"))), now))
        assertEquals(ProjectLane.OTHER, projectLane(JsonObject(ordinary + ("status" to JsonPrimitive("FUTURE_STATUS"))), now))
        assertEquals(ProjectLane.WAITING, projectLane(obj("""{"status":"OPEN","_count":{"tasks":1},"buckets":{"failed":1}}"""), now))
    }

    @Test fun authorizationRetainsBigintRevisionAndAutomaticDoesNotBecomeLegacyPause() {
        val body = projectAuthorization(obj("""{"configRevision":"18446744073709551615"}"""), automatic = false, concurrency = 7)
        assertEquals("18446744073709551615", body.text("expectedConfigRevision"))
        assertEquals(JsonPrimitive(false), body["automatic"])
        assertFalse(body.containsKey("coordinatorEnabled"))
        assertEquals(7, body.number("maxConcurrentTasks"))
        try { projectAuthorization(obj("{}"), automatic = true); fail("Missing revision must refuse") } catch (_: IllegalArgumentException) {}
    }

    @Test fun graphUsesPrerequisiteDirectionAndKeepsEveryFold() {
        val marks = listOf(obj("""{"id":"leaf","kind":"TASK"}"""), obj("""{"id":"fold","kind":"RUN","taskCount":4}"""), obj("""{"id":"root","kind":"TASK"}"""))
        val edges = listOf(obj("""{"sourceMarkId":"root","targetMarkId":"fold"}"""), obj("""{"sourceMarkId":"fold","targetMarkId":"leaf"}"""))
        assertEquals(mapOf("root" to 0, "fold" to 1, "leaf" to 2), graphLevels(marks, edges))
        val page = ProjectPageData(obj("""{"maxConcurrentTasks":3}"""), mapOf("graph" to buildJsonObject { put("marks", JsonArray(marks)); put("edges", JsonArray(edges)) }, "integration" to obj("{}")), emptyMap())
        assertEquals("PROJECT_BRANCH", projectStartSettings(page).line)
        assertEquals(3, projectStartSettings(page).maxConcurrentTasks)
        val decided = page.copy(sections = page.sections + ("integration" to obj("""{"line":"MAIN","locked":true}""")))
        assertEquals("MAIN", projectStartSettings(decided).line)
    }

    @Test fun optionalFailureDoesNotBecomeEmptySuccessAndPagesRestoreLoadedWindow() = runTest {
        val calls = mutableListOf<ApiRequest>()
        val auth = auth { request ->
            calls += request.api
            val path = request.api.path
            when {
                path == listOf("auth", "login") -> response(login)
                path == listOf("projects", "p") -> response("""{"id":"p","title":"Project","status":"OPEN","_count":{"tasks":2}}""")
                path.last() == "dependency-graph" -> ApiResponse(503, "{}".encodeToByteArray())
                path.takeLast(2) == listOf("tasks", "page") -> if (request.api.query.any { it == "cursor" to "next" }) response("""{"items":[{"id":"second","title":"Second"}],"nextCursor":null}""")
                    else response("""{"items":[{"id":"first","title":"First"}],"nextCursor":"next"}""")
                else -> response("{}")
            }
        }
        val handle = auth.login(ServerAddress.parse("https://project-fixture.test"), "owner@example.test", "fixture")
        val page = ProjectsApi(DirectoryApi(auth, handle)).page("p", 2)
        assertEquals(listOf("first", "second"), page.tasks.map { it.text("id") })
        assertNull(page.nextCursor)
        assertTrue("Failed graph must be a visible section error", page.errors.containsKey("graph"))
        assertFalse(page.sections.containsKey("graph"))
        assertTrue(calls.any { it.query.contains("cursor" to "next") })
        auth.logout()
    }

    @Test fun permissionDenialInAuxiliaryReadWithdrawsEntirePage() = runTest {
        val auth = auth { request ->
            when {
                request.api.path == listOf("auth", "login") -> response(login)
                request.api.path.last() == "integration" -> ApiResponse(403, "{}".encodeToByteArray())
                else -> response("{}")
            }
        }
        val handle = auth.login(ServerAddress.parse("https://project-fixture.test"), "owner@example.test", "fixture")
        try { ProjectsApi(DirectoryApi(auth, handle)).page("p"); fail("403 must not render stale project sections") }
        catch (error: ApiError) { assertEquals(403, error.status) }
        auth.logout()
    }

    private fun response(body: String) = ApiResponse(200, body.encodeToByteArray())
    private val login = """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"owner","name":"Owner","email":"owner@example.test"}}"""
    private fun auth(reply: suspend (HttpRequest) -> ApiResponse) = AuthSession(HttpTransport { reply(it) },
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
}
