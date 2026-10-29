package io.orbitd.android.push

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitLinks
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
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

    @Test fun deviceTestCorpusIsTheSharedCardsCorpus() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/shared/src/interaction-cards.fixture.json").isFile }
        // The device APK cannot read the repository, so it carries a byte-identical asset copy.
        assertArrayEquals(File(root, "src/shared/src/interaction-cards.fixture.json").readBytes(),
            File(root, "src/android/app/src/androidTest/assets/push/interaction-cards.fixture.json").readBytes())
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
        // The space URI handed to A12, never an entry URL (that would be the wrong object). Its parse
        // branch belongs to A12, so this asserts only the URI this module emits.
        assertEquals("orbit://wiki/$pid", message("wiki-review-mode-manual", "wikiSpaceID" to pid).link)
        assertNull(message("agent-message").link)
    }

    /** A11-9's push (iOS 6b4bef713 `Notifications.intent`, Phase3LogicTests): a merge into main waiting on the owner opens its project's
     * sessions page — with or without a coordinator conversation — named without a workspace (OrbitNavigationTest pins how it lands).
     * Every other owner item still opens its conversation (its project's page without one), and every session's alert its session. A
     * merge naming no project falls back to its conversation, as on iOS; no server sends one, and the parser refuses it. */
    @Test fun aMergeIntoMainOpensItsProjectsSessionsPageAndEveryOtherAlertKeepsItsRoute() {
        fun route(push: PushMessage) = push.link?.let { OrbitLinks.parse(it, origin = Origin.EXTERNAL) }
        val project = OrbitRoute(Destination.PROJECT_SESSIONS, pid, origin = Origin.EXTERNAL)
        val session = OrbitRoute(Destination.SESSION, sid, origin = Origin.EXTERNAL)
        val merge = message("approve-merge-to-main", "sessionID" to sid, "projectID" to pid, "openItemID" to iid)
        assertEquals("orbit://project/$pid", merge.link)
        assertEquals(project, route(merge))
        assertEquals(project, route(message("approve-merge-to-main", "projectID" to pid, "openItemID" to iid)))
        for (kind in listOf("coordinator-question", "escalated-to-you", "fuse-paused")) {
            assertEquals(kind, session, route(message(kind, "sessionID" to sid, "projectID" to pid, "openItemID" to iid)))
            assertEquals(kind, OrbitRoute(Destination.PROJECT, pid, origin = Origin.EXTERNAL), route(message(kind, "projectID" to pid, "openItemID" to iid)))
        }
        for (kind in listOf("approval", "finished", "failed", "agent-message")) assertEquals(kind, session, route(message(kind, "sessionID" to sid)))
        assertEquals(session, PushPayload(kind = "approve-merge-to-main", sessionId = sid).link?.let { OrbitLinks.parse(it, origin = Origin.EXTERNAL) })
        assertNull(PushMessage.parse(fixtureData() + ("payload" to
            """{"title":"A","body":"B","kind":"approve-merge-to-main","sessionID":"$sid","openItemID":"$iid"}""")))
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

    /** Revision 29's fifth owner item (§7.6 V12, owner 2026-10-28): `landed-without-confirmation` is handled as the other owner items
     * are — it names its project and its item or is no notification, it is a reminder, it opens the coordinator conversation its card
     * is in (its project's page without one), and it stands only while the item is the owner's and open: Accept ends it. */
    @Test fun workThatLandedWithoutYourConfirmationIsPushedAsAnOwnerItem() = runBlocking {
        val push = message("landed-without-confirmation", "sessionID" to sid, "projectID" to pid, "openItemID" to iid)
        assertTrue(push.payload.isOwnerItem); assertTrue(push.payload.isReminder)
        assertEquals(OrbitRoute(Destination.SESSION, sid, origin = Origin.EXTERNAL), push.link?.let { OrbitLinks.parse(it, origin = Origin.EXTERNAL) })
        assertEquals(OrbitRoute(Destination.PROJECT, pid, origin = Origin.EXTERNAL),
            message("landed-without-confirmation", "projectID" to pid, "openItemID" to iid).link?.let { OrbitLinks.parse(it, origin = Origin.EXTERNAL) })
        assertNull("an owner item names its project and its item", PushMessage.parse(fixtureData() + ("payload" to
            """{"title":"Landed without your confirmation","body":"Fix the login redirect · Launch","kind":"landed-without-confirmation","sessionID":"$sid","projectID":"$pid"}""")))
        authorityFixture { authority, server, _ ->
            var open = true
            server.respond = { request -> when (request.path) {
                "/api/projects/$pid" -> response("""{"id":"$pid","coordinatorSessionId":"$sid"}""")
                "/api/sessions/$sid" -> response("""{"id":"$sid","status":"AWAITING_INPUT","lifecycleState":"OPEN"}""")
                "/api/projects/$pid/open-items" -> response("""{"needsYou":${if (open) """[{"itemId":"$iid","kind":"LANDED_WITHOUT_CONFIRMATION","assignee":"OWNER"}]""" else "[]"},"withCoordinator":[]}""")
                else -> response("{}", 404)
            } }
            assertEquals(PushCheck.ACTIVE, authority.check(push))
            open = false
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
