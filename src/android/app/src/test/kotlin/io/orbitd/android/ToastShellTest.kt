package io.orbitd.android

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A05-4 (iOS 86661c204, d625d9809, 627989805): one toast host under the shell's bar. A confirmation is a pill for three
 * seconds, an outcome with an Undo or a diagnostic a card for six, and a failure a tinted card pinned until it is dealt
 * with; a toast naming a session is the way into it; one operation is one toast. Session row actions and the worktree
 * bar's merges report through it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = NavShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ToastShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = NavShell.reset()

    @Test fun completingASessionIsACardWithUndoForSixSeconds() {
        signIn(); openAlpha()
        rowAction("Plain notes", "Complete")
        await { toastShows("Session completed") }
        toast("Plain notes").assertExists()
        toast("Undo").assertExists()
        compose.mainClock.advanceTimeBy(3_500)
        assertTrue("a card stays six seconds", toastShows("Session completed"))
        compose.mainClock.advanceTimeBy(3_000)
        await { !toastShows("Session completed") }
    }

    @Test fun undoMovesTheSessionBackToOpenAndThatIsAPillForThreeSeconds() {
        signIn(); openAlpha()
        rowAction("Plain notes", "Complete")
        await { toastShows("Undo") }
        toast("Undo").performClick()
        await { NavShell.calls.any { it == "POST sessions/${NavShell.PLAIN}/restore" } }
        await { toastShows("Moved to Open") }
        assertTrue("Undo took the card down", !toastShows("Session completed"))
        compose.mainClock.advanceTimeBy(3_500)
        await { !toastShows("Moved to Open") }
    }

    @Test fun movingToTrashIsAToastWithUndoRatherThanADialog() {
        signIn(); openAlpha()
        rowAction("Plain notes", "Move to Trash")
        await { toastShows("Moved to Trash") }
        toast("Undo").assertExists()
        compose.onAllNodesWithText("Plain notes is in Trash.").assertCountEquals(0)
    }

    @Test fun aFailureIsPinnedWithTheServersWordsUntilItIsDismissed() {
        signIn(); openAlpha()
        NavShell.refuse = 409 to "The session is busy."
        rowAction("Plain notes", "Complete")
        await { toastShows("Couldn't complete the session") }
        toast("The session is busy.").assertExists()
        toast("Copy error").assertExists()
        // Nothing takes it away on a timer: after six seconds it folds into a pill, still saying what failed.
        compose.mainClock.advanceTimeBy(20_000)
        compose.waitForIdle()
        assertTrue(toastShows("Couldn't complete the session"))
        toast("Couldn't complete the session").performClick()
        await { compose.onAllNodes(hasContentDescription("Dismiss") and hasAnyAncestor(hasTestTag("toast"))).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasContentDescription("Dismiss") and hasAnyAncestor(hasTestTag("toast"))).performClick()
        await { !toastShows("Couldn't complete the session") }
    }

    @Test fun aToastNamingASessionOpensIt() {
        signIn(); openAlpha()
        rowAction("Plain notes", "Complete")
        await { toastShows("Session completed") }
        toast("Session completed").performClick()
        await { compose.onAllNodesWithTag("transcript-list").fetchSemanticsNodes().isNotEmpty() }
        assertTrue("following it takes it down", !toastShows("Session completed"))
    }

    @Test fun aMergesResultIsAToastNamingItsSession() {
        signIn()
        open("orbit-session:${NavShell.PLAIN}")
        await { compose.onAllNodesWithText("Merge to main").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Merge to main").performClick()
        await { toastShows("Merged into main") }
        toast("Plain notes").assertExists()
    }

    @Test fun aMergeConflictIsPinnedAndResolvedInTheSessionFromTheToast() {
        NavShell.mergeAnswer = "conflict"
        signIn()
        open("orbit-session:${NavShell.PLAIN}")
        await { compose.onAllNodesWithText("Merge to main").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Merge to main").performClick()
        await { toastShows("Couldn't merge into main") }
        toast("CONFLICT (content): notes.md").assertExists()
        toast("Resolve in session").performClick()
        await { NavShell.calls.any { it == "POST sessions/${NavShell.PLAIN}/resume" } }
    }

    private fun toast(text: String) = compose.onNode(hasText(text) and hasAnyAncestor(hasTestTag("toast")))
    private fun toastShows(text: String) = compose.onAllNodes(hasText(text) and hasAnyAncestor(hasTestTag("toast"))).fetchSemanticsNodes().isNotEmpty()
    private fun rowAction(session: String, action: String) {
        await { compose.onAllNodesWithContentDescription("Options for $session").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Options for $session").performScrollTo().performClick()
        compose.onNode(hasText(action) and hasAnyAncestor(isDialog())).performScrollTo().performClick()
        compose.waitForIdle()
    }
    private fun openAlpha() {
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.onNode(hasText("Alpha") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)).performClick()
        compose.waitForIdle()
    }
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { NavShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    /** A link as Android delivers one to the running Activity; the launch intent is put back for ActivityScenario. */
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
