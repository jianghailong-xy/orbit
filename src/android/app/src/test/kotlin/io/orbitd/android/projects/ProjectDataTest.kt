package io.orbitd.android.projects

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.taskprojects.FeatureWriteRefused
import io.orbitd.android.taskprojects.FeatureWriteUncertain
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** The project wire as OrbitKit's APIClient sends it (`testEveryProjectCallHitsItsRoute`), through A03's real AuthSession. */
class ProjectDataTest {
    private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject
    private val now = Instant.parse("2026-10-05T00:00:00Z")

    @Test fun indexDistinguishesOwnerAttentionFromPlatformWorkAndQuietTasks() {
        val ordinary = obj("""{"id":"project","title":"Project","status":"OPEN","_count":{"tasks":2},"buckets":{"ready":2},"lastActivityAt":"2026-10-04T23:00:00Z"}""")
        assertEquals(ProjectLane.READY, ProjectAttention.lane(ordinary, now))
        assertEquals(ProjectLane.RUNNING, ProjectAttention.lane(JsonObject(ordinary + ("integration" to obj("""{"activeJobCount":1}"""))), now))
        assertEquals(ProjectLane.ATTENTION, ProjectAttention.lane(JsonObject(ordinary + ("attention" to obj("""{"startRequest":{"waitingSince":"2026-10-04T00:00:00Z"}}"""))), now))
        assertEquals(ProjectLane.ATTENTION, ProjectAttention.lane(JsonObject(ordinary + ("lastActivityAt" to JsonPrimitive("2026-10-01T00:00:00Z"))), now))
        // A status this build does not know reads as closed, as iOS reads it — never an invented lane.
        assertEquals(ProjectLane.COMPLETED, ProjectAttention.lane(JsonObject(ordinary + ("status" to JsonPrimitive("FUTURE_STATUS"))), now))
        assertEquals(ProjectLane.WAITING, ProjectAttention.lane(obj("""{"status":"OPEN","_count":{"tasks":1},"buckets":{"failed":1}}"""), now))
    }

    @Test fun everyProjectCallHitsItsRoute() = runTest {
        val fixture = Fixture { request ->
            val path = request.api.path
            when {
                path == listOf("projects") -> ok("""[{"id":"p1","title":"T","status":"OPEN"}]""")
                path.lastOrNull() == "coordinator" -> ok("""{"sessionId":"s1","created":true,"workspaceId":"w1"}""")
                path.lastOrNull() == "replace" -> ok("""{"sessionId":"s2","created":true}""")
                else -> ok("{}")
            }
        }
        val api = fixture.api()
        assertEquals(listOf("p1"), api.index().map { it.text("id") })
        api.document("p1"); api.panorama("p1"); api.integration("p1"); api.openItems("p1"); api.coordinator("p1"); api.graph("p1")
        api.ready("p1"); api.confirmation("p1"); api.share("p1"); api.tasks("p1", "c2", 50)
        assertEquals("s1", api.openCoordinator("p1").text("sessionId"))
        api.setStatus("p1", "DONE", "r:1")
        api.authorize("p1", RunSettings.authorization(obj("""{"configRevision":"7"}"""), automatic = true)!!)
        api.authorize("p1", RunSettings.authorization(obj("""{"configRevision":"8"}"""), maxConcurrentTasks = 4)!!)
        api.updateIntegration("p1", buildJsonObject { put("line", "MAIN"); put("mergeCheckCommand", JsonNull); put("exceptionEscalationSeconds", 3600) }, "r:1")
        api.pause("p1", true, "r:1"); api.pause("p1", false, "r:2")
        api.start("p1", StartProjectCopy.body("d1", StartProjectCopy.Settings("MAIN", null, true, 2, null), "MAIN", true, 2, " "))
        api.resumeFuse("p1", "f1"); api.resolveBlocker("p1", "b1", "agent added")
        api.run("t1", "press-1", "t1:OPEN:READY"); api.resumeList("l1")
        assertEquals("s2", api.replaceCoordinator("p1", "replace:s1")?.text("sessionId"))
        api.delete("p1")
        val log = fixture.calls.drop(1).map { call ->
            listOfNotNull("${call.api.method} /${call.api.path.joinToString("/")}" + call.api.query.takeIf { it.isNotEmpty() }
                ?.joinToString("&", "?") { "${it.first}=${it.second}" }.orEmpty(), call.api.body?.decodeToString()).joinToString(" ")
        }
        assertEquals(listOf(
            "GET /projects", "GET /projects/p1", "GET /projects/p1/panorama", "GET /projects/p1/integration", "GET /projects/p1/open-items",
            "GET /projects/p1/coordinator/status", "GET /projects/p1/dependency-graph", "GET /projects/p1/panorama/ready?limit=5",
            "GET /projects/p1/acceptance/confirmation", "GET /projects/p1/share", "GET /projects/p1/tasks/page?limit=50&cursor=c2",
            "POST /projects/p1/coordinator",
            """PATCH /projects/p1 {"status":"DONE"}""",
            // `automatic`, never `coordinatorEnabled`, whose off the server also reads as a pause.
            """PATCH /projects/p1 {"automatic":true,"expectedConfigRevision":"7"}""",
            """PATCH /projects/p1 {"maxConcurrentTasks":4,"expectedConfigRevision":"8"}""",
            """PATCH /projects/p1/integration {"line":"MAIN","mergeCheckCommand":null,"exceptionEscalationSeconds":3600}""",
            "POST /projects/p1/pause", "POST /projects/p1/resume",
            // The owner's own start answers no request: the key is sent, and it is null.
            """POST /projects/p1/start {"criteriaDigest":"d1","line":"MAIN","automatic":true,"maxConcurrentTasks":2,"mergeCheckCommand":null,"requestId":null}""",
            "POST /projects/p1/fuse/f1/resume", """POST /projects/p1/blockers/b1/resolve {"reason":"agent added"}""",
            """POST /tasks/t1/execute {"triggerId":"press-1"}""",
            """PATCH /task-lists/l1 {"paused":false,"note":"Resumed from the project Run queue"}""",
            "POST /projects/p1/coordinator/replace", "DELETE /projects/p1",
        ), log)
        assertTrue(fixture.calls.drop(1).all { it.accessToken == "fixture-access" })
    }

    @Test fun theTaskWindowIsReadAgainFromTheTopSoAPollNeitherCollapsesNorStrandsItsTail() = runTest {
        val fixture = Fixture { request ->
            when (request.api.query.toMap()["cursor"]) {
                null -> ok("""{"items":[{"id":"first"}],"nextCursor":"next"}""")
                "next" -> ok("""{"items":[{"id":"second"}],"nextCursor":"after"}""")
                else -> ok("""{"items":[{"id":"third"}],"nextCursor":null}""")
            }
        }
        val (items, cursor) = fixture.api().taskWindow("p1", 2)
        assertEquals(listOf("first", "second"), items.map { it.text("id") })
        assertEquals("after", cursor)
        assertEquals(listOf("2", "1"), fixture.calls.drop(1).map { it.api.query.toMap()["limit"] })
    }

    @Test fun noProjectWriteLeavesTheDeviceWhileTheAccountStreamIsDownAndRefusalsKeepTheServersWords() = runTest {
        val fixture = Fixture { request ->
            if (request.api.method == HttpMethod.PATCH) ApiResponse(409, """{"message":"Configuration changed — reload and try again"}""".encodeToByteArray()) else ok("{}")
        }
        fixture.api()
        val offline = ProjectApi(fixture.session, fixture.handle!!) { false }
        val before = fixture.calls.size
        try { offline.openCoordinator("p1"); fail() } catch (_: FeatureWriteRefused) { }
        try { offline.pause("p1", true, "r"); fail() } catch (_: FeatureWriteRefused) { }
        assertEquals(before, fixture.calls.size)
        val online = ProjectApi(fixture.session, fixture.handle!!)
        val refused = runCatching { online.authorize("p1", RunSettings.authorization(obj("""{"configRevision":"1"}"""), automatic = false)!!) }.exceptionOrNull()!!
        assertEquals("Configuration changed — reload and try again", failureReason(refused))
        assertEquals("the server returned 403", failureReason(ApiError.parse(403, "{}".encodeToByteArray())))
        assertEquals("first\nsecond", failureReason(ApiError.parse(400, """{"message":["first","second"]}""".encodeToByteArray())))
        assertEquals("Not Found", failureReason(ApiError.parse(404, """{"error":"Not Found"}""".encodeToByteArray())))
        assertEquals("you're signed out", failureReason(ApiError.parse(401, "{}".encodeToByteArray())))
        assertEquals("the connection dropped", failureReason(NetworkException()))
        assertTrue(failureReason(FeatureWriteUncertain()).isNotEmpty())
    }

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())
}

private class Fixture(val response: suspend (HttpRequest) -> ApiResponse) {
    val calls = mutableListOf<HttpRequest>()
    var handle: SessionHandle? = null
    val session = AuthSession(HttpTransport { request ->
        calls += request
        if (request.api.path == listOf("auth", "login")) ApiResponse(200, """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"owner","email":"owner@example.test","name":"Owner"}}""".encodeToByteArray())
        else response(request)
    }, object : CredentialStore {
        var saved: StoredSession? = null
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
    }, "test")
    suspend fun api(): ProjectApi {
        handle = session.login(ServerAddress.parse("https://projects.example"), "owner@example.test", "fixture-password")
        return ProjectApi(session, handle!!)
    }
}
