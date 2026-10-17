package io.orbitd.android.tasks

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.cards.*
import io.orbitd.android.taskprojects.FeatureWriteRefused
import io.orbitd.android.taskprojects.FeatureWriteUncertain
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The Tasks wire as OrbitKit's APIClient sends it, through A03's real AuthSession over a fake transport. */
class TaskApiTest {
    @Test fun browsingScopesStayOutsideProjectsWhilePickedListsAndCreatorsKeepTheirMembers() {
        assertEquals("none", TaskQuery().scope().toMap()["projectId"])
        assertEquals("none", TaskQuery(listId = "none").scope().toMap()["projectId"])
        assertFalse(TaskQuery(listId = "named").scope().toMap().containsKey("projectId"))
        assertFalse(TaskQuery(creatorSessionId = "session").scope().toMap().containsKey("projectId"))
        val page = TaskQuery(filter = TaskFilter.RUNNABLE, search = "  中文 & x  ", labels = listOf("Sprint, one", "Mobile")).page("opaque&cursor")
        assertEquals(listOf("Sprint, one", "Mobile"), page.filter { it.first == "labels" }.map { it.second })
        assertEquals("中文 & x", page.toMap()["q"]); assertEquals("RUNNABLE", page.toMap()["status"])
        assertEquals("opaque&cursor", page.toMap()["cursor"]); assertEquals("none", page.toMap()["counts"]); assertEquals("200", page.toMap()["limit"])
        // Counts are the scope's: never the tab or the search.
        val counts = TaskQuery(filter = TaskFilter.FAILED, search = "x", labels = listOf("a")).scope().toMap()
        assertFalse(counts.containsKey("status")); assertFalse(counts.containsKey("q")); assertEquals("a", counts["labels"])
        assertEquals(listOf("projectId" to "none"), TaskQuery(labels = listOf("a")).listScope())
    }

    @Test fun reopenClearsBothRetirementFieldsInOneAuthenticatedPatch() = runTest {
        val fixture = Fixture()
        val api = fixture.api()
        api.reopen("task", "task:1")
        val call = fixture.calls.last()
        assertEquals(listOf("tasks", "task"), call.api.path); assertEquals(HttpMethod.PATCH, call.api.method)
        assertEquals("fixture-access", call.accessToken)
        assertEquals(json("""{"status":"OPEN","supersededByTaskId":null,"terminalReason":null}"""), call.body())
        fixture.session.logout()
        try { api.reopen("task", "task:2"); fail("A logged-out epoch must not write") } catch (_: SessionChanged) { }
    }

    /** A task pin is one authenticated PATCH naming the engine beside the credential (board 6): a DeepSeek key pinned under
     * DeepSeek Harness, the engine alone, then every pin taken back — each with the model pin cleared. */
    @Test fun aPinNamesTheEngineBesideTheProviderInOnePatch() = runTest {
        val fixture = Fixture()
        val api = fixture.api()
        api.pin("task", TaskPin(TaskPin.Pin("dsh"), TaskPin.Pin("deepseek-2")), "task:1")
        api.pin("task", TaskPin(TaskPin.Pin("claude")), "task:2")
        api.pin("task", TaskPin(TaskPin.Pin(null), TaskPin.Pin(null)), "task:3")
        val pins = fixture.calls.filter { it.api.method == HttpMethod.PATCH }
        assertTrue(pins.all { it.api.path == listOf("tasks", "task") && it.accessToken == "fixture-access" })
        assertEquals(listOf(json("""{"engine":"dsh","provider":"deepseek-2","model":null}"""), json("""{"engine":"claude","model":null}"""),
            json("""{"engine":null,"provider":null,"model":null}""")), pins.map { it.body() })
    }

    @Test fun panelConfirmReadsFirstAndNeverAnswersARunThatStartedWaiting() = runTest {
        var view = """{"taskId":"task","completionCriterion":"OWNER_CONFIRMED","status":"OPEN","waiting":null}"""
        val fixture = Fixture { request -> if (request.api.method == HttpMethod.GET) ApiResponse(200, view.encodeToByteArray()) else ApiResponse(200, "{}".encodeToByteArray()) }
        val api = fixture.api()
        api.confirmOwner("task", "task:1")
        assertEquals(json("""{"decision":"CONFIRM","requestId":null,"reviewRecordId":null}"""), fixture.calls.last().body())
        view = """{"taskId":"task","completionCriterion":"OWNER_CONFIRMED","status":"OPEN","waiting":{"requestId":"r","sessionId":"run"}}"""
        val posts = fixture.calls.count { it.api.method == HttpMethod.POST }
        try { api.confirmOwner("task", "task:2"); fail("The panel must not answer a run's card") } catch (_: IllegalStateException) { }
        // The server confirms only unsettled tasks: a FAILED one is not offered (OWNER_CONFIRMATION_UNSETTLED_STATUSES).
        view = """{"taskId":"task","completionCriterion":"OWNER_CONFIRMED","status":"FAILED","waiting":null}"""
        try { api.confirmOwner("task", "task:3"); fail("FAILED is settled") } catch (_: IllegalStateException) { }
        assertEquals(posts, fixture.calls.count { it.api.method == HttpMethod.POST })
    }

    @Test fun aRunPressIsResentUnderItsOneNameAndAnUnknownAnswerHoldsTheSamePress() = runTest {
        var attempts = 0
        val fixture = Fixture { request -> if (request.api.path.lastOrNull() == "execute") { attempts++; throw NetworkException() } else ApiResponse(200, "{}".encodeToByteArray()) }
        val api = fixture.api()
        try { api.execute("task", "first-press", "task:1"); fail("Expected an unknown result") } catch (_: FeatureWriteUncertain) { }
        assertEquals("the resend budget is four deliveries of one press", 4, attempts)
        assertTrue(fixture.calls.filter { it.api.path.lastOrNull() == "execute" }.all { it.body() == json("""{"triggerId":"first-press"}""") })
        // A new press over the same displayed row within the hold is refused locally, not sent.
        try { TaskApi(fixture.session, fixture.handle!!).execute("task", "new-press", "task:1"); fail() } catch (_: FeatureWriteUncertain) { }
        assertEquals(4, attempts)
    }

    @Test fun aRunWhoseFirstDeliveryStillHoldsTheLeaseIsAskedAgainUnderTheSameName() = runTest {
        var attempts = 0
        val fixture = Fixture { request ->
            if (request.api.path.lastOrNull() != "execute") ApiResponse(200, "{}".encodeToByteArray())
            else if (++attempts == 1) ApiResponse(409, """{"code":"TASK_RUN_REQUEST_IN_PROGRESS"}""".encodeToByteArray())
            else ApiResponse(200, """{"sessionId":"run"}""".encodeToByteArray())
        }
        val result = fixture.api().execute("task", "press", "task:1") as JsonObject
        assertEquals("run", result.text("sessionId")); assertEquals(2, attempts)
    }

    @Test fun refusalsKeepTheServersWordsAndARunConflictIsReadByCode() = runTest {
        val fixture = Fixture { ApiResponse(403, """{"code":"PROJECT_SCOPE_MISMATCH","message":"Filed under another project","requiredAction":"Ask the owner"}""".encodeToByteArray()) }
        val api = fixture.api()
        repeat(2) { attempt ->
            try { api.update("task", buildJsonObject { put("runAt", JsonNull) }, "task:$attempt"); fail("A refusal is not a success") }
            catch (error: ApiError) { assertEquals("Filed under another project", taskError(error)) }
        }
        assertEquals("a definitive refusal leaves no hold", 2, fixture.calls.count { it.api.method == HttpMethod.PATCH })
        assertEquals("You don't have permission to access this task.", taskError(ApiError.parse(403, "{}".encodeToByteArray())))
        val held = TaskRunHandoff.readConflict(ApiError.parse(409, """{"code":"TASK_ALREADY_RUNNING","conflictingSessionId":"run","taskId":"t"}""".encodeToByteArray()))!!
        assertEquals(TaskRunHandoff.Kind.HELD, held.kind); assertEquals("run", held.sessionId); assertEquals(TaskRunHandoff.heldTitle, held.title)
        assertEquals(TaskRunHandoff.Kind.ENDING, TaskRunHandoff.readConflict(ApiError.parse(409,
            """{"code":"TASK_ALREADY_RUNNING","conflictingSessionEnding":true}""".encodeToByteArray()))?.kind)
        assertNull(TaskRunHandoff.readConflict(ApiError.parse(409, """{"code":"SOMETHING_NEW"}""".encodeToByteArray())))
    }

    @Test fun bulkWritesNameAssigneeExplicitlyAndRunAFewAtOnceUnderOnePress() = runTest {
        val fixture = Fixture()
        val api = fixture.api()
        api.batch(TaskBatchAction.ASSIGN, listOf("one", "two"), "t1", null, "r1")
        assertEquals(listOf("tasks", "batch-assign"), fixture.calls.last().api.path)
        assertEquals(json("""{"taskIds":["one","two"],"assigneeId":null}"""), fixture.calls.last().body())
        api.batch(TaskBatchAction.RUN, listOf("a", "b", "c", "d", "e"), "press", null, "r2")
        assertEquals(json("""{"taskIds":["a","b","c","d","e"],"maxConcurrent":3,"triggerId":"press"}"""), fixture.calls.last().body())
        api.batch(TaskBatchAction.STOP, listOf("a"), "t3", null, "r3")
        assertEquals(json("""{"taskIds":["a"]}"""), fixture.calls.last().body())
    }

    @Test fun commentsCarryMentionedWorkspacesAndFollowCreatesAVersionOneTaskWatch() = runTest {
        val fixture = Fixture()
        val api = fixture.api()
        val workspaces = listOf(json("""{"id":"ws1","name":"Builder"}"""), json("""{"id":"ws2","name":"Build"}"""))
        val body = "Please check this @builder."
        api.addComment("task", body, mentionedWorkspaceIds(body, workspaces), "c1")
        assertEquals(json("""{"body":"Please check this @builder.","mentions":["ws1"]}"""), fixture.calls.last().body())
        api.addComment("task", "  plain  ", emptyList(), "c2")
        assertEquals(json("""{"body":"plain"}"""), fixture.calls.last().body())
        api.follow("task", TaskFollow.conditions[1], 86_400, "key-1")
        assertEquals(json("""{"predicateVersion":1,"predicate":{"kind":"ANY_OF","operands":[{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_TERMINAL"},
            {"kind":"ANY","over":"ALL_TARGETS","leaf":"TASK_FAILED"}]},"targets":[{"kind":"TASK","id":"task"}],"action":"NOTIFY_USER","ttlSeconds":86400,"idempotencyKey":"key-1"}"""),
            fixture.calls.last().body())
    }

    @Test fun theDependencyComponentIsAskedInBothDirections() = runTest {
        val fixture = Fixture { ApiResponse(200, """{"focusTaskId":"t","nodes":[],"edges":[]}""".encodeToByteArray()) }
        fixture.api().dependencyGraph("t")
        assertEquals(listOf("direction" to "both", "maxNodes" to "500", "pairUnary" to "true"), fixture.calls.last().api.query)
    }

    @Test fun noWriteLeavesTheDeviceWhileTheAccountStreamIsDown() = runTest {
        val fixture = Fixture()
        fixture.api()
        val offline = TaskApi(fixture.session, fixture.handle!!) { false }
        val before = fixture.calls.size
        try { offline.update("task", buildJsonObject { put("autoRunWhenReady", true) }, "t:1"); fail() } catch (_: FeatureWriteRefused) { }
        try { offline.execute("task", "press", "t:1"); fail() } catch (_: FeatureWriteRefused) { }
        assertEquals(before, fixture.calls.size)
    }
}

internal fun json(value: String) = Json.parseToJsonElement(value).jsonObject
private fun HttpRequest.body() = json(api.body!!.decodeToString())
private class Fixture(val response: suspend (HttpRequest) -> ApiResponse = { ApiResponse(200, "{}".encodeToByteArray()) }) {
    val calls = mutableListOf<HttpRequest>()
    var handle: SessionHandle? = null
    val session = AuthSession(HttpTransport { request ->
        calls += request
        if (request.api.path == listOf("auth", "login")) ApiResponse(200, """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"owner","email":"owner@example.test","name":"Owner"}}""".encodeToByteArray())
        else if (request.api.path == listOf("auth", "logout")) ApiResponse(200, "{}".encodeToByteArray()) else response(request)
    }, object : CredentialStore {
        var saved: StoredSession? = null
        override suspend fun load() = saved
        override suspend fun save(session: StoredSession) { saved = session }
        override suspend fun clear() { saved = null }
    }, object : InstanceStore {
        override suspend fun load(): String? = null
        override suspend fun save(server: String) {}
    }, object : SessionDataStore {
        val data = mutableMapOf<String, ByteArray>()
        override suspend fun read(account: AccountKey, kind: DataKind, key: String) = data[key]
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) { data[key] = bytes }
        override suspend fun clearAll() { data.clear() }
    }, "test")
    suspend fun api(): TaskApi {
        handle = session.login(ServerAddress.parse("https://tasks.example"), "owner@example.test", "fixture-password")
        return TaskApi(session, handle!!)
    }
}
