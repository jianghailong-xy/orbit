package io.orbitd.android.reader

import androidx.compose.runtime.compositionLocalOf
import io.orbitd.android.core.cards.WorkflowFinishedRun
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.wiki.RelativeTime
import io.orbitd.android.wiki.WikiRunsLogic
import java.time.Duration
import java.util.Locale
import kotlinx.serialization.json.*

/**
 * One Orbit workflow as the reader reads it (`GET /sessions/:id/workflows`, docs/subagent-workflow-design.md §5.1), keyed by the
 * `mcp__orbit__workflow` call it belongs to. Its calls are SubAgent runs whose `workflowRunId` is this [id]. Mirrors `@orbit/shared`'s
 * `WorkflowRunView` and OrbitKit's `WorkflowRunView`.
 */
internal data class WorkflowRun(val id: String, val toolUseId: String, val name: String, val description: String? = null,
    val phases: List<String> = emptyList(),
    /** `RUNNING`, `DONE`, `FAILED`, `INTERRUPTED`, `STOPPED`. */
    val status: String,
    /** Calls that finished, and calls that ended any other way; with [costUsd], counted from the calls' runs while the workflow runs,
     * and the runner's report once it has ended. */
    val callsDone: Int = 0, val callsFailed: Int = 0, val costUsd: Double = 0.0,
    /** The cost limit the call set; null when it set none (the default). */
    val maxCostUsd: Double? = null,
    /** Why it did not finish, truncated; null while it runs and when it finished. */
    val error: String? = null, val createdAt: String, val endedAt: String? = null) {
    val isRunning: Boolean get() = status == "RUNNING"

    companion object {
        fun from(row: JsonObject): WorkflowRun? {
            val id = row.string("id")?.ifEmpty { null } ?: return null
            val toolUseId = row.string("toolUseId")?.ifEmpty { null } ?: return null
            fun int(key: String) = (row[key] as? JsonPrimitive)?.intOrNull ?: 0
            return WorkflowRun(id, toolUseId, row.string("name").orEmpty(), row.string("description"),
                (row["phases"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull },
                row.string("status").orEmpty(), int("callsDone"), int("callsFailed"), (row["costUsd"] as? JsonPrimitive)?.doubleOrNull ?: 0.0,
                (row["maxCostUsd"] as? JsonPrimitive)?.doubleOrNull, row.string("error"), row.string("createdAt").orEmpty(), row.string("endedAt"))
        }

        /** The list by workflow call; the later row wins a repeated id, as on iOS. */
        fun byCall(rows: List<JsonObject>): Map<String, WorkflowRun> = rows.mapNotNull(::from).associateBy { it.toolUseId }
    }
}

/**
 * An Orbit workflow — a top-level `mcp__orbit__workflow` call whose `agent()` calls arrive as `delegate` calls nested under it
 * (docs/subagent-workflow-design.md §3.3) — as Android draws it, following iOS (board docs/mocks/subagent-workflow part 4; OrbitKit
 * `WorkflowBlock`, read case for case). The numbers come from the server ([WorkflowRun] and its calls' [SubagentRun]s), never from the
 * transcript's text; the transcript only says which calls the script has made so far.
 *
 * Folded it has three lines: `Workflow` and the description with a spinner or how it ended; then, grey, `<phase> · <done> of <started> ·
 * $<cost>` (`$x of $y` only when the call set a limit); then, italic and only while it runs, how many calls are running and queued. Tapped,
 * it opens a page of its calls by phase, each opening the existing SubAgent detail.
 */
internal data class WorkflowBlock(
    /** The row's words after `Workflow`: the call's description, else the script's name. */
    val title: String,
    val state: State,
    /** The grey second line: `Verify · 7 of 12 · $0.84`. */
    val progress: String,
    /** The italic third line while it runs: `3 running, 2 queued`; null once it has ended or while neither is true. */
    val live: String?,
    /** Why it did not finish, for one that ended any other way than DONE. */
    val error: String?,
    val sections: List<Section>,
) {
    enum class State { RUNNING, DONE, FAILED, STOPPED }

    enum class CallState {
        /** Made by the script, its SubAgent not started yet (calls share the SubAgent concurrency limit). */
        QUEUED, RUNNING, DONE, FAILED
    }

    /** One `agent()` call: a row of the calls page. */
    data class Call(
        /** The nested `delegate` call's tool_use id, `<workflow call>#<callIndex>`. */
        val id: String,
        /** The script's label for it, else its type. */
        val label: String,
        /** The first line it handed back, or how it ended; null while it has not ended. */
        val result: String?,
        val state: CallState,
        val phase: String?,
        /** The nested call itself, which the existing SubAgent block draws. */
        val row: TranscriptRow,
    )

    /** The calls of one phase, in the order the script made them. */
    data class Section(
        /** The phase's title; null for calls the script gave no phase. */
        val title: String?,
        /** `Verify · 3 done · 3 running · 2 queued` — done counts every call that ended, a failed one included (its row's ✕ says which). */
        val header: String,
        val calls: List<Call>,
        /** How many rows to show before [more]; `calls.size` when nothing is folded. */
        val shown: Int,
        /** `2 more`: an ended phase of a workflow still running shows its first rows only. */
        val more: String?,
    ) {
        val id: String get() = title.orEmpty()
    }

    val running: Boolean get() = state == State.RUNNING
    val calls: List<Call> get() = sections.flatMap { it.calls }

    companion object {
        const val TOOL_NAME = "mcp__orbit__workflow"
        /** What the block's row calls it. */
        const val LABEL = "Workflow"

        /** [row] is the workflow call with the calls the transcript keeps under it; [run] reads a call's SubAgent run by its tool_use id.
         * [backgroundRunning] is the transcript's own word that the work goes on, used only before the server's view is read. */
        fun describe(row: TranscriptRow, workflow: WorkflowRun?, run: (String) -> SubagentRun?, backgroundRunning: Boolean = false): WorkflowBlock {
            val state = state(row, workflow, backgroundRunning)
            val calls = row.children.filter { it.event.type == "tool_use" && it.event.toolName() == SubagentBlock.TOOL_NAME }
                .mapNotNull { child -> child.event.toolId()?.let { call(it, child, run(it), workflowEnded = state != State.RUNNING) } }
            val ended = calls.count { it.state == CallState.DONE || it.state == CallState.FAILED }
            val runningCalls = calls.count { it.state == CallState.RUNNING }
            val queuedCalls = calls.count { it.state == CallState.QUEUED }
            // Once it has ended, the runner's report counts every call, those older than the transcript's window too.
            val doneCount = workflow?.let { if (it.isRunning) maxOf(ended, it.callsDone + it.callsFailed) else it.callsDone + it.callsFailed } ?: ended
            val started = maxOf(calls.size, doneCount)
            // What the ended calls reported, as the server counts it while the workflow runs.
            val cost = workflow?.costUsd ?: calls.sumOf { call -> run(call.id)?.takeIf { !it.isRunning }?.costUsd ?: 0.0 }

            val parts = buildList {
                if (state == State.RUNNING) currentPhase(calls)?.let(::add)
                add("$doneCount of $started")
                add(money(cost, workflow?.maxCostUsd))
            }
            val live = if (state != State.RUNNING) emptyList() else buildList {
                if (runningCalls > 0) add("$runningCalls running")
                if (queuedCalls > 0) add("$queuedCalls queued")
            }
            val input = row.event.fields["input"] as? JsonObject
            return WorkflowBlock(
                title = input?.string("description")?.trim()?.ifEmpty { null } ?: workflow?.description?.ifEmpty { null }
                    ?: workflow?.name?.ifEmpty { null } ?: scriptName(input?.string("script")) ?: "",
                state = state,
                progress = parts.joinToString(" · "),
                live = live.ifEmpty { null }?.joinToString(", "),
                error = if (state == State.RUNNING || state == State.DONE) null else workflow?.error?.ifEmpty { null },
                sections = sections(calls, workflow?.phases.orEmpty(), workflowRunning = state == State.RUNNING))
        }

        /** `$0.84`, or `$0.84 of $5.00` when the call set a limit. */
        fun money(cost: Double, limit: Double?): String {
            val spent = String.format(Locale.US, "$%.2f", cost)
            return if (limit == null) spent else spent + " of " + String.format(Locale.US, "$%.2f", limit)
        }

        private fun state(row: TranscriptRow, workflow: WorkflowRun?, backgroundRunning: Boolean): State {
            if (workflow != null) return when (workflow.status) {
                "RUNNING" -> State.RUNNING
                "DONE" -> State.DONE
                "FAILED" -> State.FAILED
                else -> State.STOPPED
            }
            // Before the server's view is read: the call refused, or its work still going.
            if (row.result?.isError() == true) return State.FAILED
            if (row.result == null || backgroundRunning) return State.RUNNING
            return State.DONE
        }

        private fun call(id: String, row: TranscriptRow, run: SubagentRun?, workflowEnded: Boolean): Call {
            val state = when {
                run != null -> if (run.isRunning) CallState.RUNNING else if (run.status == "DONE") CallState.DONE else CallState.FAILED
                // A call whose run never opened, of a workflow that ended, did not run at all.
                row.result == null -> if (workflowEnded) CallState.FAILED else CallState.QUEUED
                row.result.isError() -> CallState.FAILED
                else -> CallState.DONE
            }
            val input = row.event.fields["input"] as? JsonObject
            // What it handed back, first line only; a failed call says nothing until its run says why.
            val result = if (state != CallState.DONE) null else SubagentResult.text(row.result?.let {
                contentText(it.fields["content"]) ?: it.fields.string("result") }, run)?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()
            return Call(id,
                label = run?.label?.ifEmpty { null } ?: input?.string("description")?.ifEmpty { null } ?: run?.type?.ifEmpty { null }
                    ?: input?.string("type")?.ifEmpty { null } ?: "agent",
                result = result, state = state,
                phase = run?.phase?.ifEmpty { null } ?: input?.string("workflow_phase")?.ifEmpty { null },
                row = row)
        }

        /** The phase the work is in: the newest call still running or queued, else the newest call's. */
        private fun currentPhase(calls: List<Call>): String? =
            calls.lastOrNull { it.state == CallState.RUNNING || it.state == CallState.QUEUED }?.phase ?: calls.lastOrNull()?.phase

        /** The calls by phase: the script's phases in the order its meta lists them, then any other phase in the order its first call
         * came, then the calls with none. */
        private fun sections(calls: List<Call>, phases: List<String>, workflowRunning: Boolean): List<Section> {
            val order = mutableListOf<String?>()
            phases.filter { phase -> calls.any { it.phase == phase } }.forEach { order += it }
            calls.forEach { if (it.phase !in order) order += it.phase }
            if (order.size > 1 && null in order) { order.remove(null); order += null }
            val last = order.lastOrNull()
            return order.map { phase ->
                val members = calls.filter { it.phase == phase }
                val ended = members.count { it.state == CallState.DONE || it.state == CallState.FAILED }
                val running = members.count { it.state == CallState.RUNNING }
                val queued = members.count { it.state == CallState.QUEUED }
                val counts = buildList {
                    if (ended > 0 || (running == 0 && queued == 0)) add("$ended done")
                    if (running > 0) add("$running running")
                    if (queued > 0) add("$queued queued")
                }
                // A phase that is over, while the work goes on in a later one, gives its room to the live one.
                val folds = workflowRunning && phase != last && running == 0 && queued == 0 && members.size > 3
                val shown = if (folds) 2 else members.size
                Section(phase, (listOfNotNull(phase) + counts).joinToString(" · "), members, shown,
                    if (folds) "${members.size - shown} more" else null)
            }
        }

        private val metaName = Regex("meta\\s*=\\s*\\{[^}]*?\\bname\\s*:\\s*(['\"`])([^'\"`]+)\\1")

        /** The `name` of the script's leading `export const meta = { name: '…' }`, when it is a plain string. */
        internal fun scriptName(script: String?): String? = script?.let { metaName.find(it)?.groupValues?.get(2) }
    }
}

/**
 * What moves a session's workflows: each workflow call and its result, each call the script made under it and the call's result, and the
 * first event of each call's SubAgent (its run opened). Empty when the window holds no workflow, so a session that never ran one reads
 * nothing (OrbitKit `WorkflowRuns.signature`, web `workflowRunsSignature`).
 */
internal object WorkflowRuns {
    fun signature(events: List<RunEvent>, background: List<JsonObject> = emptyList()): String {
        val flows = events.filter { it.type == "tool_use" && it.parent() == null && it.toolName() == WorkflowBlock.TOOL_NAME }
            .mapNotNull { it.toolId() }.toSet()
        if (flows.isEmpty()) return ""
        val calls = events.filter { it.type == "tool_use" && it.parent() in flows && it.toolName() == SubagentBlock.TOOL_NAME }
            .mapNotNull { it.toolId() }.toSet()
        val opened = events.mapNotNull { e -> e.parent()?.takeIf { it in calls } }.toSet()
        return buildList {
            flows.forEach { add(it) }
            calls.forEach { add("$it:${if (it in opened) "o" else "-"}") }
            events.forEach { event ->
                val id = event.toolId() ?: return@forEach
                if (id !in flows && id !in calls) return@forEach
                when (event.type) {
                    "tool_result" -> add("$id:result:${event.seq}")
                    "background_task" -> add("$id:${event.fields.string("status")}")
                }
            }
            background.forEach { row -> row.string("toolUseId")?.takeIf { it in flows }?.let { add("$it:${row.string("status")}") } }
        }.joinToString(",")
    }
}

/** The session's Orbit workflows by `mcp__orbit__workflow` call, as the reader last read them. */
internal val LocalWorkflowRuns = compositionLocalOf<Map<String, WorkflowRun>> { emptyMap() }

/**
 * The finished strip (board part 4 ②; OrbitKit `WorkflowFinishedStrip`): a pale purple strip, the parent's answer under it.
 */
internal data class WorkflowFinishedStrip(
    /** `Workflow finished`, or how it ended otherwise. */
    val title: String,
    /** `12 calls · 1 failed · 6m 40s · $1.37`. */
    val line: String,
    val failed: Boolean,
) {
    companion object {
        /** [workflow] is the server's view of the same run, when read: its numbers and its time win over the block's. */
        fun describe(run: WorkflowFinishedRun, workflow: WorkflowRun?): WorkflowFinishedStrip {
            val title = when (run.status) {
                "DONE" -> "Workflow finished"
                "FAILED" -> "Workflow failed"
                "INTERRUPTED" -> "Workflow interrupted"
                else -> "Workflow stopped"
            }
            val done = workflow?.callsDone ?: run.callsDone ?: 0
            val failed = workflow?.callsFailed ?: run.callsFailed ?: 0
            val parts = mutableListOf(if (done + failed == 1) "1 call" else "${done + failed} calls")
            if (failed > 0) parts += "$failed failed"
            if (workflow?.endedAt != null) {
                val start = RelativeTime.parse(workflow.createdAt)
                val end = RelativeTime.parse(workflow.endedAt)
                if (start != null && end != null) parts += WikiRunsLogic.duration(Duration.between(start, end).toMillis() / 1000.0)
            }
            (workflow?.costUsd ?: run.costUsd)?.let { parts += WorkflowBlock.money(it, workflow?.maxCostUsd) }
            return WorkflowFinishedStrip(title, parts.joinToString(" · "), run.status != "DONE")
        }

        /** The server's view of the run a block names, whichever way each spells its id. */
        fun workflow(run: WorkflowFinishedRun, workflows: Collection<WorkflowRun>): WorkflowRun? =
            workflows.firstOrNull { ObjectId.same(it.id, run.runId) }
    }
}

private fun RunEvent.toolName() = fields.string("name") ?: fields.string("toolName")
private fun RunEvent.isError() = fields.string("isError") == "true" || fields.string("is_error") == "true"
