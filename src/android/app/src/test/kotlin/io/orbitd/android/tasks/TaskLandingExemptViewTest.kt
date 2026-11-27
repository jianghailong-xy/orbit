package io.orbitd.android.tasks

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.material3.Surface
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.management.ManagementFixture
import io.orbitd.android.management.ManagementShellApplication
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A task's landing-check exemption on its page (revision 42 part two, D5), as the web's `TaskDetailPanel.test.tsx` holds it: Exempt
 * with its reason, who marked it and when, and Remove exemption; nothing for a task that is not exempt; and the section for an exempt
 * task with no landing yet. Ported from main's second Android port (22189bf97a) onto this project's `TaskExemptionRow`. Each state's frame, light and dark, is written under `src/android/build/evidence/task-landing-exempt-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h4000dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TaskLandingExemptViewTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/task-landing-exempt-android").also { it.mkdirs() }
    }

    private val reason = "Only moves cron entries; the landing check needs a database this task cannot reach."
    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()

    private fun task(status: String, exempt: Boolean, landed: Boolean) = """{"id":"${ManagementFixture.TASK}","title":"Move the nightly cron entries",
        "status":"$status","description":"Move them.","createdAt":"${ago(200)}","updatedAt":"${ago(1)}","completionCriterion":"EVIDENCE_JUDGMENT",
        "projectId":"P1","project":{"id":"P1","title":"Nightly jobs","status":"OPEN"},
        "landingCheckExempt":$exempt,"landingCheckExemptReason":${if (exempt) "\"$reason\"" else "null"},
        "landingCheckExemptBySessionId":${if (exempt) "\"S-coord\"" else "null"},"landingCheckExemptOwnerSetAt":null,
        ${if (landed) """"integration":{"state":"ON_INTEGRATION_LINE","landTask":{"jobId":"j1","state":"LANDED","generation":"1",
          "targetRef":"refs/heads/project/nightly","queuedAt":"${ago(12)}","startedAt":"${ago(11)}","finishedAt":"${ago(10)}","waitMs":40000}},""" else ""}
        "assignee":{"id":"${ManagementFixture.WORKSPACE}","name":"orbit-develop"},"dependsOn":[],"dependedOnBy":[],"comments":[],"sessions":[]}"""

    private fun project() = """{"id":"P1","title":"Nightly jobs","settingChanges":[{"id":"c1","projectId":"P1","taskId":"${ManagementFixture.TASK}",
        "field":"TASK_LANDING_CHECK_EXEMPT","origin":"COORDINATOR","oldValue":{"exempt":false,"reason":null},"newValue":{"exempt":true,"reason":"$reason"},
        "reason":"$reason","writtenBySessionId":"S-coord","revertsChangeId":null,"revertedAt":null,"revertible":true,"createdAt":"${ago(20)}"}]}"""

    @Before fun start() { fixture.reset() }

    /** The page's theme: one composition per test, so light and dark are the same page redrawn. */
    private val dark = androidx.compose.runtime.mutableStateOf(false)

    private fun page(task: String) {
        fixture.task = task; fixture.project = project()
        val app = RuntimeEnvironment.getApplication() as OrbitApplication
        app.realtime.setNetwork(true, "fixture")
        runBlocking { fixture.signIn(app.session) }
        compose.waitUntil(60_000) { app.realtime.state.value.controlConnection == io.orbitd.android.core.realtime.ConnectionState.CONNECTED }
        val handle = (app.session.state.value as AuthState.SignedIn).handle
        compose.setContent { OrbitTheme(darkTheme = dark.value) { Surface { TaskDetail(app, handle, ManagementFixture.TASK, 0, {}, {}) } } }
        compose.waitUntil(60_000) { compose.onAllNodesWithTag("task-status-line").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
    }

    /** The Landing section, heading included, cut out of the page as it is drawn. */
    private fun shot(name: String) {
        compose.waitForIdle()
        val base = compose.activity.window.decorView
        val full = Bitmap.createBitmap(base.width, base.height, Bitmap.Config.ARGB_8888)
        base.draw(Canvas(full))
        val bounds = compose.onNodeWithTag("task-landing-exempt").fetchSemanticsNode().boundsInWindow
        val pad = (12 * compose.density.density).toInt()
        val top = max(0, (compose.onAllNodesWithTag("task-landing").fetchSemanticsNodes().firstOrNull()?.boundsInWindow?.top ?: bounds.top).toInt() -
            (44 * compose.density.density).toInt())
        val bottom = min(full.height, bounds.bottom.toInt() + pad)
        val cut = Bitmap.createBitmap(full, 0, top, full.width, bottom - top)
        File(output, "$name.png").outputStream().use { cut.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun anExemptTaskReadsExemptWithItsReasonWhoMarkedItAndAWayToRemoveIt() {
        page(task("DONE", exempt = true, landed = true))
        listOf(false, true).forEach { dark ->
            this.dark.value = dark
            compose.waitUntil(60_000) { compose.onAllNodesWithText("marked 20m ago", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
            val block = hasAnyAncestor(hasTestTag("task-landing-exempt"))
            compose.onNode(hasText("Landing check") and block, useUnmergedTree = true).assertExists()
            compose.onNodeWithTag("task-landing-exempt-chip", useUnmergedTree = true).assertTextEquals("Exempt")
            compose.onNodeWithTag("task-landing-exempt-reason", useUnmergedTree = true).assertTextEquals(reason)
            compose.onNodeWithTag("task-landing-exempt-by:who", useUnmergedTree = true).assertTextEquals("Coordinator")
            compose.onNode(hasText("marked 20m ago") and hasAnyAncestor(hasTestTag("task-landing-exempt-by")), useUnmergedTree = true).assertExists()
            compose.onNodeWithTag("task-landing-exempt-remove").assertTextEquals("Remove exemption").assertIsEnabled()
            // Its landing still reads as it did, above the exemption.
            compose.onNodeWithTag("task-landing-badge").assertTextEquals("Landed")
            assertTrue(compose.onNodeWithTag("task-landing-badge").fetchSemanticsNode().boundsInRoot.top <
                compose.onNodeWithTag("task-landing-exempt").fetchSemanticsNode().boundsInRoot.top)
            shot(if (dark) "exempt-landed-dark" else "exempt-landed-light")
        }
    }

    @Test fun removeExemptionWritesTheFlagOff() {
        page(task("DONE", exempt = true, landed = true))
        compose.onNodeWithTag("task-landing-exempt-remove").performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.bodies.any { it.startsWith("PATCH tasks/${ManagementFixture.TASK}") } }
        assertEquals(listOf("""PATCH tasks/${ManagementFixture.TASK} {"landingCheckExempt":false}"""),
            fixture.bodies.filter { it.startsWith("PATCH tasks/") })
    }

    @Test fun anExemptTaskWithNoLandingYetStillHasTheSectionForItsExemption() {
        page(task("OPEN", exempt = true, landed = false))
        listOf(false, true).forEach { dark ->
            this.dark.value = dark
            compose.waitUntil(60_000) { compose.onAllNodesWithText("marked 20m ago", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("task-landing-exempt").assertExists()
            compose.onNodeWithTag("task-landing-badge").assertDoesNotExist()
            compose.onNodeWithTag("task-landing-open").assertDoesNotExist()
            shot(if (dark) "exempt-no-landing-dark" else "exempt-no-landing-light")
        }
    }

    @Test fun aTaskThatIsNotExemptDrawsNoneOfIt() {
        page(task("DONE", exempt = false, landed = true))
        compose.onNodeWithTag("task-landing").assertExists()
        compose.onNodeWithTag("task-landing-exempt").assertDoesNotExist()
        // No project read for a task that is not exempt.
        assertTrue(fixture.calls.none { it == "GET projects/P1" })
    }
}
