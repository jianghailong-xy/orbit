package io.orbitd.android.wiki

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import java.time.Instant
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Wiki/Watch text at twice the type size, measured with real fonts: what gives way when a line runs out of room is
 * what iOS lets give way — never a word broken into a column of letters. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WikiLargeTypeTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun large(content: @androidx.compose.runtime.Composable () -> Unit) {
        compose.activityRule.scenario.onActivity { activity -> activity.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = 2f)) { OrbitTheme(content = content) }
        } }
    }
    private fun layout(node: SemanticsNodeInteraction): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(results) }
        return results.single()
    }

    @Test fun theReviewCardsHeadKeepsItsTimeOnOneLineAndTheProposerGivesWay() {
        val changeset = Wire.json.decodeFromString(WikiChangeset.serializer(), """{"id":"c1","origin":"session",
            "sessionId":"01a0cca7-8609-70ed-a0e2-d4b55b832b60","rationale":"Learned while porting the reader to Android",
            "createdAt":"2026-10-05T11:00:00Z","ops":[{"id":"op-add","seq":0,"op":"add","payload":{"entry":{"kind":"pitfall",
            "title":"Robolectric needs sdk 29","summary":"Pin it"}},"decision":"pending"}]}""")
        large { WikiReviewPage(WikiLogic.reviewCards(listOf(changeset)), entry = { null }, now = Instant.parse("2026-10-05T12:00:00Z"),
            busy = false, actions = WikiReviewActions()) }
        val time = layout(compose.onNodeWithText("· 1h ago"))
        assertEquals("the time reads on one line", 1, time.lineCount)
        assertFalse(time.isLineEllipsized(0))
        // The proposer's name is the one cut short, on its one line, as iOS's `.lineLimit(1)` button is.
        val proposer = layout(compose.onNodeWithTag("wiki-review-proposer"))
        assertEquals(1, proposer.lineCount)
        assertTrue(proposer.isLineEllipsized(0))
    }

    @Test fun aReviewTabTooNarrowForItsLabelEndsInAnEllipsis() {
        val changeset = Wire.json.decodeFromString(WikiChangeset.serializer(), """{"id":"c1","origin":"session",
            "createdAt":"2026-10-05T11:00:00Z","ops":[{"id":"op-add","seq":0,"op":"add","payload":{"entry":{"kind":"pitfall",
            "title":"T","summary":"S"}},"decision":"pending"}]}""")
        large { WikiReviewPage(WikiLogic.reviewCards(listOf(changeset)), entry = { null }, now = Instant.parse("2026-10-05T12:00:00Z"),
            busy = false, actions = WikiReviewActions()) }
        val amend = layout(compose.onNodeWithTag("wiki-review-tab:amend"))
        assertEquals(1, amend.lineCount)
        assertTrue("a cut label says it is cut, as a segmented control's does", amend.isLineEllipsized(0))
    }

    @Test fun aBarTitleWithoutRoomEndsInAnEllipsisOnOneLine() {
        val route = OrbitRoute(Destination.WATCH, id = "01a0cca7-8609-70ed-a0e2-d4b55b832b63")
        large { Column {
            PageBar.Bind(route, "Watching")
            Box(Modifier.width(56.dp)) { PageBar.Title(route) { Text("fallback") } }
        } }
        val title = layout(compose.onNodeWithText("Watching"))
        assertEquals("a navigation title is one line, as iOS's is", 1, title.lineCount)
        assertTrue(title.isLineEllipsized(0))
    }
}
