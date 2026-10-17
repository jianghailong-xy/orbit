package io.orbitd.android.projects

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The start card's toggles only while a clamp cuts (A11-13; iOS d91a0dd48, docs/mocks/start-card-web-width): More under the
 * coordinator's words while three lines hide some of them, Read all under the criteria while two lines hide some of one — measured
 * by the text's own layout, with the native graphics a phone lays text out with, at a 360 dp phone's width. Each case reads the
 * drawn text's layout back and holds the toggle to it: the press is there exactly when the layout says words are hidden. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w360dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class StartProjectCardClampTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val tag = "start-card"
    private val seal = "c2b4e16c4b59" + "0".repeat(52)
    private val short = "B and C both build on A — one branch checks them together."
    private val long = "The plan files ten tasks under the six criteria and orders them by what each needs first: the shared rule lands before " +
        "either client builds on it, both clients then go side by side, and the go-live waits for both. Automatic can stay on, because every " +
        "landing runs the merge check on the combined tree, and the only decision left to you is the go-live itself, which you confirm."

    private fun card(why: String, criteria: List<String>) {
        val request = StartProjectCopy.Request(StartProjectCopy.Settings("PROJECT_BRANCH", "refs/heads/project/p", true, 3, "npm test"), why, seal)
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            var draft by remember(request) { mutableStateOf(StartProjectCopy.Draft.of(request.settings)) }
            Column(Modifier.verticalScroll(rememberScrollState())) {
                StartProjectCard("p", "Runner 页整页改版", true, "56m ago", request, criteria.mapIndexed { i, text -> StartCriterion(i + 1, text) },
                    StartProjectCopy.PlanView(criteria.size, null), true, 7_200, draft, { draft = it }, StartProjectCopy.Standing.LIVE, enabled = true,
                    starting = false, error = null, tag = tag, startTag = "$tag-confirm", onStart = {}, onViewTasks = {})
            }
        } } }
        compose.waitForIdle()
    }

    /** The drawn text's own layout, read back off its node. */
    private fun layout(nodeTag: String): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        compose.onNodeWithTag(nodeTag, useUnmergedTree = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!.invoke(results)
        return results.single()
    }

    @Test fun moreIsOfferedOnlyWhileThreeLinesCutTheCoordinatorsWords() {
        card(short, listOf("Done."))
        layout("$tag-why-text").let { assertFalse(it.didOverflowHeight); assertTrue(it.lineCount <= 3) }
        compose.onNodeWithTag("$tag-why").assertDoesNotExist()

        card(long, listOf("Done."))
        layout("$tag-why-text").let { assertTrue("cut at three lines", it.didOverflowHeight); assertEquals(3, it.lineCount) }
        compose.onNodeWithTag("$tag-why").performScrollTo().assertTextEquals(StartProjectCopy.more).performClick()
        compose.waitForIdle()
        // Open, the words are whole and the press says Less; closed again, More is back.
        layout("$tag-why-text").let { assertFalse(it.didOverflowHeight); assertTrue("${it.lineCount} lines", it.lineCount > 3) }
        compose.onNodeWithTag("$tag-why").assertTextEquals(StartProjectCopy.less).performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("$tag-why").assertTextEquals(StartProjectCopy.more)
    }

    @Test fun readAllIsOfferedOnlyWhileTwoLinesCutACriterion() {
        val few = listOf("Reminders follow one rule on every client.", "The go-live is confirmed by the owner.")
        card(short, few)
        few.indices.forEach { assertFalse(layout("$tag-criterion:$it").didOverflowHeight) }
        compose.onNodeWithTag("$tag-criteria").assertDoesNotExist()

        // One criterion of three cut at two lines is enough: a folded list is an invitation to sign unread.
        card(short, few + long)
        assertFalse(layout("$tag-criterion:0").didOverflowHeight); assertTrue(layout("$tag-criterion:2").didOverflowHeight)
        assertEquals(2, layout("$tag-criterion:2").lineCount)
        compose.onNodeWithTag("$tag-criteria").performScrollTo().assertTextEquals(StartProjectCopy.readAll(3)).performClick()
        compose.waitForIdle()
        assertFalse(layout("$tag-criterion:2").didOverflowHeight)
        compose.onNodeWithTag("$tag-criteria").assertTextEquals(StartProjectCopy.showLess).performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("$tag-criteria").assertTextEquals(StartProjectCopy.readAll(3))
    }
}
