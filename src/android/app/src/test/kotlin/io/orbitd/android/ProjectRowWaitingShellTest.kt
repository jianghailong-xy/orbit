package io.orbitd.android

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.cards.CardFocus
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.After
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
 * Owner 2026-11-14 (the boards beside task 34xRdpqM8dnX1kUnRjcnG): a session-list project row whose line says a member waits on you
 * opens that member — Back returns to the list — and the conversation opens on the top of its waiting card, not the transcript's end.
 * Every other row opens the coordinator as before, and opening the member any other way keeps the tail. The frame of the member opened
 * from the row is written under `$ORBIT_PROJECT_ROW_SHOTS` (default: the JVM's tmpdir), `project-row-waiting-*`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w393dp-h852dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ProjectRowWaitingShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 0) val midday = MiddayZone()
    @get:Rule(order = 1) val compose = createAndroidComposeRule<MainActivity>()

    private val output: File by lazy {
        File(System.getenv("ORBIT_PROJECT_ROW_SHOTS") ?: File(System.getProperty("java.io.tmpdir"), "project-row-waiting-android").path).also { it.mkdirs() }
    }
    private val row get() = "project-row:${ProjectShell.LAUNCH}"
    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()

    /** The command's first and last lines. The card is taller than the screen, so the tail never shows the command's head: the
     * command itself folds, and the height under it is the Allow & remember label, which names every program the command runs. */
    private val headLine = "echo HEAD-OF-THE-WAITING-CARD"
    private val footLine = "echo FOOT-OF-THE-WAITING-CARD"

    @After fun realClock() { CardFocus.now = { System.currentTimeMillis() } }

    @Before fun start() {
        // Keep the row's request alive while the reader loads and lays out the card.
        CardFocus.now = { 1_000_000L }
        ProjectShell.reset()
        ProjectShell.waitingEvents = buildJsonArray {
            (1..24).forEach { n ->
                add(Json.parseToJsonElement("""{"type":"user","seq":${2 * n - 1},"turnId":"t-$n","ts":"${ago(60L - n)}","payload":{"text":"Retry step $n of the quota read."}}"""))
                add(Json.parseToJsonElement("""{"type":"assistant","seq":${2 * n},"turnId":"t-$n","ts":"${ago(60L - n)}","payload":{"text":"Step $n: the quota read came back. ${"It answered within its window and the counts matched. ".repeat(3)}"}}"""))
            }
        }.toString()
        val command = (listOf(headLine) + (1..60).map { "retry-line-$it" } + footLine).joinToString("\n")
        ProjectShell.waitingApprovals = buildJsonArray {
            add(buildJsonObject {
                put("id", "a-quota"); put("sessionId", ProjectShell.WAITING); put("toolName", "Bash"); put("status", "PENDING")
                put("createdAt", ago(9)); putJsonObject("input") { put("command", command); put("description", "Retry the quota read") }
            })
        }.toString()
    }

    /** Board ①–③: the row whose line names the waiting member opens it; Back returns to the list. */
    @Test fun aRowWhoseMemberWaitsOpensThatMemberAndBackReturnsToTheList() {
        signIn(); openList()
        compose.onNode(hasTestTag("project-row-line") and hasText("Waiting for your confirmation · Quota retry"), useUnmergedTree = true).assertExists()
        val before = ProjectShell.calls.size
        compose.onNodeWithTag(row).performClick()
        await { exists(hasContentDescription("Project sessions")) && ProjectShell.calls.drop(before).any { it == "GET sessions/${ProjectShell.WAITING}" } }
        assertFalse("the coordinator is not opened: ${ProjectShell.calls.drop(before)}",
            ProjectShell.calls.drop(before).any { it == "GET sessions/${ProjectShell.COORD}" })
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(hasTestTag(row)) }
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
    }

    /** The coordinator itself waiting outranks the member: the row says the coordinator's words and opens it. */
    @Test fun aRowWhoseCoordinatorWaitsOpensTheCoordinator() {
        ProjectShell.coordinatorWaiting = true
        opensTheCoordinator()
    }

    /** Nobody waiting — the row says what the line does (here the project's landing) — opens the coordinator, as before. */
    @Test fun aRowNobodyWaitsOnOpensTheCoordinator() {
        ProjectShell.memberWaiting = false
        opensTheCoordinator()
    }

    private fun opensTheCoordinator() {
        signIn(); openList()
        compose.onAllNodes(hasTestTag("project-row-line") and hasText("Quota retry", substring = true), useUnmergedTree = true).assertCountEquals(0)
        val before = ProjectShell.calls.size
        compose.onNodeWithTag(row).performClick()
        await { exists(hasContentDescription("Project sessions")) && ProjectShell.calls.drop(before).any { it == "GET sessions/${ProjectShell.COORD}" } }
        assertFalse(ProjectShell.calls.drop(before).any { it == "GET sessions/${ProjectShell.WAITING}" })
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(hasTestTag(row)) }
    }

    /** The member opened from the row shows its waiting card's head — its title, header and first line — at the top of the
     * transcript, not the transcript's end. */
    @Test fun theMemberOpensOnTheTopOfItsWaitingCard() = opensOnTheCardsTop("project-row-waiting-member-opened")

    /** The same, with another session waiting too: since 2026-11-15 (07-console-one-capsule) a conversation carries no bar for it,
     * so nothing floats over the card's head. */
    @Test fun theMemberOpensOnTheTopOfItsWaitingCardBelowTheFloatingCapsule() {
        ProjectShell.plainWaiting = true
        opensOnTheCardsTop("project-row-waiting-member-opened-capsule")
    }

    @Test fun aRecordLinkDoesNotBlockPendingWaitingCardFocus() {
        val record = "34A06fQuestionRecord01"
        ProjectShell.waitingAround = buildJsonObject {
            put("events", Json.parseToJsonElement(ProjectShell.waitingEvents!!))
            put("hasMore", false)
            putJsonObject("anchor") { put("kind", "event"); put("id", record); put("seq", 47) }
        }
        signIn()
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            // A record link arrives before the project row's session-scoped request has been consumed.
            CardFocus.request(ProjectShell.WAITING, CardFocus.WAITING)
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse("orbit-session:${ProjectShell.WAITING}?at=$record"))
                    .setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        await { laidOut(hasTestTag("event:47")) && read() }
        // Bring the rail into composition without a touch, which would cancel the pending request.
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("approval:a-quota"))
        settle()
        compose.waitUntil(10_000) { CardFocus.pending(ProjectShell.WAITING) == null }
        assertEquals("the waiting card took focus", "approval:a-quota", CardFocus.held(ProjectShell.WAITING)?.key)
    }

    private fun opensOnTheCardsTop(name: String) {
        signIn(); openList()
        compose.onNodeWithTag(row).performClick()
        await { shows(headLine) || shows(footLine) }
        // The focus request is spent after bring-into-view. Its children can still have empty bounds until layout.
        await { read() && CardFocus.pending(ProjectShell.WAITING) == null && CardFocus.held(ProjectShell.WAITING)?.key == "approval:a-quota" }
        settle()
        await {
            laidOut(hasTestTag("approval:a-quota")) && laidOut(hasText("Run a command?")) &&
                laidOut(hasText("From Orbit")) && commandHead().singleOrNull()?.isEmpty == false
        }
        shot(name)
        val list = bounds(compose.onNodeWithTag("transcript-list"))
        val head = commandHead().single()
        val title = bounds(compose.onNodeWithText("Run a command?", useUnmergedTree = true))
        val header = bounds(compose.onNodeWithText("From Orbit", useUnmergedTree = true))
        assertTrue("the card's title is inside the transcript: $title in $list", title.top >= list.top && title.bottom <= list.bottom)
        assertTrue("its header too: $header in $list", header.top >= list.top && header.bottom <= list.bottom)
        assertTrue("and its command's first line: $head in $list", head.top >= list.top && head.bottom <= list.bottom)
        // A conversation carries no notice for what already waited elsewhere (07-console-one-capsule, 12-once).
        val notices = compose.onAllNodesWithTag("needs-you-toast", useUnmergedTree = true).fetchSemanticsNodes()
        assertTrue("no needs-you notice over the transcript: ${notices.size}", notices.isEmpty())
        // At the top of the list, not wherever it happened to come in: the card's title in the list's upper quarter.
        val clear = list.top
        assertTrue("the card is at the top: $title in $list, clear from $clear", title.top < clear + list.height / 4)
        assertFalse("the card's foot is below, unseen", commandFootShown(list))
        assertFalse("the transcript is not at its end", atTheEnd())
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(hasTestTag(row)) }
    }

    /** The same member opened another way — the row's menu, Open Session — opens at the tail, as it always did. A visit of its own:
     * a conversation opened again comes back where the reader left it. */
    @Test fun theMemberOpenedFromTheMenuKeepsTheTail() {
        signIn(); openList()
        compose.onNode(hasRowMenu("Options for Launch")).openRowMenu()
        await { exists(hasText("Open Session") and hasAnyAncestor(isDialog())) }
        compose.onNode(hasText("Open Session") and hasAnyAncestor(isDialog())).performClick()
        await { shows(footLine) || shows(headLine) }
        await { read() }
        settle()
        shot("project-row-waiting-member-from-menu")
        val again = bounds(compose.onNodeWithTag("transcript-list"))
        assertTrue("the menu's open is at the transcript's end", atTheEnd())
        assertFalse("and not at the card's head", commandHead().any { it.top < again.bottom && it.bottom > again.top })
    }

    /** Where the command's own text is — not a button's label that quotes it. */
    private fun commandHead(): List<Rect> = compose.onAllNodes(SemanticsMatcher("starts with the card's first line") { node ->
        node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text?.removePrefix("$ ")?.startsWith(headLine) == true
    }, useUnmergedTree = true).fetchSemanticsNodes().map { it.boundsInRoot }
    /** Whether the command's own last line is on screen: its text runs down to the foot, which sits at the bottom of that text.
     * Not just any node holding those words; and a folded command shows no foot at all. */
    private fun commandFootShown(list: Rect): Boolean = compose.onAllNodes(SemanticsMatcher("the command's own text, down to its foot") { node ->
        node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text?.let { it.removePrefix("$ ").startsWith(headLine) && it.contains(footLine) } == true
    }, useUnmergedTree = true).fetchSemanticsNodes().any { it.boundsInRoot.bottom > list.top && it.boundsInRoot.bottom <= list.bottom }
    /** Whether the transcript is scrolled to its end: its scroll range has nowhere further to go. */
    private fun atTheEnd(): Boolean {
        val range = compose.onNodeWithTag("transcript-list").fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
        return range.value() >= range.maxValue() - 1f
    }
    /** The member's own read has landed: its transcript and its cards, fresh. */
    private fun read() = app().realtime.state.value.session?.let {
        ObjectId.same(it.id, ProjectShell.WAITING) && it.snapshot != null && it.fresh && it.transcript.seeded
    } == true
    private fun settle() { repeat(5) { compose.mainClock.advanceTimeBy(500); compose.waitForIdle() } }
    private fun bounds(node: SemanticsNodeInteraction): Rect = node.fetchSemanticsNode().boundsInRoot
    private fun laidOut(matcher: SemanticsMatcher) =
        compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().singleOrNull()?.boundsInRoot?.isEmpty == false
    private fun shows(text: String) = compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun openList() = await { exists(hasTestTag(row)) }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString(maxDepth = Int.MAX_VALUE))
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
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
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
