package io.orbitd.android

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.projects.LandingJobLine
import io.orbitd.android.projects.LandingJobsList
import io.orbitd.android.projects.ProjectPage
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
 * A-2's NATIVE shots against board v4 07: the Landing card's Open landing, the jobs list with a landing and a server that names
 * none (the grey slot), the merge card, the X-E5 card and the Landings group. Each is drawn by the production composables over the
 * shell's controlled server, and written under `src/android/build/evidence/landing-entries-android/` beside its semantics tree.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1600dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingEntriesShotsTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = ProjectShell.reset()

    private val launch = ProjectShell.LAUNCH
    private val landing = ProjectShell.LANDING
    private fun ago(minutes: Long): String = Instant.now().minusSeconds(minutes * 60).toString()
    private fun q(value: String?): String = value?.let { "\"$it\"" } ?: "null"

    private val landingView get() = """{"sessionId":"$landing","projectId":"$launch","subject":"TASK","taskId":"t-landing","promotionId":null,
        "episode":1,"openedAt":"${ago(600)}","settledAt":null,"settledAs":null,"checks":[],
        "currentAttempt":{"jobId":"j-1","kind":"LAND_TASK","state":"RUNNING","generation":1,"phase":"CHECK","round":1,"step":null,"claim":1,
        "runnerName":"wikova","sourceSessionId":"$landing","targetRef":"refs/heads/project/launch","startedAt":"${ago(110)}",
        "heartbeatAt":"${ago(0)}","outputMovedAt":"${ago(6)}","progressProtocol":"v2",
        "check":{"name":"TASK_ACCEPTANCE","index":1,"count":3,"budgetSeconds":3600,"startedAt":"${ago(110)}"},"liveness":"LIVE",
        "blockingReason":null,"timedOut":false,"limitSeconds":600,"retryable":false,"pushBoundaryPassed":false},"todos":[],"generations":[]}"""

    private fun job(id: String, state: String = "RUNNING", kind: String = "LAND_TASK", landingId: String? = landing, timedOut: Boolean = false,
        retryable: Boolean = false, title: String = "Wire the page") = """{"jobId":"$id","kind":"$kind","state":"$state","phase":"CHECK",
        "taskId":"t-$id","taskTitle":"$title","generation":1,"startedAt":"${ago(60)}","queuedAt":"${ago(90)}","heartbeatAt":"${ago(0)}",
        "runnerName":"wikova","timedOut":$timedOut,"limitSeconds":600,"retryable":$retryable${landingId?.let { ",\"landingSessionId\":\"$it\"" }.orEmpty()}}"""

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/landing-entries-android").also { it.mkdirs() }
    }

    @Test fun theLandingCardsOpenLanding() {
        ProjectShell.inFlightJobs = "[${job("j-1")}]"; ProjectShell.landing = landingView
        openPage()
        await { exists(hasTestTag("landing-card:open-landing")) }
        shot("01-landing-card")
    }

    @Test fun theJobsListWithALandingAndAServerThatNamesNone() {
        val now = Instant.parse("2026-10-19T12:00:00Z")
        fun jobJson(id: String, state: String = "RUNNING", kind: String = "LAND_TASK", landingId: String? = "L1", timedOut: Boolean = false,
            retryable: Boolean = false, title: String = "Wire the page") = buildJsonObject {
            put("jobId", id); put("kind", kind); put("state", state); put("phase", "CHECK"); put("taskId", "t-$id"); put("taskTitle", title)
            put("generation", 1); put("startedAt", now.minusSeconds(60).toString()); put("queuedAt", now.minusSeconds(90).toString())
            put("heartbeatAt", now.toString()); put("runnerName", "workstation-gpu"); put("timedOut", timedOut); put("limitSeconds", 600)
            put("retryable", retryable); landingId?.let { put("landingSessionId", it) }
        }
        val view = buildJsonObject {
            put("integratingCount", 2); put("queuedCount", 2)
            putJsonObject("inFlight") { put("kind", "LAND_TASK"); put("state", "RUNNING"); put("startedAt", now.minusSeconds(60).toString())
                put("heartbeatAt", now.toString()); put("taskTitle", "Wire the page"); put("phase", "CHECK") }
            putJsonArray("inFlightJobs") { add(jobJson("j-1", timedOut = true, retryable = true)); add(jobJson("j-2", state = "QUEUED"))
                add(jobJson("j-3", kind = "CHECK_PROMOTION", state = "QUEUED", title = "Merge project/launch → main"))
                add(jobJson("j-old", state = "QUEUED", landingId = null, title = "An older server's job")) }
        }
        val lines: List<LandingJobLine> = ProjectPage.landingJobLines(view, now, now, false)
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(color = MaterialTheme.colorScheme.background) {
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) { LandingJobsList(lines, retry = { null }, openTask = {}, openLanding = {}, close = {}) }
            }
        } } }
        compose.waitForIdle()
        compose.onNodeWithTag("landing-job:j-3:open-landing").assertTextEquals("Open landing ›")
        compose.onNodeWithTag("landing-job:j-old:open-landing").assertTextEquals("No landing page on this server yet")
        shot("02-jobs-list")
    }

    @Test fun theMergeCheckCardWithItsQueueFoot() {
        ProjectShell.inFlightJobs = "[${job("j-1", kind = "CHECK_PROMOTION")},${job("j-2", state = "QUEUED", kind = "LAND_TASK")}]"
        ProjectShell.mergeCheck = true; ProjectShell.landing = landingView
        openPage()
        await { exists(hasTestTag("project-merge-card:checking")) && exists(hasTestTag("project-merge-card:more-jobs")) }
        shot("03-merge-checking")
    }

    @Test fun theXe5CardInTheCoordinatorsConversation() {
        ProjectShell.landing = landingView
        ProjectShell.needsYouItems = """[{"itemId":"item-xe5","kind":"LANDING_LEASE_EXPIRED","title":"A landing stopped reporting",
            "detailLine":"The runner stopped reporting","assignee":"OWNER","assigneeReason":"ESCALATED","waitingSince":"${ago(120)}","escalatedAt":"${ago(120)}",
            "landingSessionId":"$landing","integrationJobId":"j-1","actions":["ABANDON","OPEN_LANDING"],"primaryAction":"ABANDON",
            "requiredAction":"The runner stopped reporting; abandon this landing, or wait for the runner to come back.",
            "lease":{"jobKind":"LAND_TASK","generation":2,"phase":"REBASE","claimGeneration":1,"round":1,"checkCount":3,"runner":"workstation-gpu",
            "progressProtocol":"v2","pushReported":false,"lastReportAt":"${ago(300)}"}}]"""
        openPage()
        await { exists(hasText("Coordinate launch") and hasClickAction()) }
        compose.onNode(hasText("Coordinate launch") and hasClickAction()).performClick()
        await { exists(hasTestTag("item:item-xe5:ABANDON")) }
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("item:item-xe5:ABANDON"))
        shot("04-xe5-card")
    }

    @Test fun theLandingsGroup() {
        ProjectShell.landing = landingView
        fun row(id: String, title: String, createdAt: String, state: String, subject: String = "TASK", settledAs: String? = null,
            settledAt: String? = null) = """{"id":"$id","title":"$title","status":"AWAITING_INPUT","createdAt":"$createdAt","lastTurnAt":"$createdAt",
            "sessionKind":"LANDING","landing":{"subject":"$subject","state":"$state","settledAs":${q(settledAs)},"settledAt":${q(settledAt)}},
            "projectMembership":{"projectId":"$launch","projectTitle":"Launch","projectStatus":"OPEN","role":"LANDING"}}"""
        ProjectShell.landings = """[${row("l-await", "Land · Wire the page", ago(42), "AWAITING_DECISION")},
            ${row("l-settled", "Land · Ship the drawer", ago(120), "SETTLED", settledAs = "LANDED", settledAt = ago(60))},
            ${row("l-old", "Land · Ship the docs", ago(2 * 24 * 60), "SETTLED", settledAs = "LANDED", settledAt = ago(2 * 24 * 60))}]"""
        ProjectShell.needsYouItems = """[{"itemId":"item-holder","kind":"INTEGRATION_CHECK_FAILED","title":"Checks failed",
            "waitingSince":"${ago(30)}","assignee":"COORDINATOR","landingSessionId":"l-await"}]"""
        openPage()
        await { exists(hasTestTag("landing-row:l-await")) && exists(hasTestTag("landings:earlier")) }
        // The waiting row's holder is the open-items read: let it land so the shot says what stopped the landing.
        await { exists(hasText("Checks failed · with the coordinator", substring = true)) }
        shot("05-landings-group")
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
