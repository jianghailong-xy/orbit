package io.orbitd.android.reader

import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.composer.SessionComposer
import io.orbitd.android.cards.CardFocus
import io.orbitd.android.cards.NeedsYouLogic
import io.orbitd.android.cards.ReaderSide
import io.orbitd.android.cards.SessionCards
import io.orbitd.android.cards.SessionNeedsYouBar
import io.orbitd.android.watch.SessionWatches
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.*
import io.orbitd.android.directory.*
import io.orbitd.android.navigation.*
import io.orbitd.android.text.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

@Composable
fun SessionReader(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, api: DirectoryApi,
    data: DirectoryData, open: (OrbitRoute) -> Unit) {
    var recordOpened by rememberSaveable { mutableStateOf(false) }
    val model = remember(handle, route.id, route.recordId) { SessionReaderModel(app.session, handle,
        app.realtime, route.id!!, app.processScope, route.recordId, recordOpened) }
    DisposableEffect(model) { onDispose { model.close() } }
    val state by model.state.collectAsState()
    val composer = remember(app, handle, route.id) { app.composer(handle, route.id!!) }
    val composerState by composer.state.collectAsState()
    var composeFocus by remember(handle, route.id) { mutableIntStateOf(0) }
    var composerFocused by remember(handle, route.id) { mutableStateOf(false) }
    LaunchedEffect(state.window.seeded, state.loading, state.targetSeq) {
        if (route.recordId != null && state.window.seeded && !state.loading && state.targetSeq != null) recordOpened = true
    }
    val rows = remember(state.window.events) { transcriptRows(state.window.events) }
    val readable by rememberUpdatedState(!state.denied)
    val attachmentMetadata by rememberUpdatedState(state.window.events.flatMap { event ->
        (event.fields["attachments"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
    }.associateBy { ObjectId.canonical(it.string("id").orEmpty()) })
    // The session's pictures in transcript order: image attachments, and uploads linked by name in prose.
    val galleryImages by rememberUpdatedState(remember(state.window.events) { sessionImages(state.window.events) })
    val resources = remember(handle, route.id) { ReaderResources(app.session, handle, route.id,
        available = { readable }, metadata = { source ->
            attachmentMetadata[ObjectId.canonical(source.removePrefix("orbit-attachment:"))]?.let {
                (it.string("name") ?: it.string("fileName") ?: "Attachment") to
                    (it.string("mime") ?: it.string("mimeType") ?: "application/octet-stream")
            }
        }, images = { galleryImages } ) }
    val openLink = rememberReaderLinkHandler(resources) { next ->
        if (next.destination == Destination.SESSION && ObjectId.same(next.id, route.id) &&
            next.recordId != null && next.recordId == route.recordId) model.openRecord(next.recordId)
        else open(next)
    }
    // The worktree bar's model: its own reads while an outcome is pending or the session is live, and the store's as they land.
    val worktree = remember(handle, route.id) { WorktreeModel(api, route.id!!, app.processScope) }
    val list = rememberLazyListState()
    var follow by rememberSaveable { mutableStateOf(route.recordId == null) }
    var placed by remember(model) { mutableStateOf(false) }
    var dragging by remember { mutableStateOf(false) }
    var positioning by remember { mutableStateOf(false) }
    var details by rememberSaveable { mutableStateOf(false) }
    var action by remember { mutableStateOf<DirectoryDialog?>(null) }
    val currentRows by rememberUpdatedState(rows)
    val nested = remember { object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            if (source == NestedScrollSource.UserInput) { follow = false; dragging = true }
            return Offset.Zero
        }
    } }
    LaunchedEffect(model, state.denied) { if (state.denied) { action = null; details = false; placed = false } }
    LaunchedEffect(state.ready, state.window.seeded, state.targetTick) {
        if (!state.ready || !state.window.seeded || state.denied) return@LaunchedEffect
        positioning = true
        if (!placed) follow = model.following
        withFrameNanos { }
        val target = state.targetSeq?.let { anchorRow(currentRows, it) }
        if (target != null) {
            follow = false
            list.scrollToItem(currentRows.indexOf(target) + 1, state.targetOffset)
        } else if (follow) list.scrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
        placed = true; positioning = false
    }
    // The observer writes a record+pixel offset, not an index that would change on a prepend.
    LaunchedEffect(model, list) {
        snapshotFlow { Triple(list.isScrollInProgress, list.layoutInfo.visibleItemsInfo, list.canScrollForward) }
            .collect { (scrolling, visible, canForward) ->
                if (placed && !positioning) {
                    if (!scrolling && dragging) { follow = !canForward && model.state.value.window.newerAfter == null; dragging = false }
                    val item = visible.firstOrNull { it.key.toString().startsWith("event:") }
                    val seq = item?.key?.toString()?.substringAfter(':')?.toLongOrNull()
                    if (seq != null) model.position(seq, -item.offset, follow)
                }
            }
    }
    val transcript = state.session?.transcript
    val snapshotDetail = state.session?.snapshot?.detail
    // What the needs-you bar counts in this conversation (iOS `ConsoleModel.openBelowRows`), and which way it lies from
    // the reader: the cards are drawn in the rail before the tail, so they are above only once the reader is past it.
    val belowRows = remember(state.session?.snapshot) {
        state.session?.snapshot?.let { NeedsYouLogic.belowRows(state.session!!.id, it) }.orEmpty()
    }
    val readerSide by remember(list) { derivedStateOf {
        when (val top = topLineItem(list.layoutInfo.visibleItemsInfo, list.layoutInfo.viewportStartOffset)) {
            null -> null
            "tail" -> ReaderSide.ABOVE
            else -> ReaderSide.BELOW
        }
    } }
    val scope = rememberCoroutineScope()
    LaunchedEffect(snapshotDetail) { snapshotDetail?.let(worktree::offer) }
    LaunchedEffect(worktree, state.denied) {
        if (!state.denied) worktree.poll { (worktree.state.value.detail ?: snapshotDetail)?.let { it.string("runStatus") ?: it.string("status") } in
            setOf("RUNNING", "AWAITING_INPUT", "INTERRUPTED") }
    }
    // A06-5: the viewport changing size under a pinned reader (keyboard, a taller composer, the sticky
    // header) asks for the tail again; nothing else re-anchors the bottom of a list that shrank.
    val viewport = remember(model) { TranscriptViewport() }
    var repin by remember(model) { mutableIntStateOf(0) }
    LaunchedEffect(state.window.events, transcript?.textDrafts, transcript?.thinkingDrafts, transcript?.toolOutputs, follow, placed, repin) {
        if (placed && follow && !dragging && state.window.newerAfter == null && !state.loading) {
            withFrameNanos { }
            positioning = true
            list.scrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
            positioning = false
        }
    }
    // Background agents' and workflows' progress, as their cards and the background list read it.
    val background = state.session?.snapshot?.background
    val taskActivity = remember(transcript?.taskProgress, state.window.events, background) {
        TaskActivity.of(transcript?.taskProgress, state.window.events, background.orEmpty())
    }
    CompositionLocalProvider(LocalReaderResources provides resources, LocalTaskActivity provides taskActivity) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
        val otherInputHasKeyboard = WindowInsets.ime.getBottom(LocalDensity.current) > 0 && !composerFocused
        val composerHeight = if (otherInputHasKeyboard) 0.dp else if (maxHeight < 320.dp) maxHeight else maxHeight * 0.65f
        val compact = maxWidth < 600.dp
        Column(Modifier.fillMaxSize()) {
            val session = state.session
            val detail = session?.snapshot?.detail
            if (state.denied) {
                StatusMessage("Session unavailable", if (session?.error?.httpStatus == 403) "You don't have permission to access this item." else "This item is no longer available.", model::retry)
            } else {
                Column(Modifier.weight(1f).fillMaxWidth()) {
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { details = true }, enabled = detail != null) { Text(detail?.string("title") ?: "Session details") }
                    val directorySession = remember(detail) { detail?.let { runCatching { Wire.json.decodeFromJsonElement(DirectorySession.serializer(), it) }.getOrNull() } }
                    TextButton(enabled = session?.fresh == true && data.fresh && directorySession != null,
                        onClick = { action = DirectoryDialog.SessionMenu(directorySession!!,
                            SessionView.entries.firstOrNull { it.name == directorySession.lifecycleState } ?: SessionView.OPEN) }) { Text("Session options") }
                }
                // Connection changes must not insert/remove a banner above the reading viewport.
                val reconnecting = session?.fresh != true && state.window.seeded
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 16.dp),
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Text(if (reconnecting) "Saved messages · Reconnecting…" else sessionLabel(session),
                        Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                    // Reserve the scaled button's height even while fresh, including 200% text.
                    TextButton(onClick = model::retry, enabled = reconnecting,
                        modifier = Modifier.alpha(if (reconnecting) 1f else 0f)
                            .then(if (reconnecting) Modifier else Modifier.clearAndSetSemantics { })) { Text("Retry") }
                }
                state.error?.let { StatusMessage("Couldn't load messages", it, model::retry) }
                // The needs-you bar, under the header and over the transcript (iOS `NeedsYouBannerView` in the console's top
                // inset). Its press here unpins the reader and shows the waiting card, which the card rail brings into view.
                SessionNeedsYouBar(app, handle, route.id!!, list, hidden = composerFocused && compact,
                    below = NeedsYouLogic.below(belowRows, readerSide), open = open, onBelow = { row ->
                        follow = false
                        scope.launch {
                            // The rail is the item before the tail; a card in it is brought into view once it is drawn.
                            list.scrollToItem((list.layoutInfo.totalItemsCount - 2).coerceAtLeast(0))
                            CardFocus.request(route.id!!, row)
                        }
                    })
                // Capture all lazy intervals in this composition, preserving A05's measurement fix.
                val displayedRows = rows
                val displayedWindow = state.window
                val live = transcript.takeIf { displayedWindow.newerAfter == null }
                val displayedLoading = state.loading
                val targetSeq = state.targetSeq
                // Folds away while a phone's composer holds the keyboard, with the rest of the chrome.
                StickyQuestion(displayedRows, list, hidden = composerFocused && compact) { row -> model.show(row.event.seq) }
                LazyColumn(Modifier.weight(1f).fillMaxWidth().onSizeChanged {
                    if (viewport.resized(it.height, placed && follow && state.window.newerAfter == null)) repin++
                }.nestedScroll(nested).pointerInput(model) {
                    // Do not consume the gesture: native selection/links still receive it.
                    // A touch pauses following so a live update cannot move text under a selection.
                    awaitEachGesture { awaitFirstDown(requireUnconsumed = false); follow = false }
                }.testTag("transcript-list"), state = list,
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (!displayedWindow.seeded) item(key = "loading") { LoadingMessage("Loading messages…") }
                    item(key = "older") {
                        if (displayedWindow.hasOlder) TextButton(enabled = !displayedLoading, onClick = { follow = false; model.older() }) { Text(if (displayedLoading) "Loading messages…" else "Load earlier messages") }
                    }
                    items(displayedRows, key = { it.key }, contentType = { it.event.type }) { row ->
                        TranscriptRowView(row, model, live, openLink, row.contains(targetSeq ?: -1))
                    }
                    if (displayedWindow.seeded && displayedRows.isEmpty()) item(key = "empty") { Text("No messages yet") }
                    if (live != null) {
                        items(live.thinkingDrafts.entries.toList(), key = { "thinking:${it.key}" }) { entry ->
                            LiveMessage("Thinking", entry.key, entry.value, openLink)
                        }
                        items(live.textDrafts.entries.toList(), key = { "assistant:${it.key}" }) { entry ->
                            LiveMessage("Assistant", entry.key, entry.value, openLink)
                        }
                    }
                    item(key = "newer") { if (displayedWindow.newerAfter != null) TextButton(enabled = !displayedLoading, onClick = model::newer) { Text("Load newer messages") } }
                    item(key = "interaction-cards") { SessionCards(openLink, discuss = if (!composerState.loaded) null else { context ->
                        val prior = composer.state.value.draft.text
                        val text = prior + (if (prior.isBlank()) "" else "\n\n") + context
                        composer.edit(text, text.length, text.length)
                        composerFocused = true
                        composeFocus++
                    }) }
                    item(key = "tail") { Spacer(Modifier.height(1.dp).testTag("transcript-tail")) }
                }
                if (!follow || state.window.newerAfter != null) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                    TextButton(onClick = {
                        val last = rows.lastOrNull { it.event.type == "user" }
                        if (last != null) model.show(last.event.seq)
                    }, enabled = rows.any { it.event.type == "user" }) { Text("Last question") }
                    TextButton(onClick = { follow = true; model.latest() }) { Text("Jump to latest") }
                }
                }
                SessionWatches(app, handle, route.id!!, open = open)
                // The session's code output, folded with the rest of the chrome while a phone's composer is focused.
                if (!(composerFocused && compact)) Box(Modifier.padding(horizontal = 16.dp)) { WorktreeBar(worktree, openLink) }
                // Keep the composer and its activity-result launchers alive while card forms use the IME.
                // The chip's Open task › pushes the task over this run, so Back returns to it.
                Box(Modifier.heightIn(max = composerHeight).clipToBounds()) { SessionComposer(app, handle, route.id!!, state.session,
                    focusRequest = composeFocus, inputFocusChanged = { composerFocused = it }, openTask = { open(OrbitRoute(Destination.TASK, it)) }) }
            }
        }
        }
        if (details && !state.denied) SessionDetails(state.session, api, openLink) { details = false }
        action?.let { DirectoryActionDialog(it, api, data.copy(fresh = data.fresh && state.session?.fresh == true), { action = it }) {
            app.realtime.refreshDirectory(); app.realtime.refreshSession()
        } }
    }
}

private fun sessionLabel(session: SessionState?): String {
    val snapshot = session?.snapshot
    return when {
        snapshot?.approvals?.isNotEmpty() == true -> "Waiting for your reply"
        session?.error != null -> "Disconnected · Retrying"
        snapshot != null -> snapshot.detail.string("runState") ?: snapshot.detail.string("status") ?: "Session"
        else -> "Connecting…"
    }
}

@Composable
private fun LiveMessage(label: String, parent: String, text: String, open: (String) -> Unit) {
    Column { Text(if (parent.isEmpty()) "$label · Live" else "Subagent · $label · Live", style = MaterialTheme.typography.labelMedium)
        if (label == "Thinking") {
            var expanded by rememberSaveable { mutableStateOf(false) }
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide thinking" else "Show thinking") }
            if (expanded) StreamingText(text, open)
        } else StreamingText(text, open)
    }
}

/** Every picture a reader can page through: image attachments, and `[label](orbit-attachment:id "name.png")` links. */
internal fun sessionImages(events: List<RunEvent>): List<String> {
    val linked = Regex("""\[[^\]\n]+\]\((orbit-attachment:[^)\s]+)(?:\s+"((?:\\.|[^"\\])*)")?\)""")
    return events.flatMap { event ->
        val attached = (event.fields["attachments"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
            .filter { (it.string("mime") ?: it.string("mimeType"))?.startsWith("image/") == true }
            .mapNotNull { it.string("id")?.let { id -> "orbit-attachment:$id" } }
        val body = event.body()
        attached + if ("orbit-attachment:" !in body) emptyList() else linked.findAll(body)
            .filter { MarkdownFileRef(it.groupValues[1], "", it.groupValues[2].ifEmpty { null }).isImage }.map { it.groupValues[1] }.toList()
    }.distinct()
}
