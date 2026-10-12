package io.orbitd.android.composer

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.tasks.TaskDetailCopy
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The composer's model chip on a task run smart selection routed (iOS 6826eed7e, 4622c6a60, 7c49be60a; ModelRoutingLogicTests): marked
 * ✦ only while the run is still on the model the decision applied and the account's switch is on, named aloud as iOS names it, and
 * its menu opening on the tier, the first reason and the note a sentence an item. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class SmartSelectionChipTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun route(level: String? = "L", model: String = "claude-opus-5-5", applied: Boolean = true) = buildJsonObject {
        put("level", level); put("model", model); put("effort", "high"); put("applied", applied)
        put("reasons", JsonArray(listOf(JsonPrimitive("Touches the dispatch path across two modules"), JsonPrimitive("second reason"))))
    }

    @Test fun theChipIsMarkedOnlyWhileATaskRunIsOnItsPick() {
        val picked = route()
        assertEquals(picked, smartRoute("T", picked, "claude-opus-5-5", smartSelection = true))
        assertNull("a model changed here is this run's own", smartRoute("T", picked, "claude-sonnet-5-5", smartSelection = true))
        assertNull("a session opened by hand", smartRoute(null, picked, "claude-opus-5-5", smartSelection = true))
        assertNull("a shadow-only run", smartRoute("T", route(applied = false), "claude-opus-5-5", smartSelection = true))
        assertNull("a decision that named no tier", smartRoute("T", route(level = null), "claude-opus-5-5", smartSelection = true))
        assertNull(smartRoute("T", null, "claude-opus-5-5", smartSelection = true))
        assertNull("the account's switch off: never marked", smartRoute("T", picked, "claude-opus-5-5", smartSelection = false))
    }

    @Test fun theNoteIsShownASentenceAnItemAndTheEffortIsNamedAsIOSNamesIt() {
        val note = TaskDetailCopy.modelChangeAppliesToThisRun
        assertEquals(listOf("Changing the model here applies to this run only.", "To fix the model for every run, set it on the task."), sentences(note))
        assertEquals(note, sentences(note).joinToString(" "))
        assertEquals(listOf("One sentence."), sentences("One sentence."))
        assertEquals("Picked by smart selection · tier L", TaskDetailCopy.pickedBySmartSelection("L"))
        assertEquals(listOf("Default", "Default", "xHigh", "High", "Max"), listOf(null, "", "xhigh", "high", "max").map(::effortLabel))
    }

    @Test fun theMarkedChipCarriesTheStarAndSaysItWasPicked() {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Column { ModelChip("claude-opus-5-5", "High", smart = true, enabled = true) {}; SmartRouteNote(route()) }
        } } }
        compose.waitForIdle()
        compose.onNodeWithTag("composer-model").assertContentDescriptionEquals("Model claude-opus-5-5, effort High, picked by smart selection")
        compose.onNodeWithTag("composer-model-smart", useUnmergedTree = true).assertExists().assertTextEquals("✦")
        compose.onNodeWithText("✦ Picked by smart selection · tier L").assertExists()
        compose.onNodeWithText("Touches the dispatch path across two modules").assertExists()
        compose.onAllNodesWithText("second reason").assertCountEquals(0)
        compose.onNodeWithText("Changing the model here applies to this run only.").assertExists()
        compose.onNodeWithText("To fix the model for every run, set it on the task.").assertExists()
    }

    @Test fun anUnmarkedChipIsTheModelAlone() {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) { ModelChip("gpt-6-astra", "Default", smart = false, enabled = true) {} } } }
        compose.waitForIdle()
        compose.onNodeWithTag("composer-model").assertContentDescriptionEquals("Model gpt-6-astra, effort Default")
        compose.onAllNodesWithTag("composer-model-smart", useUnmergedTree = true).assertCountEquals(0)
        compose.onNodeWithText("gpt-6-astra").assertExists()
    }
}
