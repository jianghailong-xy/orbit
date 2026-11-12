package io.orbitd.android.directory

import io.orbitd.android.core.protocol.Wire
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

/** A session held by its runner's update, case for case with web `runnerSlots.runnerUpdating.test.ts`: board 2's studio-mac draining
 *  for 0.1.254 behind two turns, then the less the runner reports. */
class RunnerUpdatingTest {
    private val now: Instant = Instant.parse("2026-11-12T12:00:00Z")
    private val update = QueuedRunnerUpdate("0.1.254", now.minusSeconds(38 * 60L + 5).toString(),
        listOf(QueuedRunnerUpdate.Turn("a1", "Backfill missing shard rows"), QueuedRunnerUpdate.Turn("b2", "Why are 11-08 metrics zero")))
    private val gate = QueuedGate("runner_updating", 2, update)

    private fun words(text: String) = RunnerUpdatingPart.Words(text)

    @Test fun namesTheUpdateInTheListLineAndTheStateWord() {
        val row = DirectorySession("s", status = "PENDING", runState = "QUEUED", queuedReason = "runner_updating", queuedActive = 2)
        assertEquals(SessionLine("Runner updating", SessionLine.Tone.WARNING), SessionLine.make(row, live = true, machine = "studio-mac"))
        assertEquals("Runner updating", SessionHeader.statusWord(row))
        // Every other queue keeps its word and its tone, and Trash draws no live line.
        val capacity = row.copy(queuedReason = "runner_at_capacity")
        assertEquals(SessionLine("Queued", SessionLine.Tone.QUEUED), SessionLine.make(capacity, live = true))
        assertEquals("Queued", SessionHeader.statusWord(capacity))
        assertEquals(SessionLine("Queued", SessionLine.Tone.QUEUED), SessionLine.make(row.copy(queuedReason = null), live = true))
        assertNotEquals(SessionLine.Tone.WARNING, SessionLine.make(row, live = false).tone)
        // A region hold says its own words, as web's `held ?? queuedLabel`.
        val region = row.copy(error = "CLAUDE_REGION_UNSUPPORTED: Claude Code stopped")
        assertEquals(SessionLine("Anthropic unavailable on HPC", SessionLine.Tone.QUEUED), SessionLine.make(region, live = true, machine = "HPC"))
    }

    @Test fun decodesTheRowTolerantly() {
        val row = Wire.json.decodeFromString(DirectorySession.serializer(), """{"id":"s","status":"PENDING","runState":"QUEUED",
            "queuedReason":"runner_updating","queuedActive":2,"queuedLimit":null,"queuedRunnerUpdate":{"targetVersion":"0.1.254",
            "since":"2026-11-12T11:21:55.000Z","turns":[{"id":"a1","title":"Backfill missing shard rows"},{"id":"b2","title":null}]}}""")
        assertEquals(QueuedGate("runner_updating", 2, QueuedRunnerUpdate("0.1.254", "2026-11-12T11:21:55.000Z",
            listOf(QueuedRunnerUpdate.Turn("a1", "Backfill missing shard rows"), QueuedRunnerUpdate.Turn("b2", null)))), row.queuedGate)
        // An older server sends none of it; a shape this build cannot read is no update, not a row that fails.
        assertEquals(QueuedGate(), Wire.json.decodeFromString(DirectorySession.serializer(), """{"id":"s"}""").queuedGate)
        val odd = Wire.json.decodeFromString(DirectorySession.serializer(), """{"id":"s","queuedReason":"runner_updating","queuedRunnerUpdate":"soon"}""")
        assertNull(odd.queuedGate.queuedRunnerUpdate)
    }

    @Test fun saysWhatItWaitsForWithTheTurnsAsLinksOnTheQueuedPage() {
        val parts = RunnerUpdating.runnerUpdatingDescription(gate, "studio-mac")
        assertEquals(listOf(words("studio-mac is updating to 0.1.254. "), words("It starts no new work until 2 turns finish: "),
            RunnerUpdatingPart.Session("a1", "Backfill missing shard rows"), words(" and "),
            RunnerUpdatingPart.Session("b2", "Why are 11-08 metrics zero"), words(". "), words("This session starts right after.")), parts)
        assertEquals("studio-mac is updating to 0.1.254. It starts no new work until 2 turns finish: Backfill missing shard rows and " +
            "Why are 11-08 metrics zero. This session starts right after.", RunnerUpdating.runnerUpdatingPlain(parts))
    }

    @Test fun countsTheMinutesItHasWaited() {
        assertEquals("Waiting 38 min", RunnerUpdating.runnerUpdatingWaited(gate, now))
        fun at(minutes: Long) = RunnerUpdating.runnerUpdatingWaited(gate.copy(queuedRunnerUpdate = update.copy(since = now.minusSeconds(minutes * 60).toString())), now)
        assertEquals("Waiting less than a minute", at(0))
        assertEquals("Waiting 1 h", at(60))
        assertEquals("Waiting 2 h 5 min", at(125))
        assertNull(RunnerUpdating.runnerUpdatingWaited(gate.copy(queuedRunnerUpdate = update.copy(since = null)), now))
        assertNull("a clock ahead of this one knows nothing", RunnerUpdating.runnerUpdatingWaited(gate.copy(queuedRunnerUpdate = update.copy(since = now.plusSeconds(60).toString())), now))
        assertNull(RunnerUpdating.runnerUpdatingWaited(gate.copy(queuedRunnerUpdate = update.copy(since = "not a time")), now))
    }

    @Test fun givesTheQueuedMessagesFootRowTagAndItsPopoverTheSameAccount() {
        assertEquals("runner updating", RunnerUpdating.RUNNER_UPDATING_TAG)
        assertEquals("studio-mac starts no new turns until 2 turns finish, then updates to 0.1.254. This message is sent right after.",
            RunnerUpdating.runnerUpdatingMessageText(gate, "studio-mac"))
    }

    @Test fun namesOnlyTheTurnsThatAreTheReadersAndCountsTheRest() {
        assertEquals("studio-mac is updating to 0.1.254. It starts no new work until 3 turns finish: Backfill missing shard rows, " +
            "Why are 11-08 metrics zero and 1 more. This session starts right after.",
            RunnerUpdating.runnerUpdatingPlain(RunnerUpdating.runnerUpdatingDescription(gate.copy(queuedActive = 3), "studio-mac")))
    }

    @Test fun saysLessNotSomethingFalseWhenTheRunnerReportsLess() {
        val old = QueuedGate("runner_updating", 1, QueuedRunnerUpdate(null, null, listOf(QueuedRunnerUpdate.Turn("a1", "Backfill missing shard rows"))))
        assertEquals("studio-mac is updating. It starts no new work until 1 turn finishes: Backfill missing shard rows. This session starts right after.",
            RunnerUpdating.runnerUpdatingPlain(RunnerUpdating.runnerUpdatingDescription(old, "studio-mac")))
        assertEquals("studio-mac starts no new turns until 1 turn finishes, then updates. This message is sent right after.",
            RunnerUpdating.runnerUpdatingMessageText(old, "studio-mac"))
        // Nothing left in flight: the runner is about to restart, so no sentence about turns.
        val idle = old.copy(queuedActive = 0, queuedRunnerUpdate = old.queuedRunnerUpdate!!.copy(turns = emptyList()))
        assertEquals("studio-mac is updating. This session starts right after.",
            RunnerUpdating.runnerUpdatingPlain(RunnerUpdating.runnerUpdatingDescription(idle, "studio-mac")))
        assertEquals("studio-mac updates now. This message is sent right after.", RunnerUpdating.runnerUpdatingMessageText(idle, "studio-mac"))
    }

    @Test fun anUnnamedMachineIsTheRunnerAndAnUntitledTurnIsUntitled() {
        val untitled = gate.copy(queuedActive = null, queuedRunnerUpdate = update.copy(turns = listOf(QueuedRunnerUpdate.Turn("a1", "  "))))
        assertEquals("The runner is updating to 0.1.254. It starts no new work until 1 turn finishes: Untitled session. This session starts right after.",
            RunnerUpdating.runnerUpdatingPlain(RunnerUpdating.runnerUpdatingDescription(untitled, null)))
        assertEquals("The runner starts no new turns until 2 turns finish, then updates to 0.1.254. This message is sent right after.",
            RunnerUpdating.runnerUpdatingMessageText(gate, " "))
    }
}
