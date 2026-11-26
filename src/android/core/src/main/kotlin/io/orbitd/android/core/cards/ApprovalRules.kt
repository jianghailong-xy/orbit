package io.orbitd.android.core.cards

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

@Serializable
data class PermissionRule(val toolName: String, val ruleContent: String? = null)

/** Mirrors shared/bashRules.ts; the shared fixture is also consumed by OrbitKit. */
object ApprovalRules {
    /** Changing a project's merge check (OrbitKit `Approvals.isMergeCheckChange`): the server writes it only against a card a
     * person answered, so a standing rule would turn every later proposal into a refusal the agent cannot read. */
    const val mergeCheckChange = "orbit_project_update_integration"
    private val asks = setOf("AskUserQuestion", "ExitPlanMode", "orbit_task_create", "orbit_project_create",
        "orbit_task_batch", "orbit_dag_change", "orbit_blocker_resolve", "orbit_provider_create",
        "orbit_provider_update", "orbit_provider_delete", mergeCheckChange, SkipMergeCheckCards.tool, DeleteCards.runnerTool, DeleteCards.workspaceTool,
        WorkspaceWriteCards.createTool, WorkspaceWriteCards.updateTool, "orbit_browser_clear_logins")
    private val shells = setOf("bash", "/bin/bash", "/usr/bin/bash", "sh", "/bin/sh", "/usr/bin/sh", "zsh", "/bin/zsh", "/usr/bin/zsh")
    private val commandKeywords = setOf("if", "then", "elif", "else", "while", "until", "do", "time", "coproc")
    /** Words that lead a command without being its program: what follows them is judged instead. */
    private val leadingKeywords = commandKeywords + setOf("fi", "done", "esac", "!", "{", "}")
    /** Words that open a construct whose next word is a name or a pattern, not a program to run. */
    private val constructHeaders = setOf("for", "select", "case", "function")
    /** Programs whose second word picks what they do (`git status`); any other program's second word is an argument. */
    private val subcommandPrograms = setOf(
        "git", "gh", "npm", "pnpm", "yarn", "bun", "npx", "deno", "node-gyp",
        "docker", "podman", "kubectl", "helm", "terraform", "gcloud", "aws", "az",
        "go", "cargo", "rustup", "swift", "xcrun", "dotnet", "mvn", "gradle", "gradlew", "flutter", "adb",
        "pip", "pip3", "uv", "poetry", "conda", "brew", "apt", "apt-get",
        "systemctl", "launchctl", "defaults", "make", "orbit")
    /** Programs that change files or the environment, or run whatever they are given: allowed once, never remembered. */
    private val neverRemembered = setOf(
        "cp", "mv", "rm", "rmdir", "ln", "chmod", "chown", "chgrp", "tee", "dd", "touch", "truncate",
        "mkdir", "install", "rsync", "unlink", "shred",
        "export", "env", "set", "unset", "declare", "typeset", "readonly", "local", "alias", "source", ".",
        "eval", "exec", "sudo", "doas", "xargs", "nohup", "timeout", "nice", "command", "builtin")
    fun remember(tool: String, input: JsonObject): List<PermissionRule> = when {
        tool.isBlank() || tool in asks -> emptyList()
        tool == "Bash" && input.flag("orbitScheduleCheckOnly") -> input.text("command")?.takeIf { it.isNotBlank() }
            ?.let { listOf(PermissionRule("Bash", it)) }.orEmpty()
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
    /** Whether Create and start leads the card, ahead of Create task (web `createAndStartLeads`): whenever it is offered, except on
     * a task the agent filed with `autoRunWhenReady: false`. That is a hold someone asked for, so the first press does not start it. */
    fun createAndStartLeads(tool: String, input: JsonObject): Boolean = offersCreateAndStart(tool, input) &&
        (input["autoRunWhenReady"] as? JsonPrimitive)?.booleanOrNull != false
    private class Heredoc(val delimiter: String, val stripTabs: Boolean, val quoted: Boolean)
    /** The heredoc whose `<<` or `<<-` is at [start] and the index just past its word, or null when no word follows. */
    private fun readHeredoc(command: String, start: Int): Pair<Heredoc, Int>? {
        var i = start + 2
        val stripTabs = command.getOrNull(i) == '-'
        if (stripTabs) i++
        while (command.getOrNull(i) == ' ' || command.getOrNull(i) == '\t') i++
        val wordStart = i
        val delimiter = StringBuilder()
        var quoted = false
        while (i < command.length && command[i] !in " \t\n;&|()<>") {
            val c = command[i++]
            when (c) {
                '\'', '"' -> {
                    val end = command.indexOf(c, i).let { if (it < 0) command.length else it }
                    delimiter.append(command, i, end)
                    i = end + 1
                    quoted = true
                }
                '\\' -> { command.getOrNull(i++)?.let { delimiter.append(it) }; quoted = true }
                else -> delimiter.append(c)
            }
        }
        return if (i == wordStart) null else Heredoc(delimiter.toString(), stripTabs, quoted) to i
    }
    /** Where the bodies of these heredocs end, reading from the line at [start]: just past the last one's terminator, or at the
     * end of the command when a terminator never comes. Unless the delimiter is quoted, a backslash-newline joins two lines,
     * and shells differ on whether what it joins can terminate, so nothing past such a line is read. */
    private fun endOfHeredocBodies(command: String, start: Int, heredocs: List<Heredoc>): Int {
        var i = start
        for (heredoc in heredocs) {
            fun terminates(text: String) = (if (heredoc.stripTabs) text.trimStart('\t') else text) == heredoc.delimiter
            while (true) {
                if (i >= command.length) return command.length
                val lineStart = i
                while (i < command.length && command[i] != '\n') {
                    i += if (!heredoc.quoted && command[i] == '\\') 2 else 1
                }
                val line = command.substring(lineStart, minOf(i, command.length))
                i++
                if (terminates(line)) break
                if (terminates(line.replace("\\\n", ""))) return command.length
            }
        }
        return i
    }
    /** Where a command substitution opens at [i], as the index its body starts at, or -1. `$((` is arithmetic. */
    private fun substitutionBody(command: String, i: Int): Int = when {
        command[i] == '`' -> i + 1
        command[i] == '$' && command.getOrNull(i + 1) == '(' && command.getOrNull(i + 2) != '(' -> i + 2
        else -> -1
    }
    /** Where the command substitution whose body starts at [start] ends: just past the `)` or backtick that closes it, or at
     * the end of the command when nothing does. Quotes and nested substitutions inside are read so they do not end it early. */
    private fun endOfSubstitution(command: String, start: Int, backtick: Boolean): Int {
        var depth = 1
        var i = start
        while (i < command.length) {
            val c = command[i]
            when {
                c == '\\' -> i += 2
                backtick -> { if (c == '`') return i + 1; i++ }
                c == '\'' -> i = command.indexOf('\'', i + 1).let { if (it < 0) command.length else it + 1 }
                c == '"' -> {
                    i++
                    while (i < command.length && command[i] != '"') {
                        val body = substitutionBody(command, i)
                        i = when {
                            command[i] == '\\' -> i + 2
                            body >= 0 -> endOfSubstitution(command, body, command[i] == '`')
                            else -> i + 1
                        }
                    }
                    i++
                }
                c == '`' -> i = endOfSubstitution(command, i + 1, true)
                c == '(' -> { depth++; i++ }
                c == ')' -> { if (--depth == 0) return i + 1; i++ }
                else -> i++
            }
        }
        return command.length
    }
    /** The prefix "always allow" remembers for one sub-command, read with its substitutions replaced by `$_`, or null: leading
     * keywords skipped, a second word only for a sub-command program, nothing for a program that changes files or the environment. */
    private fun rememberedPrefix(head: String): String? {
        val words = head.trim().split(Regex("\\s+"))
        var i = 0
        while (i < words.size && (words[i] in leadingKeywords || Regex("^[A-Za-z_][A-Za-z0-9_]*=.*").matches(words[i]))) i++
        val program = words.getOrNull(i)?.takeIf { it !in constructHeaders && Regex("^[A-Za-z./_-][\\w./-]*$").matches(it) }
            ?: return null
        val name = program.substringAfterLast('/')
        if (name in neverRemembered) return null
        if (name !in subcommandPrograms) return program
        val sub = words.getOrNull(i + 1)?.takeIf { Regex("^[A-Za-z][\\w-]*$").matches(it) } ?: return null
        return "$program $sub"
    }
    fun bash(command: String): List<PermissionRule> {
        val segments = mutableListOf<String>()
        val heads = mutableListOf<String>()
        val part = StringBuilder()
        // The sub-command with each command substitution replaced by `$_`: what a rule is taken from.
        val head = StringBuilder()
        // The quote that is open: ' and " as themselves, $ for ANSI-C $'...', which closes on '.
        var quote: Char? = null
        var wordStart = true
        val heredocs = mutableListOf<Heredoc>()
        var inArithmetic = false
        var i = 0
        while (i < command.length) {
            val body = if (quote == null || quote == '"') substitutionBody(command, i) else -1
            if (body >= 0) {
                // A command substitution runs a second command to build this one: one piece of this sub-command, never split
                // at what it holds, and no rule is taken from inside it.
                val end = endOfSubstitution(command, body, command[i] == '`')
                part.append(command, i, end); head.append("\$_")
                i = end; wordStart = false
                continue
            }
            val start = part.length
            val c = command[i++]
            val angles = quote == null && c == '<' && command.getOrNull(i) == '<' && !inArithmetic
            val hereString = angles && command.getOrNull(i + 1) == '<'
            val heredoc = if (angles && !hereString) readHeredoc(command, i - 1) else null
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
                // A here-string: its text is the word after it, on this line.
                hereString -> { part.append("<<<"); i += 2; wordStart = true }
                heredoc != null -> {
                    val (read, end) = heredoc
                    heredocs += read
                    part.append(command, i - 1, minOf(end, command.length))
                    i = end
                }
                c == ';' || c == '\n' || c == '|' || (c == '&' && command.getOrNull(i) == '&') -> {
                    if ((c == '&' || c == '|') && command.getOrNull(i) == c) i++
                    segments += part.toString(); part.clear(); heads += head.toString(); head.clear(); wordStart = true; inArithmetic = false
                    if (c == '\n' && heredocs.isNotEmpty()) { i = endOfHeredocBodies(command, i, heredocs); heredocs.clear() }
                }
                else -> {
                    // Between $(( and )) a << is a shift. A bare (( is arithmetic only in some shells, and a plain sh takes the << in it for a heredoc.
                    if (c == '(' && command.getOrNull(i - 2) == '(' && command.getOrNull(i - 3) == '$') inArithmetic = true
                    if (c == ')' && command.getOrNull(i - 2) == ')') inArithmetic = false
                    part.append(c); wordStart = c in " \t&()<>"
                }
            }
            if (part.length > start) head.append(part, start, part.length)
        }
        segments += part.toString()
        heads += head.toString()
        val tokens = segments.map { segment -> segment.trim().split(Regex("\\s+"))
            .dropWhile { Regex("^[A-Za-z_][A-Za-z0-9_]*=.*").matches(it) } }
        if (tokens.any { it.firstOrNull() in shells &&
                (it.getOrNull(1) == "--command" || Regex("^-[A-Za-z]*c[A-Za-z]*$").matches(it.getOrNull(1) ?: "")) }) return emptyList()
        return heads.mapNotNull(::rememberedPrefix).filter { it !in commandKeywords }.distinct().map { PermissionRule("Bash", "$it:*") }
    }
}
