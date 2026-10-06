package io.orbitd.android.tasks

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.cards.*
import io.orbitd.android.taskprojects.FeatureWriteUncertain
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class TaskApiTest {
    @Test fun listScopeUsesOutsideProjectsButNamedListsAndConversationKeepTheirMembership() {
        assertEquals("none", TaskQuery().scope().toMap()["projectId"])
        assertEquals("none", TaskQuery(listId = "none").scope().toMap()["projectId"])
        assertFalse(TaskQuery(listId = "named").scope().toMap().containsKey("projectId"))
        assertFalse(TaskQuery(creatorSession = "session").scope().toMap().containsKey("projectId"))
        val query = TaskQuery(status = "RUNNABLE", query = "  中文 & x  ", labels = listOf("Sprint, one", "Mobile")).parameters("opaque&cursor")
        assertEquals(listOf("Sprint, one", "Mobile"), query.filter { it.first == "labels" }.map { it.second })
        assertEquals("中文 & x", query.toMap()["q"])
        assertEquals("opaque&cursor", query.toMap()["cursor"])
        assertEquals("none", query.toMap()["counts"])
    }

    @Test fun reopenClearsBothRetirementFieldsInOneAuthenticatedPatch() = runTest {
        val fixture = Fixture()
        val api = fixture.api()
        api.reopen("task")
        val call = fixture.calls.last()
        assertEquals(listOf("tasks", "task"), call.api.path)
        assertEquals(HttpMethod.PATCH, call.api.method)
        assertEquals("fixture-access", call.accessToken)
        assertEquals(json("""{"status":"OPEN","supersededByTaskId":null,"terminalReason":null}"""), call.body())
        fixture.session.logout()
        try { api.reopen("task"); fail("Logged-out epoch must not mutate") } catch (_: SessionChanged) { }
    }

    @Test fun directOwnerConfirmationReadsAuthorityAndCannotAnswerAnArrivingRunCard() = runTest {
        var waiting = false
        val fixture = Fixture { request ->
            if (request.api.method == HttpMethod.GET) ApiResponse(200, (if (waiting)
                """{"completionCriterion":"OWNER_CONFIRMED","status":"OPEN","waiting":{"requestId":"r","sessionId":"run"}}"""
            else """{"completionCriterion":"OWNER_CONFIRMED","status":"OPEN","waiting":null}""").encodeToByteArray())
            else ApiResponse(200, "{}".encodeToByteArray())
        }
        val api = fixture.api()
        api.confirmWithoutRun("task")
        assertEquals(json("""{"decision":"CONFIRM","requestId":null}"""), fixture.calls.last().body())
        waiting = true
        val writes = fixture.calls.count { it.api.method == HttpMethod.POST }
        try { api.confirmWithoutRun("task"); fail("Panel must not answer a run card") } catch (_: IllegalStateException) { }
        assertEquals(writes, fixture.calls.count { it.api.method == HttpMethod.POST })
    }

    @Test fun missingOwnerReadIsNotNoWaitingAndOtherCriteriaNeverShowPanelConfirm() {
        assertFalse(TaskApi.canConfirmWithoutRun(json("""{"completionCriterion":"OWNER_CONFIRMED","status":"OPEN"}""")))
        assertFalse(TaskApi.canConfirmWithoutRun(json("""{"completionCriterion":"EVIDENCE_JUDGMENT","status":"OPEN","waiting":null}""")))
        assertFalse(TaskApi.canConfirmWithoutRun(json("""{"completionCriterion":"OWNER_CONFIRMED","status":"DONE","waiting":null}""")))
        assertTrue(TaskApi.canConfirmWithoutRun(json("""{"completionCriterion":"OWNER_CONFIRMED","status":"FAILED","waiting":null}""")))
    }

    @Test fun uncertainRunCannotBeReplayedByRecreationOrByMintingANewTrigger() = runTest {
        val fixture = Fixture { throw NetworkException() }
        val api = fixture.api().also { it.authorityRevision = "revision-one" }
        try { api.execute("task", "first-press"); fail("Expected unknown result") } catch (_: FeatureWriteUncertain) { }
        val sent = fixture.calls.size
        val restored = TaskApi(fixture.session, fixture.handle!!).also { it.authorityRevision = "revision-one" }
        try { restored.execute("task", "new-press"); fail("Same unknown authority revision must stay fenced") } catch (_: FeatureWriteUncertain) { }
        assertEquals(sent, fixture.calls.size)
    }

    @Test fun permissionDenialIsDefinitiveAndPreservesServerRequiredAction() = runTest {
        val fixture = Fixture { ApiResponse(403, """{"code":"TASK_DENIED","message":"Not allowed","requiredAction":"Ask the owner"}""".encodeToByteArray()) }
        val api = fixture.api()
        repeat(2) {
            try { api.update("task", buildJsonObject { put("runAt", JsonNull) }); fail("Permission must not become a success") }
            catch (error: ApiError) { assertEquals(403, error.status); assertEquals("You don't have permission to access this task.", taskError(error)) }
        }
        assertEquals(2, fixture.calls.count { it.api.method == HttpMethod.PATCH })
    }

    @Test fun batchAssignmentsUseExplicitNullAndRunHasOnePressIdentity() = runTest {
        val fixture = Fixture()
        val api = fixture.api()
        api.batch("assign", listOf("one", "two"))
        assertEquals(listOf("tasks", "batch-assign"), fixture.calls.last().api.path)
        assertEquals(JsonNull, fixture.calls.last().body()["assigneeId"])
        api.batch("execute", listOf("one", "two"), "press", 2)
        val body = fixture.calls.last().body()
        assertEquals("press", body.text("triggerId")); assertEquals(2, body.number("maxConcurrent"))
        assertEquals(listOf("one", "two"), body.strings("taskIds"))
    }

    @Test fun acceptanceEditsKeepCompletionCriterionAndClearCommandPairTogether() {
        val current = json("""{"acceptanceCriteria":"Before","acceptanceCommand":"check","acceptanceExpectedExitCode":0,"completionCriterion":"EXECUTABLE"}""")
        val fields = acceptancePatch(current, "After", "", "")
        assertEquals(JsonNull, fields["acceptanceCommand"]); assertEquals(JsonNull, fields["acceptanceExpectedExitCode"])
        assertFalse(fields.containsKey("completionCriterion"))
        assertNotNull(acceptanceProblem("check", "")); assertNotNull(acceptanceProblem("check", "1.0"))
        assertNull(acceptanceProblem("check", "-1"))
    }

    @Test fun dependencyGraphAdaptsContractEdgeDirectionWithoutInventingNodes() {
        val graph = json("""{"nodes":[{"id":"before","title":"First","status":"DONE"},{"id":"after","title":"Second","status":"OPEN"}],"edges":[{"sourceTaskId":"before","targetTaskId":"after"}],"truncated":true,"limits":{"maxNodes":200}}""")
        val rendered = taskGraphForDisplay(graph)
        assertEquals(listOf("before", "after"), rendered.objects("marks").map { it.text("taskId") })
        assertEquals("before", rendered.objects("edges").single().text("sourceMarkId"))
        assertEquals("after", rendered.objects("edges").single().text("targetMarkId"))
        assertTrue(rendered.flag("truncated")); assertEquals(200, rendered.obj("limits")?.number("maxTasks"))
    }

    @Test fun batchPartialResultNamesRefusalsInsteadOfClaimingAllTasksSaved() {
        val result = json("""{"dispatched":1,"skipped":[{"id":"b","title":"Blocked work","reason":"DEPENDENCY_BLOCKED"}],"failed":[{"id":"c","ok":false,"error":"Runner unavailable"}]}""")
        val text = batchResultText(result, mapOf("c" to "Retry work"))
        assertTrue(text.contains("1 tasks started"))
        assertTrue(text.contains("Blocked work: DEPENDENCY_BLOCKED"))
        assertTrue(text.contains("Retry work: Runner unavailable"))
        assertFalse(text.contains("Saved"))
    }

    @Test fun liveRunAndReviewPresentationDoesNotMasqueradeAsLifecycleCompletion() {
        val row = json("""{"status":"DONE","running":true,"queued":true,"confirmationUnderReview":true,"dependencyState":"BLOCKED_FAILED"}""")
        assertEquals("Running", taskStatus(row))
        assertEquals("Under review", taskPhrase(row))
        assertEquals("Waiting for your confirmation", taskPhrase(JsonObject(row + ("awaitingOwnerConfirmation" to JsonPrimitive(true)))))
    }
}

private fun json(value: String) = Json.parseToJsonElement(value).jsonObject
private fun HttpRequest.body() = json(api.body!!.decodeToString())
private class Fixture(val response: suspend (HttpRequest) -> ApiResponse = { ApiResponse(200, "{}".encodeToByteArray()) }) {
    val calls = mutableListOf<HttpRequest>()
    var handle: SessionHandle? = null
    val session = AuthSession(HttpTransport { request ->
        calls += request
        if (request.api.path == listOf("auth", "login")) ApiResponse(200, """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"owner","email":"owner@example.test","name":"Owner"}}""".encodeToByteArray()) else response(request)
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
