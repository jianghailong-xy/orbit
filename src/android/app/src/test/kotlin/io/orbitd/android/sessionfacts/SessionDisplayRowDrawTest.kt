package io.orbitd.android.sessionfacts

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.SessionRow
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The session list row as drawn, on every row of the comparison rig's table: with the facts, the trailing slot is one of the three state
 * icons (from `phase`) and the second line ends in the row's marks, the value a screen reader hears being the state and the marks; without
 * them, the slot draws today's mark (legacy-baseline.android.json's `mark`) and no state icon or mark chip is drawn.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = io.orbitd.android.TestOrbitApplication::class)
class SessionDisplayRowDrawTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val dir = File("../../../scripts/acceptance/session-three-state-check")
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
    private val fixture = Json.parseToJsonElement(File(dir, "fixture.json").readText()).jsonArray.mapIndexed { i, r ->
        val p = r.jsonObject["payload"]!!.jsonObject
        // As the board's fixture, the server's list row sends `engineTurnActive` for row 27; row 28 keeps the payload the baseline was recorded on.
        json.decodeFromJsonElement(DirectorySession.serializer(),
            if (i + 1 == 27) JsonObject(p + ("engineTurnActive" to JsonPrimitive(true))) else p)
    }
    private val baseline = Json.parseToJsonElement(File(dir, "legacy-baseline.android.json").readText()).jsonObject["rows"]!!.jsonArray
        .map { it.jsonObject["mark"]!!.jsonPrimitive.content }

    /** The board's after column for the rows with the facts: the state icon, the marks and what TalkBack says. Interrupted, Finished and
     * Ended are not drawn; Failed, Retrying, On hold, Background and Will resume are the row's title-line icons ([iconsAfter]), not chips,
     * though TalkBack still says the marks (the owner, 2026-11-27). */
    private val after = mapOf(
        1 to Triple("QUEUED", listOf(), "Queued"), 3 to Triple("RUNNING", listOf(), "Running"), 5 to Triple("IDLE", listOf(), "Idle"),
        7 to Triple("IDLE", listOf(), "Idle"), 9 to Triple("IDLE", listOf(), "Idle"),
        11 to Triple("IDLE", listOf(), "Idle, Failed"), 13 to Triple("IDLE", listOf(), "Idle"),
        15 to Triple("RUNNING", listOf(), "Running"), 17 to Triple("RUNNING", listOf("NEEDS_YOU"), "Running, Needs you"),
        19 to Triple("QUEUED", listOf(), "Queued, On hold"), 21 to Triple("IDLE", listOf(), "Idle"),
        23 to Triple("IDLE", listOf(), "Idle"), 25 to Triple("IDLE", listOf(), "Idle"),
        27 to Triple("RUNNING", listOf(), "Running"), 29 to Triple("RUNNING", listOf(), "Running"),
        31 to Triple("IDLE", listOf(), "Idle"), 33 to Triple("IDLE", listOf(), "Idle"),
        35 to Triple("IDLE", listOf(), "Idle"),
    )
    private val iconsAfter = mapOf(11 to listOf("FAILED"), 15 to listOf("BACKGROUND"), 19 to listOf("ON_HOLD"), 31 to listOf("WILL_RESUME"))
    private val iconTags = listOf("FAILED", "RETRYING", "ON_HOLD", "BACKGROUND", "WILL_RESUME")
    private val stateTags = listOf("QUEUED", "RUNNING", "IDLE").map { "session-state-icon:$it" }
    private val markTags = listOf("NEEDS_YOU", "FAILED", "RETRYING", "ON_HOLD")
    private val legacyTags = listOf("needs-you", "review", "queued", "running", "watching", "jobs", "services", "failed")

    private fun present(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test fun everyFixtureRowDrawsTheBoardsStateAndMarksWithTheFactsAndTodaysMarkWithout() {
        val shown = mutableStateOf(fixture[0])
        compose.setContent { OrbitTheme { SessionRow(shown.value, null, {}) {} } }
        fixture.forEachIndexed { i, session ->
            val row = i + 1
            shown.value = session.copy(id = "row$row")
            compose.waitForIdle()
            val states = stateTags.filter(::present).map { it.substringAfter(':') }
            val marks = markTags.filter { present("session-mark:$it") }
            val icons = iconTags.filter { present("session-row-icon:$it") }
            val legacy = legacyTags.filter { present("session-mark-$it") }
            val value = compose.onNodeWithTag("session-state:row$row", useUnmergedTree = true).fetchSemanticsNode().let { node ->
                generateSequence(node) { it.parent }.firstNotNullOfOrNull { it.config.getOrNull(SemanticsProperties.StateDescription) }
            }
            val expected = after[row]
            if (expected != null) {
                assertEquals("row $row state icon", listOf(expected.first), states)
                assertEquals("row $row marks", expected.second, marks)
                assertEquals("row $row title-line icons", iconsAfter[row].orEmpty(), icons)
                assertEquals("row $row draws no legacy mark", listOf<String>(), legacy)
                assertEquals("row $row TalkBack value", expected.third, value)
            } else {
                assertEquals("row $row draws no state icon", listOf<String>(), states)
                assertEquals("row $row draws no mark chip", listOf<String>(), marks)
                assertEquals("row $row draws no title-line icon", listOf<String>(), icons)
                val before = baseline[row / 2 - 1]
                assertEquals("row $row legacy mark", if (before == "none") listOf() else listOf(before), legacy)
            }
        }
    }
}
