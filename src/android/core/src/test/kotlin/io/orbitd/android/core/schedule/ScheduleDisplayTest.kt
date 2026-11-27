package io.orbitd.android.core.schedule

import io.orbitd.android.core.schedule.ScheduleDisplay.Circle
import io.orbitd.android.core.schedule.ScheduleDisplay.CircleView
import io.orbitd.android.core.schedule.ScheduleDisplay.GroupKey
import io.orbitd.android.core.schedule.ScheduleDisplay.Mark
import io.orbitd.android.core.schedule.ScheduleDisplay.Tag
import io.orbitd.android.core.schedule.ScheduleDisplay.TagTone
import io.orbitd.android.core.schedule.ScheduleDisplay.TimelineGroup
import io.orbitd.android.core.schedule.ScheduleDisplay.TimelineItem
import io.orbitd.android.core.schedule.ScheduleDisplay.WaitingText
import java.time.Instant
import java.time.OffsetDateTime
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The scheduled tasks' display rules say what OrbitKit's and the web's say: OrbitKit's ScheduleDisplayTests, case for
 * case (the ones about Apple-only types — Session, Notifications, the drawer — are left to the app). */
class ScheduleDisplayTest {
    // The boards' demo day: Friday Nov 14, 12:19 in Asia/Shanghai (UTC+8, no DST).
    private val tz = "Asia/Shanghai"
    private val now: Instant = Instant.parse("2025-11-14T04:19:00.000Z")

    /** An instant from a Shanghai wall clock, as the server writes it. */
    private fun sh(local: String): String = OffsetDateTime.parse("$local:00+08:00").toInstant().toString()
    private fun at(local: String): Instant = ScheduleDisplay.parse(sh(local))!!
    private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

    private var seq = 0
    private fun schedule(title: String? = null, rule: ScheduleRule = ScheduleRule.Daily("09:00"), workspaceName: String? = "apiserver",
                         accessLevel: String = "CHECK_ONLY", state: String = "ACTIVE", heldReason: String? = null,
                         nextDueAt: String? = null, consecutiveFailures: Int = 0): ScheduleView {
        seq += 1
        return ScheduleView(id = "s$seq", title = title ?: "Schedule $seq", rule = rule, timezone = tz, workspaceId = "w1",
            workspaceName = workspaceName, accessLevel = accessLevel, state = state, heldReason = heldReason, nextDueAt = nextDueAt,
            consecutiveFailures = consecutiveFailures)
    }

    private fun run(s: ScheduleView, state: String, plannedAt: String) =
        ScheduleRunView(id = "r-${s.id}-$plannedAt", scheduleId = s.id, plannedAt = plannedAt, state = state, startedAt = plannedAt)

    private fun names(groups: List<TimelineGroup>): List<String> = groups.map { g ->
        val items = g.items.map { item ->
            when (item) {
                is TimelineItem.Schedule -> item.schedule.title
                is TimelineItem.Run -> item.schedule.title
                is TimelineItem.Draft -> item.card.title ?: ""
                is TimelineItem.Task -> item.task.title
                is TimelineItem.Missed -> item.schedule.title
            }
        }
        "${g.title}|${g.subtitle ?: "nil"}|${items.joinToString(",")}"
    }

    // timeline

    @Test fun boardOneLayout() {
        val sweep = schedule("Nightly pg spec sweep", nextDueAt = sh("2025-11-15T02:00"), consecutiveFailures = 3)
        val audit = schedule("Weekly dependency audit", state = "HELD", heldReason = "AGENT_DISABLED")
        val docs = schedule("Docs link check", nextDueAt = sh("2025-11-15T12:00"))
        val notes = schedule("Release notes draft", nextDueAt = sh("2025-11-14T17:00"))
        val deploy = schedule("Deploy health check", rule = ScheduleRule.Once("2025-11-14T18:00"), nextDueAt = sh("2025-11-14T18:00"))
        val codex = schedule("Codex stable check", nextDueAt = sh("2025-11-15T09:00"))
        val cost = schedule("Weekly cost report", nextDueAt = sh("2025-11-17T10:00"))
        val csp = schedule("Gateway CSP report digest", state = "PAUSED")
        val gone = schedule("Ended one", state = "ENDED")
        val groups = ScheduleDisplay.timeline(listOf(sweep, audit, docs, notes, deploy, codex, cost, csp, gone),
            runs = listOf(run(docs, "RUNNING", sh("2025-11-14T12:00"))), now = now, timezone = tz)
        assertEquals(listOf(
            "Today|Fri, Nov 14|Docs link check,Release notes draft,Deploy health check",
            "Tomorrow|Sat, Nov 15|Nightly pg spec sweep,Codex stable check,Docs link check",
            "Monday|Nov 17|Weekly cost report",
            "Paused|2|Weekly dependency audit,Gateway CSP report digest",
        ), names(groups))
        assertEquals(listOf(GroupKey.today, GroupKey.tomorrow, GroupKey.day, GroupKey.paused), groups.map { it.key })
        assertTrue("the running run leads Today", groups[0].items[0] is TimelineItem.Run)
    }

    // No Needs you group (owner 2026-11-19): a failing schedule is tagged on its own row, on the day of its next run.
    @Test fun aFailingScheduleIsTaggedOnItsDayRow() {
        val sweep = schedule("Nightly pg spec sweep", nextDueAt = sh("2025-11-15T02:00"), consecutiveFailures = 3)
        val groups = ScheduleDisplay.timeline(listOf(sweep), now = now, timezone = tz)
        assertEquals(listOf("Tomorrow|Sat, Nov 15|Nightly pg spec sweep"), names(groups))
        assertEquals(CircleView(Circle.failed, Mark.alert, Tag(TagTone.fail, "Failed 3 in a row")), ScheduleDisplay.rowCircle(sweep, emptyList()))
        assertEquals(1, ScheduleDisplay.needsYouCount(listOf(sweep)))
    }

    @Test fun aRunUnderWayClearsTheFailure() {
        val sweep = schedule("Nightly pg spec sweep", nextDueAt = sh("2025-11-15T02:00"), consecutiveFailures = 3)
        for (state in listOf("QUEUED", "RUNNING", "AWAITING_APPROVAL")) {
            val runs = listOf(run(sweep, state, sh("2025-11-14T12:00")))
            assertEquals(state, CircleView(Circle.open), ScheduleDisplay.rowCircle(sweep, runs))
            assertEquals(state, 0, ScheduleDisplay.needsYouCount(listOf(sweep), runs = runs))
        }
        // An ended run does not: the failure stays until the server resets the count.
        val ended = listOf(run(sweep, "FAILED", sh("2025-11-14T12:00")))
        assertEquals(Circle.failed, ScheduleDisplay.rowCircle(sweep, ended).circle)
        assertEquals(1, ScheduleDisplay.needsYouCount(listOf(sweep), runs = ended))
        // Another schedule's run under way is not this one's.
        val other = schedule("Other")
        assertEquals(1, ScheduleDisplay.needsYouCount(listOf(sweep), runs = listOf(run(other, "RUNNING", sh("2025-11-14T12:00")))))
    }

    @Test fun heldSchedulesLeadPaused() {
        val zeta = schedule("Zeta held", state = "HELD", heldReason = "AGENT_DISABLED")
        val alpha = schedule("Alpha paused", state = "PAUSED")
        val beta = schedule("Beta held", state = "HELD", heldReason = "AGENT_DISABLED")
        val groups = ScheduleDisplay.timeline(listOf(zeta, alpha, beta), now = now, timezone = tz)
        assertEquals(listOf("Paused|3|Beta held,Zeta held,Alpha paused"), names(groups))
        assertEquals(Tag(TagTone.held, "Held"), ScheduleDisplay.rowCircle(beta, emptyList()).tag)
        assertEquals(2, ScheduleDisplay.needsYouCount(listOf(zeta, alpha, beta)))
    }

    @Test fun splitsAtLocalMidnight() {
        val late = schedule("Late", nextDueAt = sh("2025-11-14T23:30"))
        val early = schedule("Early", nextDueAt = sh("2025-11-15T00:30"))
        assertEquals(listOf("Today|Fri, Nov 14|Late", "Tomorrow|Sat, Nov 15|Early"),
            names(ScheduleDisplay.timeline(listOf(early, late), now = now, timezone = tz)))
    }

    @Test fun readsDaysInTheViewersZone() {
        val late = schedule("Late", nextDueAt = sh("2025-11-14T23:30"))
        val early = schedule("Early", nextDueAt = sh("2025-11-15T00:30"))
        assertEquals(listOf("Tomorrow|Fri, Nov 14|Late,Early"),
            names(ScheduleDisplay.timeline(listOf(early, late), now = now, timezone = "America/Los_Angeles")))
    }

    @Test fun midnightEdges() {
        val s = schedule("Midnight", nextDueAt = sh("2025-11-15T00:00"))
        assertEquals(listOf("Tomorrow"), ScheduleDisplay.timeline(listOf(s), now = at("2025-11-14T23:59"), timezone = tz).map { it.title })
        assertEquals(listOf("Today|Sat, Nov 15|Midnight"), names(ScheduleDisplay.timeline(listOf(s), now = at("2025-11-15T00:00"), timezone = tz)))
    }

    @Test fun theComingWeekThenLater() {
        fun on(d: String) = schedule(d, nextDueAt = sh("${d}T09:00"))
        val groups = ScheduleDisplay.timeline(listOf(on("2025-11-16"), on("2025-11-17"), on("2025-11-20"), on("2025-11-21"), on("2025-12-01")),
            now = now, timezone = tz)
        assertEquals(listOf("Sunday|Nov 16|2025-11-16", "Monday|Nov 17|2025-11-17", "Thursday|Nov 20|2025-11-20",
            "Later|nil|2025-11-21,2025-12-01"), names(groups))
    }

    @Test fun onASundayMondayIsTomorrow() {
        val mon = schedule("Mon", nextDueAt = sh("2025-11-17T09:00"))
        val sat = schedule("Sat", nextDueAt = sh("2025-11-22T09:00"))
        val sun = schedule("Sun", nextDueAt = sh("2025-11-23T09:00"))
        assertEquals(listOf("Tomorrow|Mon, Nov 17|Mon", "Saturday|Nov 22|Sat", "Later|nil|Sun"),
            names(ScheduleDisplay.timeline(listOf(sun, sat, mon), now = at("2025-11-16T20:00"), timezone = tz)))
    }

    @Test fun acrossAYearEnd() {
        val s = schedule("New year", nextDueAt = sh("2026-01-01T09:00"))
        assertEquals(listOf("Tomorrow|Thu, Jan 1"),
            ScheduleDisplay.timeline(listOf(s), now = at("2025-12-31T22:00"), timezone = tz).map { "${it.title}|${it.subtitle ?: ""}" })
    }

    @Test fun aSlotAlreadyDueIsToday() {
        val s = schedule("Due", nextDueAt = sh("2025-11-13T09:00"))
        assertEquals(listOf("Today"), ScheduleDisplay.timeline(listOf(s), now = now, timezone = tz).map { it.title })
    }

    @Test fun pastRunsOnlyWithShowPastRunsAndOnlyToday() {
        val s = schedule("Codex stable check", nextDueAt = sh("2025-11-15T09:00"))
        val runs = listOf(run(s, "CHANGED", sh("2025-11-14T10:00")), run(s, "NO_CHANGE", sh("2025-11-13T10:00")))
        assertEquals(listOf("Tomorrow"), ScheduleDisplay.timeline(listOf(s), runs, now = now, timezone = tz).map { it.title })
        val shown = ScheduleDisplay.timeline(listOf(s), runs, showPastRuns = true, now = now, timezone = tz)
        assertEquals(listOf("Today|Fri, Nov 14|Codex stable check", "Tomorrow|Sat, Nov 15|Codex stable check"), names(shown))
        assertEquals("CHANGED", (shown[0].items[0] as TimelineItem.Run).run.state)
    }

    @Test fun aDraftOnTheDayOfItsFirstRun() {
        val card = ScheduleCard(id = "c1", kind = "CREATE", title = "Weekday issue summary",
            `when` = ScheduleCardWhen(ScheduleRule.Weekly("09:00", listOf("MON", "TUE", "WED", "THU", "FRI")), tz, sh("2025-11-17T09:00")))
        val cost = schedule("Weekly cost report", nextDueAt = sh("2025-11-17T10:00"))
        assertEquals(listOf("Monday|Nov 17|Weekday issue summary,Weekly cost report"),
            names(ScheduleDisplay.timeline(listOf(cost), drafts = listOf(card), now = now, timezone = tz)))
    }

    // circles

    @Test fun everyRunStateHasACircle() {
        val expected = mapOf(
            "QUEUED" to Triple(Circle.open, Mark.clock, null), "RUNNING" to Triple(Circle.running, null, null),
            "AWAITING_APPROVAL" to Triple(Circle.held, Mark.alert, "Waiting for you"), "NO_CHANGE" to Triple(Circle.done, Mark.check, "No change"),
            "CHANGED" to Triple(Circle.done, Mark.check, "Known"), "FAILED" to Triple(Circle.failed, Mark.alert, "Failed"),
            "SKIPPED" to Triple(Circle.muted, Mark.check, "Skipped"), "MISSED" to Triple(Circle.muted, Mark.check, "Missed"),
            "HELD" to Triple(Circle.held, Mark.alert, "Held"), "CANCELLED" to Triple(Circle.muted, Mark.check, "Cancelled"),
        )
        for ((state, want) in expected) {
            val v = ScheduleDisplay.runCircle(state)
            assertEquals(state, want.first, v.circle)
            assertEquals(state, want.second, v.mark)
            assertEquals(state, want.third, v.tag?.text)
        }
        assertEquals(CircleView(Circle.new, Mark.check, Tag(TagTone.new, "New")), ScheduleDisplay.runCircle("CHANGED", newFinding = true))
    }

    @Test fun everyScheduleStateHasACircle() {
        assertEquals(Circle.open, ScheduleDisplay.scheduleCircle("ACTIVE", 0).circle)
        assertEquals(CircleView(Circle.failed, Mark.alert, Tag(TagTone.fail, "Failed 3 in a row")), ScheduleDisplay.scheduleCircle("ACTIVE", 3))
        assertEquals("Failed", ScheduleDisplay.scheduleCircle("ACTIVE", 1).tag?.text)
        assertEquals(Tag(TagTone.held, "Held"), ScheduleDisplay.scheduleCircle("HELD", 0).tag)
        assertEquals(Circle.paused, ScheduleDisplay.scheduleCircle("PAUSED", 0).circle)
        assertEquals(Circle.muted, ScheduleDisplay.scheduleCircle("ENDED", 0).circle)
        assertEquals(Circle.draft, ScheduleDisplay.scheduleCircle("ACTIVE", 0, draft = true).circle)
        assertEquals(false, ScheduleDisplay.needsYou("PAUSED", 2))
        // The drawer's number: failing (with no run under way) or held, nothing else.
        assertEquals(2, ScheduleDisplay.needsYouCount(listOf(schedule(consecutiveFailures = 2), schedule(state = "HELD"),
            schedule(state = "PAUSED"), schedule())))
    }

    @Test fun landMayCopy() {
        assertEquals("Edit and land on main · edits in its own worktree, then Orbit merges it into main after the run. It can't release or deploy.", ScheduleDisplay.mayText("LAND"))
        assertEquals(2, ScheduleDisplay.accessOrder["LAND"])
    }

    // lines

    @Test fun rowLinesReadLikeBoardOne() {
        fun line(s: ScheduleView, agent: String? = null, pausedAt: String? = null, running: Int? = null, draft: Boolean = false) =
            ScheduleDisplay.rowLine(s.rule, s.workspaceName, s.accessLevel, s.state, s.heldReason, agent,
                pausedAt?.let(ScheduleDisplay::parse), tz, running, draft)
        assertEquals("Every day at 02:00 · apiserver · Check only", line(schedule(rule = ScheduleRule.Daily("02:00"))))
        assertEquals("Every Friday at 17:00 · Orbit baseline · Open a PR",
            line(schedule(rule = ScheduleRule.Weekly("17:00", listOf("FRI")), workspaceName = "Orbit baseline", accessLevel = "OPEN_PR")))
        assertEquals("Once · apiserver · Check only", line(schedule(rule = ScheduleRule.Once("2025-11-14T18:00"))))
        assertEquals("Every Monday at 09:00 · web · the agent \"auditor\" is disabled",
            line(schedule(rule = ScheduleRule.Weekly("09:00", listOf("MON")), workspaceName = "web", state = "HELD",
                heldReason = "AGENT_DISABLED"), agent = "auditor"))
        assertEquals("Every day at 12:00 · web · Check only · running for 21 min",
            line(schedule(rule = ScheduleRule.Daily("12:00"), workspaceName = "web"), running = 21))
        assertEquals("Every day at 08:00 · web · paused Nov 7",
            line(schedule(rule = ScheduleRule.Daily("08:00"), workspaceName = "web", state = "PAUSED"), pausedAt = sh("2025-11-07T15:00")))
        assertEquals("Weekdays at 09:00 · apiserver · Check only · draft, waiting for you",
            line(schedule(rule = ScheduleRule.Weekly("09:00", listOf("MON", "TUE", "WED", "THU", "FRI"))), draft = true))
    }

    @Test fun pastRunLines() {
        assertEquals("Ended without a report", ScheduleDisplay.runLine("FAILED", null, "NO_REPORT", null))
        assertEquals("2.1.310 is out · you were notified", ScheduleDisplay.runLine("CHANGED", "2.1.310 is out", null, null, notified = true))
        assertEquals("0.49.0 again · linked PR #831 · not notified", ScheduleDisplay.runLine("CHANGED", "0.49.0 again · linked PR #831", null, null))
        assertEquals("Over budget: 7 of 7 runs this week",
            ScheduleDisplay.runLine("MISSED", null, "OVER_BUDGET", "Over budget: 7 of 7 runs this week"))
        // A reported failure says what the run reported, as its Waiting card and push do (W3, schedule.spec.ts).
        assertEquals("Reported a failure: The releases page returned 503",
            ScheduleDisplay.runLine("FAILED", "The releases page returned 503.", "REPORTED_FAILED", null))
        assertEquals("Reported a failure", ScheduleDisplay.runLine("FAILED", null, "REPORTED_FAILED", null))
    }

    @Test fun whenText() {
        fun on(local: String) = ScheduleDisplay.whenText(at(local), now, tz)
        assertEquals("Today 02:00", on("2025-11-14T02:00"))
        assertEquals("Tomorrow 09:00", on("2025-11-15T09:00"))
        assertEquals("Monday 09:00", on("2025-11-17T09:00"))
        assertEquals("Nov 24 09:00", on("2025-11-24T09:00"))
    }

    // cards

    @Test fun createCardWhen() {
        val daily = ScheduleDisplay.createWhen(ScheduleCardWhen(ScheduleRule.Daily("10:00"), tz, sh("2025-11-15T10:00")), now, tz)
        assertEquals("Daily 10:00 · Asia/Shanghai · first run tomorrow", daily.text)
        val draft = ScheduleDisplay.createWhen(ScheduleCardWhen(ScheduleRule.Weekly("09:00", listOf("MON", "TUE", "WED", "THU", "FRI")), tz,
            sh("2025-11-17T09:00")), now, tz)
        assertEquals("Weekdays at 09:00 · Asia/Shanghai", "${draft.rule} · ${draft.zone}")
        assertEquals("First run Monday", draft.firstRun)
        assertEquals("Daily 10:00 · your time zone",
            ScheduleDisplay.createWhen(ScheduleCardWhen(ScheduleRule.Daily("10:00"), null, null), now, tz).text)
    }

    @Test fun waitingOnYouCards() {
        assertEquals(WaitingText("Nightly pg spec sweep failed 3 runs in a row", "Scheduled",
            "The last run ended without a report (Nov 14, 02:00). It keeps running on schedule until you pause it. Open the run " +
                "to see where it stopped, or ask a session to fix the prompt.", listOf("Open run", "Pause schedule")),
            ScheduleDisplay.failedWaiting("Nightly pg spec sweep", 3, "NO_REPORT", null, plannedAt = sh("2025-11-14T02:00"), timezone = tz))
        assertEquals(WaitingText("Weekly dependency audit is held", "Scheduled",
            "It could not start on Monday 09:00: the agent \"auditor\" in workspace web is disabled. Nothing runs until it is " +
                "enabled and you resume.", listOf("Open agent settings", "Resume")),
            ScheduleDisplay.heldWaiting("Weekly dependency audit", "AGENT_DISABLED", sh("2025-11-10T09:00"), "auditor", "web",
                at("2025-11-10T09:01"), tz))
        assertEquals(WaitingText("Nightly pg spec sweep wants to run a command", "Scheduled run",
            "If nobody answers by 04:00 this run fails; the next one starts tomorrow.", listOf("Always allow", "Allow once", "Deny"),
            "Always allow covers psql:* in apiserver: later runs won't ask for this."),
            ScheduleDisplay.approvalWaiting("Nightly pg spec sweep", sh("2025-11-14T04:00"), sh("2025-11-15T02:00"), "psql:*", "apiserver",
                at("2025-11-14T02:03"), tz))
        val held = ScheduleDisplay.heldWaiting("Audit", "AGENT_DISABLED", sh("2025-10-27T09:00"), now = now, timezone = tz)
        assertEquals("It could not start on Oct 27, 09:00: its agent is disabled. Nothing runs until it is enabled and you resume.", held.body)
    }

    /** S5's pushes, the reported failure's own words and the create card's last line (scheduleContract.spec.ts). */
    @Test fun thePushesTheReportedFailureAndTheNotice() {
        val push = ScheduleDisplay.failedPush("Nightly pg spec sweep", 3, "NO_REPORT", null, plannedAt = "2026-11-13T18:00:00.000Z", timezone = tz)
        assertEquals("Nightly pg spec sweep failed 3 runs in a row", push.title)
        assertEquals("The last run ended without a report. It keeps running until you pause it.", push.body)
        assertEquals("The last run reported a failure: The releases page returned 503. It keeps running until you pause it.",
            ScheduleDisplay.failedPush("Codex stable check", 1, "REPORTED_FAILED", null, "The releases page returned 503.",
                "2026-11-14T02:00:00.000Z", tz).body)
        assertTrue(ScheduleDisplay.failedWaiting("Codex stable check", 1, "REPORTED_FAILED", null, "The releases page returned 503.",
            "2026-11-14T02:00:00.000Z", tz).body.startsWith("The last run reported a failure: The releases page returned 503 ("))
        assertEquals("Release 2.0 freeze watch ended itself", ScheduleDisplay.goalReachedPushTitle("Release 2.0 freeze watch"))
        assertEquals("You'll hear about new versions and failures only.", ScheduleDisplay.createNotice("versions"))
        assertEquals("You'll hear about new issues and failures only.", ScheduleDisplay.createNotice("issues"))
        assertEquals(ScheduleCopy.CreateCard.notice, ScheduleDisplay.createNotice(null))
        assertEquals(ScheduleCopy.CreateCard.notice, ScheduleDisplay.createNotice("findings"))
    }

    /** A long reported summary is one line of at most 120 characters, ending in an ellipsis. */
    @Test fun aLongReportedSummaryIsClipped() {
        val clause = ScheduleDisplay.reportedFailureClause("REPORTED_FAILED", null, "word ".repeat(40) + "\n end.")!!
        val summary = clause.removePrefix("reported a failure: ")
        assertEquals(120, summary.length)
        assertTrue(summary.endsWith("…"))
        assertNull(ScheduleDisplay.reportedFailureClause("REPORTED_FAILED", "server words", "x"))
    }

    /** S5's schedule names its agent and engine. A hold says which agent. */
    @Test fun theScheduleNamesItsAgentAndEngine() {
        val s = ScheduleView.parse(json("""{"id":"a","title":"Weekly dependency audit","rule":{"kind":"WEEKLY","time":"09:00","weekdays":["MON"]},
            "timezone":"UTC","workspaceId":"w","workspaceName":"web","state":"HELD","heldReason":"AGENT_DISABLED",
            "agentName":"auditor","engine":"codex"}"""))!!
        assertEquals("auditor", s.agentName)
        assertEquals("It could not start on Monday 09:00: the agent \"auditor\" in workspace web is disabled. Nothing runs until it is " +
            "enabled and you resume.", ScheduleDisplay.heldWaiting(s.title, s.heldReason, sh("2025-11-10T09:00"), s.agentName, s.workspaceName,
                at("2025-11-10T09:01"), tz).body)
        assertEquals("codex", s.engine)
        val card = ScheduleCard.parse(json("""{"id":"c","kind":"CREATE","notice":"You'll hear about new versions and failures only."}"""))!!
        assertEquals("You'll hear about new versions and failures only.", card.notice)
    }

    @Test fun theRunsSession() {
        assertEquals("Scheduled run · planned 10:00, started 10:01 · access Check only",
            ScheduleDisplay.runStripText(sh("2025-11-13T10:00"), sh("2025-11-13T10:01"), "CHECK_ONLY", tz))
        assertEquals("run of Nov 13", ScheduleDisplay.runOfText(sh("2025-11-13T10:00"), tz))
        assertEquals("Run of Nov 13", ScheduleDisplay.capitalizedRunOf(sh("2025-11-13T10:00"), tz))
        assertEquals("Reported: Changed · codex@0.49.0 · you were notified", ScheduleDisplay.reportedText("CHANGED", "codex@0.49.0", notified = true))
        assertEquals("Reported: No change", ScheduleDisplay.reportedText("NO_CHANGE", null))
    }

    @Test fun theDeleteConfirmationNamesTheSchedule() {
        assertEquals("Delete “Codex stable check”?", ScheduleDisplay.deleteTitle("Codex stable check"))
    }

    /** The list's own timeline runs (W2) and a run's session's `run` decode, with the facts the list worked out. */
    @Test fun theListsRunsAndTheSessionsRunDecode() {
        val read = ScheduleListResponse.parse(json("""{"schedules":[{"id":"a","title":"A","rule":{"kind":"DAILY","time":"09:00"},"timezone":"UTC",
            "workspaceId":"w","state":"PAUSED","pausedAt":"2025-11-07T07:00:00.000Z"}],
            "runs":[{"id":"r","scheduleId":"a","plannedAt":"2025-11-14T02:00:00.000Z","state":"CHANGED","key":"k","newFinding":true,"notified":true}]}"""))!!
        assertEquals("2025-11-07T07:00:00.000Z", read.schedules.first().pausedAt)
        val facts = ScheduleDisplay.runFindingFacts(read.runs!!.first(), emptyList())
        assertTrue(facts.newFinding && facts.notified)
        assertNull(ScheduleListResponse.parse(json("""{"schedules":[]}"""))!!.runs)
        val cards = SessionScheduleCardsResponse.parse(json("""{"run":{"id":"r","scheduleId":"a","plannedAt":"2025-11-13T02:00:00.000Z",
            "state":"RUNNING"},"cards":[],"records":[]}"""))!!
        assertEquals("r", cards.run?.id)
    }

    /** Without the list's own facts, a run's finding is new when it first appeared in this run, by either spelling of the id. */
    @Test fun findingFactsFromTheSchedulesFindings() {
        val uuid = "0b3c9a2e-5d1f-4c8e-9a7b-112233445566"
        val run = ScheduleRunView(id = uuid.uppercase(), scheduleId = "a", plannedAt = "2025-11-14T02:00:00.000Z", state = "CHANGED", key = "k")
        val finding = ScheduleFindingView(key = "k", firstRunId = uuid, notifiedAt = "2025-11-14T02:05:00.000Z")
        assertEquals(ScheduleDisplay.FindingFacts(true, true), ScheduleDisplay.runFindingFacts(run, listOf(finding)))
        assertEquals(ScheduleDisplay.FindingFacts(false, false), ScheduleDisplay.runFindingFacts(run, listOf(finding.copy(firstRunId = "other"))))
        assertEquals(ScheduleDisplay.FindingFacts(false, false), ScheduleDisplay.runFindingFacts(run.copy(key = null), listOf(finding)))
    }

    @Test fun fillLeavesAMissingPlaceholderShowing() {
        assertEquals("x and {b}", ScheduleDisplay.fill("{a} and {b}", mapOf("a" to "x")))
        assertEquals("no { brace", ScheduleDisplay.fill("no { brace", emptyMap()))
    }

    // decoding

    /** A create card and a list row as the server writes them (schedule-views.ts) decode with every field the cards draw;
     * an unknown state or reason costs nothing. */
    @Test fun theDoorsAnswersDecode() {
        val decoded = ScheduleCard.parse(json("""{"id":"r1","kind":"CREATE","state":"PENDING","askedBy":"SESSION","askedBySessionId":"s1",
            "scheduleId":null,"createdAt":"2025-11-14T02:00:00.000Z","decidedAt":null,"resultRevision":null,
            "decision":{"allow":"/api/schedule-requests/r1/allow","decline":"/api/schedule-requests/r1/decline"},
            "title":"Codex stable check","readBack":"Every day at 10:00…","intent":"every day at 10",
            "when":{"rule":{"kind":"DAILY","time":"10:00"},"timezone":null,"firstRunAt":null,"text":"Daily 10:00 · your time zone"},
            "runsIn":{"workspaceId":"w1","workspaceName":"apiserver","engine":"codex","text":"apiserver · Codex agent"},
            "may":{"accessLevel":"CHECK_ONLY","text":"Check only"},"costs":{"runsPerWeek":7,"runLimitMinutes":30,"text":"x"},
            "today":{"key":"codex@0.48.0","summary":"Codex 0.48.0, same as pinned.","text":"x"},"notice":"n","envelope":null}"""))!!
        assertTrue(decoded.isCreate && decoded.isPending)
        assertNull(decoded.`when`?.timezone)
        assertEquals("codex", decoded.runsIn?.engine)
        assertEquals(7, decoded.costs?.runsPerWeek)
        val rows = ScheduleListResponse.parse(json("""{"schedules":[{"id":"a","title":"A","rule":{"kind":"WEEKLY","time":"09:00","weekdays":["MON"]},
            "timezone":"UTC","workspaceId":"w","state":"SOMETHING_NEW","consecutiveFailures":0,"lastRun":{"id":"r","scheduleId":"a",
            "plannedAt":"2025-11-14T02:00:00.000Z","state":"FAILED","failureReason":"A_NEW_REASON"}}, {"id":"broken"}]}"""))!!.schedules
        assertEquals("a row this build cannot read is dropped, not the list", listOf("a"), rows.map { it.id })
        assertEquals(ScheduleRule.Weekly("09:00", listOf("MON")), rows[0].rule)
        assertEquals("A_NEW_REASON", rows[0].lastRun?.failureReason)
        assertNull(ScheduleDisplay.failureClause("A_NEW_REASON", null))
    }

    /** The four Waiting on you kinds ride the owner-request list beside the kinds `OwnerRequest` reads; an unknown kind and an
     * owner request are no schedule item. */
    @Test fun scheduleItemsRideTheOwnerRequestList() {
        val items = ScheduleWaitingItem.fromRequestList(json("""{"requests":[
            {"id":"o1","kind":"SCHEDULE_FAILED","state":"PENDING","title":"t","why":"w","scheduleId":"S1","scheduleRunId":"R1",
             "askedBySessionId":"s","createdAt":"2025-11-14T02:41:00.000Z"},
            {"id":"o2","kind":"DECISION","state":"PENDING","title":"t","why":"w","askedBySessionId":"s","createdAt":"2025-11-14T02:41:00.000Z",
             "blocksTaskIds":[]},
            {"id":"o3","kind":"SOMETHING_ELSE","state":"PENDING","title":"t","why":"w","askedBySessionId":"s","createdAt":"2025-11-14T02:41:00.000Z"}]}"""))
        assertEquals(listOf("o1"), items.map { it.id })
        assertEquals("R1", items.first().scheduleRunId)
    }

    @Test fun everySentenceEndLineAndMissedRow() {
        val workdays = listOf("MON", "TUE", "WED", "THU", "FRI")
        val all = listOf("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")
        fun text(rule: ScheduleRule) = ScheduleDisplay.ruleText(rule)
        assertEquals("Every 30 min, 09:00–18:00, Mon–Fri", text(ScheduleRule.Every(30, "09:00", workdays, "18:00")))
        assertEquals("Every hour", text(ScheduleRule.Every(60, "00:00", all)))
        assertEquals("Every 2 hours from 08:00, weekends", text(ScheduleRule.Every(120, "08:00", listOf("SAT", "SUN"))))
        assertEquals("Every 6 hours, Mon, Thu", text(ScheduleRule.Every(360, "00:00", listOf("MON", "THU"))))
        assertEquals(text(ScheduleRule.Every(30, "09:00", workdays)), ScheduleDisplay.ruleText(ScheduleRule.Every(30, "09:00", workdays), ScheduleDisplay.RuleForm.long))

        val now = java.time.Instant.parse("2026-11-20T10:00:00Z")
        val rule = ScheduleRule.Every(30, "09:00", workdays)
        fun view(endAt: String? = null, maxRuns: Int? = null, runsLeft: Int? = null) =
            ScheduleView("s", "Poll", rule = rule, timezone = "UTC", workspaceId = "w", endAt = endAt, maxRuns = maxRuns, runsLeft = runsLeft)
        assertEquals("until 18:00 today", ScheduleDisplay.endText(view(endAt = "2026-11-20T18:00:00Z"), now, "UTC"))
        assertEquals("until 09:00 tomorrow", ScheduleDisplay.endText(view(endAt = "2026-11-21T09:00:00Z"), now, "UTC"))
        assertEquals("until Nov 25", ScheduleDisplay.endText(view(endAt = "2026-11-25T09:00:00Z"), now, "UTC"))
        assertEquals("3 runs left", ScheduleDisplay.endText(view(maxRuns = 5, runsLeft = 3), now, "UTC"))
        assertEquals("1 run left", ScheduleDisplay.endText(view(maxRuns = 5, runsLeft = 1), now, "UTC"))
        assertEquals("until 18:00 today${ScheduleCopy.separator}1 run left",
            ScheduleDisplay.endText(view(endAt = "2026-11-20T18:00:00Z", maxRuns = 2, runsLeft = 1), now, "UTC"))
        assertNull(ScheduleDisplay.endText(view(), now, "UTC"))

        fun missed(id: String, at: String) = ScheduleRunView(id, "s", plannedAt = at, state = "MISSED")
        val runs = listOf(missed("r1", "2026-11-20T01:00:00Z"), missed("r2", "2026-11-20T01:30:00Z"), missed("r3", "2026-11-20T08:30:00Z"))
        assertEquals("3 slots missed, 01:00–08:30", ScheduleDisplay.missedText(runs, "UTC"))
        assertEquals("2 slots missed, Nov 19, 22:00–Nov 20, 06:30",
            ScheduleDisplay.missedText(listOf(missed("x1", "2026-11-19T22:00:00Z"), missed("x2", "2026-11-20T06:30:00Z")), "UTC"))
        val groups = ScheduleDisplay.timeline(listOf(view()), runs + missed("r4", "2026-11-20T09:00:00Z").copy(state = "CHANGED"),
            showPastRuns = true, now = now, timezone = "UTC")
        val items = groups.flatMap { it.items }
        val collapsed = items.filterIsInstance<ScheduleDisplay.TimelineItem.Missed>().single()
        assertEquals(3, collapsed.runs.size)
        assertEquals(1, items.filterIsInstance<ScheduleDisplay.TimelineItem.Run>().size)
    }

    // Rename (§8.4)

    @Test fun aRenameSavesTheTrimmedTitleAndNothingWhenEmptyOrUnchanged() {
        assertEquals("New name", ScheduleDisplay.renameTitle("  New name \n", "Old name"))
        assertNull(ScheduleDisplay.renameTitle("", "Old name"))
        assertNull(ScheduleDisplay.renameTitle("   ", "Old name"))
        assertNull(ScheduleDisplay.renameTitle("Old name", "Old name"))
        assertNull(ScheduleDisplay.renameTitle(" Old name ", "Old name"))
    }

    @Test fun aPersonsRenameSaysWhatItWasCalled() {
        fun record(changedBy: String, before: String?, after: String) = ScheduleChangeRecord("s", "t", revision = 2, changedBy = changedBy,
            before = before?.let { Json.parseToJsonElement(it) as JsonObject }, after = Json.parseToJsonElement(after) as JsonObject)
        val old = """{"title":"Codex check"}"""
        val new = """{"title":"Codex stable check"}"""
        assertEquals("Renamed from “Codex check”", ScheduleDisplay.renamedText(record("USER", old, new)))
        assertNull(ScheduleDisplay.renamedText(record("SESSION", old, new)))
        assertNull(ScheduleDisplay.renamedText(record("RUN", old, new)))
        assertNull(ScheduleDisplay.renamedText(record("USER", null, new)))
        assertNull(ScheduleDisplay.renamedText(record("USER", old, """{"title":"Codex stable check","note":"n"}""")))
    }
}
