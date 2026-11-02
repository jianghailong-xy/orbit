package io.orbitd.android.reader

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.directory.RecapCard
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The conversation's Recap card as it is drawn (iOS `RecapCardView`): one paragraph, the word and when the recap was written running
 * into the recap whole, with one ⋮ — named for TalkBack — at the end of the last line, holding Refresh and Hide, and asking once and
 * not again while it asks. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class RecapCardViewTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val card = RecapCard("Research done: integrate Copilot CLI first.", "Sat, Oct 17, 1:44 PM")

    @Test fun theCardSaysTheRecapWholeAndWhenItWasWritten() {
        var asked = 0
        compose.setContent { OrbitTheme { RecapCardView(card, refreshing = false, onRefresh = { asked++ }, onHide = {}) } }
        compose.onNodeWithTag("recap-card-text", useUnmergedTree = true)
            .assertTextEquals("Recap · Sat, Oct 17, 1:44 PM  Research done: integrate Copilot CLI first.")
        compose.onNodeWithContentDescription("Recap actions").performClick()
        compose.onNodeWithText("Refresh recap").performClick()
        assertEquals(1, asked)
    }

    @Test fun aRecapWithNoTimeSaysTheWordAloneAndARefreshInFlightCannotBePressedAgain() {
        compose.setContent { OrbitTheme { RecapCardView(card.copy(whenWritten = null), refreshing = true, onRefresh = {}, onHide = {}) } }
        compose.onNodeWithTag("recap-card-text", useUnmergedTree = true).assertTextEquals("Recap  Research done: integrate Copilot CLI first.")
        compose.onNodeWithTag("recap-more").assertIsNotEnabled()
    }

    @Test fun theMenuHandsTheHideBackWithoutRefreshing() {
        var hid = 0
        var asked = 0
        compose.setContent { OrbitTheme { RecapCardView(card, refreshing = false, onRefresh = { asked++ }, onHide = { hid++ }) } }
        compose.onNodeWithContentDescription("Recap actions").performClick()
        compose.onNodeWithText("Hide recap").performClick()
        assertEquals(1, hid)
        assertEquals(0, asked)
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) fun theMenuSitsAtTheEndOfTheLastLineAndTheWordsRunTheWholeRow() {
        compose.setContent { OrbitTheme { RecapCardView(card.copy(text = "Done.", whenWritten = null), refreshing = false, onRefresh = {}, onHide = {}) } }
        val row = compose.onNodeWithTag("recap-card").getUnclippedBoundsInRoot()
        val text = compose.onNodeWithTag("recap-card-text", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val more = compose.onNodeWithTag("recap-more").getUnclippedBoundsInRoot()
        // One line, with ⋮ on its middle, 12dp short of its end: the 48dp button hangs 12dp past the end of the line.
        assertEquals((text.top + text.bottom).value / 2, (more.top + more.bottom).value / 2, 0.5f)
        assertEquals(row.right.value - 12f, (more.left + more.right).value / 2, 0.5f)
        // The words run to the end of the row, from its top, and the card is a line tall: no column, and no room kept over them
        // for a 48dp button.
        assertEquals(row.right.value, text.right.value, 0.5f)
        assertEquals(text.top.value, row.top.value, 0.5f)
        assertTrue("the card is a line tall", (row.bottom - row.top).value < 24f)
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) fun aLastLineWithNoRoomLeavesTheMenuALineOfItsOwn() {
        // 20dp of line beside the mark: each line holds a letter or two, and none has the 24dp ⋮ takes of it. A short recap, so the
        // tall card still fits the window.
        compose.setContent {
            OrbitTheme { Box(Modifier.width(41.dp)) { RecapCardView(card.copy(text = "Done.", whenWritten = null), refreshing = false, onRefresh = {}, onHide = {}) } }
        }
        val row = compose.onNodeWithTag("recap-card").getUnclippedBoundsInRoot()
        val text = compose.onNodeWithTag("recap-card-text", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val more = compose.onNodeWithTag("recap-more").getUnclippedBoundsInRoot()
        assertTrue("the card gains a line under the words", row.bottom.value > text.bottom.value + 10f)
        assertEquals((text.bottom + row.bottom).value / 2, (more.top + more.bottom).value / 2, 0.5f)
    }

    /** A real touch, not a semantics press, at each edge of ⋮'s target: it hangs past the card it stands in, above and below a line
     * and past the line's end, so nothing but the hit test says those parts answer. In the reader's own list, between two items. */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) fun aTouchAnywhereOnTheTargetOpensTheMenuThoughItHangsPastTheCard() {
        compose.setContent {
            OrbitTheme {
                LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    item { Text("The reply above.") }
                    item { RecapCardView(card.copy(text = "Done.", whenWritten = null), refreshing = false, onRefresh = {}, onHide = {}) }
                    item { Text("The next item.") }
                }
            }
        }
        val more = compose.onNodeWithTag("recap-more")
        val edges: List<Pair<String, TouchInjectionScope.() -> Offset>> = listOf(
            "the middle" to { center }, "the top" to { topCenter + Offset(0f, 1f) }, "the bottom" to { bottomCenter - Offset(0f, 1f) },
            "the left" to { centerLeft + Offset(1f, 0f) }, "the right" to { centerRight - Offset(1f, 0f) })
        edges.forEach { (edge, at) ->
            more.performTouchInput { click(at()) }
            compose.onNodeWithText("Refresh recap").assertExists("a touch at $edge of ⋮ opened no menu")
            // Its item closes it; `onHide` here does nothing, so the card stays for the next touch.
            compose.onNodeWithText("Hide recap").performClick()
            compose.onNodeWithText("Refresh recap").assertDoesNotExist()
        }
    }
}
