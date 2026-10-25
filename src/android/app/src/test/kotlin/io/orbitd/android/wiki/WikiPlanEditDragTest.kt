package io.orbitd.android.wiki

import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The plan's Edit sheet orders its sections as iOS's list does in edit mode: a section is dragged by its handle
 * (the account owner's decision, card 34bs0PdYUHHwiKHYn3rCp), and TalkBack, which cannot drag, moves it with the
 * row's Move up / Move down actions. There are no ↑/↓ buttons. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1400dp")
class WikiPlanEditDragTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val stored = WikiPlanFixture.version("v1").docs!!.first { it.slug == "session-runtime" }
    private val keys = stored.sections!!.map { it.key }

    private fun show(content: @Composable () -> Unit) {
        compose.activityRule.scenario.onActivity { it.setContent { OrbitTheme { content() } } }
        compose.waitForIdle()
    }

    private fun editSheet(saved: MutableList<WikiPlanDocInput>) = show {
        WikiPlanEditSheet("3.1", stored, 2, close = {}) { input -> saved += input; null }
    }

    @Test fun aSectionIsMovedByDraggingItsHandle() {
        val saved = mutableListOf<WikiPlanDocInput>()
        editSheet(saved)
        assertTrue("no ↑/↓ buttons", compose.onAllNodesWithTag("wiki-plan-edit-up:1").fetchSemanticsNodes().isEmpty())
        val height = compose.onNodeWithTag("wiki-plan-edit-row:0").fetchSemanticsNode().boundsInRoot.height
        // The first section is dragged by its handle past the middle of the second.
        compose.onNodeWithTag("wiki-plan-edit-drag:0").performTouchInput {
            down(center)
            repeat(10) { moveBy(Offset(0f, height * 0.12f)) }
            up()
        }
        compose.waitForIdle()
        compose.onNodeWithTag("wiki-plan-edit-save").performClick()
        compose.waitUntil(60_000) { saved.isNotEmpty() }
        assertEquals(listOf(keys[1], keys[0]) + keys.drop(2), saved.single().sections.map { it.key })
    }

    @Test fun talkBackMovesASectionWithTheRowsActions() {
        val saved = mutableListOf<WikiPlanDocInput>()
        editSheet(saved)
        val actions = compose.onNodeWithTag("wiki-plan-edit-row:1").fetchSemanticsNode().config.getOrNull(SemanticsActions.CustomActions).orEmpty()
        assertEquals(listOf("Move up", "Move down"), actions.map { it.label })
        compose.runOnIdle { actions.first { it.label == "Move up" }.action() }
        compose.onNodeWithTag("wiki-plan-edit-save").performClick()
        compose.waitUntil(60_000) { saved.isNotEmpty() }
        assertEquals(listOf(keys[1], keys[0]) + keys.drop(2), saved.single().sections.map { it.key })
        val first = compose.onNodeWithTag("wiki-plan-edit-row:0").fetchSemanticsNode().config.getOrNull(SemanticsActions.CustomActions).orEmpty()
        assertEquals("the first section cannot move up", listOf("Move down"), first.map { it.label })
    }
}
