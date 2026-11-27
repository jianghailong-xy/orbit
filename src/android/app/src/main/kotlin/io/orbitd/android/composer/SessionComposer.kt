package io.orbitd.android.composer

import android.content.ClipboardManager
import android.view.ViewTreeObserver
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.*
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalWindowInfo
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
import io.orbitd.android.management.LocalSmartSelection
import io.orbitd.android.management.LocalTranslation
import io.orbitd.android.management.LocalPromptOptimizer
import io.orbitd.android.core.promptoptimizer.PromptOptimizer
import io.orbitd.android.core.promptoptimizer.PromptOptimizerCopy
import io.orbitd.android.core.translation.Translation
import io.orbitd.android.core.protocol.SessionFacts
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.personalPermissions
import io.orbitd.android.reader.ComposerFold
import io.orbitd.android.reader.SteerDelivery
import io.orbitd.android.reader.UnreadSteer
import io.orbitd.android.reader.queuedTail
import io.orbitd.android.tasks.TaskDetailCopy
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*

@Composable
internal fun SessionComposer(app: OrbitApplication, handle: SessionHandle, sessionId: String, session: SessionState?, target: DraftTarget? = null, focusRequest: Int = 0,
    inputFocusChanged: (Boolean) -> Unit = {},
    openTask: ((String) -> Unit)? = null, openRunner: ((runner: String, engine: String) -> Unit)? = null,
    openTranslationSettings: (() -> Unit)? = null,
    /** The page's own placeholder, over the composer's: a new account's welcome card (WelcomeCopy.WELCOME_PLACEHOLDER). */
    placeholder: String? = null,
    /** A page chat's chips over the text, ahead of the staged files: `Folder · Scans ✕` (PageChat). */
    chips: (@Composable () -> Unit)? = null) {
    val model = remember(app, handle, sessionId) { app.composer(handle, sessionId, target) }
    val state by model.state.collectAsState()
    val context = LocalContext.current
    val draft = state.draft
    var field by remember(model) { mutableStateOf(TextFieldValue()) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val window = LocalWindowInfo.current
    // A hand-off from a sheet ("Chat about this" in a card's review) comes while the sheet's window still has the focus, and a
    // focus or keyboard asked for then is lost with nothing to ask again (A08i): it is asked for once this window has it back.
    LaunchedEffect(focusRequest) {
        if (focusRequest > 0) { snapshotFlow { window.isWindowFocused }.first { it }; focus.requestFocus(); keyboard?.show() }
    }
    // Keep TextFieldValue's composing range during IME updates. Disk stores committed text/cursor,
    // never an IME's stale composing range after a new input connection or process.
    LaunchedEffect(draft.text, draft.selectionStart, draft.selectionEnd) {
        if (field.text != draft.text) field = TextFieldValue(draft.text,
            TextRange(draft.selectionStart.coerceIn(0, draft.text.length), draft.selectionEnd.coerceIn(0, draft.text.length)))
    }
    var menu by remember { mutableStateOf(false) }
    var drivePicker by remember { mutableStateOf(false) }
    val driveOffered = io.orbitd.android.drive.driveShown(app, handle)
    var models by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<StagedAttachment?>(null) }
    var queued by remember { mutableStateOf(false) }
    // The watch's wake the queue's Withdraw is asking about first (A08-14).
    var withdrawingWake by remember { mutableStateOf<String?>(null) }
    var slashScope by remember { mutableStateOf<String?>(null) }
    var selectionNotice by remember { mutableStateOf<String?>(null) }
    // Board 02 ②: while the coordinator writes its handoff note, and while it hands over, nothing is sent into it.
    val handingOver = target == null && CoordinatorHandoff.outgoing(session?.snapshot?.detail)?.locksComposer == true
    val usable = state.loaded && session.canCompose() && !handingOver
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
    if (drivePicker) {
        // It opens on the session's project folder (D22), named as the project is.
        val project = ((detail["projectMembership"] as? JsonObject)?.get("projectTitle") as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
        io.orbitd.android.drive.DrivePickerSheet(io.orbitd.android.drive.DriveStore.of(app, handle), project,
            onDismiss = { drivePicker = false }) { paths ->
            drivePicker = false
            val text = draft.text
            val added = (if (text.isNotEmpty() && !text.last().isWhitespace()) " " else "") + paths.joinToString(" ") + " "
            val end = text.length + added.length
            model.edit(text + added, end, end)
        }
    }
    val picked = JsonObject(detail + draft.resumeConfig)
    // A new session that names no model starts on its workspace's `lastModel` when it runs on the workspace's lastEngine and
    // lastProvider, while the runner still offers it (docs/workspace-default-model-design.md) — read once the workspace has one.
    val lastModel = detail.text("lastModel") != null
    LaunchedEffect(model, lastModel) {
        if (target != null && lastModel && model.state.value.let { it.catalog == null && !it.catalogLoading }) model.loadCatalog()
    }
    val seed = if (target == null || draft.resumeConfig["model"] != null) null else state.catalog?.let { catalog ->
        catalog.engineOf(picked).let { engine ->
            catalog.liveLastModel(engine, draft.resumeConfig.text("provider") ?: detail.text("lastProvider") ?: engine, detail)
        }
    }
    val effective = if (seed == null) picked else JsonObject(picked + ("model" to JsonPrimitive(seed)))
    // What is still waiting, as the transcript's tail draws it (A07-14): never the accepted head — the runner's now, which nothing
    // withdraws — nor a steer's receipt.
    val waiting = remember(session?.snapshot?.queuedTurns, session?.transcript?.events) {
        queuedTail(session?.snapshot?.queuedTurns.orEmpty(), session?.transcript?.events.orEmpty())
    }
    val running = detail.text("runState") == "RUNNING" || detail.text("status") == "RUNNING"
    // The engine this session's turns run on, which no pick here changes: whether a message can go into a running one (Send's other
    // way), and what the box says while Cursor CLI's runs.
    val engine = ProviderChoices.engine(detail, state.catalog?.providers.orEmpty())
    val midTurn = SteerDelivery.runtimeTakesMidTurnSteer(engine)
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
    val translation = LocalTranslation.current
    // Frame 6 of the failure policy board: while the server skips a failing translator, the tag warns that messages will wait — until
    // the instant passes, which the server does not announce, so a timer here draws the ordinary tag again.
    val translationUnavailable = translationUnavailable(translation)
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
    // The keyboard is up when Compose's IME inset says so, or when the window's own insets do (A15 F-48, as `ComposerFold`):
    // Android 15's recreated window fits the keyboard itself and leaves the inset at 0. Nothing composes this box again as that
    // window's keyboard comes and goes, so the window's word is read each time the window lays out.
    val focusManager = LocalFocusManager.current
    val view = LocalView.current
    var windowIme by remember(view) { mutableStateOf(ComposerFold.windowIme(view)) }
    DisposableEffect(view) {
        val read = ViewTreeObserver.OnGlobalLayoutListener { windowIme = ComposerFold.windowIme(view) }
        view.viewTreeObserver.addOnGlobalLayoutListener(read)
        onDispose { view.viewTreeObserver.removeOnGlobalLayoutListener(read) }
    }
    var imeWasUp by remember { mutableStateOf(false) }
    val imeUp = WindowInsets.ime.getBottom(LocalDensity.current) > 0 || windowIme
    LaunchedEffect(imeUp) {
        if (imeUp) imeWasUp = true
        else if (imeWasUp) { imeWasUp = false; if (inputFocused) focusManager.clearFocus() }
    }
    val focusField: () -> Unit = { focus.requestFocus(); keyboard?.show() }
    // Prompt optimizer (board docs/mocks/prompt-optimizer, frames 2–6; iOS ComposerView): ✦ Optimize beside Send while the account has
    // it on and the box holds a draft it can improve — and, while a press is out, as the busy button that cancels it.
    val optimizer = state.optimizer
    val showsOptimize = optimizer.isOptimizing || PromptOptimizer.showsButton(LocalPromptOptimizer.current, field.text)
    // Edit, then use: the box takes the caret once the sheet's window has given the focus back (A08i, as [focusRequest]).
    var editFocus by remember { mutableIntStateOf(0) }
    LaunchedEffect(editFocus) {
        if (editFocus > 0) { snapshotFlow { window.isWindowFocused }.first { it }; focus.requestFocus(); keyboard?.show() }
    }
    val useSuggestion: () -> Unit = {
        suggestion?.let {
            field = TextFieldValue(it, TextRange(it.length))
            model.edit(it, it.length, it.length)
            focusField()
        }
    }
    // Board docs/mocks/android-composer-parity (iOS ComposerView's card): what the toolbar shows, worked out before it is drawn.
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
    // Cursor CLI's model by its catalogue's name, its effort and what the session set (iOS 5 ①②) — one name, its effort inside it.
    val cursorModel = if (shownEngine == CursorRuntime.ENGINE) CursorRuntime.modelName(state.catalog,
        effective.text("provider") ?: shownEngine, effective.text("model").orEmpty(), effective.text("effort")) else null
    // Any other model by its catalogue's name too (web and iOS do), and a Claude id the catalogue has no row for
    // as Claude Code names it — a signed-out runner whose probe failed showed the bare `claude-opus-5-5`.
    val modelName = effective.text("model")?.let { id ->
        if (id.isBlank()) "Runtime default"
        else state.catalog?.modelLabel(shownEngine, effective.text("provider") ?: shownEngine, id)
            ?: if (shownEngine == ProviderEngines.CLAUDE) ProviderEngines.claudeModelName(id) else id
    }
    val dshPicks = dsh && effective.text("model").isNullOrBlank()
    val chipName = cursorModel ?: if (dshPicks) DshRuntime.PICKED_BY else modelName ?: "Model"
    // The effort after the name (decided 2026-11-19, iOS `chipEffortLabel`): "High", and " · Fast" with the fast lane on. Cursor CLI's
    // name already carries its effort and settings; a model DeepSeek Harness picks has none to name.
    val chipEffort = if (cursorModel != null || dshPicks) null else effortLabel(effective.text("effort")) +
        if (effective.flag("fastMode") == true && state.catalog?.fast(shownEngine, effective.text("provider") ?: shownEngine, effective.text("model").orEmpty()) == true) " · Fast" else ""
    // The permission mode beside `+` (iOS `modeMenu`): what the session runs in, by the shared table's name.
    // Always shown, as iOS's: one the session names, else the mode it runs in with none named (Default; Cursor CLI's Accept Edits).
    val modeValue = shownPermissionMode(effective, shownEngine)
    val modeLabel = personalPermissions.firstOrNull { it.first == modeValue }?.second ?: modeValue
    // The plan's binding window, which the gauge draws beside the ring once the catalogue that reports it is in.
    val planRow = state.catalog?.usage(effective)?.let { io.orbitd.android.management.bindingRow(it, System.currentTimeMillis()) }
    var modeMenu by remember { mutableStateOf(false) }
    val focused = inputFocused && imeUp
    // The band under the card is the page's own colour (iOS `ComposerBand`): a tonal elevation tinted it grey-blue apart from the page.
    // Not a Surface: a Surface clips to itself, and the card's light-mode shadow spreads over the page above the band, as on iOS.
    CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurface) {
        Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 16.dp, vertical = 6.dp)
            .testTag("session-composer")) {
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                state.error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = model::clearError) { Text("Dismiss error") } }
                if (!state.loaded && !state.busy) TextButton(onClick = model::restore) { Text("Retry draft restore") }
                state.notice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                if (state.acknowledgementPending) {
                    Text("Session created. Save its confirmation to continue.")
                    Button(enabled = !state.busy, onClick = model::retrySend) { Text("Retry saving confirmation") }
                }
                selectionNotice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                // Not for a session a move let go: nothing tells its reader it ended (SessionFacts.releasedByMove).
                if (target == null && terminal(detail) && !SessionFacts.releasedByMove(detail)) {
                    Text("Sending a message will resume this session in Open.", style = MaterialTheme.typography.bodySmall)
                    (detail["capabilities"] as? JsonObject)?.text("resumeBlockedReason")?.let { reason ->
                        Text(reason); TextButton(onClick = { app.realtime.refreshSession() }) { Text("Check Again") }
                    }
                }
                if (!session.canCompose()) Text("Reconnect to send. Your draft is saved.", style = MaterialTheme.typography.bodySmall)
                draft.pending?.let { pending ->
                    Text("Delivery unconfirmed: ${pending.text.take(120)}", style = MaterialTheme.typography.bodySmall)
                    if (isCreate(pending.endpoint)) Text("Creation is unconfirmed. Check this workspace's sessions before creating another session.")
                    else Button(enabled = !state.busy && !state.waiting && session?.accessDenied != true, onClick = model::retrySend) { Text("Retry saved send") }
                }
                // Frame 6: the press failed; the draft below is untouched.
                if (optimizer.failed) PromptOptimizationFailureLine(retry = model::retryOptimize, dismiss = model::dismissOptimization)
            }
            // The card: staged attachments, the text across its whole width, and the toolbar pinned to its foot. The text grows
            // upward and the toolbar never moves, so `+` and Send stay where the thumb left them however long the message gets.
            Column(Modifier.weight(1f, fill = false).fillMaxWidth().composerCardLift().clip(ComposerCardShape).background(composerCardColor())
                .border(1.dp, composerCardBorder(focused), ComposerCardShape).testTag("composer-card")) {
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                    chips?.invoke()
                    // Decided 2026-11-19: inside the card, above the text, as iOS draws them.
                    AttachmentStrip(draft.attachments, state.uploads, bytes = { model.attachmentBytes(it) },
                        open = { preview = it }, remove = { model.removeAttachment(it.id) })
                    // Settings › Translation (6A): while it is on, the box says which way its words go — "Chinese → English" —
                    // and the tag opens Settings › Sessions, where the switch and the language are. Like the placeholder, it
                    // shows only while the box is empty, so typed text gets the whole width. A suggestion on offer takes the line
                    // instead (docs/mocks/prompt-suggestion-room), unless the tag is warning that translation is unavailable.
                    val tag = translation.takeIf { it.on && field.text.isEmpty() && (suggestion == null || translationUnavailable) }
                    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = if (tag != null) 10.dp else 16.dp, top = 14.dp, bottom = 6.dp),
                        verticalAlignment = Alignment.Top) {
                        Box(Modifier.weight(1f)) {
                            SuggestionTaps(suggestion != null, inputFocused, focusField, useSuggestion) { taps ->
                                val textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface)
                                BasicTextField(field, onValueChange = { field = it; model.edit(it.text, it.selection.start, it.selection.end) },
                                    modifier = Modifier.fillMaxWidth().focusRequester(focus).onFocusChanged { inputFocused = it.isFocused; inputFocusChanged(it.isFocused) }
                                        .testTag("composer-input")
                                        .then(taps)
                                        // TalkBack's own double-tap is "activate": it takes the guess with this action.
                                        .semantics { if (suggestion != null) customActions = listOf(CustomAccessibilityAction("Use suggestion") { useSuggestion(); true }) }
                                        .onPreviewKeyEvent {
                                            if (it.type == KeyEventType.KeyDown && it.key == Key.Enter && (it.isCtrlPressed || it.isMetaPressed) && field.composition == null && usable) {
                                                send(false); true
                                            } else false
                                        }, enabled = state.loaded && !handingOver,
                                    textStyle = textStyle, cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                                    minLines = 1, maxLines = 6,
                                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
                                    decorationBox = { inner ->
                                        Box {
                                            if (field.text.isEmpty()) CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurfaceVariant,
                                                LocalTextStyle provides textStyle.copy(color = MaterialTheme.colorScheme.onSurfaceVariant)) {
                                                if (suggestion != null) SuggestionPlaceholder(suggestion)
                                                // Cursor CLI takes no message mid-turn: one written now waits for the turn to end (iOS 5 ⑥).
                                                else Text(when {
                                                    placeholder != null -> placeholder
                                                    handingOver -> CoordinatorHandoffCopy.HANDING_OVER
                                                    target?.isMachineDraft == true || (target != null && MachineSetup.standsInForMachine(detail)) ->
                                                        detail.text("name")?.takeIf { it.isNotEmpty() }?.let(MachineSetupCopy::composerPlaceholderFor) ?: "Message…"
                                                    target == null && running && engine == CursorRuntime.ENGINE -> CursorRuntime.RUNNING_PLACEHOLDER
                                                    else -> "Message…"
                                                }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                            }
                                            inner()
                                        }
                                    })
                            }
                        }
                        tag?.let { on ->
                            Text(io.orbitd.android.translation.TranslationFailureCopy.composerTag(on.language, on.agentLanguage, translationUnavailable),
                                Modifier.padding(start = 8.dp, top = 1.dp).testTag("composer-translation-tag")
                                .clip(RoundedCornerShape(50)).background(MaterialTheme.colorScheme.surfaceVariant)
                                .then(if (openTranslationSettings != null) Modifier.clickable(role = Role.Button, onClick = openTranslationSettings) else Modifier)
                                .padding(horizontal = 8.dp, vertical = 2.dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = if (translationUnavailable) LocalOrbitColors.current.needsYou else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                // The toolbar: `+` and the mode on the left; the model, the gauge, Optimize and Send on the right. Only the model's name
                // gives way, and only after Optimize has folded to ✦ and the effort has left the chip ([toolbarFit]).
                val measure = rememberToolbarMeasure()
                val toolbarStyle = toolbarTextStyle()
                val optimizeStyle = MaterialTheme.typography.labelMedium
                BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = (TOOLBAR_EDGE / 2).dp).padding(bottom = 4.dp)) {
                    val fixed = TOOLBAR_PLUS + TOOLBAR_SEND + (if (planRow != null) TOOLBAR_CAPSULE else TOOLBAR_RING) +
                        measure(modeLabel, toolbarStyle.copy(fontWeight = FontWeight.Medium)) + TOOLBAR_TEXT_PAD
                    val chipWithEffort = measure(chipName, toolbarStyle.copy(fontWeight = FontWeight.SemiBold)) + TOOLBAR_TEXT_PAD +
                        (chipEffort?.let { 5f + measure(it, toolbarStyle) } ?: 0f) + (if (smart != null) 30f else 0f)
                    // PromptOptimizeButton's full pill: its mark (✦, or the 12 dp spinner), 4 dp, the word, 9 dp each side, 2 dp around.
                    val optimizeWidth = if (!showsOptimize) null else (if (optimizer.isOptimizing) 12f else measure("✦", optimizeStyle)) + 4f +
                        measure(if (optimizer.isOptimizing) PromptOptimizerCopy.OPTIMIZING else PromptOptimizerCopy.OPTIMIZE, optimizeStyle) + 22f
                    val fit = toolbarFit(maxWidth.value - fixed, chipWithEffort, optimizeWidth)
                    Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box {
                            ToolbarPlus(enabled = state.loaded) { menu = true }
                            DropdownMenu(menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(text = { Text("Image") }, onClick = { menu = false; photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) })
                                DropdownMenuItem(text = { Text("File") }, onClick = { menu = false; files.launch(arrayOf("*/*")) })
                                // From Drive (board 04-android ⑭, D21): a drive file's path goes in the message; nothing is uploaded again.
                                if (driveOffered) DropdownMenuItem(text = { Text("Drive") }, onClick = { menu = false; drivePicker = true },
                                    modifier = Modifier.testTag("composer-from-drive"))
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
                                    if (!draft.text.startsWith("!")) model.edit("!${draft.text}", 1, 1)
                                })
                                if (target == null) DropdownMenuItem(text = { Text("Queued messages (${waiting.size})") }, onClick = { menu = false; queued = true })
                                // A pick held for this session travels with the re-send, which would otherwise run on what it already has.
                                if (target == null) DropdownMenuItem(text = { Text("Retry last failed message") }, enabled = usable && !state.busy,
                                    onClick = { menu = false; model.retryFailed() })
                                if (detail.text("retryAt") != null) DropdownMenuItem(text = { Text("Cancel automatic retry") }, enabled = usable && !state.busy,
                                    onClick = { menu = false; model.control("auto-retry", HttpMethod.DELETE) })
                            }
                        }
                        modeLabel.let { label ->
                            Box {
                                ToolbarMode(label, enabled = usable && !state.busy && draft.pending == null && draft.createdSessionId == null) {
                                    modeMenu = true; model.loadCatalog()
                                }
                                DropdownMenu(modeMenu, onDismissRequest = { modeMenu = false }) {
                                    PermissionModeItems(model, state, effective, usable) { modeMenu = false }
                                }
                            }
                        }
                        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
                            ModelChip(chipName, effortLabel(effective.text("effort")), smart != null,
                                enabled = usable && !state.busy && draft.pending == null && draft.createdSessionId == null,
                                shownEffort = chipEffort?.takeIf { fit.showsEffort },
                                // …and aloud with its effort said once (iOS `chipAccessibilityLabel`): the name above already holds it.
                                spokenName = if (cursorModel == null) null else CursorRuntime.spokenName(state.catalog,
                                    effective.text("provider") ?: shownEngine, effective.text("model").orEmpty(), effective.text("effort"))) {
                                models = true; model.loadCatalog()
                            }
                        }
                        ComposerUsage(model, state, effective, session, planRow)
                        // Frame 2's ✦ Optimize beside Send; frame 3's busy "Optimizing…", which cancels when pressed.
                        if (showsOptimize) PromptOptimizeButton(busy = optimizer.isOptimizing, enabled = state.loaded, compact = fit.compactOptimize, press = model::optimize)
                        var queueMenu by remember { mutableStateOf(false) }
                        LaunchedEffect(queueOffered) { if (!queueOffered) queueMenu = false }
                        Box {
                            RoundSend(stop = stop, waiting = state.waiting || state.busy, enabled = sendEnabled,
                                label = if (state.waiting) "Uploading…" else if (state.busy) "Sending…" else if (stop) "Stop" else "Send",
                                modifier = Modifier.testTag("composer-send").holdToOffer(queueOffered) { queueMenu = true }.semantics {
                                    if (queueOffered) customActions = listOf(CustomAccessibilityAction(PendingTray.QUEUE_FOR_NEXT_TURN) { send(true); true })
                                }, press = { if (stop) model.stop() else send(false) })
                            DropdownMenu(queueMenu, onDismissRequest = { queueMenu = false }) {
                                DropdownMenuItem(text = { Text(PendingTray.QUEUE_FOR_NEXT_TURN) }, modifier = Modifier.testTag("composer-queue-next-turn"),
                                    leadingIcon = { Icon(painterResource(R.drawable.ic_queue_next), null, Modifier.size(16.dp)) },
                                    onClick = { queueMenu = false; send(true) })
                            }
                        }
                    }
                }
            }
            // Frame 5: after Use, Undo puts the owner's own draft back, for as long as the box still holds what Use put there, and for a
            // few seconds.
            if (optimizer.offersUndo(draft.text)) PromptOptimizationUndoToast(undo = model::undoOptimization, expired = model::forgetOptimizationUndo)
            // A07-19 (a): what the provider picked here will do, and when — under the box, for as long as the pick stands.
            state.switchNote?.let { Text(it, Modifier.fillMaxWidth().padding(top = 4.dp).testTag("composer-switch-note"),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
    // Frame 4 on a phone: the suggestion is a bottom sheet over the composer; the box is untouched until Use.
    optimizer.suggestion?.let { optimization ->
        PromptOptimizationSheet(optimization, optimizer.basedOnEarlierDraft(draft.text), optimizer.showingGloss, translation.language,
            toggleGloss = model::toggleOptimizationGloss, use = model::useOptimization,
            editThenUse = { model.useOptimization(); editFocus++ }, tryAgain = model::retryOptimize, dismiss = model::dismissOptimization)
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

/**
 * The session's tray of messages nothing has read yet (docs/mocks/steer-tray): the reader's steers — [unreadSteers], which the
 * conversation leaves out until the engine reads them ([SteerDelivery.place]) — and their messages still on the queue, acted on
 * through the session's composer [model]. The session page draws it as its band's first card, right under the conversation and
 * above the parking strip (docs/mocks/pending-tray-above-parking, decided 2026-10-28).
 */
@Composable
internal fun SessionPendingTray(model: ComposerModel, session: SessionState?, unreadSteers: List<UnreadSteer>,
    held: (@Composable () -> Unit)? = null) {
    val state by model.state.collectAsState()
    val detail = session?.snapshot?.detail ?: JsonObject(emptyMap())
    // What is still waiting, as the transcript's tail draws it (A07-14), and whether one can go into the turn running now.
    val waiting = remember(session?.snapshot?.queuedTurns, session?.transcript?.events) {
        queuedTail(session?.snapshot?.queuedTurns.orEmpty(), session?.transcript?.events.orEmpty())
    }
    val running = detail.text("runState") == "RUNNING" || detail.text("status") == "RUNNING"
    // The engine this session's turns run on: whether it takes a message mid-turn, and who it was that read one too late to withdraw.
    val engine = ProviderChoices.engine(detail, state.catalog?.providers.orEmpty())
    val usable = state.loaded && session.canCompose()
    val rows = PendingTray.rows(unreadSteers, waiting, state, steerOffered = usable && running && SteerDelivery.runtimeTakesMidTurnSteer(engine))
    PendingTrayCard(rows, enabled = usable, steer = { model.steer(it.turnId) },
        withdraw = { model.withdraw(it.turnId, it.restores, it.steer, engine) },
        // Cursor CLI takes no message mid-turn — one would stop the turn — so the tray says why its rows wait (iOS 5 ⑤).
        note = if (engine == CursorRuntime.ENGINE) CursorRuntime.QUEUE_NOTE else null, held = held)
}

/** The engine's guess in the empty box (docs/prompt-suggestions-design.md §4.3): the words, cut at the end, and "Double-tap"
 * right after them. TalkBack skips the hint: its own double-tap is "activate", and it takes the guess with the field's
 * "Use suggestion" action. */
@Composable
internal fun SuggestionPlaceholder(suggestion: String) = Row(verticalAlignment = Alignment.CenterVertically) {
    Text(suggestion, Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis)
    Text("Double-tap", Modifier.padding(start = 8.dp).testTag("composer-suggestion-hint").clearAndSetSemantics {},
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

/** The model chip (iOS `modelChipLabel`): the model's name in semibold, then [shownEffort] in the secondary colour ("Opus 5.5 High"),
 * which the toolbar leaves out where the row has no room for it before the name truncates; on a task run still on the model smart
 * selection picked, a ✦ before it all on a light tint of the accent. Named aloud "Model X, effort Y" — or [spokenName], where the
 * name already says its effort — and ", picked by smart selection" while it carries the ✦. */
@Composable
internal fun ModelChip(name: String, effort: String, smart: Boolean, enabled: Boolean, modifier: Modifier = Modifier, spokenName: String? = null,
    shownEffort: String? = null, open: () -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    val spoken = (spokenName ?: "Model $name, effort $effort") + if (smart) TaskDetailCopy.chipPickedBySmartSelection else ""
    val alpha = if (enabled) 1f else 0.38f
    Box(modifier.height(48.dp).clip(RoundedCornerShape(12.dp)).clickable(enabled = enabled, role = Role.Button, onClick = open)
        .testTag("composer-model").semantics { contentDescription = spoken }.padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
        Row(if (smart) Modifier.background(accent.copy(alpha = 0.12f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp) else Modifier,
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            // Said by the chip's spoken name rather than read out as a symbol.
            if (smart) Text("✦", Modifier.testTag("composer-model-smart"), color = accent.copy(alpha = alpha), style = toolbarTextStyle())
            Text(name, Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis, style = toolbarTextStyle(),
                fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha))
            shownEffort?.let { Text(it, Modifier.testTag("composer-model-effort"), maxLines = 1, softWrap = false, style = toolbarTextStyle(),
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha)) }
        }
    }
}

/** The permission mode the toolbar names: the one [detail] holds, else the one a session that names none runs in. */
internal fun shownPermissionMode(detail: JsonObject, engine: String): String =
    detail.text("permissionMode")?.takeIf { it.isNotEmpty() } ?: CursorRuntime.unsetMode(engine)

/**
 * The toolbar's permission mode menu (iOS `modeMenu`): the modes the engine offers for this model, ✓ on the one in use, each written
 * to the session as the model menu's Permissions rows do. Cursor CLI lists Default too, greyed with why (D6, iOS 6 ①); the menu waits
 * for the catalogue that says which modes there are.
 */
@Composable
internal fun PermissionModeItems(model: ComposerModel, state: ComposerState, detail: JsonObject, usable: Boolean, close: () -> Unit) {
    val catalog = state.catalog
    if (catalog == null) {
        DropdownMenuItem(text = { Text(state.catalogError ?: "Loading…") }, enabled = state.catalogError != null, onClick = model::loadCatalog)
        return
    }
    val engine = catalog.engineOf(detail)
    val modes = catalog.permissions(engine, detail.text("provider").orEmpty(), detail.text("model").orEmpty())
    val listed = if (engine == CursorRuntime.ENGINE && modes.isNotEmpty()) listOf("default") + modes else modes
    val current = shownPermissionMode(detail, engine)
    val enabled = usable && !state.busy && state.draft.pending == null
    listed.forEach { mode ->
        ModeMenuItem(personalPermissions.firstOrNull { it.first == mode }?.second ?: mode, mode == current,
            if (engine == CursorRuntime.ENGINE) CursorRuntime.modeNote(mode) else null, enabled && mode in modes,
            Modifier.testTag("composer-toolbar-mode:$mode")) {
            close(); if (mode != current) model.config(buildJsonObject { put("permissionMode", mode) })
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
    // A Cursor CLI session that has talked, on a runner that can't carry its conversation: its other accounts and keys are listed but
    // can't be picked, and the menu says why (D5, iOS 6 ④⑤) — the move the server would refuse.
    val moveBlocked = CursorRuntime.moveBlocked(engine, detail, catalog.runner, draft)
    fun pick(option: ProviderOption, account: String? = null) = model.config(buildJsonObject {
        put("provider", option.id); put("engine", engine)
        account?.let { put("account", it) }
        // A draft lands on its workspace's lastModel where that is this engine and credential's, else their default.
        put("model", if (draft) catalog.newSessionModel(engine, option.id, detail) else catalog.defaultModel(engine, option.id)); put("effort", "")
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
                // The runner's Claude region names no fix: the press still opens the machine's Claude Code page, which explains.
                Text(if (blocked) "${option.label} — ${option.unavailable}" + (option.fixEngine?.takeUnless { option.regionBlocked }
                    ?.let { ProviderChoices.fixSuffix(it, option.unavailable) } ?: "")
                    else (if (here) "✓ " else "") + option.label)
                option.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                option.notice?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
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
            // them greyed. None under a sign-in the runner's Claude region blocks: no session starts on any of them there.
            val accounts = if (option.kind != CredentialKind.LOGIN || option.unavailable != null && !here || option.regionBlocked) emptyList()
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
                    // The runner's Claude region names no fix; the row still opens the machine's Claude Code page.
                    option.unavailable != null -> option.unavailable + (option.fixEngine?.takeUnless { option.regionBlocked }
                        ?.let { ProviderChoices.fixSuffix(it, option.unavailable) } ?: "")
                    landing != null -> catalog.modelLabel(option.engine, landing.id, catalog.defaultModel(option.engine, landing.id))
                    else -> ""
                }
                Row(Modifier.fillMaxWidth().clickable(enabled = connect || repair != null || option.unavailable == null && !state.busy, role = Role.Button) {
                    if (connect) runCatching { uri.openUri(server.trimEnd('/') + EngineCopy.DEEPSEEK_CONNECT_PATH) }
                    else if (repair != null) catalog.runner.text("id")?.let { runner -> openRunner?.invoke(runner, repair) }
                    else if (landing != null && option.engine != current) model.config(buildJsonObject {
                        put("engine", option.engine); put("provider", landing.id)
                        // The workspace's lastModel where the engine lands on its lastEngine and lastProvider, else their default.
                        val next = catalog.newSessionModel(option.engine, landing.id, detail)
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

/** Whether [translation] is unavailable now, flipping back by itself the moment its `translationUnavailableUntil` passes. */
@Composable
internal fun translationUnavailable(translation: io.orbitd.android.management.AccountTranslation): Boolean {
    val until = translation.unavailableUntil
    var unavailable by remember(until) { mutableStateOf(translation.unavailableAt(java.time.Instant.now())) }
    LaunchedEffect(until) {
        if (until == null) return@LaunchedEffect
        val left = java.time.Duration.between(java.time.Instant.now(), until).toMillis()
        if (left > 0) kotlinx.coroutines.delay(left)
        unavailable = false
    }
    return unavailable
}
