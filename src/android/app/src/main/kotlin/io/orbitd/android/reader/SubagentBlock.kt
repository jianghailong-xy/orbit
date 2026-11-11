package io.orbitd.android.reader

import androidx.compose.runtime.compositionLocalOf
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.wiki.RelativeTime
import io.orbitd.android.wiki.WikiRunsLogic
import java.time.Duration
import java.util.Locale
import kotlinx.serialization.json.*

/**
 * One SubAgent run as the reader reads it (`GET /sessions/:id/subagents`), keyed by the `delegate` call it belongs to: what the
 * transcript's SubAgent block shows beside the call — tier, model, Why, time and cost (docs/subagent-design.md §6.4). Mirrors
 * `@orbit/shared`'s `SubagentRunView` and OrbitKit's `SubagentRunView`.
 */
internal data class SubagentRun(val toolUseId: String, val type: String, val background: Boolean, val status: String,
    val level: String? = null, val model: String? = null, val modelLabel: String? = null, val reasons: List<String> = emptyList(),
    val costUsd: Double = 0.0, val resultSummary: String? = null, val createdAt: String, val endedAt: String? = null) {
    /** A background call answers at once, so its card's own status cannot say whether the work still goes on. */
    val isRunning: Boolean get() = status == "RUNNING"

    companion object {
        fun from(row: JsonObject): SubagentRun? {
            val id = row.string("toolUseId")?.ifEmpty { null } ?: return null
            return SubagentRun(id, row.string("type").orEmpty(), (row["background"] as? JsonPrimitive)?.booleanOrNull == true,
                row.string("status").orEmpty(), row.string("level"), row.string("model"), row.string("modelLabel"),
                (row["reasons"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull },
                (row["costUsd"] as? JsonPrimitive)?.doubleOrNull ?: 0.0, row.string("resultSummary"), row.string("createdAt").orEmpty(),
                row.string("endedAt"))
        }

        /** The list by `delegate` call; the later row wins a repeated id, as on iOS. */
        fun byCall(rows: List<JsonObject>): Map<String, SubagentRun> = rows.mapNotNull(::from).associateBy { it.toolUseId }
    }
}

/**
 * Orbit's own SubAgent — a `mcp__orbit__delegate` call — as the transcript draws it (board docs/mocks/subagent/03.png, OrbitKit
 * `SubagentBlock`): the folded row's grey second line, the Background mark and the opened block's grey Why line. A phone has no room
 * for web's trailing meta, so the second line carries the type, tier and model and, once the run has ended, how long it took and
 * what it cost. A background run puts `Background` in the type's place.
 */
internal data class SubagentBlock(val type: String, val background: Boolean, val detailLine: String, val why: String?, val running: Boolean) {
    companion object {
        const val TOOL_NAME = "mcp__orbit__delegate"

        /** [callRunning]: the call has no result yet — what says the block runs before the run itself has been read. */
        fun describe(input: JsonElement?, run: SubagentRun?, callRunning: Boolean): SubagentBlock {
            val args = input as? JsonObject
            val type = run?.type?.ifEmpty { null } ?: args?.string("type")?.ifEmpty { null } ?: "general"
            val background = run?.background ?: ((args?.get("background") as? JsonPrimitive)?.booleanOrNull == true)
            val parts = buildList {
                add(if (background) "Background" else type)
                run?.level?.ifEmpty { null }?.let(::add)
                (run?.modelLabel?.ifEmpty { null } ?: run?.model?.ifEmpty { null })?.let(::add)
                duration(run)?.let(::add)
                cost(run)?.let(::add)
            }
            val reasons = run?.reasons.orEmpty().filter { it.isNotEmpty() }
            return SubagentBlock(type, background, parts.joinToString(" · "), reasons.ifEmpty { null }?.joinToString(" · "),
                run?.isRunning ?: callRunning)
        }

        /** How long the run took, once it has ended: `41s`, `1m 12s` (web and iOS `wikiDuration`). */
        private fun duration(run: SubagentRun?): String? {
            if (run == null || run.isRunning) return null
            val start = RelativeTime.parse(run.createdAt) ?: return null
            val end = RelativeTime.parse(run.endedAt) ?: return null
            return WikiRunsLogic.duration(Duration.between(start, end).toMillis() / 1000.0)
        }

        /** What the run cost, once it has ended: `$0.03`, or `<$0.01` when it came to less than a cent. */
        fun cost(run: SubagentRun?): String? {
            if (run == null || run.isRunning) return null
            if (run.costUsd < 0.01) return "<$0.01"
            return String.format(Locale.ROOT, "$%.2f", run.costUsd)
        }
    }
}

/**
 * What a SubAgent handed back (OrbitKit `SubagentResult`): a foreground call's result is `{ runId, status, result, … }`; a background
 * call's is only its receipt, so its result comes from the run once that has ended. Null while there is nothing to show.
 */
internal object SubagentResult {
    fun text(callResult: String?, run: SubagentRun?): String? {
        val text = callResult?.trim()?.ifEmpty { null } ?: return endedSummary(run)
        val obj = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return text
        (obj["result"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.ifEmpty { null }?.let { return it }
        endedSummary(run)?.let { return it }
        // A launch receipt (`{ runId, status: "running" }`): the work is drawn, not this.
        if (obj["runId"] != null) return null
        return text
    }

    private fun endedSummary(run: SubagentRun?): String? = run?.takeIf { !it.isRunning }?.resultSummary?.ifEmpty { null }
}

/**
 * What moves a session's SubAgent runs (OrbitKit `SubagentRuns.signature`, web `delegateRunsSignature`): each top-level `delegate`
 * call, its result, and the terminal `background_task` a background run ends with. Empty when the window holds no delegate call, so a
 * session that never delegated reads nothing.
 */
internal object SubagentRuns {
    /** [background]: the session's REST list (GET /sessions/:id/background), which says a background run ended when the window
     * no longer holds its `background_task` event. */
    fun signature(events: List<RunEvent>, background: List<JsonObject> = emptyList()): String {
        val calls = events.filter { it.type == "tool_use" && it.parent() == null &&
            (it.fields.string("name") ?: it.fields.string("toolName")) == SubagentBlock.TOOL_NAME }.mapNotNull { it.toolId() }.toSet()
        if (calls.isEmpty()) return ""
        return buildList {
            calls.forEach { add(it) }
            events.forEach { event ->
                val id = event.toolId() ?: return@forEach
                if (id !in calls) return@forEach
                when (event.type) {
                    "tool_result" -> add("$id:result:${event.seq}")
                    "background_task" -> add("$id:${event.fields.string("status")}")
                }
            }
            background.forEach { row -> row.string("toolUseId")?.takeIf { it in calls }?.let { add("$it:${row.string("status")}") } }
        }.joinToString(",")
    }
}

/** The session's SubAgent runs by `delegate` call, as the reader last read them. */
internal val LocalSubagentRuns = compositionLocalOf<Map<String, SubagentRun>> { emptyMap() }
