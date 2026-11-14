package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.guests.GuestConversation
import io.orbitd.android.core.guests.GuestCopy
import io.orbitd.android.core.guests.GuestSession
import io.orbitd.android.core.guests.GuestTone
import io.orbitd.android.core.guests.SharedWithMe
import io.orbitd.android.core.guests.hint
import io.orbitd.android.core.guests.tone
import io.orbitd.android.core.guests.waiting
import io.orbitd.android.core.guests.word
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.wiki.PageBar
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * The guest view (docs/session-guests-design.md §4; boards docs/mocks/share-links/10-session-guests-3 and 11-guest-one-link-2; web
 * `GuestSessionView`): a session someone invited this account to reply in. Its head — the title and `Shared by <owner>` in the bar, the
 * status and a Guest badge under it — over the transcript the guest door projects, drawn by the reader's own rows, read only: no
 * approval, no session menu. A composer that only takes text: no mode, model or effort, no `!` shell, no attachments. A message is a
 * turn of the owner's session, on the owner's machine; one to an ended session restarts it there. The guest's own messages are headed
 * `You` and the owner's with the owner's name. A 404 at any point is the not-shared state.
 */
@Composable
fun GuestSessionPage(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, id: String, initial: GuestSession? = null) {
    val auth by app.session.state.collectAsState()
    val myName = (auth as? AuthState.SignedIn)?.user?.name
    val scope = rememberCoroutineScope()
    val model = remember(handle, id, myName) { GuestConversation(app.session, handle, id, myName, scope, initial) }
    val view by model.state.collectAsState()
    var retry by remember(model) { mutableIntStateOf(0) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Followed only while the app is on screen (web: not while the tab is hidden); back on screen, it reads at once.
    LaunchedEffect(model, lifecycle, retry) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.follow() } }
    PageBar.Bind(route, title = if (view.loaded) SharedWithMe.firstLine(view.title) else null,
        subtitle = if (view.loaded) GuestCopy.sharedBy(view.ownerName) else null)
    when {
        view.gone -> NotShared()
        view.error != null && !view.loaded -> Box(Modifier.fillMaxSize().padding(16.dp)) {
            StatusMessage(GuestCopy.COULD_NOT_LOAD, view.error!!) { model.retryLoad(); retry++ }
        }
        !view.loaded -> Box(Modifier.fillMaxSize().padding(16.dp).testTag("guest-loading")) { LoadingMessage(GuestCopy.LOADING) }
        else -> GuestConversationView(model)
    }
}

/** What the door answers for every session this account cannot reply in: removed, left, Trash or deleted. */
@Composable
private fun NotShared() {
    Column(Modifier.fillMaxSize().padding(32.dp).testTag("guest-not-shared").semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(GuestCopy.NOT_SHARED, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(GuestCopy.NOT_SHARED_DETAIL, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center)
    }
}

@Composable
private fun GuestConversationView(model: GuestConversation) {
    val view by model.state.collectAsState()
    val owner = view.ownerName
    val rows = remember(view.events) { ExchangeFold.fold(Steps.group(transcriptRows(view.events, holdsSteers = false))) }
    val list = rememberLazyListState()
    // Pinned to the newest message until the reader scrolls away from it, as the reader's own list follows.
    var pinned by remember { mutableStateOf(true) }
    LaunchedEffect(list) {
        // Read where a scroll came to rest: one that ended at the newest message pins the list again, one that ended above it lets go.
        snapshotFlow { list.isScrollInProgress }.distinctUntilChanged()
            .collect { scrolling -> if (!scrolling) pinned = !list.canScrollForward }
    }
    LaunchedEffect(rows.lastOrNull()?.key, rows.size) { if (pinned && rows.isNotEmpty()) list.scrollToItem(rows.size) }
    val full = remember(model) { FullEvents { model.full(it) } }
    Column(Modifier.fillMaxSize()) {
        GuestHead(view.state.word, view.state.tone)
        CompositionLocalProvider(LocalOwnerHeading provides owner) {
            LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("guest-transcript"), state = list,
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                item(key = "older") {
                    if (view.hasOlder) TextButton(enabled = !view.loadingOlder, onClick = { pinned = false; model.older() }) {
                        Text(if (view.loadingOlder) GuestCopy.LOADING else GuestCopy.LOAD_EARLIER)
                    }
                }
                // A guest page names nothing outside the conversation: its links are drawn as their words.
                items(rows, key = { it.key }) { row -> TranscriptRowView(row, full, null, {}) }
            }
        }
        GuestComposer(model, owner)
    }
}

/** The status pill (web `status-pill`, toned as the public page tones it) and the Guest badge. */
@Composable
private fun GuestHead(word: String, tone: GuestTone) {
    val colors = LocalOrbitColors.current
    val color = when (tone) {
        GuestTone.RUNNING -> colors.running
        GuestTone.AWAITING -> colors.needsYou
        GuestTone.DONE -> colors.success
        GuestTone.FAILED -> MaterialTheme.colorScheme.error
        GuestTone.QUEUED, GuestTone.CANCELLED -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("guest-head"),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.background(color.copy(alpha = 0.12f), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp)
            .testTag("guest-status"), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (tone == GuestTone.RUNNING) CircularProgressIndicator(Modifier.size(10.dp), color = color, strokeWidth = 1.5.dp)
            else Box(Modifier.size(7.dp).background(color, CircleShape))
            Text(word, color = color, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        }
        Text(GuestCopy.GUEST_BADGE, Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp).testTag("guest-badge"),
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    HorizontalDivider()
}

/** Text only: the box, Send, and the line under it — where a message runs, that it waits its turn, or that it restarts the session. */
@Composable
private fun GuestComposer(model: GuestConversation, owner: String) {
    val view by model.state.collectAsState()
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (view.state.waiting) Row(Modifier.testTag("guest-waiting").semantics { liveRegion = LiveRegionMode.Polite },
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(7.dp).background(LocalOrbitColors.current.needsYou, CircleShape))
            Text(GuestCopy.waiting(owner), style = MaterialTheme.typography.bodySmall, color = LocalOrbitColors.current.needsYou)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(view.draft, model::edit, Modifier.weight(1f).testTag("guest-composer-input"), enabled = !view.sending,
                placeholder = { Text(GuestCopy.placeholder(owner), maxLines = 1) }, minLines = 1, maxLines = 4)
            Spacer(Modifier.width(8.dp))
            Button(onClick = model::send, enabled = view.draft.isNotBlank() && !view.sending, modifier = Modifier.testTag("guest-send")) {
                Text(if (view.sending) "Sending…" else "Send")
            }
        }
        val error = view.sendError
        Text(error ?: view.state.hint(owner), Modifier.testTag("guest-hint"), style = MaterialTheme.typography.bodySmall,
            color = if (error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
