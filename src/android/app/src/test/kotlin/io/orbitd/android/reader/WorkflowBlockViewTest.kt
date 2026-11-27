package io.orbitd.android.reader

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.reader.WorkflowFixture.WF
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.io.File

/**
 * The workflow block as the production [TranscriptRowView] draws it (board docs/mocks/subagent-workflow part 4, following iOS
 * `WorkflowBlockViews.swift`): the folded card running and finished, the calls page by phase that a tap opens, each row opening the call's
 * SubAgent block, and the finished strip of the wake turn with the agent's answer under it. Frames go to
 * `src/android/build/evidence/workflow-block-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WorkflowBlockViewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun show(finished: Boolean, dark: Boolean = false) {
        val rows = transcriptRows(WorkflowFixture.events(finished))
        val workflow = if (finished) WorkflowFixture.finishedWorkflow else WorkflowFixture.workflow()
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = dark) {
            CompositionLocalProvider(LocalWorkflowRuns provides mapOf(WF to workflow),
                LocalSubagentRuns provides WorkflowFixture.runs(finished)) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.fillMaxWidth().padding(vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        rows.forEach { row -> TranscriptRowView(row, { error("no full read") }, null, {}) }
                    }
                }
            }
        } } }
        compose.waitForIdle()
    }

    private fun says(words: String, under: String) = compose.onAllNodes(hasText(words) and hasAnyAncestor(hasTestTag(under)), useUnmergedTree = true)
        .fetchSemanticsNodes().isNotEmpty()

    private fun press(matcher: SemanticsMatcher) {
        compose.onNode(matcher).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
    }

    @Test fun theRunningBlockFoldedSaysPhaseCountCostAndWhatRunsAndWaits() {
        show(finished = false)
        assertTrue(says("Workflow", "workflow-block"))
        assertTrue(says("Review the scheduler diff", "workflow-block"))
        compose.onNodeWithTag("workflow-progress", useUnmergedTree = true).assertTextEquals("Verify · 7 of 12 · $0.84")
        compose.onNodeWithTag("workflow-live", useUnmergedTree = true).assertTextEquals("3 running, 2 queued")
        compose.onNodeWithTag("workflow-running", useUnmergedTree = true).assertExists()
        // Its calls are behind the tap, not drawn as the transcript's own SubAgent blocks.
        compose.onAllNodes(hasTestTag("subagent-row"), useUnmergedTree = true).assertCountEquals(0)
        shot("01-folded-running")
    }

    @Test fun theCallsPageGroupsByPhaseAndARowOpensTheSubagentBlock() {
        show(finished = false)
        press(hasTestTag("workflow-block"))
        compose.onNodeWithTag("workflow-calls").assertExists()
        assertEquals(listOf("REVIEW · 4 DONE", "VERIFY · 3 DONE · 3 RUNNING · 2 QUEUED"),
            compose.onAllNodes(hasTestTag("workflow-phase"), useUnmergedTree = true).fetchSemanticsNodes().map {
                it.config[androidx.compose.ui.semantics.SemanticsProperties.Text].joinToString { t -> t.text } })
        // The ended Review phase gives its room to the live one: two rows, then "2 more".
        compose.onNodeWithTag("workflow-call:$WF#1", useUnmergedTree = true).assertExists()
        compose.onAllNodes(hasTestTag("workflow-call:$WF#2"), useUnmergedTree = true).assertCountEquals(0)
        assertTrue(says("2 findings", "workflow-call:$WF#0"))
        assertTrue(says("nextRun() skips a day at DST end", "workflow-call:$WF#4"))
        compose.onAllNodes(hasText("Queued"), useUnmergedTree = true).assertCountEquals(2)
        shotDialog("03-calls-page")
        press(hasTestTag("workflow-more"))
        compose.onNodeWithTag("workflow-call:$WF#2", useUnmergedTree = true).assertExists()
        // A row opens the call's SubAgent block, opened: its type line and what it handed back.
        press(hasTestTag("workflow-call:$WF#4"))
        compose.onNodeWithTag("workflow-call-detail").assertExists()
        assertTrue(says("general · S · DeepSeek Chat · 1m", "workflow-call-detail"))
        assertTrue(says("Why · S: the workflow call asked for it", "workflow-call-detail"))
        assertTrue(says("Reading the diff.", "workflow-call-detail"))
        shotDialog("04-call-detail")
        press(hasTestTag("workflow-call-back"))
        compose.onNodeWithTag("workflow-calls-list").assertExists()
        press(hasTestTag("workflow-calls-done"))
        compose.onAllNodes(hasTestTag("workflow-calls")).assertCountEquals(0)
    }

    @Test fun theFinishedBlockAndItsStripWithTheAnswerUnderIt() {
        show(finished = true)
        compose.onNodeWithTag("workflow-progress", useUnmergedTree = true).assertTextEquals("12 of 12 · $1.37")
        compose.onAllNodes(hasTestTag("workflow-live"), useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodes(hasTestTag("workflow-running"), useUnmergedTree = true).assertCountEquals(0)
        assertTrue(says("Workflow finished", "workflow-finished-strip"))
        assertTrue(says("12 calls · 1 failed · 6m 40s · $1.37", "workflow-finished-strip"))
        // Never the raw block or the reader's bubble.
        compose.onAllNodes(hasText("<orbit-workflow-finished>", substring = true), useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodes(hasText("The control plane opened this turn", substring = true), useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodes(hasText("Three findings held up", substring = true), useUnmergedTree = true).assertCountEquals(1)
        shot("02-folded-finished-and-strip")
        press(hasTestTag("workflow-block"))
        assertEquals(listOf("REVIEW · 4 DONE", "VERIFY · 8 DONE"),
            compose.onAllNodes(hasTestTag("workflow-phase"), useUnmergedTree = true).fetchSemanticsNodes().map {
                it.config[androidx.compose.ui.semantics.SemanticsProperties.Text].joinToString { t -> t.text } })
        compose.onAllNodes(hasTestTag("workflow-more")).assertCountEquals(0)
    }

    @Test fun darkFrames() {
        show(finished = false, dark = true)
        shot("dark-01-folded-running")
        press(hasTestTag("workflow-block"))
        shotDialog("dark-03-calls-page")
        show(finished = true, dark = true)
        shot("dark-02-folded-finished-and-strip")
    }

    private val output by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/workflow-block-android").also { it.mkdirs() }
    }

    private fun shot(name: String) = draw(compose.activity.window.decorView, name)
    private fun shotDialog(name: String) = draw(ShadowDialog.getLatestDialog().window!!.decorView, name)

    private fun draw(view: View, name: String) {
        compose.waitForIdle()
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
