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
        var approval = fixture().obj("snapshot")!!.objects("approvals").first()
        var pending = true
        var denied = false
        var posted = 0
        var holdRead: CompletableDeferred<Unit>? = null
        var write: suspend () -> ApiResponse = { pending = false; response("""{"status":"ALLOWED"}""") }
        fun response(json: String) = ApiResponse(200, json.encodeToByteArray())
        fun client() = AuthSession(HttpTransport { request ->
            val path = request.api.path
            when {
                path.first() == "auth" -> response("{}")
                request.api.method != HttpMethod.GET -> { posted++; write() }
                path == listOf("sessions", sid) -> {
                    holdRead?.await()
                    if (denied) ApiResponse(403, "{}".encodeToByteArray()) else response("""{"id":"$sid","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN"}""")
                }
                path.last() == "page" -> response("""{"events":[],"hasMore":false,"after":null}""")
                path.last() == "approvals" -> response(if (pending) "[$approval]" else "[]")
                path == listOf("tasks", "evidence-decisions", "pending") -> response("""{"pending":[],"decided":[]}""")
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
}
