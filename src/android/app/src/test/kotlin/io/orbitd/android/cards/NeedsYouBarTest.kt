package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
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

    @Test fun theBarSaysItsLinePointsWhereItIsAndPressesOnce() {
        var pressed = 0
        compose.setContent { OrbitTheme { NeedsYouBar("1 open question below", NeedsYouChevron.DOWN, NeedsYouLogic.belowHint) { pressed++ } } }
        compose.onNodeWithTag("needs-you-bar-text", useUnmergedTree = true).assertTextEquals("1 open question below")
        compose.onNodeWithTag("needs-you-bar-chevron:DOWN", useUnmergedTree = true).assertExists()
        val bar = compose.onNode(hasClickAction() and hasText("1 open question below"))
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
        compose.setContent { OrbitTheme { NeedsYouBar("Question from coordinator", null, NeedsYouLogic.itemHint, detail = "Integration line",
            since = since, more = 2, glyph = NeedsYouGlyph.QUESTION) { pressed++ } } }
        compose.onNodeWithTag("needs-you-bar-text", useUnmergedTree = true).assertTextEquals("Question from coordinator")
        compose.onNodeWithTag("needs-you-bar-detail", useUnmergedTree = true).assertTextEquals("Integration line")
        compose.onNodeWithTag("needs-you-bar-more", useUnmergedTree = true).assertTextEquals("+2")
        compose.onNodeWithTag("needs-you-bar-age", useUnmergedTree = true).assertTextEquals(TaskTime.elapsed(since)!!)
        compose.onNodeWithTag("needs-you-bar-glyph:QUESTION", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("needs-you-bar-chevron:UP", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("needs-you-bar-chevron:DOWN", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("needs-you-bar").performClick()
        compose.runOnIdle { assertEquals(1, pressed) }
    }

    /** Several waiting (the owner's 2026-11-13 board, option B): folded, the "+N" carries a ⌄ and the press unfolds; unfolded, the
     * first capsule's ↑ is a press of its own that folds them, apart from the capsule's own press. */
    @Test fun theFoldedBarMarksItUnfoldsAndTheFirstUnfoldedCapsuleFolds() {
        var pressed = 0
        var folded = 0
        compose.setContent { OrbitTheme { Column {
            NeedsYouBar("Question from coordinator", null, NeedsYouLogic.unfoldHint(2), more = 1, unfolds = true) { pressed++ }
            NeedsYouBar("Approve merge to main", null, NeedsYouLogic.itemHint, onFold = { folded++ }) { pressed++ }
        } } }
        compose.onNodeWithTag("needs-you-bar-unfolds", useUnmergedTree = true).assertExists()
        assertEquals("Shows all 2 waiting on you", compose.onNode(hasClickAction() and hasText("Question from coordinator"))
            .fetchSemanticsNode().config.getOrNull(SemanticsActions.OnClick)?.label)
        compose.onNodeWithTag("needs-you-bar-fold").performClick()
        compose.runOnIdle { assertEquals(1, folded); assertEquals(0, pressed) }
        compose.onNode(hasClickAction() and hasText("Approve merge to main")).performClick()
        compose.runOnIdle { assertEquals(1, pressed); assertEquals(1, folded) }
    }

    @Test fun theThreeHintsAreIosOwn() {
        assertEquals("Shows what is waiting in this conversation", NeedsYouLogic.belowHint)
        assertEquals("Opens the session waiting on you", NeedsYouLogic.sessionHint)
        assertEquals("Opens the card waiting on you", NeedsYouLogic.itemHint)
    }
}
