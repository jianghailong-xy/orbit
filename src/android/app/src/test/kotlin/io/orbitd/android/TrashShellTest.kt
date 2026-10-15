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

    /** The list offers Move to Trash only while the directory is fresh, so no read of it is on the wire at the press; the reads that
     * could bring the row back are the ones that leave after it, before the server has the move — an account event's, or the
     * re-read of a move pressed just before. */
    @Test fun theRowLeavesOnThePressAndNoReadBeforeTheMoveSettlesBringsItBack() {
        NavShell.running = setOf(NavShell.PLAIN)
        signIn(); openAlpha()
        await { exists(hasContentDescription("Options for Plain notes")) }
        openDrawer(); await { exists(hasText("Fixture runner · 1 running")) }; closeDrawer()
        val answer = CompletableDeferred<Unit>()
        NavShell.holdDelete = answer
        rowAction("Plain notes", "Move to Trash")
        await { NavShell.calls.any { it == "DELETE sessions/${NavShell.PLAIN}" } }
        // Gone with the server yet to answer — from the list, and from what the drawer counts.
        compose.onAllNodesWithContentDescription("Options for Plain notes").assertCountEquals(0)
        openDrawer(); compose.onAllNodesWithText("Fixture runner · 1 running").assertCountEquals(0); closeDrawer()
        assertFalse(toastShows("Moved to Trash"))
        // A read that leaves before the server has the move answers with the row: the snapshot has it, no list draws it.
        val reads = openReads()
        app().realtime.refreshDirectory()
        await { openReads() > reads && !app().realtime.state.value.directoryRefreshing }
        assertTrue(snapshotHasPlain())
        compose.waitForIdle()
        compose.onAllNodesWithContentDescription("Options for Plain notes").assertCountEquals(0)
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

    /** Two rows moved to Trash one after the other: the first move's re-read leaves while the server has yet to take the second, and
     * answers with that row. It stays out, and each row is let go once a read behind its own move has landed. */
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
    /** Alpha's row is the destination showing: pressing it only closes the drawer (A05-8). */
    private fun closeDrawer() { alphaRow().performClick(); compose.waitForIdle() }
    private fun openAlpha() { openDrawer(); alphaRow().performClick(); compose.waitForIdle() }
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { NavShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
