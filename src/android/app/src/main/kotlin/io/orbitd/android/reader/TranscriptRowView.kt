package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.core.realtime.*
import io.orbitd.android.core.cards.AntigravityRepair
import io.orbitd.android.core.cards.DshRuntime
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.cards.withoutWakeBlocks
import io.orbitd.android.cards.TranscriptCardView
import io.orbitd.android.cards.DetailFold
import io.orbitd.android.text.*
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
internal fun TranscriptRowView(row: TranscriptRow, model: SessionReaderModel, live: Transcript?, open: (String) -> Unit, highlighted: Boolean = false,
    detailOnly: Boolean = false) {
    val event = row.event
    val clipboard = LocalClipboardManager.current
    var expanded by rememberSaveable(row.key) { mutableStateOf(false) }
    var childrenOpen by rememberSaveable(row.key) { mutableStateOf(false) }
    var fullEvent by remember(row.event) { mutableStateOf<RunEvent?>(null) }
    var fullResult by remember(row.result) { mutableStateOf<RunEvent?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }
    var copyOverflow by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val shown = fullEvent ?: event
    val result = fullResult ?: row.result
    val tool = event.type in setOf("tool_use", "tool_result")
    val cards = remember(shown) { transcriptCards(shown) }
    // The owner's answer handed to the coordinator: the row is its one line (`OwnerAnswerLineView`), not a message under a heading.
    val answerLine = cards.singleOrNull()?.takeIf { event.type == "user" && it.key.endsWith(":ownerAnswer") }
    fun loadFull(copy: Boolean = false) { scope.launch {
        loading = true; error = false
        try {
            if (fullEvent == null && event.truncated) fullEvent = model.full(event.seq)
            if (fullResult == null && row.result?.truncated == true) fullResult = model.full(row.result.seq)
            if (copy) {
                val source = if (tool) fullResult ?: row.result ?: fullEvent ?: event else fullEvent ?: event
                val value = (if (source.type == "user") source.personWords() else source.body()).ifBlank { source.fields["input"]?.toString() ?: source.payload.toString() }
                if (value.length > COPY_TEXT_LIMIT) copyOverflow = value else clipboard.setText(AnnotatedString(value))
            }
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { error = true; expanded = true }
        finally { loading = false }
    } }
    val title = when (event.type) {
        "user" -> if (cards.isNotEmpty()) "Orbit" else (event.fields["sessionMessage"] as? JsonObject)?.let { "From ${it.string("fromTitle") ?: "another Orbit session"}" } ?: "You"
        "assistant" -> "Assistant"
        "thinking" -> "Thinking"
        "tool_use" -> shown.fields.string("name") ?: shown.fields.string("toolName") ?: "Tool"
        "tool_result" -> "Tool output"
        "interrupt" -> "Interrupted"
        "error", "auth_error" -> "Error"
        "notice" -> "Notice"
        "auto_retry" -> EngineErrors.autoRetryTitle(shown.fields.string("variant") == "quota", shown.body())
        "background_task" -> "Background work"
        else -> event.type.replace('_', ' ').replaceFirstChar(Char::uppercase)
    }
    val bg = when { highlighted -> MaterialTheme.colorScheme.secondaryContainer
        event.type == "user" && answerLine == null -> MaterialTheme.colorScheme.surfaceVariant
        else -> MaterialTheme.colorScheme.surface }
    // The runtime's calls whose work outlives them: a sub-agent (Agent; Task before 2.x) and a Workflow.
    val taskKind = (shown.fields.string("name") ?: shown.fields.string("toolName")).takeIf { event.type == "tool_use" && it in setOf("Agent", "Task", "Workflow") }
    val activity = LocalTaskActivity.current
    val progress = if (taskKind != null) activity?.progress(event.toolId()) else null
    val resultText = result?.let { contentText(it.fields["content"]) ?: it.fields.string("result") }
    // A07-4: an Antigravity failure on a session Antigravity runs is its repair card, in place of the line (iOS d2737d665).
    val console = LocalSessionConsole.current
    val repair = if (event.type == "error" || event.type == "assistant") AntigravityRepair.of(shown.body().trim())?.takeIf { console?.executesAntigravity == true } else null
    // A07-5: so is a DeepSeek Harness failure on a session Harness runs (iOS e789ce3dc).
    val dshRepair = if (event.type == "error") DshRuntime.repair(shown.body().trim())?.takeIf { console?.executesDsh == true } else null
    Column(Modifier.fillMaxWidth().background(bg).padding(10.dp).testTag(row.key), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (answerLine != null) { TranscriptCardView(answerLine, open, shown); return@Column }
        if (dshRepair != null && console != null) { DshRepairCard(dshRepair, console); return@Column }
        if (repair != null && console != null) { AntigravityRepairCard(repair, console); return@Column }
        if (event.type == "auto_retry" && console != null) {
            AutoRetryCard(AutoRetryNotice(shown.body(), shown.fields.string("variant") == "quota", shown.fields["stale"] == JsonPrimitive(true),
                shown.fields["afterUserMsg"] == JsonPrimitive(true)), console)
            return@Column
        }
        if (!detailOnly) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(title, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium)
            // A workflow's agents done out of all, an agent's tool calls.
            progress?.let(TaskProgressCopy::badge)?.let { badge -> Text(badge, Modifier.padding(start = 6.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 5.dp, vertical = 1.dp),
                fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Spacer(Modifier.weight(1f))
            TextButton(enabled = !loading, onClick = { loadFull(copy = true) }) { Text("Copy message") }
        }
        if (tool) {
            val isError = result?.fields?.string("isError") == "true" || result?.fields?.string("is_error") == "true"
            val liveOutput = live?.toolOutputs?.get(event.toolId())?.string("content")
            // The call returned the moment its work started, so its own "Complete" would sit on work just begun.
            val taskRunning = taskKind != null && activity?.isRunning(event.toolId()) == true
            if (taskKind == "Workflow") TaskProgressCopy.workflowTitle(shown.fields["input"], resultText, progress)?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (!detailOnly) {
                Text(when { isError -> "Failed"; taskRunning -> "Running"; result != null || event.type == "tool_result" -> "Complete"; else -> "Awaiting result" },
                    color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { expanded = !expanded; if (expanded && (shown.truncated || result?.truncated == true)) loadFull() }) {
                    Text(if (expanded) "Hide input and output" else "Show input and output")
                }
                if (taskRunning) progress?.let(TaskProgressCopy::trayLine)?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            if (expanded || detailOnly) {
                // A workflow opens to its progress, its script folded under it; a sub-agent's totals close its transcript.
                if (taskKind == "Workflow" && progress != null) TaskProgressView(progress, row) { card ->
                    TranscriptRowView(card, model, live, open, detailOnly = true)
                }
                val script = ((shown.fields["input"] as? JsonObject)?.get("script") as? JsonPrimitive)?.contentOrNull
                if (taskKind == "Workflow" && script != null) {
                    var scriptOpen by rememberSaveable(row.key) { mutableStateOf(false) }
                    TextButton(onClick = { scriptOpen = !scriptOpen }) { Text((if (scriptOpen) "▾ " else "▸ ") + "Workflow script") }
                    if (scriptOpen) CodeText(script, "js")
                } else shown.fields["input"]?.let { input -> Text("Input", style = MaterialTheme.typography.labelMedium); CodeText(input.toString(), "json") }
                // Workflow progress rows open these same agents; the rest stay ordinary nested records.
                val shownAgents = progress?.agents.orEmpty().mapNotNull { it.transcriptKey }.toSet()
                val nested = row.children.filter { !(it.event.type == "tool_use" && it.event.toolId() in shownAgents) }
                if (taskKind != null && taskKind != "Workflow" && progress != null) TaskProgressView(progress)
                // A launch receipt says only that the work started: hidden once the progress speaks for the work,
                // and always for an agent's ack. A workflow before any progress keeps it.
                val receipt = !isError && resultText != null && (if (taskKind == "Workflow") BackgroundReceipt.workflow(resultText) != null
                    else taskKind != null && BackgroundReceipt.agentId(resultText) != null)
                val output = (if (receipt && (progress != null || taskKind != "Workflow")) null else resultText)
                    ?: (if (result == null) contentText(shown.fields["content"]) ?: shown.fields.string("result") ?: liveOutput else null)
                output?.let { Text("Output", style = MaterialTheme.typography.labelMedium); CodeText(it) }
                contentImages((result ?: shown).fields["content"]).forEach { TranscriptImage(it, "Tool result image", open) }
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (error) TextButton(onClick = { loadFull() }) { Text("Couldn't load full output · Retry") }
                if (nested.isNotEmpty()) {
                    Text("${nested.size} subagent records", style = MaterialTheme.typography.labelMedium)
                    nested.take(4).forEach { child -> TranscriptRowView(child, model, live, open) }
                    if (nested.size > 4) TextButton(onClick = { childrenOpen = true }) { Text("Open subagent transcript") }
                }
            } else liveOutput?.let { Text(it.takeLast(240), maxLines = 3, style = MaterialTheme.typography.bodySmall) }
        } else if (event.type in setOf("error", "notice", "auto_retry")) {
            EngineLine(shown)
            if (shown.truncated) TextButton(enabled = !loading, onClick = { loadFull() }) { Text(if (error) "Couldn't load full message · Retry" else "Read full message") }
        } else if (event.type == "thinking") {
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide thinking" else "Show thinking") }
            if (expanded) MarkdownText(shown.body(), open = open)
        } else {
            cards.forEach { TranscriptCardView(it, open, shown) }
            val atts = (shown.fields["attachments"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
            val attachmentOnly = shown.type == "user" && shown.body().isBlank() && atts.isNotEmpty()
            // What delivery appended is not the person's: their bubble holds their words, the card the rest.
            val note = shown.fields.string("controlPlaneNote")?.takeIf { it.isNotBlank() }
                // A wake's blocks are its line (A08-11); only what else the note carried is an attached entry.
                ?.let { if (cards.any { card -> card.key.endsWith(":wake") }) withoutWakeBlocks(it) else it }?.takeIf { it.isNotBlank() }
            val words = if (shown.type == "user") shown.personWords() else shown.body()
            if (cards.isEmpty() && !attachmentOnly) { if (note == null || words.isNotBlank()) MarkdownText(words.ifBlank { shown.payload.toString() }, open = open) }
            else if (shown.body().isNotBlank()) DetailFold("Orbit attached") { MarkdownText(shown.body(), open = open) }
            note?.let { AttachedNoteCard(it.trim()) }
            atts.forEach { attachment -> attachment.string("id")?.let { id ->
                val name = attachment.string("name") ?: "Attachment"
                if (attachment.string("mime")?.startsWith("image/") == true) TranscriptImage("orbit-attachment:$id", name, open)
                else TextButton(onClick = { open("orbit-attachment:$id") }) { Text(name) }
            } }
            (shown.fields["sessionMessage"] as? JsonObject)?.let { sender ->
                Text("Sent by another Orbit session, not by you", style = MaterialTheme.typography.bodySmall)
                sender.string("fromSessionId")?.let { id -> TextButton(onClick = { open("orbit-session:$id") }) { Text("Open sender session") } }
            }
            if (shown.truncated) TextButton(enabled = !loading, onClick = { loadFull() }) { Text(if (error) "Couldn't load full message · Retry" else "Read full message") }
        }
    }
    copyOverflow?.let { LongTextDialog(it) { copyOverflow = null } }
    if (childrenOpen) Dialog({ childrenOpen = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) { Column {
            TextButton(onClick = { childrenOpen = false }) { Text("Close subagent transcript") }
            val shownAgents = progress?.agents.orEmpty().mapNotNull { it.transcriptKey }.toSet()
            LazyColumn { items(row.children.filter { !(it.event.type == "tool_use" && it.event.toolId() in shownAgents) }, key = { it.key }) {
                TranscriptRowView(it, model, live, open) } }
        } }
    }
}

/** A failure or heads-up the engine reported, drawn as iOS's label: red for an error, the warning tone at label size for a notice. */
@Composable
private fun EngineLine(event: RunEvent) {
    val text = event.body()
    when (event.type) {
        "error" -> ToolFailureSummary.parse(text)?.let { ToolFailureCard(text, it) }
            ?: GlyphLine("⚠", text, MaterialTheme.colorScheme.error, MaterialTheme.typography.bodyLarge)
        "notice" -> GlyphLine("⚠", text, LocalOrbitColors.current.needsYou, MaterialTheme.typography.labelLarge)
        // The self-healing failure's sentence; the card around it (countdown, Retry) is the auto-retry card's.
        else -> GlyphLine("◷", text, MaterialTheme.colorScheme.onSurfaceVariant, MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun GlyphLine(glyph: String, text: String, color: Color, style: TextStyle) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(glyph, color = color, style = style, modifier = Modifier.clearAndSetSemantics { })
        SelectionContainer { Text(text, color = color, style = style) }
    }
}

/** A tool's failure folded to the call, its path and a stable reason, with the engine's whole log one tap away (iOS `ToolFailureCardView`). */
@Composable
private fun ToolFailureCard(message: String, summary: ToolFailureSummary) {
    var expanded by rememberSaveable(message) { mutableStateOf(false) }
    val error = MaterialTheme.colorScheme.error
    Column(Modifier.fillMaxWidth().drawBehind { drawRect(error, size = size.copy(width = 3.dp.toPx())) }.padding(start = 11.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(summary.tool ?: "Tool call", Modifier.weight(1f, fill = false), fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("Failed", color = error, style = MaterialTheme.typography.labelLarge, maxLines = 1)
        }
        summary.path?.let { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.StartEllipsis) }
        Text(summary.reason, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2, overflow = TextOverflow.Ellipsis)
        TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide full log" else "Show full log") }
        if (expanded) SelectionContainer {
            Text(message, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(8.dp),
                fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

