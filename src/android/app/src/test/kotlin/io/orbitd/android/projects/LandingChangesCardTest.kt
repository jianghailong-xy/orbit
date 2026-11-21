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

    @Test fun theSettingsEntryOpensHistoryAndRevertRequiresConfirmation() {
        val view = json("""{"line":"PROJECT_BRANCH","landingCheckCommand":"make fast",
            "landingCheck":{"command":"make fast","setBy":"COORDINATOR","setAt":"2026-11-21T10:00:00Z"}}""")
        val change = """{"id":"change-1","field":"LANDING_CHECK","origin":"COORDINATOR","createdAt":"2026-11-21T10:00:00Z",
            "oldValue":{"none":false},"newValue":{"none":false,"command":"make fast"},"reason":"Faster feedback","revertible":true}"""
        val doc = json("""{"settingChanges":[$change]}""")
        val state = ProjectPageState().apply { integration = view }
        val writes = mutableListOf<String>()
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme {
            var open by remember { mutableStateOf(false) }
            var history by remember { mutableStateOf(ProjectSettingChange.read(doc)) }
            Column(Modifier.verticalScroll(rememberScrollState())) {
                RunSettingsSection(state, doc, now, true, {}, {}, {}, {}, {}, openLandingChanges = { open = true })
            }
            if (open) LandingChangesSheet(history, now, enabled = true, revert = { id ->
                writes += id
                history = history.map { if (it.id == id) it.copy(revertible = false, revertedAt = now.toString()) else it }
                null
            }, openTask = {}, close = { open = false })
        } } }
        compose.onNodeWithText("Coordinator · set 2h ago").assertExists()
        compose.onNodeWithText("1 change ›").assertExists()
        compose.onNodeWithTag("project-landing-changes").performScrollTo().performClick()
        compose.onNodeWithTag("landing-changes-sheet").assertExists()
        compose.onNodeWithText("Uses merge check → make fast").assertExists()
        compose.onNodeWithText("Faster feedback").assertExists()

        val revert = compose.onNodeWithTag("landing-change-revert:change-1")
        revert.performClick()
        compose.onNodeWithText("Revert this change?").assertIsDisplayed()
        compose.onNodeWithText("Landing check goes back from make fast to Uses merge check.\n" +
            "The coordinator can no longer change this field without a card.").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle { Assert.assertTrue(writes.isEmpty()) }

        revert.performClick()
        compose.onNodeWithTag("landing-change-revert-confirm").performClick()
        compose.runOnIdle { Assert.assertEquals(listOf("change-1"), writes) }
        revert.assertDoesNotExist()
        compose.onNodeWithText("Reverted by you · just now · coordinator needs a card for this field").assertExists()
    }

    @Test fun noCheckHidesTheCommandAndTimeoutAndWritesTheNamedValue() {
        val view = json("""{"line":"PROJECT_BRANCH","landingCheckCommand":"make fast","landingCheckTimeoutSeconds":600,
            "landingCheck":{"command":"make fast","setBy":"CARD"}}""")
        val state = ProjectPageState().apply { integration = view }
        val writes = mutableListOf<JsonObject?>()
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme {
            var editing by remember { mutableStateOf(false) }
            Column(Modifier.verticalScroll(rememberScrollState())) {
                RunSettingsSection(state, json("{}"), now, true, {}, {}, {}, {}, {}, editLandingCheck = { editing = true })
            }
            if (editing) LandingCheckEditor(view, now, enabled = true, close = { editing = false }) {
                writes += it
                null
            }
        } } }
        compose.onNodeWithTag("project-landing-check").performScrollTo().performClick()
        compose.onNode(hasText("Merge check") and isSelectable()).assertExists()
        compose.onNodeWithTag("landing-check-command").assertExists()
        compose.onNodeWithText("No check").performClick()
        compose.onNodeWithTag("landing-check-command").assertDoesNotExist()
        compose.onNodeWithTag("landing-check-timeout").assertDoesNotExist()
        compose.onNodeWithText("Who can set it").assertExists()
        compose.onNodeWithText("Save").performClick()
        compose.runOnIdle { Assert.assertEquals(listOf(json("""{"landingCheck":"NONE"}""")), writes) }
    }
}
