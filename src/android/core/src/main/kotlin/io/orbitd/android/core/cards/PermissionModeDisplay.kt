package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.PermissionModeChange
import io.orbitd.android.core.protocol.PermissionModeRefusal
import io.orbitd.android.core.protocol.PermissionModes
import io.orbitd.android.core.protocol.PermissionModes.AUTO
import io.orbitd.android.core.protocol.PermissionModes.BYPASS
import io.orbitd.android.core.protocol.PermissionModes.DEFAULT
import java.time.Duration
import java.time.Instant

/**
 * What the composer's mode control says (board docs/mocks/permission-mode-actual, the owner's picks A1 and C1): the mode the
 * session's engine runs in, never the one asked for adjusted by a guess. Where the two differ, [gap] says how — the runner switching
 * a Claude engine back up to Auto, written "Default → Auto" beside a spinner, or a gap that stands, the running mode beside an amber
 * dot. [head] is what the mode menu opens on: why, in a sentence.
 */
data class ModeCapsule(val label: String, val gap: Gap? = null, val head: Head? = null) {
    enum class Gap { CORRECTING, STANDING }

    /** [lead] in bold, then [text]. */
    data class Head(val lead: String, val text: String) {
        val sentence: String get() = "$lead $text"
    }

    /** The label read aloud: an arrow is not a word. */
    val spoken: String get() = label.replace(" → ", ", switching to ")
}

/**
 * One mode change as the transcript says it (board B1): [before], the mode in bold, [after] — what the mode became and who or what
 * made it. [gap]: the change set the mode the session runs in now, and that is not the one asked for; it is drawn amber.
 */
data class ModeLine(val key: String, val at: String, val before: String, val mode: String, val after: String, val gap: Boolean) {
    val text: String get() = before + mode + after
}

object PermissionModeDisplay {
    /** How long a Claude engine that started below the Auto asked for is shown as being switched back. The runner does it at once
     * (owner ruling R1); a report older than this was not acted on, and the gap stands. */
    val CORRECTION_WINDOW: Duration = Duration.ofSeconds(60)

    /** A live session whose server records the mode running but has recorded none yet. */
    const val UNCONFIRMED = "Mode unconfirmed"

    private val BELOW_AUTO = setOf("default", "acceptEdits", "plan")
    private val ENGINE_CAUSES = setOf("ENGINE_REPORT", "RESPAWN")
    /** The changes whose line says why the mode running is not the one asked for: Orbit's own, and the engine's word. The owner's
     * change or a claim that reached the engine with another mode says nothing of why — the intent moved since, or a rule above did. */
    private val SAYS_WHY = setOf("ORBIT_CHANGE", "ENGINE_REPORT", "RESPAWN")

    /**
     * The control for a session asked to run in [intent].
     *
     * [beforeStart]: a draft, a session no claim has taken yet, or one whose run has ended — what its next run starts in is the
     * question, so the intent is shown; on a Claude Code model with no Auto ([noAutoModel], the model's name) the Default it starts
     * in, the pick staying Auto (C1). Otherwise the mode [actual] the server recorded, with any gap from [intent] explained by the
     * newest change, [latest]. [reported] false is a server that records no running mode, whose intent is all there is to show.
     * A scheduled run on Claude Code ([scheduledOnClaude]) runs in Auto whatever was asked: that is the rule, not a gap.
     * [refusal], the newest correction Claude refused among the events loaded: while it answers [latest], the gap stands at once,
     * with the CLI's own words, and nothing is "switching".
     */
    fun capsule(intent: String, actual: String?, reported: Boolean, beforeStart: Boolean, latest: PermissionModeChange?,
        noAutoModel: String?, runsAsRoot: Boolean, scheduledOnClaude: Boolean, now: Instant,
        refusal: PermissionModeRefusal? = null): ModeCapsule {
        val asked = PermissionModes.label(intent)
        if (beforeStart) {
            if (intent == AUTO && noAutoModel != null) return ModeCapsule(PermissionModes.label(DEFAULT), ModeCapsule.Gap.STANDING,
                ModeCapsule.Head("Starts in Default.", "$noAutoModel has no Auto; your pick stays Auto and applies on a model that has it."))
            return ModeCapsule(asked)
        }
        if (!reported) return ModeCapsule(asked)
        actual ?: return ModeCapsule(UNCONFIRMED)
        val running = PermissionModes.label(actual)
        if (actual == intent) return ModeCapsule(running)
        val lead = "Running in $running."
        if (scheduledOnClaude && actual == AUTO) return ModeCapsule(running, head = ModeCapsule.Head(lead, "Scheduled runs always use Auto."))
        if (refusal != null && refusalStands(refusal, latest, actual)) return ModeCapsule(running, ModeCapsule.Gap.STANDING,
            ModeCapsule.Head(lead, refusalWhy(refusal)))
        val engineSaid = intent == AUTO && actual in BELOW_AUTO && noAutoModel == null && latest != null && latest.toMode == actual &&
            latest.cause in ENGINE_CAUSES
        if (engineSaid && correctingAt(latest!!.at, now)) return ModeCapsule("$running → $asked", ModeCapsule.Gap.CORRECTING,
            ModeCapsule.Head(lead, "Claude started below the Auto you asked for; the runner is switching it to Auto now."))
        val why = when {
            intent == AUTO && actual == DEFAULT && noAutoModel != null ->
                "You asked for Auto, but $noAutoModel has no Auto. Pick a model with Auto to get it back."
            intent == BYPASS && runsAsRoot -> "You asked for Bypass, which can’t run on a root runner."
            engineSaid -> "Claude started below the Auto you asked for. Pick Auto to switch it."
            else -> "You asked for $asked." +
                (latest?.takeIf { it.toMode == actual && it.cause in SAYS_WHY }?.let { " ${line(it, null, null, null, false, false).text}." } ?: "")
        }
        return ModeCapsule(running, ModeCapsule.Gap.STANDING, ModeCapsule.Head(lead, why))
    }

    /** How far the runner's clock may run behind the server's: the refusal is stamped by the runner, the report it answers by the
     * server when it took the batch. */
    private val REFUSAL_CLOCK_SLACK: Duration = Duration.ofSeconds(60)

    /** Whether [refusal] answers the change the engine runs under now: Claude's report of the mode it settled on (or came back from a
     * re-spawn in), which the runner then failed to correct. Any later change — a correction that took, the owner's pick — ends it. */
    fun refusalStands(refusal: PermissionModeRefusal?, latest: PermissionModeChange?, actual: String?): Boolean {
        if (refusal == null || latest == null || actual == null) return false
        if (latest.cause !in ENGINE_CAUSES || latest.toMode != actual || refusal.mode != actual) return false
        val refusedAt = parse(refusal.at) ?: return true
        val reportedAt = parse(latest.at) ?: return true
        return !refusedAt.isBefore(reportedAt.minus(REFUSAL_CLOCK_SLACK))
    }

    /** The refusal that is the gap now, if one is: the newest of [loaded] (the events loaded) when it stands, so its transcript line is
     * the gap's; else the detail's [carried], which stands whether or not its event is loaded (paged out of a long session). */
    fun standingRefusal(loaded: List<PermissionModeRefusal>, carried: PermissionModeRefusal?, latest: PermissionModeChange?,
        actual: String?): PermissionModeRefusal? =
        loaded.lastOrNull()?.takeIf { refusalStands(it, latest, actual) } ?: carried?.takeIf { refusalStands(it, latest, actual) }

    /** The index of the change [refusal] answers: the newest report of the mode it stays in, from before it. */
    private fun answered(changes: List<PermissionModeChange>, refusal: PermissionModeRefusal): Int? {
        val refusedAt = parse(refusal.at)
        return changes.indices.lastOrNull { i ->
            val change = changes[i]
            change.cause in ENGINE_CAUSES && change.toMode == refusal.mode &&
                (refusedAt == null || parse(change.at)?.isAfter(refusedAt.plus(REFUSAL_CLOCK_SLACK)) != true)
        }
    }

    private fun refusalWhy(refusal: PermissionModeRefusal): String {
        val asked = PermissionModes.label(refusal.requested)
        val words = refusal.reason.takeIf { it.isNotEmpty() }?.let { if (it.endsWith(".")) ": $it" else ": $it." } ?: "."
        return "You asked for $asked, but the runner couldn’t switch Claude to it$words"
    }

    /** When a Claude report recorded at [at] stops reading as being switched back, and the control is drawn again as a gap that stands. */
    fun correctionEnds(at: String): Instant? = parse(at)?.plus(CORRECTION_WINDOW)

    /** What the Auto row of the mode menu says under its name on a model with no Auto (C1): the pick stays, and what it runs as. */
    fun autoNote(noAutoModel: String, beforeStart: Boolean): String =
        if (beforeStart) "Not on $noAutoModel, starts in Default" else "Not on $noAutoModel, runs as Default"

    /**
     * The transcript's lines for [changes], oldest first: each says what the mode became and who or what made it. A Claude report the
     * runner then corrected is said once, by the correction ("Mode set back to Auto by the runner — Claude had started in Default").
     * The newest, when the mode it set is still the one running and is not [intent], is the gap's: amber, saying why where that is
     * known — [noAutoModel] (the model's name when it has no Auto), a root runner. Each correction Claude refused ([refusals]) has a
     * line of its own, saying the runner could not switch it and why; while the newest still stands it is the gap's line.
     */
    fun lines(changes: List<PermissionModeChange>, intent: String?, actual: String?, noAutoModel: String?, runsAsRoot: Boolean,
        scheduledOnClaude: Boolean, refusals: List<PermissionModeRefusal> = emptyList()): List<ModeLine> {
        val gapOpen = intent != null && actual != null && actual != intent
        val standing = refusals.lastOrNull()?.takeIf { gapOpen && refusalStands(it, changes.lastOrNull(), actual) }
        // The report a refusal answers is placed with it: the server stamps a change when it took the runner's batch, after the
        // runner's own stamp on the refusal, so by time alone the report would land below its answer.
        val answeredAt = refusals.mapNotNull { r -> answered(changes, r)?.let { it to r.at } }.toMap()
        val changed = changes.mapIndexedNotNull { i, change ->
            val next = changes.getOrNull(i + 1)
            if (change.cause in ENGINE_CAUSES && next?.cause == "RUNNER_CORRECTION" && next.fromMode == change.toMode) return@mapIndexedNotNull null
            val gap = standing == null && next == null && gapOpen && change.toMode == actual && !(scheduledOnClaude && actual == AUTO)
            val shown = line(change, changes.getOrNull(i - 1), intent?.takeIf { gap }, noAutoModel, runsAsRoot, scheduledOnClaude)
            answeredAt[i]?.let { shown.copy(at = it) } ?: shown
        }
        return changed + refusals.map { refusal ->
            val asked = PermissionModes.label(refusal.requested)
            ModeLine(refusal.key, refusal.at, "Claude stays in ", PermissionModes.label(refusal.mode),
                " — the runner couldn’t switch it to $asked" + (refusal.reason.takeIf { it.isNotEmpty() }?.let { ": $it" } ?: ""),
                refusal == standing)
        }
    }

    /** [gapFrom]: the intent the line's mode falls short of, when it is the gap's line. */
    private fun line(change: PermissionModeChange, previous: PermissionModeChange?, gapFrom: String?, noAutoModel: String?,
        runsAsRoot: Boolean, scheduledOnClaude: Boolean): ModeLine {
        val noAuto = gapFrom == AUTO && change.toMode == DEFAULT && noAutoModel != null
        val (before, after) = when (change.cause) {
            "CLAIM" -> (if (change.fromMode == null) "Started in " else "Resumed in ") to when {
                // The server's own word on why the claim handed another mode than the one asked for.
                change.reason == "SCHEDULED_RUN" -> " — scheduled runs always use Auto"
                change.reason == "ROOT_RUNNER" -> PermissionModes.label(change.requestedMode ?: BYPASS).let { asked ->
                    ", not $asked — $asked can’t run on a root runner"
                }
                gapFrom == BYPASS && runsAsRoot -> ", not Bypass — Bypass can’t run on a root runner"
                noAuto -> ", not Auto — $noAutoModel has no Auto"
                scheduledOnClaude && change.toMode == AUTO -> " — scheduled runs always use Auto"
                else -> ""
            }
            "OWNER_PICK" -> if (noAuto) "Mode now " to " — you picked $noAutoModel, which has no Auto"
                else "Mode set to " to " by you" + where(change.client)
            "ORBIT_CHANGE" -> "Mode set to " to " by Orbit"
            "RUNNER_CORRECTION" -> change.fromMode?.let { from ->
                "Mode set back to " to " by the runner — Claude had ${if (previous?.cause == "RESPAWN") "restarted" else "started"} in " +
                    PermissionModes.label(from)
            } ?: ("Mode set to " to " by the runner")
            "ENGINE_REPORT" -> "Claude started in " to ""
            "RESPAWN" -> "Claude restarted in " to ""
            else -> "Mode changed to " to ""
        }
        return ModeLine(change.key, change.at, before, PermissionModes.label(change.toMode), after, gapFrom != null)
    }

    /** Where the owner was: the app the request named (`turn-sender-client.ts`). */
    private fun where(client: String?) = when (client) {
        "web" -> ", on the web"
        "ios" -> ", on iOS"
        "macos" -> ", on Mac"
        "android" -> ", on Android"
        "terminal" -> ", in the terminal"
        else -> ""
    }

    /** Where each line goes among the transcript's rows (as OwnerRequests.place): after the last row stamped at or before it, by the
     * row's index, or -1 ahead of every row. A line with no readable time is left out. */
    fun place(rowTimes: List<String?>, lines: List<ModeLine>): Map<Int, List<ModeLine>> {
        val times = rowTimes.map(::parse)
        return lines.mapNotNull { line ->
            val at = parse(line.at) ?: return@mapNotNull null
            times.indexOfLast { it != null && !it.isAfter(at) } to line
        }.groupBy({ it.first }, { it.second })
    }

    private fun correctingAt(at: String, now: Instant): Boolean = correctionEnds(at)?.isAfter(now) == true

    private fun parse(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }
}
