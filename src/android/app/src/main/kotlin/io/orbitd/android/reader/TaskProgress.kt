package io.orbitd.android.reader

import kotlinx.serialization.json.*

/**
 * How far a background sub-agent or workflow has got (OrbitKit `TaskProgress`, @orbit/shared
 * `taskProgress.ts`): the runner's relay of Claude Code's `task_started`/`task_progress` frames, keyed
 * by the launching Agent or Workflow call. It arrives live as `task_progress` events, each the whole
 * picture so far, and once more as the `progress` of the durable `background_task` that ends the task.
 */
internal data class TaskProgress(
    val toolUseId: String, val taskId: String? = null, val taskType: String? = null, val description: String? = null,
    val workflowName: String? = null, val lastToolName: String? = null, val summary: String? = null,
    val usage: Usage? = null, val phases: List<Phase> = emptyList(), val agents: List<Agent> = emptyList(),
    val logs: List<String> = emptyList(),
) {
    data class Usage(val totalTokens: Int, val toolUses: Int, val durationMs: Int)
    data class Phase(val index: Int, val title: String)
    data class Agent(val index: Int, val label: String, val phaseIndex: Int? = null, val phaseTitle: String? = null,
        val state: String? = null, val model: String? = null, val tokens: Int? = null, val toolCalls: Int? = null,
        val lastToolName: String? = null, val lastToolSummary: String? = null,
        /** The Agent call whose nested transcript holds this workflow agent's activity. */
        val transcriptKey: String? = null, val error: String? = null,
        /** Answered from the workflow's journal on a resume rather than run again. */
        val cached: Boolean = false)

    companion object {
        private fun JsonObject.str(key: String) = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content?.ifEmpty { null }
        private fun JsonObject.num(key: String) = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.toInt()
        private fun JsonObject.list(key: String) = (get(key) as? JsonArray).orEmpty().filterIsInstance<JsonObject>()

        /** A `task_progress` payload or a `background_task`'s `progress`; null when it names no call to hang on. */
        fun from(payload: JsonElement?): TaskProgress? {
            val p = payload as? JsonObject ?: return null
            val id = p.str("toolUseId") ?: return null
            val usage = p["usage"] as? JsonObject
            return TaskProgress(id, p.str("taskId"), p.str("taskType"), p.str("description"), p.str("workflowName"),
                p.str("lastToolName"), p.str("summary"),
                usage?.let { Usage(it.num("totalTokens") ?: 0, it.num("toolUses") ?: 0, it.num("durationMs") ?: 0) },
                p.list("phases").mapNotNull { ph -> ph.num("index")?.let { Phase(it, ph.str("title").orEmpty()) } },
                p.list("agents").mapNotNull { a -> a.num("index")?.let { index ->
                    Agent(index, a.str("label").orEmpty(), a.num("phaseIndex"), a.str("phaseTitle"), a.str("state"), a.str("model"),
                        a.num("tokens"), a.num("toolCalls"), a.str("lastToolName"), a.str("lastToolSummary"), a.str("transcriptKey"),
                        a.str("error"), (a["cached"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true)
                } },
                (p["logs"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.takeIf { l -> l.isString }?.content })
        }
    }
}

/**
 * The words and numbers a background agent's or workflow's progress is drawn with — the card badge, the
 * per-phase agent list, the footer, the background row's one-line summary. A line-for-line port of
 * OrbitKit's `TaskProgressCopy` / @orbit/shared `taskProgressCopy.ts`, held to the same golden table
 * (`src/shared/src/taskProgressCopy.golden.json`, read by `TaskProgressCopyParityTest`).
 */
internal object TaskProgressCopy {
    enum class Lane { DONE, RUNNING, QUEUED, FAILED }

    fun lane(a: TaskProgress.Agent): Lane = when {
        a.error != null || a.state == "error" || a.state == "failed" -> Lane.FAILED
        a.state == "done" || a.cached -> Lane.DONE
        a.state == null || a.state == "start" || a.state == "queued" || a.state == "pending" -> Lane.QUEUED
        else -> Lane.RUNNING
    }

    data class PhaseGroup(val title: String, val done: Int, val total: Int, val agents: List<TaskProgress.Agent>)

    /** The agents grouped by the phase the script put them in, phases in their own order. */
    fun phaseGroups(p: TaskProgress): List<PhaseGroup> = p.agents.groupBy { it.phaseIndex ?: -1 }.toSortedMap().map { (index, members) ->
        val agents = members.sortedBy { it.index }
        val declared = p.phases.firstOrNull { it.index == index }?.title.orEmpty()
        val title = declared.ifEmpty { agents.firstOrNull { !it.phaseTitle.isNullOrEmpty() }?.phaseTitle.orEmpty() }
        PhaseGroup(title, agents.count { lane(it) == Lane.DONE }, agents.size, agents)
    }

    /** The card's badge: a workflow's agents done out of all, an agent's tool calls. */
    fun badge(p: TaskProgress): String? {
        if (p.agents.isNotEmpty()) return "${p.agents.count { lane(it) == Lane.DONE }}/${p.agents.size}"
        val calls = p.usage?.toolUses ?: 0
        return if (calls > 0) "$calls" else null
    }

    private fun tools(n: Int) = if (n == 1) "1 tool" else "$n tools"
    private fun toolCalls(n: Int) = if (n == 1) "1 tool call" else "$n tool calls"

    /** The right-hand word of an agent's row. */
    fun detail(a: TaskProgress.Agent): String {
        val l = lane(a)
        return when {
            l == Lane.FAILED -> "failed"
            a.cached -> "cached"
            l == Lane.QUEUED -> "queued"
            else -> a.toolCalls?.let(::tools).orEmpty()
        }
    }

    /** What a running agent is doing right now: its current tool and what it is doing with it. */
    fun now(a: TaskProgress.Agent): String =
        if (lane(a) != Lane.RUNNING) "" else listOfNotNull(a.lastToolName, a.lastToolSummary).filter { it.isNotEmpty() }.joinToString(" ")

    /** 45s · 17m · 1h 5m */
    fun duration(ms: Int): String {
        val s = ms / 1000
        if (s < 60) return "${s}s"
        val m = s / 60
        if (m < 60) return "${m}m"
        val h = m / 60
        return if (m % 60 == 0) "${h}h" else "${h}h ${m % 60}m"
    }

    private fun totalToolCalls(p: TaskProgress) = p.usage?.toolUses ?: p.agents.sumOf { it.toolCalls ?: 0 }

    /** The footer under the list: "113 tool calls · 17m". */
    fun footer(p: TaskProgress): String = buildList {
        totalToolCalls(p).takeIf { it > 0 }?.let { add(toolCalls(it)) }
        p.usage?.durationMs?.takeIf { it > 0 }?.let { add(duration(it)) }
    }.joinToString(" · ")

    /** The background row's second line while the work runs: where a workflow is, what an agent is doing. */
    fun trayLine(p: TaskProgress): String? {
        val parts = mutableListOf<String>()
        if (p.agents.isNotEmpty()) {
            val groups = phaseGroups(p)
            (groups.firstOrNull { it.done < it.total } ?: groups.lastOrNull())?.let { current ->
                parts += (if (current.title.isEmpty()) "" else "${current.title} ") + "${current.done}/${current.total}"
            }
            val running = p.agents.filter { lane(it) == Lane.RUNNING }
            if (running.size == 1) parts += "${running[0].label} running" else if (running.size > 1) parts += "${running.size} agents running"
        } else if (!p.lastToolName.isNullOrEmpty()) parts += p.lastToolName
        totalToolCalls(p).takeIf { it > 0 }?.let { parts += toolCalls(it) }
        return parts.ifEmpty { null }?.joinToString(" · ")
    }

    /** What a Workflow call is called: its launch receipt's summary, else the progress's description, else the script's `meta`. */
    fun workflowTitle(input: JsonElement?, result: String?, progress: TaskProgress?): String? {
        result?.let { BackgroundReceipt.workflow(it)?.second }?.let { return it }
        progress?.description?.takeIf { it.isNotEmpty() }?.let { return it }
        return ((input as? JsonObject)?.get("script") as? JsonPrimitive)?.contentOrNull?.let(::scriptMetaDescription)
    }

    /** The first `description: '…'` in a workflow script — its `meta` block opens every script. */
    fun scriptMetaDescription(script: String): String? {
        var i = script.indexOf("description").takeIf { it >= 0 }?.plus("description".length) ?: return null
        while (i < script.length && script[i].isWhitespace()) i++
        if (i >= script.length || script[i] != ':') return null
        i++
        while (i < script.length && script[i].isWhitespace()) i++
        if (i >= script.length || script[i] !in "'\"`") return null
        val quote = script[i++]
        val out = StringBuilder()
        while (i < script.length) {
            val ch = script[i]
            if (ch == '\\' && i + 1 < script.length) { out.append(script[i + 1]); i += 2; continue }
            if (ch == quote) return out.toString().ifEmpty { null }
            out.append(ch); i++
        }
        return null
    }
}

/** The runtime's own receipts for background work (OrbitKit `BackgroundSummary`, @orbit/shared `workflowLaunchReceipt`). */
internal object BackgroundReceipt {
    /** "Workflow launched in background. Task ID: <id>\nSummary: <text>\n…" → its task id and title. */
    fun workflow(result: String): Pair<String, String?>? {
        val text = result.trimStart()
        val prefix = "Workflow launched in background. Task ID: "
        if (!text.startsWith(prefix)) return null
        val id = text.drop(prefix.length).takeWhile { !it.isWhitespace() }.ifEmpty { return null }
        val summary = text.lines().firstOrNull { it.startsWith("Summary: ") }?.drop("Summary: ".length)?.trim()?.ifEmpty { null }
        return id to summary
    }

    /** "Async agent launched successfully. (…) agentId: <id> …" → the agent's id; an inline Agent answers with its report instead. */
    fun agentId(result: String): String? {
        if (!result.contains("Async agent launched")) return null
        val at = result.indexOf("agentId:").takeIf { it >= 0 } ?: return null
        return result.substring(at + "agentId:".length).trimStart()
            .takeWhile { it.isLetterOrDigit() || it == '-' || it == '_' }.ifEmpty { null }
    }
}
