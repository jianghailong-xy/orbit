package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.tasks.TaskDetail
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Instant

/** The account's switch for smart model selection (iOS 9fb3ae6ee, 614a21410; A13-14): Settings → Sessions has it, written alone as
 * preferences.modelRouting, and while it is off — the default — the task page and the workspace form draw none of smart selection. */
@RunWith(RobolectricTestRunner::class)
// Tall enough that the task page's lazy list composes every section: what is absent is absent, not below the fold.
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h4000dp")
class SmartSelectionGateTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    private val fixture = ManagementFixture
    private var revision by mutableLongStateOf(0L)

    /** A task the coordinator suggested a tier for, with one run smart selection routed and one it would have. */
    private fun task(): String {
        val at = Instant.now().minusSeconds(3_600).toString()
        val option = { level: String, label: String, effort: String, model: String ->
            """{"level":"$level","label":"$label","effort":"$effort","model":"$model","provider":"claude"}""" }
        return """{"id":"${ManagementFixture.TASK}","title":"Fixture task","status":"OPEN","description":"Do the thing.","createdAt":"$at","updatedAt":"$at",
            "modelHint":"M","modelHintReason":"A well-specified fix.",
            "modelHintOptions":[${option("S", "Sonnet 5.5", "low", "claude-sonnet-5-5")},${option("M", "Sonnet 5.5", "medium", "claude-sonnet-5-5")},
              ${option("L", "Opus 5.5", "high", "claude-opus-5-5")},${option("XL", "Opus 5.5", "max", "claude-opus-5-5")}],
            "assignee":{"id":"${ManagementFixture.WORKSPACE}","name":"Alpha"},
            "sessions":[{"id":"run-1","title":"Run one","status":"SUCCEEDED","runState":"SUCCEEDED","createdAt":"$at",
                "route":{"level":"M","applied":true,"model":"claude-sonnet-5-5","effort":"medium","provider":"claude","reasons":["Well specified"],"decidedAt":"$at","policyVersion":1}},
              {"id":"run-2","title":"Run two","status":"SUCCEEDED","runState":"SUCCEEDED","createdAt":"$at","model":"claude-opus-5-5","effort":"high",
                "route":{"level":"L","applied":false,"model":"claude-sonnet-5-5","effort":"medium","provider":"claude","reasons":["Shadow"],"decidedAt":"$at","policyVersion":1}}]}"""
    }

    @Before fun start() { fixture.reset(); fixture.task = task() }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }

    private fun taskPage() {
        val app = RuntimeEnvironment.getApplication() as OrbitApplication
        runBlocking { fixture.signIn(app.session) }
        val handle = (app.session.state.value as AuthState.SignedIn).handle
        compose.setContent { TaskDetail(app, handle, ManagementFixture.TASK, 0, {}, {}) }
        await("Fixture task")
        await("Run two")
    }

    @Test fun theTaskPageDrawsNoSmartSelectionWhileTheAccountsSwitchIsOff() {
        taskPage()
        compose.onAllNodesWithTag("task-suggested").assertCountEquals(0)
        compose.onAllNodesWithText("Coordinator:", substring = true).assertCountEquals(0)
        compose.onAllNodesWithText("✦", substring = true).assertCountEquals(0)
        compose.onAllNodesWithText("would have picked", substring = true).assertCountEquals(0)
        compose.onAllNodesWithText("ⓘ").assertCountEquals(0)
        // What a run ran on is still said, from its own row: the second ran on Opus at high.
        compose.onNodeWithText("· Opus 5.5 · high", substring = true).assertExists()
    }

    /** On, everything is as before: Suggested, the coordinator's reason, the routed run's ✦ tier, the shadow run's would-have-picked and ⓘ. */
    @Test fun withTheSwitchOnTheTaskPageAndTheWorkspaceFormAreAsBefore() {
        val app = RuntimeEnvironment.getApplication() as OrbitApplication
        runBlocking { fixture.signIn(app.session) }
        val handle = (app.session.state.value as AuthState.SignedIn).handle
        val api = api()
        var page by mutableStateOf("task")
        compose.setContent {
            CompositionLocalProvider(LocalSmartSelection provides true) {
                if (page == "task") TaskDetail(app, handle, ManagementFixture.TASK, 0, {}, {})
                else WorkspaceSettings(api, ManagementFixture.WORKSPACE, revision, {}, {}, {})
            }
        }
        await("Run two")
        compose.onNodeWithTag("task-suggested").assertExists()
        compose.onNodeWithText("Coordinator: A well-specified fix.").assertExists()
        compose.onNodeWithText("✦ M").assertExists()
        compose.onNodeWithText("would have picked", substring = true).assertExists()
        compose.onAllNodesWithText("ⓘ").assertCountEquals(2)
        page = "workspace"
        await("Smart model selection for tasks")
        compose.onNodeWithText("Task runs").assertExists()
    }

    @Test fun theWorkspaceFormHasNoTaskRunsWhileTheSwitchIsOff() {
        val api = api()
        compose.setContent { WorkspaceSettings(api, ManagementFixture.WORKSPACE, revision, {}, {}, {}) }
        await("Working directory")
        compose.onAllNodesWithText("Task runs").assertCountEquals(0)
        compose.onAllNodesWithText("Smart model selection for tasks").assertCountEquals(0)
    }

    /** The switch is the whole app's at once: what AccountAppearance hands every page — the composer's ✦ (A11c) as much as the task
     * page — follows Settings the moment the server took the change. */
    @Test fun settingsSwitchIsTheWholeAppsAtOnce() {
        val app = RuntimeEnvironment.getApplication() as OrbitApplication
        runBlocking { fixture.signIn(app.session) }
        val api = ManagementApi(app.session, (app.session.state.value as AuthState.SignedIn).handle)
        compose.setContent {
            AccountAppearance(app) {
                Column {
                    Text("smart selection: " + if (LocalSmartSelection.current) "on" else "off")
                    SettingsScreen(api, OrbitRoute(Destination.SETTINGS), revision, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                        deviceAlerts = { true }, notifications = {}, about = {})
                }
            }
        }
        await("smart selection: off"); await("Smart model selection")
        compose.onNode(hasText("Smart model selection") and isToggleable()).performScrollTo().performClick()
        await("smart selection: on")
        assertEquals(true, fixture.modelRouting)
    }

    @Test fun settingsHasTheSwitchWrittenAloneAsModelRouting() {
        val api = api()
        compose.setContent {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS), revision, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
        await("Smart model selection")
        compose.onNodeWithText("Coordinators suggest a tier for each task, and Agents you turn this on for run their tasks on that tier's model " +
            "and effort. Off: tasks run exactly as before.", useUnmergedTree = true).assertExists()
        val row = hasText("Smart model selection") and isToggleable()
        compose.onNode(row).assertIsOff()
        compose.onNode(row).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.modelRouting == true }
        compose.waitUntil(60_000) { runCatching { compose.onNode(row).assertIsOn() }.isSuccess }
        assertEquals("written alone", 1, fixture.writes("users/me/preferences").size)
    }
}
