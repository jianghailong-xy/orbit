package io.orbitd.android.directory

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.ui.OrbitTheme
import io.orbitd.android.watch.WatchFixture
import io.orbitd.android.watch.WatchSessionSummary
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A session's row (iOS `AgentSessionRow.compactRow`): its live mark, its time, its one line and what a screen reader hears. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = io.orbitd.android.TestOrbitApplication::class)
class SessionRowTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    private val marks = listOf("needs-you", "review", "running", "watching", "jobs", "failed").map { "session-mark-$it" }

    private fun draw(session: DirectorySession, watching: WatchSessionSummary? = null, deleted: Boolean = false, machine: String? = null) {
        compose.setContent { OrbitTheme { SessionRow(session, machine, {}, deleted, watching) {} } }
        compose.waitForIdle()
    }
    private fun mark(): List<String> = marks.filter { compose.onAllNodesWithTag(it, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    private fun line(id: String = "s") = compose.onNodeWithTag("session-state:$id", useUnmergedTree = true).fetchSemanticsNode()
        .config[SemanticsProperties.Text].joinToString { it.text }
    private fun parked(id: String = "s") = DirectorySession(id, title = "Row", status = "AWAITING_INPUT", runState = "AWAITING_INPUT", createdAt = "2026-10-08T08:00:00Z")

    @Test fun theMarkIsWhatMustNeverGoSilentAndTheCalmStatesDrawNone() {
        draw(parked().copy(pendingApprovals = 1)); assertEquals(listOf("session-mark-needs-you"), mark())
    }
    @Test fun aReportUnderReviewDrawsTheClockInTheQuietTone() {
        draw(parked().copy(confirmationUnderReview = JsonObject(emptyMap()))); assertEquals(listOf("session-mark-review"), mark())
    }
    @Test fun aWorkingSessionDrawsTheSpinner() {
        draw(parked().copy(runState = "RUNNING", status = "RUNNING")); assertEquals(listOf("session-mark-running"), mark())
    }
    @Test fun aTurnTheRuntimeStartedOrASubAgentDrawsTheSpinnerToo() {
        draw(parked().copy(engineTurnActive = true)); assertEquals(listOf("session-mark-running"), mark())
    }
    @Test fun oneAWatchWillResumeDrawsTheEyeInAJobsPlace() {
        draw(parked().copy(runningBgCount = 1, runningBgJobCount = 1), WatchSessionSummary(listOf(WatchFixture.watch(observer = "s"))))
        assertEquals(listOf("session-mark-watching"), mark())
    }
    @Test fun aJobInFlightBreathesAndAProcessMerelyLeftUpDoesNot() {
        draw(parked().copy(runningBgCount = 1, runningBgJobCount = 1)); assertEquals(listOf("session-mark-jobs"), mark())
    }
    @Test fun aProcessLeftUpDrawsNothing() {
        draw(parked().copy(runningBgCount = 1, runningBgJobCount = 0)); assertEquals(emptyList<String>(), mark())
    }
    @Test fun aFailureIsRed() {
        draw(parked().copy(runState = "FAILED", status = "FAILED", error = "It broke")); assertEquals(listOf("session-mark-failed"), mark())
    }
    @Test fun aFailureAboutToRetryOrOfAnOfflineRunnerIsNot() {
        draw(parked().copy(runState = "FAILED", status = "FAILED", retryAt = Instant.now().plusSeconds(30).toString())); assertEquals(emptyList<String>(), mark())
    }
    @Test fun anOfflineRunnersFailureIsNotRedEither() {
        draw(parked().copy(runState = "FAILED", status = "FAILED", error = "Runner offline")); assertEquals(emptyList<String>(), mark())
    }
    @Test fun aSessionParkedOrFinishedDrawsNothing() {
        draw(parked()); assertEquals(emptyList<String>(), mark())
    }

    /** A row's value is the state its mark leaves out, and its long press is named for a screen reader. */
    @Test fun aScreenReaderHearsTheStateAndTheMenu() {
        draw(parked())
        val row = compose.onNode(hasText("Row") and hasClickAction()).fetchSemanticsNode().config
        assertEquals("Waiting for your reply", row.getOrNull(SemanticsProperties.StateDescription))
        assertEquals("Options for Row", row.getOrNull(SemanticsActions.OnLongClick)?.label)
    }

    /** One line, in the words of what it is doing; in Trash nothing is live. */
    @Test fun theLineIsWhatTheRowIsDoingAndNothingIsLiveInTrash() {
        draw(parked().copy(pendingApprovals = 1)); assertEquals("Waiting for approval", line())
    }
    @Test fun inTrashTheLineIsNotLive() {
        draw(parked().copy(pendingApprovals = 1, lastAssistantText = "The last reply"), deleted = true)
        assertEquals("The last reply", line())
    }

    /** A session held for the Claude region names its machine, on its line (`SessionLine`'s `machine`). */
    @Test fun aHeldSessionNamesItsMachine() {
        val held = parked().copy(runState = "QUEUED", status = "PENDING", error = "CLAUDE_REGION_UNSUPPORTED: Claude Code stopped")
        assertEquals(SessionLine("Anthropic unavailable on HPC", SessionLine.Tone.QUEUED), SessionLine.make(held, live = true, machine = "HPC"))
        assertEquals("with no machine known it is plain Queued", SessionLine(SessionLineCopy.queued, SessionLine.Tone.QUEUED), SessionLine.make(held, live = true))
    }

    /** A coordinator a list draws flat says so (Trash, a tag). */
    @Test fun aCoordinatorDrawnFlatSaysSo() {
        draw(parked().copy(projectMembership = SessionProjectMembership("p", role = "COORDINATOR")))
        compose.onNodeWithContentDescription("Project coordinator", useUnmergedTree = true).assertExists()
    }

    @Test fun theTimeIsHowLongTheTurnHasRunOrWhenItLastMoved() {
        val now = Instant.parse("2026-10-09T01:00:00Z")
        val running = parked().copy(runState = "RUNNING", status = "RUNNING")
        assertEquals("12m", SessionListTime.format(running.copy(currentTurnStartedAt = "2026-10-09T00:48:00Z"), now))
        assertNull("no start, no time", SessionListTime.format(running.copy(lastTurnAt = "2026-10-09T00:48:00Z"), now))
        assertEquals("12m ago", SessionListTime.format(parked().copy(lastTurnAt = "2026-10-09T00:48:00Z"), now))
        assertEquals("from when it was made", "1h ago", SessionListTime.format(parked().copy(createdAt = "2026-10-09T00:00:00Z"), now))
    }

    @Test fun aTagsColourIsItsSixDigitsOrGrey() {
        assertEquals(Color(0xFFFF3B30), tagColor("#FF3B30"))
        assertEquals(Color.Gray, tagColor("red"))
        assertEquals(Color.Gray, tagColor(null))
    }
}
