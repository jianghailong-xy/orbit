package io.orbitd.android.push

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitLinks
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

class PushAuthorityTest {
    @Test fun sharedBackendFixtureRetainsZeroBadgeAndCanonicalClearSessions() {
        val samples = pushFixture()["samples"]!!.jsonArray
        val approval = PushMessage.parse(samples[0].jsonObject["data"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content })!!
        val sync = PushMessage.parse(samples[1].jsonObject["data"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content })!!
        assertEquals(PushType.ALERT, approval.type)
        assertTrue(approval.payload.isReminder)
        assertEquals(sid, OrbitLinks.parse(approval.link!!)!!.id)
        assertEquals(PushType.SYNC, sync.type)
        assertEquals(0, sync.payload.badge)
        assertEquals(setOf(sid), sync.payload.clearSessions)
        assertNull(sync.link)
    }

    @Test fun parserRejectsMalformedEnvelopeAndPartialRoutesWithoutRewritingOpaqueBinding() {
        val base = fixtureData()
        assertEquals(base.getValue("registrationKey"), PushMessage.parse(base)!!.registrationKey)
        listOf("version" to "2", "type" to "notification", "eventId" to "1", "registrationKey" to "1",
            "notificationKey" to "\n", "sentAt" to "yesterday", "payload" to "[]").forEach {
            assertNull(it.first, PushMessage.parse(base + it))
        }
        listOf(
            """{"title":"A","body":"B","kind":"approval","sessionID":"../../other"}""",
            """{"title":"A","body":"B","kind":"approval","sessionID":3}""",
            """{"title":"A","body":"B","kind":"approval","sessionID":"1","badge":"1"}""",
            """{"title":"A","body":"B","kind":"confirmation-problems","sessionID":"1"}""",
            """{"title":"A","body":"B","kind":"watch-matched","watchID":"1","generation":0}""",
            """{"title":"A","body":"B","kind":"unknown","sessionID":"1"}""",
            """{"clearSessions":["bad/id"]}""",
        ).forEach { assertNull(PushMessage.parse(base + ("payload" to it))) }
        val normalized = message("approval", "sessionID" to "1")
        assertEquals(ObjectId.canonical("1"), normalized.payload.sessionId)
    }

    @Test fun routesPreserveCardSemanticPriorityAndOnlyConfirmationRecordIsAnAnchor() {
        val owner = message("coordinator-question", "sessionID" to sid, "projectID" to pid, "openItemID" to iid)
        assertEquals(Destination.SESSION, OrbitLinks.parse(owner.link!!)!!.destination)
        assertNull(OrbitLinks.parse(owner.link!!)!!.recordId)
        val noCoordinator = message("coordinator-question", "projectID" to pid, "openItemID" to iid)
        assertEquals(Destination.PROJECT, OrbitLinks.parse(noCoordinator.link!!)!!.destination)
        val confirmation = message("confirmation-problems", "sessionID" to sid, "taskID" to tid, "recordID" to rid)
        assertEquals(rid, OrbitLinks.parse(confirmation.link!!)!!.recordId)
        assertEquals(Destination.WATCH, OrbitLinks.parse(message("watch-matched", "watchID" to wid, "generation" to 3).link!!)!!.destination)
        assertEquals(Destination.RUNNER, OrbitLinks.parse(message("engine-signed-out", "runnerID" to runnerId, "engine" to "codex").link!!)!!.destination)
        // Existing OrbitLinks has no wiki-space entry; an entry URL would be the wrong object.
        assertNull(message("wiki-review-mode-manual", "wikiSpaceID" to pid).link)
        assertNull(message("agent-message").link)
    }

    @Test fun needsYouUsesAuthenticatedOpenSnapshotWithPublicAliasesAndExcludesStartOnlyAndFiledRows() = runBlocking {
        authorityFixture { authority, server, _ ->
            server.respond = { request ->
                assertEquals("/api/sessions?view=open", request.path)
                response("""[
                    {"id":"1","status":"RUNNING","lifecycleState":"OPEN","pendingApprovals":1},
                    {"id":"${ObjectId.canonical("1")}","lifecycleState":"OPEN","pendingApprovals":2},
                    {"id":"2","lifecycleState":"OPEN","pendingApprovals":1,"waitingKind":"START_REQUEST"},
                    {"id":"3","status":"AWAITING_INPUT","lifecycleState":"OPEN","pendingApprovals":0,"ownerItems":[{"itemId":"4"}],"cancelRequestedAt":"2026-10-04"},
                    {"id":"5","lifecycleState":"OPEN","pendingApprovals":2,"cancelRequestedAt":"2026-10-04"},
                    {"id":"6","lifecycleState":"COMPLETED","pendingApprovals":1},
                    {"id":"7","lifecycleState":"TRASH","pendingApprovals":1}
                ]""")
            }
            assertEquals(setOf(ObjectId.canonical("1"), ObjectId.canonical("3")), authority.needsYou())
            server.respond = { response("{\"unexpected\":[]}") }
            try { authority.needsYou(); fail("Invalid read is not an authoritative empty list") } catch (_: ProtocolException) { }
            server.respond = { response("[{\"id\":\"1\",\"lifecycleState\":\"OPEN\",\"pendingApprovals\":\"broken\"}]") }
            try { authority.needsYou(); fail("Invalid count is not an authoritative zero") } catch (_: ProtocolException) { }
        }
    }

    @Test fun approvalReadSeparatesResolvedMissingForbiddenAndUnknownAndUsesPendingEndpoint() = runBlocking {
        authorityFixture { authority, server, _ ->
            val push = message("approval", "sessionID" to sid)
            var filed = false
            var pending = true
            server.respond = { request -> when (request.path) {
                "/api/sessions/$sid" -> response("""{"id":"$sid","status":"RUNNING","lifecycleState":"OPEN","completedAt":${if (filed) "\"2026-10-04\"" else "null"}}""")
                "/api/sessions/$sid/approvals?status=PENDING" -> response(if (pending) """[{"id":"$iid","status":"PENDING"}]""" else "[]")
                else -> response("{}", 404)
            } }
            assertEquals(PushCheck.ACTIVE, authority.check(push))
            pending = false
            assertEquals(PushCheck.STALE, authority.check(push))
            pending = true; filed = true
            assertEquals(PushCheck.STALE, authority.check(push))
            for ((http, result) in listOf(403 to PushCheck.FORBIDDEN, 404 to PushCheck.MISSING, 503 to PushCheck.UNKNOWN)) {
                server.respond = { response("{}", http) }
                assertEquals(result, authority.check(push))
            }
            server.respond = { response("not json") }
            assertEquals(PushCheck.UNKNOWN, authority.check(push))
            server.respond = { request -> if (request.path!!.contains("approvals")) response("[{}]")
                else response("""{"id":"$sid","status":"RUNNING","lifecycleState":"OPEN"}""") }
            assertEquals(PushCheck.UNKNOWN, authority.check(push))
        }
    }

    @Test fun ownerItemsReadActualItemIdContractAndRejectMovedCoordinatorOrResolvedItem() = runBlocking {
        authorityFixture { authority, server, _ ->
            val push = message("coordinator-question", "sessionID" to sid, "projectID" to pid, "openItemID" to iid)
            var coordinator = sid
            var needs = true
            server.respond = { request -> when (request.path) {
                "/api/projects/$pid" -> response("""{"id":"$pid","coordinatorSessionId":"$coordinator"}""")
                "/api/sessions/$sid" -> response("""{"id":"$sid","status":"AWAITING_INPUT","lifecycleState":"OPEN"}""")
                "/api/projects/$pid/open-items" -> response("""{"needsYou":${if (needs) """[{"itemId":"$iid","kind":"COORDINATOR_QUESTION","assignee":"OWNER"}]""" else "[]"},"withCoordinator":[]}""")
                else -> response("{}", 404)
            } }
            assertEquals(PushCheck.ACTIVE, authority.check(push))
            needs = false
            assertEquals(PushCheck.STALE, authority.check(push))
            needs = true; coordinator = tid
            assertEquals(PushCheck.STALE, authority.check(push))
        }
    }

    @Test fun watchNeedsExactMatchGenerationAndConfirmationNeedsActualProblemsRecord() = runBlocking {
        authorityFixture { authority, server, _ ->
            val watch = message("watch-matched", "watchID" to wid, "generation" to 2)
            server.respond = { response("""{"id":"$wid","action":"NOTIFY_USER","generation":3,"matches":[{"generation":2}]}""") }
            assertEquals(PushCheck.ACTIVE, authority.check(watch))
            server.respond = { response("""{"id":"$wid","action":"NOTIFY_USER","generation":3,"matches":[{"generation":3}]}""") }
            assertEquals(PushCheck.STALE, authority.check(watch))
            val confirmation = message("confirmation-problems", "sessionID" to sid, "taskID" to tid, "recordID" to rid)
            var record = rid
            server.respond = { request -> if (request.path == "/api/sessions/$sid") response("""{"id":"$sid","status":"SUCCEEDED","lifecycleState":"COMPLETED"}""") else
                response("""{"decisions":[{"sessionId":"$sid","review":{"problems":{"recordId":"$record"}}}]}""") }
            assertEquals(PushCheck.ACTIVE, authority.check(confirmation))
            record = iid
            assertEquals(PushCheck.STALE, authority.check(confirmation))
        }
    }

    @Test fun runnerUsesActualListContractAndCurrentEngineAuth() = runBlocking {
        authorityFixture { authority, server, _ ->
            val push = message("engine-signed-out", "runnerID" to runnerId, "engine" to "codex")
            var engineAuth = "no"
            server.respond = { request ->
                assertEquals("/api/runners", request.path)
                response("""[{"id":"$runnerId","engines":[{"engine":"codex","auth":"$engineAuth"}]}]""")
            }
            assertEquals(PushCheck.ACTIVE, authority.check(push))
            engineAuth = "yes"; assertEquals(PushCheck.STALE, authority.check(push))
            engineAuth = "unknown"; assertEquals(PushCheck.UNKNOWN, authority.check(push))
        }
    }

    @Test fun headlessMessageHasNoInventedRouteAndChecksCurrentAccountPreference() = runBlocking {
        authorityFixture { authority, server, _ ->
            val push = message("agent-message")
            var enabled = true
            server.respond = { request ->
                assertEquals("/api/users/me", request.path)
                response("""{"id":"fixture-user","preferences":{"notifyAgentMessage":$enabled}}""")
            }
            assertNull(push.link)
            assertEquals(PushCheck.ACTIVE, authority.check(push))
            enabled = false
            assertEquals(PushCheck.STALE, authority.check(push))
            server.respond = { response("{}") }
            assertEquals(PushCheck.UNKNOWN, authority.check(push))
        }
    }

    @Test fun offlineDoesNotBecomeResolvedAndRetiredAccountPropagatesCancellation() = runBlocking {
        authorityFixture { authority, server, auth ->
            val push = message("approval", "sessionID" to sid)
            server.server.shutdown()
            assertEquals(PushCheck.UNKNOWN, authority.check(push))
            try { authority.needsYou(); fail("Offline must not clear current reminders") } catch (_: NetworkException) { }
            auth.logout()
            try { authority.check(push); fail("Retired account must not finish a check") } catch (_: SessionChanged) { }
        }
    }
}

private val sid = "019a0000-0000-7000-8000-000000000002"
private val pid = "019a0000-0000-7000-8000-000000000003"
private val iid = "019a0000-0000-7000-8000-000000000004"
private val tid = "019a0000-0000-7000-8000-000000000005"
private val rid = "019a0000-0000-7000-8000-000000000006"
private val wid = "019a0000-0000-7000-8000-000000000007"
private val runnerId = "019a0000-0000-7000-8000-000000000008"

private fun pushFixture(): JsonObject {
    val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/shared/src/android-push.fixture.json").isFile }
    return Json.parseToJsonElement(File(root, "src/shared/src/android-push.fixture.json").readText()).jsonObject
}
private fun fixtureData(): Map<String, String> = pushFixture()["samples"]!!.jsonArray[0].jsonObject["data"]!!.jsonObject
    .mapValues { it.value.jsonPrimitive.content }
private fun message(kind: String, vararg fields: Pair<String, Any>): PushMessage = PushMessage.parse(fixtureData() + ("payload" to
    buildJsonObject {
        put("title", "Fixture"); put("body", "Read current state"); put("kind", kind)
        fields.forEach { (key, value) -> if (value is Int) put(key, value) else put(key, value.toString()) }
    }.toString()))!!

private fun response(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setBody(body)
private class AuthorityServer(val server: MockWebServer) {
    var respond: (RecordedRequest) -> MockResponse = { response("{}", 404) }
}
private suspend fun authorityFixture(block: suspend (PushAuthority, AuthorityServer, AuthSession) -> Unit) {
    MockWebServer().use { server ->
        val fixture = AuthorityServer(server)
        val access = listOf("authority", "access").joinToString("-")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/api/auth/login" -> response(buildJsonObject {
                    put("accessToken", access); put("refreshToken", listOf("authority", "refresh").joinToString("-"))
                    putJsonObject("user") { put("id", "fixture-user"); put("name", "Fixture"); put("email", "fixture@example.test") }
                }.toString())
                "/api/auth/logout" -> response("{}")
                else -> { assertEquals("Bearer $access", request.getHeader("Authorization")); fixture.respond(request) }
            }
        }
        server.start()
        val auth = AuthSession(OkHttpTransport(), object : CredentialStore {
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
        val handle = auth.login(ServerAddress.parse(server.url("/").toString(), true), "fixture@example.test", "test-password")
        try { block(PushAuthority(auth, handle), fixture, auth) } finally { auth.logout() }
    }
}
