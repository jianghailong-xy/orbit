package io.orbitd.android.reader

import kotlinx.serialization.json.*

/**
 * What a folded, still-running background task's card says it is on right now (A06-17, iOS ea175e5af `liveActivity`, web
 * `SubagentLiveLine`): the last thing its sub-agent's own transcript — the records nested under the call — did. A tool call
 * reads as its label and the file it touched, or its label and what it did; a stretch of reasoning as "Thinking…"; a reply as
 * its first line. Records that say none of those (an error, an unmatched result) are passed over for the one before.
 */
internal object SubagentLiveLine {
    fun of(nested: List<TranscriptRow>): String? {
        for (child in nested.asReversed()) {
            val event = child.event
            when (event.type) {
                "tool_use" -> return ToolLine.describe(event.fields.string("name") ?: event.fields.string("toolName") ?: "tool",
                    event.fields["input"], event.toolId().orEmpty()).liveLine
                // Only a block with words of its own is a row at all (`transcriptRows`); an empty one is never "Thinking…".
                "thinking" -> if (child.thinkingText().isNotEmpty()) return "Thinking…"
                "assistant" -> event.body().lines().firstOrNull { it.isNotBlank() }?.let { return it }
            }
        }
        return null
    }
}

/**
 * A tool call's one-line description: its label, the file it touched and what it did. An approximation of OrbitKit's
 * `ToolDisplay.describe` (label, path and summary only — no symbol, tone, badge or body), which Android does not have yet: the
 * label is the tool's name with iOS's renames, the file is `file_path`'s last component (apply_patch's first file), and the
 * summary is the field iOS reads for the common tools — a command's description or the command, a search's pattern, a URL, a
 * query, an agent's description — else the call's short string fields.
 */
internal data class ToolLine(val label: String, val file: String?, val summary: String?) {
    /** iOS's live line: the label and the file, else the label and the summary, else the label. */
    val liveLine: String get() = file?.let { "$label $it" } ?: summary?.takeIf { it.isNotEmpty() }?.let { "$label $it" } ?: label

    companion object {
        fun describe(name: String, input: JsonElement?, id: String): ToolLine {
            val args = input as? JsonObject ?: JsonObject(emptyMap())
            fun text(key: String) = (args[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            fun joined(vararg keys: String) = keys.mapNotNull { text(it)?.ifEmpty { null } }.ifEmpty { null }?.joinToString("  ·  ")
            // A person's own `!` command, which the runner tags `shell-…`.
            if (id.startsWith("shell-")) return ToolLine("Shell", null, text("command"))
            val file = when (name) {
                "apply_patch" -> (args["files"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.ifEmpty { null } }?.firstOrNull()
                else -> text("file_path")
            }?.let(::fileName)?.ifEmpty { null }
            return when (name) {
                "Bash" -> ToolLine("Bash", null, text("description")?.trim()?.ifEmpty { null } ?: text("command")?.let(::collapse)?.ifEmpty { null })
                "Read", "Write", "Edit", "MultiEdit", "apply_patch" -> ToolLine(name, file, null)
                "Glob" -> ToolLine(name, null, joined("pattern", "path"))
                "Grep" -> ToolLine(name, null, joined("pattern", "path", "glob"))
                "WebFetch" -> ToolLine(name, null, text("url"))
                "WebSearch", "ToolSearch" -> ToolLine(name, null, text("query"))
                "TodoWrite" -> ToolLine("Todos", null, null)
                "ExitPlanMode" -> ToolLine("Plan", null, null)
                "AskUserQuestion" -> ToolLine("Question", null, null)
                "Task", "Agent" -> ToolLine(text("subagent_type")?.let { "$name · $it" } ?: name, null, text("description"))
                "Workflow" -> ToolLine(name, null, TaskProgressCopy.workflowTitle(args, null, null))
                else -> ToolLine(if (name.startsWith("mcp__")) name.removePrefix("mcp__").replace("__", " · ") else name, file, keyValues(args))
            }
        }

        /** The last path component, trailing slashes dropped (iOS `splitPath(…).base`). */
        private fun fileName(path: String) = path.trimEnd('/').substringAfterLast('/')

        private fun collapse(command: String) = command.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")

        /** An unknown call's short string fields, sorted by key (iOS `kvSummary`). */
        private fun keyValues(args: JsonObject): String? = args.entries.sortedBy { it.key }.mapNotNull { (key, value) ->
            (value as? JsonPrimitive)?.takeIf { it.isString }?.content?.ifEmpty { null }?.let { "$key: ${if (it.length > 60) it.take(60) + "…" else it}" }
        }.ifEmpty { null }?.joinToString("  ·  ")
    }
}
