package io.orbitd.android.composer

import android.content.ClipboardManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.attachments.*
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.realtime.SessionState
import kotlinx.serialization.json.*

@Composable
fun SessionComposer(app: OrbitApplication, handle: SessionHandle, sessionId: String, session: SessionState?, target: DraftTarget? = null, focusRequest: Int = 0,
    inputFocusChanged: (Boolean) -> Unit = {}) {
    val model = remember(app, handle, sessionId) { app.composer(handle, sessionId, target) }
    val state by model.state.collectAsState()
    val context = LocalContext.current
    val draft = state.draft
    var field by remember(model) { mutableStateOf(TextFieldValue()) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(focusRequest) {
        if (focusRequest > 0) { focus.requestFocus(); keyboard?.show() }
    }
    // Keep TextFieldValue's composing range during IME updates. Disk stores committed text/cursor,
    // never an IME's stale composing range after a new input connection or process.
    LaunchedEffect(draft.text, draft.selectionStart, draft.selectionEnd) {
        if (field.text != draft.text) field = TextFieldValue(draft.text,
            TextRange(draft.selectionStart.coerceIn(0, draft.text.length), draft.selectionEnd.coerceIn(0, draft.text.length)))
    }
    var menu by remember { mutableStateOf(false) }
    var models by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<StagedAttachment?>(null) }
    var queued by remember { mutableStateOf(false) }
    var slashScope by remember { mutableStateOf<String?>(null) }
    var selectionNotice by remember { mutableStateOf<String?>(null) }
    val usable = state.loaded && session.canCompose()
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { importAttachment(context, model, it, "file") }
    }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(5)) { uris ->
        // The older OpenDocument fallback does not enforce Photo Picker's selection count.
        selectionNotice = if (uris.size > 5) "Only the first five selected photos were added." else null
        uris.take(5).forEach { importAttachment(context, model, it, "photo") }
    }
    val clipboard = context.getSystemService(ClipboardManager::class.java)
    val detail = session?.snapshot?.detail ?: JsonObject(emptyMap())
    val effective = JsonObject(detail + draft.resumeConfig)
    val running = detail.text("runState") == "RUNNING" || detail.text("status") == "RUNNING"
    Surface(tonalElevation = 2.dp) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).testTag("session-composer")) {
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                state.error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = model::clearError) { Text("Dismiss error") } }
                if (!state.loaded && !state.busy) TextButton(onClick = model::restore) { Text("Retry draft restore") }
                state.notice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                selectionNotice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                if (target == null && terminal(detail)) {
                    Text("Sending a message will resume this session in Open.", style = MaterialTheme.typography.bodySmall)
                    (detail["capabilities"] as? JsonObject)?.text("resumeBlockedReason")?.let { reason ->
                        Text(reason); TextButton(onClick = { app.realtime.refreshSession() }) { Text("Check Again") }
                    }
                }
                if (!session.canCompose()) Text("Reconnect to send. Your draft is saved.", style = MaterialTheme.typography.bodySmall)
                draft.pending?.let { pending ->
                    Text("Delivery unconfirmed: ${pending.text.take(120)}", style = MaterialTheme.typography.bodySmall)
                    if (pending.endpoint == "create") Text("Creation is unconfirmed. Check this workspace's sessions before creating another session.")
                    else Button(enabled = !state.busy && !state.waiting && session?.accessDenied != true, onClick = model::retrySend) { Text("Retry saved send") }
                }
                draft.attachments.forEach { att ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        TextButton(onClick = { preview = att }, enabled = att.size > 0, modifier = Modifier.weight(1f)) {
                            Text("${att.name} · ${att.size / 1024} KB", maxLines = 2)
                        }
                        if (att.id in state.failures) TextButton(onClick = {
                            if (att.uri != null) {
                                model.removeAttachment(att.id)
                                importAttachment(context, model, Uri.parse(att.uri), att.source)
                            } else model.retryUpload(att.id)
                        }) { Text("Retry upload") }
                        TextButton(onClick = { model.removeAttachment(att.id) }) { Text("Remove") }
                    }
                    state.uploads[att.id]?.let { LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth()) }
                    state.failures[att.id]?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                }
                ComposerUsage(model, state, effective, session)
            OutlinedTextField(field, onValueChange = { field = it; model.edit(it.text, it.selection.start, it.selection.end) },
                modifier = Modifier.fillMaxWidth().focusRequester(focus).onFocusChanged { inputFocusChanged(it.isFocused) }.testTag("composer-input").onPreviewKeyEvent {
                    if (it.type == KeyEventType.KeyDown && it.key == Key.Enter && (it.isCtrlPressed || it.isMetaPressed) && field.composition == null && usable) {
                        model.send(); true
                    } else false
                }, enabled = state.loaded, placeholder = { Text("Message…") }, minLines = 1, maxLines = 4,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default))
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Box {
                    TextButton(enabled = state.loaded, onClick = { menu = true }) { Text("+") }
                    DropdownMenu(menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Image") }, onClick = { menu = false; photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) })
                        DropdownMenuItem(text = { Text("File") }, onClick = { menu = false; files.launch(arrayOf("*/*")) })
                        val clip = clipboard.primaryClip
                        if (clip != null && clip.itemCount > 0 && clip.description.hasMimeType("image/*")) {
                            DropdownMenuItem(text = { Text("Paste image") }, onClick = {
                                menu = false; clip.getItemAt(0).uri?.let { importAttachment(context, model, it, "paste") }
                            })
                        }
                        listOf("command" to "Command", "skill" to "Skill").forEach { (kind, label) ->
                            DropdownMenuItem(text = { Text(label) }, enabled = usable, onClick = { menu = false; slashScope = kind; model.loadCatalog() })
                        }
                        DropdownMenuItem(text = { Text("Shell command") }, onClick = { menu = false; if (!draft.text.startsWith("!")) model.edit("!${draft.text}", 1, 1) })
                        if (target == null) DropdownMenuItem(text = { Text("Queued messages (${session?.snapshot?.queuedTurns?.size ?: 0})") }, onClick = { menu = false; queued = true })
                        if (target == null) DropdownMenuItem(text = { Text("Retry last failed message") }, enabled = usable && !state.busy,
                            onClick = { menu = false; model.control("retry-message", body = JsonObject(emptyMap())) })
                        if (detail.text("retryAt") != null) DropdownMenuItem(text = { Text("Cancel automatic retry") }, enabled = usable && !state.busy,
                            onClick = { menu = false; model.control("auto-retry", HttpMethod.DELETE) })
                    }
                }
                TextButton(enabled = usable && !state.busy && draft.pending == null, modifier = Modifier.weight(1f),
                    onClick = { models = true; model.loadCatalog() }) {
                    Text(effective.text("model")?.ifBlank { "Runtime default" } ?: "Model", maxLines = 1)
                }
                val hasDraft = draft.text.isNotBlank() || draft.attachments.isNotEmpty()
                Button(enabled = usable && !state.busy && !state.waiting && (if (running && !hasDraft) true else hasDraft && draft.pending == null),
                    onClick = { if (running && !hasDraft) model.control("interrupt") else model.send() }, modifier = Modifier.testTag("composer-send")) {
                    Text(if (state.waiting) "Uploading…" else if (state.busy) "Sending…" else if (running && !hasDraft) "Stop" else "Send")
                }
            }
        }
    }
    preview?.let { att ->
        val images = draft.attachments.filter { it.mime.startsWith("image/") }; val index = images.indexOfFirst { it.id == att.id }
        AttachmentActions(att.name, att.mime, { model.attachmentBytes(att.id) }, contentKey = att.id,
            previous = if (index > 0) ({ preview = images[index - 1] }) else null,
            next = if (index >= 0 && index < images.lastIndex) ({ preview = images[index + 1] }) else null) { preview = null }
    }
    slashScope?.let { kind ->
        AlertDialog(onDismissRequest = { slashScope = null }, title = { Text(if (kind == "command") "Command" else "Skill") }, text = {
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                if (state.catalogLoading) CircularProgressIndicator()
                state.catalogError?.let { Text(it); TextButton(onClick = model::loadCatalog) { Text("Retry catalog") } }
                val items = state.catalog?.slashItems(effective.text("provider").orEmpty(), detail.text("agentId")).orEmpty().filter { it.text("type") == kind }
                if (!state.catalogLoading && state.catalogError == null && items.isEmpty()) Text("No ${kind}s reported for this runtime.")
                items.forEach { item ->
                    TextButton(onClick = {
                        val word = draft.text.takeLastWhile { !it.isWhitespace() }
                        val prefix = if (word.startsWith("/")) draft.text.dropLast(word.length) else draft.text + (if (draft.text.isEmpty() || draft.text.last().isWhitespace()) "" else " ")
                        val text = prefix + "/${item.text("name")} "
                        model.edit(text, text.length, text.length); slashScope = null
                    }) { Text("/${item.text("name")} · ${item.text("description").orEmpty()}") }
                }
            }
        }, confirmButton = { TextButton(onClick = { slashScope = null }) { Text("Close") } })
    }
    if (models && session?.accessDenied != true) ModelChoices(model, state, effective, usable) { models = false }
    if (queued) AlertDialog(onDismissRequest = { queued = false }, title = { Text("Queued messages") }, text = {
        Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
            if (session?.fresh != true) Text("Reconnect to check the queue.")
            val turns = session?.snapshot?.queuedTurns.orEmpty()
            if (turns.isEmpty()) Text("No queued messages")
            turns.forEach { turn ->
                Text(turn.text("content") ?: "Message")
                TextButton(enabled = usable && !state.busy, onClick = {
                    (turn.text("turnId") ?: turn.text("id"))?.let { model.control("turns/$it", HttpMethod.DELETE) }
                }) { Text("Withdraw") }
            }
        }
    }, confirmButton = { TextButton(onClick = { queued = false }) { Text("Close") } })
}

@Composable
private fun ModelChoices(model: ComposerModel, state: ComposerState, detail: JsonObject, usable: Boolean, close: () -> Unit) {
    val catalog = state.catalog
    val provider = detail.text("provider") ?: ""
    val chosen = detail.text("model") ?: ""
    val enabled = usable && !state.busy && catalog != null && state.draft.pending == null
    fun change(key: String, value: String) { model.config(buildJsonObject { put(key, value) }) }
    AlertDialog(onDismissRequest = close, title = { Text("Model and account") }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
            if (state.catalogLoading) CircularProgressIndicator()
            state.catalogError?.let { Text(it); TextButton(onClick = model::loadCatalog) { Text("Retry model catalog") } }
            Text("Current: $provider · $chosen")
            val rows = catalog?.models(provider).orEmpty()
            rows.forEach { row ->
                TextButton(enabled = enabled, onClick = {
                    val id = row.text("value") ?: return@TextButton
                    model.config(buildJsonObject {
                        put("model", id)
                        val effort = detail.text("effort") ?: ""
                        if (row.strings("reasoningLevels").isNotEmpty() && effort !in row.strings("reasoningLevels")) put("effort", row.text("defaultReasoningLevel") ?: "")
                    })
                }) { Text((if (row.text("value") == chosen) "✓ " else "") + (row.text("label") ?: row.text("value").orEmpty())) }
            }
            if (catalog != null && rows.isEmpty()) Text("This provider has not reported available models.")
            val selected = rows.firstOrNull { it.text("value") == chosen }
            selected?.strings("reasoningLevels")?.let { levels ->
                if (levels.isNotEmpty()) { Text("Effort"); (listOf("") + levels).forEach { effort ->
                    TextButton(enabled = enabled, onClick = { change("effort", effort) }) { Text(effort.ifBlank { "Default" }) }
                } }
            }
            val modes = catalog?.permissions(provider, chosen).orEmpty()
            if (modes.isNotEmpty()) { Text("Permissions"); modes.forEach { mode ->
                TextButton(enabled = enabled, onClick = { change("permissionMode", mode) }) { Text(mode) }
            } }
            val fast = selected?.flag("fastMode") == true || (catalog?.runtime(provider) == "codex" && "priority" in selected?.strings("serviceTiers").orEmpty())
            if (fast) TextButton(enabled = enabled, onClick = { model.config(buildJsonObject { put("fastMode", detail.flag("fastMode") != true) }) }) {
                Text(if (detail.flag("fastMode") == true) "Speed: Fast" else "Speed: Standard")
            }
            Text("Provider")
            catalog?.options(provider, model.target != null)?.forEach { option ->
                TextButton(enabled = enabled && option.unavailable == null, onClick = {
                    model.config(buildJsonObject {
                        put("provider", option.id); put("model", option.models.firstOrNull()?.text("value") ?: ""); put("effort", "")
                    })
                }) { Text(option.label + (option.unavailable?.let { " · $it" } ?: "")) }
            }
            val accounts = catalog?.accounts(provider).orEmpty().takeIf {
                model.target != null || "$provider-account-move/v1" in catalog?.runner?.strings("capabilities").orEmpty()
            }.orEmpty()
            if (accounts.isNotEmpty()) {
                Text("Account")
                TextButton(enabled = enabled, onClick = { model.config(buildJsonObject { put("account", "automatic") }, true) }) { Text("Automatic") }
                accounts.forEach { account -> TextButton(enabled = enabled && account.text("auth") != "no", onClick = {
                    account.text("id")?.let { model.config(buildJsonObject { put("account", it) }, true) }
                }) { Text((account.text("name") ?: account.text("id").orEmpty()) + if (account.text("auth") == "no") " · Not signed in" else "") } }
            }
        }
    }, confirmButton = { TextButton(onClick = close) { Text("Close") } })
}
