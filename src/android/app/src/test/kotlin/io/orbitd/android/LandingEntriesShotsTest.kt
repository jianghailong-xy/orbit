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
import io.orbitd.android.cards.TranscriptCardView
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.CardActionState
import io.orbitd.android.core.cards.CardCatalog
import io.orbitd.android.core.cards.InteractionCard
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.projects.LandingJobLine
import io.orbitd.android.projects.LandingJobsList
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
 * A-2's NATIVE frames against board v4 07, light and dark: the Landing card's Open landing, the jobs list with a landing and a server
 * that names none (the grey slot), the merge check card with its queue foot, the X-E5 card, an INTEGRATION_* item's card with Open
 * landing after its existing doors (board 07 13:28), the delivery card's two links, the source session's derived label, and the
 * Landings group. Each is drawn by the production composables over the shell's controlled server (or standalone, where the frame is
 * one card), and written under `src/android/build/evidence/landing-entries-android/<theme>/` beside its semantics tree.
 */
abstract class LandingEntriesShots {
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
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/landing-entries-android/$theme").also { it.mkdirs() }
    }

    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = dark) {
            Surface(color = MaterialTheme.colorScheme.background) { content() }
        } } }
        compose.waitForIdle()
    }

    /** A · the Landing card: one job names its landing at the card's foot (board 07 10:20). */
    @Test fun theLandingCardsOpenLanding() {
        val now = Instant.parse("2026-10-19T12:00:00Z")
        val view = buildJsonObject {
            put("integratingCount", 1); put("queuedCount", 0)
            val job = buildJsonObject {
                put("jobId", "j-1"); put("kind", "LAND_TASK"); put("state", "RUNNING"); put("phase", "CHECK"); put("taskId", "t-1")
                put("taskTitle", "Wire the page"); put("generation", 1); put("startedAt", now.minusSeconds(66).toString())
                put("queuedAt", now.minusSeconds(100).toString()); put("heartbeatAt", now.toString()); put("runnerName", "wikova")
                put("timedOut", false); put("limitSeconds", 600); put("retryable", false); put("landingSessionId", landing)
            }
            put("inFlight", job)
            putJsonArray("inFlightJobs") { add(job) }
            putJsonArray("landTasks") { addJsonObject {
                put("taskId", "t-1"); put("taskTitle", "Wire the page")
                putJsonObject("integration") { putJsonObject("landTask") { put("jobId", "j-1"); put("state", "RUNNING")
                    put("targetRef", "refs/heads/project/launch") } }
            } }
        }
        val card = ProjectPage.landingCard(view, now, now, false)!!
        show { Column(Modifier.fillMaxWidth().padding(16.dp)) {
            ProjectLandingCardView(card, onOpenJobs = {}, onOpenProject = null, openLanding = {}, retry = { null }) } }
        compose.onNodeWithTag("landing-card:open-landing", useUnmergedTree = true).assertExists()
        shot("01-landing-card")
    }

    /** B · the jobs list: every row names its landing, and a server that names none says so in grey (board 07 10:52). */
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
        show { Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
            LandingJobsList(lines, retry = { null }, openTask = {}, openLanding = {}, close = {}) } }
        compose.onNodeWithTag("landing-job:j-3:open-landing").assertTextEquals("Open landing ›")
        compose.onNodeWithTag("landing-job:j-old:open-landing").assertTextEquals("No landing page on this server yet")
        shot("02-jobs-list")
    }

    /** C · the merge check card with its queue foot (board 07 10:52): the whole head row opens the round's landing. */
    @Test fun theMergeCheckCardWithItsQueueFoot() {
        ProjectShell.inFlightJobs = "[${job("j-1", kind = "CHECK_PROMOTION")},${job("j-2", state = "QUEUED", kind = "LAND_TASK")}]"
        ProjectShell.mergeCheck = true
        openPage()
        await { exists(hasTestTag("project-merge-card:checking")) && exists(hasTestTag("project-merge-card:more-jobs")) }
        shot("03-merge-check-card")
    }

    /** D · the X-E5 card (board 07 15:02): Abandon leads, Open landing follows, and the lease block names the task, the runner and
     * the two instants. */
    @Test fun theXe5CardInTheCoordinatorsConversation() {
        show { Column(Modifier.verticalScroll(rememberScrollState())) { exceptionCard(xe5()) } }
        compose.onNodeWithTag("item:item-xe5:ABANDON").assertTextEquals("Abandon")
        compose.onNodeWithTag("item:item-xe5:OPEN_LANDING").assertTextEquals("Open landing")
        compose.onNodeWithTag("item:item-xe5:fact:Landing", useUnmergedTree = true).assertExists()
        shot("04-xe5-card")
    }

    /** E · board 07 13:28: an INTEGRATION_* item's card, Open landing appended after its existing doors. */
    @Test fun anIntegrationItemsCardEndsWithOpenLanding() {
        val row = buildJsonObject {
            put("itemId", "item-integration"); put("kind", "INTEGRATION_CHECK_FAILED"); put("title", "Checks failed on the combined tree")
            put("detailLine", "the merge check exited 1"); put("assignee", "OWNER"); put("assigneeReason", "ESCALATED")
            put("waitingSince", ago(145)); put("escalatedAt", ago(123))
            put("taskId", "t1"); put("sessionId", "s-failed"); put("landingSessionId", landing)
            putJsonArray("actions") { listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "RETRY", "OPEN_LANDING").forEach { add(it) } }
            put("requiredAction", "This task cannot reach the project branch until its landing check passes — re-run it or ask the coordinator to fix it.")
            put("facts", buildJsonObject {
                put("task", JsonNull); put("targetRef", "project/launch"); put("targetSha", "b70a4461c2d3e4f5a6b7")
                putJsonArray("files") {}
                put("check", buildJsonObject { put("command", "npx vitest run src/web"); put("exitCode", 1); put("timedOut", false)
                    put("durationMs", 232000); put("outputTail", "FAIL src/web/src/panel.test.tsx\n  expected 2, received 3") })
                put("branchUnchanged", true); put("errorCode", JsonNull); put("failure", JsonNull)
            })
        }
        show { Column(Modifier.verticalScroll(rememberScrollState())) { exceptionCard(row) } }
        compose.onNodeWithTag("item:item-integration:OPEN_LANDING").assertTextEquals("Open landing")
        shot("05-integration-card")
    }

    /** F · the delivery card's two ways into the record: the failed session and the landing (board 06 b). */
    @Test fun theDeliveryCardsTwoLinks() {
        val delivery = buildJsonObject {
            put("itemId", "i1"); put("kind", "INTEGRATION_CHECK_FAILED"); put("title", "Checks failed on the combined tree")
            putJsonObject("task") { put("id", "t1"); put("title", "Wire the page"); put("sessionId", "s-failed") }
            putJsonArray("files") {}; put("targetRef", "refs/heads/project/launch")
            put("landingSessionId", landing)
        }
        val event = RunEvent("user", 3, buildJsonObject { put("text", "From Orbit · project item delivered"); put("openItemDelivery", delivery) }, "turn-1")
        val card = transcriptCards(event).single()
        show { Column(Modifier.padding(16.dp)) { TranscriptCardView(card, {}, event) } }
        compose.onNodeWithText("Open the failed session ↗").assertExists()
        compose.onNodeWithText("Open the landing ↗").assertExists()
        shot("06-delivery-card")
    }

    /** G · the source session's derived label (board 06 e): what the platform did with its work, opening the landing generation. */
    @Test fun theSourceSessionsLandingLabel() {
        val detail = buildJsonObject { putJsonObject("sourceLanding") {
            put("landingSessionId", landing); put("subject", "TASK"); put("state", "RUNNING"); put("phase", "CHECK")
            put("settledAs", JsonNull); put("targetRef", "refs/heads/project/launch") } }
        show { Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) { SourceLandingChip(detail) {} } }
        compose.onNodeWithTag("source-landing", useUnmergedTree = true).assertTextEquals("Landing · checking ›")
        shot("07-source-label")
    }

    /** H · the Landings group (board 04 c1): waiting and settled rows under the Coordinator, the older ones folded. */
    @Test fun theLandingsGroup() {
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
        await { exists(hasText("Checks failed · with the coordinator", substring = true)) }
        shot("08-landings-group")
    }

    // MARK: the cards' fixtures

    private fun xe5(): JsonObject {
        // One clock for every instant, so the heading is exactly the 27 minutes board 07 15:02 counts.
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
            put("jobKind", "LAND_TASK"); put("generation", 2); put("phase", "REBASE"); put("claimGeneration", 1); put("round", 1)
            put("checkCount", 3); put("runner", "workstation-gpu"); put("progressProtocol", "v2"); put("pushReported", false)
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

    // MARK: the shell, its jobs and its shots

    private fun job(id: String, state: String = "RUNNING", kind: String = "LAND_TASK", landingId: String? = landing, timedOut: Boolean = false) =
        """{"jobId":"$id","kind":"$kind","state":"$state","phase":"CHECK","taskId":"t-$id","taskTitle":"Wire the page","generation":1,
        "startedAt":"${ago(60)}","queuedAt":"${ago(90)}","heartbeatAt":"${ago(0)}","runnerName":"wikova","timedOut":$timedOut,
        "limitSeconds":600,"retryable":false${landingId?.let { ",\"landingSessionId\":\"$it\"" }.orEmpty()}}"""

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
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1600dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingEntriesShotsTest : LandingEntriesShots() {
    override val theme = "light"
    override val dark = false
}

/** Dark frames: `isSystemInDarkTheme()` reads the night qualifier, as on a device. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1600dp-night")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingEntriesDarkShotsTest : LandingEntriesShots() {
    override val theme = "dark"
    override val dark = true
}
