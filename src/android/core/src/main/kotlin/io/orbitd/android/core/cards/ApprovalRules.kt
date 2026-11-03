package io.orbitd.android.core.cards

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class PermissionRule(val toolName: String, val ruleContent: String? = null)

/** Mirrors shared/bashRules.ts; the shared fixture is also consumed by OrbitKit. */
object ApprovalRules {
    /** Changing a project's merge check (OrbitKit `Approvals.isMergeCheckChange`): the server writes it only against a card a
     * person answered, so a standing rule would turn every later proposal into a refusal the agent cannot read. */
    const val mergeCheckChange = "orbit_project_update_integration"
    private val asks = setOf("AskUserQuestion", "ExitPlanMode", "orbit_task_create", "orbit_project_create",
        "orbit_task_batch", "orbit_dag_change", "orbit_blocker_resolve", "orbit_provider_create",
        "orbit_provider_update", "orbit_provider_delete", mergeCheckChange, DeleteCards.runnerTool, DeleteCards.workspaceTool,
        WorkspaceWriteCards.createTool, WorkspaceWriteCards.updateTool)
    private val shells = setOf("bash", "/bin/bash", "/usr/bin/bash", "sh", "/bin/sh", "/usr/bin/sh", "zsh", "/bin/zsh", "/usr/bin/zsh")
    private val commandKeywords = setOf("if", "then", "elif", "else", "while", "until", "do", "time", "coproc")
    fun remember(tool: String, input: JsonObject): List<PermissionRule> = when {
        tool.isBlank() || tool in asks -> emptyList()
        tool == "Bash" -> bash(input.text("command") ?: "")
        else -> listOf(PermissionRule(tool))
    }
    /** Whether the single-task card offers Create and start (web `offersCreateAndStart`): only when the server's forecast says
     * nothing would start the task by itself (`needsManualStart` is 1). One that starts on its own, now or at its runAt, waits on a
     * prerequisite, cannot run or waits for its project to start has nothing for the press to add, and a card whose forecast
     * could not be read says nothing either way. Nor a card the server did not mark `acceptsStartAfterCreate`: its runner, or the
     * server itself, predates the choice and would only create the task. */
    fun offersCreateAndStart(tool: String, input: JsonObject): Boolean = tool == "orbit_task_create" &&
        input.flag("acceptsStartAfterCreate") && input.obj("preview")?.number("needsManualStart") == 1
    fun bash(command: String): List<PermissionRule> {
        val segments = mutableListOf<String>()
        val part = StringBuilder()
        // The quote that is open: ' and " as themselves, $ for ANSI-C $'...', which closes on '.
        var quote: Char? = null
        var wordStart = true
        var i = 0
        while (i < command.length) {
            val c = command[i++]
            when {
                quote == '\'' -> { part.append(c); if (c == '\'') quote = null }
                quote != null && c == '\\' && i < command.length -> { part.append(c); part.append(command[i++]) }
                quote != null -> { part.append(c); if (c == (if (quote == '$') '\'' else quote)) quote = null }
                c == '\\' && i < command.length -> {
                    part.append(c)
                    // A line continuation is as if neither character were there, so the word state stays.
                    if (command[i] != '\n') wordStart = false
                    part.append(command[i++])
                }
                c == '\'' || c == '"' -> { quote = c; part.append(c); wordStart = false }
                c == '$' && command.getOrNull(i) == '\'' -> { quote = '$'; part.append(c); part.append(command[i++]); wordStart = false }
                c == '#' && wordStart -> while (i < command.length && command[i] != '\n') i++
                c == ';' || c == '\n' || c == '|' || (c == '&' && command.getOrNull(i) == '&') -> {
                    if ((c == '&' || c == '|') && command.getOrNull(i) == c) i++
                    segments += part.toString(); part.clear(); wordStart = true
                }
                else -> { part.append(c); wordStart = c in " \t&()<>" }
            }
        }
        segments += part.toString()
        val tokens = segments.map { segment -> segment.trim().split(Regex("\\s+"))
            .dropWhile { Regex("^[A-Za-z_][A-Za-z0-9_]*=.*").matches(it) } }
        if (tokens.any { it.firstOrNull() in shells &&
                (it.getOrNull(1) == "--command" || Regex("^-[A-Za-z]*c[A-Za-z]*$").matches(it.getOrNull(1) ?: "")) }) return emptyList()
        return tokens.mapNotNull { words ->
            val program = words.firstOrNull()?.takeIf { Regex("^[A-Za-z./_-][\\w./-]*$").matches(it) } ?: return@mapNotNull null
            val sub = words.getOrNull(1)?.takeIf { Regex("^[A-Za-z][\\w-]*$").matches(it) }
            if (sub == null) program else "$program $sub"
        }.filter { it !in commandKeywords }.distinct().map { PermissionRule("Bash", "$it:*") }
    }
}
