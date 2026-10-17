package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** A workflow's progress as the transcript draws it: phases, agent rows, totals — and A06-6's agent rows that open. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class TaskProgressViewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun json(text: String) = Wire.json.parseToJsonElement(text)
    private val golden by lazy {
        val file = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "src/shared/src/taskProgressCopy.golden.json") }.first { it.isFile }
        json(file.readText()).jsonObject["cases"]!!.jsonArray[0].jsonObject["progress"]!!
    }

    private fun show(progress: TaskProgress, workflow: TranscriptRow? = null, opened: MutableList<String> = mutableListOf()) {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme {
            TaskProgressView(progress, workflow) { card -> opened += card.key; Text("activity of ${card.event.toolId()}") }
        } } }
        compose.waitForIdle()
    }

    @Test fun phasesAgentsAndTotalsReadAsTheGoldenTableSays() {
        show(TaskProgress.from(golden)!!)
        listOf("GROUND", "DESIGN", "JUDGE", "4/4", "2/3", "0/2", "design:entity-graph", "46 tools", "queued", "113 tool calls · 17m")
            .forEach { compose.onAllNodesWithText(it, useUnmergedTree = true).onFirst().assertExists() }
        compose.onAllNodesWithText("cached", useUnmergedTree = true).assertCountEquals(4)
        compose.onNodeWithText("Bash grep -rn \"entity\" src/apiserver/src", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test fun anAgentRowOpensToWhatItDid() {
        val progress = TaskProgress.from(json("""{"toolUseId":"wf","agents":[
            {"index":0,"label":"design:wiki","state":"running","model":"claude-opus-5-5","lastToolName":"Bash","lastToolSummary":"ls src","transcriptKey":"toolu_a"},
            {"index":1,"label":"judge:product","state":"error","error":"rate limited"},
            {"index":2,"label":"judge:engineering","state":"running","lastToolName":"Read","transcriptKey":"toolu_missing"}]}"""))!!
        val workflow = transcriptRows(listOf(RunEvent("tool_use", 1, json("""{"id":"wf","name":"Workflow"}""")),
            RunEvent("tool_use", 2, json("""{"id":"toolu_a","name":"Agent","parentToolUseId":"wf"}""")),
            RunEvent("tool_use", 3, json("""{"id":"toolu_r","name":"Read","parentToolUseId":"toolu_a"}""")))).single()
        val opened = mutableListOf<String>()
        show(progress, workflow, opened)
        val row = compose.onNode(hasText("design:wiki") and hasClickAction(), useUnmergedTree = false)
        row.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
        assertEquals("Show agent activity", row.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsActions.OnClick].label)
        row.performClick()
        compose.onNodeWithText("claude-opus-5-5").assertIsDisplayed()
        compose.onNodeWithText("activity of toolu_a").assertIsDisplayed()
        assertEquals(listOf("event:2"), opened)
        compose.onNodeWithText("Bash ls src", useUnmergedTree = true).assertDoesNotExist()
        compose.onNode(hasText("design:wiki") and hasClickAction()).assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))

        compose.onNode(hasText("judge:product") and hasClickAction()).performClick()
        compose.onNodeWithText("rate limited").assertIsDisplayed()
        compose.onNodeWithText("Detailed activity is not available for this agent.").assertIsDisplayed()
        compose.onNode(hasText("judge:engineering") and hasClickAction()).performClick()
        compose.onNodeWithText("Latest tool").assertIsDisplayed()
        compose.onNodeWithText("No activity received yet.").assertIsDisplayed()
    }

    @Test fun activityReadsTheEndOnceTheTaskEndedAndTheLiveFrameWhileItRuns() {
        val live = mapOf("wf" to json("""{"toolUseId":"wf","agents":[{"index":0,"label":"live","state":"running"}]}""").jsonObject)
        val end = json("""{"toolUseId":"wf","agents":[{"index":0,"label":"ended","state":"done"}]}""").jsonObject
        val running = TaskActivity.of(live, emptyList(), listOf(buildJsonObject { put("toolUseId", "wf"); put("status", "running") }))
        assertEquals("live", running.progress("wf")!!.agents.single().label)
        assertTrue(running.isRunning("wf"))
        val ended = TaskActivity.of(live, listOf(RunEvent("background_task", 9, buildJsonObject {
            put("toolUseId", "wf"); put("status", "completed"); put("progress", end) })), emptyList())
        assertEquals("a buffered frame never replaces the end's own last word", "ended", ended.progress("wf")!!.agents.single().label)
        assertFalse(ended.isRunning("wf"))
        val restEnded = TaskActivity.of(emptyMap(), emptyList(), listOf(buildJsonObject { put("toolUseId", "wf"); put("status", "done"); put("progress", end) }))
        assertEquals("ended", restEnded.progress("wf")!!.agents.single().label)
        assertNull(restEnded.progress("other"))
    }
}
