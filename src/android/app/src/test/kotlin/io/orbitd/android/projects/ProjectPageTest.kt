package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/** OrbitKit's project page cases (ProjectPageTests, ProjectPageSectionsTests, ProjectRunSettingsTests), held over the same
 * server JSON the Android page reads; the start card's own cases are StartProjectTest's. */
class ProjectPageTest {
    private val now = Instant.parse("2026-09-24T12:00:00Z")
    private fun iso(secondsBeforeNow: Long) = now.minusSeconds(secondsBeforeNow).toString()
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject

    // MARK: work overview

    @Test fun overviewWithoutIntegrationDrawsTheSevenLanesAndDoneCarriesItsShare() {
        val cells = ProjectPage.overviewCells(j("""{"running":4,"ready":1,"blocked":2,"done":27}"""), 34, null, null)
        assertEquals(listOf("Running", "Ready", "Waiting", "Awaiting verification", "Done", "Failed", "Cancelled"), cells.map { it.label })
        assertEquals("79% complete", cells.first { it.key == "done" }.footnote)
        assertEquals("no tasks yet", ProjectPage.overviewCells(j("{}"), 0, null, null).first { it.key == "done" }.footnote)
    }

    @Test fun overviewWithIntegrationSplitsDoneAndShowsOnlyNonZeroExtras() {
        val b = j("""{"running":4,"ready":0,"blocked":2,"done":28,"failed":1,"integrating":1,"onIntegrationLine":4,"onUpstream":23,"doneNotIntegrated":0,"waitingForLanding":1}""")
        val branch = ProjectPage.overviewCells(b, 35, "PROJECT_BRANCH", null)
        assertEquals(listOf("Running", "Ready", "Waiting", "Pending landing", "On project branch", "On main", "Failed"), branch.map { it.label })
        assertEquals("1 waiting for a prerequisite to land", branch.first { it.key == "blocked" }.footnote)
        assertEquals("no landing receipt yet", branch.first { it.key == "integrating" }.footnote)
        assertFalse(ProjectPage.overviewCells(b, 35, "MAIN", null).any { it.key == "onIntegrationLine" })
        assertEquals("34 tasks · 18 dependencies", ProjectPage.overviewSubtitle(j("""{"taskCount":34,"edgeCount":18}""")))
        assertEquals("1 task · 1 dependency", ProjectPage.overviewSubtitle(j("""{"taskCount":1,"edgeCount":1}""")))
    }

    @Test fun readyWorkWaitsForTheStartThePauseOrAHand() {
        val buckets = j("""{"ready":2,"blocked":3}""")
        assertEquals(ProjectPage.readyUntilStarted, ProjectPage.overviewCells(buckets, 5, null, false).first { it.key == "ready" }.footnote)
        assertEquals("can start now", ProjectPage.overviewCells(buckets, 5, null, true).first { it.key == "ready" }.footnote)
        val one = j("""{"ready":1}""")
        assertEquals("can start manually", ProjectPage.overviewCells(one, 1, null, null, manualReadyCount = 1).first { it.key == "ready" }.footnote)
        assertEquals("project is paused", ProjectPage.overviewCells(one, 1, null, null, paused = true, manualReadyCount = 1).first { it.key == "ready" }.footnote)
        val queue = j("""{"readyCount":7,"manualReady":{"count":7,"taskId":"t","title":"Check the lock order"}}""")
        assertEquals("t", ProjectPage.manualReady(queue, "OPEN", null, false)?.text("taskId"))
        assertNull(ProjectPage.manualReady(queue, "OPEN", false, false))
        assertNull(ProjectPage.manualReady(queue, "OPEN", null, true))
        assertNull(ProjectPage.manualReady(queue, "DONE", null, false))
        assertNull(ProjectPage.manualReady(j("""{"readyCount":7}"""), "OPEN", null, false))
        assertNull(ProjectPage.manualReady(null, "OPEN", null, false))
        assertEquals("7 tasks are set to start manually.", ProjectPage.manualReadySentence(7))
        assertEquals("1 task is set to start manually.", ProjectPage.manualReadySentence(1))
    }

    @Test fun anOpenProjectWhoseWorkHasAllSettledIsReadyToWrapUp() {
        val settled = j("""{"done":12,"cancelled":1}""")
        assertTrue(ProjectPage.wrappingUp("OPEN", settled, null))
        assertFalse(ProjectPage.wrappingUp("DONE", settled, null))
        assertFalse(ProjectPage.wrappingUp("OPEN", j("""{"ready":1,"done":12}"""), null))
        assertFalse(ProjectPage.wrappingUp("OPEN", j("{}"), null))
        assertFalse(ProjectPage.wrappingUp("OPEN", j("""{"done":1,"integrating":1}"""), null))
        assertFalse(ProjectPage.wrappingUp("OPEN", j("""{"done":1,"onIntegrationLine":1}"""), null))
        assertFalse(ProjectPage.wrappingUp("OPEN", settled, j("""{"state":"QUEUED","startedAt":""}""")))
        assertEquals("All 13 tasks are settled. The project stays open until its outcome is confirmed.", ProjectPage.wrapUpSentence(13))
    }

    // MARK: the landing in flight

    @Test fun theLandingLineNamesTheTaskAndCountsSecondsWhileTheChecksRun() {
        val view = j("""{"integratingCount":1,"queuedCount":0,"inFlight":{"taskTitle":"T2 wiki 契约、迁移与共享类型","state":"RUNNING","startedAt":"${iso(80)}","kind":"LAND_TASK","phase":"CHECK"}}""")
        assertEquals(LandingLine("Landing", "T2 wiki 契约、迁移与共享类型", true, "checking", "1m 20s", "Elapsed", null), ProjectPage.landingLine(view, now, null, false))
        val queued = j("""{"integratingCount":0,"queuedCount":1,"inFlight":{"taskTitle":"T1","state":"QUEUED","startedAt":"${iso(40)}"}}""")
        assertEquals(LandingLine("Integration", "T1", false, "queued", "0m 40s", "Queued for", null), ProjectPage.landingLine(queued, now, null, false))
        val several = j("""{"integratingCount":2,"queuedCount":1,"inFlight":{"taskTitle":"T1","state":"RUNNING","startedAt":"${iso(80)}"}}""")
        assertEquals("3 jobs", ProjectPage.landingLine(several, now, null, false)?.what)
        assertNull(ProjectPage.landingLine(j("""{"integratingCount":0,"queuedCount":0,"inFlight":null}"""), now, null, false))
        assertNull(ProjectPage.landingLine(j("{}"), now, null, false))
        val unreadable = j("""{"integratingCount":1,"queuedCount":0,"inFlight":{"taskTitle":null,"state":"RUNNING","startedAt":"not a date"}}""")
        assertEquals(LandingLine("Integration", null, true, "running", "0m 0s", "Elapsed", null), ProjectPage.landingLine(unreadable, now, null, false))
    }

    @Test fun aLandingThatStoppedReportingFreezesItsClockAndStopsClaimingActivity() {
        val view = j("""{"integratingCount":1,"inFlight":{"state":"RUNNING","startedAt":"${iso(80)}","kind":"LAND_TASK","phase":"CHECK"}}""")
        val later = now.plusSeconds(60)
        val line = ProjectPage.landingLine(view, later, now, true)!!
        assertEquals("Update unavailable", line.state); assertFalse(line.running); assertEquals("1m 20s", line.clock); assertEquals("Updated 1m ago", line.updated)
        assertEquals(false, ProjectPage.landingLine(view, now.plusSeconds(91), now, false)?.running)
        assertEquals(true, ProjectPage.landingLine(view, later, later, false)?.running)
        val stale = j("""{"integratingCount":1,"inFlight":{"state":"RUNNING","startedAt":"${iso(720)}","kind":"LAND_TASK","phase":"CHECK","heartbeatAt":"${iso(660)}"}}""")
        val beat = ProjectPage.landingLine(stale, now, now, false)!!
        assertFalse(beat.running); assertEquals("Update unavailable", beat.state); assertEquals("1m 0s", beat.clock); assertEquals("Updated 11m ago", beat.updated)
        ProjectPage.integrationJobWords.forEach { (kind, word) -> ProjectPage.integrationPhaseWords.forEach { (phase, state) ->
            val job = ProjectPage.landingLine(j("""{"inFlight":{"state":"RUNNING","startedAt":"${iso(80)}","kind":"$kind","phase":"$phase"}}"""), now, null, false)!!
            assertEquals(word, job.word); assertEquals(state, job.state)
        } }
        val promotion = ProjectPage.landingLine(j("""{"inFlight":{"state":"QUEUED","startedAt":"${iso(80)}","kind":"LAND_PROMOTION","phase":"CHECK"}}"""), now, null, false)!!
        assertEquals("Merge to main", promotion.word); assertEquals("queued", promotion.state); assertFalse(promotion.running)
        assertEquals(listOf("1m 20s", "0m 40s", "0m 0s", "0m 59s", "60m 0s", "0m 0s"), listOf(80.0, 40.0, 0.0, 59.0, 3600.0, -5.0).map(ProjectPage::landingClock))
    }

    // MARK: the jobs in flight (iOS 3a5c576fc, ProjectPageTests; docs/mocks/landing-jobs-sheet)

    /** One `inFlightJobs` element, its instants counted in seconds before `now`. */
    private fun job(id: String, kind: String = "LAND_TASK", state: String = "RUNNING", phase: String? = "FETCH", taskId: String? = "t-c5",
        title: String? = "C5 · 托管 runner", generation: Int = 1, started: Long = 80, queued: Long = 95, heartbeat: Long? = 20,
        runner: String? = "workstation-gpu", retriedBy: String? = null, timedOut: Boolean = false, limit: Int? = 600, retryable: Boolean = false) = buildJsonObject {
        put("jobId", id); put("kind", kind); put("state", state); put("phase", phase); put("taskId", taskId); put("taskTitle", title)
        put("generation", generation); put("startedAt", iso(started)); put("queuedAt", iso(queued)); put("heartbeatAt", heartbeat?.let(::iso))
        put("runnerName", runner); put("retriedBy", retriedBy); put("timedOut", timedOut); put("limitSeconds", limit); put("retryable", retryable)
    }
    private fun integration(integrating: Int, queued: Int, inFlight: JsonObject, jobs: List<JsonObject>?) = buildJsonObject {
        put("integratingCount", integrating); put("queuedCount", queued); put("inFlight", inFlight); jobs?.let { put("inFlightJobs", JsonArray(it)) }
    }
    private fun inFlight(title: String? = null, state: String = "RUNNING", started: Long, kind: String? = null, phase: String? = null, heartbeat: Long? = null) =
        buildJsonObject {
            put("taskTitle", title); put("state", state); put("startedAt", iso(started)); put("kind", kind); put("phase", phase); put("heartbeatAt", heartbeat?.let(::iso))
        }
    /** The 21:57 screen: a landing whose runner took it 110 minutes ago and has said nothing since, and a merge into main queued behind it. */
    private fun stuckLanding() = integration(1, 1, inFlight("C5 · 托管 runner", started = 6_630, kind = "LAND_TASK", phase = "FETCH", heartbeat = 6_620), listOf(
        job("j-c5", started = 6_630, queued = 6_640, heartbeat = 6_620, timedOut = true, retryable = true),
        job("j-merge", kind = "LAND_PROMOTION", state = "QUEUED", phase = null, taskId = null, title = null, started = 2_468, queued = 2_468, heartbeat = null,
            runner = null, limit = null)))

    @Test fun theHelpersSayTheCountTheLimitTheTitleAndTheClockTime() {
        assertEquals("2 jobs", ProjectPage.landingJobsCount(2, 0)); assertEquals("2 jobs · 1 timed out", ProjectPage.landingJobsCount(2, 1))
        assertEquals("limit 10m", ProjectPage.landingLimit(600)); assertEquals("limit 75m", ProjectPage.landingLimit(4_500))
        // Rounded as `Math.round` rounds: half a minute goes up.
        assertEquals("limit 11m", ProjectPage.landingLimit(630)); assertEquals("limit 10m", ProjectPage.landingLimit(629))
        assertEquals("1 job in flight", ProjectPage.landingJobsTitle(1)); assertEquals("2 jobs in flight", ProjectPage.landingJobsTitle(2))
        assertEquals("0 jobs in flight", ProjectPage.landingJobsTitle(0))
        val claimed = Instant.parse("2026-10-07T12:07:30.000Z")
        assertEquals("12:07", ProjectPage.landingClockTime(claimed, ZoneOffset.UTC)); assertEquals("20:07", ProjectPage.landingClockTime(claimed, ZoneOffset.ofHours(8)))
        assertEquals("08:07", ProjectPage.landingClockTime(claimed, ZoneOffset.ofHours(-4)))
        assertEquals("22:15", ProjectPage.landingClockTime(claimed.plusSeconds(36_480), ZoneOffset.UTC))
        assertEquals("00:12", ProjectPage.landingClockTime(claimed.plusSeconds(43_500), ZoneOffset.UTC))
    }

    /** On a server that lists its jobs, the count says how many timed out, and a lead the server judged timed out says so. */
    @Test fun theLandingLineSaysTheLeadTimedOutAndCountsTheTimedOutJobs() {
        assertEquals(LandingLine("Landing", "2 jobs · 1 timed out", false, "Timed out", "110m", "No report for", "limit 10m", timedOut = true),
            ProjectPage.landingLine(stuckLanding(), now, now, false))
        // One job: the name slot is its task, as ever.
        val one = integration(1, 0, inFlight("C5", started = 6_630, kind = "LAND_TASK", phase = "CHECK"),
            listOf(job("j", phase = "CHECK", started = 6_630, heartbeat = null, timedOut = true, limit = 4_200)))
        val line = ProjectPage.landingLine(one, now, now, false)!!
        assertEquals("C5", line.what); assertEquals("no report since the claim, when the runner never made one", "110m", line.clock)
        assertEquals("limit 70m", line.updated)
        // Jobs in flight that did not time out: the count alone.
        val running = integration(1, 1, inFlight("C5", started = 80, kind = "LAND_TASK", phase = "FETCH", heartbeat = 20),
            listOf(job("j1"), job("j2", state = "QUEUED", phase = null, heartbeat = null, runner = null)))
        assertEquals(LandingLine("Landing", "2 jobs", true, "fetching", "1m 20s", "Elapsed", "Updated just now"), ProjectPage.landingLine(running, now, now, false))
    }

    /** "Update unavailable" is this app unable to read the server, and it outranks what the last read said — a timed-out lead included. */
    @Test fun theLandingLineCannotReadTheServerEvenWhenTheLeadTimedOut() {
        for ((updatedAt, failed) in listOf(now to true, now.minusSeconds(91) to false)) {
            val line = ProjectPage.landingLine(stuckLanding(), now, updatedAt, failed)!!
            assertEquals("Update unavailable", line.state); assertFalse(line.running); assertFalse(line.timedOut)
            assertEquals("2 jobs · 1 timed out", line.what); assertEquals("Elapsed", line.clockLabel)
            // Frozen at the runner's last report, ten seconds after its claim.
            assertEquals("0m 10s", line.clock); assertEquals("Updated 110m ago", line.updated)
        }
    }

    /** A server that lists its jobs decides what timed out: an old heartbeat alone is no longer "Update unavailable". */
    @Test fun aServerThatListsItsJobsIsNotSecondGuessedFromTheHeartbeat() {
        val flight = inFlight("T", started = 720, kind = "LAND_TASK", phase = "CHECK", heartbeat = 660)
        val listed = integration(1, 0, flight, listOf(job("j", phase = "CHECK", started = 720, heartbeat = 660, limit = 4_200)))
        assertEquals(LandingLine("Landing", "T", true, "checking", "12m 0s", "Elapsed", "Updated 11m ago"), ProjectPage.landingLine(listed, now, now, false))
        // An empty list is still a server that lists them; no list at all is an older server, whose row keeps the guess it always made.
        assertEquals("checking", ProjectPage.landingLine(integration(1, 0, flight, emptyList()), now, now, false)?.state)
        val older = ProjectPage.landingLine(integration(1, 0, flight, null), now, now, false)!!
        assertEquals("Update unavailable", older.state); assertFalse(older.timedOut)
        assertNull("an older server's absence is not none in flight", ProjectPage.inFlightJobs(integration(1, 0, flight, null)))
    }

    /** One line per job, in the server's order, each drawn as the row: its task in the name slot, a running job's phase and clock, a queued job's wait. */
    @Test fun theJobLinesDrawEachJobAsTheRow() {
        val view = integration(1, 2, inFlight(started = 80), listOf(job("j1"), job("j2", phase = "REBASE", started = 130, heartbeat = null),
            // Re-queued after an earlier claim: the raw row still carries that claim's step and report, and neither is this wait's.
            job("j3", state = "QUEUED", phase = "PUSH", started = 2_468, heartbeat = 3_000, runner = null, limit = null)))
        val lines = ProjectPage.landingJobLines(view, now, now.minusSeconds(75), false)
        assertEquals(listOf("j1", "j2", "j3"), lines.map { it.jobId })
        assertEquals(LandingJobLine("j1", "t-c5", LandingLine("Landing", "C5 · 托管 runner", true, "fetching", "1m 20s", "Elapsed", "Updated just now"), null, false), lines[0])
        // No report yet: how fresh the line is comes from the read, as the row's does.
        assertEquals(LandingLine("Landing", "C5 · 托管 runner", true, "rebasing", "2m 10s", "Elapsed", "Updated 1m ago"), lines[1].line)
        assertEquals(LandingLine("Landing", "C5 · 托管 runner", false, "queued", "41m 8s", "Queued for", "Updated 1m ago"), lines[2].line)
        assertNull(lines[2].detail)
        assertEquals("an older server lists nothing", emptyList<LandingJobLine>(), ProjectPage.landingJobLines(integration(1, 0, inFlight(started = 80), null), now, null, false))
    }

    /** A timed-out job says who took it and when, where it stopped, and whether a push may already have happened — and offers Retry
     * when the server says it can be retried. */
    @Test fun aTimedOutJobSaysWhereItsRunnerStoppedAndOffersRetry() {
        val zone = ZoneOffset.ofHours(8)
        val at = ProjectPage.landingClockTime(Instant.parse(iso(6_630)), zone)
        val lines = ProjectPage.landingJobLines(stuckLanding(), now, now, false, zone)
        assertEquals(listOf("j-c5", "j-merge"), lines.map { it.jobId })
        assertEquals(LandingJobLine("j-c5", "t-c5", LandingLine("Landing", "C5 · 托管 runner", false, "Timed out", "110m", "No report for", "limit 10m", timedOut = true),
            "Runner workstation-gpu took it at $at · stopped at fetching · no push recorded", true), lines[0])
        // A promotion lands no single task: no title, nothing to open.
        assertEquals(LandingJobLine("j-merge", null, LandingLine("Merge to main", null, false, "queued", "41m 8s", "Queued for", "Updated just now"), null, false), lines[1])
        fun detail(phase: String?, runner: String? = "workstation-gpu") = ProjectPage.landingJobLines(integration(0, 0, inFlight(started = 6_630),
            listOf(job("j", phase = phase, started = 6_630, heartbeat = 6_620, runner = runner, timedOut = true))), now, now, false, zone).first().detail
        assertEquals("Runner workstation-gpu took it at $at · stopped at pushing · may have been pushed", detail("PUSH"))
        assertEquals("Runner workstation-gpu took it at $at · stopped at verifying · may have been pushed", detail("VERIFY"))
        assertEquals("Runner workstation-gpu took it at $at · stopped at merging · no push recorded", detail("MERGE"))
        assertEquals("The runner took it at $at · stopped at running · no push recorded", detail(null, runner = null))
        assertEquals("The runner took it at $at · stopped at fetching · no push recorded", detail("FETCH", runner = ""))
        // Retry is the server's to offer: a timed-out job it will not take has none.
        val refused = integration(0, 0, inFlight(started = 6_630), listOf(job("j", started = 6_630, heartbeat = 6_620, timedOut = true, retryable = false)))
        assertFalse(ProjectPage.landingJobLines(refused, now, now, false).first().retryable)
    }

    /** The run a retry started says which generation it is, who asked, and when. */
    @Test fun aRetriedJobSaysItsGenerationAndWhoAsked() {
        val zone = ZoneOffset.UTC
        val at = ProjectPage.landingClockTime(Instant.parse(iso(12)), zone)
        val view = integration(0, 0, inFlight(started = 12), listOf(job("j2", generation = 2, started = 12, queued = 12, heartbeat = 2, retriedBy = "OWNER"),
            job("j3", state = "QUEUED", phase = null, generation = 3, started = 12, queued = 12, heartbeat = null, runner = null, retriedBy = "COORDINATOR", limit = null)))
        val lines = ProjectPage.landingJobLines(view, now, now, false, zone)
        assertEquals(listOf("Generation 2 · retried by you at $at", "Generation 3 · retried by the coordinator at $at"), lines.map { it.detail })
        assertEquals("fetching", lines[0].line.state); assertEquals("0m 12s", lines[0].line.clock)
    }

    /** While this app cannot read the server, every job says so — the timed-out one too — and its clock stops where the row's does. */
    @Test fun theJobLinesCannotReadTheServerEither() {
        val lines = ProjectPage.landingJobLines(stuckLanding(), now, now, true)
        assertEquals(listOf("Update unavailable", "Update unavailable"), lines.map { it.line.state })
        assertEquals(listOf(false, false), lines.map { it.line.timedOut }); assertEquals(listOf(false, false), lines.map { it.line.running })
        assertEquals("0m 10s", lines[0].line.clock); assertEquals("Updated 110m ago", lines[0].line.updated)
        assertTrue(lines[0].detail!!.endsWith("stopped at fetching · no push recorded")); assertTrue(lines[0].retryable)
        assertEquals("Update unavailable", ProjectPage.landingJobLines(stuckLanding(), now, now.minusSeconds(91), false).first().line.state)
    }

    /** An element that leaves its optional facts out reads as their empty forms; one that is not an object is an older server's list. */
    @Test fun aSparseJobReadsAsItsEmptyFormsAndAnUnreadableListAsNone() {
        val sparse = integration(0, 1, inFlight(state = "QUEUED", started = 30), listOf(j("""{"jobId":"j","kind":"LAND_TASK","state":"QUEUED","startedAt":"s","queuedAt":"q"}""")))
        val line = ProjectPage.landingJobLines(sparse, now, now, false).single()
        assertEquals(LandingJobLine("j", null, LandingLine("Landing", null, false, "queued", "0m 0s", "Queued for", "Updated just now"), null, false), line)
        assertNull(ProjectPage.inFlightJobs(j("""{"inFlightJobs":[1,2]}""")))
        assertNull(ProjectPage.inFlightJobs(j("""{"inFlightJobs":"later"}""")))
    }

    // MARK: criteria

    @Test fun criterionWorkSaysWhereMetWorkIsAndNamesWhatHoldsUnmetWork() {
        assertEquals("Met by its work", ProjectPage.criterionWork(j("""{"satisfied":true,"landing":"LANDED"}"""), "project/x")?.state)
        assertEquals("on main", ProjectPage.criterionWork(j("""{"satisfied":true,"landing":"LANDED"}"""), "project/x")?.landing)
        val branch = ProjectPage.criterionWork(j("""{"satisfied":true,"landing":"ON_INTEGRATION_LINE"}"""), "project/x")!!
        assertEquals("on project/x", branch.landing); assertEquals("not on main yet", branch.landingWarning)
        val flagged = ProjectPage.criterionWork(j("""{"satisfied":true,"landing":"UNKNOWN"}"""), null)!!
        assertEquals("no merge receipt either way", flagged.landing); assertTrue(flagged.landingFlagged)
        assertNull(ProjectPage.criterionWork(j("""{"id":"c4","ordinal":4,"text":"D"}"""), null))
        val unmet = ProjectPage.criterionWork(j("""{"satisfied":false,"landing":"UNKNOWN","unmet":[{"clause":"SERVING_WORK_UNSETTLED","heldUpBy":[
            {"taskId":"t1","title":"Wire it","requiredAction":"RUN_ACCEPTANCE_COMMAND"},{"taskId":"t2","title":"Odd","requiredAction":"SOMETHING_NEW"}]},{"clause":"NEW_CLAUSE"}]}"""), null)!!
        assertEquals("Not met by its work", unmet.state); assertNull(unmet.landing)
        assertEquals(listOf("Work filed under it has not settled by the criterion that work declared.", "NEW_CLAUSE"), unmet.reasons.map { it.sentence })
        assertEquals(listOf("needs its acceptance command to run", "SOMETHING_NEW"), unmet.reasons.first().heldUpBy.map { it.action })
        assertEquals("12 criteria stated. Whether one is met is read off the work filed under it; nothing in Orbit judges the criteria themselves.", ProjectPage.criteriaStanding(12))
        assertTrue(ProjectPage.criteriaStanding(1).startsWith("1 criterion stated."))
        assertEquals("View all 12 criteria" to "8 more not shown", ProjectPage.criteriaDisclosure(12, 4, false))
        assertEquals("Show first 4 criteria" to "Showing all 12 criteria", ProjectPage.criteriaDisclosure(12, 4, true))
        assertNull(ProjectPage.criteriaDisclosure(4, 4, false))
    }

    // MARK: coordinator

    private fun status(state: String, session: String? = null) = j("""{"projectId":"p","readAt":"${iso(0)}","state":"$state","coordination":{${session?.let { "\"sessionId\":\"s\",\"session\":$it" }.orEmpty()}}}""")

    @Test fun coordinatorPillFollowsTheWebsTruthTable() {
        fun live(run: String, active: Boolean, pending: Int) = ProjectPage.coordinatorPill(status("LIVE",
            """{"id":"s","runState":"$run","lifecycleState":"OPEN","engineTurnActive":$active,"pendingApprovals":$pending}""")).label
        assertEquals("Needs you", live("RUNNING", false, 1))
        assertEquals("Working", live("RUNNING", false, 0))
        assertEquals("Working", live("AWAITING_INPUT", true, 0))
        assertEquals("Needs you", live("AWAITING_INPUT", false, 0))
        assertEquals("Idle", live("FAILED", false, 0))
        assertEquals("Completed", ProjectPage.coordinatorPill(status("LIVE", """{"id":"s","runState":"AWAITING_INPUT","lifecycleState":"COMPLETED"}""")).label)
        assertEquals("Not started", ProjectPage.coordinatorPill(status("NEVER_OPENED")).label)
        assertEquals("Deleted", ProjectPage.coordinatorPill(status("TRASHED")).label)
        assertEquals(Pill("Cannot be opened", TagTone.DANGER), ProjectPage.coordinatorPill(status("UNAVAILABLE")))
    }

    @Test fun coordinatorRowsReadTheWayTheWebCardDoes() {
        assertEquals(listOf("1st", "2nd", "11th", "22nd").map { "$it coordinator of this project" }, listOf("0", "1", "10", "21").map(ProjectPage::coordinatorOrdinal))
        assertEquals("delivered · last 4m ago", ProjectPage.wakeupsLine(j("""{"state":"DELIVERED","at":"${iso(240)}"}"""), now))
        assertEquals("none yet", ProjectPage.wakeupsLine(j("""{"state":"NONE"}"""), now))
        assertEquals("6 of 30", ProjectPage.selfStartedLine(j("""{"selfStartedToday":6,"limit":30}""")))
        assertEquals("6 · no limit", ProjectPage.selfStartedLine(j("""{"selfStartedToday":6}""")))
        assertEquals("30 of 30 · paused", ProjectPage.selfStartedLine(j("""{"selfStartedToday":30,"limit":30,"paused":true}""")))
        assertEquals(1f, ProjectPage.selfStartedFraction(j("""{"selfStartedToday":31,"limit":30}""")))
        assertNull(ProjectPage.selfStartedFraction(j("""{"selfStartedToday":3}""")))
        assertEquals("last active 12m ago", ProjectPage.lastActive(j("""{"id":"s","startedAt":"${iso(3600)}","finishedAt":"${iso(720)}"}"""), iso(0)))
        assertEquals("last active 12m ago", ProjectPage.lastActive(j("""{"id":"s","startedAt":"${iso(2_592_000)}","lastTurnAt":"${iso(720)}"}"""), iso(0)))
        assertEquals("Manual dispatch" to "7 open tasks are coordinated from this conversation.", ProjectPage.dispatchNote(7, false))
        assertEquals("1 open task is coordinated from this conversation.", ProjectPage.dispatchNote(1, false).second)
        assertEquals("Open tasks are coordinated from this conversation.", ProjectPage.dispatchNote(null, false).second)
        assertEquals("No open tasks remain.", ProjectPage.dispatchNote(0, false).second)
        assertEquals("Open work" to "A completed conversation is told nothing new — and 2 open tasks still point at it.", ProjectPage.dispatchNote(2, true))
        assertEquals("Reply to coordinator", ProjectPage.coordinatorPress(false, true))
        assertEquals("Open coordinator", ProjectPage.coordinatorPress(false, false))
        assertEquals("Open coordinator", ProjectPage.coordinatorPress(true, true))
    }

    // MARK: open items

    private fun item(kind: String, assignee: String, waited: Long, escalateIn: Long? = null, actions: List<String> = emptyList(), sessionId: String? = null,
        fuse: String? = null) = buildJsonObject {
        put("itemId", "i"); put("kind", kind); put("title", "T"); put("waitingSince", iso(waited)); put("assignee", assignee)
        escalateIn?.let { put("escalateAt", iso(-it)) }; sessionId?.let { put("sessionId", it) }; fuse?.let { put("fuseEpisodeId", it) }
        put("actions", JsonArray(actions.map(::JsonPrimitive)))
    }

    @Test fun anItemCountsDownToTheOwnerAndOffersTheFirstPressThisClientCanMake() {
        assertEquals("18m · goes to you in 1h 42m", ProjectPage.waitingLabel(item("INTEGRATION_CONFLICT", "COORDINATOR", 18 * 60, 102 * 60), now))
        assertEquals("3h · due to come to you", ProjectPage.waitingLabel(item("INTEGRATION_CONFLICT", "COORDINATOR", 3 * 3600, -60), now))
        assertEquals("waiting 35m", ProjectPage.waitingLabel(item("COORDINATOR_QUESTION", "OWNER", 35 * 60), now))
        assertEquals("OPEN_TASK_SESSION", ProjectPage.primaryAction(item("TASK_FAILED", "OWNER", 60, actions = listOf("RETRY", "OPEN_TASK_SESSION", "CANCEL_TASK"), sessionId = "s1")))
        assertNull(ProjectPage.primaryAction(item("TASK_FAILED", "OWNER", 60, actions = listOf("RETRY", "OPEN_TASK_SESSION"))))
        assertEquals("ANSWER", ProjectPage.primaryAction(item("COORDINATOR_QUESTION", "OWNER", 60, actions = listOf("ANSWER"))))
        assertNull(ProjectPage.primaryAction(item("FUSE_PAUSED", "OWNER", 60, actions = listOf("RESUME"))))
        assertEquals("RESUME", ProjectPage.primaryAction(item("FUSE_PAUSED", "OWNER", 60, actions = listOf("RESUME"), fuse = "f1")))
        assertEquals("Review", ProjectPage.actionLabel("REVIEW"))
        assertNull(ProjectPage.actionLabel("CANCEL_TASK"))
    }

    // The toolbar's Open items and the page's reminder (iOS 39a1aadde; ProjectPageTests, ProjectRunSettingsTests on main).
    private fun page(status: String = "OPEN", started: Boolean? = true) = buildJsonObject {
        put("status", status); if (started != null) put("startedAt", if (started) JsonPrimitive(iso(86_400)) else JsonNull)
    }
    private fun items(needsYou: List<JsonObject> = emptyList(), withCoordinator: List<JsonObject> = emptyList(), startRequest: JsonObject? = null,
        doneRequest: JsonObject? = null) = buildJsonObject {
        put("needsYou", JsonArray(needsYou)); put("withCoordinator", JsonArray(withCoordinator))
        startRequest?.let { put("startRequest", it) }; doneRequest?.let { put("doneRequest", it) }
    }

    @Test fun openItemsSummaryKeepsCoordinatorItemsQuietUntilTheServerReassignsThem() {
        val coordinator = item("INTEGRATION_CHECK_FAILED", "COORDINATOR", 3_600, escalateIn = -60)
        val quiet = ProjectPage.openItemsSummary(page(), items(withCoordinator = listOf(coordinator)))!!
        assertEquals(1, quiet.count); assertEquals(0, quiet.needsYou)
        assertNull("a local countdown reaching zero does not reassign an item", quiet.attention)
        assertEquals("No action needed from you · 1 with the coordinator", quiet.subtitle)
        val owner = item("INTEGRATION_CHECK_FAILED", "OWNER", 3_600)
        val escalated = ProjectPage.openItemsSummary(page(), items(needsYou = listOf(owner)))!!
        assertEquals(1, escalated.count); assertEquals("1 item needs you", escalated.attention); assertEquals("1 item needs you", escalated.subtitle)
        val pause = item("FUSE_PAUSED", "OWNER", 60, actions = listOf("RESUME"), fuse = "f1")
        val mixed = ProjectPage.openItemsSummary(page(), items(needsYou = listOf(owner, pause), withCoordinator = listOf(coordinator)))!!
        assertEquals(3, mixed.count); assertEquals("2 items need you", mixed.attention); assertEquals("2 items need you · 1 with the coordinator", mixed.subtitle)
    }

    @Test fun openItemsSummaryDoesNotTurnAnUnreadInboxIntoAnEmptyOne() {
        assertNull(ProjectPage.openItemsSummary(page(), null))
        val empty = ProjectPage.openItemsSummary(page(), items())!!
        assertEquals(0, empty.count); assertNull(empty.attention); assertEquals(ProjectPage.noOpenItems, empty.subtitle)
    }

    @Test fun openItemsSummaryCountsOnlyAStartRequestThePageCanStillAnswer() {
        val asked = items(startRequest = buildJsonObject { put("itemId", "s1"); put("kind", "START_REQUEST") })
        val live = ProjectPage.openItemsSummary(page(started = false), asked)!!
        assertEquals(1, live.count); assertEquals("1 item needs you", live.attention)
        val own = ProjectPage.openItemsSummary(page(started = false), items())!!
        assertEquals("the owner's own Start… is not a pending request", 0, own.count); assertNull(own.attention)
        assertEquals(StartProjectCopy.PageRow.Own, StartProjectCopy.pageRow("OPEN", false, items()))
        for (started in listOf(true, null)) assertEquals(0, ProjectPage.openItemsSummary(page(started = started), asked)!!.count)
        for (status in listOf("DONE", "CANCELLED")) assertEquals(0, ProjectPage.openItemsSummary(page(status, started = false), asked)!!.count)
        assertNull("a request still on its way is not a project nobody asked about", StartProjectCopy.pageRow("OPEN", false, null))
    }

    @Test fun openItemsSummaryCountsTheRequestToRecordTheProjectDoneOnce() {
        val request = buildJsonObject { put("itemId", "d"); put("kind", "DONE_REQUEST"); put("title", ProjectDone.heading); put("waitingSince", iso(240))
            put("doneRequest", buildJsonObject { put("criteriaDigest", "c"); put("judgment", "j") }) }
        val asked = ProjectPage.openItemsSummary(page(), items(doneRequest = request))!!
        assertEquals(1, asked.needsYou); assertEquals("1 item needs you", asked.attention)
        val twice = ProjectPage.openItemsSummary(page(), items(needsYou = listOf(request), doneRequest = request))!!
        assertEquals("the request has its own row and is counted once", 1, twice.needsYou)
        assertEquals(emptyList<JsonObject>(), ProjectPage.needsYouRows(items(needsYou = listOf(request))))
        assertEquals("the owner's own Record as done… is waiting on nobody", 0, ProjectPage.openItemsSummary(page(), items())!!.needsYou)
        assertEquals("a project already done is asked nothing", 0, ProjectPage.openItemsSummary(page("DONE"), items(doneRequest = request))!!.needsYou)
    }

    @Test fun integrationFactsOnABranchAndOnMain() {
        val branch = j("""{"line":"PROJECT_BRANCH","ref":"project/bg-jobs","upstreamRef":"main","commitsAheadOfUpstream":7,"lastUpstreamSyncAt":"${iso(720)}",
            "integratingCount":1,"queuedCount":1,"mergeCheckOnTip":"PASSING"}""")
        assertEquals(listOf("project/bg-jobs", "7 commits ahead of main at last measurement", "synced with main 12m ago", "Running jobs 1 · Queued 1",
            "Last landing check ✓ passing"), ProjectPage.integrationFacts(branch, now))
        assertEquals(listOf("main", "Running jobs 0 · Queued 0", "Last landing check not checked"),
            ProjectPage.integrationFacts(j("""{"line":"MAIN","upstreamRef":"main","commitsAheadOfUpstream":3,"mergeCheckOnTip":"UNKNOWN"}"""), now))
        assertNull(ProjectPage.integrationFacts(j("{}"), now))
    }

    // MARK: tasks

    @Test fun taskBandsFollowTheWebsOrderAndRowsDropTheTagTheirBandSays() {
        listOf("READY" to "ready", "FAILED" to "failed", "CANCELLED" to "settled", "AWAITING_VERIFICATION" to "awaiting-verification").forEach { (state, key) ->
            listOf("QUEUED", "CHECK_FAILED", "ON_UPSTREAM").forEach { integration ->
                assertEquals(listOf(key), ProjectPage.taskGroups(listOf(j("""{"id":"r","title":"Work","workState":"$state","integration":{"state":"$integration"}}"""))).map { it.key })
            }
        }
        val rows = listOf(
            """{"id":"done","title":"d","status":"DONE","workState":"DONE"}""",
            """{"id":"lvl2","title":"b2","topoLevel":2,"dependencyState":"BLOCKED","workState":"BLOCKED"}""",
            """{"id":"ready","title":"r","workState":"READY"}""",
            """{"id":"run","title":"x","status":"IN_PROGRESS","workState":"RUNNING"}""",
            """{"id":"landing","title":"l","dependencyState":"BLOCKED","workState":"BLOCKED","landingWaitCount":1}""",
            """{"id":"integ","title":"i","status":"DONE","workState":"DONE","integration":{"state":"CHECK_FAILED","handler":"COORDINATOR"}}""",
            """{"id":"landed","title":"o","status":"DONE","workState":"DONE","integration":{"state":"ON_UPSTREAM"}}""",
            """{"id":"lvl1","title":"b1","topoLevel":1,"dependencyState":"BLOCKED","workState":"BLOCKED"}""",
        ).map(::j)
        val groups = ProjectPage.taskGroups(rows)
        assertEquals(listOf("running", "integrating", "ready", "waiting-for-landing", "level-1", "level-2", "landed", "settled"), groups.map { it.key })
        assertEquals(listOf("Running", "Pending landing", "Ready · can start now", "Waiting · for a prerequisite to land", "Blocked · topology level 1",
            "Blocked · topology level 2", "Landed", "Done / Cancelled"), groups.map { it.heading })
        assertTrue(groups.last().settled)
        assertEquals("BLOCKED", ProjectPage.workState(j("""{"status":"OPEN"}""")))
        assertEquals("AWAITING_VERIFICATION", ProjectPage.workState(j("""{"status":"OPEN","completionPolicy":"VERIFICATION_PASSED"}""")))
        assertEquals("Ready · automatic dispatch", ProjectPage.workTag(j("""{"workState":"READY","autoRunWhenReady":true}"""))?.text)
        assertNull(ProjectPage.workTag(j("""{"dependencyState":"BLOCKED","workState":"BLOCKED","landingWaitCount":2}""")))
        fun tag(state: String, handler: String?) = ProjectPage.integrationTag(j("""{"integration":{"state":"$state"${handler?.let { ",\"handler\":\"$it\"" }.orEmpty()}}}"""), "project/x", "main")?.text
        assertEquals("Conflict · you", tag("CONFLICT", "OWNER"))
        assertEquals("Checks failed · coordinator", tag("CHECK_FAILED", "COORDINATOR"))
        assertEquals("On project/x", tag("ON_INTEGRATION_LINE", null))
        assertEquals("On main", tag("ON_UPSTREAM", null))
        assertNull(tag("SOMETHING_NEW", null))
        assertEquals("Integrating · checking", ProjectPage.integrationTag(j("""{"integration":{"state":"RUNNING","checksRunningForMs":180000}}"""), null, null)?.text)
        assertEquals("Waits for 1 task to land", ProjectPage.integrationTag(j("""{"dependencyState":"BLOCKED","landingWaitCount":1}"""), null, null)?.text)
        assertEquals(emptyList<Tag>(), ProjectPage.rowTags(j("""{"status":"OPEN","workState":"READY"}"""), "Ready · can start now", null, null))
        assertEquals(listOf("Ready · automatic dispatch"), ProjectPage.rowTags(j("""{"status":"OPEN","workState":"READY","autoRunWhenReady":true}"""), "Ready · can start now", null, null).map { it.text })
        assertEquals(emptyList<Tag>(), ProjectPage.rowTags(j("""{"status":"FAILED","workState":"FAILED"}"""), "Failed · coordinated continuation", null, null))
        assertEquals(listOf("On main"), ProjectPage.rowTags(j("""{"status":"DONE","workState":"DONE","integration":{"state":"ON_UPSTREAM"}}"""), "Landed", null, "main").map { it.text })
    }

    // MARK: blockers

    private val whoNotInTeam = j("""{"id":"b1","kind":"WHO_NOT_IN_TEAM","owner":"USER","severity":"CRITICAL","requiredAction":"Add the assigned agent to this project team, or reassign the task.",
        "subjectTitle":"合并 TasksView 的两个独立轮询循环","firstSeenAt":"2026-08-21T17:20:23.000Z"}""")

    @Test fun aBlockerIsNamedSaysWhatItIsAboutAndHowItEnded() {
        assertEquals(BlockerHeadline("Needs you", TagTone.WARNING, "Who not in team"), ProjectPage.blockerHeadline(whoNotInTeam))
        val coordinator = j("""{"id":"b2","kind":"AWAITING_USER_INPUT","owner":"COORDINATOR"}""")
        assertEquals("Coordinator", ProjectPage.blockerHeadline(coordinator).tag); assertEquals("Awaiting user input", ProjectPage.blockerHeadline(coordinator).title)
        val scope = j("""{"id":"b3","kind":"DELIVERY_REVIEW","detail":{"reason":"OUTSIDE_DECLARED_SCOPE"}}""")
        assertEquals("Changed files it didn’t declare", ProjectPage.blockerHeadline(scope).title); assertEquals("Needs your approval", ProjectPage.blockerHeadline(scope).tag)
        assertEquals("合并 TasksView 的两个独立轮询循环", ProjectPage.blockerSubjectLine(whoNotInTeam))
        assertEquals("Task · criterion 3 is now revision 2", ProjectPage.blockerSubjectLine(j("""{"id":"b","kind":"K","subjectTitle":"Task","criterionOrdinal":3,"criterionRevision":2,
            "detail":{"reason":"ACCEPTANCE_STANDARD_MOVED"}}""")))
        assertNull(ProjectPage.blockerSubjectLine(j("""{"id":"b","kind":"K"}""")))
        assertEquals("src/a/one.ts · two.ts · +1", ProjectPage.blockerPathsLine(listOf("src/a/one.ts", "src/a/two.ts", "src/b/three.ts")))
        assertEquals("src/a/one.ts · lib/x.ts", ProjectPage.blockerPathsLine(listOf("src/a/one.ts", "lib/x.ts")))
        assertNull(ProjectPage.blockerPathsLine(emptyList()))
        val at = Instant.parse("2026-09-24T14:41:12.000Z")
        assertEquals("since 33d", ProjectPage.blockerSince(whoNotInTeam.text("firstSeenAt"), at))
        assertEquals("since 31m", ProjectPage.blockerSince("2026-09-24T14:10:00.000Z", at))
        assertEquals("since just now", ProjectPage.blockerSince(null, at))
        val auto = j("""{"id":"r","kind":"WHO_NOT_IN_TEAM","subjectTitle":"Baseline","resolvedAt":"2026-08-21T16:12:28.738Z","resolvedBy":"AUTO"}""")
        assertEquals("Auto-resolved — its condition no longer holds (08-21 16:12)", ProjectPage.blockerResolution(auto, ZoneOffset.UTC))
        assertEquals("Resolved by you — agent added", ProjectPage.blockerResolution(j("""{"id":"r","kind":"K","resolvedBy":"USER","resolutionNote":"  agent added  "}"""), ZoneOffset.UTC))
        assertEquals("Who not in team · 合并 TasksView 的两个独立轮询循环", ProjectPage.blockerName(whoNotInTeam))
        assertEquals("Who not in team", ProjectPage.blockerName(j("""{"id":"b","kind":"WHO_NOT_IN_TEAM","subjectTitle":""}""")))
        assertEquals("Who not in team · Baseline — Auto-resolved — its condition no longer holds (08-21 16:12)", ProjectPage.blockerResolvedLine(auto, ZoneOffset.UTC))
        assertEquals("4 resolved · latest: Auto-resolved — its condition no longer holds (08-21 16:12)",
            ProjectPage.blockersResolvedSummary(buildJsonObject { put("resolved", JsonArray(listOf(auto))); put("resolvedCount", 4) }, ZoneOffset.UTC))
        assertNull(ProjectPage.blockersResolvedSummary(j("{}")))
        assertEquals("Who not in team · 合并 TasksView 的两个独立轮询循环\n\nAccepting records your name and note.", ProjectPage.resolveBlockerMessage(whoNotInTeam))
    }

    @Test fun aDeliveryBlockerAsksForADecisionAndShowsWhatItRestsOn() {
        val argued = j("""{"id":"b4","kind":"HUMAN_DECISION_REQUIRED","subjectTitle":"补数","agentArgument":"  这次交付只定位根因，没有执行补数。 ","criterionOrdinal":3,
            "criterionText":"给出可验证的补数方案，并完成一次成功重跑。","detail":{"reason":"CRITERION_EXEMPTION_ARGUED"}}""")
        assertEquals("Agent says this criterion doesn’t apply", ProjectPage.blockerHeadline(argued).title)
        assertEquals("Does the agent’s explanation make this criterion inapplicable to this work?", ProjectPage.blockerDecision(argued)?.question)
        assertEquals(listOf("Review…", "Review this blocker", "What did you verify?", "Accept the explanation", "Leave it open"), listOf(ProjectPage.resolveBlockerPress(argued),
            ProjectPage.resolveBlockerTitle(argued), ProjectPage.resolveBlockerQuestion(argued), ProjectPage.resolveBlockerConfirm(argued), ProjectPage.resolveBlockerKeep(argued)))
        assertEquals("Agent says this criterion doesn’t apply · 补数\n\nYour decision\nDoes the agent’s explanation make this criterion inapplicable to this work?\n\n" +
            "Agent’s explanation\n这次交付只定位根因，没有执行补数。\n\nCurrent criterion\n给出可验证的补数方案，并完成一次成功重跑。\n\nAccepting records your name and note.",
            ProjectPage.resolveBlockerMessage(argued))
        val scope = j("""{"id":"b5","kind":"DELIVERY_REVIEW","agentArgument":"ignored","detail":{"reason":"OUTSIDE_DECLARED_SCOPE","paths":["src/a.ts","src/b.ts"]}}""")
        assertEquals("Accept these files", ProjectPage.resolveBlockerConfirm(scope))
        assertEquals("Changed files it didn’t declare\n\nYour decision\nAre these extra files part of the delivery you want to accept?\n\nFiles this blocker names\nsrc/a.ts\nsrc/b.ts\n\n" +
            "Accepting records your name and note.", ProjectPage.resolveBlockerMessage(scope))
        assertNull(ProjectPage.blockerDecision(whoNotInTeam))
        assertEquals(listOf("Resolve…", "Resolve this blocker", "Why is it no longer blocking?", "Resolve", "Cancel"), listOf(ProjectPage.resolveBlockerPress(whoNotInTeam),
            ProjectPage.resolveBlockerTitle(whoNotInTeam), ProjectPage.resolveBlockerQuestion(whoNotInTeam), ProjectPage.resolveBlockerConfirm(whoNotInTeam),
            ProjectPage.resolveBlockerKeep(whoNotInTeam)))
    }

    // MARK: run queue

    @Test fun theRunQueueSaysWhatIsInItHowItIsSortedAndWhatStartingReleases() {
        assertEquals("7 ready · sorted by work unblocked", ProjectPage.queueSummary(j("""{"readyCount":7}""")))
        assertEquals("Ready tasks can start now.", ProjectPage.queueHelp(j("""{"readyCount":7}""")))
        assertEquals("3 running · 1 queued · 2 ready · 1 ready in paused lists · ready tasks sorted by work unblocked",
            ProjectPage.queueSummary(j("""{"readyCount":2,"queuedCount":1,"runningCount":3,"pausedCount":1}""")))
        assertEquals("4 ready · stable order", ProjectPage.queueSummary(j("""{"readyCount":4,"impactTruncated":{"maxTasks":2000}}""")))
        val row = j("""{"taskId":"t","title":"T","runState":"READY","downstreamBlocked":3}""")
        assertEquals("Prerequisites complete", ProjectPage.queueRowState(row))
        assertEquals("Unblocks 3 tasks", ProjectPage.queueImpact(row))
        assertEquals("Unblocks 1 task", ProjectPage.queueImpact(j("""{"taskId":"t","title":"T","runState":"READY","downstreamBlocked":1}""")))
        assertEquals("Ready now", ProjectPage.queueImpact(j("""{"taskId":"t","title":"T","runState":"READY","downstreamBlocked":null}""")))
        val paused = j("""{"taskId":"t","title":"T","runState":"PAUSED","pausedList":{"id":"l","title":"Backlog","readyCount":3,"autoRunReadyCount":1},"downstreamBlocked":null}""")
        assertEquals("List paused · Backlog", ProjectPage.queueRowState(paused))
        assertEquals("Ready after resume", ProjectPage.queueImpact(paused))
        assertEquals("Resume “Backlog”?", ProjectPage.resumeListQuestion(paused.obj("pausedList")!!))
        assertEquals("This removes the pause from the entire list. 3 otherwise-ready tasks will become eligible. 1 is configured to auto-run and may start immediately. " +
            "Other automatic or scheduled work in the list can also dispatch once resumed.", ProjectPage.resumeListDetail(paused))
        assertEquals("Waiting for runner", ProjectPage.queueRowState(j("""{"taskId":"t","title":"T","runState":"QUEUED"}""")))
    }

    // MARK: the start (the card's own derivations are StartProjectTest's)

    private val project = "34WvwUS8YMXfOfWbMqVuu"
    private fun mark(id: String, title: String, status: String = "OPEN") = GraphMark(MarkKind.TASK, id, title, status = status)

    @Test fun theStartsWordsAreTheCardsOwn() {
        assertEquals("c2b4e16c4b59", StartProjectCopy.shortSeal("c2b4e16c4b59" + "0".repeat(52)))
        assertEquals("(unreadable)", StartProjectCopy.shortSeal(""))
        assertEquals(listOf("Done when · 4 criteria", "Done when · 1 criterion", "Plan · 5 tasks", "Plan · 1 task", "Plan · 5 tasks in 4 levels"),
            listOf(StartProjectCopy.doneWhenHead(4), StartProjectCopy.doneWhenHead(1), StartProjectCopy.planHead(5), StartProjectCopy.planHead(1),
                StartProjectCopy.planHead(5, levels = 4)))
        assertEquals("project/34Wvw…", RunSettings.shortBranch("refs/heads/project/$project"))
        assertEquals("release/next", RunSettings.shortBranch("refs/heads/release/next"))
        assertEquals("project/short", RunSettings.shortBranch("project/short"))
        assertEquals("project/$project", StartProjectCopy.branch(null, project))
        assertEquals("project/34Wzv", StartProjectCopy.branch("refs/heads/project/34Wzv", project))
        assertEquals(RunSettings.automaticHintProjectBranch, RunSettings.automaticHint("PROJECT_BRANCH"))
        assertEquals(RunSettings.automaticHintMain, RunSettings.automaticHint("MAIN"))
        assertTrue(RunSettings.mergeCheckMissing("PROJECT_BRANCH", true, "   "))
        assertFalse(RunSettings.mergeCheckMissing("PROJECT_BRANCH", true, "npm test"))
        assertFalse(RunSettings.mergeCheckMissing("MAIN", true, null))
        assertFalse(RunSettings.mergeCheckMissing("PROJECT_BRANCH", false, null))
        assertEquals("task at a time", RunSettings.tasksAtATime(1)); assertEquals("tasks at a time", RunSettings.tasksAtATime(3))
        assertEquals("The coordinator asked · a project branch · Automatic on · at most 3 at a time",
            StartProjectCopy.requestSummary(j("""{"line":"PROJECT_BRANCH","automatic":true,"maxConcurrentTasks":3}""")))
    }

    @Test fun theOwnersStartTakesTheDefaultRuleAndAPressSendsEverySetting() {
        val chain = DependencyGraph(listOf(mark("a", "A"), mark("b", "B")), listOf(GraphEdge("a", "b")), 2, false, null)
        val loose = DependencyGraph(listOf(mark("a", "A"), mark("b", "B")), emptyList(), 2, false, null)
        val cancelledEdge = DependencyGraph(listOf(mark("a", "A", "CANCELLED"), mark("b", "B")), listOf(GraphEdge("a", "b")), 2, false, null)
        val folded = DependencyGraph(listOf(GraphMark(MarkKind.RUN, "r", "run", taskCount = 3, statusCounts = mapOf("OPEN" to 3))), emptyList(), 3, false, null)
        val undecided = j("""{"line":null,"mergeCheckCommand":"make check"}""")
        assertEquals(StartProjectCopy.Settings("PROJECT_BRANCH", null, true, 4, "make check"), StartProjectCopy.defaultSettings(undecided, 4, chain))
        assertEquals("MAIN", StartProjectCopy.defaultSettings(undecided, 4, loose).line)
        assertEquals("MAIN", StartProjectCopy.defaultSettings(undecided, 4, cancelledEdge).line)
        assertEquals("PROJECT_BRANCH", StartProjectCopy.defaultSettings(undecided, 4, folded).line)
        assertEquals(StartProjectCopy.Settings("MAIN", null, true, 1, "make check"), StartProjectCopy.defaultSettings(undecided, null, null))
        val decided = j("""{"line":"PROJECT_BRANCH","ref":"project/34Wzv"}""")
        assertEquals(StartProjectCopy.Settings("PROJECT_BRANCH", "refs/heads/project/34Wzv", true, 3, null), StartProjectCopy.defaultSettings(decided, 3, loose))
        assertEquals(StartProjectCopy.Settings("MAIN", null, true, 3, null), StartProjectCopy.defaultSettings(j("""{"line":"MAIN","ref":"main"}"""), 3, chain))
        // Nobody asked: no reason, and no request for the press to answer.
        val request = StartProjectCopy.ownerRequest(StartProjectCopy.defaultSettings(decided, 3, loose), "seal")
        assertEquals("", request.why)
        val branch = StartProjectCopy.body(request, StartProjectCopy.Draft("PROJECT_BRANCH", false, 5, "  npm test  "), requestId = null)
        assertEquals(j("""{"criteriaDigest":"seal","line":"PROJECT_BRANCH","projectBranchName":"refs/heads/project/34Wzv","automatic":false,"maxConcurrentTasks":5,
            "mergeCheckCommand":"npm test","requestId":null}"""), branch)
        val main = StartProjectCopy.body(request, StartProjectCopy.Draft("MAIN", true, 3, "   "), requestId = null)
        assertFalse("directly into main names no branch", main.containsKey("projectBranchName"))
        assertEquals(JsonNull, main["mergeCheckCommand"]); assertEquals(JsonNull, main["requestId"])
    }

    // MARK: How it runs

    @Test fun eachControlWritesOnlyWhatMovedAndOnlyWhileItCan() {
        assertEquals(j("""{"line":"MAIN"}"""), RunSettings.lineWrite(j("""{"line":null}"""), "MAIN"))
        assertNull(RunSettings.lineWrite(j("""{"line":"PROJECT_BRANCH","ref":"project/x"}"""), "PROJECT_BRANCH"))
        assertEquals(j("""{"line":"MAIN"}"""), RunSettings.lineWrite(j("""{"line":"PROJECT_BRANCH","ref":"project/x"}"""), "MAIN"))
        assertNull("a locked line is refused 409; it is not sent", RunSettings.lineWrite(j("""{"line":"PROJECT_BRANCH","ref":"project/x","locked":true}"""), "MAIN"))
        val set = j("""{"line":"PROJECT_BRANCH","mergeCheckCommand":"npx tsc -b"}""")
        assertNull(RunSettings.mergeCheckWrite(set, "  npx tsc -b \n"))
        assertEquals(j("""{"mergeCheckCommand":null}"""), RunSettings.mergeCheckWrite(set, "   "))
        assertEquals(j("""{"mergeCheckCommand":"make test"}"""), RunSettings.mergeCheckWrite(j("""{"line":"MAIN"}"""), " make test "))
        assertNull(RunSettings.mergeCheckWrite(j("""{"line":"MAIN"}"""), ""))
        assertNull(RunSettings.escalationWrite(j("""{"line":"MAIN","escalationSeconds":7200}"""), 7200))
        assertEquals(j("""{"exceptionEscalationSeconds":3600}"""), RunSettings.escalationWrite(j("""{"line":"MAIN","escalationSeconds":7200}"""), 3600))
        assertEquals(setOf("automatic", "expectedConfigRevision"), RunSettings.authorization(j("""{"configRevision":"3"}"""), automatic = false)!!.keys)
        assertEquals(setOf("maxConcurrentTasks", "expectedConfigRevision"), RunSettings.authorization(j("""{"configRevision":"3"}"""), maxConcurrentTasks = 5)!!.keys)
        // A big revision rides as the string it was read as; no revision is no write.
        assertEquals("18446744073709551615", RunSettings.authorization(j("""{"configRevision":"18446744073709551615"}"""), automatic = true)!!.text("expectedConfigRevision"))
        assertNull(RunSettings.authorization(j("{}"), automatic = true))
        assertEquals(listOf("30 minutes", "1 hour", "2 hours", "4 hours", "8 hours", "24 hours", "90 minutes"), RunSettings.escalationOptions(5400).map { it.second })
        assertEquals("3 hours", RunSettings.escalationLabel(10800))
        assertEquals("Tasks land on: decided when you start — the coordinator suggests directly into main", RunSettings.undecidedLine("MAIN"))
        assertEquals("Tasks land on: decided when you start", RunSettings.undecidedLine(null))
    }
}
