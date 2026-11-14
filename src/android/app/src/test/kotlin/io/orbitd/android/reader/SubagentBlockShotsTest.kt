package io.orbitd.android.reader

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
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
import java.io.File

/**
 * NATIVE frames of an opened SubAgent block on a phone whose run carries the server's one-line Why (`SubagentRunView.why`): the Why line
 * is that summary in at most two lines, and Details opens to every reason and removed candidate. Written under
 * `src/android/build/evidence/subagent-why-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w393dp-h852dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SubagentBlockShotsTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")!!)) { it.parentFile }.first { File(it, "src/android").isDirectory }
        File(root, "src/android/build/evidence/subagent-why-android").also { it.mkdirs() }
    }

    private fun json(text: String) = Wire.json.parseToJsonElement(text)

    private val oneLine = "Tier S, set by the caller · Cost: gpt-6.1-sol · low on codex, subscription with 84% quota left · 28 others removed"

    private val runs = SubagentRun.byCall((json("""[{"toolUseId":"toolu_sa","type":"explore","background":false,"status":"DONE",
        "level":"S","model":"gpt-6.1-sol","modelLabel":"GPT-6.1 Sol","effort":"low",
        "reasons":["Tier S, set by the caller","Optimize For: Cost","Cheapest of 29 candidates: gpt-6.1-sol · low on codex, subscription with 84% quota left",
          "Moved off claude: no quota left on this runner"],
        "why":"$oneLine",
        "removed":[{"provider":"claude","engine":"claude","model":"claude-opus-5-5","effort":"high","reason":"Tier S excludes it"},
          {"provider":"team-codex","engine":"codex","model":null,"effort":null,"reason":"No quota left"}],
        "costUsd":0.03,"resultSummary":"Three callers, all in quota/.","workspaceName":null,
        "createdAt":"2026-11-11T11:02:31.000Z","endedAt":"2026-11-11T11:03:12.000Z"}]""") as JsonArray).map { it.jsonObject })

    private val row = transcriptRows(listOf(
        RunEvent("tool_use", 3, json("""{"id":"toolu_sa","name":"mcp__orbit__delegate","input":{"type":"explore","description":"Find every caller of pollQuota"}}""")),
        RunEvent("tool_result", 7, json("""{"toolUseId":"toolu_sa","content":"{\"runId\":\"sa\",\"status\":\"DONE\",\"result\":\"Three callers, all in quota/.\"}"}""")),
    )).single()

    private fun shot(name: String) {
        compose.waitForIdle()
        val decor = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        decor.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        assertTrue("$name is blank", pixels.distinct().size > 2)
        val file = File(output, "$name.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name -> $file")
        bitmap.recycle()
    }

    private fun whyLines(): Int {
        val node = compose.onNode(hasTestTag("subagent-why"), useUnmergedTree = true).fetchSemanticsNode()
        val layouts = mutableListOf<TextLayoutResult>()
        node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(layouts)
        return layouts.single().lineCount
    }

    @Test fun theOpenedBlocksWhyIsTheOneLineSummaryWithItsReasonsBehindDetails() {
        compose.setContent {
            OrbitTheme(darkTheme = false) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    CompositionLocalProvider(LocalSubagentRuns provides runs) {
                        Column(Modifier.padding(horizontal = 8.dp, vertical = 16.dp)) { SubagentBlockView(row, highlighted = false) { } }
                    }
                }
            }
        }
        compose.onNode(hasTestTag("subagent-row"), useUnmergedTree = true).performClick()
        compose.onNode(hasTestTag("subagent-why"), useUnmergedTree = true).assertTextEquals("Why · $oneLine")
        val lines = whyLines()
        assertTrue("the Why line takes at most two lines, took $lines", lines in 1..2)
        compose.onNodeWithText("Details").assertExists()
        compose.onAllNodesWithText("Moved off claude", substring = true).assertCountEquals(0)
        shot("a-subagent-why-one-line")

        compose.onNodeWithText("Details").performClick()
        compose.onNodeWithText("Hide").assertExists()
        compose.onNodeWithText("Moved off claude: no quota left on this runner").assertExists()
        compose.onNodeWithText("Removed · claude, claude-opus-5-5 · high: Tier S excludes it").assertExists()
        compose.onNodeWithText("Removed · team-codex (codex): No quota left").assertExists()
        assertEquals(lines, whyLines())
        shot("b-subagent-why-details")
    }
}
