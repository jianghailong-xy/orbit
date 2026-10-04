package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.core.realtime.*
import io.orbitd.android.text.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
internal fun TranscriptRowView(row: TranscriptRow, model: SessionReaderModel, live: Transcript?, open: (String) -> Unit, highlighted: Boolean = false) {
    val event = row.event
    val clipboard = LocalClipboardManager.current
    var expanded by rememberSaveable(row.key) { mutableStateOf(false) }
    var childrenOpen by rememberSaveable(row.key) { mutableStateOf(false) }
    var fullEvent by remember(row.event) { mutableStateOf<RunEvent?>(null) }
    var fullResult by remember(row.result) { mutableStateOf<RunEvent?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val shown = fullEvent ?: event
    val result = fullResult ?: row.result
    val tool = event.type in setOf("tool_use", "tool_result")
    fun loadFull() { scope.launch {
        loading = true; error = false
        try {
            if (event.truncated) fullEvent = model.full(event.seq)
            if (row.result?.truncated == true) fullResult = model.full(row.result.seq)
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { error = true }
        finally { loading = false }
    } }
    val title = when (event.type) {
        "user" -> (event.fields["sessionMessage"] as? JsonObject)?.let { "From ${it.string("fromTitle") ?: "another Orbit session"}" } ?: "You"
        "assistant" -> "Assistant"
        "thinking" -> "Thinking"
        "tool_use" -> shown.fields.string("name") ?: shown.fields.string("toolName") ?: "Tool"
        "tool_result" -> "Tool output"
        "interrupt" -> "Interrupted"
        "error", "auth_error" -> "Error"
        "auto_retry" -> "Retrying"
        "background_task" -> "Background work"
        else -> event.type.replace('_', ' ').replaceFirstChar(Char::uppercase)
    }
    val bg = when { highlighted -> MaterialTheme.colorScheme.secondaryContainer
        event.type == "user" -> MaterialTheme.colorScheme.surfaceVariant
        else -> MaterialTheme.colorScheme.surface }
    Column(Modifier.fillMaxWidth().background(bg).padding(10.dp).testTag(row.key), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(title, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium)
            TextButton(onClick = { clipboard.setText(AnnotatedString(if (tool) contentText(result?.fields?.get("content")) ?: shown.body() else shown.body())) }) { Text("Copy message") }
        }
        if (tool) {
            val isError = result?.fields?.string("isError") == "true" || result?.fields?.string("is_error") == "true"
            val liveOutput = live?.toolOutputs?.get(event.toolId())?.string("content")
            val progress = live?.taskProgress?.get(event.toolId())
            Text(when { isError -> "Failed"; result != null || event.type == "tool_result" -> "Complete"; else -> "Awaiting result" },
                color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { expanded = !expanded; if (expanded && (shown.truncated || result?.truncated == true)) loadFull() }) {
                Text(if (expanded) "Hide input and output" else "Show input and output")
            }
            progress?.let { Text(contentText(it["progress"]) ?: it.toString(), style = MaterialTheme.typography.bodySmall) }
            if (expanded) {
                shown.fields["input"]?.let { input -> Text("Input", style = MaterialTheme.typography.labelMedium); CodeText(input.toString(), "json") }
                val output = contentText((result ?: shown).fields["content"]) ?: (result ?: shown).fields.string("result") ?: liveOutput
                output?.let { Text("Output", style = MaterialTheme.typography.labelMedium); CodeText(it) }
                contentImages((result ?: shown).fields["content"]).forEach { TranscriptImage(it, "Tool result image", open) }
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (error) TextButton(onClick = ::loadFull) { Text("Couldn't load full output · Retry") }
                if (row.children.isNotEmpty()) {
                    Text("${row.children.size} subagent records", style = MaterialTheme.typography.labelMedium)
                    row.children.take(4).forEach { child -> TranscriptRowView(child, model, live, open) }
                    if (row.children.size > 4) TextButton(onClick = { childrenOpen = true }) { Text("Open subagent transcript") }
                }
            } else liveOutput?.let { Text(it.takeLast(240), maxLines = 3, style = MaterialTheme.typography.bodySmall) }
        } else if (event.type == "thinking") {
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide thinking" else "Show thinking") }
            if (expanded) MarkdownText(shown.body(), open = open)
        } else {
            MarkdownText(shown.body().ifBlank { shown.payload.toString() }, open = open)
            val atts = (shown.fields["attachments"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
            atts.forEach { attachment -> attachment.string("id")?.let { id ->
                val name = attachment.string("name") ?: "Attachment"
                if (attachment.string("mime")?.startsWith("image/") == true) TranscriptImage("orbit-attachment:$id", name, open)
                else TextButton(onClick = { open("orbit-attachment:$id") }) { Text(name) }
            } }
            (shown.fields["sessionMessage"] as? JsonObject)?.let { sender ->
                Text("Sent by another Orbit session, not by you", style = MaterialTheme.typography.bodySmall)
                sender.string("fromSessionId")?.let { id -> TextButton(onClick = { open("orbit-session:$id") }) { Text("Open sender session") } }
            }
            if (shown.truncated) TextButton(enabled = !loading, onClick = ::loadFull) { Text(if (error) "Couldn't load full message · Retry" else "Read full message") }
        }
    }
    if (childrenOpen) Dialog({ childrenOpen = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) { Column {
            TextButton(onClick = { childrenOpen = false }) { Text("Close subagent transcript") }
            LazyColumn { items(row.children, key = { it.key }) { TranscriptRowView(it, model, live, open) } }
        } }
    }
}
