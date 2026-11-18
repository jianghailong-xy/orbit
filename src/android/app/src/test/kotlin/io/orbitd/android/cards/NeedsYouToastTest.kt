package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The needs-you notice and the conversation's capsule as they are drawn (iOS `NeedsYouToastCard`, `waitingCapsule`): their lines,
 * marks, the way the capsule's chevron points, and what TalkBack is told the press does, the same three hints iOS gives. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class NeedsYouToastTest {
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

    /** A notice (the owner, 2026-11-15, `docs/mocks/needs-you-capsule/12-once`): the conversation, what it waits on and where, the
     * mark of what waits; the whole card is the press, and TalkBack is told where it goes. */
    @Test fun theNoticeSaysWhichConversationAndWhatAndOpensIt() {
        var pressed = 0
        val notice = NeedsYouToast("c1|2026-01-01T00:00:00Z", buildJsonObject { put("id", "c1") }, "Integration line",
            "Question from coordinator · orbit-develop", OwnerItem("i1", "COORDINATOR_QUESTION", "", "2026-01-01T00:00:00Z"))
        compose.setContent { OrbitTheme { NeedsYouToastCard(notice, dismiss = {}) { pressed++ } } }
        compose.onNodeWithTag("needs-you-toast-title", useUnmergedTree = true).assertTextEquals("Integration line")
        compose.onNodeWithTag("needs-you-toast-line", useUnmergedTree = true).assertTextEquals("Question from coordinator · orbit-develop")
        compose.onNodeWithTag("needs-you-toast-glyph:QUESTION", useUnmergedTree = true).assertExists()
        assertEquals(NeedsYouLogic.itemHint, compose.onNodeWithTag("needs-you-toast").fetchSemanticsNode().config
            .getOrNull(SemanticsActions.OnClick)?.label)
        compose.onNodeWithTag("needs-you-toast").performClick()
        compose.runOnIdle { assertEquals(1, pressed) }
    }

    /** Flicked up it goes; a tap is still the press, and TalkBack has the same Dismiss. */
    @Test fun aSwipeUpSendsTheNoticeAwayAndATapStillOpens() {
        var pressed = 0
        var dismissed = 0
        val notice = NeedsYouToast("s|1", buildJsonObject { put("id", "s") }, "Wire up Ollama", "Needs your reply · orbit-op")
        compose.setContent { OrbitTheme { NeedsYouToastCard(notice, dismiss = { dismissed++ }) { pressed++ } } }
        compose.onNodeWithTag("needs-you-toast").performClick()
        compose.runOnIdle { assertEquals(1, pressed); assertEquals(0, dismissed) }
        compose.onNodeWithTag("needs-you-toast").performTouchInput { swipeUp(startY = bottom - 4f, endY = top - 200f, durationMillis = 120) }
        compose.waitUntil(5_000) { dismissed >= 1 }
        compose.runOnIdle { assertEquals(1, pressed) }
        val actions = compose.onNodeWithTag("needs-you-toast").fetchSemanticsNode().config.getOrNull(SemanticsActions.CustomActions)
        assertEquals(listOf(NeedsYouLogic.dismissLabel), actions?.map { it.label })
    }

    @Test fun theThreeHintsAreIosOwn() {
        assertEquals("Shows what is waiting in this conversation", NeedsYouLogic.belowHint)
        assertEquals("Opens the session waiting on you", NeedsYouLogic.sessionHint)
        assertEquals("Opens the card waiting on you", NeedsYouLogic.itemHint)
    }
}
