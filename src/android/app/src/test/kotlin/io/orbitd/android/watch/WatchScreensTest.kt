package io.orbitd.android.watch

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.ui.OrbitTheme
import io.orbitd.android.wiki.PageBar
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/** Following, a watch's page and the session's Watching strip, composed over a real store reading a controlled
 * `/api`: the sections and placeholders, the controls each state offers and Stop's confirmation, and the strip's
 * read-only rows. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class WatchScreensTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val f = WatchFixture
    private val server = FakeWatchServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val opened = mutableListOf<OrbitRoute>()
    private val titles: (String?) -> String? = { id -> if (id == "S1") "Coordinator" else if (id == "S7") "Review the contract" else null }

    @After fun close() { scope.cancel() }

    private fun store(): WatchStore = WatchStore(server.auth, runBlocking { server.signIn() }, scope)

    private fun iso(secondsFromNow: Long) = Instant.now().plusSeconds(secondsFromNow).toString()

    /** A watch as the server sends it now: looked at 20 s ago, made ten minutes ago, an hour left. */
    private fun row(id: String, state: String = "ACTIVE", action: String = "RESUME_SESSION", observer: String? = "S1",
        predicate: JsonObject = f.all("TASK_TERMINAL"), targets: List<JsonObject> = f.tasks(2), matches: List<JsonObject> = emptyList(),
        lookedSecondsAgo: Long? = 20) = f.json(id = id, state = state, action = action, observer = observer, predicate = predicate,
        targets = targets, matches = matches, lastEvaluatedAt = lookedSecondsAgo?.let { iso(-it) }, createdAt = iso(-600), expiresAt = iso(3_600))

    private fun show(content: @Composable () -> Unit) {
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme { content() } } }
        compose.waitForIdle()
    }

    private fun load(store: WatchStore) {
        compose.runOnIdle { scope.launch { store.load() } }
        compose.waitUntil(5_000) { store.state.value.loadState.hasLoaded && !store.state.value.loadState.loading }
    }

    private fun await(tag: String) = compose.waitUntil(5_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    private fun awaitText(text: String) = compose.waitUntil(5_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }

    /** The page with the shell's bar above it, where iOS puts the record's controls. */
    private fun detail(store: WatchStore, id: () -> String) = show {
        val route = OrbitRoute(Destination.WATCH, id())
        Column {
            Row { PageBar.Actions(route, this) }
            WatchDetailScreen(store, route, id(), titles) { opened += it }
        }
    }

    // MARK: the entry points other screens call

    /** `WatchDestination` is Following without an id and the watch's page with one, and `SessionWatches` draws
     * nothing while nothing will resume the session — over the signed-in account's one store. */
    @Test fun theEntryPointsShareTheAccountsStore() {
        val app = compose.activity.application as OrbitApplication
        compose.waitUntil(5_000) { app.session.state.value is AuthState.SignedOut }
        val handle = runBlocking { app.session.login(ServerAddress.parse("https://fixture.test"), "a@example.test", "fixture-password") }
        var route by mutableStateOf(OrbitRoute(Destination.WATCH))
        show {
            Column {
                Box(Modifier.weight(1f)) { WatchDestination(app, handle, route) { opened += it } }
                SessionWatches(app, handle, "S1") { opened += it }
            }
        }
        await("following-empty")
        compose.onAllNodesWithTag("session-watches").assertCountEquals(0)
        compose.runOnIdle { route = OrbitRoute(Destination.WATCH, ObjectId.canonical("34TcwNgAIo6tGUiIKjqnQ")) }
        await("watch-not-found")
        val store = WatchStore.of(app.session, handle, app.processScope)
        assertTrue(store.state.value.loadState.hasLoaded)
    }

    // MARK: Following

    @Test fun followingFilesEveryWatchUnderItsSection() {
        val rows = listOf(row("A1"), row("N1", state = "REVOKED"), row("H1", state = "MATCHED"))
        server.serve({ rows })
        val store = store()
        show { FollowingScreen(store, OrbitRoute(Destination.WATCH), titles) { opened += it } }
        await("following-row:H1")
        val order = listOf("following-section:NEEDS_ATTENTION", "following-row:N1", "following-section:ACTIVE", "following-row:A1",
            "following-section:HISTORY", "following-row:H1").map { compose.onNodeWithTag(it).fetchSemanticsNode().positionInRoot.y }
        assertEquals("the sections in display order, each over its own rows", order.sorted(), order)
        compose.onNodeWithTag("following-section:NEEDS_ATTENTION").assertTextEquals("Needs attention")
        compose.onNodeWithTag("following-section:ACTIVE").assertTextEquals("Active")
        compose.onNodeWithTag("following-section:HISTORY").assertTextEquals("History")
        compose.onNodeWithTag("following-row:N1").assertTextContains("Access revoked", substring = true)
            .assertTextContains("Stopped: access to its targets was revoked", substring = true)
        compose.onNodeWithTag("following-row:A1").assertTextContains("Watching 2 targets", substring = true)
            .assertTextContains("0 of 2 finished", substring = true).assertTextContains("All tasks finish", substring = true)
            .assertTextContains("Resume Coordinator · Last evaluated just now", substring = true)
        compose.onNodeWithTag("following-row:H1").assertTextContains("Matched", substring = true)
            .assertTextContains("Resume Coordinator · 10m ago", substring = true)
        assertEquals("Following", PageBar.title(OrbitRoute(Destination.WATCH)))
        assertEquals(listOf("GET /api/watches?state=ACTIVE", "GET /api/watches?state=PAUSED", "GET /api/watches", "GET /api/watches?needsAttention=true"),
            server.lines)
    }

    @Test fun aFollowingRowOpensItsWatch() {
        server.serve({ listOf(row("A1")) })
        val store = store()
        show { FollowingScreen(store, OrbitRoute(Destination.WATCH), titles) { opened += it } }
        await("following-row:A1")
        compose.onNodeWithTag("following-row:A1").assertHasClickAction().performClick()
        assertEquals(listOf(OrbitRoute(Destination.WATCH, "A1")), opened)
    }

    @Test fun followingSaysLoadingThenThatNothingIsFollowedOnlyAfterAnAnswer() {
        val gate = CompletableDeferred<Unit>()
        server.serve({ emptyList() })
        server.hold = { gate }
        val store = store()
        show { FollowingScreen(store, OrbitRoute(Destination.WATCH), titles) {} }
        await("following-loading")
        compose.onAllNodesWithTag("following-empty").assertCountEquals(0)
        compose.runOnIdle { server.hold = { null }; gate.complete(Unit) }
        await("following-empty")
        compose.onNodeWithText("Not following anything").assertIsDisplayed()
        compose.onNodeWithText("When you or an agent watches sessions or tasks, the watch shows up here: what it waits for, how far along it is, and what happens when it holds.")
            .assertIsDisplayed()
    }

    @Test fun aFailedReadOffersRetryAndRetryReadsAgain() {
        var down = true
        server.respond = { call -> if (down) 503 to "{}" else 200 to (if (call.query == null) JsonArray(listOf(row("A1"))).toString() else "[]") }
        val store = store()
        show { FollowingScreen(store, OrbitRoute(Destination.WATCH), titles) {} }
        await("following-failed")
        compose.onNodeWithText("Watches couldn't be loaded").assertIsDisplayed()
        compose.onNodeWithText("Check the connection, then try again.").assertIsDisplayed()
        down = false
        compose.onNodeWithTag("following-retry").performClick()
        await("following-row:A1")
        compose.onAllNodesWithTag("following-failed").assertCountEquals(0)
    }

    @Test fun aServerWithoutWatchesSaysSoAndOffersNoRetry() {
        server.respond = { 404 to "{}" }
        val store = store()
        show { FollowingScreen(store, OrbitRoute(Destination.WATCH), titles) {} }
        await("following-unsupported")
        compose.onNodeWithText("Watches aren't available").assertIsDisplayed()
        compose.onNodeWithText("This server doesn't serve watches yet.").assertIsDisplayed()
        compose.onAllNodesWithText("Retry").assertCountEquals(0)
    }

    // MARK: a watch's page

    @Test fun activeOffersPauseAndStopThenPausedOffersResumeAndStop() {
        var state = "ACTIVE"
        server.serve({ listOf(row("W1", state = state)) }, control = { id, verb ->
            state = if (verb == "pause") "PAUSED" else if (verb == "resume") "ACTIVE" else state
            200 to row(id, state = state).toString()
        })
        val store = store()
        load(store)
        detail(store) { "W1" }
        await("watch:W1:WATCH_PAUSE")
        compose.onNodeWithTag("watch:W1:WATCH_PAUSE").assertTextEquals("Pause")
        compose.onNodeWithTag("watch:W1:WATCH_CANCEL").assertTextEquals("Stop")
        compose.onAllNodesWithTag("watch:W1:WATCH_RESUME").assertCountEquals(0)
        compose.onAllNodesWithText("Edit").assertCountEquals(0)
        assertEquals("Watching 2 targets", PageBar.title(OrbitRoute(Destination.WATCH, "W1")))
        compose.onNodeWithTag("watch:W1:WATCH_PAUSE").performClick()
        await("watch:W1:WATCH_RESUME")
        compose.onNodeWithTag("watch:W1:WATCH_RESUME").assertTextEquals("Resume")
        compose.onNodeWithTag("watch:W1:WATCH_CANCEL").assertIsEnabled()
        compose.onAllNodesWithTag("watch:W1:WATCH_PAUSE").assertCountEquals(0)
        assertEquals("Paused · 2 targets", PageBar.title(OrbitRoute(Destination.WATCH, "W1")))
        compose.onNodeWithTag("watch:W1:WATCH_RESUME").performClick()
        await("watch:W1:WATCH_PAUSE")
        assertEquals(listOf("POST /api/watches/W1/pause", "POST /api/watches/W1/resume"), server.lines.filter { it.startsWith("POST") })
    }

    @Test fun anEndedWatchOffersNoControls() {
        val ended = listOf("MATCHED", "EXPIRED", "CANCELLED", "REVOKED", "UNRESOLVABLE", "SNOOZED")
        server.serve({ ended.map { row("E-$it", state = it) } })
        val store = store()
        load(store)
        var id by mutableStateOf("E-MATCHED")
        detail(store) { id }
        ended.forEach { state ->
            compose.runOnIdle { id = "E-$state" }
            await("watch-detail:E-$state")
            listOf("WATCH_PAUSE", "WATCH_RESUME", "WATCH_CANCEL").forEach { compose.onAllNodesWithTag("watch:E-$state:$it").assertCountEquals(0) }
            compose.onAllNodesWithText("Pause").assertCountEquals(0)
            compose.onAllNodesWithText("Stop").assertCountEquals(0)
        }
    }

    @Test fun stopAsksFirstAndOnlyAConfirmedStopIsSent() {
        var state = "ACTIVE"
        server.serve({ listOf(row("W1", state = state)) }, control = { id, verb ->
            if (verb == "cancel") state = "CANCELLED"
            200 to row(id, state = state).toString()
        })
        val store = store()
        load(store)
        detail(store) { "W1" }
        await("watch:W1:WATCH_CANCEL")
        compose.onNodeWithTag("watch:W1:WATCH_CANCEL").performClick()
        compose.onNodeWithText("Stop watching?").assertIsDisplayed()
        compose.onNodeWithText("The waiting session won't be resumed, and it isn't told the watch stopped.").assertIsDisplayed()
        compose.onNodeWithTag("watch-stop-cancel").assertTextEquals("Cancel").performClick()
        compose.onAllNodesWithText("Stop watching?").assertCountEquals(0)
        assertTrue(server.lines.none { it.startsWith("POST") })
        compose.onNodeWithTag("watch:W1:WATCH_CANCEL").performClick()
        compose.onNodeWithTag("watch-stop-confirm").assertTextEquals("Stop").performClick()
        compose.waitUntil(5_000) { store.watch("W1")?.state == WatchState.CANCELLED }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("watch:W1:WATCH_CANCEL").fetchSemanticsNodes().isEmpty() }
        assertEquals(listOf("POST /api/watches/W1/cancel"), server.lines.filter { it.startsWith("POST") })
        assertEquals("Stopped", PageBar.title(OrbitRoute(Destination.WATCH, "W1")))
    }

    @Test fun aNotifyWatchsStopSaysNobodyWillBeNotified() {
        server.serve({ listOf(row("W1", action = "NOTIFY_USER", observer = null)) })
        val store = store()
        load(store)
        detail(store) { "W1" }
        await("watch:W1:WATCH_CANCEL")
        compose.onNodeWithTag("watch:W1:WATCH_CANCEL").performClick()
        compose.onNodeWithText("You won't be notified when the condition holds.").assertIsDisplayed()
    }

    @Test fun aRefusedControlRereadsAndSaysWhatTheServerSaid() {
        var state = "ACTIVE"
        server.serve({ listOf(row("W1", state = state)) }, control = { _, _ ->
            state = "MATCHED"
            409 to """{"message":"a MATCHED watch cannot be paused","state":"MATCHED"}"""
        })
        val store = store()
        load(store)
        detail(store) { "W1" }
        await("watch:W1:WATCH_PAUSE")
        compose.onNodeWithTag("watch:W1:WATCH_PAUSE").performClick()
        await("watch-error")
        compose.onNodeWithTag("watch-error").assertTextEquals("Couldn't pause the watch — a MATCHED watch cannot be paused.")
        // Read again: it matched, so it offers nothing now.
        compose.onAllNodesWithTag("watch:W1:WATCH_PAUSE").assertCountEquals(0)
        compose.onAllNodesWithTag("watch:W1:WATCH_CANCEL").assertCountEquals(0)
        assertEquals("Matched", PageBar.title(OrbitRoute(Destination.WATCH, "W1")))
        assertEquals(1, server.lines.count { it.startsWith("POST") })
    }

    @Test fun aDeepLinkedWatchTheListDoesNotHoldIsFetchedBeforeItIsCalledMissing() {
        val publicId = "34TcwNgAIo6tGUiIKjqnQ"
        val uuid = ObjectId.canonical(publicId)!!
        server.serve({ emptyList() }, single = { id -> if (id == uuid) 200 to row(publicId, state = "MATCHED").toString() else null })
        val store = store()
        load(store)
        var id by mutableStateOf(uuid)
        detail(store) { id }
        await("watch-detail:$publicId")
        assertTrue(server.lines.contains("GET /api/watches/$uuid"))
        assertEquals("Matched", PageBar.title(OrbitRoute(Destination.WATCH, uuid)))
        compose.runOnIdle { id = "GONE" }
        await("watch-not-found")
        compose.onNodeWithText("Watch not found").assertIsDisplayed()
        compose.onNodeWithText("It may have been deleted, or this server doesn't serve watches.").assertIsDisplayed()
        assertTrue(server.lines.contains("GET /api/watches/GONE"))
    }

    @Test fun thePageReadsTheWholeRecordAndOpensTargetsThatStillExist() {
        val targets = listOf(f.target("S7", kind = "SESSION", state = "SATISFIED"), f.target("T1", title = "Fix the login redirect"),
            f.target("T2", state = "GONE"))
        val matches = listOf(f.match(deliveries = listOf(f.delivery("DEAD_LETTER", lastError = "OBSERVER_SESSION_ENDED: ended"))))
        val predicate = f.composite("ANY_OF", f.all("TASK_TERMINAL"), f.all("SESSION_TURN_SETTLED"))
        server.serve({ listOf(row("W1", state = "MATCHED", predicate = predicate, targets = targets, matches = matches)) })
        val store = store()
        load(store)
        detail(store) { "W1" }
        await("watch-detail:W1")
        listOf("Progress", "1 of 2 met · 1 gone", "Condition", "All tasks finish, or all sessions finish their turn", "When it holds",
            "Resume Coordinator", "Freshness", "Last evaluated just now", "Delivery", "Delivery failed: OBSERVER_SESSION_ENDED: ended").forEach { awaitText(it) }
        compose.onNodeWithTag("watch-attention").assertExists()
        compose.onNodeWithTag("watch-detail:W1").performScrollToNode(hasTestTag("watch-target:S7"))
        compose.onNodeWithTag("watch-target:S7").assertTextContains("Review the contract", substring = true).assertTextContains("Met", substring = true)
        compose.onNodeWithTag("watch-target:S7").performClick()
        compose.onNodeWithTag("watch-detail:W1").performScrollToNode(hasTestTag("watch-target:T1"))
        compose.onNodeWithTag("watch-target:T1").assertTextContains("Fix the login redirect", substring = true).performClick()
        compose.onNodeWithTag("watch-detail:W1").performScrollToNode(hasTestTag("watch-target:T2"))
        compose.onNodeWithTag("watch-target:T2").assertTextContains("Deleted", substring = true).assertHasNoClickAction()
        assertEquals(listOf(OrbitRoute(Destination.SESSION, "S7", origin = Origin.LINK), OrbitRoute(Destination.TASK, "T1", origin = Origin.LINK)), opened)
        compose.onNodeWithTag("watch-detail:W1").performScrollToNode(hasText("ALL TASK_TERMINAL 2/2"))
        compose.onNodeWithText("History").assertExists()
        compose.onNodeWithText("ALL TASK_TERMINAL 2/2").assertIsDisplayed()
    }

    // MARK: the Watching strip

    @Test fun theStripStaysAwayWhileNothingLiveWillResumeTheSession() {
        server.serve({ listOf(row("N1", action = "NOTIFY_USER", observer = null), row("M1", state = "MATCHED"), row("O1", observer = "S9")) })
        val store = store()
        load(store)
        show { WatchingCardStack(store, "S1", titles) { opened += it } }
        compose.onAllNodesWithTag("session-watches").assertCountEquals(0)
    }

    @Test fun aLoneTargetIsNamedWithWhereItStandsAndTheStripIsReadOnly() {
        val target = f.target("T1", title = "Fix the login redirect", status = f.status("IN_PROGRESS", running = true))
        server.serve({ listOf(row("W1", targets = listOf(target))) })
        val store = store()
        load(store)
        show { WatchingCardStack(store, ObjectId.canonical("S1") ?: "S1", titles) { opened += it } }
        await("session-watches")
        compose.onNodeWithTag("watch-strip-line").assertTextContains("Watching", substring = true)
            .assertTextContains("Fix the login redirect", substring = true).assertTextContains("Running", substring = true)
        listOf("Pause", "Resume", "Stop", "Edit").forEach { compose.onAllNodesWithText(it).assertCountEquals(0) }
        // A watch is not a process: nothing here borrows the Background processes tray's words.
        compose.onAllNodesWithText("Background", substring = true, ignoreCase = true).assertCountEquals(0)
        // Opened, the lone target is a row of its own, and its row is the way to it.
        compose.onNodeWithTag("watch-strip-line").performClick()
        await("watch-strip-target:W1:T1")
        compose.onNodeWithTag("watch-strip-target:W1:T1").performClick()
        assertEquals(listOf(OrbitRoute(Destination.TASK, "T1", origin = Origin.LINK)), opened)
        compose.onNodeWithTag("watch-strip-line").performClick()
        compose.onAllNodesWithTag("watch-strip-target:W1:T1").assertCountEquals(0)
    }

    @Test fun severalTargetsSayWhatTheWaitNeedsAndOpenToTheirRowsMetFirst() {
        val targets = listOf(f.target("T1", title = "Schema", status = f.status("DONE")),
            f.target("T2", title = "Service", status = f.status("IN_PROGRESS", running = true)),
            f.target("T3", title = "Clients", state = "SATISFIED", status = f.status("DONE")),
            f.target("T4", title = "Docs", status = f.status("FAILED")),
            f.target("T5", title = "Old", state = "GONE"))
        server.serve({ listOf(row("W1", targets = targets, lookedSecondsAgo = 720)) })
        val store = store()
        load(store)
        show { WatchingCardStack(store, "S1", titles) { opened += it } }
        await("session-watches")
        compose.onNodeWithTag("watch-strip-line").assertTextContains("all 4 tasks", substring = true)
            .assertTextContains("1 running · 1 failed · 2/4 done", substring = true)
        compose.onNodeWithTag("watch-strip-line").performClick()
        await("watch-strip-target:W1:T3")
        compose.onNodeWithTag("watch-strip-stale:W1").assertTextEquals("Not checked for 12m — the resume may be late.")
        val order = listOf("T3", "T1", "T2", "T4").map { compose.onNodeWithTag("watch-strip-target:W1:$it").fetchSemanticsNode().positionInRoot.y }
        assertEquals("what the condition has met first, then the watch's own order", order.sorted(), order)
        compose.onAllNodesWithTag("watch-strip-target:W1:T5").assertCountEquals(0)
        compose.onNodeWithTag("watch-strip-target:W1:T2").assertTextContains("Service", substring = true).assertTextContains("Running", substring = true)
    }

    @Test fun aSessionTargetIsNamedByTheTitleThisClientHolds() {
        val target = f.target("S7", kind = "SESSION", status = f.status("AWAITING_INPUT"))
        server.serve({ listOf(row("W1", targets = listOf(target), predicate = f.all("SESSION_TURN_SETTLED"))) })
        val store = store()
        load(store)
        show { WatchingCardStack(store, "S1", titles) { opened += it } }
        await("session-watches")
        compose.onNodeWithTag("watch-strip-line").assertTextContains("Review the contract", substring = true)
            .assertTextContains("Waiting for your reply", substring = true)
        compose.onNodeWithTag("watch-strip-line").performClick()
        await("watch-strip-target:W1:S7")
        compose.onNodeWithTag("watch-strip-target:W1:S7").performClick()
        assertEquals(listOf(OrbitRoute(Destination.SESSION, "S7", origin = Origin.LINK)), opened)
    }
}
