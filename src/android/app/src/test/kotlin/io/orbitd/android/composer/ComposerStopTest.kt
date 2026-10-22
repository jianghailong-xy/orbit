package io.orbitd.android.composer

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * A07-20: whether the composer's Stop has something to stop (iOS 593920cea; OrbitKit Phase2LogicTests.testShowsInterrupt and
 * InterruptAndSendTests, web `showStop`): a turn running, one the engine started for itself while parked, a sub-agent or a background
 * process still at work under a parked turn — and nothing for an idle session, which keeps Send.
 */
class ComposerStopTest {
    private fun detail(json: String) = Json.parseToJsonElement(json).jsonObject
    private fun parked(more: String = "") = detail("""{"id":"s","status":"AWAITING_INPUT","runState":"AWAITING_INPUT"$more}""")

    @Test fun aRunningTurnHasSomethingToStop() {
        assertTrue(hasSomethingToStop(detail("""{"status":"RUNNING","runState":"RUNNING"}""")))
        // An older server's record, with no runState.
        assertTrue(hasSomethingToStop(detail("""{"status":"RUNNING"}""")))
    }

    /** AWAITING_INPUT with `engineTurnActive`: a turn the engine started for itself, which streams for its whole duration while the run
     * state stays parked — the runner interrupts it unconditionally. */
    @Test fun aTurnTheEngineStartedForItselfHasSomethingToStop() {
        assertTrue(hasSomethingToStop(parked(""","engineTurnActive":true""")))
        assertFalse(hasSomethingToStop(parked(""","engineTurnActive":false""")))
        // Only while parked: an ended session's leftover flag stops nothing.
        assertFalse(hasSomethingToStop(detail("""{"status":"CANCELLED","runState":"ENDED","engineTurnActive":true}""")))
    }

    /** A sub-agent or workflow still at work under a parked turn: the detail's ids, or a list row's count. */
    @Test fun aSubAgentStillAtWorkHasSomethingToStop() {
        assertTrue(hasSomethingToStop(parked(""","runningSubagents":["agent-1"]""")))
        assertTrue(hasSomethingToStop(parked(""","runningSubagentCount":1""")))
        assertFalse(hasSomethingToStop(parked(""","runningSubagents":[]""")))
    }

    /** A background process left running — a job, a dev server, a watcher: the detail's `runningBgShells`, or a list row's count. */
    @Test fun aBackgroundProcessStillRunningHasSomethingToStop() {
        assertTrue(hasSomethingToStop(parked(""","runningBgShells":["bg-1","bg-2"]""")))
        assertTrue(hasSomethingToStop(parked(""","runningBgCount":2""")))
        assertFalse(hasSomethingToStop(parked(""","runningBgShells":[],"runningBgCount":0""")))
    }

    /** Parked with nothing generating and nothing left running stays Send — and so does a turn that was stopped, a session that ended, and a
     * new session's draft, whose detail is its workspace. */
    @Test fun anIdleSessionHasNothingToStop() {
        assertFalse(hasSomethingToStop(parked()))
        assertFalse(hasSomethingToStop(parked(""","engineTurnActive":false,"runningSubagents":[],"runningBgShells":[]""")))
        assertFalse(hasSomethingToStop(detail("""{"status":"INTERRUPTED","runState":"INTERRUPTED"}""")))
        assertFalse(hasSomethingToStop(detail("""{"status":"SUCCEEDED","runState":"SUCCEEDED"}""")))
        assertFalse(hasSomethingToStop(detail("""{"id":"w","provider":"claude","runnerId":"r","enabled":true}""")))
        assertFalse(hasSomethingToStop(JsonObject(emptyMap())))
    }

    /** iOS f4e1b0efa (OrbitKit StopBackgroundWorkWiringTests): asking an interrupt to end the background work is the composer's Stop's
     * alone — ComposerModel.stop — and every other interrupt goes out bodyless (ComposerModelTest), killing nothing. */
    @Test fun onlyTheComposersStopAsksForTheBackgroundWorkToEnd() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.firstOrNull { File(it, "src/android/core").isDirectory }
        assertNotNull("the repository root was not found above the test's working directory", root)
        val askers = listOf("src/android/app/src/main", "src/android/core/src/main").flatMap { File(root, it).walk().filter { file ->
            file.extension == "kt" && file.readText().contains("stopBackgroundWork") }.map { file -> file.name } }
        assertEquals(listOf("ComposerModel.kt"), askers)
        val model = File(root, "src/android/app/src/main/kotlin/io/orbitd/android/composer/ComposerModel.kt").readLines()
        assertEquals(listOf("    fun stop() = control(\"interrupt\", body = buildJsonObject { put(\"stopBackgroundWork\", true) })"),
            model.filter { it.contains("stopBackgroundWork") })
    }
}
