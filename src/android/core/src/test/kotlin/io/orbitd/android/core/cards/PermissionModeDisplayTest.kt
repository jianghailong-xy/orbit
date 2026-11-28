package io.orbitd.android.core.cards

import io.orbitd.android.core.cards.ModeCapsule.Gap
import io.orbitd.android.core.protocol.PermissionModeChange
import io.orbitd.android.core.protocol.PermissionModeRefusal
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

/**
 * The board's states (docs/mocks/permission-mode-actual; the owner picked A1, B1 and C1): the mode control shows the mode running
 * (①), a gap from the intent as "Default → Auto" with a spinner while the runner switches Claude back and as the running mode with
 * a dot where it stands (②, A1), the picker before a start keeps Auto on a model with none and says what it starts in (④, C1), and
 * the transcript says each change and who or what made it (③, B1).
 */
class PermissionModeDisplayTest {
    private val now = Instant.parse("2026-11-22T12:00:10.000Z")
    private fun change(from: String?, to: String, cause: String, client: String? = null, at: String = "2026-11-22T12:00:05.000Z") =
        PermissionModeChange(from, to, cause, client, at)
    private fun capsule(intent: String, actual: String?, latest: PermissionModeChange? = null, beforeStart: Boolean = false,
        reported: Boolean = true, noAutoModel: String? = null, runsAsRoot: Boolean = false, scheduled: Boolean = false, at: Instant = now) =
        PermissionModeDisplay.capsule(intent, actual, reported, beforeStart, latest, noAutoModel, runsAsRoot, scheduled, at)

    // ① The control is the mode running.

    @Test fun theModeRunningIsShownBareWhenItIsTheOneAskedFor() {
        assertEquals(ModeCapsule("Auto"), capsule("auto", "auto", change(null, "auto", "CLAIM")))
        assertEquals(ModeCapsule("Accept Edits"), capsule("acceptEdits", "acceptEdits"))
    }

    // ② A1: a gap the runner is closing, and one that stands.

    @Test fun claudeStartingBelowAutoReadsDefaultToAutoWhileTheRunnerSwitchesIt() {
        val shown = capsule("auto", "default", change("auto", "default", "ENGINE_REPORT"))
        assertEquals("Default → Auto", shown.label)
        assertEquals(Gap.CORRECTING, shown.gap)
        assertEquals("Running in Default.", shown.head?.lead)
        assertEquals("Claude started below the Auto you asked for; the runner is switching it to Auto now.", shown.head?.text)
        assertEquals("Default, switching to Auto", shown.spoken)
        // After a re-spawn the same.
        assertEquals(Gap.CORRECTING, capsule("auto", "default", change("auto", "default", "RESPAWN")).gap)
    }

    /** The runner switches Claude back at once (R1): a report a minute old was not acted on, and the gap stands. */
    @Test fun aReportTheRunnerDidNotActOnStandsAfterAMinute() {
        val report = change("auto", "default", "ENGINE_REPORT", at = "2026-11-22T12:00:00.000Z")
        assertEquals(Gap.CORRECTING, capsule("auto", "default", report, at = Instant.parse("2026-11-22T12:00:59.000Z")).gap)
        val stale = capsule("auto", "default", report, at = Instant.parse("2026-11-22T12:01:00.000Z"))
        assertEquals(ModeCapsule("Default", Gap.STANDING, ModeCapsule.Head("Running in Default.",
            "Claude started below the Auto you asked for. Pick Auto to switch it.")), stale)
        assertEquals(Instant.parse("2026-11-22T12:01:00.000Z"), PermissionModeDisplay.correctionEnds(report.at))
    }

    @Test fun aModelWithNoAutoIsAGapThatStandsAndSaysHowToGetAutoBack() {
        val shown = capsule("auto", "default", change("auto", "default", "OWNER_PICK", "android"), noAutoModel = "Haiku 4.5")
        assertEquals(ModeCapsule("Default", Gap.STANDING, ModeCapsule.Head("Running in Default.",
            "You asked for Auto, but Haiku 4.5 has no Auto. Pick a model with Auto to get it back.")), shown)
        // Never read as Claude being switched back: the runner has nothing to switch it to.
        assertEquals(Gap.STANDING, capsule("auto", "default", change("auto", "default", "ENGINE_REPORT"), noAutoModel = "Haiku 4.5").gap)
        assertEquals("Not on Haiku 4.5, runs as Default", PermissionModeDisplay.autoNote("Haiku 4.5", beforeStart = false))
    }

    @Test fun bypassOnARootRunnerSaysWhyItRunsInAuto() {
        val shown = capsule("bypassPermissions", "auto", change(null, "auto", "CLAIM"), runsAsRoot = true)
        assertEquals(ModeCapsule("Auto", Gap.STANDING, ModeCapsule.Head("Running in Auto.", "You asked for Bypass, which can’t run on a root runner.")), shown)
    }

    @Test fun anyOtherGapSaysWhatWasAskedAndWhatSetTheModeRunning() {
        assertEquals("You asked for Plan. Mode set to Default by Orbit.",
            capsule("plan", "default", change("plan", "default", "ORBIT_CHANGE", "orbit")).head?.text)
        assertEquals("You asked for Plan. Claude started in Default.",
            capsule("plan", "default", change("plan", "default", "ENGINE_REPORT")).head?.text)
        // A claim, or the runner, that put the engine in another mode than the one asked for since says nothing of why.
        assertEquals("You asked for Plan.", capsule("plan", "auto", change(null, "auto", "CLAIM")).head?.text)
        assertEquals("You asked for Plan.", capsule("plan", "auto", change("default", "auto", "RUNNER_CORRECTION")).head?.text)
        // The owner's own change on its way to the engine: what was asked is the whole story.
        assertEquals(ModeCapsule("Auto", Gap.STANDING, ModeCapsule.Head("Running in Auto.", "You asked for Plan.")),
            capsule("plan", "auto", change("default", "auto", "OWNER_PICK", "web")))
        assertEquals("You asked for Plan.", capsule("plan", "auto").head?.text)
    }

    /** A scheduled run on Claude Code runs in Auto whatever its session asked: the rule, said in the menu, not a gap. */
    @Test fun aScheduledRunInAutoIsNotAGap() {
        assertEquals(ModeCapsule("Auto", head = ModeCapsule.Head("Running in Auto.", "Scheduled runs always use Auto.")),
            capsule("default", "auto", change(null, "auto", "CLAIM"), scheduled = true))
        assertEquals(Gap.STANDING, capsule("plan", "default", change("auto", "default", "ORBIT_CHANGE", "orbit"), scheduled = true).gap)
    }

    @Test fun aLiveSessionWithNoModeRecordedSaysSoAndAnOlderServerShowsTheIntent() {
        assertEquals(ModeCapsule("Mode unconfirmed"), capsule("auto", null))
        assertEquals(ModeCapsule("Plan"), capsule("plan", null, reported = false))
    }

    // ④ C1: before the session starts.

    @Test fun beforeAStartAutoOnAModelWithItIsPlain() {
        assertEquals(ModeCapsule("Auto"), capsule("auto", null, beforeStart = true))
        // An ended session's next run starts in the pick, whatever its last one ran in.
        assertEquals(ModeCapsule("Plan"), capsule("plan", "default", change("auto", "default", "ENGINE_REPORT"), beforeStart = true))
    }

    @Test fun beforeAStartAutoOnAModelWithNoneShowsTheDefaultItStartsIn() {
        assertEquals(ModeCapsule("Default", Gap.STANDING, ModeCapsule.Head("Starts in Default.",
            "Haiku 4.5 has no Auto; your pick stays Auto and applies on a model that has it.")),
            capsule("auto", null, beforeStart = true, noAutoModel = "Haiku 4.5"))
        assertEquals("Not on Haiku 4.5, starts in Default", PermissionModeDisplay.autoNote("Haiku 4.5", beforeStart = true))
        // Only Auto is held back by the model.
        assertEquals(ModeCapsule("Plan"), capsule("plan", null, beforeStart = true, noAutoModel = "Haiku 4.5"))
    }

    // ③ B1: the transcript's line for each change.

    private fun lines(vararg changes: PermissionModeChange, intent: String = "auto", actual: String? = changes.lastOrNull()?.toMode,
        noAutoModel: String? = null, runsAsRoot: Boolean = false, scheduled: Boolean = false) =
        PermissionModeDisplay.lines(changes.toList(), intent, actual, noAutoModel, runsAsRoot, scheduled)

    @Test fun eachCauseSaysWhoOrWhatMadeTheChange() {
        val said = lines(
            change(null, "auto", "CLAIM", at = "2026-11-22T12:00:00.000Z"),
            change("auto", "plan", "OWNER_PICK", "web", at = "2026-11-22T12:00:01.000Z"),
            change("plan", "acceptEdits", "OWNER_PICK", "ios", at = "2026-11-22T12:00:02.000Z"),
            change("acceptEdits", "dontAsk", "OWNER_PICK", "macos", at = "2026-11-22T12:00:03.000Z"),
            change("dontAsk", "auto", "OWNER_PICK", "android", at = "2026-11-22T12:00:04.000Z"),
            change("auto", "plan", "OWNER_PICK", "terminal", at = "2026-11-22T12:00:05.000Z"),
            change("plan", "auto", "OWNER_PICK", at = "2026-11-22T12:00:06.000Z"),
            change("auto", "default", "ORBIT_CHANGE", "orbit", at = "2026-11-22T12:00:07.000Z"),
            change("default", "plan", "CLAIM", at = "2026-11-22T12:00:08.000Z"),
            change("plan", "auto", "RESPAWN", at = "2026-11-22T12:00:09.000Z"),
            change("auto", "default", "ENGINE_REPORT", at = "2026-11-22T12:00:10.000Z"),
            change(null, "auto", "RUNNER_CORRECTION", at = "2026-11-22T12:00:11.000Z"),
            change("auto", "plan", "SOMETHING_NEW", at = "2026-11-22T12:00:12.000Z"),
            intent = "plan")
        assertEquals(listOf(
            "Started in Auto",
            "Mode set to Plan by you, on the web",
            "Mode set to Accept Edits by you, on iOS",
            "Mode set to Don't Ask by you, on Mac",
            "Mode set to Auto by you, on Android",
            "Mode set to Plan by you, in the terminal",
            "Mode set to Auto by you",
            "Mode set to Default by Orbit",
            "Resumed in Plan",
            "Claude restarted in Auto",
            "Claude started in Default",
            "Mode set to Auto by the runner",
            "Mode changed to Plan",
        ), said.map { it.text })
        // The mode is the line's bold part.
        assertEquals(listOf("Auto", "Plan", "Accept Edits"), said.take(3).map { it.mode })
        assertEquals(said.size, said.map { it.key }.toSet().size)
    }

    /** As the board's ③ draws them: a correction says what Claude had started in, a claim's substitution says why, and the line still
     * short of what was asked is amber. */
    @Test fun theBoardsLinesForTheRunnerAClaimAndAModelWithNoAuto() {
        // Claude started in Default and the runner switched it back: one line, the correction's.
        val corrected = lines(change(null, "auto", "CLAIM", at = "2026-11-22T12:00:00.000Z"),
            change("auto", "default", "ENGINE_REPORT", at = "2026-11-22T12:00:01.000Z"),
            change("default", "auto", "RUNNER_CORRECTION", at = "2026-11-22T12:00:02.000Z"))
        assertEquals(listOf("Started in Auto", "Mode set back to Auto by the runner — Claude had started in Default"), corrected.map { it.text })
        assertTrue(corrected.none { it.gap })
        assertEquals("Mode set back to Auto by the runner — Claude had restarted in Default", lines(
            change("auto", "default", "RESPAWN", at = "2026-11-22T12:00:01.000Z"),
            change("default", "auto", "RUNNER_CORRECTION", at = "2026-11-22T12:00:02.000Z")).single().text)
        // Before the runner acts, Claude's report is the line, and the gap's.
        assertEquals(listOf(false, true), lines(change(null, "auto", "CLAIM", at = "2026-11-22T12:00:00.000Z"),
            change("auto", "default", "ENGINE_REPORT", at = "2026-11-22T12:00:01.000Z")).map { it.gap })

        val root = lines(change(null, "auto", "CLAIM"), intent = "bypassPermissions", runsAsRoot = true).single()
        assertEquals("Started in Auto, not Bypass — Bypass can’t run on a root runner", root.text)
        assertTrue(root.gap)

        val scheduled = lines(change(null, "auto", "CLAIM"), intent = "default", scheduled = true).single()
        assertEquals("Started in Auto — scheduled runs always use Auto", scheduled.text)
        assertFalse(scheduled.gap)

        val haiku = lines(change(null, "auto", "CLAIM", at = "2026-11-22T12:00:00.000Z"),
            change("auto", "default", "OWNER_PICK", "android", at = "2026-11-22T12:00:01.000Z"), noAutoModel = "Haiku 4.5")
        assertEquals(listOf("Started in Auto", "Mode now Default — you picked Haiku 4.5, which has no Auto"), haiku.map { it.text })
        assertEquals(listOf(false, true), haiku.map { it.gap })
        assertEquals("Started in Default, not Auto — Haiku 4.5 has no Auto",
            lines(change(null, "default", "CLAIM"), noAutoModel = "Haiku 4.5").single().text)
    }

    /** Only the line that set the mode running now can be the gap's: once a later change closes it, every line is plain. */
    @Test fun onlyTheNewestLineCanBeAmber() {
        val closed = lines(change(null, "default", "CLAIM", at = "2026-11-22T12:00:00.000Z"),
            change("default", "auto", "OWNER_PICK", "android", at = "2026-11-22T12:00:01.000Z"), noAutoModel = "Haiku 4.5")
        assertEquals(listOf("Started in Default", "Mode set to Auto by you, on Android"), closed.map { it.text })
        assertTrue(closed.none { it.gap })
        // A mode the server has moved past since (the detail's actual is newer than its last change) is no gap either.
        assertFalse(lines(change(null, "default", "CLAIM"), actual = "auto").single().gap)
    }

    @Test fun eachLineGoesAfterTheLastRowStampedAtOrBeforeIt() {
        val rows = listOf("2026-11-22T12:00:01.000Z", null, "2026-11-22T12:00:03.000Z")
        val (first, second, third, unread) = listOf("2026-11-22T12:00:00.000Z", "2026-11-22T12:00:02.000Z", "2026-11-22T12:00:03.000Z", "yesterday")
            .map { at -> ModeLine("k$at", at, "Mode set to ", "Auto", "", false) }
        val placed = PermissionModeDisplay.place(rows, listOf(first, second, third, unread))
        assertEquals(mapOf(-1 to listOf(first), 0 to listOf(second), 2 to listOf(third)), placed)
    }

    // A correction Claude refused (permission_mode_correction_failed): a gap that stands at once, in the CLI's words.

    private val words = "Cannot set permission mode to auto: auto mode unavailable for this model"
    private val report = change("auto", "default", "ENGINE_REPORT", at = "2026-11-22T12:00:05.000Z")
    private val refusal = PermissionModeRefusal(7, "2026-11-22T12:00:06.000Z", "default", "auto", words)

    @Test fun aRefusedCorrectionStandsAtOnceWithTheCliWordsAndNeverReadsAsSwitching() {
        val shown = PermissionModeDisplay.capsule("auto", "default", true, false, report, null, false, false, now, refusal)
        assertEquals(ModeCapsule("Default", Gap.STANDING, ModeCapsule.Head("Running in Default.",
            "You asked for Auto, but the runner couldn’t switch Claude to it: $words.")), shown)
        assertEquals("Default", shown.spoken)
    }

    @Test fun theNextChangeEndsTheRefusal() {
        val corrected = change("default", "auto", "RUNNER_CORRECTION", at = "2026-11-22T12:05:00.000Z")
        assertEquals(ModeCapsule("Auto"), PermissionModeDisplay.capsule("auto", "auto", true, false, corrected, null, false, false, now, refusal))
        // A re-spawn that comes back below Auto again is a new attempt, read as being switched back.
        val respawn = change("auto", "default", "RESPAWN", at = "2026-11-22T12:20:00.000Z")
        assertEquals(Gap.CORRECTING, PermissionModeDisplay.capsule("auto", "default", true, false, respawn, null, false, false,
            Instant.parse("2026-11-22T12:20:05.000Z"), refusal).gap)
    }

    @Test fun theTranscriptSaysTheRunnerCouldNotSwitchItAndWhy() {
        val said = PermissionModeDisplay.lines(listOf(change(null, "auto", "CLAIM", at = "2026-11-22T12:00:04.000Z"), report), "auto",
            "default", null, false, false, listOf(refusal))
        assertEquals(listOf("Started in Auto", "Claude started in Default",
            "Claude stays in Default — the runner couldn’t switch it to Auto: $words"), said.map { it.text })
        // The refusal is the gap's line now; the report it answers is said plainly.
        assertEquals(listOf(false, false, true), said.map { it.gap })
        assertEquals("2026-11-22T12:00:06.000Z", said.last().at)
        // History once the owner moved on: still said, no longer amber.
        val later = PermissionModeDisplay.lines(listOf(report, change("default", "plan", "OWNER_PICK", "android", at = "2026-11-22T12:09:00.000Z")),
            "plan", "plan", null, false, false, listOf(refusal))
        assertFalse(later.last().gap)
    }

    @Test fun theClaimLineIsWordedFromTheServersRequestedModeAndReason() {
        val root = PermissionModeChange(null, "auto", "CLAIM", null, "2026-11-22T12:00:00.000Z", requestedMode = "bypassPermissions", reason = "ROOT_RUNNER")
        // Said even where this client does not know the runner runs as root.
        assertEquals("Started in Auto, not Bypass — Bypass can’t run on a root runner",
            PermissionModeDisplay.lines(listOf(root), "bypassPermissions", "auto", null, false, false).single().text)
        val scheduled = PermissionModeChange("default", "auto", "CLAIM", null, "2026-11-22T12:00:00.000Z", requestedMode = "default", reason = "SCHEDULED_RUN")
        assertEquals("Resumed in Auto — scheduled runs always use Auto",
            PermissionModeDisplay.lines(listOf(scheduled), "default", "auto", null, false, true).single().text)
    }
}
