package io.orbitd.android.core.cards

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class PermissionRule(val toolName: String, val ruleContent: String? = null)

/** Mirrors shared/bashRules.ts; the shared fixture is also consumed by OrbitKit. */
object ApprovalRules {
    private val asks = setOf("AskUserQuestion", "ExitPlanMode", "orbit_task_create", "orbit_project_create",
        "orbit_task_batch", "orbit_dag_change", "orbit_blocker_resolve", "orbit_provider_create",
        "orbit_provider_update", "orbit_provider_delete")
    private val shells = setOf("bash", "/bin/bash", "/usr/bin/bash", "sh", "/bin/sh", "/usr/bin/sh", "zsh", "/bin/zsh", "/usr/bin/zsh")
    fun remember(tool: String, input: JsonObject): List<PermissionRule> = when {
        tool.isBlank() || tool in asks -> emptyList()
        tool == "Bash" -> bash(input.text("command") ?: "")
        else -> listOf(PermissionRule(tool))
    }
    fun bash(command: String): List<PermissionRule> {
        val segments = mutableListOf<String>()
        val part = StringBuilder()
        var quote: Char? = null
        var i = 0
        while (i < command.length) {
            val c = command[i++]
            when {
                c == '\\' && i < command.length -> { part.append(c); part.append(command[i++]) }
                quote != null -> { part.append(c); if (c == quote) quote = null }
                c == '\'' || c == '"' -> { quote = c; part.append(c) }
                c == ';' || c == '\n' || c == '|' || (c == '&' && command.getOrNull(i) == '&') -> {
                    if ((c == '&' || c == '|') && command.getOrNull(i) == c) i++
                    segments += part.toString(); part.clear()
                }
                else -> part.append(c)
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
        }.distinct().map { PermissionRule("Bash", "$it:*") }
    }
}
