package io.orbitd.android.projects

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/** The landing as a card of its own and the head every landing row wears (A11-11; iOS 749d995c5, 3b23aa163 — OrbitKit's
 * ProjectLandingCardTests and ProjectLandingHeadTests over the same server JSON): the row's words and clocks, plus the branch, the
 * several jobs and, for a job the server judged timed out, where its runner stopped and whether a Retry takes it. */
class ProjectLandingCardTest {
    private val now = Instant.parse("2026-10-11T09:07:00Z")
    private fun iso(secondsBeforeNow: Long) = now.minusSeconds(secondsBeforeNow).toString()

    /** One `inFlightJobs` element, its instants counted in seconds before `now`. */
    private fun job(id: String, kind: String = "LAND_TASK", state: String = "RUNNING", phase: String? = "CHECK", taskId: String? = "t-c5",
        title: String? = "C5 · 托管 runner", started: Long = 66, heartbeat: Long? = 0, runner: String? = "workstation-gpu", timedOut: Boolean = false,
        limit: Int? = 600, retryable: Boolean = false) = buildJsonObject {
        put("jobId", id); put("kind", kind); put("state", state); put("phase", phase); put("taskId", taskId); put("taskTitle", title); put("generation", 1)
        put("startedAt", iso(started)); put("queuedAt", iso(started + 32)); put("heartbeatAt", heartbeat?.let(::iso)); put("runnerName", runner)
        put("retriedBy", null as String?); put("timedOut", timedOut); put("limitSeconds", limit); put("retryable", retryable)
    }

    /** One of the project's landings, as `landTasks` serves it — the branch a job lands on. */
    private fun landing(jobId: String, targetRef: String = "refs/heads/project/34bmzOkov3xN2yLPrnsCk", state: String = "RUNNING") = buildJsonObject {
        put("taskId", "t-c5"); put("taskTitle", "C5 · 托管 runner")
        putJsonObject("integration") { putJsonObject("landTask") { put("jobId", jobId); put("state", state); put("phase", "CHECK"); put("targetRef", targetRef) } }
    }

    /** The 9:07 screen: tasks landing on the project branch, the lead's runner reporting as it works. `inFlight` is the lead of the jobs
     * it is handed, as the server's read gives it. */
    private fun running(jobs: List<JsonObject>, landTasks: List<JsonObject>? = null) = buildJsonObject {
        val lead = jobs.firstOrNull()
        put("integratingCount", jobs.count { it.text("state") == "RUNNING" }); put("queuedCount", jobs.count { it.text("state") == "QUEUED" })
        putJsonObject("inFlight") {
            put("taskTitle", lead?.text("taskTitle") ?: "C5 · 托管 runner"); put("state", lead?.text("state") ?: "RUNNING")
            put("startedAt", lead?.text("startedAt") ?: iso(66)); put("kind", lead?.text("kind") ?: "LAND_TASK"); put("phase", lead?.text("phase") ?: "CHECK")
            put("heartbeatAt", lead?.text("heartbeatAt") ?: iso(0))
        }
        put("landTasks", JsonArray(landTasks ?: jobs.map { landing(it.text("jobId")!!) }))
        put("inFlightJobs", JsonArray(jobs))
    }
    private fun JsonObject.text(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull

    // MARK: the card (ProjectLandingCardTests)

    /** In flight, one job: the row plus the branch it lands on and the sentence that takes the reader off the hook; its clock, wait
     * and freshness are the row's own. */
    @Test fun theCardIsTheRowPlusTheBranchItsJobsAndTheSentence() {
        val view = running(listOf(job("j-c5")))
        val card = ProjectPage.landingCard(view, now, now, false)!!
        assertEquals("Landing", card.title); assertEquals("Landing", card.word); assertEquals("checking", card.state)
        assertTrue(card.running); assertFalse(card.timedOut)
        assertEquals("C5 · 托管 runner", card.what); assertEquals("project/34bmzOkov3xN2yLPrnsCk", card.target)
        assertEquals("1m 6s", card.clock); assertEquals("Elapsed", card.clockLabel); assertEquals("Updated just now", card.updated)
        assertEquals(listOf("j-c5"), card.jobs.map { it.jobId }); assertNull(card.detail); assertNull(card.retryJobId)
        assertEquals(LandingHead("1m 6s", true, "checking · updated just now"), card.head)
        // The line the row drew, unchanged: the card cannot say anything the row could not.
        assertEquals(LandingLine("Landing", "C5 · 托管 runner", true, "checking", "1m 6s", "Elapsed", "Updated just now"), ProjectPage.landingLine(view, now, now, false))
    }

    /** Queued, waiting its turn: the same card standing still — nothing spins, the clock is the wait, and the head says so. */
    @Test fun aQueuedJobIsTheSameCardStandingStill() {
        val view = running(listOf(job("j-q", state = "QUEUED", phase = null, started = 65, heartbeat = null, runner = null, limit = null)))
        val card = ProjectPage.landingCard(view, now, now, false)!!
        assertEquals("Landing", card.title); assertEquals("queued", card.state); assertFalse(card.running); assertFalse(card.timedOut)
        assertEquals("Queued for", card.clockLabel); assertNull(card.wait)
        assertEquals(LandingHead("1m 5s", true, "queued · updated just now"), card.head)
    }

    /** Several jobs: the head counts them the way the row's name slot does, and the body names each one with its own state — a queued
     * job is not painted with the running one's colour or word. */
    @Test fun severalJobsAreACountInTheHeadAndARowEachInTheBody() {
        val view = running(listOf(job("j-1"), job("j-2", state = "QUEUED", phase = null, taskId = "t-d", title = "维护：dossier 重复发出", started = 32,
            heartbeat = null, runner = null, limit = null)))
        val card = ProjectPage.landingCard(view, now, now, false)!!
        assertEquals("Landing 2 jobs", card.title); assertNull("the count is the head's; the bodies are the rows", card.what)
        assertEquals(listOf("C5 · 托管 runner" to "checking", "维护：dossier 重复发出" to "queued"), card.jobs.map { it.title to it.state })
        assertEquals(listOf(true, false), card.jobs.map { it.running })
        // The head, the clock and the branch are the LEAD job's: the one that is running.
        assertEquals("checking", card.state); assertTrue(card.running); assertEquals("project/34bmzOkov3xN2yLPrnsCk", card.target)
        // All of them waiting their turn: nothing spins, and the head says so.
        val queued = running(listOf(job("j-1", state = "QUEUED", phase = null, heartbeat = null, runner = null, limit = null),
            job("j-2", state = "QUEUED", phase = null, taskId = "t-d", title = "维护：dossier 重复发出", heartbeat = null, runner = null, limit = null)))
        val waiting = ProjectPage.landingCard(queued, now, now, false)!!
        assertEquals("Landing 2 jobs", waiting.title); assertEquals("queued", waiting.state); assertFalse(waiting.running); assertEquals("Queued for", waiting.clockLabel)
    }

    /** A lead the server judged timed out: the card says so, says where the runner stopped and whether a push was recorded, and offers
     * Retry — the job list's own sentence, under the card. */
    @Test fun aTimedOutLeadSaysWhereItStoppedAndOffersRetry() {
        val view = running(listOf(job("j-c5", started = 6_630, heartbeat = 6_620, timedOut = true, retryable = true)))
        val card = ProjectPage.landingCard(view, now, now, false, ZoneOffset.UTC)!!
        assertTrue(card.timedOut); assertFalse(card.running); assertEquals("Landing", card.title); assertEquals("Timed out", card.state)
        assertEquals("110m", card.clock); assertEquals("No report for", card.clockLabel); assertEquals("limit 10m", card.updated)
        assertEquals("Runner workstation-gpu took it at 07:16 · stopped at checking · no push recorded", card.detail)
        assertEquals("j-c5", card.retryJobId)
        assertEquals(LandingHead("Timed out", false, "No report for 110m · limit 10m"), card.head)
        // Several, the lead timed out: the count names how many did.
        val two = running(listOf(job("j-c5", started = 6_630, heartbeat = 6_620, timedOut = true, retryable = true),
            job("j-2", state = "QUEUED", phase = null, taskId = "t-d", title = "维护", heartbeat = null, runner = null, limit = null)))
        assertEquals("Landing 2 jobs · 1 timed out", ProjectPage.landingCard(two, now, now, false)!!.title)
        assertEquals(listOf("Timed out", "queued"), ProjectPage.landingCard(two, now, now, false)!!.jobs.map { it.state })
    }

    /** Retry is the server's answer, never the timeout's: a job the server will not take a retry for has no press, and only the LEAD
     * job's flag can offer one. */
    @Test fun retryIsTheServersAnswerAndTheLeadJobs() {
        val refused = running(listOf(job("j-c5", started = 6_630, heartbeat = 6_620, timedOut = true, retryable = false)))
        assertNull(ProjectPage.landingCard(refused, now, now, false)!!.retryJobId)
        val behind = running(listOf(job("j-1"), job("j-2", taskId = "t-d", title = "维护", started = 6_630, heartbeat = 6_620, timedOut = true, retryable = true)))
        val card = ProjectPage.landingCard(behind, now, now, false)!!
        assertEquals("checking", card.state); assertNull(card.retryJobId)
    }

    /** Nothing in flight is no card at all — and a server that lists no jobs still gets the card, with what it can say: no rows, no
     * branch to name, no Retry to offer. */
    @Test fun nothingLandingDrawsNoCardAndAnOlderServerDrawsWhatItCan() {
        assertNull(ProjectPage.landingCard(buildJsonObject { put("integratingCount", 0); put("queuedCount", 0); put("inFlight", JsonNull) }, now, now, false))
        val older = buildJsonObject {
            put("integratingCount", 1); put("queuedCount", 0)
            putJsonObject("inFlight") { put("taskTitle", "C5 · 托管 runner"); put("state", "RUNNING"); put("startedAt", iso(66)); put("kind", "LAND_TASK")
                put("phase", "CHECK"); put("heartbeatAt", iso(0)) }
        }
        val card = ProjectPage.landingCard(older, now, now, false)!!
        assertEquals("Landing", card.title); assertEquals("C5 · 托管 runner", card.what); assertEquals(emptyList<LandingCard.Job>(), card.jobs)
        assertNull(card.target); assertNull(card.retryJobId)
    }

    /** The branch is the job's own landing, short — absent when the job is not one of the project's landings at all, and when the
     * landing names no ref. */
    @Test fun theBranchIsTheJobsOwnLandingAndAbsentWhenNothingNamesIt() {
        val check = running(listOf(job("j-check", kind = "CHECK_PROMOTION", taskId = null, title = null)), landTasks = emptyList())
        assertNull(ProjectPage.landingCard(check, now, now, false)!!.target)
        assertEquals("main", ProjectPage.landingCard(running(listOf(job("j-c5")), listOf(landing("j-c5", "main"))), now, now, false)!!.target)
        assertNull(ProjectPage.landingCard(running(listOf(job("j-c5")), listOf(landing("j-c5", ""))), now, now, false)!!.target)
        assertNull(ProjectPage.landingCard(running(listOf(job("j-c5")), listOf(landing("j-other"))), now, now, false)!!.target)
    }

    // MARK: the head (ProjectLandingHeadTests, the board's six states)

    private fun head(state: String, timedOut: Boolean = false, clock: String = "2m 40s", clockLabel: String = "Elapsed", wait: String? = null,
        updated: String? = null) = ProjectPage.landingHead(state, timedOut, clockLabel, clock, wait, updated)

    @Test fun runningLeadsWithTheClockAndItsState() {
        // The freshness's own capital folds away: the line reads as one sentence.
        assertEquals(LandingHead("2m 40s", true, "checking · updated 2m ago"), head("checking", updated = "Updated 2m ago"))
    }

    @Test fun theWaitIsAClauseOfTheLineAndOnlyWhenThereWasOne() {
        assertEquals("checking · waited 1m 20s · updated just now", head("checking", wait = "1m 20s", updated = "Updated just now").detail)
        assertEquals("queued · updated just now", head("queued", updated = "Updated just now").detail)
        assertEquals("checking", head("checking").detail)
    }

    @Test fun queuedIsTheSameRowWithTheClockStandingStill() {
        assertEquals(LandingHead("1m 5s", true, "queued · updated just now"), head("queued", clock = "1m 5s", updated = "Updated just now"))
    }

    @Test fun anUnreadableServerFreezesTheClockAndSaysSo() {
        assertEquals(LandingHead("2m 40s", true, "Update unavailable · updated 12m ago"), head("Update unavailable", updated = "Updated 12m ago"))
    }

    @Test fun aTimedOutJobLosesTheClockAndLeadsWithItsStateInTheLine() {
        assertEquals(LandingHead("Timed out", false, "No report for 110m · limit 10m"),
            head("Timed out", timedOut = true, clock = "110m", clockLabel = "No report for", updated = "limit 10m"))
    }

    /** An older server's silence IS the state word, so the line is its own sentence — never "No report · No report for 5m". */
    @Test fun anOlderServersSilenceIsSaidOnce() {
        assertEquals(LandingHead("5m", true, "No report for 5m"), head(ProjectPage.landingNoReport, clock = "5m", clockLabel = "No report for", updated = "No report for 5m"))
        assertEquals(ProjectPage.landingNoReportYet, head(ProjectPage.landingNoReport, updated = ProjectPage.landingNoReportYet).detail)
    }

    /** The card and the line share the one function, so a card can never word a job differently from the row beside it. */
    @Test fun theCardAndTheLineComposeTheSameHead() {
        val line = LandingLine("Landing", "C5 · 托管 runner", false, "queued", "1m 5s", "Queued for", "Updated just now")
        assertEquals(head("queued", clock = "1m 5s", clockLabel = "Queued for", updated = "Updated just now"), line.head)
        // A merge check the read hands over as working: "Merge check  2m 40s" over "checking · updated just now".
        val check = buildJsonObject {
            put("integratingCount", 1); put("queuedCount", 0); put("landTasks", JsonArray(emptyList()))
            putJsonObject("inFlight") { put("taskTitle", JsonNull); put("state", "RUNNING"); put("startedAt", iso(160)); put("kind", "CHECK_PROMOTION")
                put("phase", "CHECK"); put("heartbeatAt", iso(0)) }
        }
        val read = ProjectPage.landingLine(check, now, now, false)!!
        assertEquals("Merge check", read.word); assertEquals(LandingHead("2m 40s", true, "checking · updated just now"), read.head)
    }

    /** §7.2 V6: once the server sends the step, claim and liveness facts, the card's head and the jobs list's rows draw them — and a
     * server that sends none keeps the card above, word for word. */
    @Test fun theV6FactsReachTheCardAndEveryRow() {
        val v6 = { liveness: String -> buildJsonObject {
            put("taskTitle", "C5 · 托管 runner"); put("state", "RUNNING"); put("kind", "LAND_TASK"); put("phase", "CHECK")
            put("startedAt", iso(110)); put("heartbeatAt", iso(0)); put("jobId", "j-c5"); put("taskId", "t-c5"); put("runner", "workstation-gpu")
            put("claim", 1); put("round", 1)
            put("check", Json.parseToJsonElement("""{"name":"TASK_ACCEPTANCE","index":1,"count":3,"budgetSeconds":3600,"startedAt":"${iso(110)}"}"""))
            put("stepStartedAt", iso(110)); put("outputMovedAt", iso(6)); put("progressProtocol", "v2"); put("typicalMs", null)
            put("liveness", liveness)
        } }
        val view = { liveness: String -> buildJsonObject {
            put("integratingCount", 1); put("queuedCount", 0)
            put("inFlight", v6(liveness))
            put("landTasks", JsonArray(listOf(landing("j-c5"))))
            put("inFlightJobs", JsonArray(listOf(Json.parseToJsonElement(v6(liveness).toString()))))
        } }
        val card = ProjectPage.landingCard(view("LIVE"), now, now, false)!!
        val expected = LandingHead("1m 50s of 60m", true, "checking · output 6s ago · claim 1 · round 1 of 3")
        assertEquals(expected, card.head)
        assertEquals("1m 50s of 60m", card.clock); assertEquals(true, card.liveness?.ticking)
        assertEquals(expected, ProjectPage.landingJobLines(view("LIVE"), now, now, false).single().line.head)
        // LEGACY keeps its clock but never infers silence; the head says why it is quiet.
        assertEquals(LandingHead("1m 50s of 60m", true, "checking · reports only between steps · claim 1 · round 1 of 3"),
            ProjectPage.landingCard(view("LEGACY"), now, now, false)!!.head)
        // A server without the fields: the card is the one this file's first test draws, unchanged.
        val older = running(listOf(job("j-c5")))
        assertEquals(LandingHead("1m 6s", true, "checking · updated just now"), ProjectPage.landingCard(older, now, now, false)!!.head)
    }
}
