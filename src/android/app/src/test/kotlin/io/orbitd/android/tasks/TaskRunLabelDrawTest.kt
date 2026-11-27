package io.orbitd.android.tasks

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.material3.Surface
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.management.ManagementFixture
import io.orbitd.android.management.ManagementShellApplication
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The task page's run rows as drawn by the production `TaskDetail`, one run per row of the comparison rig's table
 * (scripts/acceptance/session-three-state-check/fixture.json): with the facts, the run's icon is one of the three state icons, its word
 * the state from `phase` and its marks the approved board's (docs/mocks/session-display-three-states); without them, today's word
 * (legacy-baseline.android.json's `runBadge`) and no state icon or mark.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h891dp")
class TaskRunLabelDrawTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()

    private val dir = File("../../../scripts/acceptance/session-three-state-check")
    private val rows = Json.parseToJsonElement(File(dir, "fixture.json").readText()).jsonArray.mapIndexed { i, r ->
        val p = r.jsonObject["payload"]!!.jsonObject
        // As the board's fixture, the server sends `engineTurnActive` for row 27; row 28 keeps the payload the baseline was recorded on.
        JsonObject(p + ("id" to JsonPrimitive("R${i + 1}")) + ("createdAt" to JsonPrimitive("2026-11-24T08:00:00Z")) +
            ("agent" to buildJsonObject { put("name", "orbit-ws01") }) + (if (i + 1 == 27) mapOf("engineTurnActive" to JsonPrimitive(true)) else emptyMap()))
    }
    private val baseline = Json.parseToJsonElement(File(dir, "legacy-baseline.android.json").readText()).jsonObject["rows"]!!.jsonArray
        .map { it.jsonObject["runBadge"]!!.jsonPrimitive.content }

    /** The board's task run label, after: the state and the marks for each row with the facts. Interrupted, Background, Will resume,
     * Finished and Ended are not marks (the owner, 2026-11-27). */
    private val after = mapOf(
        1 to ("QUEUED" to listOf()), 3 to ("RUNNING" to listOf()), 5 to ("IDLE" to listOf()), 7 to ("IDLE" to listOf()),
        9 to ("IDLE" to listOf()), 11 to ("IDLE" to listOf("FAILED")), 13 to ("IDLE" to listOf()),
        15 to ("RUNNING" to listOf()), 17 to ("RUNNING" to listOf("NEEDS_YOU")), 19 to ("QUEUED" to listOf("ON_HOLD")),
        21 to ("IDLE" to listOf()), 23 to ("IDLE" to listOf()), 25 to ("IDLE" to listOf()),
        27 to ("RUNNING" to listOf()), 29 to ("RUNNING" to listOf()), 31 to ("IDLE" to listOf()), 33 to ("IDLE" to listOf()),
        35 to ("IDLE" to listOf()),
    )
    private val words = mapOf("QUEUED" to "Queued", "RUNNING" to "Running", "IDLE" to "Idle")
    private val marks = listOf("NEEDS_YOU", "FAILED", "RETRYING", "ON_HOLD")

    @Before fun start() { ManagementFixture.reset() }

    @Test fun everyFixtureRowsRunDrawsTheBoardsStateAndMarksWithTheFactsAndTodaysWordWithout() {
        ManagementFixture.task = buildJsonObject {
            put("id", ManagementFixture.TASK); put("title", "Runs of every fixture row"); put("status", "IN_PROGRESS")
            put("createdAt", "2026-11-24T07:00:00Z"); put("updatedAt", "2026-11-24T09:00:00Z")
            put("assignee", buildJsonObject { put("id", ManagementFixture.WORKSPACE); put("name", "orbit-ws01") })
            put("dependsOn", JsonArray(emptyList())); put("dependedOnBy", JsonArray(emptyList())); put("comments", JsonArray(emptyList()))
            put("sessions", JsonArray(rows))
        }.toString()
        val app = RuntimeEnvironment.getApplication() as OrbitApplication
        app.realtime.setNetwork(true, "fixture")
        runBlocking { ManagementFixture.signIn(app.session) }
        compose.waitUntil(60_000) { app.realtime.state.value.controlConnection == io.orbitd.android.core.realtime.ConnectionState.CONNECTED }
        val handle = (app.session.state.value as AuthState.SignedIn).handle
        compose.setContent { OrbitTheme(darkTheme = false) { Surface { TaskDetail(app, handle, ManagementFixture.TASK, 0, {}, {}) } } }
        compose.waitUntil(60_000) { compose.onAllNodesWithTag("task-status-line").fetchSemanticsNodes().isNotEmpty() }
        rows.indices.map { it + 1 }.forEach { row ->
            compose.onNodeWithTag("task-detail").performScrollToNode(hasTestTag("task-run:R$row"))
            fun inRun(tag: String) = compose.onAllNodes(hasTestTag(tag) and hasAnyAncestor(hasTestTag("task-run:R$row")), useUnmergedTree = true)
                .fetchSemanticsNodes().isNotEmpty()
            val word = compose.onNodeWithTag("task-run-state:R$row", useUnmergedTree = true).fetchSemanticsNode()
                .config.getOrNull(SemanticsProperties.Text)?.joinToString { it.text }
            val icons = words.keys.filter { inRun("session-state-icon:$it") }
            val drawn = marks.filter { inRun("session-mark:$it") }
            val expected = after[row]
            if (expected != null) {
                assertEquals("row $row word", words.getValue(expected.first), word)
                assertEquals("row $row state icon", listOf(expected.first), icons)
                assertEquals("row $row marks", expected.second, drawn)
            } else {
                assertEquals("row $row word", baseline[row / 2 - 1], word)
                assertEquals("row $row draws no state icon", listOf<String>(), icons)
                assertEquals("row $row draws no mark", listOf<String>(), drawn)
            }
        }
    }
}
