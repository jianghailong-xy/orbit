package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.taskprojects.SharePanel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The pool page and the share panel over the controlled server: what they say after a failed read, and what they offer each role. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class ManagementPanelTest {
    /** The compose rule's host activity is not in the app's manifest; Robolectric resolves it once it is registered. */
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    private val fixture = ManagementFixture
    private var revision by mutableLongStateOf(0L)

    @Before fun start() { fixture.reset() }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
    private fun pool(record: String) {
        val api = api()
        compose.setContent { ProviderManagement(api, revision, record, {}, {}) }
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun reread() { revision++; compose.waitForIdle() }

    @Test fun aFailedPeopleReadKeepsWhoCanUseThePoolAndSaysItFailed() {
        pool("own:${fixture.POOL}")
        await("Me and 1 person")
        fixture.accessFails = true
        reread()
        compose.waitUntil(60_000) { fixture.calls.count { it == "GET providers/shared-pools/${fixture.POOL}" } >= 2 }
        // The fixture sees the read when it is asked; the failed answer reaches the page on a real thread, later on a loaded host.
        await("pool read failed")
        compose.onNodeWithText("Me and 1 person", substring = true).assertExists()
        // Not said to be the owner's alone: no "Just me ·" line, and the owner's mode switch is not on Just me.
        compose.onAllNodesWithText("Just me ·", substring = true).assertCountEquals(0)
        compose.onAllNodes(hasText("Just me") and isSelected()).assertCountEquals(0)
        compose.onNodeWithText("pool read failed", substring = true).assertExists()
    }

    @Test fun aPoolWhosePeopleWereNeverReadIsNotCalledJustMineAndCannotBeDeletedBlind() {
        fixture.accessFails = true
        pool("own:${fixture.POOL}")
        await("Team Codex")
        compose.waitForIdle()
        compose.onAllNodesWithText("Just me", substring = true).assertCountEquals(0)
        compose.onNodeWithText("pool read failed", substring = true).assertExists()
        compose.onNode(hasText("Delete pool") and hasClickAction()).performScrollTo().assertIsNotEnabled()
    }

    @Test fun aMemberTheRuleLeavesOutIsNotOfferedSignInAgain() {
        fixture.viewerRole = "MEMBER"; fixture.viewerCreates = false; fixture.loginState = "SIGNED_OUT"
        fixture.membersCanAddAccounts = false
        pool("shared:${fixture.POOL}")
        await("Team Codex")
        compose.waitForIdle()
        compose.onAllNodes(hasText("Sign in again") and hasClickAction() and isEnabled()).assertCountEquals(0)
    }

    @Test fun aMemberWhoMayAddAccountsButNotKeysIsNotOfferedAKey() {
        fixture.viewerRole = "MEMBER"; fixture.viewerCreates = false
        fixture.membersCanAddAccounts = true; fixture.membersCanAdd = false
        pool("shared:${fixture.POOL}")
        await("Team Codex")
        compose.onNode(hasText("Add account") and hasClickAction()).performClick()
        compose.waitForIdle()
        compose.onAllNodesWithText("Paste an OpenAI API key").assertCountEquals(0)
    }

    @Test fun anAdminWhoDidNotMakeThePoolIsNotOfferedALeaveTheServerRefuses() {
        fixture.viewerRole = "ADMIN"; fixture.viewerCreates = false
        pool("shared:${fixture.POOL}")
        await("Team Codex")
        compose.onNode(hasText("Leave pool") and hasClickAction()).performScrollTo().assertIsNotEnabled()
    }

    @Test fun editModeMovesARunnerByDraggingItsHandleAndSendsTheOrderOnce() {
        fixture.secondRunner = true
        val api = api()
        compose.setContent { RunnersList(api, revision) {} }
        await("Spare box")
        compose.onNode(hasText("Edit") and hasClickAction()).performClick()
        // The row merges its handle ("≡", at its right edge) into one node; the drag starts on the handle.
        compose.onNodeWithContentDescription("Reorder Old alias").assert(hasCustomAction("Move down")).performTouchInput {
            down(centerRight - androidx.compose.ui.geometry.Offset(8f, 0f))
            repeat(30) { moveBy(androidx.compose.ui.geometry.Offset(0f, 20f)) }
            up()
        }
        // The fixture notes the call before it takes the new order: wait for the order itself.
        compose.waitUntil(60_000) { fixture.runnerOrder == listOf(fixture.RUNNER_TWO, fixture.RUNNER) }
        compose.waitForIdle()
        assertEquals("One order goes out per drag", 1, fixture.calls.count { it == "POST runners/reorder" })
    }

    private fun hasCustomAction(label: String) = SemanticsMatcher("has custom action $label") { node ->
        node.config.getOrNull(SemanticsActions.CustomActions)?.any { action -> action.label == label } == true
    }

    @Test fun aShareRefreshThatFailsStopsWritesAndOffersRetry() {
        val api = api()
        compose.setContent { ShareResourcePanel(api, revision, "SESSION", fixture.SESSION) }
        await("Tool calls and output")
        compose.onNode(hasText("Only you") and isSelectable()).assertIsEnabled()
        fixture.shareFails = true
        reread()
        compose.waitUntil(60_000) { fixture.calls.count { it == "GET sessions/${fixture.SESSION}/share" } >= 2 }
        // The fixture sees the read when it is asked; the failed answer reaches the panel on a real thread, later on a loaded host.
        await("share read failed")
        compose.onNodeWithText("share read failed", substring = true).assertExists()
        compose.onNode(hasText("Retry") and hasClickAction()).assertExists()
        compose.onAllNodes(hasText("Only you") and isSelectable() and isEnabled()).assertCountEquals(0)
    }

    /** A page that hosts the panel (a task's or a project's ⋯ → Share…) hears the server's answer to each read and change,
     * in the shape its menu reads: what the menu then says is what the server last said. */
    @Test fun theSharePanelReportsEachAnswerInTheShapeTheMenuReads() {
        val api = api()
        val answers = mutableListOf<JsonObject>()
        compose.setContent { ShareResourcePanel(api, revision, "SESSION", fixture.SESSION) { answers += it } }
        await("Tool calls and output")
        compose.onNode(hasText("Only you") and isSelectable()).performClick()
        compose.onNode(hasText("Turn off") and hasClickAction()).performClick()
        compose.waitUntil(60_000) { answers.size >= 2 }
        compose.onNode(hasText("Anyone with the link") and isSelectable()).performClick()
        compose.waitUntil(60_000) { answers.size >= 3 }
        compose.waitForIdle()
        assertEquals(listOf("GET", "DELETE", "PUT"), fixture.calls.filter { it.endsWith("sessions/${fixture.SESSION}/share") }.map { it.substringBefore(' ') })
        assertEquals(listOf("Live link", "Only you", "Live link"), answers.map(SharePanel::menuStatus))
        assertEquals("The read's counts stay with every answer", 3, answers.count { it["counts"] is JsonObject })
    }

    /**
     * At twice the font size (and with a long pool name) a button or a chip keeps its words on one line: what does not
     * fit beside the others moves down whole. Seen on the emulator at 200%: Turn off one letter per line, Share Link…
     * broken, the SHARED chip upright. Real text measurement needs Robolectric's native graphics.
     */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) fun atTwiceTheFontSizeNoButtonOrChipBreaksItsWords() {
        val api = api()
        fixture.poolLabel = "Team Codex for the whole studio"
        var page by mutableStateOf("links")
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = 2f)) {
                when (page) {
                    "links" -> SharingSettings(api, revision)
                    "share" -> ShareResourcePanel(api, revision, "SESSION", fixture.SESSION)
                    else -> ProviderManagement(api, revision, null, {}, {})
                }
            }
        }
        val broken = mutableListOf<String>()
        await("Turn off"); listOf("Copy Link", "Share Link…", "Turn off").forEach { broken += lines(it) }
        page = "share"; await("Tool calls and output"); listOf("Copy Link", "Share Link…").forEach { broken += lines(it) }
        page = "providers"; await("SHARED"); broken += lines("SHARED")
        assertEquals("Broken across lines at 200%", emptyList<String>(), broken)
    }

    /** "<text>: N lines" for each place [text] is drawn on more than one line. */
    private fun lines(text: String): List<String> {
        compose.waitForIdle()
        val nodes = compose.onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes()
        assertTrue("\"$text\" is shown", nodes.isNotEmpty())
        return nodes.mapNotNull { node ->
            val layout = mutableListOf<TextLayoutResult>()
            node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(layout)
            layout.firstOrNull()?.lineCount?.takeIf { it > 1 }?.let { "$text: $it lines" }
        }
    }

    /**
     * A row removed in Edit mode leaves no handle behind. The next row moves into its place, and a drag on that row's
     * handle moves that row. The handles were kept by id and never dropped: the removed row's handle lay over the next
     * row's, a drag could start on the removed id, and moving it past half a row ran removeAt(-1). Which of two
     * overlapping handles was found first followed hash order, so both orders are run.
     */
    @Test fun aRemovedRowLeavesNoHandleBehindForTheNextRowsDrag() {
        fixture.secondRunner = true
        val api = api()
        var round by mutableStateOf(0)
        compose.setContent { key(round) { RunnersList(api, revision) {} } }
        for ((order, next) in listOf(listOf(fixture.RUNNER, fixture.RUNNER_TWO) to "Spare box", listOf(fixture.RUNNER_TWO, fixture.RUNNER) to "Old alias")) {
            fixture.runnerOrder = order; fixture.removedRunners = emptySet()
            round++
            await(next); compose.waitForIdle()
            compose.onNode(hasText("Edit") and hasClickAction()).performClick()
            compose.onAllNodes(hasText("Remove") and hasClickAction()).onFirst().performClick()
            compose.onNode(hasText(RunnerCopy.REMOVE) and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
            compose.waitUntil(60_000) { fixture.removedRunners.size == 1 && compose.onAllNodes(hasContentDescription("Reorder", substring = true)).fetchSemanticsNodes().size == 1 }
            compose.waitForIdle()
            compose.onNodeWithContentDescription("Reorder $next").performTouchInput {
                down(centerRight - androidx.compose.ui.geometry.Offset(8f, 0f))
                repeat(30) { moveBy(androidx.compose.ui.geometry.Offset(0f, 20f)) }
                up()
            }
            compose.waitForIdle()
            compose.onNodeWithContentDescription("Reorder $next").assertExists()
        }
        assertEquals("A list of one sends no order", 0, fixture.calls.count { it == "POST runners/reorder" })
    }

    /** A photo far longer than it is high, zoomed in all the way, still draws (it is no layout size). */
    @Test fun aVeryLongPhotoZoomedInAllTheWayStillDraws() {
        val photo = android.graphics.Bitmap.createBitmap(30_000, 100, android.graphics.Bitmap.Config.ARGB_8888)
        compose.setContent { PersonalPhotoDialog(photo, {}, {}) }
        val preview = compose.onNodeWithContentDescription("Photo crop preview")
        repeat(10) {
            val zoomIn = preview.fetchSemanticsNode().config[SemanticsActions.CustomActions].first { it.label == "Zoom in" }
            compose.runOnUiThread { zoomIn.action() }
            compose.waitForIdle()
        }
        compose.onNodeWithText("Save").assertExists()
    }
}
