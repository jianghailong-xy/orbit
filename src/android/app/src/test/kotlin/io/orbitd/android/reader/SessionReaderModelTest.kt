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

@OptIn(ExperimentalCoroutinesApi::class)
class SessionReaderModelTest {
    private class Rig(val test: TestScope) {
        val saved = mutableMapOf<String, ByteArray>()
        val calls = mutableListOf<ApiRequest>()
        var held: CompletableDeferred<Unit>? = null
        var aroundMissing = false
        private fun rows(first: Int, last: Int) = (first..last).map { RunEvent("assistant", it.toLong(), buildJsonObject { put("text", "Record $it") }) }
        val auth = AuthSession(HttpTransport { request ->
            val api = request.api; calls += api
            val data = when {
                api.path.first() == "auth" -> """{"accessToken":"access","refreshToken":"refresh","user":{"id":"u","email":"a@example.test","name":"A"}}"""
                api.path == listOf("sessions", "s") -> """{"id":"s","status":"RUNNING"}"""
                api.path.last() == "page" -> {
                    val query = api.query.toMap()
                    val page = when {
                        "before" in query -> {
                            held?.let { withContext(NonCancellable) { it.await() } }
                            val end = query.getValue("before").toInt() - 1
                            EventPage(rows(maxOf(1, end-199), end), end > 200)
                        }
                        "around" in query -> {
                            if (aroundMissing) return@HttpTransport ApiResponse(404, "{}".toByteArray())
                            EventPage(rows(100, 299), true, 299, 100, RecordAnchor("event", "record", 180))
                        }
                        "after" in query -> EventPage(emptyList())
                        else -> EventPage(rows(801, 1000), true)
                    }
                    Wire.json.encodeToString(EventPage.serializer(), page)
                }
                else -> "[]"
            }
            ApiResponse(200, data.toByteArray())
        }, object : CredentialStore {
            var value: StoredSession? = null
            override suspend fun load() = value
            override suspend fun save(session: StoredSession) { value = session }
            override suspend fun clear() { value = null }
        }, object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) { }
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String) = saved[key]
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) { saved[key] = bytes }
            override suspend fun clearAll() { saved.clear() }
        }, "test", dispatcher = StandardTestDispatcher(test.testScheduler), eventTransport = object : EventTransport {
            override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) { onOpen(); awaitCancellation() }
        })
        lateinit var store: RealtimeStore
        val handle get() = (auth.state.value as AuthState.SignedIn).handle
        suspend fun start(): SessionReaderModel {
            auth.login(ServerAddress.parse("https://fixture.test"), "a@example.test", "password")
            store = RealtimeStore(auth, test.backgroundScope)
            store.selectSession("s"); store.setForeground(true); store.setNetwork(true)
            test.runCurrent()
            return reader().also { test.runCurrent() }
        }
        fun reader(record: String? = null) = SessionReaderModel(auth, handle, store, "s", test.backgroundScope, record)
    }
    @Test fun bookmarkRestoresHistoryOfflineBySequenceAndOffset() = runTest {
        val rig = Rig(this); val reader = rig.start()
        reader.position(850, 37, false); reader.older(); runCurrent()
        assertEquals(601L, reader.state.value.window.events.first().seq)
        reader.close(); runCurrent()
        rig.store.setNetwork(false); runCurrent()
        val before = rig.calls.size
        val restored = rig.reader(); runCurrent()
        assertEquals(850L, restored.state.value.targetSeq)
        assertEquals(37, restored.state.value.targetOffset)
        assertFalse(restored.following)
        assertTrue(restored.state.value.window.events.any { it.seq == 850L })
        assertEquals(before, rig.calls.size)
    }
    @Test fun oneOlderRequestAndLateResponseCannotReplaceJumpToLatest() = runTest {
        val rig = Rig(this); val reader = rig.start()
        rig.held = CompletableDeferred()
        reader.position(801, -20, false)
        reader.older(); runCurrent(); reader.older(); runCurrent()
        assertEquals(1, rig.calls.count { it.query.any { q -> q.first == "before" } })
        reader.latest(); runCurrent()
        rig.held!!.complete(Unit); runCurrent()
        assertEquals(801L, reader.state.value.window.events.first().seq)
        assertTrue(reader.following)
        assertFalse(reader.state.value.loading)
    }
    @Test fun metadataOnlyBookmarkLoadsItsSequenceInsteadOfSubstitutingLatest() = runTest {
        val rig = Rig(this); rig.start().close(); runCurrent()
        val cacheKey = rig.saved.keys.single { it.startsWith("reader-") }
        rig.saved[cacheKey] = Wire.json.encodeToString(ReadingBookmark.serializer(), ReadingBookmark(42, 13, false)).toByteArray()
        val restored = rig.reader(); runCurrent()
        assertEquals(42L, restored.state.value.targetSeq)
        assertEquals(13, restored.state.value.targetOffset)
        assertTrue(restored.state.value.window.events.any { it.seq == 42L })
        assertEquals(42L, restored.state.value.window.newerAfter)
        assertTrue(rig.calls.any { it.query.contains("before" to "43") })
    }
    @Test fun aroundRecordDetachesUntilNewerOrLatestAndMissingTargetKeepsMessages() = runTest {
        val rig = Rig(this); val reader = rig.start()
        reader.openRecord("record"); runCurrent()
        assertEquals(180L, reader.state.value.targetSeq)
        assertEquals(299L, reader.state.value.window.newerAfter)
        assertFalse(reader.following)
        rig.aroundMissing = true
        reader.openRecord("wrong"); runCurrent()
        assertEquals("That message is not in this session", reader.state.value.error)
        assertEquals(100L, reader.state.value.window.events.first().seq)
        assertFalse(reader.state.value.denied)
    }
}
