package io.orbitd.android

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A05-3 (iOS d2858a5e8): the session page's ⋯ in the bar replaces its Share button — Share… / Copy Link; Rename… /
 * Pin / Move… / Tags…; Open Task or Open Project for a session one of them runs; Complete Session or Move to Open; Move
 * to Trash. A trashed session offers only Move to Open and, asked first, Delete Permanently; what would stop a live run
 * says so. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = NavShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SessionMenuTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = NavShell.reset()

    @Test fun aTasksOpenSessionOffersIosItemsInIosOrder() {
        NavShell.ended = setOf(NavShell.SESSION)
        signIn(); open("orbit-session:${NavShell.SESSION}")
        menu()
        assertEquals(listOf("Share…", "Copy Link", "Rename…", "Pin", "Move…", "Tags…", "Open Task", "Complete Session", "Move to Trash"), items())
        assertTrue("an ended run has nothing to stop", compose.onAllNodes(hasText("Stops the current run")).fetchSemanticsNodes().isEmpty())
        compose.onAllNodesWithContentDescription("Share session").assertCountEquals(0)
    }

    @Test fun aSessionInNoTaskOrProjectHasNoOpenItem() {
        signIn(); open("orbit-session:${NavShell.PLAIN}")
        menu()
        assertEquals(listOf("Share…", "Copy Link", "Rename…", "Pin", "Move…", "Tags…", "Complete Session", "Move to Trash"), items())
    }

    @Test fun whatWouldStopALiveRunSaysSo() {
        NavShell.running = setOf(NavShell.SESSION)
        signIn(); open("orbit-session:${NavShell.SESSION}")
        menu()
        listOf("Complete Session", "Move to Trash").forEach { item ->
            compose.onNode(hasText(item) and hasText("Stops the current run") and hasAnyAncestor(isPopup())).assertExists()
        }
    }

    @Test fun copyLinkCopiesTheSignedInAddressAndSaysSo() {
        signIn(); open("orbit-session:${NavShell.SESSION}")
        menu()
        item("Copy Link").performClick()
        val clip = (compose.activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.getItemAt(0)?.text?.toString()
        assertEquals("https://a05c.test/sessions/${NavShell.SESSION}", clip)
        await { compose.onAllNodes(hasText("Link copied") and hasAnyAncestor(hasTestTag("toast"))).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun aCompletedSessionOffersMoveToOpen() {
        NavShell.lifecycle = NavShell.lifecycle + (NavShell.SESSION to "COMPLETED")
        signIn(); open("orbit-session:${NavShell.SESSION}")
        menu()
        assertEquals(listOf("Share…", "Copy Link", "Rename…", "Pin", "Move…", "Tags…", "Open Task", "Move to Open", "Move to Trash"), items())
    }

    @Test fun aTrashedSessionOffersMoveToOpenAndDeletePermanentlyAskedFirst() {
        NavShell.lifecycle = NavShell.lifecycle + (NavShell.SESSION to "TRASH")
        signIn(); open("orbit-session:${NavShell.SESSION}")
        menu()
        assertEquals(listOf("Move to Open", "Delete Permanently"), items())
        item("Delete Permanently").performClick()
        compose.onNodeWithText("Delete permanently?").assertExists()
        compose.onNodeWithText("This session and its full transcript will be permanently deleted. This can't be undone.").assertExists()
        assertTrue("nothing is deleted before it is confirmed", NavShell.calls.none { it.startsWith("DELETE") })
    }

    @Test fun openTaskOpensTheTaskOverTheSession() {
        signIn(); open("orbit-session:${NavShell.SESSION}")
        menu()
        item("Open Task").performClick()
        await { compose.onAllNodesWithTag("task-assignee").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Back").assertExists()
    }

    @Test fun completingFromTheMenuLeavesThePageAndOffersUndo() {
        signIn(); open("orbit-session:${NavShell.PLAIN}")
        menu()
        item("Complete Session").performClick()
        await { NavShell.calls.any { it == "POST sessions/${NavShell.PLAIN}/complete" } }
        await { compose.onAllNodes(hasText("Session completed") and hasAnyAncestor(hasTestTag("toast"))).fetchSemanticsNodes().isNotEmpty() }
        await { compose.onAllNodesWithTag("transcript-list").fetchSemanticsNodes().isEmpty() }
        compose.onNode(hasText("Undo") and hasAnyAncestor(hasTestTag("toast"))).assertExists()
    }

    private fun menu() {
        await { compose.onAllNodes(hasContentDescription("Session actions") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Session actions").performClick()
        compose.waitForIdle()
    }
    private fun items() = compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
    private fun item(text: String) = compose.onNode(hasText(text) and hasAnyAncestor(isPopup()) and hasClickAction())
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
