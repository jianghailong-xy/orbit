package io.orbitd.android.core.cards

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class CardActionsTest {
    private class Rig(val scope: TestScope) {
        val credentials = MemoryCredentials().apply { value = StoredSession(serverA.value, tokens()) }
        val instances = MemoryInstances().apply { value = serverA.value }
        val data = MemoryData()
        val sid = fixture().text("sessionId")!!
        val pid = fixture().text("projectId")!!
        var exception: JsonObject? = null
        var approval = fixture().obj("snapshot")!!.objects("approvals").first()
        var pending = true
        var denied = false
        var posted = 0
        var holdRead: CompletableDeferred<Unit>? = null
        /** The session is its project's coordinator conversation, and what the pending evidence read answers it. */
        var coordinates = false
        var evidence = """{"pending":[],"decided":[]}"""
        var lastPost: ApiRequest? = null
        var write: suspend () -> ApiResponse = { pending = false; response("""{"status":"ALLOWED"}""") }
        fun response(json: String) = ApiResponse(200, json.encodeToByteArray())
        fun client() = AuthSession(HttpTransport { request ->
            val path = request.api.path
            when {
                path.first() == "auth" -> response("{}")
                request.api.method != HttpMethod.GET -> { posted++; lastPost = request.api; write() }
                path == listOf("sessions", sid) -> {
                    holdRead?.await()
                    if (denied) ApiResponse(403, "{}".encodeToByteArray()) else response(buildJsonObject {
                        put("id", sid); put("status", "AWAITING_INPUT"); put("runState", "AWAITING_INPUT"); put("lifecycleState", "OPEN")
                        if (exception != null || coordinates) put("projectId", pid)
                    }.toString())
                }
                path == listOf("projects", pid) -> response(fixture().obj("snapshot")!!.obj("standing")!!.obj("project").toString())
                path == listOf("projects", pid, "open-items") -> response(buildJsonObject {
                    putJsonArray("needsYou") { exception?.takeIf { it.text("assignee") == "OWNER" }?.let { add(it) } }
                    putJsonArray("withCoordinator") { exception?.takeIf { it.text("assignee") == "COORDINATOR" }?.let { add(it) } }
                    put("startRequest", JsonNull)
                }.toString())
                path.last() == "page" -> response("""{"events":[],"hasMore":false,"after":null}""")
                path.last() == "approvals" -> response(if (pending) "[$approval]" else "[]")
                path == listOf("tasks", "evidence-decisions", "pending") -> response(evidence)
                else -> response("[]")
            }
        }, credentials, instances, data, "test", dispatcher = StandardTestDispatcher(scope.testScheduler),
            eventTransport = object : EventTransport {
                override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) {
                    onOpen(); awaitCancellation()
                }
            })
        suspend fun start(): Pair<AuthSession, RealtimeStore> {
            val auth = client(); auth.restore()
            val store = RealtimeStore(auth, scope.backgroundScope)
            store.selectSession(sid); store.setForeground(true); store.setNetwork(true)
            scope.runCurrent()
            check(store.state.value.session!!.fresh)
            return auth to store
        }
        fun card(store: RealtimeStore) = CardCatalog.session(sid, store.state.value.session!!.snapshot!!).single()
    }
    private fun AuthSession.handle() = (state.value as AuthState.SignedIn).handle

    @Test fun reassignedExceptionKeepsSameItemButNotThePreviousGenerationsFence() = runTest {
        val patches = fixture("interaction-cards-review.fixture.json").objects("exceptionAssignmentChanges")
        val original = fixture().obj("snapshot")!!.obj("standing")!!.obj("openItems")!!.objects("needsYou").single { it.text("itemId") == "x1" }
        for (lostResponse in listOf(false, true)) {
            val rig = Rig(this).apply { pending = false; exception = JsonObject(original + patches[0]) }
            var (auth, store) = rig.start()
            var actions = CardActions(auth, store, backgroundScope)
            val first = rig.card(store)
            suspend fun refresh() { store.refreshSession(); runCurrent(); advanceTimeBy(101); runCurrent() }
            val firstWrite = CompletableDeferred<Unit>()
            rig.write = {
                firstWrite.await()
                if (lostResponse) throw IOException("response lost")
                rig.exception = JsonObject(original + patches[1]); rig.response("{}")
            }
            actions.submit(auth.handle(), first, CardVerb.RETURN_COORDINATOR); runCurrent()
            actions.submit(auth.handle(), first, CardVerb.RETURN_COORDINATOR); runCurrent()
            assertEquals(1, rig.posted)
            firstWrite.complete(Unit); runCurrent(); advanceTimeBy(101); runCurrent()
            store.close(); runCurrent()
            val restarted = rig.start(); auth = restarted.first; store = restarted.second
            actions = CardActions(auth, store, backgroundScope)
            actions.restore(auth.handle(), listOf(first))
            assertEquals(lostResponse, actions.state.value[first.key]!!.uncertain)
            assertEquals(!lostResponse, actions.state.value[first.key]!!.settled)
            actions.submit(auth.handle(), first, CardVerb.RETURN_COORDINATOR); runCurrent()
            assertEquals("Same generation stays fenced after cold restore", 1, rig.posted)
            for (round in 1..2) {
                rig.exception = JsonObject(original + patches[round * 2 - 1]); refresh()
                assertTrue(CardCatalog.session(rig.sid, store.state.value.session!!.snapshot!!).isEmpty())
                rig.exception = JsonObject(original + patches[round * 2]); refresh()
                val current = rig.card(store)
                assertEquals(first.key, current.key)
                actions.restore(auth.handle(), listOf(current))
                val state = actions.state.value[current.key]
                assertFalse("A new assignment must not inherit sent/uncertain", state?.settled == true || state?.uncertain == true)
                assertNotEquals(first.binding, current.binding)
                // No persisted fence in this account: stale display must also fail the REST version check.
                val otherRig = Rig(this).apply { pending = false; exception = rig.exception }
                val (otherAuth, otherStore) = otherRig.start()
                CardActions(otherAuth, otherStore, backgroundScope).submit(otherAuth.handle(), first, CardVerb.MARK_HANDLED, CardInput(text = "Old display")); runCurrent()
                assertEquals("Old display must not write to a new assignment", 0, otherRig.posted)
                otherStore.close(); runCurrent()
                val write = CompletableDeferred<Unit>()
                rig.write = { write.await(); rig.response("{}") }
                actions.submit(auth.handle(), current, if (round == 1) CardVerb.RETURN_COORDINATOR else CardVerb.MARK_HANDLED, CardInput(text = "Reviewed this assignment")); runCurrent()
                actions.submit(auth.handle(), current, CardVerb.RETURN_COORDINATOR); runCurrent()
                assertEquals(round + 1, rig.posted)
                write.complete(Unit); runCurrent(); advanceTimeBy(101); runCurrent()
            }
            store.close(); runCurrent()
        }
    }

    @Test fun doubleTapAndSecondControllerCannotPostTwiceAndNoOptimisticRemoval() = runTest {
        val rig = Rig(this); val (auth, store) = rig.start()
        val first = CardActions(auth, store, backgroundScope); val other = CardActions(auth, store, backgroundScope)
        val gate = CompletableDeferred<Unit>()
        rig.write = { gate.await(); rig.pending = false; rig.response("""{"status":"ALLOWED"}""") }
        val card = rig.card(store)
        first.submit(auth.handle(), card, CardVerb.ALLOW); runCurrent()
        first.submit(auth.handle(), card, CardVerb.DENY); other.submit(auth.handle(), card, CardVerb.ALLOW); runCurrent()
        assertEquals(1, rig.posted)
        assertEquals(1, store.state.value.session!!.snapshot!!.approvals.size)
        assertTrue(first.state.value[card.key]!!.busy)
        gate.complete(Unit); runCurrent(); advanceTimeBy(101); runCurrent()
        assertTrue(store.state.value.session!!.snapshot!!.approvals.isEmpty())
        assertEquals("Allowed · recorded by the server", first.state.value[card.key]!!.message)
        first.restore(auth.handle(), listOf(card))
        assertEquals("An ordinary refresh must preserve the actual server verdict", "Allowed · recorded by the server", first.state.value[card.key]!!.message)
        store.close()
    }

    @Test fun timeoutAfterServerEffectIsFencedAcrossColdAuthAndStoreRestore() = runTest {
        val rig = Rig(this); val (auth, store) = rig.start(); val card = rig.card(store)
        // Keep GET pending to model a delayed authority read after the lost response.
        rig.write = { throw IOException("lost response after server effect") }
        val actions = CardActions(auth, store, backgroundScope)
        actions.submit(auth.handle(), card, CardVerb.ALLOW); runCurrent(); advanceTimeBy(101); runCurrent()
        assertTrue(actions.state.value[card.key]!!.uncertain)
        store.close(); runCurrent()
        val (restored, freshStore) = rig.start()
        val restoredActions = CardActions(restored, freshStore, backgroundScope)
        restoredActions.restore(restored.handle(), listOf(rig.card(freshStore)))
        assertTrue(restoredActions.state.value[card.key]!!.uncertain)
        restoredActions.submit(restored.handle(), card, CardVerb.DENY); runCurrent()
        assertEquals(1, rig.posted)
        rig.pending = false
        freshStore.refreshSession(); runCurrent(); advanceTimeBy(101); runCurrent()
        assertTrue(freshStore.state.value.session!!.snapshot!!.approvals.isEmpty())
        freshStore.close()
    }

    @Test fun alreadyHandledOrChangedInputIsRejectedBeforeSending() = runTest {
        for (missing in listOf(true, false)) {
            val rig = Rig(this); val (auth, store) = rig.start(); val card = rig.card(store)
            if (missing) rig.pending = false else rig.approval = JsonObject(rig.approval + ("input" to buildJsonObject { put("command", "different") }))
            val actions = CardActions(auth, store, backgroundScope)
            actions.submit(auth.handle(), card, CardVerb.ALLOW); runCurrent()
            assertEquals(0, rig.posted)
            assertTrue(actions.state.value[card.key]!!.message!!.contains("handled elsewhere"))
            store.close(); runCurrent()
        }
    }

    @Test fun losingRaceDisplaysTheWinningServerDecision() = runTest {
        val rig = Rig(this); val (auth, store) = rig.start(); val card = rig.card(store)
        rig.write = { rig.pending = false; rig.response("""{"status":"DENIED"}""") }
        val actions = CardActions(auth, store, backgroundScope)
        actions.submit(auth.handle(), card, CardVerb.ALLOW); runCurrent()
        assertEquals("Denied · recorded by the server", actions.state.value[card.key]!!.message)
        store.close()
    }

    @Test fun forbiddenActionRechecksSessionAndUsesDurableRevocation() = runTest {
        val rig = Rig(this); val (auth, store) = rig.start(); val card = rig.card(store)
        rig.write = { rig.denied = true; ApiResponse(403, "{}".encodeToByteArray()) }
        val actions = CardActions(auth, store, backgroundScope)
        actions.submit(auth.handle(), card, CardVerb.ALLOW); runCurrent()
        assertTrue(store.state.value.session!!.accessDenied)
        assertNull(store.state.value.session!!.snapshot)
        assertFalse(actions.valid(auth.handle(), rig.sid))
        assertFalse(actions.state.value[card.key]!!.uncertain)
        store.close(); runCurrent()
        val restored = rig.client(); restored.restore()
        val restoredStore = RealtimeStore(restored, backgroundScope); restoredStore.selectSession(rig.sid); runCurrent()
        assertTrue(restoredStore.state.value.session!!.accessDenied)
        restoredStore.close()
    }

    @Test fun foregroundAndAccountEpochChangesWhilePreflightingPreventWrite() = runTest {
        for (change in listOf("logout", "background", "offline", "navigate")) {
            val rig = Rig(this); val (auth, store) = rig.start(); val card = rig.card(store)
            val actions = CardActions(auth, store, backgroundScope)
            rig.holdRead = CompletableDeferred()
            actions.submit(auth.handle(), card, CardVerb.ALLOW); runCurrent()
            when (change) {
                "logout" -> auth.logout()
                "background" -> store.setForeground(false)
                "offline" -> store.setNetwork(false)
                else -> store.selectSession(null)
            }
            rig.holdRead!!.complete(Unit); runCurrent()
            assertEquals(change, 0, rig.posted)
            store.close(); runCurrent()
        }
    }

    @Test fun offlineCachedCardCannotWriteAndConflictDoesNotClaimSuccess() = runTest {
        val rig = Rig(this); val (auth, store) = rig.start(); val card = rig.card(store)
        val actions = CardActions(auth, store, backgroundScope)
        store.setNetwork(false); runCurrent()
        actions.submit(auth.handle(), card, CardVerb.ALLOW); runCurrent()
        assertEquals(0, rig.posted)
        store.setNetwork(true); runCurrent()
        rig.write = { ApiResponse(409, """{"code":"EVIDENCE_JUDGMENT_EVIDENCE_SUPERSEDED","requiredAction":"Read revision 8."}""".encodeToByteArray()) }
        actions.submit(auth.handle(), card, CardVerb.ALLOW); runCurrent()
        assertEquals(1, rig.posted)
        assertFalse(actions.state.value[card.key]!!.settled)
        assertFalse(actions.state.value[card.key]!!.uncertain)
        assertTrue(actions.state.value[card.key]!!.message!!.contains("Read revision 8."))
        store.close()
    }

    /** Decide it myself (project 34cygPTQe5LPUT7tdUAzG): the closed card has no decision to press; the opened one is re-read at the
     * press as the revision still waiting, and posts today's request — but not once the revision was sent to the coordinator. */
    @Test fun decideItMyselfIsPressedAsTheRevisionStillWaiting() = runTest {
        val queue = fixture().obj("snapshot")!!.obj("standing")!!.obj("evidenceDecisions")!!
        val row = queue.objects("waitingOnCoordinator").single()
        fun read(group: String, value: JsonObject) = buildJsonObject {
            put("decidingSessionId", queue.text("decidingSessionId")); putJsonArray("pending") {}; putJsonArray("decided") {}
            putJsonArray(group) { add(value) }
        }.toString()
        val waitingRead = read("waitingOnCoordinator", row)
        val rig = Rig(this).apply { pending = false; coordinates = true; evidence = waitingRead; write = { response("{}") } }
        val (auth, store) = rig.start()
        val actions = CardActions(auth, store, backgroundScope)
        val waiting = rig.card(store)
        assertEquals(CardFamily.COORDINATOR_QUEUE, waiting.family)
        actions.submit(auth.handle(), waiting, CardVerb.CONFIRM_EVIDENCE); runCurrent()
        assertEquals("the closed card asks nothing", 0, rig.posted)
        val opened = CoordinatorQueue.decideMyself(waiting)!!
        rig.evidence = read("sentToCoordinator", buildJsonObject {
            put("taskId", row.text("taskId")); put("title", row.text("title")); put("projectId", row.text("projectId"))
            put("evidenceRevision", "2"); put("deliveredAt", "2026-10-04T00:05:00.000Z")
        })
        actions.submit(auth.handle(), opened, CardVerb.CONFIRM_EVIDENCE); runCurrent(); advanceTimeBy(101); runCurrent()
        assertEquals("sent to the coordinator meanwhile: no longer the owner's to press here", 0, rig.posted)
        assertTrue(actions.state.value[opened.key]!!.message!!.contains("handled elsewhere"))
        rig.evidence = waitingRead
        actions.submit(auth.handle(), opened, CardVerb.CONFIRM_EVIDENCE); runCurrent(); advanceTimeBy(101); runCurrent()
        assertEquals(1, rig.posted)
        assertEquals(listOf("tasks", row.text("taskId"), "evidence", "decision"), rig.lastPost!!.path)
        assertEquals(buildJsonObject { put("decidingSessionId", queue.text("decidingSessionId")); put("evidenceRevision", "2"); put("decision", "CONFIRM") },
            Wire.json.parseToJsonElement(rig.lastPost!!.body!!.decodeToString()))
        assertTrue(actions.state.value[opened.key]!!.settled)
        store.close()
    }
}
