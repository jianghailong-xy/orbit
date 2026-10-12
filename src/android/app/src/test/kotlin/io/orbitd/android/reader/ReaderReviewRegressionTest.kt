package io.orbitd.android.reader

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

/** Controlled rev1 review inputs. The same tests run against b0 and the repaired product. */
@OptIn(ExperimentalCoroutinesApi::class)
class ReaderReviewRegressionTest {
    private class Rig(val test: TestScope) {
        val disk = mutableMapOf<Pair<AccountKey, String>, ByteArray>()
        var pageStatus = 200
        var recordStatus = 200
        var snapshotStatus = 200
        var pageOffline = false
        var held: CompletableDeferred<Unit>? = null
        var heldFull: CompletableDeferred<Unit>? = null
        val calls = mutableListOf<ApiRequest>()
        val auth = AuthSession(HttpTransport { request ->
            val api = request.api; calls += api
            val status: Int
            val data: String
            when {
                api.path.first() == "auth" -> {
                    status = 200
                    data = """{"accessToken":"access","refreshToken":"refresh","user":{"id":"u","email":"a@example.test","name":"A"}}"""
                }
                api.path.last() == "page" -> {
                    val query = api.query.toMap()
                    status = if ("around" in query) recordStatus else pageStatus
                    if (pageOffline) throw IOException("controlled offline")
                    if ("before" in query) held?.let { withContext(NonCancellable) { it.await() } }
                    val start = if ("around" in query) 100 else if ("before" in query) 601 else 801
                    val events = (start until start + 200).map { RunEvent("assistant", it.toLong(), buildJsonObject { put("text", "Protected record $it") }) }
                    data = Wire.json.encodeToString(EventPage.serializer(), EventPage(events, true,
                        if ("around" in query) 299 else null, anchor = if ("around" in query) RecordAnchor("event", "record", 180) else null))
                }
                api.path.last() == "full" -> {
                    status = recordStatus; data = """{"type":"assistant","seq":999,"payload":{"text":"Complete protected record"}}"""
                    heldFull?.let { withContext(NonCancellable) { it.await() } }
                }
                api.path.size == 2 && api.path.first() == "sessions" -> { status = snapshotStatus; data = """{"id":"${api.path[1]}","status":"RUNNING"}""" }
                else -> { status = 200; data = "[]" }
            }
            ApiResponse(status, data.toByteArray())
        }, object : CredentialStore {
            var value: StoredSession? = null
            override suspend fun load() = value
            override suspend fun save(session: StoredSession) { value = session }
            override suspend fun clear() { value = null }
        }, object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) = Unit
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String) = disk[account to key]
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) { disk[account to key] = bytes }
            override suspend fun clearAll() { disk.clear() }
        }, "review", dispatcher = StandardTestDispatcher(test.testScheduler), eventTransport = object : EventTransport {
            override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) { onOpen(); awaitCancellation() }
        })
        lateinit var store: RealtimeStore
        val handle get() = (auth.state.value as AuthState.SignedIn).handle
        suspend fun start(): SessionReaderModel {
            auth.login(ServerAddress.parse("https://fixture.test"), "a@example.test", "password")
            restart(online = true)
            return reader().also { test.runCurrent(); assertTrue(it.state.value.window.events.isNotEmpty()) }
        }
        fun restart(online: Boolean) {
            if (::store.isInitialized) store.close()
            store = RealtimeStore(auth, test.backgroundScope)
            store.selectSession("s"); store.setForeground(true); store.setNetwork(online)
            test.runCurrent()
        }
        fun reader(record: String? = null, id: String = "s") = SessionReaderModel(auth, handle, store, id, test.backgroundScope, record, true)
    }
    private fun assertWithdrawn(reader: SessionReaderModel, context: String) {
        assertTrue("$context: session must be denied", reader.state.value.denied)
        assertTrue("$context: no records available for display/copy", reader.state.value.window.events.isEmpty())
        assertNull("$context: no stale authority", reader.state.value.session?.snapshot)
    }
    @Test fun ordinaryPageDenialWithdrawsEvenWhenRefreshFails() = runTest {
        for (status in listOf(403, 404)) for (direction in listOf("tail", "before", "after")) {
            val rig = Rig(this); val reader = rig.start()
            if (direction == "after") { reader.openRecord("record"); runCurrent() }
            reader.position(850, 19, false)
            rig.snapshotStatus = 503; rig.pageStatus = status
            when (direction) { "tail" -> reader.latest(); "before" -> reader.older(); else -> reader.newer() }
            runCurrent()
            assertWithdrawn(reader, "$direction $status then snapshot 503")
            reader.close(); runCurrent(); rig.restart(false)
            val restored = rig.reader(); runCurrent()
            assertWithdrawn(restored, "$direction $status offline return")
            restored.close(); rig.store.close()
        }
    }
    @Test fun ordinaryNetworkAndServerFailuresKeepStaleMessages() = runTest {
        for (offline in listOf(false, true)) {
            val rig = Rig(this); val reader = rig.start()
            val before = reader.state.value.window.events
            rig.snapshotStatus = 503; rig.pageStatus = 503; rig.pageOffline = offline
            reader.older(); runCurrent()
            assertFalse(reader.state.value.denied)
            assertEquals(before, reader.state.value.window.events)
            assertNotNull(reader.state.value.error)
            reader.close(); rig.store.close()
        }
    }
    @Test fun fullAndAroundExplicit403OrSession404Withdraw() = runTest {
        for (path in listOf("full", "around")) for (status in listOf(403, 404)) {
            val rig = Rig(this); val reader = rig.start()
            rig.recordStatus = status; rig.snapshotStatus = if (status == 404) 404 else 503
            if (path == "full") runCatching { reader.full(999) } else reader.openRecord("missing")
            runCurrent()
            assertWithdrawn(reader, "$path $status")
            reader.close(); rig.store.close()
        }
    }
    @Test fun missingRecord404DoesNotRevokeAnAuthorizedSessionOrInventDenialOffline() = runTest {
        for (path in listOf("full", "around")) for (authority in listOf(200, 503)) {
            val rig = Rig(this); val reader = rig.start()
            val before = reader.state.value.window.events
            rig.recordStatus = 404; rig.snapshotStatus = authority
            if (path == "full") runCatching { reader.full(999) } else reader.openRecord("missing")
            runCurrent()
            assertFalse("$path with authority $authority", reader.state.value.denied)
            assertEquals(before, reader.state.value.window.events)
            reader.close(); rig.store.close()
        }
    }
    @Test fun revocationInvalidatesEveryRecordRouteAndRejectsLateSaveAfterRestart() = runTest {
        val rig = Rig(this); val original = rig.start()
        original.position(850, 37, false); original.close(); runCurrent()
        val delayed = rig.reader(); runCurrent()
        val record = rig.reader("record"); runCurrent()
        record.position(150, 21, false)
        rig.snapshotStatus = 403; rig.store.refreshSession(); runCurrent()
        assertWithdrawn(record, "record route snapshot denial")
        rig.store.selectSession(null); runCurrent()
        // Closing an older route may race the route that revoked the session.
        delayed.position(860, 42, false); delayed.close(); record.close(); runCurrent()
        rig.restart(false)
        val restored = rig.reader(); runCurrent()
        assertWithdrawn(restored, "default route after store/process recreation")
        val restoredRecord = rig.reader("record"); runCurrent()
        assertWithdrawn(restoredRecord, "record route after store/process recreation")
        rig.snapshotStatus = 200; rig.store.setNetwork(true); runCurrent()
        assertFalse("online authority permits a fresh load", restored.state.value.denied)
        assertTrue(restored.state.value.window.events.isNotEmpty())
        assertNull("revoked old history was not restored", restored.state.value.targetSeq)
    }
    @Test fun revocationLeavesOtherSessionsAndAccountNamespacesAlone() = runTest {
        val rig = Rig(this); val original = rig.start()
        val foreign = AccountKey("https://foreign.test", "another-user") to "reader-s"
        rig.disk[foreign] = "another account's saved content".toByteArray()
        original.close(); runCurrent()
        rig.store.selectSession("other"); runCurrent()
        val other = rig.reader(id = "other"); runCurrent()
        other.position(850, 9, false); other.close(); runCurrent()
        rig.store.selectSession("s"); runCurrent()
        val target = rig.reader(); runCurrent()
        rig.snapshotStatus = 404; rig.store.refreshSession(); runCurrent()
        assertWithdrawn(target, "target only")
        assertEquals("another account's saved content", rig.disk.getValue(foreign).decodeToString())
        rig.store.setNetwork(false); rig.store.selectSession("other"); runCurrent()
        val otherRestored = rig.reader(id = "other"); runCurrent()
        assertFalse(otherRestored.state.value.denied)
        assertEquals(850L, otherRestored.state.value.targetSeq)
        assertTrue(otherRestored.state.value.window.events.isNotEmpty())
        // Auth namespace includes the server. Keep the disk and establish a different namespace.
        rig.snapshotStatus = 200
        rig.auth.login(ServerAddress.parse("https://second.test"), "a@example.test", "password")
        rig.restart(true)
        val secondAccount = rig.reader(); runCurrent()
        assertFalse(secondAccount.state.value.denied)
        assertTrue(secondAccount.state.value.window.events.isNotEmpty())
    }
    @Test fun olderResponseAlreadyInFlightCannotRepublishAfterRevocation() = runTest {
        val rig = Rig(this); val reader = rig.start()
        rig.held = CompletableDeferred()
        reader.older(); runCurrent()
        rig.snapshotStatus = 404; rig.store.refreshSession(); runCurrent()
        assertWithdrawn(reader, "snapshot revoked during page")
        rig.snapshotStatus = 503
        rig.held!!.complete(Unit); runCurrent()
        assertWithdrawn(reader, "late successful page")
        reader.close(); runCurrent(); rig.restart(false)
        val restored = rig.reader(); runCurrent()
        assertWithdrawn(restored, "late page never saved for reentry")
    }
    @Test fun lateFullOutputCannotBeReturnedForCopyAfterRevocation() = runTest {
        val rig = Rig(this); val reader = rig.start()
        rig.heldFull = CompletableDeferred()
        val copy = async { runCatching { reader.full(999) } }
        runCurrent()
        rig.snapshotStatus = 403; rig.store.refreshSession(); runCurrent()
        rig.heldFull!!.complete(Unit); runCurrent()
        assertTrue(copy.await().exceptionOrNull() is CancellationException)
        assertWithdrawn(reader, "late full response cannot copy")
    }
}
