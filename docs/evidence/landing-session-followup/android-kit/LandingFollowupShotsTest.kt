package io.orbitd.android

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.cards.ExceptionCard
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.CardActionState
import io.orbitd.android.core.cards.CardCatalog
import io.orbitd.android.core.cards.InteractionCard
import io.orbitd.android.projects.ProjectLandingCardView
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.reader.SourceLandingChip
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * EVIDENCE KIT, not part of the app's tests (task 34jBwFmcEPK012TsNL0Lc, the landing-session follow-up): NATIVE frames of what that
 * task changed on Android, light and dark, against docs/mocks/landing-session/v4/04, 06 and 07. The Landings group's Earlier row with
 * a zero count left out and gone when both are zero; the Landing card when its only job is a merge job (no task-landing sentence) next
 * to a task's (which keeps it); the round line by job kind on the card's head and the X-E5 card's Step row; and the source session's
 * landing label with its ring. Every check here has a count of 1, so a LAND_TASK's `of 3` can only come from its kind.
 *
 * It compiles into the app's unit tests through `kit.gradle` (an init script that adds this directory to the test source set) and
 * writes `src/android/build/evidence/landing-session-followup/<theme>/`, beside each frame's semantics tree.
 */
abstract class LandingFollowupShots {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    protected abstract val theme: String
    protected abstract val dark: Boolean

    @Before fun start() = ProjectShell.reset()

    private val launch = ProjectShell.LAUNCH
    private val landing = ProjectShell.LANDING
    private fun ago(minutes: Long): String = Instant.now().minusSeconds(minutes * 60).toString()
    private fun q(value: String?): String = value?.let { "\"$it\"" } ?: "null"

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/landing-session-followup/$theme").also { it.mkdirs() }
    }

    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = dark) {
            Surface(color = MaterialTheme.colorScheme.background) { content() }
        } } }
        compose.waitForIdle()
    }

    // MARK: 04 c1 — the Landings group's Earlier row

    @Test fun theEarlierRowLeavesOutAZeroCount() {
        landings(listOf("LANDED"))
        await { exists(hasTestTag("landings:earlier")) }
        compose.onNodeWithTag("landings:earlier").assert(hasText("Earlier · 1 landed"))
        shot("01-earlier-landed")
    }

    @Test fun theEarlierRowLeavesOutAZeroLanded() {
        landings(listOf("NOTHING_TO_LAND"))
        await { exists(hasTestTag("landings:earlier")) }
        compose.onNodeWithTag("landings:earlier").assert(hasText("Earlier · 1 nothing to land"))
        shot("02-earlier-nothing")
    }

    @Test fun theEarlierRowWithBothCounts() {
        landings(listOf("LANDED", "NOTHING_TO_LAND"))
        await { exists(hasTestTag("landings:earlier")) }
        compose.onNodeWithTag("landings:earlier").assert(hasText("Earlier · 1 landed · 1 nothing to land"))
        shot("03-earlier-both")
    }

    @Test fun noEarlierRowWhenBothCountsAreZero() {
        landings(listOf("CANCELLED"))
        await { exists(hasTestTag("landing-row:l-await")) }
        compose.waitForIdle()
        compose.onNodeWithTag("landings:earlier").assertDoesNotExist()
        shot("04-earlier-none")
    }

    /** One waiting landing, one settled today, and the older ones (two days back) settled as [older] says. */
    private fun landings(older: List<String>) {
        fun row(id: String, title: String, createdAt: String, state: String, settledAs: String? = null, settledAt: String? = null) =
            """{"id":"$id","title":"$title","status":"AWAITING_INPUT","createdAt":"$createdAt","lastTurnAt":"$createdAt",
            "sessionKind":"LANDING","landing":{"subject":"TASK","state":"$state","settledAs":${q(settledAs)},"settledAt":${q(settledAt)}},
            "projectMembership":{"projectId":"$launch","projectTitle":"Launch","projectStatus":"OPEN","role":"LANDING"}}"""
        val rows = listOf(row("l-await", "Land · Wire the page", ago(42), "AWAITING_DECISION"),
            row("l-settled", "Land · Ship the drawer", ago(120), "SETTLED", settledAs = "LANDED", settledAt = ago(60))) +
            older.mapIndexed { i, settledAs ->
                row("l-old-$i", "Land · Older landing ${i + 1}", ago(2 * 24 * 60L + i), "SETTLED", settledAs = settledAs,
                    settledAt = ago(2 * 24 * 60L + i))
            }
        ProjectShell.landings = rows.joinToString(",", "[", "]")
        ProjectShell.needsYouItems = """[{"itemId":"item-holder","kind":"INTEGRATION_CHECK_FAILED","title":"Checks failed",
            "waitingSince":"${ago(30)}","assignee":"COORDINATOR","landingSessionId":"l-await"}]"""
        openPage()
    }

    // MARK: 04 — the Landing card: a lone merge job's says no task-landing sentence; the round by job kind

    @Test fun aLoneMergeCheckCard() = card("CHECK_PROMOTION", "05-card-merge-check")

    @Test fun aLoneMergeToMainCard() = card("LAND_PROMOTION", "06-card-merge-to-main")

    @Test fun aTaskLandingCardKeepsItsSentence() = card("LAND_TASK", "07-card-task")

    private fun card(kind: String, name: String) {
        val now = Instant.parse("2026-10-19T12:00:00Z")
        fun iso(seconds: Long) = now.minusSeconds(seconds).toString()
        val task = kind == "LAND_TASK"
        val check = """{"name":"${if (task) "TASK_ACCEPTANCE" else "MERGE_CHECK"}","index":1,"count":1,"budgetSeconds":3600,
            "startedAt":"${iso(110)}"}"""
        val job = """{"jobId":"j-1","kind":"$kind","state":"RUNNING","phase":"CHECK",
            "taskId":${if (task) "\"t-1\"" else "null"},"taskTitle":${if (task) "\"Wire the page\"" else "null"},"generation":1,
            "startedAt":"${iso(110)}","queuedAt":"${iso(144)}","heartbeatAt":"${iso(0)}",
            "runner":"wikova","runnerName":"wikova","timedOut":false,"limitSeconds":null,"retryable":false,
            "progressProtocol":"v2","claim":1,"round":1,"check":$check,"landingSessionId":"$landing",
            "stepStartedAt":"${iso(110)}","outputMovedAt":"${iso(6)}","typicalMs":null,"liveness":"LIVE"}"""
        val landTasks = if (task) """[{"taskId":"t-1","taskTitle":"Wire the page","integration":{"landTask":{"jobId":"j-1",
            "state":"RUNNING","phase":"CHECK","targetRef":"refs/heads/project/launch","startedAt":"${iso(110)}"}}}]""" else "[]"
        val view = Json.parseToJsonElement("""{"integratingCount":1,"queuedCount":0,"inFlight":$job,"inFlightJobs":[$job],
            "landTasks":$landTasks}""").jsonObject
        val drawn = ProjectPage.landingCard(view, now, now, false)!!
        show { Column(Modifier.fillMaxWidth().padding(16.dp)) {
            ProjectLandingCardView(drawn, onOpenJobs = {}, onOpenProject = null, openLanding = {}, retry = { null }) } }
        val detail = compose.onNodeWithTag("landing-head:detail", useUnmergedTree = true)
        if (task) {
            detail.assert(hasText("claim 1 · round 1 of 3", substring = true))
            compose.onNodeWithText(ProjectPage.landingNothingToDo, useUnmergedTree = true).assertExists()
        } else {
            detail.assert(hasText("claim 1 · round 1", substring = true))
            detail.assert(hasText("round 1 of", substring = true).not())
            compose.onNodeWithText(ProjectPage.landingNothingToDo, useUnmergedTree = true).assertDoesNotExist()
        }
        shot(name)
    }

    // MARK: 06 c — the X-E5 card's Step row by job kind

    @Test fun theXe5StepRowOfALandTask() {
        show { Column(Modifier.verticalScroll(rememberScrollState())) { exceptionCard(xe5("LAND_TASK", "REBASE")) } }
        compose.onNode(hasText("rebasing · claim 1 · round 1 of 3") and hasAnyAncestor(hasTestTag("item:item-xe5:fact:Step")),
            useUnmergedTree = true).assertExists()
        shot("08-xe5-task")
    }

    @Test fun theXe5StepRowOfAMergeCheck() {
        show { Column(Modifier.verticalScroll(rememberScrollState())) { exceptionCard(xe5("CHECK_PROMOTION", "CHECK")) } }
        compose.onNode(hasText("checking · claim 1 · round 1") and hasAnyAncestor(hasTestTag("item:item-xe5:fact:Step")),
            useUnmergedTree = true).assertExists()
        shot("09-xe5-check")
    }

    private fun xe5(jobKind: String, phase: String): JsonObject {
        val now = Instant.now()
        fun at(minutes: Long) = now.minusSeconds(minutes * 60).toString()
        return buildJsonObject {
            put("itemId", "item-xe5"); put("kind", "LANDING_LEASE_EXPIRED"); put("title", "A landing stopped reporting")
            put("detailLine", "The runner stopped reporting"); put("assignee", "OWNER"); put("assigneeReason", "ESCALATED")
            put("waitingSince", at(2)); put("escalatedAt", at(2))
            put("taskId", "t1"); put("sessionId", JsonNull); put("landingSessionId", landing); put("integrationJobId", "j-1")
            putJsonArray("actions") { listOf("ABANDON", "OPEN_LANDING").forEach { add(it) } }
            put("primaryAction", "ABANDON")
            put("requiredAction", "The runner stopped reporting; abandon this landing, or wait for the runner to come back.")
            put("facts", buildJsonObject { putJsonObject("task") { put("title", "Land · Wire the page") } })
            putJsonObject("lease") {
                put("jobKind", jobKind); put("generation", 2); put("phase", phase); put("claimGeneration", 1); put("round", 1)
                put("checkCount", 1); put("runner", "workstation-gpu"); put("progressProtocol", "v2"); put("pushReported", false)
                put("lastReportAt", at(29)); put("leaseExpiredAt", at(19))
            }
        }
    }

    @Composable
    private fun exceptionCard(row: JsonObject) {
        val card: InteractionCard = CardCatalog.project("s1", "p1", mapOf(
            "project" to buildJsonObject { put("id", "p1") },
            "openItems" to buildJsonObject { putJsonArray("needsYou") { add(row) }; putJsonArray("withCoordinator") {} })).single()
        ExceptionCard(card, fresh = true, result = CardActionState(), mergeCard = null, open = {}, discuss = null, review = {}) { _, _ -> }
    }

    // MARK: 06 e — the source session's landing label and its ring

    @Test fun theSourceLabelWearsTheRingWhileItRuns() {
        val detail = buildJsonObject { putJsonObject("sourceLanding") {
            put("landingSessionId", landing); put("subject", "TASK"); put("state", "RUNNING"); put("phase", "CHECK")
            put("settledAs", JsonNull); put("targetRef", "refs/heads/project/launch") } }
        show { Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) { SourceLandingChip(detail) {} } }
        compose.onNodeWithTag("source-landing").assertTextEquals("Landing · checking ›")
        compose.onNodeWithTag("source-landing:ring", useUnmergedTree = true).assertExists()
        shot("10-source-label")
    }

    // MARK: the shell and its shots

    private fun openPage() {
        signIn()
        await { exists(hasTestTag("workspace:${ProjectShell.ALPHA}")) }
        compose.onNodeWithTag("workspace:${ProjectShell.ALPHA}").performClick()
        await { exists(hasTestTag("project-row:$launch")) }
        compose.onNodeWithTag("project-row:$launch").performClick()
        await { exists(hasTestTag("project-sessions")) }
    }

    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ProjectShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onRoot().printToString())
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
    private fun app() = compose.activity.application as OrbitApplication
}

/** Light frames: the default Robolectric qualifiers. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1100dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingFollowupShotsTest : LandingFollowupShots() {
    override val theme = "light"
    override val dark = false
}

/** Dark frames: `isSystemInDarkTheme()` reads the night qualifier, as on a device. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1100dp-night")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingFollowupDarkShotsTest : LandingFollowupShots() {
    override val theme = "dark"
    override val dark = true
}
