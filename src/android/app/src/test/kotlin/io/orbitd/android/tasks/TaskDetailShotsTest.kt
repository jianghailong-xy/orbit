package io.orbitd.android.tasks

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
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
import java.io.File
import java.time.Instant

/**
 * The task page led by the agent's work on Android, against iOS boards 04–05 (docs/mocks/task-detail-agent-first): the
 * sections in the iOS order, and frames of a running task's first screen and its lower half, a done task's first screen, its ⋯
 * menu and the Runs with sheet — each drawn by the production `TaskDetail` over the fixture server and written under
 * `src/android/build/evidence/task-detail-agent-first-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TaskDetailShotsTest {
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
        File(root, "src/android/build/evidence/task-detail-agent-first-android").also { it.mkdirs() }
    }

    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private val brief = "Read docs/managed-runner-remote-host-design.md (branch orbit/orbit-prod-ip-10-66-0-1-runner-runner-do-29e980; merge it if your " +
        "base lacks it), decision D1 and Proposal item 2. Then wire one manager per host and place each new managed runner on a host.\\n\\n" +
        "Keep existing single-host configs working unchanged. Add tests for the placement rule and for the docker.hosts parser."
    private val criteria = "The apiserver reads a `docker.hosts` list, opens one remote channel and one manager per host, and places each new " +
        "managed runner on a host; existing single-host configs keep working unchanged."

    /** Board 04's task: running for 1h 12m on Opus 5.5, $0.84 so far, at step 3 of 5, filed from a session, one task waiting on it. */
    private fun running() = """{"id":"${ManagementFixture.TASK}","title":"Apiserver: docker.hosts list, remote channels, one manager per host, placement",
        "status":"IN_PROGRESS","description":"$brief","acceptanceCriteria":"$criteria","createdAt":"${ago(200)}","updatedAt":"${ago(1)}",
        "completionCriterion":"EVIDENCE_JUDGMENT","projectId":"P1","project":{"id":"P1","title":"Managed runners on other Docker hosts (orbitd.io)","status":"OPEN"},
        "modelHintOptions":[{"level":"L","label":"Opus 5.5","effort":"high","model":"claude-opus-5-5","provider":"claude"}],
        "assignee":{"id":"${ManagementFixture.WORKSPACE}","name":"orbit-develop"},
        "creatorSession":{"id":"S0","title":"Managed runners on other Docker hosts"},
        "progress":{"revision":3,"phase":"One manager per host","current":3,"total":5,"message":"Wiring the per-host manager into runners/managed/manager.service.ts",
          "lastProgressAt":"${ago(1)}"},
        "dependsOn":[],"dependedOnBy":[{"task":{"id":"T2","title":"Channel-host kit, /upgrade and the lab","status":"OPEN"}}],
        "comments":[{"id":"C1","authorName":"Fixture","body":"Keep the single-host path as the default.","createdAt":"${ago(150)}"}],
        "sessions":[{"id":"S1","title":"Run","status":"RUNNING","runState":"RUNNING","createdAt":"${ago(72)}","model":"claude-opus-5-5","effort":"high",
          "costUsd":0.84,"agent":{"name":"orbit-develop"}}]}"""

    /** Board 05 B's task: done, its evidence accepted by a reviewing agent, $3.12 across its runs. */
    private fun done() = """{"id":"${ManagementFixture.TASK}","title":"Docker channel: listen on a private address with allowPeers","status":"DONE",
        "description":"$brief","acceptanceCriteria":"The channel can listen on one private IPv4 address with a required allowPeers list.",
        "createdAt":"${ago(300)}","updatedAt":"${ago(20)}","completionCriterion":"EVIDENCE_JUDGMENT","projectId":"P1",
        "project":{"id":"P1","title":"Managed runners on other Docker hosts (orbitd.io)","status":"OPEN"},
        "modelHintOptions":[{"level":"L","label":"Opus 5.5","effort":"high","model":"claude-opus-5-5","provider":"claude"}],
        "assignee":{"id":"${ManagementFixture.WORKSPACE}","name":"orbit-develop"},"dependsOn":[],"dependedOnBy":[],"comments":[],
        "sessions":[{"id":"S1","title":"Run","status":"SUCCEEDED","runState":"SUCCEEDED","createdAt":"${ago(120)}","model":"claude-opus-5-5","effort":"high",
          "costUsd":3.12,"agent":{"name":"orbit-develop"}}]}"""

    private fun evidence() = """[{"revision":"1","submittedAt":"${ago(40)}","evidence":{"claim":"The channel listens on one private IPv4 with a required allowPeers list; other sources are closed before a request is read; 0.0.0.0, public and empty-allowPeers configs are refused.",
        "gaps":[],"checks":[{"kind":"TOOL_CALL","ref":"toolu_1","command":"python3 -B -m unittest discover -s scripts/managed-runner","succeeded":true},
        {"kind":"COMMIT","ref":"7c41e9a0b123456"}]},"decision":{"decision":"CONFIRM","decidedAt":"${ago(30)}","decidedByType":"AGENT"}}]"""

    @Before fun start() { fixture.reset() }

    private fun page(task: String, evidence: String = "[]") {
        fixture.task = task; fixture.evidence = evidence
        val app = RuntimeEnvironment.getApplication() as OrbitApplication
        // Connected, as a reader on a phone is: the presses and the menu are live.
        app.realtime.setNetwork(true, "fixture")
        runBlocking { fixture.signIn(app.session) }
        compose.waitUntil(60_000) { app.realtime.state.value.controlConnection == io.orbitd.android.core.realtime.ConnectionState.CONNECTED }
        val handle = (app.session.state.value as AuthState.SignedIn).handle
        compose.setContent { OrbitTheme(darkTheme = false) { Surface { TaskDetail(app, handle, ManagementFixture.TASK, 0, {}, {}) } } }
        compose.waitUntil(60_000) { compose.onAllNodesWithTag("task-status-line").fetchSemanticsNodes().isNotEmpty() }
        if (evidence != "[]") compose.waitUntil(60_000) { compose.onAllNodesWithTag("task-evidence").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
    }

    /** Every window the app has open — the Activity, then any dialog or menu over it — drawn where it sits. */
    @Suppress("UNCHECKED_CAST")
    private fun shot(name: String) {
        compose.waitForIdle()
        val global = Class.forName("android.view.WindowManagerGlobal").getMethod("getInstance").invoke(null)
        val views = (global.javaClass.getDeclaredField("mViews").apply { isAccessible = true }.get(global) as List<View>).filter { it.isShown }
        val base = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(base.width, base.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.WHITE)
        views.forEach { view ->
            val at = IntArray(2).also(view::getLocationOnScreen)
            canvas.save(); canvas.translate(at[0].toFloat(), at[1].toFloat())
            if (view !== base) canvas.drawColor(0x52000000, android.graphics.PorterDuff.Mode.SRC_OVER)
            view.draw(canvas); canvas.restore()
        }
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun headings(): List<String> = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading), useUnmergedTree = true)
        .fetchSemanticsNodes().sortedBy { it.boundsInRoot.top }
        .mapNotNull { node -> node.children.firstNotNullOfOrNull { it.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text } }

    /** The sections in the iOS page's order, on a page tall enough that the lazy list composes every one of them. */
    @Test @Config(qualifiers = "w411dp-h4000dp")
    fun theSectionsAreInTheIOSPagesOrder() {
        page(running(), evidence())
        assertEquals(listOf(TaskDetailCopy.nowHeading, TaskDetailCopy.evidenceHeading, TaskDetailCopy.doneMeansHeading, TaskDetailCopy.briefHeading,
            TaskDetailCopy.planHeading, TaskDetailCopy.runsWithHeading, TaskDetailCopy.activityHeading), headings())
        // The status line: running with how long, who, what the run is on, and what it has cost.
        compose.onNodeWithText("Running · 1h 12m").assertExists()
        compose.onNodeWithText("· Opus 5.5").assertExists()
        compose.onNodeWithText("· $0.84").assertExists()
        compose.onNodeWithText("Step 3 of 5").assertExists()
        compose.onNodeWithText(TaskDetailCopy.isWorking("orbit-develop")).assertExists()
        // The plan is a sentence, the graph folded in place.
        compose.onNodeWithText("Nothing blocks this task. “Channel-host kit, /upgrade and the lab” waits on it.").assertExists()
        compose.onNodeWithText(TaskDetailCopy.showGraph).assertExists()
        // The comment box writes to the run while one is going.
        compose.onNodeWithTag("task-compose-target").assertTextContains(TaskDetailCopy.toTheRun, substring = true)
        // Activity, oldest first: filed, the comment, then the run.
        val filed = compose.onNodeWithTag("task-filed").fetchSemanticsNode().boundsInRoot.top
        val comment = compose.onNodeWithText("Keep the single-host path as the default.").fetchSemanticsNode().boundsInRoot.top
        val run = compose.onNodeWithTag("task-run:S1").fetchSemanticsNode().boundsInRoot.top
        assertTrue("filed $filed < comment $comment < run $run", filed < comment && comment < run)
        // Attribution and Followed by say nothing here, so they are not drawn.
        compose.onAllNodesWithText(TaskDetailCopy.attributionHeading).assertCountEquals(0)
        compose.onAllNodesWithText(TaskDetailCopy.followedByHeading).assertCountEquals(0)
        shot("00-running-whole-page")
    }

    @Test fun runningFirstScreen() {
        page(running())
        shot("01-running-first-screen")
        compose.onNodeWithTag("task-detail").performScrollToNode(hasTestTag("task-activity"))
        shot("02-running-scrolled")
    }

    /** A done task: Delivered first, no press under the title, and Reopen task / Run again / Follow task / Add prerequisite in ⋯. */
    @Test fun doneFirstScreenMenuAndRunsWithSheet() {
        page(done(), evidence())
        compose.onNodeWithText(TaskDetailCopy.deliveredHeading).assertExists()
        compose.onAllNodesWithTag("task-run").assertCountEquals(0)
        shot("03-done-first-screen")
        compose.onNodeWithTag("task-menu").performClick()
        listOf(TaskReopenCopy.actionLabel, TaskDetailCopy.runAgain, TaskDetailCopy.followTask, TaskDetailCopy.addPrerequisite)
            .forEach { compose.onNodeWithText(it).assertExists() }
        shot("04-done-menu")
        compose.onNodeWithText(TaskDetailCopy.followTask).performClick() // closes the menu; the follow sheet opens
        compose.waitForIdle()
        compose.onNodeWithTag("task-sheet-cancel").performClick()
        compose.onNodeWithTag("task-detail").performScrollToNode(hasTestTag("task-runs-with"))
        compose.onNodeWithTag("task-runs-with").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("task-assignee").fetchSemanticsNodes().isNotEmpty() }
        shot("05-runs-with-sheet")
    }
}
