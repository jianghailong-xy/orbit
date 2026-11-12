package io.orbitd.android.directory

import java.time.Instant
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** The server's account of a runner draining for a self-update (web `QueuedRunnerUpdate`, docs/runner-update-drain-design.md): the
 *  release it installs next, when the wait began, and the reader's own turns the drain waits for, oldest first. */
data class QueuedRunnerUpdate(val targetVersion: String? = null, val since: String? = null, val turns: List<Turn> = emptyList()) {
    data class Turn(val id: String, val title: String?)

    companion object {
        /** Read leniently from the row's JSON: a shape this build cannot read is no update rather than a row that fails to decode. */
        fun of(json: JsonElement?): QueuedRunnerUpdate? {
            val o = json as? JsonObject ?: return null
            fun JsonObject.str(key: String) = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
            val turns = (o["turns"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
                .mapNotNull { t -> t.str("id")?.let { Turn(it, t.str("title")) } }
            return QueuedRunnerUpdate(o.str("targetVersion"), o.str("since"), turns)
        }
    }
}

/** Which gate the server found holding a queued session (web `QueuedGate`), as the runner_updating copy reads it. */
data class QueuedGate(val queuedReason: String? = null, val queuedActive: Int? = null, val queuedRunnerUpdate: QueuedRunnerUpdate? = null)

internal val DirectorySession.queuedGate: QueuedGate
    get() = QueuedGate(queuedReason, queuedActive, QueuedRunnerUpdate.of(queuedRunnerUpdate))

/** A run of the explanation: words, or a turn the reader can open (web `RunnerUpdatingPart`). */
sealed interface RunnerUpdatingPart {
    data class Words(val text: String) : RunnerUpdatingPart
    data class Session(val id: String, val title: String) : RunnerUpdatingPart
}

/**
 * A session held by its runner's self-update (queuedReason `runner_updating`, board 2 and 5 of docs/mocks/runner-update-drain): every
 * word a port of web `runnerSlots.ts`'s, held to that source by RunnerUpdatingCopyParityTest.
 */
internal object RunnerUpdating {
    const val RUNNER_UPDATING_TITLE = "Runner updating"
    /** The foot-row tag under a message the drain holds: `Queued · ` then this, underlined, to open why. */
    const val RUNNER_UPDATING_TAG = "runner updating"
    /** The word before the tag on the foot row (web `QUEUED_LABEL`). */
    const val QUEUED = "Queued"
    const val THE_RUNNER = "The runner"
    const val UNTITLED_SESSION = "Untitled session"
    const val SESSION_STARTS = "This session starts right after."
    const val MESSAGE_SENT = "This message is sent right after."
    const val LESS_THAN_A_MINUTE = "Waiting less than a minute"
    const val AND = " and "

    fun isRunnerUpdating(gate: QueuedGate?): Boolean = gate?.queuedReason == "runner_updating"

    private fun turnTitle(title: String?) = title?.trim()?.takeIf { it.isNotEmpty() } ?: UNTITLED_SESSION

    /** "2 turns finish" — the count is every turn in flight on the runner, the reader's or not. */
    private fun turnsFinish(count: Int) = if (count == 1) "1 turn finishes" else "$count turns finish"

    private fun turnCount(gate: QueuedGate) = gate.queuedActive ?: gate.queuedRunnerUpdate?.turns?.size ?: 0

    /** The turns, named, joined as a sentence lists them, with "N more" for the turns that are not the reader's to name. */
    private fun namedTurns(gate: QueuedGate): List<RunnerUpdatingPart> {
        val named = gate.queuedRunnerUpdate?.turns.orEmpty()
        val count = gate.queuedActive ?: named.size
        val items: MutableList<RunnerUpdatingPart> = named.map { RunnerUpdatingPart.Session(it.id, turnTitle(it.title)) }.toMutableList()
        if (count > named.size) items += RunnerUpdatingPart.Words("${count - named.size} more")
        val parts = mutableListOf<RunnerUpdatingPart>()
        items.forEachIndexed { i, item ->
            if (i > 0) parts += RunnerUpdatingPart.Words(if (i == items.size - 1) AND else ", ")
            parts += item
        }
        return parts
    }

    /** The queued page's explanation (board 2 ②), its turns as parts the page draws as links (web `runnerUpdatingDescription`). */
    fun runnerUpdatingDescription(gate: QueuedGate, machine: String?): List<RunnerUpdatingPart> {
        val who = machine?.trim()?.takeIf { it.isNotEmpty() } ?: THE_RUNNER
        val version = gate.queuedRunnerUpdate?.targetVersion?.takeIf { it.isNotEmpty() }
        val parts = mutableListOf<RunnerUpdatingPart>(RunnerUpdatingPart.Words(if (version != null) "$who is updating to $version. " else "$who is updating. "))
        val count = turnCount(gate)
        if (count > 0) {
            parts += RunnerUpdatingPart.Words("It starts no new work until ${turnsFinish(count)}: ")
            parts += namedTurns(gate)
            parts += RunnerUpdatingPart.Words(". ")
        }
        parts += RunnerUpdatingPart.Words(SESSION_STARTS)
        return parts
    }

    /** The popover a queued message's `runner updating` tag opens (board 2 ⑤; web `runnerUpdatingMessageText`). */
    fun runnerUpdatingMessageText(gate: QueuedGate, machine: String?): String {
        val who = machine?.trim()?.takeIf { it.isNotEmpty() } ?: THE_RUNNER
        val version = gate.queuedRunnerUpdate?.targetVersion?.takeIf { it.isNotEmpty() }
        val update = if (version != null) "updates to $version" else "updates"
        val count = turnCount(gate)
        val first = if (count > 0) "$who starts no new turns until ${turnsFinish(count)}, then $update." else "$who $update now."
        return "$first $MESSAGE_SENT"
    }

    /** `Waiting 38 min`, from the gate's clock; null when the server sent none it can be read from (web `runnerUpdatingWaited`). */
    fun runnerUpdatingWaited(gate: QueuedGate, now: Instant): String? {
        val since = gate.queuedRunnerUpdate?.since ?: return null
        val at = runCatching { Instant.parse(since) }.getOrNull() ?: return null
        if (at.isAfter(now)) return null
        val minutes = (now.toEpochMilli() - at.toEpochMilli()) / 60_000
        if (minutes < 1) return LESS_THAN_A_MINUTE
        if (minutes < 60) return "Waiting $minutes min"
        val rest = minutes % 60
        return "Waiting ${minutes / 60} h${if (rest != 0L) " $rest min" else ""}"
    }

    /** The parts as one plain line (web `runnerUpdatingPlain`). */
    fun runnerUpdatingPlain(parts: List<RunnerUpdatingPart>): String = parts.joinToString("") {
        when (it) { is RunnerUpdatingPart.Words -> it.text; is RunnerUpdatingPart.Session -> it.title }
    }
}
