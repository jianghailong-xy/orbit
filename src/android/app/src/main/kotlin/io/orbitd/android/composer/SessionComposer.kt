package io.orbitd.android.composer

import android.content.ClipboardManager
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.attachments.*
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.DshRuntime
import io.orbitd.android.core.cards.WatchWakeQueue
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.realtime.SessionState
import io.orbitd.android.management.EngineAccounts
import io.orbitd.android.management.LocalDefaultModels
import io.orbitd.android.management.LocalRememberModel
import io.orbitd.android.management.LocalSmartSelection
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.personalPermissions
import io.orbitd.android.reader.SteerDelivery
import io.orbitd.android.reader.UnreadSteer
import io.orbitd.android.reader.queuedTail
import io.orbitd.android.tasks.TaskDetailCopy
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.ui.typingFold
import kotlinx.serialization.json.*

/** [unreadSteers]: the reader's steers nothing has read yet, which the conversation leaves to the tray above this box
 * ([SteerDelivery.place]). */
@Composable
internal fun SessionComposer(app: OrbitApplication, handle: SessionHandle, sessionId: String, session: SessionState?, target: DraftTarget? = null, focusRequest: Int = 0,
    inputFocusChanged: (Boolean) -> Unit = {}, foldsChrome: Boolean = false,
    openTask: ((String) -> Unit)? = null, openRunner: ((runner: String, engine: String) -> Unit)? = null,
    unreadSteers: List<UnreadSteer> = emptyList()) {
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
    // The watch's wake the queue's Withdraw is asking about first (A08-14).
    var withdrawingWake by remember { mutableStateOf<String?>(null) }
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
    val picked = JsonObject(detail + draft.resumeConfig)
    // A07-19 (e): a new session that names no model starts on the one last picked for its engine and credential (iOS
    // `draftModelSeed`) while the runner still offers it — read once the account remembers any.
    val remembered = LocalDefaultModels.current
    LaunchedEffect(model, remembered.isNotEmpty()) {
        if (target != null && remembered.isNotEmpty() && model.state.value.let { it.catalog == null && !it.catalogLoading }) model.loadCatalog()
    }
    val seed = if (target == null || draft.resumeConfig["model"] != null) null else state.catalog?.let { catalog ->
        catalog.engineOf(picked).let { engine -> catalog.liveRememberedModel(engine, picked.text("provider") ?: engine, remembered) }
    }
    val effective = if (seed == null) picked else JsonObject(picked + ("model" to JsonPrimitive(seed)))
    // What is still waiting, as the transcript's tail draws it (A07-14): never the accepted head — the runner's now, which nothing
    // withdraws — nor a steer's receipt.
    val waiting = remember(session?.snapshot?.queuedTurns, session?.transcript?.events) {
        queuedTail(session?.snapshot?.queuedTurns.orEmpty(), session?.transcript?.events.orEmpty())
    }
    val running = detail.text("runState") == "RUNNING" || detail.text("status") == "RUNNING"
    // The engine this session's turns run on, which no pick here changes: whether a message can go into a running one — the tray's
    // Steer, and Send's other way — and who it was that read one too late to withdraw.
    val engine = ProviderChoices.engine(detail, state.catalog?.providers.orEmpty())
    val midTurn = SteerDelivery.runtimeTakesMidTurnSteer(engine)
    // The tray above the box (docs/mocks/steer-tray): the reader's steers nothing has read yet and their messages still on the queue.
    val trayRows = if (target != null) emptyList() else PendingTray.rows(unreadSteers, waiting, state, steerOffered = usable && running && midTurn)
    // The engine the box's picks run on: the session's, or a draft's pick.
    val shownEngine = ProviderChoices.engine(effective, state.catalog?.providers.orEmpty())
    // DeepSeek Harness takes no ! command, and picks its own model until the runner reports one (A07-5).
    val dsh = shownEngine == DshRuntime.ENGINE
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
    val send = { queueForNextTurn: Boolean -> spent = standing; model.send(seed, queueForNextTurn) }
    var inputFocused by remember { mutableStateOf(false) }
    // Android hides its keyboard without taking the field's focus with it, where iOS's first responder resigns. The
    // reader's chrome fold (iOS `ConsoleView.foldsChrome`) reads this box's editing state, so the keyboard going
    // hands the page its bar and rows back instead of leaving a phone without them.
    val focusManager = LocalFocusManager.current
    var imeWasUp by remember { mutableStateOf(false) }
    val imeUp = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    LaunchedEffect(imeUp) {
        if (imeUp) imeWasUp = true
        else if (imeWasUp) { imeWasUp = false; if (inputFocused) focusManager.clearFocus() }
    }
    val focusField: () -> Unit = { focus.requestFocus(); keyboard?.show() }
    val useSuggestion: () -> Unit = {
        suggestion?.let {
            field = TextFieldValue(it, TextRange(it.length))
            model.edit(it, it.length, it.length)
            focusField()
        }
    }
    Column {
    // Directly above the box, and not folded while a phone types: it is about the messages being typed into. It takes what room the
    // box leaves, scrolling past about four rows.
    PendingTrayCard(trayRows, enabled = usable, steer = { model.steer(it.turnId) },
        withdraw = { model.withdraw(it.turnId, it.restores, it.steer, engine) }, modifier = Modifier.weight(1f, fill = false),
        // Cursor CLI takes no message mid-turn — one would stop the turn — so the tray says why its rows wait (iOS 5 ⑤).
        note = if (engine == CursorRuntime.ENGINE) CursorRuntime.QUEUE_NOTE else null)
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
                // The context line folds away with the page's chrome while this box holds a phone's keyboard
                // (`foldsChrome`), as the reader's rows above do; the input and its buttons stay where they are.
                Box(Modifier.fillMaxWidth().typingFold(foldsChrome)) { ComposerUsage(model, state, effective, session) }
            SuggestionTaps(suggestion != null, inputFocused, focusField, useSuggestion) { taps ->
                OutlinedTextField(field, onValueChange = { field = it; model.edit(it.text, it.selection.start, it.selection.end) },
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).onFocusChanged { inputFocused = it.isFocused; inputFocusChanged(it.isFocused) }
                        .testTag("composer-input")
                        .then(taps)
                        // TalkBack's own double-tap is "activate": it takes the guess with this action.
                        .semantics { if (suggestion != null) customActions = listOf(CustomAccessibilityAction("Use suggestion") { useSuggestion(); true }) }
                        .onPreviewKeyEvent {
                            if (it.type == KeyEventType.KeyDown && it.key == Key.Enter && (it.isCtrlPressed || it.isMetaPressed) && field.composition == null && usable) {
                                send(false); true
                            } else false
                        }, enabled = state.loaded,
                    placeholder = {
                        if (suggestion != null) SuggestionPlaceholder(suggestion)
                        // Cursor CLI takes no message mid-turn: one written now waits for the turn to end (iOS 5 ⑥).
                        else Text(if (target == null && running && engine == CursorRuntime.ENGINE) CursorRuntime.RUNNING_PLACEHOLDER else "Message…",
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
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
                        DropdownMenuItem(text = { Text("Shell command") }, onClick = {
                            menu = false
                            if (dsh) model.refuse(DshRuntime.SHELL_REFUSAL) else if (!draft.text.startsWith("!")) model.edit("!${draft.text}", 1, 1)
                        })
                        if (target == null) DropdownMenuItem(text = { Text("Queued messages (${waiting.size})") }, onClick = { menu = false; queued = true })
                        // A pick held for this session travels with the re-send, which would otherwise run on what it already has.
                        if (target == null) DropdownMenuItem(text = { Text("Retry last failed message") }, enabled = usable && !state.busy,
                            onClick = { menu = false; model.retryFailed() })
                        if (detail.text("retryAt") != null) DropdownMenuItem(text = { Text("Cancel automatic retry") }, enabled = usable && !state.busy,
                            onClick = { menu = false; model.control("auto-retry", HttpMethod.DELETE) })
                    }
                }
                // Cursor CLI's model by its catalogue's name, its effort and what the session set (iOS 5 ①②).
                val cursorModel = if (shownEngine == CursorRuntime.ENGINE) CursorRuntime.modelName(state.catalog,
                    effective.text("provider") ?: shownEngine, effective.text("model").orEmpty(), effective.text("effort")) else null
                ModelChip(cursorModel ?: if (dsh && effective.text("model").isNullOrBlank()) DshRuntime.PICKED_BY else effective.text("model")?.ifBlank { "Runtime default" } ?: "Model",
                    effortLabel(effective.text("effort")), smart != null,
                    enabled = usable && !state.busy && draft.pending == null && draft.createdSessionId == null, modifier = Modifier.weight(1f),
                    // …and aloud with its effort said once (iOS `chipAccessibilityLabel`): the name above already holds it.
                    spokenName = if (cursorModel == null) null else CursorRuntime.spokenName(state.catalog,
                        effective.text("provider") ?: shownEngine, effective.text("model").orEmpty(), effective.text("effort"))) {
                    models = true; model.loadCatalog()
                }
                val hasDraft = draft.text.isNotBlank() || draft.attachments.isNotEmpty()
                // With nothing typed, Send is Stop wherever there is something to stop — a turn running, one the engine started for
                // itself, or work left running under a parked turn (A07-20, iOS 593920cea). Steer and Queue for next turn still ask for
                // a running turn.
                val stop = hasSomethingToStop(detail) && !hasDraft
                val sendEnabled = usable && !state.busy && !state.waiting && draft.createdSessionId == null && (if (stop) true else hasDraft && draft.pending == null)
                // Held while a turn runs, Send offers the other way to send it: queued for the next turn instead of into this one (decided
                // 2026-10-16, docs/mocks/steer-tray; iOS's context menu on Send, the web's ⌥Enter). Only where the engine would otherwise
                // take it into the turn, and never for a `!cmd`, which always waits.
                val queueOffered = target == null && running && hasDraft && midTurn && sendEnabled && !draft.text.trim().startsWith("!")
                var queueMenu by remember { mutableStateOf(false) }
                LaunchedEffect(queueOffered) { if (!queueOffered) queueMenu = false }
                Box {
                    Button(enabled = sendEnabled, onClick = { if (stop) model.stop() else send(false) },
                        modifier = Modifier.testTag("composer-send").holdToOffer(queueOffered) { queueMenu = true }.semantics {
                            if (queueOffered) customActions = listOf(CustomAccessibilityAction(PendingTray.QUEUE_FOR_NEXT_TURN) { send(true); true })
                        }) {
                        Text(if (state.waiting) "Uploading…" else if (state.busy) "Sending…" else if (stop) "Stop" else "Send")
                    }
                    DropdownMenu(queueMenu, onDismissRequest = { queueMenu = false }) {
                        DropdownMenuItem(text = { Text(PendingTray.QUEUE_FOR_NEXT_TURN) }, modifier = Modifier.testTag("composer-queue-next-turn"),
                            leadingIcon = { Icon(painterResource(R.drawable.ic_queue_next), null, Modifier.size(16.dp)) },
                            onClick = { queueMenu = false; send(true) })
                    }
                }
            }
            // A07-19 (a): what the provider picked here will do, and when — under the box, for as long as the pick stands.
            state.switchNote?.let { Text(it, Modifier.fillMaxWidth().padding(top = 4.dp).testTag("composer-switch-note"),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
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
                val items = state.catalog?.let { it.slashItems(it.engineOf(effective), detail.text("agentId")) }.orEmpty().filter { it.text("type") == kind }
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
    if (models && session?.accessDenied != true) ModelChoices(model, state, effective, usable, smart, detail.text("taskId"), openTask,
        openRunner) { models = false }
    if (queued) AlertDialog(onDismissRequest = { queued = false }, title = { Text("Queued messages") }, text = {
        Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
            if (session?.fresh != true) Text("Reconnect to check the queue.")
            if (waiting.isEmpty()) Text("No queued messages")
            waiting.forEach { turn ->
                Text(turn.event.fields.text("text") ?: "Message")
                // As the tail's Cancel: a steer is on its way into the running turn, and a turn with no id is nobody's to name yet.
                // A watch's wake asks first, as its line at the transcript's end does (A08-14).
                if (turn.cancelable) TextButton(enabled = usable && !state.busy, onClick = {
                    if (turn.watch != null) withdrawingWake = turn.turnId else model.control("turns/${turn.turnId}", HttpMethod.DELETE)
                }) { Text("Withdraw") }
            }
        }
    }, confirmButton = { TextButton(onClick = { queued = false }) { Text("Close") } })
    withdrawingWake?.let { turnId ->
        AlertDialog(onDismissRequest = { withdrawingWake = null }, title = { Text(WatchWakeQueue.confirmTitle) },
            text = { Text(WatchWakeQueue.consequence) },
            confirmButton = { TextButton(onClick = { withdrawingWake = null; model.control("turns/$turnId", HttpMethod.DELETE) }) {
                Text(WatchWakeQueue.withdraw, color = MaterialTheme.colorScheme.error)
            } },
            dismissButton = { TextButton(onClick = { withdrawingWake = null }) { Text(WatchWakeQueue.keep) } })
    }
}

/** The engine's guess in the empty box (docs/prompt-suggestions-design.md §4.3): the words, cut at the end, and "Double-tap to use"
 * right after them. TalkBack skips the hint: its own double-tap is "activate", and it takes the guess with the field's
 * "Use suggestion" action. */
@Composable
internal fun SuggestionPlaceholder(suggestion: String) = Row(verticalAlignment = Alignment.CenterVertically) {
    Text(suggestion, Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis)
    Text("Double-tap to use", Modifier.padding(start = 8.dp).testTag("composer-suggestion-hint").clearAndSetSemantics {},
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

/** A press held past the long-press timeout runs [offer] instead of the press (Send's Queue for next turn): the lift that ends the hold
 * is kept from the button, so it is not a send as well. A shorter press, or one that slides away, is the button's own. Watched in the
 * Initial pass, ahead of the button's own gestures. */
internal fun Modifier.holdToOffer(enabled: Boolean, offer: () -> Unit): Modifier = if (!enabled) this else composed {
    val latestOffer by rememberUpdatedState(offer)
    pointerInput(Unit) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val ended = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) { waitForUpOrCancellation(PointerEventPass.Initial); true }
            if (ended == true) return@awaitEachGesture
            latestOffer()
            waitForUpOrCancellation(PointerEventPass.Initial)?.consume()
        }
    }
}

/** The model chip (iOS `modelChipLabel`): the model's name, and — on a task run still on the model smart selection picked — a ✦ before
 * it on a light tint of the accent. Named aloud "Model X, effort Y" — or [spokenName], where the name already says its effort — and
 * ", picked by smart selection" while it carries the ✦. */
@Composable
internal fun ModelChip(name: String, effort: String, smart: Boolean, enabled: Boolean, modifier: Modifier = Modifier, spokenName: String? = null,
    open: () -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    val spoken = (spokenName ?: "Model $name, effort $effort") + if (smart) TaskDetailCopy.chipPickedBySmartSelection else ""
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
private fun ModelChoices(model: ComposerModel, state: ComposerState, detail: JsonObject, usable: Boolean, smart: JsonObject?,
    taskId: String?, openTask: ((String) -> Unit)?, openRunner: ((String, String) -> Unit)?, close: () -> Unit) {
    val catalog = state.catalog
    val provider = detail.text("provider") ?: ""
    // The session's engine, which nothing here changes (contract §3.5): the menu opens on it, and every row below is its.
    val engine = catalog?.engineOf(detail) ?: ProviderEngines.sessionEngine(detail.text("engine") ?: detail.text("lastEngine"), provider, emptyList())
    val chosen = detail.text("model") ?: ""
    val enabled = usable && !state.busy && catalog != null && state.draft.pending == null
    val rememberModel = LocalRememberModel.current
    fun change(key: String, value: String) { model.config(buildJsonObject { put(key, value) }) }
    AlertDialog(onDismissRequest = close, title = {
        // The engine this session runs on for good (iOS 0557592f8), over everything below that picks for the next turn — in the
        // dialog's head, so it stays in view as the Provider list scrolls.
        Column {
            Text("Model and account")
            Text(ProviderEngines.cliName(engine), Modifier.padding(top = 4.dp).testTag("composer-engine-title"), style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
            // A task run on smart selection's pick opens on why it is this model, and on where to fix the model for every run.
            smart?.let { SmartRouteNote(it); HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
            if (state.catalogLoading) CircularProgressIndicator()
            state.catalogError?.let { Text(it); TextButton(onClick = model::loadCatalog) { Text("Retry model catalog") } }
            val rows = catalog?.models(engine, provider).orEmpty()
            // A Cursor CLI model is the one its value names, whatever context or speed it carries beside it (`CursorRuntime.pick`).
            val cursorPick = if (engine == CursorRuntime.ENGINE) CursorRuntime.pick(chosen, catalog, provider) else null
            val chosenName = cursorPick?.model ?: chosen
            rows.forEach { row ->
                TextButton(enabled = enabled, onClick = {
                    val id = row.text("value") ?: return@TextButton
                    // A07-19 (e): the next new session on this engine and credential starts on it (`<engine>:<provider>`, contract
                    // §6.5): one key's model on Claude Code is not its model on DeepSeek Harness.
                    if (provider.isNotEmpty()) rememberModel(engine, provider, id)
                    model.config(buildJsonObject {
                        put("model", id)
                        val effort = detail.text("effort") ?: ""
                        if (row.strings("reasoningLevels").isNotEmpty() && effort !in row.strings("reasoningLevels")) put("effort", row.text("defaultReasoningLevel") ?: "")
                        // A Cursor CLI model with no effort of its own — Auto among them — runs with none.
                        else if (engine == CursorRuntime.ENGINE && row.strings("reasoningLevels").isEmpty() && effort.isNotEmpty()) put("effort", "")
                    })
                }) { Text((if (row.text("value") == chosenName) "✓ " else "") + (row.text("label") ?: row.text("value").orEmpty())) }
            }
            if (catalog != null && rows.isEmpty()) Text("This provider has not reported available models.")
            // Cursor CLI's Auto takes no parameters (contract §10): no Effort to offer, and a line on what it does instead (iOS 5 ②).
            if (CursorRuntime.onAuto(engine, chosen)) Text(CursorRuntime.AUTO_NOTE, Modifier.padding(vertical = 6.dp).testTag("composer-cursor-auto-note"),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val levels = catalog?.efforts(engine, provider, chosen).orEmpty()
            if (levels.isNotEmpty()) { Text("Effort"); (listOf("") + levels).forEach { effort ->
                TextButton(enabled = enabled, onClick = { change("effort", effort) }) { Text(effort.ifBlank { "Default" }) }
            } }
            // A Cursor CLI model's own context and speed (iOS 5 ③, web `cursorSettingRows`), each where the runner's catalogue says the
            // model takes it, carried in the session's model value by shared cursorModels.ts's rules (`claude-opus-5-5[context=1m,fast=true]`):
            // a value the model doesn't offer reads as its own, and one picked back at its default is taken out.
            if (cursorPick != null && !CursorRuntime.onAuto(engine, chosen)) CursorRuntime.settingRows(cursorPick).forEach { setting ->
                Text(setting.title)
                setting.values.forEach { (value, label) ->
                    TextButton(enabled = enabled, modifier = Modifier.testTag("composer-cursor-${setting.title.lowercase()}:$value"), onClick = {
                        change("model", CursorRuntime.encodeModel(cursorPick.model, cursorPick.parameters + (setting.id to value), cursorPick.row))
                    }) { Text((if (value == setting.value) "✓ " else "") + label) }
                }
            }
            // Asked of the engine: DeepSeek Harness enforces Default, Auto and Don't Ask alone, as the server does. Cursor CLI lists Default
            // too, greyed with why (D6, iOS 6 ①).
            val modes = catalog?.permissions(engine, provider, chosen).orEmpty()
            val listed = if (engine == CursorRuntime.ENGINE && modes.isNotEmpty()) listOf("default") + modes else modes
            val current = detail.text("permissionMode")
            if (listed.isNotEmpty()) { Text("Permissions"); listed.forEach { mode ->
                TextButton(enabled = enabled && mode in modes, onClick = { change("permissionMode", mode) }, modifier = Modifier.testTag("composer-mode:$mode")) {
                    Column {
                        Text((if (mode == current) "✓ " else "") + (personalPermissions.firstOrNull { it.first == mode }?.second ?: mode))
                        // What the mode does there, in the shared table's words, where it does less than its name says.
                        (if (engine == CursorRuntime.ENGINE) CursorRuntime.modeNote(mode) else null)?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            } }
            if (catalog?.fast(engine, provider, chosen) == true) TextButton(enabled = enabled, onClick = { model.config(buildJsonObject { put("fastMode", detail.flag("fastMode") != true) }) }) {
                Text(if (detail.flag("fastMode") == true) "Speed: Fast" else "Speed: Standard")
            }
            if (catalog != null) ProviderChoices(model, catalog, engine, provider, detail, state.draft.resumeConfig, enabled,
                fix = openRunner?.let { open -> { engine: String -> catalog.runner.text("id")?.let { runner -> close(); open(runner, engine) } } })
            // …and ends on the task, pushed over this run, so Back returns to it.
            if (smart != null && taskId != null && openTask != null) {
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                TextButton(onClick = { close(); openTask(taskId) }, modifier = Modifier.testTag("composer-open-task")) { Text(TaskDetailCopy.openTask) }
            }
        }
    }, confirmButton = { TextButton(onClick = close) { Text("Close") } })
}

/**
 * The Provider part of the menu (boards 4 ④⑤ and 5): only the credentials the session's [engine] runs, grouped by where they come
 * from — the runner's own sign-in (its accounts, where it keeps several: Automatic first with what it does, then each with its own
 * quota, iOS 9ee358083), or OpenCode's own configuration there; the account pools; the keys. Picking one moves the session's
 * credential and never its engine. A row this runner can't run says why and, where the engine's page on the runner fixes that,
 * goes there ([fix], iOS d2737d665). A session whose key the menu no longer lists — turned off, deleted — shows it first, under
 * its own heading, saying what became of it; a credential below fixes the session.
 */
@Composable
private fun ProviderChoices(model: ComposerModel, catalog: ComposerCatalog, engine: String, provider: String, detail: JsonObject, held: JsonObject,
    enabled: Boolean, fix: ((engine: String) -> Unit)?) {
    val antigravityKey = catalog.antigravityKeyAvailable(detail)
    val options = catalog.credentials(engine, antigravityKey)
    val current = catalog.current(engine, provider, antigravityKey)
    val gone = catalog.gone(engine, provider)
    val runnerName = RunnerPage.displayName(catalog.runner)
    val amber = LocalOrbitColors.current.needsYou
    val draft = model.target != null
    val remembered = LocalDefaultModels.current
    // A Cursor CLI session that has talked, on a runner that can't carry its conversation: its other accounts and keys are listed but
    // can't be picked, and the menu says why (D5, iOS 6 ④⑤) — the move the server would refuse.
    val moveBlocked = CursorRuntime.moveBlocked(engine, detail, catalog.runner, draft)
    fun pick(option: ProviderOption, account: String? = null) = model.config(buildJsonObject {
        put("provider", option.id); put("engine", engine)
        account?.let { put("account", it) }
        // A draft lands on the model last picked for the engine and this credential (A07-19 (e)).
        put("model", if (draft) catalog.newSessionModel(engine, option.id, remembered) else catalog.defaultModel(engine, option.id)); put("effort", "")
    })
    @Composable fun header(text: String) = Text(text, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant)
    @Composable fun row(option: ProviderOption) {
        // The one the session is on is the list's own caption, whatever stops it; any other this runner can't run says why.
        val here = option.id == provider
        val blocked = option.unavailable != null && !here
        val repair = option.fixEngine?.takeIf { blocked && fix != null }
        TextButton(enabled = enabled && (!blocked || repair != null) && !(moveBlocked && !here),
            onClick = { if (repair != null) fix?.invoke(repair) else if (!here) pick(option) },
            modifier = Modifier.testTag("composer-provider:${option.id}")) {
            // What a sign-in is (`opencode auth`, a Google account) goes under its name, as the boards' menus put it.
            Column {
                Text(if (blocked) "${option.label} — ${option.unavailable}" + (option.fixEngine?.let { ProviderChoices.fixSuffix(it, option.unavailable) } ?: "")
                    else (if (here) "✓ " else "") + option.label)
                option.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
    Row(Modifier.padding(top = 8.dp).testTag("composer-provider"), verticalAlignment = Alignment.CenterVertically) {
        Text(EngineCopy.PROVIDER, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
        // A07-19 (d): a sign-in by the account in use — Automatic while Orbit picks it — OpenCode's own configuration as its own sign-in.
        Text(gone ?: catalog.providerValue(current, engine, detail, held, draft), Modifier.testTag("composer-provider-value"),
            color = if (gone != null) amber else MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (options.none { it.id == provider } && provider.isNotEmpty()) {
        if (current.kind == CredentialKind.KEY) header(EngineCopy.THIS_SESSIONS_KEY)
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp).testTag("composer-provider-current"), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f, fill = false)) {
                Text(current.label, color = MaterialTheme.colorScheme.onSurfaceVariant)
                current.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            gone?.let { Text("  " + if (it == EngineCopy.KEY_DELETED) "Deleted" else it, color = amber) }
        }
    }
    val own = options.filter { it.kind == CredentialKind.LOGIN || it.kind == CredentialKind.OPENCODE }
    if (own.isNotEmpty()) {
        header(if (own.any { it.kind == CredentialKind.LOGIN && it.unavailable == null }) EngineCopy.signedInOn(runnerName) else EngineCopy.on(runnerName))
        own.forEach { option ->
            // An engine's own sign-in with several accounts is its accounts. On the sign-in the session is on, those are the ones it
            // moves between — a draft starts on any of them, a session moves only where the runner carries it across; a draft on
            // another credential of this engine lands on the one picked.
            val here = option.id == provider
            // Cursor CLI's are listed for a session on any runner: one that has not talked moves between them (D5), and one that has lists
            // them greyed.
            val accounts = if (option.kind != CredentialKind.LOGIN || option.unavailable != null && !here) emptyList()
                else catalog.accountChoices(engine).takeIf { it.size >= 2 &&
                    (draft || here && (catalog.movesAccounts(engine) || engine == CursorRuntime.ENGINE)) }.orEmpty()
            if (accounts.isEmpty()) { row(option); return@forEach }
            // The account this session (or draft) is on, as the Provider row names it (A07-19 (d)): Automatic while Orbit picks it,
            // else the one picked, its own, its workspace's — Default, which dispatch resolves a sign-in with no account named to.
            val on = if (here) catalog.accountOn(engine, detail, held, draft) else null
            fun mark(account: String) = if (on != null && account == (if (on.automatic) EngineAccounts.AUTOMATIC else on.account)) "✓ " else ""
            fun take(account: String) = if (here) model.config(buildJsonObject { put("account", account) }, true) else pick(option, account)
            // A Cursor conversation that has started stays on its account: Automatic only picks where one starts.
            AccountRow(mark(EngineAccounts.AUTOMATIC) + EngineCopy.AUTOMATIC, EngineCopy.AUTOMATIC_DETAIL, enabled && !moveBlocked,
                spoken = "Automatic: starts on the ${ProviderEngines.cliName(engine)} account whose quota resets soonest" +
                    if (engine == CursorRuntime.ENGINE) "" else ", and switches when it hits its limit") {
                take(EngineAccounts.AUTOMATIC)
            }
            accounts.forEach { account ->
                // Its own quota under it: "5h 12%", or what an Antigravity bucket has left, "gemini-5h 4% left". A signed-out account is a
                // request for its sign-in, on the runner's page for the engine.
                AccountRow(mark(account.id) + account.label, account.unavailable?.let { "$it, sign in →" } ?: account.quota,
                    enabled && !moveBlocked && (account.unavailable == null || fix != null), nearLimit = account.nearLimit && account.unavailable == null) {
                    if (account.unavailable == null) take(account.id) else fix?.invoke(engine)
                }
            }
        }
    }
    options.filter { it.kind == CredentialKind.POOL }.takeIf { it.isNotEmpty() }?.let { pools -> header(EngineCopy.ACCOUNT_POOLS); pools.forEach { row(it) } }
    options.filter { it.kind == CredentialKind.KEY }.takeIf { it.isNotEmpty() }?.let { keys -> header(EngineCopy.API_KEYS); keys.forEach { row(it) } }
    if (moveBlocked) Text(CursorRuntime.MOVE_BLOCKED_NOTE, Modifier.padding(top = 8.dp).testTag("composer-provider-move-blocked"),
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    // A Claude subscription token is the one key on Anthropic's protocol OpenCode does not run: its absence there is said.
    if (engine == ProviderEngines.OPENCODE) catalog.providers.filter { it.flag("pool") != true && it.text("runtime") == ProviderEngines.CLAUDE &&
        it["engines"] is JsonArray && catalog.providerEngines(it.text("slug")) == listOf(ProviderEngines.CLAUDE) }.mapNotNull { it.text("label") ?: it.text("slug") }.takeIf { it.isNotEmpty() }?.let {
        Text(EngineCopy.subscriptionOnly(it), Modifier.padding(top = 8.dp).testTag("composer-provider-note"), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * The new session's Engine list (board 4 ①; iOS `EngineSwitchSheet`): the CLI the session will run on for good, one row per engine
 * in ALL_ENGINES order, each saying the model where a pick of it lands — or why it can't run here. Which credential and which
 * account it spends is the composer's Provider menu's question. DeepSeek Harness with no DeepSeek key offers the connection, on
 * the web, instead.
 */
@Composable
internal fun EngineChoices(model: ComposerModel, state: ComposerState, detail: JsonObject, server: String,
    openRunner: ((runner: String, engine: String) -> Unit)? = null, close: () -> Unit) {
    val catalog = state.catalog
    val uri = LocalUriHandler.current
    val current = catalog?.engineOf(detail)
    val remembered = LocalDefaultModels.current
    // Where each engine lands: the draft's pick, then what the workspace last ran there.
    val preferred = listOf(detail.text("engine") to detail.text("provider"), detail.text("lastEngine") to (detail.text("lastProvider") ?: detail.text("provider")))
    AlertDialog(onDismissRequest = close, title = { Text(EngineCopy.ENGINE) }, text = {
        Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()).testTag("engine-choices")) {
            if (state.catalogLoading) CircularProgressIndicator()
            state.catalogError?.let { Text(it); TextButton(onClick = model::loadCatalog) { Text("Retry model catalog") } }
            if (catalog != null) catalog.engines(preferred, catalog.antigravityKeyAvailable(detail)).forEach { option ->
                val connect = option.unavailable == EngineCopy.CONNECT_DEEPSEEK_KEY
                val landing = option.landing
                // An engine this runner can't run goes to the runner's page for it, where that fixes it (iOS d2737d665).
                val repair = option.fixEngine?.takeIf { openRunner != null }
                val secondary = when {
                    connect -> "${EngineCopy.CONNECT_DEEPSEEK_KEY} →"
                    option.unavailable != null -> option.unavailable + (option.fixEngine?.let { ProviderChoices.fixSuffix(it, option.unavailable) } ?: "")
                    landing != null -> catalog.modelLabel(option.engine, landing.id, catalog.defaultModel(option.engine, landing.id))
                    else -> ""
                }
                Row(Modifier.fillMaxWidth().clickable(enabled = connect || repair != null || option.unavailable == null && !state.busy, role = Role.Button) {
                    if (connect) runCatching { uri.openUri(server.trimEnd('/') + EngineCopy.DEEPSEEK_CONNECT_PATH) }
                    else if (repair != null) catalog.runner.text("id")?.let { runner -> openRunner?.invoke(runner, repair) }
                    else if (landing != null && option.engine != current) model.config(buildJsonObject {
                        put("engine", option.engine); put("provider", landing.id)
                        // The model last picked for the engine and where it lands, while still offered (A07-19 (e), iOS `pickDraft`).
                        val next = catalog.newSessionModel(option.engine, landing.id, remembered)
                        put("model", next); put("effort", "")
                        // A mode the new engine refuses is not carried over: DeepSeek Harness takes Default, Auto and Don't Ask; Cursor CLI
                        // has no Default, and starts in Accept Edits (D6).
                        detail.text("permissionMode")?.takeIf { it !in catalog.permissions(option.engine, landing.id, next) }
                            ?.let { put("permissionMode", CursorRuntime.fallbackMode(option.engine)) }
                    })
                    close()
                }.padding(vertical = 10.dp).testTag("engine:${option.engine}"), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    // The offer to connect a key goes under Harness's name, whole (board 4 ①); a model or a reason beside its engine.
                    if (connect) Column(Modifier.weight(1f)) {
                        Text(option.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(secondary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    } else {
                        // The engine's name is the row: it keeps its width and the model beside it gives way first (iOS 0ae7ec209). Half
                        // the row each cut "DeepSeek Harness" beside its model and tick on a 360 dp phone.
                        Text(option.label, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = if (option.unavailable == null) Color.Unspecified else MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(secondary, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.End,
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (option.engine == current) Text("✓", color = MaterialTheme.colorScheme.primary)
                }
            }
            Text(EngineCopy.ENGINE_FOOTER, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }, confirmButton = { TextButton(onClick = close) { Text("Done") } })
}
