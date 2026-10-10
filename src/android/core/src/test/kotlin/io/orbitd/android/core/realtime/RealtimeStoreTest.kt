package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RealtimeStoreTest {
    private class Connection(val request: HttpRequest) {
        val frames = Channel<SseFrame>(Channel.UNLIMITED)
        var closed = false
        suspend fun emit(json: String) { frames.send(SseFrame(json, null, null)) }
    }
    private class Streams : EventTransport {
        val all = mutableListOf<Connection>()
        override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) {
            val connection = Connection(request).also { all += it }
            try { onOpen(); for (frame in connection.frames) onFrame(frame) } finally { connection.closed = true }
        }
        fun session() = all.last { it.request.api.path.size > 1 }
        fun control() = all.last { it.request.api.path == listOf("events") }
    }
    private class Rig(val scope: TestScope) {
        val credentials = MemoryCredentials()
        val instances = MemoryInstances()
        val data = MemoryData()
        val streams = Streams()
        val reads = mutableListOf<HttpRequest>()
        var rows = listOf("""{"seq":1,"type":"user","payload":{"text":"initial"}}""")
        var pending = true
        var title = "original"
        var directoryError: Int? = null
        var detailError: Int? = null
        var project = false
        /** The server's own null: a 200 with no body, as `promotions/current` answers for a project asking nothing. */
        var emptyPromotion = false
        /** The project document's `startedAt` as raw JSON — `null` for a project nobody has started — or no document of its own. */
        var projectStartedAt: String? = null
        /** How `projects/p1/integration` answers. */
        var integrationStatus = 200
        var heldDirectory: CompletableDeferred<Unit>? = null
        var heldDetail: CompletableDeferred<Unit>? = null
        fun response(json: String) = ApiResponse(200, json.encodeToByteArray())
        fun client(dispatcher: CoroutineDispatcher = StandardTestDispatcher(scope.testScheduler)) = AuthSession(HttpTransport { request ->
            reads += request
            val path = request.api.path
            when {
                path == listOf("auth", "logout") -> response("{}")
                path.first() == "auth" -> response(Wire.json.encodeToString(io.orbitd.android.core.protocol.LoginResponse.serializer(), tokens("bob")))
                path == listOf("sessions") -> {
                    val captured = title
                    heldDirectory?.let { withContext(NonCancellable) { it.await() } }
                    directoryError?.let { return@HttpTransport ApiResponse(it, "{}".encodeToByteArray()) }
                    response("""[{"id":"s1","title":"$captured","status":"RUNNING","capabilities":{"canSend":true},"permissionMode":"safe"}]""")
                }
                path.size == 1 -> response("[]")
                path.last() == "page" -> {
                    val after = request.api.query.toMap()["after"]?.toLong()
                    val selected = rows.filter { after == null || Wire.decode(it.encodeToByteArray(), RunEvent.serializer()).seq > after }
                    response("""{"events":[${selected.joinToString()}],"hasMore":false,"after":null}""")
                }
                path == listOf("sessions", "s1") || path == listOf("sessions", "s2") -> {
                    val captured = detailError
                    heldDetail?.let { withContext(NonCancellable) { it.await() } }
                    captured?.let { return@HttpTransport ApiResponse(it, "{}".encodeToByteArray()) }
                    response("""{"id":"${path.last()}","status":"RUNNING"${if (project) ",\"taskId\":\"t1\",\"projectId\":\"p1\"" else ""}}""")
                }
                emptyPromotion && path.takeLast(2) == listOf("promotions", "current") -> ApiResponse(200, ByteArray(0))
                projectStartedAt != null && path == listOf("projects", "p1") -> response("""{"id":"p1","startedAt":$projectStartedAt}""")
                path == listOf("projects", "p1", "integration") -> if (integrationStatus != 200) ApiResponse(integrationStatus, "{}".encodeToByteArray())
                    else response("""{"repository":"acme/payments-api","upstreamRef":null,"lastMainBranch":{"branch":"master"}}""")
                path.last() in setOf("approvals", "turns", "background") ->
                    response(if (pending) """[{"id":"pending-card-marker","status":"PENDING"}]""" else "[]")
                else -> response(if (pending) """{"pending":[{"id":"standing-card-marker"}]}""" else "null")
            }
        }, credentials, instances, data, "test", dispatcher = dispatcher, eventTransport = streams)

        suspend fun start(): Pair<AuthSession, RealtimeStore> {
            credentials.value = StoredSession(serverA.value, tokens())
            instances.value = serverA.value
            val auth = client()
            auth.restore()
            val store = RealtimeStore(auth, scope.backgroundScope)
            store.selectSession("s1")
            store.setNetwork(true, "wifi")
            store.setForeground(true)
            scope.runCurrent()
            return auth to store
        }
    }

    @Test fun bothStreamsAndEveryNonReplayableReadRecoverOnForeground() = runTest {
        val rig = Rig(this)
        rig.project = true
        val (_, store) = rig.start()
        assertEquals(2, rig.streams.all.count { !it.closed })
        assertTrue(store.state.value.directoryFresh)
        assertTrue(store.state.value.session!!.fresh)
        assertEquals(1, store.state.value.session!!.snapshot!!.approvals.size)
        val paths = rig.reads.map { it.api.path.joinToString("/") }.toSet()
        assertTrue(paths.containsAll(setOf("sessions/s1/approvals", "sessions/s1/turns", "sessions/s1/background",
            "tasks/evidence-decisions/pending", "tasks/t1/owner-confirmation", "projects/p1/open-items",
            "projects/p1/acceptance/criteria-decisions/pending", "projects/p1/acceptance/confirmation",
            "projects/p1/promotions/current", "projects/p1")))
        store.setForeground(false)
        runCurrent()
        assertTrue(rig.streams.all.all { it.closed })
        assertFalse(store.state.value.session!!.fresh)
        rig.pending = false
        rig.title = "changed while backgrounded"
        store.setForeground(true)
        runCurrent()
        assertEquals(2, rig.streams.all.count { !it.closed })
        assertEquals("changed while backgrounded", store.state.value.directory!!.sessions["open"]!![0].text("title"))
        assertTrue(store.state.value.session!!.snapshot!!.approvals.isEmpty())
        assertTrue(store.state.value.session!!.snapshot!!.queuedTurns.isEmpty())
        assertTrue(store.state.value.session!!.snapshot!!.background.isEmpty())
        assertEquals("null", store.state.value.session!!.snapshot!!.standing["ownerConfirmation"].toString())
    }

    /** A project nobody has started has no promotion: the server's null for it is a read like any other, and the
     * conversation stays fresh with its cards (the coordinator's start request among them). */
    @Test fun aReadAnsweredWithNoBodyIsNullNotAFailedSnapshot() = runTest {
        val rig = Rig(this)
        rig.project = true; rig.pending = false; rig.emptyPromotion = true
        val (_, store) = rig.start()
        assertTrue(store.state.value.session!!.fresh)
        assertEquals(kotlinx.serialization.json.JsonNull, store.state.value.session!!.snapshot!!.standing["promotion"])
        assertTrue(rig.reads.any { it.api.path.joinToString("/") == "projects/p1/promotions/current" })
    }

    /** The start card's Main branch row is drawn from the project's integration read, which a project nobody has started reads with
     * its conversation — so the card is never drawn on main and then moved — and a started one does not read at all. */
    @Test fun anUnstartedProjectsConversationReadsItsIntegration() = runTest {
        val rig = Rig(this)
        rig.project = true; rig.pending = false; rig.projectStartedAt = "null"
        val (_, store) = rig.start()
        assertTrue(store.state.value.session!!.fresh)
        val read = store.state.value.session!!.snapshot!!.standing["integration"] as kotlinx.serialization.json.JsonObject
        assertEquals("acme/payments-api", (read["repository"] as kotlinx.serialization.json.JsonPrimitive).content)
    }

    @Test fun aStartedProjectsConversationDoesNotReadItsIntegration() = runTest {
        val rig = Rig(this)
        rig.project = true; rig.pending = false; rig.projectStartedAt = "\"2026-10-10T00:00:00Z\""
        val (_, store) = rig.start()
        assertTrue(store.state.value.session!!.fresh)
        assertNull(store.state.value.session!!.snapshot!!.standing["integration"])
        assertFalse(rig.reads.any { it.api.path == listOf("projects", "p1", "integration") })
    }

    /** A read of it that fails costs the conversation nothing: the snapshot is fresh without it, and the card draws no row. */
    @Test fun aFailedIntegrationReadLeavesTheConversationFresh() = runTest {
        val rig = Rig(this)
        rig.project = true; rig.pending = false; rig.projectStartedAt = "null"; rig.integrationStatus = 503
        val (_, store) = rig.start()
        assertTrue(store.state.value.session!!.fresh)
        assertTrue(rig.reads.any { it.api.path == listOf("projects", "p1", "integration") })
        assertNull(store.state.value.session!!.snapshot!!.standing["integration"])
    }

    @Test fun forbiddenAndMissingSessionWithdrawTranscriptAndCacheUntilAuthorityRecovers() = runTest {
        for (status in listOf(403, 404)) {
            val rig = Rig(this)
            val (auth, store) = rig.start()
            rig.detailError = status
            store.refreshSession(); runCurrent(); advanceTimeBy(101); runCurrent()
            assertTrue(store.state.value.session!!.accessDenied)
            assertNull(store.state.value.session!!.snapshot)
            assertTrue(store.state.value.session!!.transcript.events.isEmpty())
            rig.streams.session().emit("""{"seq":2,"type":"assistant","payload":{"text":"must stay hidden"}}""")
            runCurrent()
            assertTrue(store.state.value.session!!.transcript.events.isEmpty())
            val cache = RealtimeCache.read(auth, (auth.state.value as AuthState.SignedIn).handle)
            assertFalse(cache.sessions.containsKey("s1"))
            rig.detailError = null
            advanceTimeBy(1_001); runCurrent()
            assertFalse(store.state.value.session!!.accessDenied)
            assertTrue(store.state.value.session!!.fresh)
            assertEquals("initial", store.state.value.session!!.transcript.events.single().fields.text("text"))
            store.close(); runCurrent()
        }
    }

    @Test fun readDenialWithoutAReaderSurvivesColdAuthAndStoreRestoration() = runTest {
        val rig = Rig(this)
        val (auth, store) = rig.start()
        val handle = (auth.state.value as AuthState.SignedIn).handle
        store.selectSession(null); runCurrent()
        store.reportReadDenial(handle, "s1", ApiError.parse(403, "{}".toByteArray()))
        store.close(); runCurrent()
        val restoredAuth = rig.client()
        restoredAuth.restore()
        val restored = RealtimeStore(restoredAuth, backgroundScope)
        restored.selectSession("s1"); runCurrent()
        assertTrue(restored.state.value.session!!.accessDenied)
        assertTrue(restored.state.value.session!!.transcript.events.isEmpty())
        restored.setForeground(true); restored.setNetwork(true); runCurrent()
        assertFalse(restored.state.value.session!!.accessDenied)
        assertTrue(restored.state.value.session!!.fresh)
        assertEquals("initial", restored.state.value.session!!.transcript.events.single().fields.text("text"))
    }

    @Test fun readingCacheRevocationRejectsLateWritesButLeavesOtherScopesIntact() = runTest {
        val rig = Rig(this)
        val (auth, _) = rig.start()
        val handle = (auth.state.value as AuthState.SignedIn).handle
        val cache = ReadingCache(auth, handle, "s1")
        val other = ReadingCache(auth, handle, "s2")
        cache.write("reader-s1", 0, "default".toByteArray())
        cache.write("reader-s1-record", 0, "record".toByteArray())
        other.write("reader-s2", 0, "other".toByteArray())
        val denied = cache.revoke()
        assertNull(cache.read("reader-s1").second)
        assertNull(cache.read("reader-s1-record").second)
        cache.write("reader-s1", 0, "late write".toByteArray())
        assertEquals("other", other.read("reader-s2").second!!.decodeToString())
        cache.authorize(denied.revision)
        assertFalse(cache.valid(0))
        cache.write("reader-s1", 0, "late after recovery".toByteArray())
        assertEquals("default", cache.read("reader-s1").second!!.decodeToString())
        cache.write("reader-s1", denied.revision, "fresh".toByteArray())
        assertEquals("fresh", cache.read("reader-s1").second!!.decodeToString())
    }

    @Test fun authorityResponseStartedBeforeReadDenialCannotReleaseIt() = runTest {
        val rig = Rig(this)
        val (auth, store) = rig.start()
        rig.heldDetail = CompletableDeferred()
        store.refreshSession(); runCurrent()
        rig.detailError = 503
        store.reportReadDenial((auth.state.value as AuthState.SignedIn).handle, "s1", ApiError.parse(404, "{}".toByteArray()))
        val oldRequest = rig.heldDetail!!
        rig.heldDetail = null; oldRequest.complete(Unit); runCurrent()
        assertTrue(store.state.value.session!!.accessDenied)
        assertFalse(store.state.value.session!!.fresh)
        assertNull(store.state.value.session!!.snapshot)
        assertTrue(store.state.value.session!!.transcript.events.isEmpty())
    }

    @Test fun temporarySessionErrorRetainsOnlyStaleReadContent() = runTest {
        val rig = Rig(this)
        val (_, store) = rig.start()
        rig.detailError = 503
        store.refreshSession(); runCurrent()
        assertFalse(store.state.value.session!!.fresh)
        assertFalse(store.state.value.session!!.accessDenied)
        assertEquals("initial", store.state.value.session!!.transcript.events.single().fields.text("text"))
    }

    @Test fun processRestoreReplaysOverlapToRecoverMissingOutOfOrderDurableEvent() = runTest {
        val rig = Rig(this)
        val (_, store) = rig.start()
        rig.streams.session().emit("""{"seq":3,"type":"assistant","payload":{"text":"third"}}""")
        rig.streams.session().emit("""{"seq":0,"type":"text_delta","payload":{"text":"uncommitted animation"}}""")
        runCurrent()
        advanceTimeBy(101); runCurrent()
        assertEquals(1, store.state.value.session!!.transcript.resumeSeq)
        assertEquals(3, store.state.value.session!!.transcript.maxSeq)
        val persisted = rig.data.values.values.single().decodeToString()
        assertFalse(persisted.contains("uncommitted animation"))
        assertFalse(persisted.contains("pending-card-marker"))
        assertFalse(persisted.contains("standing-card-marker"))
        store.close(); runCurrent()
        rig.rows = rig.rows + listOf("""{"seq":2,"type":"assistant","payload":{"text":"late second"}}""",
            """{"seq":3,"type":"assistant","payload":{"text":"third"}}""")
        val auth2 = rig.client()
        auth2.restore()
        val restored = RealtimeStore(auth2, backgroundScope)
        runCurrent()
        assertNotNull(restored.state.value.directory)
        assertFalse(restored.state.value.directoryFresh)
        assertNull(restored.state.value.session!!.snapshot)
        assertTrue(restored.state.value.session!!.transcript.textDrafts.isEmpty())
        restored.setNetwork(true, "cellular"); restored.setForeground(true); runCurrent()
        assertEquals("1", rig.streams.session().request.api.query.toMap()["sinceSeq"])
        assertEquals(listOf(1L, 2L, 3L), restored.state.value.session!!.transcript.events.map { it.seq })
        assertEquals(3, restored.state.value.session!!.transcript.resumeSeq)
        rig.streams.session().emit(rig.rows[1]); runCurrent()
        assertEquals(3, restored.state.value.session!!.transcript.events.size)
    }

    @Test fun resyncDropsWindowAndSeedsTailBeforeUsingNewCursor() = runTest {
        val rig = Rig(this)
        val (_, store) = rig.start()
        rig.rows = listOf("""{"seq":2001,"type":"assistant","payload":{"text":"latest tail"}}""")
        rig.streams.session().emit("""{"type":"resync","seq":0,"payload":{}}""")
        runCurrent()
        assertTrue(store.state.value.session!!.transcript.events.isEmpty())
        advanceTimeBy(1001); runCurrent()
        assertEquals("2001", rig.streams.session().request.api.query.toMap()["sinceSeq"])
        assertEquals(listOf(2001L), store.state.value.session!!.transcript.events.map { it.seq })
    }

    @Test fun openingPingCannotResetRepeatedResyncBackoff() = runTest {
        val rig = Rig(this)
        rig.start()
        suspend fun rejectWindow() {
            rig.streams.session().emit("""{"type":"ping","seq":0}""")
            rig.streams.session().emit("""{"type":"resync","seq":0}""")
            runCurrent()
        }
        rejectWindow()
        advanceTimeBy(1001); runCurrent()
        val connections = rig.streams.all.size
        rejectWindow()
        advanceTimeBy(1100); runCurrent()
        assertEquals(connections, rig.streams.all.size)
        advanceTimeBy(1000); runCurrent()
        assertEquals(connections + 1, rig.streams.all.size)
    }

    @Test fun accountEventsAreCountedByTypeAndTheConnectIsCounted() = runTest {
        val rig = Rig(this)
        val (_, store) = rig.start()
        assertEquals(1L, store.state.value.controlConnects)
        assertEquals(emptyMap<String, Long>(), store.state.value.accountEvents)
        listOf("wiki.changed", "session.updated", "wiki.changed", "ping").forEach { type ->
            rig.streams.control().emit("""{"type":"$type","sessionId":"","data":{}}""")
        }
        runCurrent()
        assertEquals("pings are not account events", mapOf("wiki.changed" to 2L, "session.updated" to 1L), store.state.value.accountEvents)
    }

    @Test fun emptySessionIdNudgesRefetchAndDirectoryErrorRetainsRows() = runTest {
        val rig = Rig(this)
        val (_, store) = rig.start()
        val revision = store.state.value.invalidationRevision
        rig.directoryError = 403
        rig.streams.control().emit("""{"type":"folder.changed","sessionId":"","data":{"id":"f1"}}""")
        runCurrent()
        assertTrue(store.state.value.invalidationRevision > revision)
        assertFalse(store.state.value.directoryFresh)
        assertEquals(403, store.state.value.directoryError!!.httpStatus)
        assertEquals(ConnectionState.CONNECTED, store.state.value.controlConnection)
        assertEquals("original", store.state.value.directory!!.sessions["open"]!![0].text("title"))
        rig.directoryError = null
        rig.title = "new"
        advanceTimeBy(1001); runCurrent()
        assertTrue(store.state.value.directoryFresh)
        assertEquals("new", store.state.value.directory!!.sessions["open"]!![0].text("title"))
    }

    @Test fun defaultNetworkIdentityChangesReconnectEvenWithoutOfflineTransition() = runTest {
        val rig = Rig(this)
        val (_, store) = rig.start()
        val previous = rig.streams.all.toList()
        store.setNetwork(true, "cellular"); runCurrent()
        assertTrue(previous.all { it.closed })
        assertEquals(2, rig.streams.all.count { !it.closed })
        val size = rig.streams.all.size
        store.setNetwork(true, "cellular"); runCurrent()
        assertEquals(size, rig.streams.all.size)
        store.setNetwork(false); runCurrent()
        advanceTimeBy(60_000); runCurrent()
        assertEquals(size, rig.streams.all.size)
        assertTrue(rig.streams.all.all { it.closed })
    }

    @Test fun oldFocusEventsCannotRepopulateTheNewSession() = runTest {
        val rig = Rig(this)
        val (_, store) = rig.start()
        val old = rig.streams.session()
        store.selectSession("s2"); runCurrent()
        old.emit("""{"seq":99,"type":"assistant","payload":{"text":"wrong session"}}"""); runCurrent()
        assertTrue(old.closed)
        assertEquals("s2", store.state.value.session!!.id)
        assertFalse(store.state.value.session!!.transcript.events.any { it.seq == 99L })
    }

    @Test fun logoutClearsCacheAndLateRestResponseCannotPublishOrWrite() = runTest {
        val rig = Rig(this)
        val (auth, store) = rig.start()
        advanceTimeBy(101); runCurrent()
        assertTrue(rig.data.values.isNotEmpty())
        val held = CompletableDeferred<Unit>()
        rig.heldDirectory = held
        store.refreshDirectory(); runCurrent()
        auth.logout(); runCurrent()
        held.complete(Unit); runCurrent()
        advanceTimeBy(200); runCurrent()
        assertNull(store.state.value.handle)
        assertNull(store.state.value.directory)
        assertNull(store.state.value.session)
        assertTrue(rig.data.values.isEmpty())
        assertTrue(rig.streams.all.all { it.closed })
    }

    @Test fun accountAndServerSwitchFenceOldEventsRestAndCache() = runTest {
        for (server in listOf(serverA, serverB)) {
            val rig = Rig(this)
            val (auth, store) = rig.start()
            advanceTimeBy(101); runCurrent()
            val oldHandle = store.state.value.handle!!
            val oldStreams = rig.streams.all.toList()
            val held = CompletableDeferred<Unit>()
            rig.heldDirectory = held
            store.refreshDirectory(); runCurrent()
            val next = auth.login(server, "bob@example.test", "fixture-password")
            rig.heldDirectory = null
            rig.title = "new account only"
            held.complete(Unit)
            runCurrent()
            store.selectSession("s2"); runCurrent()
            oldStreams.last().emit("""{"seq":99,"type":"assistant","payload":{"text":"old account secret"}}""")
            advanceTimeBy(201); runCurrent()
            assertNotSame(oldHandle, next)
            assertSame(next, store.state.value.handle)
            assertTrue(oldStreams.all { it.closed })
            assertEquals("new account only", store.state.value.directory!!.sessions["open"]!![0].text("title"))
            assertEquals("s2", store.state.value.session!!.id)
            assertFalse(store.state.value.session!!.transcript.events.any { it.seq == 99L })
            assertFalse(rig.data.values.values.any { it.decodeToString().contains("old account secret") })
            assertTrue(runCatching { auth.readData(oldHandle, DataKind.CACHE, "realtime-v1") }.isFailure)
            assertNotNull(auth.readData(next, DataKind.CACHE, "realtime-v1"))
            store.close(); auth.logout(); runCurrent()
        }
    }

    @Test fun conflatedAccountSwitchDoesNotCarryThePreviousSelectionIntoNewCache() = runTest {
        for (server in listOf(serverA, serverB)) {
            val rig = Rig(this)
            rig.credentials.value = StoredSession(serverA.value, tokens())
            rig.instances.value = serverA.value
            val auth = rig.client(UnconfinedTestDispatcher(testScheduler))
            auth.restore()
            val old = auth.state.value as AuthState.SignedIn
            val store = RealtimeStore(auth, backgroundScope)
            store.selectSession("s1"); runCurrent()
            assertEquals("s1", store.state.value.session!!.id)
            val next = auth.login(server, "bob@example.test", "fixture-password")
            // No collector turn occurred between the old and new SignedIn values.
            assertSame(old.handle, store.state.value.handle)
            runCurrent(); advanceTimeBy(201); runCurrent()
            assertSame(next, store.state.value.handle)
            assertNull(RealtimeCache.read(auth, next).lastSessionId)
            assertNull(store.state.value.session)
            assertTrue(RealtimeCache.read(auth, next).sessions.isEmpty())
            store.close(); auth.logout(); runCurrent()
        }
    }

    @Test fun pendingLoginDeepLinkAndExplicitNewHandleSelectionWinOverRestore() = runTest {
        val rig = Rig(this)
        val auth = rig.client(UnconfinedTestDispatcher(testScheduler))
        auth.restore()
        val store = RealtimeStore(auth, backgroundScope)
        // An explicit deep link can arrive before the store observes SignedOut.
        store.selectSession("s1"); runCurrent()
        val first = auth.login(serverA, "bob@example.test", "fixture-password")
        runCurrent()
        assertSame(first, store.state.value.handle)
        assertEquals("s1", store.state.value.session?.id)
        val next = auth.login(serverB, "bob@example.test", "fixture-password")
        store.selectSession("s2") // New handle is already current, collector has not caught up.
        runCurrent(); advanceTimeBy(201); runCurrent()
        assertSame(next, store.state.value.handle)
        assertEquals("s2", store.state.value.session?.id)
        assertEquals("s2", RealtimeCache.read(auth, next).lastSessionId)
    }

    @Test fun corruptOrVersionedCacheRestoresAsColdOpen() = runTest {
        val rig = Rig(this)
        val (auth, store) = rig.start()
        store.close(); runCurrent()
        val handle = (auth.state.value as AuthState.SignedIn).handle
        for (bad in listOf("{broken", """{"schema":999}""",
            """{"sessions":{"s1":{"resumeSeq":9007199254740991}}}""")) {
            auth.writeData(handle, DataKind.CACHE, "realtime-v1", bad.encodeToByteArray())
            assertEquals(RealtimeCache(), RealtimeCache.read(auth, handle))
        }
    }
}
