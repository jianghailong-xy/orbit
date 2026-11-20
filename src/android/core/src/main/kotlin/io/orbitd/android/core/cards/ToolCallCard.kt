package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import kotlin.math.roundToLong

/**
 * A plain tool-call approval read as the call it is, not its input as JSON (web `ToolCallBody`, board docs/mocks/tool-call-card):
 * a command as the command, a file tool as its path and change, a fetch as its URL, any other tool as its fields.
 */
object ToolCalls {
    /** Lines of a command or a file's content shown before the fold, as in the transcript's output. */
    const val foldLines = 12
    const val showLess = "Show less"
    const val showRaw = "Show raw input"
    const val hideRaw = "Hide raw input"

    /** The context key [CardCatalog] keeps the agent's own description under, once a translation took its place in the input. */
    const val originalDescription = "originalDescription"

    /** A generic tool call: none of Orbit's own asks, which keep the cards drawn for them. */
    fun plain(toolName: String): Boolean = approvalFamily(toolName) == CardFamily.TOOL &&
        toolName != ApprovalRules.mergeCheckChange && toolName != SkipMergeCheckCards.tool

    /** The card's question: what the call is about to do. */
    fun heading(toolName: String?, input: JsonObject): String = when (toolName) {
        "Bash" -> "Run a command?"
        "Edit", "MultiEdit" -> "Edit a file?"
        "Write" -> "Write a file?"
        "Read" -> "Read a file?"
        "NotebookEdit" -> "Edit a notebook?"
        "WebFetch" -> "Fetch a web page?"
        "WebSearch" -> "Search the web?"
        "Grep", "Glob" -> "Search files?"
        else -> if (str(input, "command").isNotEmpty()) "Run a command?" else "Approve tool call?"
    }

    /** How the body is drawn. */
    enum class Shape { COMMAND, EDIT, MULTI_EDIT, WRITE, FILE, FETCH, SEARCH, PATTERN, FIELDS }

    fun shape(toolName: String?, input: JsonObject): Shape = when {
        toolName == "Bash" || (str(input, "command").isNotEmpty() && toolName !in setOf("Edit", "MultiEdit", "Write")) -> Shape.COMMAND
        toolName == "Edit" -> Shape.EDIT
        toolName == "MultiEdit" -> Shape.MULTI_EDIT
        toolName == "Write" -> Shape.WRITE
        (toolName == "Read" || toolName == "NotebookEdit") && path(input).isNotEmpty() -> Shape.FILE
        toolName == "WebFetch" && str(input, "url").isNotEmpty() -> Shape.FETCH
        toolName == "WebSearch" && str(input, "query").isNotEmpty() -> Shape.SEARCH
        (toolName == "Grep" || toolName == "Glob") && str(input, "pattern").isNotEmpty() -> Shape.PATTERN
        else -> Shape.FIELDS
    }

    /** The one description line: [shown] in the owner's language when translated, the agent's own words as [original] beside it. */
    data class Description(val shown: String, val original: String? = null)

    /** [translated] is the input's description as the card shows it; [original] the agent's own, when a translation replaced it. */
    fun description(translated: String?, original: String?): Description? {
        val t = translated?.trim().orEmpty()
        val o = original?.trim().orEmpty()
        return when {
            t.isEmpty() && o.isEmpty() -> null
            t.isEmpty() -> Description(o)
            o.isEmpty() || o == t -> Description(t)
            else -> Description(t, o)
        }
    }

    /** The line the card leads with: the description, else (on a fetch) its prompt. */
    fun descriptionLine(toolName: String?, input: JsonObject, context: JsonObject = JsonObject(emptyMap())): Description? =
        description(str(input, "description"), context.text(originalDescription))
            ?: if (shape(toolName, input) == Shape.FETCH) str(input, "prompt").trim().takeIf { it.isNotEmpty() }?.let { Description(it) } else null

    data class Chip(val label: String, val warn: Boolean = false)

    /** The settings beside the body that change what the call does. */
    fun chips(toolName: String?, input: JsonObject): List<Chip> = when (shape(toolName, input)) {
        Shape.COMMAND -> buildList {
            input.positive("timeout")?.let { add(Chip("timeout ${duration(it)}")) }
            if (input.flag("run_in_background")) add(Chip("runs in background"))
            if (input.flag("dangerouslyDisableSandbox")) add(Chip("sandbox off", warn = true))
        }
        Shape.EDIT -> if (input.flag("replace_all")) listOf(Chip("Every occurrence")) else emptyList()
        Shape.MULTI_EDIT -> listOf(Chip(plural(input.objects("edits").size, "edit")))
        Shape.WRITE -> listOf(Chip(plural(lineCount(str(input, "content")), "line")))
        Shape.FILE -> {
            val offset = input.num("offset")
            val limit = input.num("limit")
            val from = offset ?: 1L
            if ((offset ?: 0L) == 0L && (limit ?: 0L) == 0L) emptyList()
            else listOf(Chip(if (limit != null && limit != 0L) "lines $from–${from + limit - 1}" else "from line $from"))
        }
        Shape.PATTERN -> listOfNotNull(str(input, "path").takeIf { it.isNotEmpty() }?.let { Chip("in ${relPath(it)}") },
            str(input, "glob").takeIf { it.isNotEmpty() }?.let { Chip(it) })
        else -> emptyList()
    }

    /** A timeout in milliseconds: whole minutes "N min", else one decimal; under a minute "N s". */
    fun duration(ms: Double): String = when {
        ms >= 60_000 && ms % 60_000 == 0.0 -> "${(ms / 60_000).toLong()} min"
        ms >= 60_000 -> (ms / 6_000).roundToLong().let { if (it % 10 == 0L) "${it / 10} min" else "${it / 10}.${it % 10} min" }
        else -> "${(ms / 1000).roundToLong()} s"
    }

    /** The file a file tool works on. */
    fun path(input: JsonObject): String = str(input, "file_path").ifEmpty { str(input, "notebook_path") }

    private val worktree = Regex("""\.orbit/worktrees/[^/]+/""")

    /** A path inside an Orbit worktree, from the worktree's root (web `relPath`). */
    fun relPath(path: String): String {
        val m = worktree.find(path) ?: return path
        return path.substring(m.range.last + 1).ifEmpty { path }
    }

    /** What a fold shows: the first [foldLines] lines until opened, and how many it hides. */
    data class Fold(val shown: String, val hidden: Int) {
        val toggle: String? get() = if (hidden == 0) null else "Show $hidden more lines"
    }

    fun fold(text: String, open: Boolean): Fold {
        val lines = text.split("\n")
        val hidden = maxOf(0, lines.size - foldLines)
        return Fold(if (open || hidden == 0) text else lines.take(foldLines).joinToString("\n"), hidden)
    }

    /** One edit as diff lines (`-`, `+`, ` `), unchanged lines past three around the change folded to one `⋯` line. */
    fun diff(old: String, new: String): String {
        val a = old.split("\n")
        val b = new.split("\n")
        var head = 0
        while (head < a.size && head < b.size && a[head] == b[head]) head++
        var tail = 0
        while (tail < a.size - head && tail < b.size - head && a[a.size - 1 - tail] == b[b.size - 1 - tail]) tail++
        fun gap(n: Int) = "⋯ $n unchanged ${if (n == 1) "line" else "lines"} ⋯"
        return buildList {
            if (head > 3) add(gap(head - 3))
            a.subList(maxOf(0, head - 3), head).forEach { add(" $it") }
            a.subList(head, a.size - tail).forEach { add("-$it") }
            b.subList(head, b.size - tail).forEach { add("+$it") }
            a.subList(a.size - tail, a.size).take(3).forEach { add(" $it") }
            if (tail > 3) add(gap(tail - 3))
        }.joinToString("\n")
    }

    /** An unknown tool's fields, less the description already on its line. */
    fun fields(input: JsonObject): JsonObject = JsonObject(input - "description")

    private val pretty = Json { prettyPrint = true }

    fun rawInput(input: JsonObject): String = pretty.encodeToString(JsonObject.serializer(), input)

    fun str(input: JsonObject, key: String): String = input.text(key).takeIf { (input[key] as? JsonPrimitive)?.isString == true }.orEmpty()
    private fun JsonObject.num(key: String): Long? = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.toLong()
    private fun JsonObject.positive(key: String): Double? = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it > 0 }
    private fun lineCount(s: String) = if (s.isEmpty()) 0 else s.split("\n").size
    private fun plural(n: Int, one: String) = "$n $one${if (n == 1) "" else "s"}"
}
