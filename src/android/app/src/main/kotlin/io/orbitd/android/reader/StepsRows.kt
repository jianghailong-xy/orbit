package io.orbitd.android.reader

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.core.realtime.Transcript
import kotlinx.serialization.json.JsonObject

/**
 * The steps line (web `StepsLine` / `stepsSummary` / `groupToolRuns`, board docs/mocks/session-compact-steps): everything a turn
 * does between two things it says — its thinking and its tool calls, however few — folds into one muted line, "Thought for 15s,
 * listed 1 directory, ran 2 shell commands", so the replies read as one thread. A tap opens the rows it stands for; a call still in
 * flight is drawn under the line on its own and joins it once it answers. A failure unfolds nothing: the line counts it, in red.
 */
internal object Steps {
    private val CARD_TOOLS = setOf("AskUserQuestion", "ExitPlanMode", "mcp__orbit__session_create", "mcp__orbit__task_create_batch",
        "mcp__orbit__task_create", "mcp__orbit__project_create", "Agent", "Task", "Workflow")
    private val FILE_KINDS = setOf("read", "edit", "write")

    /** A row one steps line can stand in for (web `isGroupableTool`): reasoning, or a plain call — not a call that is its own card,
     * that carries a sub-agent's records, or a `!`-shell command the reader ran. A call that answered with a picture folds too
     * (owner, 11-11): an agent reading its own screenshot is a step. */
    fun groupable(row: TranscriptRow): Boolean {
        val event = row.event
        if (event.type == "thinking") return true
        if (event.type != "tool_use" || row.children.isNotEmpty()) return false
        if (event.toolId()?.startsWith("shell-") == true) return false
        return name(event) !in CARD_TOOLS
    }

    /** Each run of groupable rows as one steps row, any count, a single one included. */
    fun group(rows: List<TranscriptRow>): List<TranscriptRow> {
        val out = ArrayList<TranscriptRow>(rows.size)
        var run = ArrayList<TranscriptRow>()
        fun flush() {
            if (run.isNotEmpty()) out += TranscriptRow(run.first().event, steps = run)
            run = ArrayList()
        }
        rows.forEach { row -> if (groupable(row)) run += row else { flush(); out += row } }
        flush()
        return out
    }

    /** The line's words: the thinking first, then each kind of call in the order it came, first letter capitalised. */
    fun summary(steps: List<TranscriptRow>): String {
        var thought = false
        var thinkMs = 0L
        class Kind(val phrase: (Int) -> String) { var calls = 0; val files = HashSet<String>(); var unnamed = 0 }
        val kinds = LinkedHashMap<String, Kind>()
        steps.forEach { row ->
            if (row.event.type == "thinking") { thought = true; thinkMs += row.thinkingMs() ?: 0; return@forEach }
            val (key, phrase) = verb(row.event)
            val kind = kinds.getOrPut(key) { Kind(phrase) }
            kind.calls++
            val file = if (key in FILE_KINDS) file(row.event) else null
            if (file != null) kind.files += file else kind.unnamed++
        }
        val parts = kinds.map { (key, kind) -> kind.phrase(if (key in FILE_KINDS) kind.files.size + kind.unnamed else kind.calls) }.toMutableList()
        if (thought) parts.add(0, if (thinkMs > 0) "Thought for ${ThinkingSummary.duration(thinkMs / 1000.0)}" else "Thought")
        return parts.joinToString(", ").replaceFirstChar(Char::uppercase)
    }

    /** A call with no answer yet, where nothing after it in [events] ended its turn: still in flight. */
    fun inFlight(row: TranscriptRow, events: List<RunEvent>): Boolean = row.event.type == "tool_use" && row.result == null &&
        events.none { it.seq > row.event.seq && it.type in setOf("turn_end", "interrupt") }

    fun failed(row: TranscriptRow): Boolean = row.result?.fields?.let { it.string("isError") == "true" || it.string("is_error") == "true" } == true

    /** What a call in flight is doing, in its own words: the description, else the command or the thing it reads. */
    fun purpose(event: RunEvent): String {
        val input = input(event)
        return input?.string("description")?.takeIf { it.isNotBlank() }
            ?: input?.string("command")?.let(::shellCommand)
            ?: input?.string("file_path") ?: input?.string("path") ?: input?.string("pattern") ?: input?.string("query") ?: input?.string("url")
            ?: name(event) ?: "Tool"
    }

    /** The command under a described shell call's purpose; nothing for any other call, whose purpose already says it. */
    fun command(event: RunEvent): String? {
        val input = input(event) ?: return null
        if (name(event) != "Bash" || input.string("description").isNullOrBlank()) return null
        return input.string("command")?.let(::shellCommand)?.takeIf { it.isNotBlank() }
    }

    private fun name(event: RunEvent) = event.fields.string("name") ?: event.fields.string("toolName")
    private fun input(event: RunEvent) = event.fields["input"] as? JsonObject
    private fun file(event: RunEvent) = input(event)?.let { it.string("file_path") ?: it.string("path") }?.takeIf { it.isNotEmpty() }

    private fun plural(n: Int, one: String, many: String) = "$n ${if (n == 1) one else many}"

    private fun verb(event: RunEvent): Pair<String, (Int) -> String> = when (name(event)) {
        "Bash" -> if (shellCommand(input(event)?.string("command").orEmpty()).split(Regex("\\s+")).first() in setOf("ls", "tree", "find"))
            "list" to { n -> "listed ${plural(n, "directory", "directories")}" }
            else "shell" to { n -> "ran ${plural(n, "shell command", "shell commands")}" }
        "Read" -> "read" to { n -> "read ${plural(n, "file", "files")}" }
        "Grep", "Glob" -> "search" to { n -> "searched ${plural(n, "time", "times")}" }
        "Edit", "MultiEdit", "apply_patch" -> "edit" to { n -> "edited ${plural(n, "file", "files")}" }
        "Write" -> "write" to { n -> "wrote ${plural(n, "file", "files")}" }
        "WebFetch" -> "fetch" to { n -> "fetched ${plural(n, "page", "pages")}" }
        "WebSearch" -> "web" to { n -> "searched the web ${plural(n, "time", "times")}" }
        "TodoWrite" -> "todo" to { _ -> "updated the plan" }
        else -> "other" to { n -> "used ${plural(n, "tool", "tools")}" }
    }

    /** Codex wraps every shell call as `/bin/bash -lc "<command>"` (web `shellCommandSummary`): the command is what is inside. */
    fun shellCommand(command: String): String {
        val text = command.trim()
        val wrapped = Regex("^(?:\\S*/)?(?:ba|z)?sh\\s+-[A-Za-z]*c\\s+([\\s\\S]+)$").find(text)?.groupValues?.get(1)?.trim() ?: return text
        val quoted = wrapped.length >= 2 && (wrapped.first() == '"' && wrapped.last() == '"' || wrapped.first() == '\'' && wrapped.last() == '\'')
        return if (quoted) wrapped.substring(1, wrapped.length - 1) else wrapped
    }
}

/**
 * A steps row: the line, its cards once opened, and — while the conversation is live — the calls still in flight under it.
 * [highlighted]: a jump landed on a record inside it, so it opens to show that record.
 */
@Composable
internal fun StepsRowView(row: TranscriptRow, model: FullEvents, live: Transcript?, open: (String) -> Unit, highlighted: Boolean) {
    var expanded by rememberSaveable(row.key) { mutableStateOf(highlighted) }
    LaunchedEffect(highlighted) { if (highlighted) expanded = true }
    val events = live?.events
    val running = if (events == null) emptyList() else row.steps.filter { Steps.inFlight(it, events) }
    val settled = row.steps.filter { it !in running }
    val line = remember(settled) { Steps.summary(settled) }
    val failed = settled.count(Steps::failed)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val error = MaterialTheme.colorScheme.error
    Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp).testTag("steps:${row.event.seq}"),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (line.isNotEmpty()) Row(Modifier.fillMaxWidth().heightIn(min = 32.dp)
            .clickable(onClickLabel = if (expanded) "Hide steps" else "Show steps", role = Role.Button) { expanded = !expanded }
            .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }.testTag("steps-line"),
            horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(buildAnnotatedString {
                append(line)
                if (failed > 0) withStyle(SpanStyle(color = error)) { append(" · $failed failed") }
            }, Modifier.weight(1f, fill = false), color = muted, style = MaterialTheme.typography.labelLarge)
            Text("▸", Modifier.rotate(if (expanded) 90f else 0f).clearAndSetSemantics { }, color = MaterialTheme.colorScheme.outline,
                style = MaterialTheme.typography.labelLarge)
        }
        if (expanded) {
            val rule = MaterialTheme.colorScheme.outlineVariant
            Column(Modifier.fillMaxWidth().drawBehind { drawRect(rule, size = size.copy(width = 2.dp.toPx())) }.padding(start = 8.dp)
                .testTag("steps-detail")) {
                row.steps.forEach { step -> key(step.key) { TranscriptRowView(step, model, live, open) } }
            }
        } else running.forEach { step -> key(step.key) { StepInFlight(step.event) } }
    }
}

/** A call in flight under its steps line: what it is doing, then the command it runs. */
@Composable
private fun StepInFlight(event: RunEvent) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().testTag("step-live:${event.seq}")) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("●", Modifier.clearAndSetSemantics { }, color = muted, style = MaterialTheme.typography.labelSmall)
            Text(Steps.purpose(event), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Steps.command(event)?.let { command ->
            Text("⎿ $ $command", Modifier.padding(start = 4.dp), color = muted, fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
