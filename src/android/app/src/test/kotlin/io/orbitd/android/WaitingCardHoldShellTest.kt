package io.orbitd.android

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
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
import io.orbitd.android.cards.CardFocus
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * What a conversation does with the card it was opened at (web 0138628478): a project row's request to open at a waiting card that
 * finds none lapses after 10 s and on the reader's scroll, so a card that arrives later does not move the list; the card it did
 * open at is held in view while records and receipts land ahead of it in the cards item, until the reader takes the scroller or
 * nothing has moved it for 5 s.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w393dp-h852dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class WaitingCardHoldShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 0) val midday = MiddayZone()
    @get:Rule(order = 1) val compose = createAndroidComposeRule<MainActivity>()

    private val row get() = "project-row:${ProjectShell.LAUNCH}"
    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private val headLine = "echo HEAD-OF-THE-WAITING-CARD"

    /** A command taller than the screen, as the waiting card of ProjectRowWaitingShellTest: placed at the top, not left at the foot. */
    private val tall = (listOf(headLine) + (1..60).map { "echo retry-line-$it" }).joinToString("\n")
    private fun approval(id: String, minutesAgo: Long, title: String, command: String = "echo $title") = buildJsonObject {
        put("id", id); put("sessionId", ProjectShell.WAITING); put("toolName", "Bash"); put("status", "PENDING")
        put("createdAt", ago(minutesAgo)); putJsonObject("input") { put("command", command); put("description", title) }
    }
    private fun serve(vararg approvals: JsonObject) { ProjectShell.waitingApprovals = JsonArray(approvals.toList()).toString() }

    /** The wall clock the 10 s lapse reads: the test's, moved by hand, since the shell's virtual time runs far ahead of real loads. */
    private var wall = 1_000_000L
    @After fun realClock() { CardFocus.now = { System.currentTimeMillis() } }

    @Before fun start() {
        CardFocus.now = { wall }
        ProjectShell.reset()
        ProjectShell.waitingEvents = buildJsonArray {
            (1..24).forEach { n ->
                add(Json.parseToJsonElement("""{"type":"user","seq":${2 * n - 1},"turnId":"t-$n","ts":"${ago(60L - n)}","payload":{"text":"Retry step $n of the quota read."}}"""))
                add(Json.parseToJsonElement("""{"type":"assistant","seq":${2 * n},"turnId":"t-$n","ts":"${ago(60L - n)}","payload":{"text":"Step $n: the quota read came back. ${"It answered within its window and the counts matched. ".repeat(3)}"}}"""))
            }
        }.toString()
    }

    /** A question answered elsewhere before the open: no card asks, minutes pass, the reader reads history, and a new card arrives. */
    @Test fun anOpenAtTheWaitingCardThatFindsNoneLapsesAfterTenSeconds() {
        serve()
        openMember()
        wall += 11_000
        readHistory()
        val before = bounds(stepRow())
        serve(approval("a-late", 1, "LATE-DECISION"))
        arrive()
        assertEquals("the late card did not carry the list away from the reader", before, bounds(stepRow()))
        assertFalse("the late card was not brought in", shows("LATE-DECISION"))
    }

    /** The reader's own scroll drops the request at once, long before its ten seconds are up. */
    @Test fun anOpenAtTheWaitingCardThatFindsNoneIsDroppedWhenTheReaderScrolls() {
        serve()
        openMember()
        wall += 1_000
        readHistory()
        val before = bounds(stepRow())
        serve(approval("a-late", 1, "LATE-DECISION"))
        arrive()
        assertEquals("the late card did not carry the list away from the reader", before, bounds(stepRow()))
    }

    /** Control: a card that arrives inside the window, with the reader still, is still brought in. */
    @Test fun aCardThatArrivesWithinTheWindowIsStillBroughtIn() {
        serve()
        openMember()
        serve(approval("a-late", 1, "LATE-DECISION"))
        arrive()
        await { shows("LATE-DECISION") }
    }

    /** Records and receipts land ahead of the opened card in the cards item: it stays in view. */
    @Test fun theOpenedCardStaysInViewWhileACardIsAddedAheadOfIt() {
        serve(approval("a-quota", 9, "Retry the quota read", tall))
        openMember()
        await { shows(headLine) }
        settle()
        val placed = title()!!
        assertTrue("opened on the card: $placed", inList(placed))
        serve(approval("a-earlier", 30, "EARLIER-DECISION"), approval("a-quota", 9, "Retry the quota read", tall))
        arrive()
        assertTrue("the earlier card landed", shows("EARLIER-DECISION"))
        assertEquals("the card is held where it was brought to while one landed ahead of it", placed.top, title()!!.top, 1f)
    }

    @Test fun theHoldReleasesWhenTheReaderTakesTheScroller() {
        serve(approval("a-quota", 9, "Retry the quota read", tall))
        openMember()
        await { shows(headLine) }
        settle()
        readHistory()
        val before = bounds(stepRow())
        serve(approval("a-earlier", 30, "EARLIER-DECISION"), approval("a-quota", 9, "Retry the quota read", tall))
        arrive()
        assertEquals("the reader's place was not taken back", before, bounds(stepRow()))
    }

    @Test fun theHoldReleasesAfterFiveSecondsWithNothingMovingIt() {
        serve(approval("a-quota", 9, "Retry the quota read", tall))
        openMember()
        await { shows(headLine) }
        settle()
        val placed = title()!!
        wall += 6_000
        serve(approval("a-earlier", 30, "EARLIER-DECISION"), approval("a-quota", 9, "Retry the quota read", tall))
        arrive()
        assertTrue("the earlier card landed", shows("EARLIER-DECISION"))
        assertTrue("nothing put the card back after the quiet: $placed, now ${title()} ${order()}", title() == null || title()!!.top > placed.top + 20f)
    }

    private fun order() = compose.onAllNodes(SemanticsMatcher("an approval card") { n ->
        n.config.getOrNull(SemanticsProperties.TestTag)?.let { it.startsWith("approval:") && it.count { c -> c == ':' } == 1 } == true
    }, useUnmergedTree = true).fetchSemanticsNodes().map { it.config[SemanticsProperties.TestTag] + "@" + it.positionInRoot.y }
    /** The waiting card's own box, by its tag: the one the open brought in, not the card that landed ahead of it. */
    private fun title(): Rect? = compose.onAllNodesWithTag("approval:a-quota", useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()?.boundsInRoot
    private fun inList(r: Rect?): Boolean { val list = bounds(compose.onNodeWithTag("transcript-list")); return r != null && r.top >= list.top && r.top < list.bottom - 100 }
    private fun stepRow() = compose.onAllNodes(SemanticsMatcher("a step row") { node ->
        node.config.getOrNull(SemanticsProperties.Text)?.any { it.text.startsWith("Retry step") || it.text.startsWith("Step ") } == true
    }, useUnmergedTree = true).fetchSemanticsNodes().first()
    private fun bounds(node: SemanticsNode): Rect = node.boundsInRoot
    private fun bounds(node: SemanticsNodeInteraction): Rect = node.fetchSemanticsNode().boundsInRoot
    private fun readHistory() { compose.onNodeWithTag("transcript-list").performTouchInput { swipeDown() }; settle() }
    /** Asks for the session again and waits, in real time, for the read to land, so the shell's virtual clock does not run past the hold meanwhile. */
    private fun arrive() {
        val reads = { ProjectShell.calls.count { it == "GET sessions/${ProjectShell.WAITING}/approvals?status=PENDING" } }
        val before = reads()
        app().realtime.refreshSession()
        val until = System.currentTimeMillis() + 30_000
        while (reads() == before && System.currentTimeMillis() < until) Thread.sleep(20)
        Thread.sleep(300)
        repeat(5) { compose.mainClock.advanceTimeBy(100); compose.waitForIdle() }
    }
    private fun advance(ms: Long) { compose.mainClock.advanceTimeBy(ms); compose.waitForIdle() }
    private fun openMember() {
        signIn(); await { exists(hasTestTag(row)) }
        compose.onNodeWithTag(row).performClick()
        await { exists(hasContentDescription("Project sessions")) }
        settle()
    }
    private fun settle() { repeat(5) { compose.mainClock.advanceTimeBy(500); compose.waitForIdle() } }
    private fun shows(text: String) = compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ProjectShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
