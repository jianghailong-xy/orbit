package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.time.Instant

/**
 * The folded "Background" row of a session's composer band: what it draws, from the session's background list
 * (GET /sessions/:id/background), the time of the session's last user message and whether the session is live. A port of
 * `backgroundRow` in src/shared/src/backgroundRow.ts (OrbitKit `BackgroundRowRule`); `BackgroundRowParityTest` runs it over every
 * case of `background-row.fixture.json`, which the web and OrbitKit read too.
 *
 * Owner decisions (project 34yq7HVPsPDGBiMEm8sL2, 2026-11-17): an ended process stays until the user's next message, and a wake
 * turn does not clear it (D1); the visible label is "Background", the screen reader keeps "Background processes" (D2); several
 * running rotate their names, newest started first, 3000 ms each with a 300 ms change (E1); a failure is neither counted nor pinned,
 * as the owner can do nothing about it (E2, revised 2026-11-21); nothing running names the last one to end, failed or not (E3).
 */
object BackgroundRow {
    /** The row's visible label. */
    const val LABEL = "Background"
    /** The screen-reader label's start; the count or the one name follows. */
    const val A11Y_PREFIX = "Background processes, "
    /** How long each name shows while the names rotate. */
    const val ROTATE_PER_NAME_MS = 3000
    /** How long the change from one name to the next takes. */
    const val ROTATE_CHANGE_MS = 300

    /** The fields of a background list entry the row reads (status running | done | failed | killed | unknown). */
    data class Input(val shellId: String, val command: String, val description: String?, val startedSeq: Long,
        val status: String, val endedAt: String?) {
        companion object {
            /** One entry of the server's list. */
            fun of(row: JsonObject) = Input(row.text("shellId").orEmpty(), row.text("command").orEmpty(), row.text("description"),
                (row["startedSeq"] as? JsonPrimitive)?.longOrNull ?: 0L, row.text("status").orEmpty(), row.text("endedAt"))
        }
    }

    /** The mark after a name: a spinner while running, then the list row's ✓ / ✕ / stop icon. */
    enum class Mark { RUNNING, DONE, FAILED, KILLED }

    /** Where a name gives way when it does not fit: a description loses its tail, a command its middle. */
    enum class Truncate { TAIL, MIDDLE }

    data class Item(val id: String, val name: String, val truncate: Truncate, val mark: Mark)

    /** `kind` is running. */
    data class CountPart(val kind: String, val text: String)

    sealed interface Name {
        /** One named item, still. */
        data class One(val item: Item) : Name
        /** The running items' names in turn, newest started first, looping. */
        data class Rotate(val items: List<Item>, val perNameMs: Int, val changeMs: Int) : Name
    }

    /** A shown row; a hidden one is null from [row]. */
    data class Row(
        val label: String,
        val name: Name,
        /** The count's parts, zero parts left out; empty unless more than one item is shown. */
        val countParts: List<CountPart>,
        /** The parts joined by " · ", or null when there are none. */
        val countLine: String?,
        /** "Background processes, " + the count, or the one name. Never the rotating text. */
        val accessibilityLabel: String,
    )

    /** A list entry's name: its description, falling back to its command (then its id). */
    fun itemName(s: Input): Pair<String, Truncate> {
        val description = s.description?.trim()
        if (!description.isNullOrEmpty()) return description to Truncate.TAIL
        val command = s.command.trim()
        return (command.ifEmpty { s.shellId }) to Truncate.MIDDLE
    }

    private fun time(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

    /** The row's cut-off: the later of the person's last message and the agent's latest turn start (null: none). */
    fun clearedAt(lastUserMessageAt: String?, lastAgentTurnStartedAt: String?): String? {
        val a = time(lastUserMessageAt)
        val b = time(lastAgentTurnStartedAt)
        return when {
            a == null -> if (b == null) null else lastAgentTurnStartedAt
            b == null -> lastUserMessageAt
            b > a -> lastAgentTurnStartedAt
            else -> lastUserMessageAt
        }
    }

    /**
     * The items the row shows: the running ones (only on a live session — a session that is not live has nothing running,
     * whatever its list last said) and the ended ones that ended after `clearedAt` (all ended ones when there is none).
     */
    fun shown(list: List<Input>, clearedAt: String?, sessionLive: Boolean): Pair<List<Input>, List<Input>> {
        val since = time(clearedAt)
        val running = if (sessionLive) list.filter { it.status == "running" } else emptyList()
        val ended = list.filter { s ->
            val end = time(s.endedAt)
            s.status in ENDED && end != null && (since == null || end > since)
        }
        return running to ended
    }

    /** What the folded row draws, or null for no row. */
    fun row(list: List<Input>, clearedAt: String?, sessionLive: Boolean): Row? {
        val (running, ended) = shown(list, clearedAt, sessionLive)
        val shown = running + ended
        if (shown.isEmpty()) return null

        fun item(s: Input): Item {
            val (name, truncate) = itemName(s)
            return Item(s.shellId, name, truncate, Mark.valueOf(s.status.uppercase()))
        }
        // The last to end; the first of equal ends, as the shared rule's reduce keeps it.
        fun lastEnded(xs: List<Input>) = xs.drop(1).fold(xs[0]) { a, b -> if (time(b.endedAt)!! > time(a.endedAt)!!) b else a }

        val name: Name = when {
            shown.size == 1 -> Name.One(item(shown[0]))
            running.size >= 2 -> Name.Rotate(running.sortedByDescending { it.startedSeq }.map(::item), ROTATE_PER_NAME_MS, ROTATE_CHANGE_MS)
            running.size == 1 -> Name.One(item(running[0]))
            else -> Name.One(item(lastEnded(ended)))
        }

        // How many run; no failed count (E2).
        val parts = buildList {
            if (shown.size > 1 && running.isNotEmpty()) add(CountPart("running", "${running.size} running"))
        }
        val countLine = parts.takeIf { it.isNotEmpty() }?.joinToString(" · ") { it.text }
        val spoken = countLine ?: when (name) {
            is Name.One -> name.item.name
            is Name.Rotate -> name.items[0].name
        }
        return Row(LABEL, name, parts, countLine, A11Y_PREFIX + spoken)
    }

    /** The row for a session's list as the server sends it. */
    fun rowOf(list: List<JsonObject>, clearedAt: String?, sessionLive: Boolean): Row? =
        row(list.map(Input::of), clearedAt, sessionLive)

    private val ENDED = setOf("done", "failed", "killed")
}
