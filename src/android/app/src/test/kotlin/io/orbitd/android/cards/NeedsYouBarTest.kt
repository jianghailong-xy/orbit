package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.TestOrbitApplication
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

/** The needs-you bar as it is drawn (iOS `NeedsYouBannerView`): its one line, the way its chevron points, and what TalkBack is
 * told the press does — the same three hints iOS gives. */
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

    @Test fun theThreeHintsAreIosOwn() {
        assertEquals("Shows what is waiting in this conversation", NeedsYouLogic.belowHint)
        assertEquals("Opens the session waiting on you", NeedsYouLogic.sessionHint)
        assertEquals("Opens the card waiting on you", NeedsYouLogic.itemHint)
    }
}
