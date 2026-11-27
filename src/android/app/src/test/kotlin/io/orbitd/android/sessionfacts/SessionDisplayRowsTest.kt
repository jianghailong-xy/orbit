package io.orbitd.android.sessionfacts

import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.SessionDisplay
import io.orbitd.android.directory.SessionDisplayState
import io.orbitd.android.directory.SessionMark
import io.orbitd.android.directory.SessionRowIcon
import io.orbitd.android.directory.SessionHeader
import io.orbitd.android.directory.SessionLine
import io.orbitd.android.directory.displayFacts
import io.orbitd.android.directory.isWorkingForList
import io.orbitd.android.directory.needsOwner
import io.orbitd.android.tasks.TaskDetailLogic
import io.orbitd.android.tasks.TaskMarkdown
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The approved board on Android (docs/mocks/session-display-three-states, capture/rules.mjs without its Disconnected mark), one named test
 * per row of the comparison rig's table (scripts/acceptance/session-three-state-check/fixture.json: session payloads as the server sends
 * them, each case once with the six facts and once without).
 *
 * Facts present: the state icon and word are `phase` alone ([SessionDisplay.state]), the marks are the facts ([SessionDisplay.marks]), and
 * every Android surface on the board says them: the list row's value (TalkBack), the task run label and the copied task Markdown's Runs
 * line. Needs you / Working is the list's own rule (contracts/session-list-order.fixtures.json): phase RUNNING is Working. Facts absent (an older server): both functions answer null
 * and each surface says what it said before this change (legacy-baseline.android.json, recorded before it).
 */
class SessionDisplayRowsTest {
    private val dir = File("../../../scripts/acceptance/session-three-state-check")
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
    private val now = Instant.parse("2026-11-23T10:00:00Z")

    /** The rig's rows, numbered from 1. The server's list row sends `engineTurnActive` for a parked session whose engine started its own
     * turn (sessions.service.ts, the list projection); the rig left it out and the board's fixture adds it to row 27 (and 28). Row 28 keeps
     * the rig's payload here: legacy-baseline.android.json was recorded on it, and it is the facts-absent drawing that must not move. */
    private val rows: List<JsonObject> = Json.parseToJsonElement(File(dir, "fixture.json").readText()).jsonArray.mapIndexed { i, r ->
        val p = r.jsonObject["payload"]!!.jsonObject
        if (i + 1 == 27) JsonObject(p + ("engineTurnActive" to JsonPrimitive(true))) else p
    }
    private val baseline = Json.parseToJsonElement(File(dir, "legacy-baseline.android.json").readText()).jsonObject["rows"]!!.jsonArray
        .map { it.jsonObject }

    private fun payload(row: Int) = rows[row - 1]
    private fun session(row: Int) = json.decodeFromJsonElement(DirectorySession.serializer(), payload(row))
    private fun group(s: DirectorySession) = if (s.needsOwner()) "Needs you" else if (s.isWorkingForList()) "Working" else "-"
    private fun rowValue(s: DirectorySession) = SessionDisplay.text(s.displayFacts, ", ") ?: SessionHeader.statusWord(s, now = now)
    private fun markdownRun(p: JsonObject): String {
        val task = buildJsonObject {
            put("title", "T"); put("status", "IN_PROGRESS")
            put("sessions", buildJsonArray { add(JsonObject(p + ("agent" to buildJsonObject { put("name", "orbit-ws01") }))) })
        }
        return TaskMarkdown.task(task, "https://orbit/t") { "Nov 24" }.lines().first { it.startsWith("- ") && it.endsWith("orbit-ws01") }
    }

    /** A row with the facts: the board's after column. */
    private fun withFacts(row: Int, state: SessionDisplayState, marks: List<String>, group: String, icons: List<SessionRowIcon> = listOf()) {
        val p = payload(row)
        assertEquals("row $row must carry the facts", true, p["released"] is JsonPrimitive && p["phase"] is JsonPrimitive)
        val s = session(row)
        assertEquals("row $row state", state, SessionDisplay.state(s.displayFacts))
        assertEquals("row $row marks", marks, SessionDisplay.marks(s.displayFacts)!!.map { it.word })
        assertEquals("row $row title-line icons", icons, SessionDisplay.rowIcons(s.displayFacts))
        // The same two functions read the task's session ref, which carries the same facts.
        assertEquals("row $row task ref state", state, SessionDisplay.state(SessionDisplay.facts(p)))
        assertEquals("row $row task ref marks", marks, SessionDisplay.marks(SessionDisplay.facts(p))!!.map { it.word })
        val words = listOf(state.word) + marks
        assertEquals("row $row list row value", words.joinToString(", "), rowValue(s))
        assertEquals("row $row header word", state.word, SessionHeader.statusWord(s, now = now))
        assertEquals("row $row task run label", words.joinToString(" · "), TaskDetailLogic.runLabel(p))
        assertEquals("row $row Markdown runs line", "- ${words.joinToString(" · ")} · Nov 24 · orbit-ws01", markdownRun(p))
        assertEquals("row $row group", group, group(s))
    }

    /** A row without the facts: nothing from the two functions, and today's words and group on every surface. */
    private fun withoutFacts(row: Int) {
        val p = payload(row)
        assertNull("row $row must not carry the facts", p["phase"]?.takeIf { it !is JsonNull })
        val s = session(row)
        val before = baseline[row / 2 - 1]
        assertEquals(before["name"]!!.jsonPrimitive.content, (Json.parseToJsonElement(File(dir, "fixture.json").readText()).jsonArray[row - 1]
            .jsonObject["name"]!!.jsonPrimitive.content))
        assertNull("row $row state", SessionDisplay.state(s.displayFacts))
        assertNull("row $row marks", SessionDisplay.marks(s.displayFacts))
        assertEquals("row $row title-line icons", listOf<SessionRowIcon>(), SessionDisplay.rowIcons(s.displayFacts))
        assertNull("row $row task ref state", SessionDisplay.state(SessionDisplay.facts(p)))
        assertNull("row $row task ref marks", SessionDisplay.marks(SessionDisplay.facts(p)))
        assertEquals("row $row list row value", before["word"]!!.jsonPrimitive.content, rowValue(s))
        assertEquals("row $row task run label", before["runBadge"]!!.jsonPrimitive.content, TaskDetailLogic.runLabel(p))
        assertEquals("row $row Markdown runs line", "- ${before["runBadge"]!!.jsonPrimitive.content} · Nov 24 · orbit-ws01", markdownRun(p))
        val beforeGroup = if (before["needsYouGroup"]!!.jsonPrimitive.boolean) "Needs you" else if (before["workingGroup"]!!.jsonPrimitive.boolean) "Working" else "-"
        assertEquals("row $row group", beforeGroup, group(s))
    }

    private val Q = SessionDisplayState.QUEUED
    private val R = SessionDisplayState.RUNNING
    private val I = SessionDisplayState.IDLE

    @Test fun row01_queued_withFacts_isQueuedWithNoMark() = withFacts(1, Q, listOf(), "Working")
    @Test fun row02_queued_withoutFacts_drawsToday() = withoutFacts(2)
    @Test fun row03_running_withFacts_isRunningWithNoMark() = withFacts(3, R, listOf(), "Working")
    @Test fun row04_running_withoutFacts_drawsToday() = withoutFacts(4)
    @Test fun row05_heldIdle_withFacts_isIdleWithNoMark() = withFacts(5, I, listOf(), "-")
    @Test fun row06_heldIdle_withoutFacts_drawsToday() = withoutFacts(6)
    @Test fun row07_stoppedTurn_withFacts_isIdleWithNoMark() = withFacts(7, I, listOf(), "-")
    @Test fun row08_stoppedTurn_withoutFacts_drawsToday() = withoutFacts(8)
    @Test fun row09_taskRunFinished_withFacts_isIdleWithNoMark() = withFacts(9, I, listOf(), "-")
    @Test fun row10_taskRunFinished_withoutFacts_drawsToday() = withoutFacts(10)
    @Test fun row11_releasedByAFailedTurn_withFacts_isIdleFailedInNeedsYou() = withFacts(11, I, listOf("Failed"), "Needs you", listOf(SessionRowIcon.FAILED))
    @Test fun row12_releasedByAFailedTurn_withoutFacts_drawsToday() = withoutFacts(12)
    @Test fun row13_releasedByEnd_withFacts_isIdleWithNoMark() = withFacts(13, I, listOf(), "-")
    @Test fun row14_releasedByEnd_withoutFacts_drawsToday() = withoutFacts(14)
    @Test fun row15_aJobWithNoTurn_withFacts_isRunningWithTheBackgroundIconInWorking() =
        withFacts(15, R, listOf(), "Working", listOf(SessionRowIcon.BACKGROUND))
    @Test fun row16_aJobWithNoTurn_withoutFacts_drawsToday() = withoutFacts(16)
    @Test fun row17_waitingOnAnApproval_withFacts_isRunningNeedsYou() = withFacts(17, R, listOf("Needs you"), "Needs you")
    @Test fun row18_waitingOnAnApproval_withoutFacts_drawsToday() = withoutFacts(18)
    @Test fun row19_onHold_withFacts_isQueuedOnHold() = withFacts(19, Q, listOf("On hold"), "Working", listOf(SessionRowIcon.ON_HOLD))
    @Test fun row20_onHold_withoutFacts_drawsToday() = withoutFacts(20)
    @Test fun row21_endRunnerNeverConfirmed_withFacts_isIdleWithNoMark() = withFacts(21, I, listOf(), "-")
    @Test fun row22_endRunnerNeverConfirmed_withoutFacts_drawsToday() = withoutFacts(22)
    @Test fun row23_oldPlainSucceeded_withFacts_isIdleWithNoMark() = withFacts(23, I, listOf(), "-")
    @Test fun row24_oldPlainSucceeded_withoutFacts_drawsToday() = withoutFacts(24)
    @Test fun row25_endingAfterAnInterruptedTurn_withFacts_isIdleWithNoMark() = withFacts(25, I, listOf(), "-")
    @Test fun row26_endingAfterAnInterruptedTurn_withoutFacts_drawsToday() = withoutFacts(26)
    @Test fun row27_engineStartedItsOwnTurn_withFacts_isRunningWithNoMarkInWorking() = withFacts(27, R, listOf(), "Working")
    @Test fun row28_engineStartedItsOwnTurn_withoutFacts_drawsToday() = withoutFacts(28)
    @Test fun row29_subAgentRunning_withFacts_isRunningWithNoMarkInWorking() = withFacts(29, R, listOf(), "Working")
    @Test fun row30_subAgentRunning_withoutFacts_drawsToday() = withoutFacts(30)
    @Test fun row31_willWake_withFacts_isIdleWithTheWillResumeIcon() = withFacts(31, I, listOf(), "-", listOf(SessionRowIcon.WILL_RESUME))
    @Test fun row32_willWake_withoutFacts_drawsToday() = withoutFacts(32)
    @Test fun row33_unknownStatusHeld_withFacts_isIdleWithNoMark() = withFacts(33, I, listOf(), "-")
    @Test fun row34_unknownStatusHeld_withoutFacts_drawsToday() = withoutFacts(34)
    @Test fun row35_unknownStatusReleased_withFacts_isIdleWithNoMark() = withFacts(35, I, listOf(), "-")
    @Test fun row36_unknownStatusReleased_withoutFacts_drawsToday() = withoutFacts(36)

    /** Beyond the table: the marks the fixture has no row for, each from its one fact (rules.mjs). */
    @Test fun aReleasedFailureTheServerWillRetryIsRetryingNotFailed() {
        val f = SessionDisplay.Facts("IDLE", true, "FAILED", waitingOn = "WAKE")
        assertEquals(listOf("Retrying"), SessionDisplay.marks(f)!!.map { it.word })
        // A list row draws it as its title-line icon, not a chip.
        assertEquals(listOf(SessionRowIcon.RETRYING), SessionDisplay.rowIcons(f))
        assertEquals(listOf<SessionMark>(), SessionDisplay.rowMarks(f))
    }
    @Test fun aReleasedFailureWhoseRunnerWentOfflineIsFailedLikeAnyOther() {
        // The owner's approval of 2026-11-25 dropped Disconnected: the error text is never read.
        val s = json.decodeFromJsonElement(DirectorySession.serializer(), JsonObject(payload(11) + ("error" to JsonPrimitive("Runner went offline"))))
        assertEquals(listOf("Failed"), SessionDisplay.marks(s.displayFacts)!!.map { it.word })
        assertEquals("Needs you", group(s))
    }
    @Test fun aParkedSessionWithAProcessLeftUpHasTheBackgroundIcon() {
        val held = SessionDisplay.Facts("IDLE", false, "ANSWERED", runningBgCount = 2)
        assertEquals(listOf<String>(), SessionDisplay.marks(held)!!.map { it.word })
        assertEquals(listOf(SessionRowIcon.BACKGROUND), SessionDisplay.rowIcons(held))
        assertEquals(listOf<SessionRowIcon>(), SessionDisplay.rowIcons(SessionDisplay.Facts("IDLE", true, "ANSWERED", workFinished = true, runningBgCount = 2)))
        assertEquals(listOf(SessionRowIcon.BACKGROUND, SessionRowIcon.WILL_RESUME),
            SessionDisplay.rowIcons(SessionDisplay.Facts("IDLE", false, "ANSWERED", waitingOn = "WAKE", runningBgCount = 1)))
    }
    @Test fun aPhaseThisBuildDoesNotKnowOrNoReleasedIsAnOlderServer() {
        assertNull(SessionDisplay.state(SessionDisplay.Facts("SLEEPING", false)))
        assertNull(SessionDisplay.marks(SessionDisplay.Facts("IDLE", null)))
        assertNull(SessionDisplay.text(SessionDisplay.Facts(null, true)))
    }
    @Test fun theRowLineFallsBackOnTheStateWordWithTheFacts() {
        // With nothing to preview, the row's second line says the state word, as web's sessionLine falls back on statusLabel.
        val bare = session(9).copy(lastAssistantText = null, lastUserText = null, recapText = null)
        assertEquals("Idle", SessionLine.make(bare, live = true, now = now).text)
    }
}
