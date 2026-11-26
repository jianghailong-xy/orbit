package io.orbitd.android.schedule

import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.core.net.ApiResponse
import java.time.ZonedDateTime
import org.junit.Assert.*
import org.junit.Test

/**
 * A scheduled run's session page where the run never reached its engine (board scheduled-run-not-started ②③④), in the production
 * shell: the card in place of the run-start error and the composer, and where each of its buttons leads.
 */
class ScheduleRunStatusShellTest : ComposerShellTest() {
    private val schedule = "34RunStatusSchedule01"
    private val runId = "34RunStatusRun000001"
    private val later = "34RunStatusSession003"
    private val fresh = "34RunStatusSession006"
    private val now = ZonedDateTime.now()
    private fun at(hour: Int, minute: Int, days: Long = 0) =
        now.plusDays(days).withHour(hour).withMinute(minute).withSecond(0).withNano(0).toInstant().toString()
    private val times = listOf(at(3, 32), at(3, 43), at(3, 58), at(4, 23), at(5, 34))
    @Volatile private var cards = ""

    private fun run(state: String, session: String, reason: String = "") =
        """{"id":"$runId","scheduleId":"$schedule","plannedAt":"${times[0]}","startedAt":"${times[0]}","state":"$state",
            "sessionId":"$session","failureReason":"$reason"}"""

    private fun tries(count: Int, claimed: Boolean = false, reached: Int = -1) = times.take(count).mapIndexed { i, time ->
        val id = when (i) { 0 -> ComposerShell.SESSION; 2 -> later; else -> "34RunStatusSessionT0$i" }
        """{"sessionId":"$id","startedAt":"$time","claimed":$claimed,"reachedEngine":${i == reached}}"""
    }.joinToString(",", "[", "]")

    private fun answer(body: String) = { ApiResponse(200, body.encodeToByteArray()) }

    private fun openRun(run: String, status: String) {
        cards = """{"run":$run,"runStatus":$status,"cards":[],"records":[]}"""
        ComposerShell.session = ComposerShell.fields("""{"title":"Engine version bump","status":"FAILED","runState":"ENDED",
            "scheduleRunId":"$runId","runSource":"SCHEDULE","engine":"claude","numTurns":0,"error":"Found no runner online"}""")
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"HPC","online":true,"status":"ONLINE",
            "version":"0.1.253","engines":[{"engine":"claude","installed":true,"auth":"yes"}]}""")
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/schedule-cards"] = { answer(cards)() }
        ComposerShell.answers["GET schedules/$schedule"] = answer("""{"schedule":{"id":"$schedule","title":"Engine version bump",
            "rule":{"kind":"DAILY","time":"06:00"},"timezone":"${now.zone.id}","workspaceId":"${ComposerShell.WORKSPACE}",
            "engine":"claude","accessLevel":"LAND","state":"ACTIVE","createdAt":"${times[0]}"},"recentRuns":[]}""")
        signIn()
        open("orbit-session:${ComposerShell.SESSION}")
    }

    private fun awaitCard(kind: String, body: String) = await {
        has(hasTestTag("schedule-run-status-$kind"), unmerged = true) && has(hasText(body), unmerged = true) &&
            has(hasTestTag("schedule-run-strip"), unmerged = true)
    }

    private fun assertOnlyTheCard() {
        for (tag in listOf("composer-input", "session-run-start", "schedule-run-report"))
            assertFalse(tag, has(hasTestTag(tag), unmerged = true))
        assertTrue(shows("Scheduled run · planned 03:32 · access Edit and land on main"))
    }

    @Test fun aRunThatDidNotRunListsItsTriesAndRunNowOpensTheNewRun() {
        ComposerShell.answers["POST schedules/$schedule/run"] = answer("""{"run":${run("RUNNING", fresh)}}""")
        openRun(run("MISSED", "34RunStatusSessionT04", "RUNNER_UNAVAILABLE"),
            """{"tries":${tries(5)},"thisTry":1,"gaveUpAt":"${at(5, 44)}","nextDueAt":"${at(6, 0, 1)}"}""")
        awaitCard("DIDNT_RUN", "HPC didn't pick it up on any of 5 tries, so the run never started. Nothing was changed.")
        assertOnlyTheCard()
        for (text in listOf("Didn't run", "03:32", "03:43", "03:58", "04:23", "05:34", "gave up 05:44", "Next run: tomorrow 06:00",
            "Open schedule")) assertTrue(text, shows(text))
        compose.onNodeWithText("Run now").performClick()
        await { ComposerShell.calls.contains("GET sessions/$fresh") }
        assertEquals(1, ComposerShell.calls.count { it == "POST schedules/$schedule/run" })
    }

    @Test fun aRunWaitingOnAFullRunnerCanBeCancelled() {
        ComposerShell.answers["POST schedule-runs/$runId/stop"] = {
            cards = """{"run":${run("CANCELLED", ComposerShell.SESSION, "CANCELLED_BY_OWNER")},
                "runStatus":{"tries":${tries(1)},"thisTry":1,"gaveUpAt":"${at(5, 44)}"},"cards":[],"records":[]}"""
            ApiResponse(200, "{}".encodeToByteArray())
        }
        openRun(run("RUNNING", ComposerShell.SESSION), """{"tries":${tries(1)},"thisTry":1,"queue":{"queuedReason":"runner_at_capacity",
            "queuedActive":20,"queuedLimit":20,"queuedHeldByJobs":0,"since":"${now.minusMinutes(72).toInstant()}",
            "deadline":"${at(3, 32, 1)}"}}""")
        awaitCard("QUEUED_FULL", "HPC is running 20 of 20 sessions. The run starts as soon as one finishes.")
        assertOnlyTheCard()
        assertTrue(shows("Queued · runner full"))
        assertTrue(shows("Waiting 1 h 12 min · gives up at 03:32 tomorrow"))
        assertTrue(shows("Open schedule"))
        compose.onNodeWithText("Cancel run").performClick()
        awaitCard("DIDNT_RUN", "You cancelled the run before it started. Nothing was changed.")
        assertEquals(1, ComposerShell.calls.count { it == "POST schedule-runs/$runId/stop" })
    }

    @Test fun aTryTheRunMovedOnFromOpensTheSessionItStartedIn() {
        openRun(run("RUNNING", later), """{"tries":${tries(3, claimed = true, reached = 2)},"thisTry":1}""")
        awaitCard("STARTED_ON", "This try stopped before its engine started (Claude Code exited). Try 3 started at 03:58.")
        assertOnlyTheCard()
        assertTrue(shows("Started on try 3"))
        assertFalse(shows("Open schedule"))
        compose.onNodeWithText("Open the run →").performClick()
        await { ComposerShell.calls.contains("GET sessions/$later") }
    }

    /** The try that reached its engine is an ordinary conversation: composer and all. */
    @Test fun theSessionTheRunStartedInKeepsItsComposer() {
        openRun(run("RUNNING", ComposerShell.SESSION), """{"tries":${tries(1, claimed = true, reached = 0)},"thisTry":1}""")
        await { has(hasTestTag("composer-input"), unmerged = true) && has(hasTestTag("schedule-run-strip"), unmerged = true) }
        assertFalse(has(hasTestTag("schedule-run-status-STARTED_ON"), unmerged = true))
    }
}
