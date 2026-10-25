package io.orbitd.android.reader

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.unit.dp
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellApplication
import io.orbitd.android.composer.ComposerShellTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A06-18 (iOS d87e5fa67, e9c1552f5) in the production shell at a small phone's width: the sticky question is a capsule in the
 * bar's middle, between back and the ⋯, and only while the reader is off the live tail — scrolled up, or reading a window
 * opened at a record. At the tail the bar's middle is empty: no question and no "Session". The capsule still names the
 * question above the fold, by the arrow alone and the question's first line, steps back through the earlier ones, hides where
 * none is above, and goes back to the one it names; up in the bar its coming moves nothing in the transcript.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w360dp-h640dp")
class StickyQuestionHeaderTest : ComposerShellTest() {
    private val record = "34A06fQuestionRecord01"

    private fun event(type: String, seq: Long, text: String) = buildJsonObject {
        put("type", type); put("seq", seq); put("payload", buildJsonObject { put("text", text) })
    }
    private fun answer(seq: Long) = event("assistant", seq, "Answer $seq\n\nIt goes on for a while, so that a few of these fill the phone's " +
        "page.\n\nAnd a little more after that.")
    private val transcript = buildList {
        add(event("user", 1, "First question"))
        (2L..11L).forEach { add(answer(it)) }
        add(event("user", 12, "Second question\nwith a second line"))
        (13L..30L).forEach { add(answer(it)) }
    }

    private fun session() {
        ComposerShell.events = transcript
        signIn(); openSession()
        await { has(hasTestTag("event:30")) && has(hasTestTag("app-bar")) }
        compose.waitForIdle()
    }

    private val capsule = hasTestTag("question-capsule")
    private fun inCapsule(matcher: SemanticsMatcher) = has(matcher and hasAnyAncestor(capsule), unmerged = true)
    private fun names(line: String) = inCapsule(hasText("↑")) && inCapsule(hasText(line))
    private fun top(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode().boundsInWindow.top
    private fun barTexts() = compose.onAllNodes(hasAnyAncestor(hasTestTag("app-bar")) and hasText("", substring = true), useUnmergedTree = true)
        .fetchSemanticsNodes()

    /** Back up the transcript as a finger does: a slow drag that stops before it lifts, so nothing flings. */
    private fun dragBack(distance: Float) = compose.onNodeWithTag("transcript-list").performTouchInput {
        down(center); repeat(10) { moveBy(Offset(0f, distance / 10)) }; advanceEventTime(200); up()
    }

    /** 末尾不显示: following the answer at the tail, the bar carries no question — though one is above the fold — and no title. */
    @Test fun atTheLiveTailTheBarsMiddleIsEmpty() {
        session()
        assertTrue("the second question is above the fold", has(hasTestTag("event:12")).not() || top("event:12") < top("transcript-list"))
        assertFalse("no capsule at the tail", has(capsule))
        assertTrue("nothing written in the bar: ${barTexts()}", barTexts().isEmpty())
        assertTrue("back and the ⋯ are there", has(hasContentDescription("Back")) && has(hasContentDescription("Session actions")))
        assertFalse("nor the jump row", has(hasTestTag("transcript-jump")))
    }

    /** 往上翻显示: scrolled up, the capsule names the question above the fold; a tap goes back to it, and it steps back. */
    @Test fun scrollingUpPutsTheQuestionInTheBarAndATapGoesBackToIt() {
        session()
        val listTop = top("transcript-list")
        dragBack(300f)
        await { names("Second question") }
        assertFalse("its first line only", inCapsule(hasText("with a second line", substring = true)))
        assertFalse("the arrow alone over the reader's own words", inCapsule(hasText("Your question", substring = true)))
        assertTrue("the jump row shows with it", has(hasTestTag("transcript-jump")))
        assertEquals("up in the bar it moves nothing", listTop, top("transcript-list"), 1f)

        compose.onNode(capsule).performClick()
        await { names("First question") }
        val below = top("event:12") - top("transcript-list")
        assertTrue("the question it named is at the top of the transcript: $below px under it",
            below >= 0f && below <= with(compose.density) { 48.dp.toPx() })

        compose.onNodeWithTag("transcript-list").performScrollToIndex(0)
        await { !has(capsule) }

        compose.onNodeWithText("Jump to latest").performClick()
        await { has(hasTestTag("event:30")) && !has(hasTestTag("transcript-jump")) }
        assertFalse("back at the tail, the bar's middle is empty again", has(capsule))
    }

    /** 记录窗口显示: a window opened at a record is off the live tail, so the capsule names the question above the record. */
    @Test fun aWindowOpenedAtARecordShowsTheQuestionInTheBar() {
        ComposerShell.events = transcript
        ComposerShell.around = buildJsonObject {
            put("events", JsonArray(transcript.take(20))); put("hasMore", false); put("after", 20)
            put("anchor", buildJsonObject { put("kind", "event"); put("id", record); put("seq", 16) })
        }
        signIn()
        open("orbit-session:${ComposerShell.SESSION}?at=$record")
        await { has(hasTestTag("composer-model") and isEnabled()) }
        await { names("Second question") }
        assertTrue("the record's window has newer messages after it", has(hasText("Load newer messages")) || has(hasTestTag("transcript-jump")))
        compose.onNode(capsule).performClick()
        await { names("First question") }
    }

    /** The capsule is the bar's: it folds away with it while the composer holds the keyboard, and comes back with it. */
    @Test fun theCapsuleFoldsAwayWithTheBarWhileTheComposerHoldsTheKeyboard() {
        session()
        dragBack(300f)
        await { names("Second question") }
        compose.onNodeWithTag("composer-input").performClick()
        await { !has(hasTestTag("app-bar")) }
        assertFalse(has(capsule))
        compose.onNodeWithTag("composer-model").performSemanticsAction(SemanticsActions.RequestFocus)
        await { has(hasTestTag("app-bar")) && names("Second question") }
    }

    /** The band it replaced moved the list by its height and scrolled it back; the capsule's coming leaves the line read where it was. */
    @Test fun theCapsuleComingLeavesTheReadLineInPlace() {
        session()
        val line = top("event:30")
        // A touch on the transcript stops following the tail without moving it.
        compose.onNodeWithTag("transcript-list").performTouchInput { click(Offset(4.dp.toPx(), centerY)) }
        await { names("Second question") }
        assertEquals(line, top("event:30"), 1f)
    }
}
