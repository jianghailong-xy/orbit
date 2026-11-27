package io.orbitd.android.directory

import io.orbitd.android.core.protocol.Wire
import java.io.File
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A session a full runner, run or batch holds (docs/mocks/queued-card-runner-full), case for case with web `queuedCapacity.test.ts` and
 *  OrbitKit `QueuedCapacityTests`: HPC on 11-15, 10 turns and 6 slots held by bg_run jobs, of 16. */
class QueuedCapacityTest {
    private fun gate(reason: String?, active: Int? = 16, limit: Int? = 16, held: Int? = 6, since: String? = "2026-11-14T17:14:54.436Z") =
        QueuedGate(reason, active, null, limit, held, since)

    private fun sentences() = listOf(
        QueuedCapacity.messageText(gate("runner_at_capacity"), "HPC"),
        QueuedCapacity.messageText(gate("runner_at_capacity", 2, 2, 1), "HPC"),
        QueuedCapacity.messageText(gate("runner_at_capacity", held = 0), "HPC"),
        QueuedCapacity.messageText(gate("runner_at_capacity", held = null), "  "),
        QueuedCapacity.messageText(gate("runner_at_capacity", null, null, null), "HPC"),
        QueuedCapacity.messageText(gate("tree_at_capacity", 13, 13, null), "HPC"),
        QueuedCapacity.messageText(gate("batch_at_capacity", 4, 4, null), null),
    )

    @Test fun heldByTheThreeCapacityGatesAndNoOther() {
        listOf("runner_at_capacity", "tree_at_capacity", "batch_at_capacity").forEach { assertTrue(it, QueuedCapacity.isCapacityHeld(gate(it))) }
        listOf("runner_updating", "runner_offline", "worktree_op_pending", null).forEach { assertFalse("$it", QueuedCapacity.isCapacityHeld(gate(it))) }
        assertFalse(QueuedCapacity.isCapacityHeld(null))
    }

    @Test fun theTagAndTitleNameWhatIsFull() {
        assertEquals(listOf("runner full", "Runner full"), gate("runner_at_capacity").let { listOf(QueuedCapacity.tag(it), QueuedCapacity.title(it)) })
        assertEquals(listOf("run full", "Run full"), gate("tree_at_capacity").let { listOf(QueuedCapacity.tag(it), QueuedCapacity.title(it)) })
        assertEquals(listOf("batch full", "Batch full"), gate("batch_at_capacity").let { listOf(QueuedCapacity.tag(it), QueuedCapacity.title(it)) })
    }

    @Test fun thePopoverCountsTurnsAndSlotsHeldByJobsApart() {
        assertEquals(listOf(
            "HPC is using all 16 slots: 10 sessions are running a turn and 6 hold a slot with a background job. This message is sent as soon as one frees up.",
            "HPC is using all 2 slots: 1 session is running a turn and 1 holds a slot with a background job. This message is sent as soon as one frees up.",
            "HPC is running 16 of 16 sessions. This message is sent as soon as one finishes.",
            "The runner is running 16 of 16 sessions. This message is sent as soon as one finishes.",
            "HPC is using all its slots. This message is sent as soon as one frees up.",
            "This run is already using all its slots (13/13). This message is sent as soon as one of its sessions finishes.",
            "This batch is running its maximum (4/4). This message is sent as soon as one of its sessions finishes.",
        ), sentences())
    }

    @Test fun theWaitCountsFromWhenTheSessionWentPending() {
        val g = gate("runner_at_capacity")
        val at = Instant.parse("2026-11-14T17:14:54.436Z")
        assertEquals("Waiting 15 min", QueuedCapacity.waited(g, at.plusSeconds(15 * 60 + 30)))
        assertEquals("Waiting less than a minute", QueuedCapacity.waited(g, at.plusSeconds(20)))
        assertEquals("Waiting 1 h 15 min", QueuedCapacity.waited(g, at.plusSeconds(75 * 60)))
        assertNull(QueuedCapacity.waited(gate("runner_at_capacity", since = null), at))
        assertNull(QueuedCapacity.waited(g, at.minusMillis(1)))
    }

    @Test fun aListRowCarriesItsCountsAndItsClock() {
        val row = DirectorySession(id = "S1", queuedReason = "runner_at_capacity", queuedActive = 16, queuedLimit = 16, queuedHeldByJobs = 6,
            lastTurnAt = "2026-11-14T17:14:54.436Z")
        assertEquals(gate("runner_at_capacity"), row.queuedGate)
    }

    /** A `GET /sessions` row as the server sends it (sessions.service.ts, queued-gate.ts `queuedRunNowOf`): HPC full at 16 of 16. */
    private fun row(extra: String) = Wire.json.decodeFromString(DirectorySession.serializer(),
        """{"id":"34aaaaaaaaaaaaaaaaaaa","title":"Android","status":"PENDING","runState":"QUEUED","queuedReason":"runner_at_capacity",""" +
            """"queuedActive":16,"queuedLimit":16,"queuedHeldByJobs":0,"lastTurnAt":"2026-11-14T17:14:54.436Z",$extra}""")
    private val offered = """"runNowAvailable":true,"runNowRefusal":null,"queuedBurstLimit":2,"runningOverLimit":null"""
    private val atCap = "HPC is already 2 over its limit, the most it can take. Wait, or stop another session."

    @Test fun runNowSaysWhatPressingDoes() {
        val gate = row(offered).queuedGate
        assertTrue(gate.runNowAvailable)
        assertNull(gate.runNowRefusal)
        assertEquals("Starts it as the 17th session on HPC. This turn only; the limit stays 16.", QueuedCapacity.runNowNote(gate, "HPC"))
        assertEquals(listOf("21st", "22nd", "23rd", "11th", "12th", "13th", "111th"), listOf(20, 21, 22, 10, 11, 12, 110).map { active ->
            QueuedCapacity.runNowNote(gate.copy(queuedActive = active), "HPC")!!.substringAfter("as the ").substringBefore(" session")
        })
        // A full run or batch counts from the runner's own slots, not the gate's.
        val tree = gate.copy(queuedReason = "tree_at_capacity", queuedActive = 13, queuedLimit = 13)
        assertEquals("Starts it as the 6th session on this runner. This turn only; the limit stays 16.", QueuedCapacity.runNowNote(tree, " ", 5, 16))
        assertEquals("Starts this turn now. The limit stays the same.", QueuedCapacity.runNowNote(tree, "HPC"))
    }

    @Test fun aRefusalIsTheServersSentenceAndNothingElseDrawsNoButton() {
        val refused = row(""""runNowAvailable":false,"runNowRefusal":"$atCap","queuedBurstLimit":2""").queuedGate
        assertFalse(refused.runNowAvailable)
        assertEquals(atCap, QueuedCapacity.runNowNote(refused, "HPC"))
        // An older server sends neither; a gate no slot holds sends false and null.
        assertNull(QueuedCapacity.runNowNote(row(""""runSource":null""").queuedGate, "HPC"))
        val offline = Wire.json.decodeFromString(DirectorySession.serializer(),
            """{"id":"s","queuedReason":"runner_offline","runNowAvailable":false,"runNowRefusal":null,"queuedBurstLimit":null}""")
        assertNull(QueuedCapacity.runNowNote(offline.queuedGate, "HPC"))
        assertNull(QueuedCapacity.runNowNote(row(offered).queuedGate.copy(queuedReason = "runner_updating"), "HPC"))
    }

    @Test fun theOverLimitTagCountsAndNamesTheRunner() {
        val over = RunningOverLimit.of(row(""""runningOverLimit":{"active":17,"limit":16,"runnerName":"HPC"}""").runningOverLimit)!!
        assertEquals("over limit · 17/16", QueuedCapacity.overLimitTag(over))
        assertEquals("Started over HPC's limit by you", QueuedCapacity.overLimitHint(over))
        assertEquals("Started over the runner's limit by you", QueuedCapacity.overLimitHint(over.copy(runnerName = null)))
        assertNull(RunningOverLimit.of(row(offered).runningOverLimit))
        assertNull(RunningOverLimit.of(row(""""runSource":null""").runningOverLimit))
    }

    /** Every word is web `queuedCapacity.ts`'s, and every sentence one its spec expects. A missing counterpart is a failure. */
    @Test fun theWordsAreTheWebs() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/web/src/lib/queuedCapacity.ts").isFile }
        val copy = File(root, "src/web/src/lib/queuedCapacity.ts").readText()
        val spec = File(root, "src/web/src/lib/queuedCapacity.test.ts").readText().replace(Regex("\\s+"), " ")
        mapOf("RUNNER_FULL_TITLE" to QueuedCapacity.RUNNER_FULL_TITLE, "RUNNER_FULL_TAG" to QueuedCapacity.RUNNER_FULL_TAG,
            "RUN_FULL_TITLE" to QueuedCapacity.RUN_FULL_TITLE, "RUN_FULL_TAG" to QueuedCapacity.RUN_FULL_TAG,
            "BATCH_FULL_TITLE" to QueuedCapacity.BATCH_FULL_TITLE, "BATCH_FULL_TAG" to QueuedCapacity.BATCH_FULL_TAG,
            "CAPACITY_HELD_LINE" to QueuedCapacity.CAPACITY_HELD_LINE, "RUN_NOW" to QueuedCapacity.RUN_NOW,
            "EXTRA_SESSIONS_ON_DEMAND" to QueuedCapacity.EXTRA_SESSIONS_ON_DEMAND,
        ).forEach { (name, words) -> assertTrue("$name", copy.contains("export const $name = '$words';")) }
        QueuedCapacity.REASONS.forEach { assertTrue(it, copy.contains("reason === '$it'")) }
        sentences().forEach { assertTrue("queuedCapacity.test.ts no longer expects $it", spec.contains("'$it'")) }
        // Run now's other words, which queuedCapacity.ts builds from parts: each template as the web writes it.
        listOf("export const RUN_NOW_FAILED = \"${QueuedCapacity.RUN_NOW_FAILED}\";",
            "return 'Starts this turn now. The limit stays the same.';",
            "return `Starts it as the \${next}\${suffix} session \${where}. This turn only; the limit stays \${limit}.`;",
            "`on \${machine.trim()}` : 'on this runner'",
            "return `over limit · \${active}/\${limit}`;",
            "`Started over \${runner}'s limit by you` : \"Started over the runner's limit by you\"",
        ).forEach { assertTrue("queuedCapacity.ts no longer says $it", copy.contains(it)) }
        val settings = File(root, "src/web/src/components/settings/MachineSettingsPage.tsx").readText()
        assertTrue(settings.contains("const MAX_EXTRA_SESSIONS = ${QueuedCapacity.MAX_EXTRA_SESSIONS};"))
    }
}
