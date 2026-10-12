package io.orbitd.android.watch

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** The watch calls hit the routes `watches.controller.ts` serves (OrbitKit `WatchAPIClientTests`), and the account's
 * store reads, re-reads and controls them as iOS `WatchesModel` does. Requests go through a real `AuthSession` to a
 * controlled `/api`. */
@OptIn(ExperimentalCoroutinesApi::class)
class WatchStoreTest {
    private val f = WatchFixture
    private val server = FakeWatchServer()

    private fun row(id: String, state: String, createdAt: String, deadLetter: String? = null): JsonObject {
        val deliveries = deadLetter?.let { listOf(JsonObject(f.delivery("DEAD_LETTER", attempts = 1, lastError = it) + ("id" to JsonPrimitive("$id-d")))) }.orEmpty()
        return f.json(id = id, state = state, action = "NOTIFY_USER", observer = null, createdAt = createdAt, targets = emptyList(),
            matches = if (state == "MATCHED") listOf(JsonObject(f.match(deliveries = deliveries) + ("id" to JsonPrimitive("$id-m")))) else emptyList(),
            lastEvaluatedAt = null)
    }

    @Test fun everyControlHitsItsRoute() = runTest {
        val body = f.json(id = "W1", state = "PAUSED", action = "NOTIFY_USER", observer = null).toString()
        server.respond = { call -> 200 to if (call.path == "/api/watches") "[$body]" else body }
        val client = WatchClient(server.auth, server.signIn())
        val listed = client.watches()
        client.watches(WatchState.ACTIVE)
        client.watch("W1")
        val paused = client.pauseWatch("W1")
        client.resumeWatch("W1")
        client.cancelWatch("W1")
        assertEquals(listOf("W1"), listed.map { it.id })
        assertEquals(WatchState.PAUSED, paused.state)
        assertEquals(listOf("GET /api/watches", "GET /api/watches?state=ACTIVE", "GET /api/watches/W1", "POST /api/watches/W1/pause",
            "POST /api/watches/W1/resume", "POST /api/watches/W1/cancel"), server.lines)
        // A control carries no body: the route names the watch and the move.
        assertTrue(server.calls.filter { it.method == "POST" }.all { it.body == null })
    }

    /** A hundred watches ended after the two that need attention, so the newest list holds neither of them: only the
     * read of its own keeps them on Needs attention, and a wake withdrawn before it ran stays in history. */
    @Test fun theFollowedListReadsTheLiveStatesTheNewestAndWhatNeedsAttention() = runTest {
        val newest = (0 until 99).map { row("E$it", "MATCHED", "2026-09-14T09:00:00.000Z") } +
            row("WITHDRAWN", "MATCHED", "2026-09-14T09:00:00.000Z", deadLetter = "WAKE_WITHDRAWN: the wake was withdrawn before a runner took it")
        val needing = listOf(row("R_OLD", "REVOKED", "2026-09-12T09:00:00.000Z"),
            row("D_OLD", "MATCHED", "2026-09-12T08:00:00.000Z", deadLetter = "PERMISSION_REVOKED: the observer session no longer belongs to the watch's owner"))
        server.respond = { call ->
            200 to when (call.query) {
                "state=ACTIVE", "state=PAUSED" -> "[]"
                "needsAttention=true" -> JsonArray(needing).toString()
                else -> JsonArray(newest).toString()
            }
        }
        val watches = WatchClient(server.auth, server.signIn()).followedWatches()
        assertEquals(listOf("GET /api/watches?state=ACTIVE", "GET /api/watches?state=PAUSED", "GET /api/watches", "GET /api/watches?needsAttention=true"),
            server.lines)
        val sections = WatchProjection.sections(watches, f.now)
        assertEquals(listOf("R_OLD", "D_OLD"), sections.first { it.group == WatchGroup.NEEDS_ATTENTION }.watches.map { it.id })
        assertEquals(100, sections.first { it.group == WatchGroup.HISTORY }.watches.size)
        assertNull(sections.firstOrNull { it.group == WatchGroup.ACTIVE })
    }

    /** The store reads through the four reads, keeps each watch once, and builds every observer's summary with it. */
    @Test fun aLoadAdoptsTheMergedListAndItsSummaries() = runTest {
        val active = f.json(id = "W1", observer = "S1", createdAt = f.ago(60))
        val paused = f.json(id = "W2", state = "PAUSED", observer = "S1", createdAt = f.ago(30))
        server.serve({ listOf(active, paused) })
        val store = WatchStore(server.auth, server.signIn(), backgroundScope)
        assertEquals(WatchLoadState(), store.state.value.loadState)
        store.load()
        assertEquals(listOf("W2", "W1"), store.state.value.watches.map { it.id })
        assertEquals(WatchLoadState(hasLoaded = true), store.state.value.loadState)
        assertEquals(listOf("W2", "W1"), store.summary("S1")!!.watches.map { it.id })
        assertEquals(4, server.calls.size)
        assertSame(store.watch("W1"), store.state.value.watches[1])
    }

    /** The list answering 404 is a server that predates watches: nothing to show or retry, so it isn't asked again. */
    @Test fun aListThatAnswers404IsAServerWithoutWatches() = runTest {
        server.respond = { 404 to """{"message":"Cannot GET /api/watches"}""" }
        val store = WatchStore(server.auth, server.signIn(), backgroundScope)
        store.load()
        assertTrue(store.state.value.unsupported)
        assertTrue(store.state.value.loadState.hasLoaded)
        assertFalse(store.state.value.loadState.lastLoadFailed)
        val before = server.calls.size
        store.load()
        store.refreshIfDue()
        assertEquals("no read once the server said it has no watches", before, server.calls.size)
    }

    /** One watch answering 404 is that watch gone — not a server without watches. */
    @Test fun aSingleWatchThatAnswers404IsNotFound() = runTest {
        server.serve({ listOf(f.json(id = "W1")) }, single = { id -> if (id == "OLD") 200 to f.json(id = "OLD", state = "MATCHED").toString() else null })
        val store = WatchStore(server.auth, server.signIn(), backgroundScope)
        store.load()
        store.fetch("GONE")
        assertNull(store.watch("GONE"))
        assertFalse(store.state.value.unsupported)
        assertEquals(listOf("W1"), store.state.value.watches.map { it.id })
        // An older watch the list doesn't hold is fetched on its own, and added at the front.
        store.fetch("OLD")
        assertEquals(listOf("OLD", "W1"), store.state.value.watches.map { it.id })
        assertEquals(listOf("GET /api/watches/GONE", "GET /api/watches/OLD"), server.lines.filter { it.startsWith("GET /api/watches/") })
    }

    /** A control adopts the watch the server answered with — what is drawn is what the server said. */
    @Test fun pauseResumeAndStopAdoptTheServersAnswer() = runTest {
        var state = "ACTIVE"
        server.serve({ listOf(f.json(id = "W1", state = state, observer = "S1")) }, control = { id, verb ->
            state = when (verb) { "pause" -> "PAUSED"; "resume" -> "ACTIVE"; "cancel" -> "CANCELLED"; else -> state }
            200 to f.json(id = id, state = state, observer = "S1").toString()
        })
        val store = WatchStore(server.auth, server.signIn(), backgroundScope)
        store.load()
        listOf(WatchControl.PAUSE to WatchState.PAUSED, WatchControl.RESUME to WatchState.ACTIVE, WatchControl.STOP to WatchState.CANCELLED).forEach { (control, expected) ->
            assertNull(store.perform(control, store.watch("W1")!!))
            assertEquals(expected, store.watch("W1")!!.state)
        }
        assertEquals(listOf("POST /api/watches/W1/pause", "POST /api/watches/W1/resume", "POST /api/watches/W1/cancel"),
            server.lines.filter { it.startsWith("POST") })
        // A stopped watch resumes nothing: its session's summary is gone with it.
        assertNull(store.summary("S1"))
        // View and Edit move nothing and send nothing.
        val before = server.calls.size
        assertNull(store.perform(WatchControl.VIEW, store.watch("W1")!!))
        assertNull(store.perform(WatchControl.EDIT, store.watch("W1")!!))
        assertEquals(before, server.calls.size)
    }

    /** A refusal usually means the watch moved on: the list is read again before the sentence is shown. */
    @Test fun aRefusedControlRereadsTheListAndSaysWhatTheServerSaid() = runTest {
        var state = "ACTIVE"
        server.serve({ listOf(f.json(id = "W1", state = state)) }, control = { _, _ ->
            state = "MATCHED"
            409 to """{"message":"a MATCHED watch cannot be paused","state":"MATCHED"}"""
        })
        val store = WatchStore(server.auth, server.signIn(), backgroundScope)
        store.load()
        val shown = store.watch("W1")!!
        server.calls.clear()
        assertEquals("Couldn't pause the watch — a MATCHED watch cannot be paused.", store.perform(WatchControl.PAUSE, shown))
        assertEquals(listOf("POST /api/watches/W1/pause", "GET /api/watches?state=ACTIVE", "GET /api/watches?state=PAUSED", "GET /api/watches",
            "GET /api/watches?needsAttention=true"), server.lines)
        assertEquals(WatchState.MATCHED, store.watch("W1")!!.state)
        // A dropped answer is read back the same way, never sent again.
        state = "ACTIVE"
        server.serve({ listOf(f.json(id = "W1", state = state)) }, control = { _, _ -> state = "PAUSED"; -1 to "" })
        server.calls.clear()
        assertEquals("Couldn't pause the watch — the connection dropped.", store.perform(WatchControl.PAUSE, store.watch("W1")!!))
        assertEquals(1, server.lines.count { it.startsWith("POST") })
        assertEquals(WatchState.PAUSED, store.watch("W1")!!.state)
        // A watch that is gone is gone, whatever the body says.
        server.serve({ emptyList() })
        assertEquals("Couldn't stop the watch — it no longer exists.", store.perform(WatchControl.STOP, store.watch("W1")!!))
        assertNull(store.watch("W1"))
    }

    /** A list read that started before a control's answer landed cannot take the answer back; one started after it
     * is the server's word. */
    @Test fun aControlsAnswerOutlivesAReadThatStartedBeforeIt() = runTest {
        var state = "ACTIVE"
        server.serve({ listOf(f.json(id = "W1", state = state)) }, control = { id, _ -> state = "PAUSED"; 200 to f.json(id = id, state = "PAUSED").toString() })
        val store = WatchStore(server.auth, server.signIn(), backgroundScope)
        store.load()
        val gate = CompletableDeferred<Unit>()
        server.hold = { call -> gate.takeIf { call.method == "GET" } }
        val stale = launch { store.load() }
        runCurrent()
        state = "ACTIVE" // what the read already in flight saw
        server.hold = { null }
        assertNull(store.perform(WatchControl.PAUSE, store.watch("W1")!!))
        assertEquals(WatchState.PAUSED, store.watch("W1")!!.state)
        state = "ACTIVE"
        gate.complete(Unit)
        stale.join()
        assertEquals("the older read keeps the answer", WatchState.PAUSED, store.watch("W1")!!.state)
        store.load()
        assertEquals("a read started after it is the server's word", WatchState.ACTIVE, store.watch("W1")!!.state)
    }

    /** A failed re-read keeps the rows on screen; only an empty list says the request failed. */
    @Test fun aFailedReadKeepsWhatWasShownAndOnlyAnEmptyListSaysSo() = runTest {
        var down = false
        server.respond = { call -> if (down) 503 to "{}" else 200 to (if (call.query == null) JsonArray(listOf(f.json(id = "W1"))).toString() else "[]") }
        val store = WatchStore(server.auth, server.signIn(), backgroundScope)
        store.load()
        down = true
        store.load()
        assertEquals(listOf("W1"), store.state.value.watches.map { it.id })
        assertTrue(store.state.value.loadState.lastLoadFailed)
        assertEquals(WatchListPresentation.CONTENT, watchListPresentation(store.state.value.loadState, store.state.value.watches.isEmpty()))
        assertEquals(WatchListPresentation.FAILED, watchListPresentation(store.state.value.loadState, true))
        assertEquals(WatchListPresentation.LOADING, watchListPresentation(store.state.value.loadState.begin(), true))
        assertEquals(WatchListPresentation.LOADING, watchListPresentation(WatchLoadState(), true))
        assertEquals(WatchListPresentation.EMPTY, watchListPresentation(WatchLoadState().succeed(), true))
    }

    /** An event that can move a target re-reads once for a burst, two seconds on — and not at all while nothing is
     * live, when no target can move. */
    @Test fun aNudgeRereadsOnceForABurstAndOnlyWhileSomethingIsLive() = runTest {
        var rows = listOf(f.json(id = "W1"))
        server.serve({ rows })
        val store = WatchStore(server.auth, server.signIn(), backgroundScope)
        store.load()
        server.calls.clear()
        repeat(3) { store.nudge() }
        advanceTimeBy(WatchStore.NUDGE_DELAY_MS - 1)
        runCurrent()
        assertEquals(0, server.calls.size)
        advanceTimeBy(2)
        runCurrent()
        assertEquals(4, server.calls.size)
        rows = listOf(f.json(id = "W1", state = "MATCHED"))
        store.load()
        server.calls.clear()
        store.nudge()
        advanceTimeBy(WatchStore.NUDGE_DELAY_MS * 2)
        runCurrent()
        assertEquals(0, server.calls.size)
    }

    /** The 30 s floor: a surface on screen asks often, the store reads at most every thirty seconds. */
    @Test fun theFloorReadsAtMostEveryThirtySeconds() = runTest {
        var clock = Instant.parse("2026-09-14T10:00:00Z")
        server.serve({ listOf(f.json(id = "W1")) })
        val store = WatchStore(server.auth, server.signIn(), backgroundScope, clock = { clock })
        store.refreshIfDue()
        assertEquals(4, server.calls.size)
        clock = clock.plusSeconds(10)
        store.refreshIfDue()
        assertEquals(4, server.calls.size)
        clock = clock.plusSeconds(21)
        store.refreshIfDue()
        assertEquals(8, server.calls.size)
    }

    /** The stream has no replay and no watch event: a reconnect re-reads the list. */
    @Test fun aReconnectRereadsTheList() = runTest {
        server.serve({ listOf(f.json(id = "W1")) })
        val store = WatchStore(server.auth, server.signIn(), backgroundScope)
        store.connection(true)
        runCurrent()
        assertEquals("the connection as first seen is no reconnect", 0, server.calls.size)
        store.connection(false)
        store.connection(true)
        runCurrent()
        assertEquals(4, server.calls.size)
        store.connection(true)
        runCurrent()
        assertEquals(4, server.calls.size)
    }

    /** One store per signed-in account; another account's store is dropped with its handle. */
    @Test fun oneStorePerSignedInHandle() = runTest {
        val handle = server.signIn()
        val store = WatchStore.of(server.auth, handle, backgroundScope)
        assertSame(store, WatchStore.of(server.auth, handle, backgroundScope))
        assertTrue(store.live())
        val next = server.signIn()
        assertFalse(store.live())
        assertNotSame(store, WatchStore.of(server.auth, next, backgroundScope))
    }
}
