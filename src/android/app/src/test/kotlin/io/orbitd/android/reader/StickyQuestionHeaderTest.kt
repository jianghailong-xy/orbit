package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The sticky "↑ Your question" header over a transcript list laid out the way SessionReader lays it out. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class StickyQuestionHeaderTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun text(t: String) = buildJsonObject { put("text", t) }
    private val rows = transcriptRows(buildList {
        add(RunEvent("user", 1, text("First question")))
        (2L..11L).forEach { add(RunEvent("assistant", it, text("Answer $it"))) }
        add(RunEvent("user", 12, text("Second question\nwith a second line")))
        (13L..30L).forEach { add(RunEvent("assistant", it, text("Answer $it"))) }
    })
    private val jumped = mutableListOf<String>()
    private lateinit var list: LazyListState

    private fun show(hidden: Boolean = false) {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme {
            list = androidx.compose.foundation.lazy.rememberLazyListState()
            Column(Modifier.fillMaxSize()) {
                StickyQuestion(rows, list, hidden) { jumped += it.key }
                LazyColumn(Modifier.weight(1f).testTag("transcript-list"), state = list,
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    item(key = "older") { }
                    items(rows, key = { it.key }) { Text(it.event.body(), Modifier.height(96.dp)) }
                    item(key = "tail") { Spacer(Modifier.height(1.dp)) }
                }
            }
        } } }
        compose.waitForIdle()
    }
    private fun scrollTo(index: Int) { compose.onNodeWithTag("transcript-list").performScrollToIndex(index); compose.waitForIdle() }
    private val header get() = compose.onAllNodesWithContentDescription("Jump to your last question")

    @Test fun hiddenAtTheTopThenNamesTheQuestionAboveTheFoldAndStepsBack() {
        show()
        header.assertCountEquals(0)
        scrollTo(rows.size + 1)
        header.assertCountEquals(1)
        named("↑ Your question", "Second question")
        compose.onNodeWithText("with a second line", substring = true, useUnmergedTree = true).assertDoesNotExist()
        scrollTo(7)
        named("↑ Your question", "First question")
        header.onFirst().performClick()
        assertEquals(listOf("event:1"), jumped)
        scrollTo(0)
        header.assertCountEquals(0)
    }

    @Test fun foldsAwayWhileTheComposerHoldsTheKeyboard() {
        show(hidden = true)
        scrollTo(rows.size + 1)
        header.assertCountEquals(0)
    }

    private fun named(label: String, line: String) {
        val bar = hasAnyAncestor(hasContentDescription("Jump to your last question"))
        compose.onNode(hasText(label) and bar, useUnmergedTree = true).assertIsDisplayed()
        compose.onNode(hasText(line) and bar, useUnmergedTree = true).assertIsDisplayed()
    }
}
