package io.orbitd.android.reader

import androidx.compose.runtime.compositionLocalOf
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.wiki.RelativeTime
import io.orbitd.android.wiki.WikiRunsLogic
import java.time.Duration
import kotlinx.serialization.json.*

/**
 * One SubAgent run as the reader reads it (`GET /sessions/:id/subagents`), keyed by the `delegate` call it belongs to: what the
 * transcript's SubAgent block shows beside the call — tier, model, Why, time and cost (docs/subagent-design.md §6.4). Mirrors
 * `@orbit/shared`'s `SubagentRunView` and OrbitKit's `SubagentRunView`.
 */
internal data class SubagentRun(val toolUseId: String, val type: String, val background: Boolean, val status: String,
    val level: String? = null, val model: String? = null, val modelLabel: String? = null, val reasons: List<String> = emptyList(),
    val costUsd: Double = 0.0, val resultSummary: String? = null, val createdAt: String, val endedAt: String? = null,
    /** The server's one-line Why: the tier, the pick with its provider once and why, any move, how many candidates were removed.
     * Null from a server before it kept one, and on rows from before then, whose Why is their reasons. */
    val why: String? = null,
    /** Every candidate the router removed, with its reason: the rest of what the Why line's Details open to. */
    val removed: List<Removed> = emptyList(),
    /** The workspace a remote SubAgent ran on; null on the parent's machine. */
    val workspaceName: String? = null,
    /** Paths the child's edit tools wrote: what an ended run left uncommitted in the working tree. */
    val changedFiles: List<String> = emptyList(),
    /** The Orbit workflow this run is a call of: its [WorkflowRun.id]. Such a run's `toolUseId` is `<the workflow call's tool_use
     * id>#<callIndex>`. Null, as are the three below, on a `delegate` call's run and from a server before it sent them. */
    val workflowRunId: String? = null,
    /** The call's place in the script, from 0 in the order the script made its `agent()` calls. */
    val callIndex: Int? = null,
    /** The `agent()` call's `label` and `phase`, as the script gave them. */
    val label: String? = null,
    val phase: String? = null) {
    /** A background call answers at once, so its card's own status cannot say whether the work still goes on. */
    val isRunning: Boolean get() = status == "RUNNING"

    data class Removed(val provider: String, val engine: String? = null, val model: String? = null, val effort: String? = null,
        val reason: String)

    companion object {
        fun from(row: JsonObject): SubagentRun? {
            val id = row.string("toolUseId")?.ifEmpty { null } ?: return null
            return SubagentRun(id, row.string("type").orEmpty(), (row["background"] as? JsonPrimitive)?.booleanOrNull == true,
                row.string("status").orEmpty(), row.string("level"), row.string("model"), row.string("modelLabel"),
                (row["reasons"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull },
                (row["costUsd"] as? JsonPrimitive)?.doubleOrNull ?: 0.0, row.string("resultSummary"), row.string("createdAt").orEmpty(),
                row.string("endedAt"), row.string("why"),
                (row["removed"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.mapNotNull { c ->
                    val provider = c.string("provider") ?: return@mapNotNull null
                    Removed(provider, c.string("engine"), c.string("model"), c.string("effort"), c.string("reason").orEmpty())
                },
                row.string("workspaceName"),
                (row["changedFiles"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.ifEmpty { null } },
                row.string("workflowRunId"), (row["callIndex"] as? JsonPrimitive)?.intOrNull, row.string("label"), row.string("phase"))
        }

        /** The list by `delegate` call; the later row wins a repeated id, as on iOS. */
        fun byCall(rows: List<JsonObject>): Map<String, SubagentRun> = rows.mapNotNull(::from).associateBy { it.toolUseId }
    }
}

/**
 * Orbit's own SubAgent — a `mcp__orbit__delegate` call — as the transcript draws it (board docs/mocks/subagent/03.png, OrbitKit
 * `SubagentBlock`): the folded row's grey second line, the Background mark and the opened block's grey Why line. A phone has no room
 * for web's trailing meta, so the second line carries the type, tier and model and, once the run has ended, how long it took (never
 * what it cost). A background run puts `Background` in the type's place.
 */
internal data class SubagentBlock(val type: String, val background: Boolean, val detailLine: String, val why: String?, val running: Boolean,
    /** What the Why line's Details open to (web `subagentWhyDetails` and its list): every reason the router gave — none when the Why
     * line already is those reasons — then every removed candidate as `Removed · <provider>: <reason>`. */
    val details: List<String> = emptyList()) {
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
            }
            return SubagentBlock(type, background, parts.joinToString(" · "), why(run), run?.isRunning ?: callRunning, details(run))
        }

        /** The Why line (web `subagentWhy`): the server's one-line Why, or the router's reasons joined when it sent none. A run on
         * another workspace leads with how that workspace was chosen, its first reason. */
        private fun why(run: SubagentRun?): String? {
            if (run == null) return null
            val why = run.why?.ifEmpty { null } ?: run.reasons.filter { it.isNotEmpty() }.ifEmpty { null }?.joinToString(" · ") ?: return null
            val chosen = if (run.workspaceName.isNullOrEmpty()) null else run.reasons.firstOrNull()?.ifEmpty { null }
            return if (chosen != null && !why.startsWith(chosen)) "$chosen · $why" else why
        }

        private fun details(run: SubagentRun?): List<String> {
            if (run == null) return emptyList()
            val reasons = if (run.why.isNullOrEmpty()) emptyList() else run.reasons.filter { it.isNotEmpty() }
            return reasons + run.removed.map { c ->
                val engine = c.engine?.ifEmpty { null }?.takeIf { it != c.provider }?.let { " ($it)" }.orEmpty()
                val model = c.model?.ifEmpty { null }?.let { m -> ", $m" + c.effort?.ifEmpty { null }?.let { " · $it" }.orEmpty() }.orEmpty()
                "Removed · ${c.provider}$engine$model: ${c.reason}"
            }
        }

        /** How long the run took, once it has ended: `41s`, `1m 12s` (web and iOS `wikiDuration`). */
        private fun duration(run: SubagentRun?): String? {
            if (run == null || run.isRunning) return null
            val start = RelativeTime.parse(run.createdAt) ?: return null
            val end = RelativeTime.parse(run.endedAt) ?: return null
            return WikiRunsLogic.duration(Duration.between(start, end).toMillis() / 1000.0)
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
        // The call's JSON clipped to a preview (the server trims a long result): the run's own text, never the receipt's opening brace.
        val obj = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull()
            ?: return if (text.startsWith("{")) endedSummary(run) else text
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
