package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.tasks.TaskTime
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The needs-you bar as it is drawn (iOS `NeedsYouBannerView`): its lines, its mark, the way its chevron points — only inside the
 * conversation — and what TalkBack is told the press does, the same three hints iOS gives. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class NeedsYouBarTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    /** What waits in the conversation on screen is said by its header's capsule (the owner, 2026-11-15,
     * `docs/mocks/needs-you-capsule/07-console-one-capsule`): its line, the way the card lies, one press. */
    @Test fun theConversationsCapsuleSaysItsLinePointsWhereItIsAndPressesOnce() {
        var pressed = 0
        compose.setContent { OrbitTheme { io.orbitd.android.reader.WaitingCapsule(
            WaitingBelow(1, "q1", "1 open question above", ReaderSide.ABOVE)) { pressed++ } } }
        compose.onNodeWithTag("waiting-capsule-text", useUnmergedTree = true).assertTextEquals("1 open question above")
        compose.onNodeWithTag("waiting-capsule-chevron:ABOVE", useUnmergedTree = true).assertExists()
        val bar = compose.onNode(hasClickAction() and hasText("1 open question above"))
        assertEquals("Shows what is waiting in this conversation",
            bar.fetchSemanticsNode().config.getOrNull(SemanticsActions.OnClick)?.label)
        bar.performClick()
        compose.runOnIdle { assertEquals(1, pressed) }
    }

    /** The capsule a thing waiting elsewhere draws (the owner's 2026-10-21 board): what and where, its mark, how long and how many
     * behind it — and no chevron, the whole capsule being the press. */
    @Test fun theCapsuleSaysWhatWhereHowLongAndHowManyAndDoesNotPoint() {
        var pressed = 0
        val since = "2026-01-01T00:00:00Z"
        compose.setContent { OrbitTheme { NeedsYouBar("Question from coordinator", NeedsYouLogic.itemHint, detail = "Integration line",
            since = since, more = 2, glyph = NeedsYouGlyph.QUESTION) { pressed++ } } }
        compose.onNodeWithTag("needs-you-bar-text", useUnmergedTree = true).assertTextEquals("Question from coordinator")
        compose.onNodeWithTag("needs-you-bar-detail", useUnmergedTree = true).assertTextEquals("Integration line")
        compose.onNodeWithTag("needs-you-bar-more", useUnmergedTree = true).assertTextEquals("+2")
        compose.onNodeWithTag("needs-you-bar-age", useUnmergedTree = true).assertTextEquals(TaskTime.elapsed(since)!!)
        compose.onNodeWithTag("needs-you-bar-glyph:QUESTION", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("needs-you-bar").performClick()
        compose.runOnIdle { assertEquals(1, pressed) }
    }

    /** Several waiting (the owner's 2026-11-13 board, option B; floating since 11-15, 04-floating): folded, a deck under the capsule
     * says the press unfolds; unfolded, the first capsule's ↑ is a press of its own that folds them, apart from the capsule's own press. */
    @Test fun theFoldedBarMarksItUnfoldsAndTheFirstUnfoldedCapsuleFolds() {
        var pressed = 0
        var folded = 0
        compose.setContent { OrbitTheme { Column {
            NeedsYouBar("Question from coordinator", NeedsYouLogic.unfoldHint(2), more = 1, deck = true) { pressed++ }
            NeedsYouBar("Approve merge to main", NeedsYouLogic.itemHint, onFold = { folded++ }) { pressed++ }
        } } }
        compose.onNodeWithTag("needs-you-bar-deck", useUnmergedTree = true).assertExists()
        assertEquals("Shows all 2 waiting on you", compose.onNode(hasClickAction() and hasText("Question from coordinator"))
            .fetchSemanticsNode().config.getOrNull(SemanticsActions.OnClick)?.label)
        compose.onNodeWithTag("needs-you-bar-fold").performClick()
        compose.runOnIdle { assertEquals(1, folded); assertEquals(0, pressed) }
        compose.onNode(hasClickAction() and hasText("Approve merge to main")).performClick()
        compose.runOnIdle { assertEquals(1, pressed); assertEquals(1, folded) }
    }

    /** Sessions blocked on a tool call carry no "+N": the deck alone says the press unfolds, and one waiting has none. */
    @Test fun theDeckSaysSeveralWithoutACount() {
        var several by mutableStateOf(true)
        compose.setContent { OrbitTheme { NeedsYouBar("4 sessions need you", NeedsYouLogic.unfoldHint(4), deck = several) {} } }
        compose.onNodeWithTag("needs-you-bar-deck", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("needs-you-bar-more", useUnmergedTree = true).assertDoesNotExist()
        several = false
        compose.onNodeWithTag("needs-you-bar-deck", useUnmergedTree = true).assertDoesNotExist()
    }

    /** Pushed up, the bar is put away; a tap is still the press, and TalkBack has the same Dismiss (06-list-floats). */
    @Test fun aSwipeUpPutsTheBarAwayAndATapStillOpens() {
        var pressed = 0
        var swiped = 0
        compose.setContent { OrbitTheme { NeedsYouBar("4 sessions need you", NeedsYouLogic.unfoldHint(4), deck = true,
            onSwipeAway = { swiped++ }) { pressed++ } } }
        compose.onNodeWithTag("needs-you-bar").performClick()
        compose.runOnIdle { assertEquals(1, pressed); assertEquals(0, swiped) }
        compose.onNodeWithTag("needs-you-bar").performTouchInput { swipeUp(startY = bottom - 4f, endY = top - 200f, durationMillis = 120) }
        compose.waitUntil(5_000) { swiped == 1 }
        compose.runOnIdle { assertEquals(1, pressed) }
        val actions = compose.onNodeWithTag("needs-you-bar").fetchSemanticsNode().config.getOrNull(SemanticsActions.CustomActions)
        assertEquals(listOf(NeedsYouLogic.dismissLabel), actions?.map { it.label })
    }

    @Test fun theThreeHintsAreIosOwn() {
        assertEquals("Shows what is waiting in this conversation", NeedsYouLogic.belowHint)
        assertEquals("Opens the session waiting on you", NeedsYouLogic.sessionHint)
        assertEquals("Opens the card waiting on you", NeedsYouLogic.itemHint)
    }
}
