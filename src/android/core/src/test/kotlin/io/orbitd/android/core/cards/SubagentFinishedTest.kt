package io.orbitd.android.core.cards

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Reading the block the control plane opens a turn with when a SubAgent ends — case for case with the web's `subagentFinished.test.ts`,
 * over the web's own fixtures (`subagentFinished.fixtures.ts`, the output of the apiserver's `buildSubagentFinishedBlock`), read from
 * that file rather than copied, so the two clients read the same blocks.
 */
class SubagentFinishedTest {
    companion object {
        private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/web/src/lib/subagentFinished.fixtures.ts").isFile }
        /** Each `export const NAME =\n  "…";` of the web fixtures, its JavaScript string read as the JSON string it also is. */
        val fixtures: Map<String, String> = Regex("export const (SUBAGENT_\\w+) =\\s*\\n\\s*(\"(?:[^\"\\\\]|\\\\.)*\");")
            .findAll(File(root, "src/web/src/lib/subagentFinished.fixtures.ts").readText())
            .associate { it.groupValues[1] to (Json.parseToJsonElement(it.groupValues[2]) as JsonPrimitive).content }
        val DONE get() = fixtures.getValue("SUBAGENT_DONE")
        val FAILED get() = fixtures.getValue("SUBAGENT_FAILED")
        val STOPPED get() = fixtures.getValue("SUBAGENT_STOPPED")
        val INTERRUPTED get() = fixtures.getValue("SUBAGENT_INTERRUPTED")
        val TWO get() = fixtures.getValue("SUBAGENT_TWO")
        val STEER get() = fixtures.getValue("SUBAGENT_STEER")
        val NODESC get() = fixtures.getValue("SUBAGENT_NODESC")

        /** The sentences the block closes on: the agent's, never shown outside "What the agent read". */
        val PROTOCOL = listOf("The control plane opened this turn for it", "It ended while you were working", "the user did not say it",
            "call delegate with resume", "review it before you commit")
    }

    private fun parse(note: String) = requireNotNull(SubagentFinished.parse(note)) { "the note reads as a SubAgent's end" }

    @Test fun theWebsFixturesAreAllHere() {
        assertEquals(setOf("SUBAGENT_DONE", "SUBAGENT_FAILED", "SUBAGENT_STOPPED", "SUBAGENT_INTERRUPTED", "SUBAGENT_TWO", "SUBAGENT_STEER",
            "SUBAGENT_NODESC"), fixtures.keys)
    }

    @Test fun readsARunThatFinishedWithItsWholeResultBackAtColumnZero() {
        val wake = parse(DONE)
        val run = wake.runs.single()
        assertEquals("34y5NxcqKYA179mC04VUB", run.runId)
        assertEquals("Deploy 6bb50a957 to production", run.description)
        assertEquals("DONE", run.status)
        assertNull(run.reason)
        assertTrue(run.result.startsWith("Stopped at step 1: the local lock `/tmp/orbit-upgrade.lock/pid`"))
        // The result's own blank line survives, and nothing of the block's indent does.
        assertTrue(run.result.contains("(not mine).\n\nThe remote check came back clean."))
        assertFalse(run.result.split("\n").any { it.startsWith(" ") })
        assertEquals(DONE, wake.text)
        assertEquals("", wake.rest)
    }

    @Test fun neverTakesTheSentencesTheBlockClosesOnIntoAResultOrAReason() {
        for (block in listOf(DONE, FAILED, STOPPED, INTERRUPTED, TWO, STEER)) for (run in parse(block).runs) for (sentence in PROTOCOL) {
            assertFalse(run.result.contains(sentence))
            assertFalse(run.reason.orEmpty().contains(sentence))
        }
    }

    @Test fun readsEachWayARunCanFailToFinishWithWhy() {
        parse(FAILED).runs.single().let {
            assertEquals("FAILED", it.status); assertEquals("It did not finish its work.", it.reason)
            assertEquals("vitest could not resolve `../quota/poller`; nothing written.", it.result)
        }
        parse(STOPPED).runs.single().let {
            assertEquals("STOPPED", it.status); assertEquals("It was stopped before it finished.", it.reason); assertEquals("", it.result)
        }
        parse(INTERRUPTED).runs.single().let {
            assertEquals("INTERRUPTED", it.status)
            assertTrue(it.reason!!.startsWith("The runner process hosting it stopped (a restart, an update or a crash)"))
            assertEquals("", it.result)
        }
    }

    @Test fun readsEveryRunOfABlockThatCarriesSeveral() {
        val wake = parse(TWO)
        assertEquals(listOf("Find every caller of pollQuota" to "DONE", "Write the poller spec" to "FAILED"), wake.runs.map { it.description to it.status })
        assertEquals("Three callers, all in `quota/`: poller.ts, account.ts, limits.ts.\n\nNothing else imports it.", wake.runs[0].result)
        assertEquals("It did not finish its work.", wake.runs[1].reason)
    }

    @Test fun readsTheBlockASteerDeliversAndARunNamedByTheStandInForNoDescription() {
        assertEquals("DONE", parse(STEER).runs.single().status)
        parse(NODESC).runs.single().let { assertEquals("without a description", it.description); assertEquals("ok", it.result) }
    }

    @Test fun keepsTheRestOfTheNoteAndLeavesABackgroundJobsBlockBesideItToItsOwnReader() {
        val job = listOf(
            "<background-job-wake>",
            "  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:",
            "    bgj_13c53745a88a｜job｜make test｜unit tests",
            "      ended｜completed｜exit code 0",
            "      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–10",
            "      (no output)",
            "  The control plane recorded this for you; the user did not say it.",
            "</background-job-wake>").joinToString("\n")
        val wake = parse("$DONE\n\n$job")
        assertEquals(1, wake.runs.size)
        assertEquals(job, wake.rest)
        assertEquals("bgj_13c53745a88a", BackgroundWakeCard.jobs(backgroundWake(wake.rest)!!).first().text("id"))
        val nudge = "You were interrupted; carry on from where you were."
        assertEquals(nudge, parse("$nudge\n\n$DONE").rest)
    }

    @Test fun readsAWordingItDoesNotKnowAsNothingAtAll() {
        assertNull(SubagentFinished.parse(null))
        assertNull(SubagentFinished.parse(""))
        assertNull(SubagentFinished.parse("Please deploy it"))
        assertNull(SubagentFinished.parse(DONE.replace("finished: DONE", "finished: CANCELLED")))
        assertNull(SubagentFinished.parse(DONE.replace("SubAgent Deploy", "Sub-agent Deploy")))
        assertNull(SubagentFinished.parse(DONE.replace("  Result:\n", "")))
        assertNull(SubagentFinished.parse("<orbit-subagent-finished>\n  The control plane opened this turn for it.\n</orbit-subagent-finished>"))
        assertNull(SubagentFinished.parse(DONE.replace("</orbit-subagent-finished>", "")))
        // One run of two it cannot read takes the whole block with it, rather than a line that drops a run.
        assertNull(SubagentFinished.parse(TWO.replace("finished: FAILED", "finished: LOST")))
    }

    // Its turn is Orbit's — a card of its own, so never the reader's bubble or the From Orbit line — but it draws nothing and so folds
    // under no line: the agent's answer reads on (web `orbitTurnOf`). A wakeup written beside it folds as its own.
    @Test fun itIsACardOfItsOwnThatFoldsNoTurnButAJobsNewsBesideIt() {
        val event = io.orbitd.android.core.realtime.RunEvent("user", 9, kotlinx.serialization.json.buildJsonObject {
            put("text", JsonPrimitive(DONE)); put("controlPlaneNote", JsonPrimitive(DONE)) }, "turn-wake")
        assertEquals(listOf("record:9:subagent"), transcriptCards(event).map { it.key })
        for (block in listOf(DONE, INTERRUPTED, STOPPED, TWO)) {
            assertNull(OrbitExchangeFold.turnOf(event.copy(payload = kotlinx.serialization.json.buildJsonObject {
                put("controlPlaneNote", JsonPrimitive(block)) })))
        }
        val job = "<background-job-wake>\n  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:\n" +
            "    bgj_13c53745a88a｜job｜make test｜unit tests\n      ended｜completed｜exit code 0\n" +
            "      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–10\n      (no output)\n" +
            "  The control plane recorded this for you; the user did not say it.\n</background-job-wake>"
        val both = event.copy(payload = kotlinx.serialization.json.buildJsonObject { put("controlPlaneNote", JsonPrimitive("$DONE\n\n$job")) })
        assertEquals(listOf("record:9:subagent", "record:9:wake"), transcriptCards(both).map { it.key })
        // A job's news draws nothing either (board C1, its Job card says it): only a wakeup coming due beside the end folds.
        assertNull(OrbitExchangeFold.turnOf(both))
        val wakeup = "<scheduled-wakeup>\n  The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:\n" +
            "    2026-09-15T18:00:00.000Z scheduled 600 seconds out, due 2026-09-15T18:10:00.000Z\n    reason: waiting for CI run 4242\n" +
            "  The control plane recorded this for you; the user did not say it.\n</scheduled-wakeup>"
        val withWakeup = event.copy(payload = kotlinx.serialization.json.buildJsonObject { put("controlPlaneNote", JsonPrimitive("$DONE\n\n$job\n\n$wakeup")) })
        assertEquals("job", OrbitExchangeFold.turnOf(withWakeup)?.category)
        assertEquals("Scheduled wakeup: waiting for CI run 4242", OrbitExchangeFold.turnOf(withWakeup)?.what)
    }
}
