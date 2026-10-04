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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.cards.SessionCards
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
    LaunchedEffect(state.window.seeded, state.loading, state.targetSeq) {
        if (route.recordId != null && state.window.seeded && !state.loading && state.targetSeq != null) recordOpened = true
    }
    val rows = remember(state.window.events) { transcriptRows(state.window.events) }
    val resources = remember(handle, route.id) { ReaderResources(app.session, handle, route.id) }
    val openLink = rememberReaderLinkHandler(resources) { next ->
        if (next.destination == Destination.SESSION && ObjectId.same(next.id, route.id) &&
            next.recordId != null && next.recordId == route.recordId) model.openRecord(next.recordId)
        else open(next)
    }
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
    LaunchedEffect(state.window.events, transcript?.textDrafts, transcript?.thinkingDrafts, transcript?.toolOutputs, follow, placed) {
        if (placed && follow && !dragging && state.window.newerAfter == null && !state.loading) {
            withFrameNanos { }
            positioning = true
            list.scrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
            positioning = false
        }
    }
    CompositionLocalProvider(LocalReaderResources provides resources) {
        Column(Modifier.fillMaxSize()) {
            val session = state.session
            val detail = session?.snapshot?.detail
            if (state.denied) {
                StatusMessage("Session unavailable", if (session?.error?.httpStatus == 403) "You don't have permission to access this item." else "This item is no longer available.", model::retry)
            } else {
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
                if (!state.window.seeded) LoadingMessage("Loading messages…")
                // Capture all lazy intervals in this composition, preserving A05's measurement fix.
                val displayedRows = rows
                val displayedWindow = state.window
                val live = transcript.takeIf { displayedWindow.newerAfter == null }
                val displayedLoading = state.loading
                val targetSeq = state.targetSeq
                LazyColumn(Modifier.weight(1f).fillMaxWidth().nestedScroll(nested).pointerInput(model) {
                    // Do not consume the gesture: native selection/links still receive it.
                    // A touch pauses following so a live update cannot move text under a selection.
                    awaitEachGesture { awaitFirstDown(requireUnconsumed = false); follow = false }
                }.testTag("transcript-list"), state = list,
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
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
                    item(key = "interaction-cards") { SessionCards(openLink) }
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
