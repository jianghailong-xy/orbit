package io.orbitd.android.projects

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.ProjectShell
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.*
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** How it runs' landing check and the coordinator's changes, drawn: ported from main's bc61299579 (its own Android port, removed in
 * this merge) onto this implementation's composables — Settings' row opens the list, Revert asks first and Cancel writes nothing,
 * an exemption's row opens its task, and No check says who can set it and writes the named value. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1000dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LandingChangesCardTest {
    @get:Rule(order = 0) val dispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<MainActivity>()
    @Before fun reset() = ProjectShell.reset()

    private val now = Instant.parse("2026-11-21T12:00:00Z")
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject

    private val change = """{"id":"change-1","projectId":"p1","taskId":null,"field":"LANDING_CHECK","origin":"COORDINATOR",
        "createdAt":"2026-11-21T10:00:00Z","oldValue":{"command":null,"timeoutSeconds":null,"none":false},
        "newValue":{"command":"make fast","timeoutSeconds":null,"none":false},"reason":"Faster feedback","writtenBySessionId":"s1",
        "revertsChangeId":null,"revertedAt":null,"revertible":true}"""
    private val exemption = """{"id":"change-2","projectId":"p1","taskId":"task-1","field":"TASK_LANDING_CHECK_EXEMPT","origin":"COORDINATOR",
        "createdAt":"2026-11-21T09:00:00Z","oldValue":{"exempt":false,"reason":null},"newValue":{"exempt":true,"reason":"Docs"},
        "reason":"Docs","writtenBySessionId":"s1","revertsChangeId":null,"revertedAt":null,"revertible":true}"""

    @Test fun theSettingsRowOpensTheListAndRevertAsksFirst() {
        val view = json("""{"line":"PROJECT_BRANCH","landingCheckCommand":"make fast",
            "landingCheck":{"command":"make fast","setBy":"COORDINATOR","setAt":"2026-11-21T10:00:00Z"}}""")
        val state = ProjectPageState().apply { integration = view }
        val writes = mutableListOf<String>()
        val opened = mutableListOf<String>()
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme {
            var doc by remember { mutableStateOf(json("""{"title":"Payments","settingChanges":[$change,$exemption]}""")) }
            Column(Modifier.verticalScroll(rememberScrollState())) {
                RunSettingsSection(state, doc, now, true, {}, {}, {}, {}, {}, revertChange = { reverted ->
                    writes += reverted.id
                    // The page reads the project again after a revert; the server marks the row it put back.
                    val put = change.replace("\"revertedAt\":null,\"revertible\":true", "\"revertedAt\":\"$now\",\"revertible\":false")
                    doc = json("""{"title":"Payments","settingChanges":[$put,$exemption]}""")
                    null
                }, openTask = { opened += it })
            }
        } } }
        compose.onNodeWithTag("project-landing-check-by:who", useUnmergedTree = true).assertTextEquals("Coordinator")
        compose.onNodeWithText("set 2h ago", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("project-coordinator-changes-count", useUnmergedTree = true).assertTextEquals("2 changes  ›")
        compose.onNodeWithTag("project-coordinator-changes").performScrollTo().performClick()
        compose.onNodeWithTag("coordinator-changes").assertExists()
        compose.onNodeWithTag("change:change-1:values", useUnmergedTree = true).assertTextEquals("Uses merge check  →  make fast")
        compose.onNodeWithText("Faster feedback").assertExists()

        compose.onNodeWithTag("change:change-1:revert").performClick()
        compose.onNodeWithText("Revert this change?").assertIsDisplayed()
        compose.onNodeWithTag("revert-sheet-body", useUnmergedTree = true).assertTextEquals("Landing check goes back from make fast to Uses merge check.")
        compose.onNodeWithText("The coordinator can no longer change this field without a card.").assertIsDisplayed()
        compose.onNodeWithTag("revert-sheet-cancel").performClick()
        compose.runOnIdle { Assert.assertTrue("Cancel writes nothing", writes.isEmpty()) }

        compose.onNodeWithTag("change:change-1:revert").performClick()
        compose.onNodeWithTag("revert-sheet-confirm").performClick()
        compose.runOnIdle { Assert.assertEquals(listOf("change-1"), writes) }
        compose.onNodeWithTag("change:change-1:revert").assertDoesNotExist()
        compose.onNodeWithTag("change:change-1:note", useUnmergedTree = true)
            .assertTextEquals("Reverted by you · just now · coordinator needs a card for this field")

        // An exemption's row opens the task it is about; a landing check's has no task to open.
        compose.onNodeWithTag("change:change-1:open-task").assertDoesNotExist()
        compose.onNodeWithTag("change:change-2:open-task").performScrollTo().assertTextEquals(LandingMeasuredCopy.openTask).performClick()
        compose.runOnIdle { Assert.assertEquals(listOf("task-1"), opened) }
        compose.onNodeWithTag("coordinator-changes").assertDoesNotExist()
    }

    @Test fun noCheckHidesTheCommandAndTimeoutSaysWhoCanSetItAndWritesTheNamedValue() {
        val writes = mutableListOf<JsonObject?>()
        val command = json("""{"line":"PROJECT_BRANCH","landingCheckCommand":"make fast","landingCheckTimeoutSeconds":600,
            "landingCheck":{"command":"make fast","setBy":"CARD"}}""")
        val none = json("""{"line":"PROJECT_BRANCH","landingCheckCommand":null,"landingCheckTimeoutSeconds":600,
            "landingCheck":{"command":"NONE","setBy":"OWNER"}}""")
        var view by mutableStateOf(command)
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme {
            val state = ProjectPageState().apply { integration = view }
            Column(Modifier.verticalScroll(rememberScrollState())) {
                RunSettingsSection(state, json("{}"), now, true, {}, { writes += it }, {}, {}, {})
            }
        } } }
        compose.onNodeWithTag("project-landing-check-command", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("600 seconds").assertExists()
        compose.onNodeWithTag("project-landing-check-who-can-set").assertDoesNotExist()
        compose.onNodeWithTag("project-landing-check-mode:NONE").performScrollTo().performClick()
        compose.runOnIdle { Assert.assertEquals(listOf(json("""{"landingCheck":"NONE"}""")), writes) }

        compose.runOnUiThread { view = none }
        compose.waitForIdle()
        compose.onNodeWithTag("project-landing-check-command", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("600 seconds").assertDoesNotExist()
        compose.onNodeWithTag("project-landing-check-none", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("project-landing-check-who-can-set").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(LandingMeasuredCopy.whoCanSet).assertExists()
        for ((by, note) in LandingMeasuredCopy.originNotes) {
            compose.onNodeWithTag("project-landing-check-who-can-set:$by:who", useUnmergedTree = true).assertTextEquals(LandingMeasuredCopy.who(by))
            compose.onNodeWithText(note, useUnmergedTree = true).assertExists()
        }
    }

    /** As web's list (`change.origin !== 'COORDINATOR'`) and OrbitKit's rows: the owner's own change and one a card approved say there is
     * nothing to revert; a coordinator's change that moved on since has no door and says nothing. */
    @Test fun aRowWithNothingToRevertSaysWhyOnlyWhenItIsNotTheCoordinators() {
        fun row(id: String, origin: String, revertible: Boolean) = """{"id":"$id","projectId":"p1","taskId":null,"field":"LANDING_CHECK",
            "origin":"$origin","createdAt":"2026-11-21T10:00:00Z","oldValue":{"command":null,"timeoutSeconds":null,"none":false},
            "newValue":{"command":null,"timeoutSeconds":null,"none":true},"reason":null,"writtenBySessionId":null,"revertsChangeId":null,
            "revertedAt":null,"revertible":$revertible}"""
        val doc = json("""{"title":"Payments","settingChanges":[${row("card", "CARD", false)},${row("owner", "OWNER", false)},
            ${row("stale", "COORDINATOR", false)}]}""")
        val state = ProjectPageState().apply { integration = json("""{"line":"PROJECT_BRANCH","landingCheckCommand":null}""") }
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme {
            Column(Modifier.verticalScroll(rememberScrollState())) { RunSettingsSection(state, doc, now, true, {}, {}, {}, {}, {}) }
        } } }
        compose.onNodeWithTag("project-coordinator-changes").performScrollTo().performClick()
        for (id in listOf("card", "owner")) {
            compose.onNodeWithTag("change:$id:note", useUnmergedTree = true).assertTextEquals(LandingMeasuredCopy.yourChange)
            compose.onNodeWithTag("change:$id:revert").assertDoesNotExist()
        }
        compose.onNodeWithTag("change:stale:note", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("change:stale:revert").assertDoesNotExist()
    }
}
