package io.orbitd.android.composer

import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.edit
import io.orbitd.android.OrbitApplication
import io.orbitd.android.attachments.*
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.realtime.SessionState
import io.orbitd.android.management.LocalSmartSelection
import io.orbitd.android.tasks.TaskDetailCopy
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.*

@Composable
fun SessionComposer(app: OrbitApplication, handle: SessionHandle, sessionId: String, session: SessionState?, target: DraftTarget? = null, focusRequest: Int = 0,
    inputFocusChanged: (Boolean) -> Unit = {}, openTask: ((String) -> Unit)? = null, openRunner: ((runner: String, engine: String) -> Unit)? = null) {
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
    // The decision behind this task run, while the chip still shows the model it picked (A11-1).
    val smart = smartRoute(detail.text("taskId"), detail["route"] as? JsonObject, effective.text("model").orEmpty(), LocalSmartSelection.current)
    // The engine's guess at the next message, offered in the empty box and taken with a double-tap on it,
    // which fills the box and sends nothing (docs/prompt-suggestions-design.md §4). A message just sent answers
    // it before its `user` event arrives, so the one standing at the send is held back until the transcript moves on.
    val standing = session?.transcript?.promptSuggestion
    var spent by remember(model) { mutableStateOf<String?>(null) }
    LaunchedEffect(standing) { if (standing == null) spent = null }
    val suggestion = if (target != null || standing == spent) null else offeredPromptSuggestion(standing, detail,
        draftEmpty = draft.text.isEmpty() && draft.attachments.isEmpty() && draft.pending == null,
        usable = usable && !state.busy && !state.waiting)
    val send = { spent = standing; model.send() }
    var inputFocused by remember { mutableStateOf(false) }
    // Set by the first double-tap that takes a suggestion on this device: from then on the box shows the guess alone,
    // without "Double-tap to use" after it.
    val composerPrefs = remember { context.getSharedPreferences("orbit.composer", Context.MODE_PRIVATE) }
    var suggestionTapLearned by remember { mutableStateOf(composerPrefs.getBoolean(SUGGESTION_TAP_LEARNED, false)) }
    val focusField: () -> Unit = { focus.requestFocus(); keyboard?.show() }
    val useSuggestion: () -> Unit = {
        suggestion?.let {
            field = TextFieldValue(it, TextRange(it.length))
            model.edit(it, it.length, it.length)
            focusField()
        }
        if (!suggestionTapLearned) {
            suggestionTapLearned = true
            composerPrefs.edit { putBoolean(SUGGESTION_TAP_LEARNED, true) }
        }
    }
    Surface(tonalElevation = 2.dp) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).testTag("session-composer")) {
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                state.error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = model::clearError) { Text("Dismiss error") } }
                if (!state.loaded && !state.busy) TextButton(onClick = model::restore) { Text("Retry draft restore") }
                state.notice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                if (state.acknowledgementPending) {
                    Text("Session created. Save its confirmation to continue.")
                    Button(enabled = !state.busy, onClick = model::retrySend) { Text("Retry saving confirmation") }
                }
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
            SuggestionTaps(suggestion != null, inputFocused, focusField, useSuggestion) { taps ->
                OutlinedTextField(field, onValueChange = { field = it; model.edit(it.text, it.selection.start, it.selection.end) },
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).onFocusChanged { inputFocused = it.isFocused; inputFocusChanged(it.isFocused) }
                        .testTag("composer-input")
                        .then(taps)
                        // TalkBack's own double-tap is "activate": it takes the guess with this action.
                        .semantics { if (suggestion != null) customActions = listOf(CustomAccessibilityAction("Use suggestion") { useSuggestion(); true }) }
                        .onPreviewKeyEvent {
                            if (it.type == KeyEventType.KeyDown && it.key == Key.Enter && (it.isCtrlPressed || it.isMetaPressed) && field.composition == null && usable) {
                                send(); true
                            } else false
                        }, enabled = state.loaded,
                    placeholder = {
                        if (suggestion != null) SuggestionPlaceholder(suggestion, showsHint = !suggestionTapLearned)
                        else Text("Message…", maxLines = 1, overflow = TextOverflow.Ellipsis)
                    },
                    minLines = 1, maxLines = 4,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default))
            }
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
                            onClick = { menu = false; model.retryFailed() })
                        if (detail.text("retryAt") != null) DropdownMenuItem(text = { Text("Cancel automatic retry") }, enabled = usable && !state.busy,
                            onClick = { menu = false; model.control("auto-retry", HttpMethod.DELETE) })
                    }
                }
                ModelChip(effective.text("model")?.ifBlank { "Runtime default" } ?: "Model", effortLabel(effective.text("effort")), smart != null,
                    enabled = usable && !state.busy && draft.pending == null && draft.createdSessionId == null, modifier = Modifier.weight(1f)) {
                    models = true; model.loadCatalog()
                }
                val hasDraft = draft.text.isNotBlank() || draft.attachments.isNotEmpty()
                Button(enabled = usable && !state.busy && !state.waiting && draft.createdSessionId == null && (if (running && !hasDraft) true else hasDraft && draft.pending == null),
                    onClick = { if (running && !hasDraft) model.control("interrupt") else send() }, modifier = Modifier.testTag("composer-send")) {
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
    // The menu's title: the engine running this session, and where a pick held for the resume takes the next turn (A07-13).
    val engineTitle = ProviderChoices.engineTitle((if (target == null) detail else effective).text("provider").orEmpty(),
        state.catalog?.providers.orEmpty(), next = if (target == null) draft.resumeConfig.text("provider") else null)
    if (models && session?.accessDenied != true) ModelChoices(model, state, effective, engineTitle, usable, smart, detail.text("taskId"), openTask,
        openRunner) { models = false }
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

private const val SUGGESTION_TAP_LEARNED = "suggestionDoubleTapLearned"

/** The engine's guess in the empty box (docs/prompt-suggestions-design.md §4.3): the words, cut at the end, and — until the first
 * double-tap that takes one on this device — "Double-tap to use" right after them. TalkBack skips the hint: its own double-tap is
 * "activate", and it takes the guess with the field's "Use suggestion" action. */
@Composable
internal fun SuggestionPlaceholder(suggestion: String, showsHint: Boolean) = Row(verticalAlignment = Alignment.CenterVertically) {
    Text(suggestion, Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis)
    if (showsHint) Text("Double-tap to use", Modifier.padding(start = 8.dp).testTag("composer-suggestion-hint").clearAndSetSemantics {},
        style = MaterialTheme.typography.bodySmall, maxLines = 1)
}

/** The field, taking the engine's guess with a double-tap (docs/prompt-suggestions-design.md §4.3). While a guess is [offered] and the
 * field is not [focused], a catcher lies over it: the keyboard a first tap would raise lifts the composer, and the second tap would land
 * on the keyboard instead. So a lone tap there (or a long press) is held until the double-tap timeout has passed and handed on as
 * [focus]. A focused field keeps its own taps, and only the second of two is kept from it ([doubleTapToUse]). */
@Composable
internal fun SuggestionTaps(offered: Boolean, focused: Boolean, focus: () -> Unit, use: () -> Unit, field: @Composable (Modifier) -> Unit) {
    val latestFocus by rememberUpdatedState(focus)
    val latestUse by rememberUpdatedState(use)
    Box {
        field(Modifier.doubleTapToUse(offered && focused, use))
        if (offered && !focused) Box(Modifier.matchParentSize().testTag("composer-suggestion-taps").pointerInput(Unit) {
            detectTapGestures(onDoubleTap = { latestUse() }, onLongPress = { latestFocus() }, onTap = { latestFocus() })
        })
    }
}

/** Two taps on a field within the double-tap timeout run [use]. The first is the field's own; the second's lift is kept from it, so it
 * neither drops the cursor into the words it just received nor opens the text toolbar. Watched in the Initial pass, ahead of the field's
 * own gestures. */
internal fun Modifier.doubleTapToUse(enabled: Boolean, use: () -> Unit): Modifier = if (!enabled) this else composed {
    val latestUse by rememberUpdatedState(use)
    pointerInput(Unit) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            waitForUpOrCancellation(PointerEventPass.Initial) ?: return@awaitEachGesture
            withTimeoutOrNull(viewConfiguration.doubleTapTimeoutMillis) {
                awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            } ?: return@awaitEachGesture
            val lift = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                waitForUpOrCancellation(PointerEventPass.Initial)
            } ?: return@awaitEachGesture
            lift.consume()
            latestUse()
        }
    }
}

/** The model chip (iOS `modelChipLabel`): the model's name, and — on a task run still on the model smart selection picked — a ✦ before
 * it on a light tint of the accent. Named aloud "Model X, effort Y", and ", picked by smart selection" while it carries the ✦. */
@Composable
internal fun ModelChip(name: String, effort: String, smart: Boolean, enabled: Boolean, modifier: Modifier = Modifier, open: () -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    val spoken = "Model $name, effort $effort" + if (smart) TaskDetailCopy.chipPickedBySmartSelection else ""
    TextButton(enabled = enabled, modifier = modifier.testTag("composer-model").semantics { contentDescription = spoken }, onClick = open) {
        Row(if (smart) Modifier.background(accent.copy(alpha = 0.12f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp) else Modifier,
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            // Said by the chip's spoken name rather than read out as a symbol.
            if (smart) Text("✦", Modifier.testTag("composer-model-smart"), color = accent)
            Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** One account in its engine's section of the Provider list (iOS `accountRowLabel`): its name, and under it its own quota — "5h 12%",
 * what an Antigravity bucket has left, "gemini-5h 4% left" — or what Automatic does, or why it can't take the session. */
@Composable
private fun AccountRow(name: String, detail: String?, enabled: Boolean, nearLimit: Boolean = false, spoken: String? = null, press: () -> Unit) {
    TextButton(enabled = enabled, onClick = press, modifier = if (spoken == null) Modifier else Modifier.semantics { contentDescription = spoken }) {
        Column(Modifier.fillMaxWidth()) {
            Text(name)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall,
                color = if (nearLimit) LocalOrbitColors.current.needsYou else MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

/** What the chip's menu opens on for a task run on smart selection's pick (iOS 6826eed7e, 7c49be60a): the tier it picked, its first
 * reason, and the note — a sentence an item, as a phone's menu cuts an item at its third line. */
@Composable
internal fun SmartRouteNote(route: JsonObject) = Column(Modifier.testTag("composer-smart-route"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text("✦ " + TaskDetailCopy.pickedBySmartSelection(route.text("level").orEmpty()), fontWeight = FontWeight.SemiBold)
    route.strings("reasons").firstOrNull()?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    sentences(TaskDetailCopy.modelChangeAppliesToThisRun).forEach {
        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ModelChoices(model: ComposerModel, state: ComposerState, detail: JsonObject, engineTitle: String, usable: Boolean, smart: JsonObject?,
    taskId: String?, openTask: ((String) -> Unit)?, openRunner: ((String, String) -> Unit)?, close: () -> Unit) {
    val catalog = state.catalog
    val provider = detail.text("provider") ?: ""
    val chosen = detail.text("model") ?: ""
    // OpenCode on a configured key is on that key: whose models the menu lists and whose row is ticked (A07-6).
    val choice = OpenCodeKeys.choice(provider, chosen)
    val enabled = usable && !state.busy && catalog != null && state.draft.pending == null
    fun change(key: String, value: String) { model.config(buildJsonObject { put(key, value) }) }
    AlertDialog(onDismissRequest = close, title = { Text("Model and account") }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
            // The engine this session runs on (iOS 0557592f8), over everything below that picks for the next turn.
            Text(engineTitle, Modifier.testTag("composer-engine-title"), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            // A task run on smart selection's pick opens on why it is this model, and on where to fix the model for every run.
            smart?.let { SmartRouteNote(it); HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
            if (state.catalogLoading) CircularProgressIndicator()
            state.catalogError?.let { Text(it); TextButton(onClick = model::loadCatalog) { Text("Retry model catalog") } }
            val rows = catalog?.models(choice).orEmpty()
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
            val draft = model.target != null
            // A draft starts on any engine, in iOS's order; a session moves only between the providers of its own CLI.
            catalog?.let { val all = it.choices(it.antigravityKeyAvailable(detail)); if (draft) all else it.sameRuntime(choice, all) }?.forEach { option ->
                val here = option.id == choice
                fun pick(account: String? = null) {
                    val next = option.models.firstOrNull()?.text("value") ?: ""
                    when {
                        // On the engine it is on, only the account moves.
                        here && account != null -> model.config(buildJsonObject { put("account", account) }, true)
                        // Within OpenCode a key is part of the model, so moving between its own config and its keys is a model change.
                        provider == "opencode" && option.runtime == "opencode" -> model.config(buildJsonObject { put("model", next) })
                        else -> model.config(buildJsonObject {
                            put("provider", if (OpenCodeKeys.choiceKey(option.id) != null) "opencode" else option.id); put("model", next); put("effort", "")
                            account?.let { put("account", it) }
                        })
                    }
                }
                // An engine whose runner keeps several accounts names a section of them (iOS 9ee358083, `accountsUnderHeader`): on the
                // engine the draft or session is on, the ones it moves between; under another, the ones a new session there starts on.
                // A draft starts on any of them; a session moves only where the runner carries it across.
                val accounts = if (option.unavailable != null && !here) emptyList()
                    else catalog.takeIf { draft || it.movesAccounts(option.id) }?.accountChoices(option.id).orEmpty()
                // A row this runner can't run stays listed with why; where an engine page fixes it, the row goes there (iOS d2737d665).
                // The one the session is on is exempt: it is the list's own caption.
                val blocked = option.unavailable != null && !here
                val fix = option.fixEngine?.takeIf { blocked && openRunner != null }
                val name = listOfNotNull(option.label, option.labelDetail).joinToString(" · ")
                if (accounts.size < 2) TextButton(enabled = enabled && (!blocked || fix != null), onClick = {
                    if (fix == null) pick() else catalog.runner.text("id")?.let { runner -> close(); openRunner?.invoke(runner, fix) }
                }) {
                    Text(if (blocked) "${option.label} — ${option.unavailable}" + (if (option.fixEngine != null) ProviderChoices.fixSuffix(option.fixEngine) else "")
                        else (if (here) "✓ " else "") + name)
                } else {
                    Text(name, Modifier.padding(top = 8.dp).testTag("composer-engine-accounts"), style = MaterialTheme.typography.labelLarge)
                    AccountRow("Automatic", "Switches to soonest reset", enabled,
                        spoken = "Automatic: starts on the ${option.label} account whose quota resets soonest, and switches when it hits its limit") { pick("automatic") }
                    accounts.forEach { account ->
                        // A signed-out account is a request for its sign-in, on the runner's page for the engine.
                        AccountRow(account.label, account.unavailable?.let { "$it, sign in →" } ?: account.quota, enabled,
                            nearLimit = account.nearLimit && account.unavailable == null) {
                            if (account.unavailable == null) pick(account.id)
                            else catalog.runner.text("id")?.let { runner -> openRunner?.let { close(); it(runner, option.id) } }
                        }
                    }
                }
            }
            // …and ends on the task, pushed over this run, so Back returns to it.
            if (smart != null && taskId != null && openTask != null) {
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                TextButton(onClick = { close(); openTask(taskId) }, modifier = Modifier.testTag("composer-open-task")) { Text(TaskDetailCopy.openTask) }
            }
        }
    }, confirmButton = { TextButton(onClick = close) { Text("Close") } })
}
