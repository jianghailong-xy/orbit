package io.orbitd.android.sessionfacts

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import io.orbitd.android.directory.SearchHit
import io.orbitd.android.directory.SearchHitRow
import io.orbitd.android.directory.SessionDisplay
import io.orbitd.android.directory.SessionMark
import io.orbitd.android.directory.displayFacts
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
 * The search row as drawn, on the server's own hits for the cross-client check's 22 search cases (search-payloads.json; what each says is
 * SearchDisplayRowsTest's): with the facts, it leads with the state icon, its line ends in the state word, every mark has its chip in
 * full on a phone's width, and a screen reader hears the state and the marks; without them, it draws today's line (agent, lifecycle, run
 * state) and no state icon, chip or value.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = io.orbitd.android.TestOrbitApplication::class, qualifiers = "w360dp-h640dp")
class SearchDisplayRowDrawTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val cases = Json.parseToJsonElement(
        File("../../../scripts/acceptance/session-three-state-check/search/search-payloads.json").readText()).jsonArray.map { it.jsonObject }
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
    private val facts = setOf("phase", "released", "lastTurnOutcome", "waitingOn", "endReason", "workFinished", "activity", "runningBgCount")
    private val stateTags = listOf("QUEUED", "RUNNING", "IDLE").map { "session-state-icon:$it" }
    private val markTags = listOf("NEEDS_YOU", "FAILED", "RETRYING", "ON_HOLD", "INTERRUPTED", "BACKGROUND", "WILL_RESUME", "FINISHED", "ENDED")

    private fun present(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun values() = compose.onNodeWithTag("search-row", useUnmergedTree = true).fetchSemanticsNode().let { node ->
        (listOf(node) + node.children).mapNotNull { it.config.getOrNull(SemanticsProperties.StateDescription) }
    }

    @Test fun everyCaseDrawsItsStateAndMarksWithTheFactsAndTodaysLineWithout() {
        val hits = cases.flatMap { case ->
            val p = case["searchHit"]!!.jsonObject
            listOf(false to p, true to JsonObject(p - facts)).map { (older, payload) ->
                Triple(case["name"]!!.jsonPrimitive.content, older, json.decodeFromJsonElement(SearchHit.serializer(), payload))
            }
        }
        val shown = mutableStateOf(hits[0].third)
        val widths = mutableMapOf<SessionMark, Int>()
        compose.setContent { OrbitTheme { Box(Modifier.testTag("search-row")) { SearchHitRow(shown.value) {} } } }
        for ((name, older, hit) in hits) {
            shown.value = hit
            compose.waitForIdle()
            val case = "$name${if (older) " without facts" else ""}"
            val state = SessionDisplay.state(hit.displayFacts)
            val marks = SessionDisplay.marks(hit.displayFacts).orEmpty()
            assertEquals("$case state icon", listOfNotNull(state?.let { "session-state-icon:${it.name}" }), stateTags.filter(::present))
            assertEquals("$case chips", markTags.filter { tag -> marks.any { it.name == tag } },
                markTags.filter { present("session-mark:$it") })
            for (mark in marks) {
                val chip = compose.onNodeWithTag("session-mark:${mark.name}", useUnmergedTree = true).assertIsDisplayed()
                // As wide beside two others as alone: a row that ran out of room would squeeze the last chip.
                val width = chip.fetchSemanticsNode().size.width
                assertEquals("$case ${mark.word} chip width", widths.getOrPut(mark) { width }, width)
            }
            assertEquals("$case no +N", false, present("session-mark-more"))
            val word = if (older) hit.runState ?: hit.status else state!!.word
            compose.onNodeWithText("${hit.agent!!.name} · ${hit.lifecycleState} · $word", useUnmergedTree = true).assertIsDisplayed()
            assertEquals("$case value", if (older) listOf() else listOf((listOf(word) + marks.map { it.word }).joinToString(", ")), values())
        }
    }
}
