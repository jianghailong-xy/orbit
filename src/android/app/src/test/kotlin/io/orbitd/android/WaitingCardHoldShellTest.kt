package io.orbitd.android

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.ObjectId
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

    // Advance the focus clock only at the scenario's time boundaries. Compose can pump frames while fixture reads complete.
    private var focusTimeMs = 1_000_000L
    @After fun realClock() { CardFocus.now = { System.currentTimeMillis() } }

    @Before fun start() {
        CardFocus.now = { focusTimeMs }
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
        restAtTheEnd()
        focusTimeMs += 11_000
        val before = bounds(stepRow())
        serve(approval("a-late", 1, "LATE-DECISION", tall))
        arrive(::lateApprovalLanded)
        assertEquals("the late card did not carry the list away from the reader", before, bounds(stepRow()))
    }

    /** The reader's own scroll drops the request at once, long before its ten seconds are up. */
    @Test fun anOpenAtTheWaitingCardThatFindsNoneIsDroppedWhenTheReaderScrolls() {
        serve()
        openMember()
        restAtTheEnd()
        focusTimeMs += 1_000
        readAlittle()
        val before = bounds(stepRow())
        serve(approval("a-late", 1, "LATE-DECISION", tall))
        arrive(::lateApprovalLanded)
        assertEquals("the late card did not carry the list away from the reader", before, bounds(stepRow()))
    }

    /** Control: a card that arrives inside the window, with the reader still, is still brought in. */
    @Test fun aCardThatArrivesWithinTheWindowIsStillBroughtIn() {
        serve()
        openMember()
        serve(approval("a-late", 1, "LATE-DECISION"))
        arrive { shows("LATE-DECISION") }
    }

    private val quota get() = approval("a-quota", 9, "Retry the quota read", tall)
    private fun ahead(n: Int) = approval("a-ahead-$n", 30L + n, "AHEAD-DECISION-$n")
    /** A question answered since the card was opened: its record is drawn first in the cards item, ahead of the waiting card. */
    private val record get() = """[{"itemId":"q1","question":{"question":"Ship the rollout?","options":[{"label":"Yes"},{"label":"Not yet"}],"recommendedOption":0},
        "askedAt":"${ago(2)}","resolution":"ANSWERED","resolvedBy":"USER","resolvedAt":"${Instant.now()}",
        "answer":{"option":1,"text":null},"delivery":null,"withdrawReason":null}]"""

    /** The card the open brought in, placed at the top, and its top. */
    private fun openedOnTheCard(): Float {
        serve(quota)
        openMember()
        await { shows(headLine) }
        // The read lands off the main thread, in real time: the card is measured once the open has brought it in, held it and laid it out.
        val brought = runCatching {
            await { CardFocus.pending(ProjectShell.WAITING) == null && CardFocus.held(ProjectShell.WAITING)?.key == "approval:a-quota" }
        }
        assertTrue("the open brought the card in and held it: pending=${CardFocus.pending(ProjectShell.WAITING)} " +
            "held=${CardFocus.held(ProjectShell.WAITING)} reported=${CardFocus.position(ProjectShell.WAITING, "approval:a-quota")}", brought.isSuccess)
        settle()
        await { waitingCard()?.boundsInRoot?.isEmpty == false }
        val top = topNow()
        val list = bounds(compose.onNodeWithTag("transcript-list"))
        assertTrue("opened on the card: $top in $list", top >= list.top && top < list.bottom - 100)
        return top
    }
    // A released card can move past the viewport. Clipped bounds then report zero instead of its new position.
    private fun topNow() = waitingCard()!!.positionInRoot.y

    /** A question record lands ahead of the opened card in the cards item: it stays where it was brought to. */
    @Test fun theOpenedCardStaysInViewWhileAQuestionRecordIsAddedAheadOfIt() {
        ProjectShell.waitingReadsProject = true
        val placed = openedOnTheCard()
        ProjectShell.closedQuestions = record
        arrive { compose.onAllNodesWithTag("item:q1", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assertEquals("the card is held where it was brought to while the record landed ahead of it", placed, topNow(), 1f)
    }

    @Test fun theOpenedCardStaysInViewWhileACardIsAddedAheadOfIt() {
        val placed = openedOnTheCard()
        serve(ahead(1), quota)
        arrive { shows("AHEAD-DECISION-1") }
        assertEquals("the card is held where it was brought to while one landed ahead of it", placed, topNow(), 1f)
    }

    /** Held first (content that lands ahead is put back), then the reader touches the list: the next one is not put back. */
    @Test fun theHoldReleasesWhenTheReaderTakesTheScroller() {
        val placed = openedOnTheCard()
        serve(ahead(1), quota); arrive { shows("AHEAD-DECISION-1") }
        assertEquals("held before the touch", placed, topNow(), 1f)
        readAlittle()
        val touched = topNow()
        serve(ahead(1), ahead(2), quota); arrive { shows("AHEAD-DECISION-2") }
        assertTrue("after the touch nothing put the card back: $touched, now ${topNow()}", topNow() > touched + 20f)
    }

    /** Held first, then five quiet seconds after it last moved: the next landing ahead of it is not put back. */
    @Test fun theHoldReleasesAfterFiveSecondsWithNothingMovingIt() {
        val placed = openedOnTheCard()
        focusTimeMs += 4_999
        serve(ahead(1), quota); arrive { shows("AHEAD-DECISION-1") }
        assertEquals("held inside the window", placed, topNow(), 1f)
        focusTimeMs += 5_000
        serve(ahead(1), ahead(2), quota); arrive { shows("AHEAD-DECISION-2") }
        assertTrue("after the quiet nothing put the card back: $placed, now ${topNow()}", topNow() > placed + 20f)
    }

    /** The waiting card's own box, by its tag: the one the open brought in, not the card that landed ahead of it. */
    private fun waitingCard() = compose.onAllNodesWithTag("approval:a-quota", useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
    private fun stepRow() = compose.onAllNodes(SemanticsMatcher("a step row") { node ->
        node.config.getOrNull(SemanticsProperties.Text)?.any { it.text.startsWith("Retry step") || it.text.startsWith("Step ") } == true
    }, useUnmergedTree = true).fetchSemanticsNodes().first()
    private fun bounds(node: SemanticsNode): Rect = node.boundsInRoot
    private fun bounds(node: SemanticsNodeInteraction): Rect = node.fetchSemanticsNode().boundsInRoot
    /** The list's end, reached by the semantics action, not a finger: the reader is at the cards, nothing has touched the list. */
    private fun restAtTheEnd() { compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("transcript-tail")); settle() }
    /** A short drag back: the reader steps up into the last rows, and the cards item is still on screen below them. */
    private fun readAlittle() { compose.onNodeWithTag("transcript-list").performTouchInput { swipe(Offset(centerX, 150f), Offset(centerX, 190f), 200) }; settle() }
    private fun readHistory() { compose.onNodeWithTag("transcript-list").performTouchInput { swipeDown() }; settle() }
    /** Wait for the refreshed content before pumping the layout and the reader's two-frame put-back. */
    private fun arrive(landed: () -> Boolean) {
        val before = snapshotReads()
        app().realtime.refreshSession()
        await { snapshotReads() > before && read() && landed() }
        repeat(5) { compose.mainClock.advanceTimeBy(100); compose.waitForIdle() }
    }
    // An approval below the viewport may never be composed after the reader scrolls away.
    private fun lateApprovalLanded() = app().realtime.state.value.session?.snapshot?.approvals
        ?.any { it["id"]?.jsonPrimitive?.content == "a-late" } == true
    private fun snapshotReads() = app().realtime.state.value.session?.snapshotReads ?: 0L
    /** The member's own read has landed: its transcript and its cards, fresh. */
    private fun read() = app().realtime.state.value.session?.let {
        ObjectId.same(it.id, ProjectShell.WAITING) && it.snapshot != null && it.fresh && it.transcript.seeded
    } == true
    private fun openMember() {
        signIn(); await { exists(hasTestTag(row)) }
        compose.onNodeWithTag(row).performClick()
        await { exists(hasContentDescription("Project sessions")) }
        await { read() }
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
