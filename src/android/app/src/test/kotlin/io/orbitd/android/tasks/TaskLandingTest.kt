package io.orbitd.android.tasks

import io.orbitd.android.navigation.Destination
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The task page's Landing section (contract §2.7a): what a task's newest LAND_TASK says in the
 * web's `LandTaskStatus` and iOS `TaskLandingLogic` words, what a task with no attempt says from its
 * read, and the two cadences the page follows it at. */
class TaskLandingTest {
    private val now = Instant.parse("2026-10-18T11:05:00Z")
    private val zone = ZoneOffset.UTC

    private fun at(minutesAgo: Long): String = now.minusSeconds(minutesAgo * 60).toString()

    private fun JsonObjectBuilder.string(key: String, value: String?) {
        put(key, value?.let(::JsonPrimitive) ?: JsonNull)
    }

    private fun job(state: String = "RUNNING", phase: String? = "CHECK", heartbeatAt: String? = at(0),
        generation: String? = "3", queuedAt: String? = at(7), startedAt: String? = at(6), finishedAt: String? = null,
        waitMs: Long? = 60_000, targetRef: String? = "refs/heads/project/P1", blockingReason: JsonObject? = null,
        landingSessionId: String? = "L1"): JsonObject = buildJsonObject {
        put("jobId", "j1")
        put("state", state)
        string("phase", phase)
        string("generation", generation)
        string("queuedAt", queuedAt)
        string("startedAt", startedAt)
        string("heartbeatAt", heartbeatAt)
        string("finishedAt", finishedAt)
        string("targetRef", targetRef)
        put("waitMs", waitMs?.let { JsonPrimitive(it) } ?: JsonNull)
        put("blockingReason", blockingReason ?: JsonNull)
        string("landingSessionId", landingSessionId)
    }

    private fun integration(state: String = "RUNNING", landTask: JsonObject? = job()): JsonObject = buildJsonObject {
        put("state", state)
        put("landTask", landTask ?: JsonNull)
    }

    private fun task(integration: JsonObject?): JsonObject = buildJsonObject {
        put("id", "t1")
        if (integration != null) put("integration", integration)
    }

    private fun status(integration: JsonObject?, now: Instant = this.now) =
        TaskLandingLogic.status(TaskIntegrationView.of(task(integration)), now, zone)

    // MARK: decoding

    @Test fun theReadModelDecodesEveryLandingField() {
        val view = TaskIntegrationView.of(task(integration("RUNNING", job(
            state = "CHECK_FAILED", phase = "CHECK", generation = "3",
            queuedAt = at(7), startedAt = at(6), heartbeatAt = at(0), finishedAt = at(1), waitMs = 60_000,
            targetRef = "refs/heads/project/P1", landingSessionId = "L1",
            blockingReason = buildJsonObject { put("code", "CHECK_FAILED"); put("summary", "Task acceptance exited 1 (expected 0).") }))))
        assertNotNull(view)
        assertEquals("RUNNING", view!!.state)
        val job = view.landTask!!
        assertEquals("j1", job.jobId)
        assertEquals("CHECK_FAILED", job.state)
        assertEquals("CHECK", job.phase)
        assertEquals("3", job.generation)
        assertEquals(at(7), job.queuedAt)
        assertEquals(at(6), job.startedAt)
        assertEquals(at(0), job.heartbeatAt)
        assertEquals(at(1), job.finishedAt)
        assertEquals(60_000L, job.waitMs)
        assertEquals("refs/heads/project/P1", job.targetRef)
        assertEquals("Task acceptance exited 1 (expected 0).", job.blockingReason)
        assertEquals("L1", job.landingSessionId)
    }

    @Test fun anOldServerDrawsNoSection() {
        // No `integration` at all: a server that predates the unified read model.
        assertNull(TaskIntegrationView.of(task(null)))
        assertNull(TaskIntegrationView.of(null))
        assertNull(status(null))
        // An integration with no attempt and nothing to say reads as no section.
        assertNull(status(integration("NOT_APPLICABLE", landTask = null)))
        // A task whose landing was never queued is a section with a sentence and no job.
        val queued = status(integration("QUEUED", landTask = null))!!
        assertEquals("Waiting to land", queued.badge?.label)
        assertEquals(TaskLandingCopy.waitingNotQueued, queued.reason)
        assertTrue(queued.facts.isEmpty())
        assertNull(queued.generation)
        // A job row with no landingSessionId still draws the section, with no way in.
        val noSession = status(buildJsonObject {
            put("state", "RUNNING")
            put("landTask", buildJsonObject { put("jobId", "j1"); put("state", "RUNNING"); put("heartbeatAt", at(0)) })
        })!!
        assertNull(noSession.landingSessionId)
        assertNull(TaskLandingLogic.route(noSession))
    }

    // MARK: badge and words

    @Test fun everyLandingStateHasItsWordAndInk() {
        val words = mapOf(
            "QUEUED" to ("Waiting to land" to "amber"),
            "RUNNING" to ("Landing" to "blue"),
            "LANDED" to ("Landed" to "green"),
            "ALREADY_LANDED" to ("Already landed" to "green"),
            "NOTHING_TO_LAND" to ("Nothing to land" to "muted"),
            "READY" to ("Ready to merge" to "amber"),
            "CONFLICT" to ("Landing conflict" to "red"),
            "CHECK_FAILED" to ("Landing checks failed" to "red"),
            "ERROR" to ("Landing error" to "red"),
            "CANCELLED" to ("Landing cancelled" to "muted"),
            "SUPERSEDED" to ("Landing superseded" to "muted"),
        )
        words.forEach { (state, word) ->
            val badge = status(integration("RUNNING", job(state = state)))?.badge
            assertEquals("state $state", word.first, badge?.label)
            assertEquals("state $state tone", word.second, badge?.tone)
        }
        // An unknown state is drawn with the server's own word, never dropped.
        assertEquals("SOMETHING_NEW", status(integration("RUNNING", job(state = "SOMETHING_NEW")))?.badge?.label)
        assertEquals("muted", status(integration("RUNNING", job(state = "SOMETHING_NEW")))?.badge?.tone)
    }

    @Test fun aTaskWithoutAnAttemptReadsItsReceipts() {
        val onLine = status(integration("ON_INTEGRATION_LINE", landTask = null))!!
        assertEquals("Landed", onLine.badge?.label)
        assertEquals("green", onLine.badge?.tone)
        val upstream = status(integration("ON_UPSTREAM", landTask = null))!!
        assertEquals("On main", upstream.badge?.label)
        assertEquals("green", upstream.badge?.tone)
        // The state that has nothing to say draws nothing.
        assertNull(status(integration("NOT_APPLICABLE", landTask = null)))
        assertNull(status(integration("AWAITING_OWNER", landTask = null)))
    }

    @Test fun aRunningAttemptNamesItsStepAndAStoppedOneSaysWhereItStopped() {
        assertEquals("checking", status(integration("RUNNING", job(state = "RUNNING", phase = "CHECK")))?.step)
        assertEquals("pushing", status(integration("RUNNING", job(state = "RUNNING", phase = "PUSH")))?.step)
        assertEquals("stopped while checking", status(integration("CHECK_FAILED", job(state = "CHECK_FAILED", phase = "CHECK")))?.step)
        assertEquals("stopped while syncing main", status(integration("CONFLICT", job(state = "CONFLICT", phase = "MAIN_SYNC")))?.step)
        // A settled attempt that was not stopped at a step says no step at all.
        assertNull(status(integration("ON_INTEGRATION_LINE", job(state = "LANDED", phase = "CHECK")))?.step)
        assertNull(status(integration("RUNNING", job(state = "RUNNING", phase = null)))?.step)
    }

    // MARK: a silent runner

    @Test fun aSilentRunnerIsSaidInTheProjectPagesWords() {
        // No verdict from the server (§2.7a's task read carries none): the project page's claim lease
        // decides, so a heartbeat past ten minutes, or none at all, is the section's own fact.
        assertEquals("No report for 12m", status(integration("RUNNING", job(state = "RUNNING", heartbeatAt = at(12))))?.noReport)
        assertEquals("No report yet", status(integration("RUNNING", job(state = "RUNNING", heartbeatAt = null)))?.noReport)
        assertNull(status(integration("RUNNING", job(state = "RUNNING", heartbeatAt = at(5))))?.noReport)
        // Only a running attempt can be silent: a queued or settled one has no clock to miss.
        assertNull(status(integration("QUEUED", job(state = "QUEUED", heartbeatAt = at(30))))?.noReport)
        assertNull(status(integration("CHECK_FAILED", job(state = "CHECK_FAILED", heartbeatAt = at(30))))?.noReport)
        // The age is read from the passed clock, so a page that keeps looking sees it grow.
        assertEquals("No report for 40m", status(integration("RUNNING", job(state = "RUNNING", heartbeatAt = at(12))),
            now.plusSeconds(28 * 60))?.noReport)
    }

    // MARK: reason and receipt

    @Test fun theReasonIsTheServersOwnSentenceAndAReceiptOutranksAnOlderAttempt() {
        val stopped = job(state = "CHECK_FAILED", phase = "CHECK",
            blockingReason = buildJsonObject { put("code", "CHECK_FAILED"); put("summary", "Task acceptance exited 1 (expected 0).") })
        val failed = status(integration("CHECK_FAILED", stopped))!!
        assertEquals("Task acceptance exited 1 (expected 0).", failed.reason)
        assertNull(failed.receipt)

        val onBranch = status(integration("ON_INTEGRATION_LINE", job(state = "ERROR", phase = "PUSH")))!!
        assertEquals("Its work is on the project branch by an existing receipt.", onBranch.receipt)
        val onMain = status(integration("ON_UPSTREAM", job(state = "ERROR", phase = "PUSH")))!!
        assertEquals("Its work is on main by an existing receipt.", onMain.receipt)
        // A landed attempt needs no receipt sentence, and nothing is said without an attempt.
        assertNull(status(integration("ON_INTEGRATION_LINE", job(state = "LANDED")))?.receipt)
        assertNull(status(integration("ON_UPSTREAM", landTask = null))?.receipt)
        // A healthy attempt has no reason to give.
        assertNull(status(integration("RUNNING", job(state = "RUNNING")))?.reason)
    }

    // MARK: facts

    @Test fun theSixFactsComeFromTheRowsOwnColumns() {
        val facts = status(integration("CHECK_FAILED", job(state = "CHECK_FAILED", waitMs = 60_000,
            queuedAt = "2026-10-18T11:02:12Z", startedAt = "2026-10-18T11:03:00Z", heartbeatAt = "2026-10-18T11:07:02Z",
            finishedAt = null, targetRef = "refs/heads/project/P1")))!!.facts
        assertEquals(listOf("Target", "Queue wait", "Queued", "Started", "Heartbeat", "Finished"), facts.map { it.label })
        assertEquals(listOf("project/P1", "1m", "Oct 18, 11:02:12 AM", "Oct 18, 11:03:00 AM", "Oct 18, 11:07:02 AM", "—"),
            facts.map { it.value })
        // A wait under a second is nothing, and a missing wait is nothing rather than a dash.
        assertEquals("0s", status(integration("RUNNING", job(waitMs = 500)))!!.facts[1].value)
        assertEquals("0s", status(integration("RUNNING", job(waitMs = null)))!!.facts[1].value)
        assertEquals("", status(integration("RUNNING", job(targetRef = null)))!!.facts[0].value)
        assertTrue(status(integration("ON_INTEGRATION_LINE", landTask = null))!!.facts.isEmpty())
    }

    // MARK: the way in and the cadence

    @Test fun openLandingIsOnlyDrawnWhenTheServerNamesASession() {
        val withSession = status(integration("RUNNING", job(landingSessionId = "L1")))!!
        assertEquals("L1", withSession.landingSessionId)
        assertEquals(Destination.SESSION, TaskLandingLogic.route(withSession)?.destination)
        assertEquals("L1", TaskLandingLogic.route(withSession)?.id)
        // An empty id is no page, exactly as the web's `landingEntry` reads it.
        assertNull(TaskLandingLogic.route(status(integration("RUNNING", job(landingSessionId = "")))!!))
        assertNull(TaskLandingLogic.route(status(integration("RUNNING", job(landingSessionId = null)))!!))
        assertNull(TaskLandingLogic.route(status(integration("QUEUED", landTask = null))!!))
    }

    @Test fun thePageFollowsALiveLandingAtTwoCadences() {
        fun every(integration: JsonObject?) = TaskLandingLogic.refetchInterval(TaskIntegrationView.of(task(integration)))
        assertEquals(4_000L, every(integration("RUNNING", job(state = "RUNNING"))))
        assertEquals("the attempt's own state decides", 4_000L, every(integration("QUEUED", job(state = "RUNNING"))))
        assertEquals(15_000L, every(integration("QUEUED", job(state = "QUEUED"))))
        assertEquals(15_000L, every(integration("QUEUED", landTask = null)))
        // Settled landings are read once, not followed.
        assertNull(every(integration("RUNNING", job(state = "LANDED"))))
        assertNull(every(integration("CHECK_FAILED", job(state = "CHECK_FAILED"))))
        assertNull(every(integration("ON_INTEGRATION_LINE", landTask = null)))
        assertNull(every(integration("NOT_APPLICABLE", landTask = null)))
        assertNull(every(null))
    }
}
