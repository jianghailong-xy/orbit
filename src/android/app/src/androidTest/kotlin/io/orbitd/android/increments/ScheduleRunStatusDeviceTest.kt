package io.orbitd.android.increments

import androidx.compose.ui.test.*
import java.time.ZonedDateTime
import okhttp3.mockwebserver.MockResponse
import org.junit.Test

/** The board's three status cards in the real reader, with a schedule-cards response for each try. */
class ScheduleRunStatusDeviceTest : IncrementDeviceTest() {
    private val schedule = "34RunStatusSchedule01"
    private val selected = "34RunStatusSession001"
    private val actual = "34RunStatusSession003"
    private val fresh = "34RunStatusSession006"
    private val runId = "34RunStatusRun000001"
    private val tries = listOf(selected, "34RunStatusSession002", actual, "34RunStatusSession004", "34RunStatusSession005")
    override val ids get() = listOf(schedule, fresh, runId, workspace, runner) + tries

    private var scenario = "DIDNT_RUN"
    @Volatile private var cancelled = false
    private val now = ZonedDateTime.now()
    private fun at(hour: Int, minute: Int, days: Long = 0) =
        now.plusDays(days).withHour(hour).withMinute(minute).withSecond(0).withNano(0).toInstant().toString()
    private val planned get() = at(3, 32)

    override fun runnerJson() = super.runnerJson().replace("Fixture runner", "HPC")

    private fun session(id: String) = """{"id":"$id","title":"${if (id == fresh) "New run" else "Engine version bump"}",
        "status":"${if (id == selected) "FAILED" else "AWAITING_INPUT"}",
        "runState":"${if (id == selected) "ENDED" else "AWAITING_INPUT"}","lifecycleState":"OPEN",
        "workspaceId":"$workspace","assignedRunnerId":"$runner","provider":"claude","engine":"claude","scheduleRunId":"$runId",
        "runSource":"SCHEDULE","numTurns":${if (id == selected) 0 else 1},
        "error":${if (id == selected) "\"Found no runner online\"" else "null"},
        "createdAt":"$planned","capabilities":{"canSend":true}}"""

    private fun run(state: String, session: String, reason: String = "") =
        """{"id":"$runId","scheduleId":"$schedule","plannedAt":"$planned","startedAt":"$planned","state":"$state",
            "sessionId":"$session","failureReason":"$reason"}"""

    private fun tryRows(count: Int, reached: Int = -1) = listOf(at(3, 32), at(3, 43), at(3, 58), at(4, 23), at(5, 34))
        .take(count).mapIndexed { i, time ->
            """{"sessionId":"${tries[i]}","startedAt":"$time","claimed":${scenario == "STARTED_ON"},"reachedEngine":${i == reached}}"""
        }.joinToString(",", "[", "]")

    private fun cards(id: String): String {
        val answer = when {
            id == fresh -> """"run":${run("RUNNING", fresh)}"""
            scenario == "STARTED_ON" -> """"run":${run("RUNNING", actual)},"runStatus":{"tries":${tryRows(3, 2)},"thisTry":${if (id == selected) 1 else 3}}"""
            scenario == "QUEUED_FULL" && !cancelled -> """"run":${run("RUNNING", selected)},"runStatus":{"tries":${tryRows(1)},"thisTry":1,
                "queue":{"queuedReason":"runner_at_capacity","queuedActive":20,"queuedLimit":20,"queuedHeldByJobs":0,
                "since":"${now.minusMinutes(72).toInstant()}","deadline":"${at(3, 32, 1)}"}}"""
            cancelled -> """"run":${run("CANCELLED", selected, "CANCELLED_BY_OWNER")},"runStatus":{"tries":${tryRows(1)},"thisTry":1,"gaveUpAt":"${at(5, 44)}"}"""
            else -> """"run":${run("MISSED", tries.last(), "RUNNER_UNAVAILABLE")},"runStatus":{"tries":${tryRows(5)},
                "thisTry":1,"gaveUpAt":"${at(5, 44)}","nextDueAt":"${at(6, 0, 1)}"}"""
        }
        return """{$answer,"cards":[],"records":[]}"""
    }

    override fun answer(req: Req): MockResponse? = when {
        req.path == "schedules/$schedule" -> json("""{"schedule":{"id":"$schedule","title":"Engine version bump",
            "rule":{"kind":"DAILY","time":"06:00"},"timezone":"${now.zone.id}","workspaceId":"$workspace",
            "engine":"claude","accessLevel":"LAND","state":"ACTIVE","createdAt":"$planned"},"recentRuns":[]}""")
        req.path == "schedules/$schedule/run" -> json("""{"run":${run("RUNNING", fresh)}}""")
        req.path == "schedule-runs/$runId/stop" -> { cancelled = true; json("{}") }
        req.path == "schedules" -> json("""{"schedules":[]}""")
        req.parts.first() == "sessions" && req.parts.getOrNull(1) in listOf(selected, actual, fresh) -> {
            val id = req.parts[1]
            when (req.parts.drop(2)) {
                emptyList<String>() -> json(session(id))
                listOf("schedule-cards") -> json(cards(id))
                listOf("events", "page") -> json(page(emptyList()))
                else -> null
            }
        }
        else -> null
    }

    private fun show(kind: String, title: String, body: String, screenshot: String) {
        scenario = kind
        signIn()
        open("orbit-session:$selected")
        await("the scheduled run strip and $title card", timeoutMs = 60_000) {
            exists(hasTestTag("schedule-run-strip"), unmerged = true) &&
                exists(hasTestTag("schedule-run-status-$kind"), unmerged = true) &&
                exists(hasText(body), unmerged = true)
        }
        verify("the correct card title", exists(hasText(title), unmerged = true))
        verify("no composer, run-start error, or old report", listOf("composer-input", "session-run-start", "schedule-run-report")
            .none { exists(hasTestTag(it), unmerged = true) })
        verify("no start time in this try's strip",
            exists(hasText("Scheduled run · planned 03:32 · access Edit and land on main"), unmerged = true))
        capture(screenshot)
    }

    @Test fun didntRun() = journey {
        show("DIDNT_RUN", "Didn't run", "HPC didn't pick it up on any of 5 tries, so the run never started. Nothing was changed.", "didnt-run")
        verify("try times and next run visible", listOf("03:32", "03:43", "03:58", "04:23", "05:34", "gave up 05:44", "Next run: tomorrow 06:00")
            .all { exists(hasText(it), unmerged = true) })
        verify("Open schedule is available", exists(hasText("Open schedule"), unmerged = true))
        compose.onNodeWithText("Run now").performClick()
        await("Run now opened the new session") { calls.any { it == "GET sessions/$fresh" } }
        verify("Run now requested once", calls.count { it == "POST schedules/$schedule/run" } == 1)
    }

    @Test fun queuedFull() = journey {
        show("QUEUED_FULL", "Queued · runner full", "HPC is running 20 of 20 sessions. The run starts as soon as one finishes.", "queued-full")
        verify("the wait and deadline", exists(hasText("gives up at 03:32 tomorrow", substring = true), unmerged = true))
        compose.onNodeWithText("Open schedule").performClick()
        await("Open schedule opened the detail sheet") { exists(hasTestTag("schedule-detail-panel")) }
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        open("orbit-session:$selected")
        compose.onNodeWithText("Cancel run").performClick()
        await("Cancel run refreshed the card") { exists(hasText("You cancelled the run before it started. Nothing was changed."), unmerged = true) }
        verify("Cancel run requested once", calls.count { it == "POST schedule-runs/$runId/stop" } == 1)
    }

    @Test fun startedOnLaterTry() = journey {
        show("STARTED_ON", "Started on try 3", "This try stopped before its engine started (Claude Code exited). Try 3 started at 03:58.", "started-on-try-3")
        compose.onNodeWithText("Open the run →").performClick()
        await("Open the run opened the delivered try and restored its composer") {
            calls.any { it == "GET sessions/$actual" } && exists(hasTestTag("composer-input"), unmerged = true)
        }
    }
}
