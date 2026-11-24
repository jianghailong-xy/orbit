package io.orbitd.android

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import java.io.File
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
import org.robolectric.annotation.GraphicsMode

/**
 * The PROJECT_REOPEN request in the production shell (docs/project-reopen-request-design.md §6.2): on the real project page of a DONE
 * project its row sits above the header, and in the asking session's real conversation the card is drawn once. Reopen calls the
 * reopen-project route in both places. Shots land in `build/evidence/project-reopen-android/`. iOS `ProjectReopenViews.swift`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ProjectReopenShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    private val id = "01a0d6a9-d763-70e1-b4cf-8793e971b506"
    private val output = File("build/evidence/project-reopen-android").also { it.mkdirs() }
    private val request = """{"id":"$id","kind":"PROJECT_REOPEN","state":"PENDING","title":"Reopen project “Launch”?",
        "why":"The release checklist found the Android share sheet still opens the old screen.","askedBySessionId":"${ProjectShell.COORD}",
        "askedBySessionTitle":"Fix share target","projectId":"${ProjectShell.LAUNCH}","createdAt":"2026-11-24T08:00:00.000Z",
        "expiresAt":"2999-12-24T08:00:00.000Z","blocksTaskIds":[],
        "payload":{"projectId":"${ProjectShell.LAUNCH}","statusAtAsk":"DONE","settledAt":"2026-11-18T09:00:00.000Z",
        "plannedWork":"Add a criterion for the Android share target and one task to fix it.",
        "askers":[{"sessionId":"${ProjectShell.COORD}","title":"Fix share target"},{"sessionId":"s2","title":"Release check"}]}}"""

    @Before fun start() { ProjectShell.reset(); ProjectShell.done = true; ProjectShell.ownerRequests = "[$request]" }

    private fun tag(part: String = "") = hasTestTag("owner-request:$id$part")

    @Test fun theRowSitsAboveTheHeaderOfTheRealProjectPageAndReopenCallsTheRoute() {
        signIn(); open("orbit-project:${ProjectShell.LAUNCH}")
        await { exists(tag()) && exists(hasTestTag("project-status")) }
        val row = compose.onNode(tag()).fetchSemanticsNode().boundsInRoot
        val header = compose.onNodeWithTag("project-status").fetchSemanticsNode().boundsInRoot
        assertTrue("the row is above the header: $row / $header", row.bottom <= header.top)
        compose.onNode(tag(":row-label"), useUnmergedTree = true).assertTextEquals("An agent asked to reopen this project")
        compose.onNode(tag(":askers"), useUnmergedTree = true).assertTextEquals("Asked by Fix share target · Also asked by Release check")
        // The two buttons are full width and stacked, as iOS draws them.
        val reopen = compose.onNode(tag(":primary"), useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val chat = compose.onNode(tag(":chat"), useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("stacked: $reopen / $chat", chat.top >= reopen.bottom && reopen.left == chat.left && reopen.width == chat.width)
        shot("project-page")
        val reads = ProjectShell.calls.count { it == "GET projects/${ProjectShell.LAUNCH}" }
        compose.onNode(tag(":primary"), useUnmergedTree = true).performClick()
        await { ProjectShell.calls.any { it == "POST owner-requests/$id/reopen-project" } }
        // The answered request leaves Open, so its row goes; the page reads the project again and it is open.
        await { !exists(tag()) && ProjectShell.calls.count { it == "GET projects/${ProjectShell.LAUNCH}" } > reads }
        await { exists(hasTestTag("project-status")) && !exists(hasTestTag("project-status") and hasText("Completed")) }
        shot("project-page-reopened")
    }

    @Test fun theCardIsDrawnOnceInTheAskingSessionsRealConversation() {
        signIn(); open("orbit-session:${ProjectShell.COORD}")
        await { exists(tag()) }
        compose.onAllNodes(tag()).assertCountEquals(1)
        compose.onNode(tag(":title"), useUnmergedTree = true).assertTextEquals("↺ Reopen project “Launch”?")
        // Inside the asking session there is no "Asked by" line.
        compose.onNode(tag(":askers"), useUnmergedTree = true).assertTextEquals("Also asked by Release check")
        shot("transcript")
        compose.onNode(tag(":primary"), useUnmergedTree = true).performClick()
        await { ProjectShell.calls.any { it == "POST owner-requests/$id/reopen-project" } }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onAllNodes(isRoot()).printToString(maxDepth = Int.MAX_VALUE))
        val decor = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        decor.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ProjectShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = try { compose.waitUntil(60_000, condition) } catch (e: Throwable) {
        File(output, "failure-semantics.txt").writeText(ProjectShell.calls.joinToString("\n") + "\n\n" +
            compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString(maxDepth = Int.MAX_VALUE))
        throw e
    }
}
