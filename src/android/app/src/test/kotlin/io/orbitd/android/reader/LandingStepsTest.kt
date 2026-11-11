package io.orbitd.android.reader

import java.io.File
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A landing's timeline as the chat's tool rows (owner 2026-11-11, docs/mocks/landings-chat-tools-native): the cases the web's
 *  `landingSteps.test.ts` and OrbitKit's `LandingStepsTests` hold, and the words looked up in the web file they were ported from. */
class LandingStepsTest {
    private var seq = 0

    private fun line(kind: String, text: String, phase: String? = null, check: String? = null, state: String? = null, exit: Int? = null): LandingEntry {
        seq += 1
        val data = when {
            state != null -> buildJsonObject { put("state", JsonPrimitive(state)) }
            exit != null -> buildJsonObject { put("exitCode", JsonPrimitive(exit)); put("expectedExitCode", JsonPrimitive(0)) }
            else -> null
        }
        return LandingEntry(kind, "2026-11-10T15:%02d:00.000Z".format(20 + seq), 1, 1, check, check?.let { 1 }, phase, null, text, data)
    }

    @Test fun landingVerdictsKeepBaselineAttributionSeparate() {
        listOf("Landing check passed · 14m", "Landing check failed · exit 1 · 14m",
            "Landing check skipped · only exempt paths changed").forEach { text ->
            listOf("also fails", "passes").forEach { verdict ->
                val task = line("CHECK_FINISHED", text, check = "LANDING_CHECK")
                val baseline = line("CHECK_FINISHED", "Checked the project branch with main, without this task · $verdict", check = "LANDING_CHECK")
                    .copy(data = buildJsonObject { put("scope", "BASELINE") })
                val rows = LandingSteps.steps(listOf(task, baseline), "LAND_TASK")
                assertEquals(listOf("check:LANDING_CHECK", "check:BASELINE"), rows.map { it.key })
                assertEquals(listOf(text, baseline.text), rows.map { it.summary.text })
                assertEquals("Landing check", rows.first().name)
            }
        }
    }

    @Test fun scopeRecoveryNeverAssignsNewestResultsToOtherAttemptsClaimsOrRounds() {
        val view = LandingSessionModel.read(kotlinx.serialization.json.Json.parseToJsonElement("""{
          "currentAttempt":{"jobId":"new","kind":"LAND_TASK","state":"CHECK_FAILED","claim":1,"round":1},
          "checks":[{"name":"LANDING_CHECK","scope":"BASELINE","exitCode":1,"expectedExitCode":0}]}
          """).let { it as kotlinx.serialization.json.JsonObject })
        val entry = line("CHECK_FINISHED", "Landing check failed · exit 1 · 14m", check = "LANDING_CHECK", exit = 1)
        val scoped = LandingSessionModel.scopedEntries(listOf(entry), view, "new")
        assertEquals("Checked the project branch with main, without this task · also fails", LandingSessionModel.timelineText(scoped.single()))
        assertEquals(listOf(entry), LandingSessionModel.scopedEntries(listOf(entry), view, "old"))
        assertEquals(listOf(entry.copy(claim = 2)), LandingSessionModel.scopedEntries(listOf(entry.copy(claim = 2)), view, "new"))
        assertEquals(listOf(entry.copy(round = 2)), LandingSessionModel.scopedEntries(listOf(entry.copy(round = 2)), view, "new"))
    }

    @Test fun aLandedTasksFifteenLinesAreFiveSteps() {
        // The owner's 2026-11-11 screenshot, line for line.
        val entries = listOf(
            line("ENQUEUED", "Task marked done · queued to land on project/p1"),
            line("CLAIMED", "Claimed by runner workstation-gpu · claim 1"),
            line("STEP", "Waiting for this runner's repository lock"),
            line("ROUND", "Round 1 of 3"),
            line("STEP", "Fetching the repository", phase = "FETCH"),
            line("STEP", "Syncing main into project/p1", phase = "MAIN_SYNC"),
            line("STEP", "Rebasing onto project/p1", phase = "REBASE"),
            line("STEP", "Running the checks", phase = "CHECK"),
            line("STEP", "Preparing the combined tree", phase = "MERGE"),
            line("CHECK_STARTED", "Merge check started · claim 1 · workstation-gpu", check = "MERGE_CHECK"),
            line("STEP", "Running the checks", phase = "CHECK"),
            line("STEP", "Reported starting the push to project/p1", phase = "PUSH"),
            line("STEP", "Verifying the merged tree", phase = "VERIFY"),
            line("CHECK_FINISHED", "Merge check passed · 0m 16s", check = "MERGE_CHECK", exit = 0),
            line("RESULT", "Landed on project/p1 · 9afb7d1", state = "LANDED"),
        )
        val steps = LandingSteps.steps(entries, "LAND_TASK")
        assertEquals(listOf("Queue", "Claim", "Sync", "Merge check", "Push"), steps.map { it.name })
        assertEquals(listOf(
            "Task marked done · queued to land on project/p1",
            "Claimed by runner workstation-gpu · claim 1",
            "Preparing the combined tree",
            "Merge check passed · 0m 16s",
            "Landed on project/p1 · 9afb7d1",
        ), steps.map { it.summary.text })
        assertEquals(listOf(1, 2, 5, 4, 3), steps.map { it.entries.size })
        // Every line is kept, each once.
        assertEquals(entries.indices.toList(), steps.flatMap { step -> step.entries.map { it.index } }.sorted())
        assertEquals(entries[14].at, steps[4].at)
        assertFalse(steps.any { LandingSteps.failed(it, "LAND_TASK") })
    }

    @Test fun aFailedChecksResultStaysInItsCheck() {
        val steps = LandingSteps.steps(listOf(
            line("ENQUEUED", "Task marked done"),
            line("CLAIMED", "Claimed by runner wikova · claim 1"),
            line("CHECK_STARTED", "Merge check started", check = "MERGE_CHECK"),
            line("CHECK_FINISHED", "Merge check failed · exit 1 after 3m 52s", check = "MERGE_CHECK", exit = 1),
            line("RESULT", "Check failed · nothing was pushed", state = "CHECK_FAILED"),
        ), "LAND_TASK")
        assertEquals(listOf("Queue", "Claim", "Merge check"), steps.map { it.name })
        assertEquals("Check failed · nothing was pushed", steps[2].summary.text)
        assertTrue(LandingSteps.failed(steps[2], "LAND_TASK"))
        assertFalse(LandingSteps.failed(steps[1], "LAND_TASK"))
    }

    @Test fun aMergeRoundsLastStepIsMergeAndACheckRoundsIsResult() {
        assertEquals(listOf("Result"), LandingSteps.steps(listOf(line("RESULT", "Ready to merge into main", state = "READY")), "CHECK_PROMOTION").map { it.name })
        assertEquals(listOf("Merge"), LandingSteps.steps(listOf(line("RESULT", "Merged into main · 8958893", state = "LANDED")), "LAND_PROMOTION").map { it.name })
    }

    @Test fun taskAcceptanceAndTheMergeCheckEachHaveAStep() {
        val steps = LandingSteps.steps(listOf(
            line("CHECK_STARTED", "Task acceptance started", check = "TASK_ACCEPTANCE"),
            line("CHECK_FINISHED", "Task acceptance passed · 1m 02s", check = "TASK_ACCEPTANCE", exit = 0),
            line("CHECK_STARTED", "Merge check started", check = "MERGE_CHECK"),
        ), "LAND_TASK")
        assertEquals(listOf("Task acceptance", "Merge check"), steps.map { it.name })
    }

    @Test fun checksDuration() {
        assertEquals(17_000, LandingSteps.checksDurationMs(listOf(16_000, null, 1_000)))
        assertNull(LandingSteps.checksDurationMs(listOf(null)))
        assertNull(LandingSteps.checksDurationMs(emptyList()))
    }

    /** The words, as the web writes them; the tool rows' status words, as the chat's own tool rows say them. */
    @Test fun theWordsAreTheWebs() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/web/src/lib").isDirectory }
        val steps = File(root, "src/web/src/lib/landingSteps.ts").readText()
        listOf("QUEUE" to LandingStepCopy.QUEUE, "CLAIM" to LandingStepCopy.CLAIM, "SYNC" to LandingStepCopy.SYNC,
            "PUSH" to LandingStepCopy.PUSH, "MERGE" to LandingStepCopy.MERGE, "RESULT" to LandingStepCopy.RESULT).forEach { (key, copy) ->
            assertTrue("landingSteps.ts no longer says $key: '$copy'", steps.contains("$key: '$copy',"))
        }
        val window = File(root, "src/web/src/components/ProjectLandingsWindow.tsx").readText()
        listOf("CHECK" to LandingStepCopy.CHECK, "DETAILS" to LandingStepCopy.DETAILS, "WORKING_FOR" to LandingStepCopy.WORKING_FOR).forEach { (key, copy) ->
            assertTrue("ProjectLandingsWindow.tsx no longer says $key: '$copy'", window.contains("$key: '$copy',"))
        }
        val chatRow = File(root, "src/android/app/src/main/kotlin/io/orbitd/android/reader/TranscriptRowView.kt").readText()
        listOf(LandingStepWords.COMPLETE, LandingStepWords.FAILED, LandingStepWords.RUNNING).forEach { word ->
            assertTrue("the chat's tool row no longer says \"$word\"", chatRow.contains("\"$word\""))
        }
    }
}
