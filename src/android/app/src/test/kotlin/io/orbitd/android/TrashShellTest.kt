package io.orbitd.android

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.directory.TrashingSessions
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A05-9 (iOS 62b7009ca): Move to Trash answers the press itself. The row leaves every list — and what the lists count — before the
 * request goes, and no read that lands before the move has settled puts it back. The toast comes as soon as the server has the move;
 * the row is held out until the lists have been read again behind it. A refusal brings it back at once, and so does an Undo. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = NavShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TrashShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = NavShell.reset()

    /** Gone from the list and from what the drawer counts with the server yet to answer; once it has, the toast at once, and the row
     * held out until the lists' re-read behind the move has landed. (A read that lands before the server has the move is the next
     * test's.) */
    @Test fun theRowLeavesTheListAndItsCountOnThePressAndIsHeldUntilTheReReadLands() {
        NavShell.running = setOf(NavShell.PLAIN)
        signIn(); openAlpha()
        await { exists(hasContentDescription("Options for Plain notes")) }
        // The drawer is composed while it is closed: its Alpha row counts the run.
        await { exists(hasText("Fixture runner · 1 running")) }
        val answer = CompletableDeferred<Unit>()
        NavShell.holdDelete = answer
        rowAction("Plain notes", "Move to Trash")
        await { NavShell.calls.any { it == "DELETE sessions/${NavShell.PLAIN}" } }
        compose.onAllNodesWithContentDescription("Options for Plain notes").assertCountEquals(0)
        compose.onAllNodesWithText("Fixture runner · 1 running").assertCountEquals(0)
        assertFalse(toastShows("Moved to Trash"))
        assertTrue("the server still has it", snapshotHasPlain())
        // The server takes the move: the toast at once, and the row held out while the lists are read again behind it.
        val behind = CompletableDeferred<Unit>()
        NavShell.holdOpen = behind
        val landed = openReads()
        answer.complete(Unit)
        await { toastShows("Moved to Trash") }
        await { openReads() > landed }
        assertEquals(setOf(TrashingSessions.key(NavShell.PLAIN)), app().trashing.ids.value)
        behind.complete(Unit)
        await { app().trashing.ids.value.isEmpty() }
        assertFalse(snapshotHasPlain())
        compose.onAllNodesWithContentDescription("Options for Plain notes").assertCountEquals(0)
    }

    /** The list offers Move to Trash only while the directory is fresh, so no read of it is on the wire at the press; the reads that
     * could bring the row back are the ones that leave after it and land before the server has the move. Here: two rows moved to
     * Trash one after the other, the first move's re-read leaving while the server has yet to take the second — it answers with that
     * row. The row stays out, and each is let go once a read behind its own move has landed. */
    @Test fun theReReadOfAMovePressedJustBeforeDoesNotBringTheNextRowBack() {
        signIn(); openAlpha()
        val first = CompletableDeferred<Unit>(); val second = CompletableDeferred<Unit>()
        NavShell.holdDeletes[NavShell.PLAIN] = first; NavShell.holdDeletes[NavShell.SESSION] = second
        rowAction("Plain notes", "Move to Trash")
        rowAction("Review navigation", "Move to Trash")
        await { NavShell.calls.any { it == "DELETE sessions/${NavShell.PLAIN}" } && NavShell.calls.any { it == "DELETE sessions/${NavShell.SESSION}" } }
        compose.onAllNodesWithContentDescription("Options for Plain notes").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Options for Review navigation").assertCountEquals(0)
        first.complete(Unit)
        await { toastShows("Moved to Trash") && app().trashing.ids.value == setOf(TrashingSessions.key(NavShell.SESSION)) }
        assertTrue("the first move's re-read had the second row in it", snapshotHas(NavShell.SESSION))
        assertFalse(snapshotHas(NavShell.PLAIN))
        compose.onAllNodesWithContentDescription("Options for Review navigation").assertCountEquals(0)
        second.complete(Unit)
        await { app().trashing.ids.value.isEmpty() }
        assertFalse(snapshotHas(NavShell.SESSION))
        compose.onAllNodesWithContentDescription("Options for Plain notes").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Options for Review navigation").assertCountEquals(0)
    }

    @Test fun aRefusedMoveBringsTheRowBackAtOnceAndSaysWhy() {
        signIn(); openAlpha()
        NavShell.refuse = 409 to "The session is busy."
        val answer = CompletableDeferred<Unit>()
        NavShell.holdDelete = answer
        rowAction("Plain notes", "Move to Trash")
        await { NavShell.calls.any { it == "DELETE sessions/${NavShell.PLAIN}" } }
        compose.onAllNodesWithContentDescription("Options for Plain notes").assertCountEquals(0)
        answer.complete(Unit)
        await { toastShows("Couldn't move to Trash") }
        compose.onNode(hasText("The session is busy.") and hasAnyAncestor(hasTestTag("toast"))).assertExists()
        await { exists(hasContentDescription("Options for Plain notes")) }
        assertTrue(app().trashing.ids.value.isEmpty())
    }

    /** Undo can come while the move's own re-read is still out: the row is let back on the press, before the restore is asked. */
    @Test fun undoLetsTheRowBackOnThePressEvenWhileTheMovesReadIsOut() {
        signIn(); openAlpha()
        await { exists(hasContentDescription("Options for Plain notes")) }
        val behind = CompletableDeferred<Unit>()
        NavShell.holdOpen = behind
        rowAction("Plain notes", "Move to Trash")
        await { toastShows("Undo") }
        assertFalse(app().trashing.ids.value.isEmpty())
        compose.onNode(hasText("Undo") and hasAnyAncestor(hasTestTag("toast"))).performClick()
        assertTrue(app().trashing.ids.value.isEmpty())
        await { NavShell.calls.any { it == "POST sessions/${NavShell.PLAIN}/restore" } }
        NavShell.holdOpen = null
        behind.complete(Unit)
        await { exists(hasContentDescription("Options for Plain notes")) }
        await { toastShows("Moved to Open") }
    }

    private fun openReads() = NavShell.calls.count { it == "GET sessions?view=open" }
    private fun snapshotHasPlain() = snapshotHas(NavShell.PLAIN)
    private fun snapshotHas(id: String) = app().realtime.state.value.directory?.sessions?.get("open").orEmpty()
        .any { it["id"]?.jsonPrimitive?.content == id }
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun toastShows(text: String) = exists(hasText(text) and hasAnyAncestor(hasTestTag("toast")))
    private fun rowAction(session: String, action: String) {
        await { exists(hasContentDescription("Options for $session")) }
        compose.onNodeWithContentDescription("Options for $session").performScrollTo().performClick()
        compose.onNode(hasText(action) and hasAnyAncestor(isDialog())).performScrollTo().performClick()
        compose.waitForIdle()
    }
    private fun alphaRow() = compose.onNode(hasText("Alpha") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab))
    private fun openDrawer() {
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.waitForIdle()
    }
    private fun openAlpha() { openDrawer(); alphaRow().performClick(); compose.waitForIdle() }
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { NavShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    /** A wait that idles the UI on every look — the store's coroutines run on the main looper, which a condition that reads only the
     * store or the fixture would never let run — and, timed out, says where the store and the fixture stood. */
    private fun await(condition: () -> Boolean) = try {
        compose.waitUntil(60_000) { compose.waitForIdle(); condition() }
    } catch (timeout: ComposeTimeoutException) {
        val live = app().realtime.state.value
        throw AssertionError("timed out: trashing=${app().trashing.ids.value} fresh=${live.directoryFresh} refreshing=${live.directoryRefreshing} " +
            "control=${live.controlConnection} error=${live.directoryError} open=${live.directory?.sessions?.get("open")?.map { it["id"] }} " +
            "calls=${NavShell.calls.takeLast(16)}", timeout)
    }
}
