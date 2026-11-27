package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.PermissionModeChange
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
     */
    fun capsule(intent: String, actual: String?, reported: Boolean, beforeStart: Boolean, latest: PermissionModeChange?,
        noAutoModel: String?, runsAsRoot: Boolean, scheduledOnClaude: Boolean, now: Instant): ModeCapsule {
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

    /** When a Claude report recorded at [at] stops reading as being switched back, and the control is drawn again as a gap that stands. */
    fun correctionEnds(at: String): Instant? = parse(at)?.plus(CORRECTION_WINDOW)

    /** What the Auto row of the mode menu says under its name on a model with no Auto (C1): the pick stays, and what it runs as. */
    fun autoNote(noAutoModel: String, beforeStart: Boolean): String =
        if (beforeStart) "Not on $noAutoModel, starts in Default" else "Not on $noAutoModel, runs as Default"

    /**
     * The transcript's lines for [changes], oldest first: each says what the mode became and who or what made it. A Claude report the
     * runner then corrected is said once, by the correction ("Mode set back to Auto by the runner — Claude had started in Default").
     * The newest, when the mode it set is still the one running and is not [intent], is the gap's: amber, saying why where that is
     * known — [noAutoModel] (the model's name when it has no Auto), a root runner.
     */
    fun lines(changes: List<PermissionModeChange>, intent: String?, actual: String?, noAutoModel: String?, runsAsRoot: Boolean,
        scheduledOnClaude: Boolean): List<ModeLine> = changes.mapIndexedNotNull { i, change ->
        val next = changes.getOrNull(i + 1)
        if (change.cause in ENGINE_CAUSES && next?.cause == "RUNNER_CORRECTION" && next.fromMode == change.toMode) return@mapIndexedNotNull null
        val gap = next == null && intent != null && change.toMode == actual && actual != intent && !(scheduledOnClaude && actual == AUTO)
        line(change, changes.getOrNull(i - 1), intent?.takeIf { gap }, noAutoModel, runsAsRoot, scheduledOnClaude)
    }

    /** [gapFrom]: the intent the line's mode falls short of, when it is the gap's line. */
    private fun line(change: PermissionModeChange, previous: PermissionModeChange?, gapFrom: String?, noAutoModel: String?,
        runsAsRoot: Boolean, scheduledOnClaude: Boolean): ModeLine {
        val noAuto = gapFrom == AUTO && change.toMode == DEFAULT && noAutoModel != null
        val (before, after) = when (change.cause) {
            "CLAIM" -> (if (change.fromMode == null) "Started in " else "Resumed in ") to when {
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
