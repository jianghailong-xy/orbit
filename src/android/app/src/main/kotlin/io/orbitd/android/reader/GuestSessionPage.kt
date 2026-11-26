package io.orbitd.android.reader

import android.content.ClipboardManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import io.orbitd.android.OrbitApplication
import io.orbitd.android.attachments.AttachmentActions
import io.orbitd.android.attachments.importGuestImage
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.guests.GuestConversation
import io.orbitd.android.core.guests.guestStream
import io.orbitd.android.core.guests.GuestCopy
import io.orbitd.android.core.guests.GuestImage
import io.orbitd.android.core.guests.GuestSession
import io.orbitd.android.core.guests.GuestState
import io.orbitd.android.core.guests.GuestTone
import io.orbitd.android.core.guests.SharedWithMe
import io.orbitd.android.core.guests.completed
import io.orbitd.android.core.guests.displayFacts
import io.orbitd.android.core.guests.hint
import io.orbitd.android.core.guests.marks
import io.orbitd.android.core.guests.tone
import io.orbitd.android.core.guests.waiting
import io.orbitd.android.core.guests.word
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.directory.SessionDisplay
import io.orbitd.android.directory.SessionMarkChips
import io.orbitd.android.directory.SessionStateGlyph
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.text.ReaderResources
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.wiki.PageBar
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * The guest view (docs/session-guests-design.md §4; boards docs/mocks/share-links/10-session-guests-3 and 11-guest-one-link-2; web
 * `GuestSessionView`): a session someone invited this account to reply in. Its head — the title and `Shared by <owner>` in the bar, the
 * status and a Guest badge under it — over the transcript the guest door projects, drawn by the reader's own rows, read only: no
 * approval, no session menu. A composer that takes words and images (PNG, JPEG, WebP or GIF up to 5 MB, picked or pasted): no mode,
 * model or effort, no `!` shell, no other files. A message is a turn of the owner's session, on the owner's machine; one to an ended
 * session restarts it there. The guest's own messages are headed `You` and the owner's with the owner's name. A 404 at any point is
 * the not-shared state.
 */
@Composable
fun GuestSessionPage(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, id: String, initial: GuestSession? = null) {
    val auth by app.session.state.collectAsState()
    val myName = (auth as? AuthState.SignedIn)?.user?.name
    val scope = rememberCoroutineScope()
    val model = remember(handle, id, myName) { GuestConversation(app.session, handle, id, myName, scope, initial,
        stream = app.session.guestStream(handle)) }
    val view by model.state.collectAsState()
    var retry by remember(model) { mutableIntStateOf(0) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Followed only while the app is on screen (web: not while the tab is hidden): the guest stream is closed when the page leaves
    // STARTED and opened again from the newest seq read on return (polling, when it cannot be opened).
    LaunchedEffect(model, lifecycle, retry) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.follow() } }
    PageBar.Bind(route, title = if (view.loaded) SharedWithMe.firstLine(view.title) else null,
        subtitle = if (view.loaded) GuestCopy.sharedBy(view.ownerName) else null)
    when {
        view.gone -> NotShared()
        view.error != null && !view.loaded -> Box(Modifier.fillMaxSize().padding(16.dp)) {
            StatusMessage(GuestCopy.COULD_NOT_LOAD, view.error!!) { model.retryLoad(); retry++ }
        }
        !view.loaded -> Box(Modifier.fillMaxSize().padding(16.dp).testTag("guest-loading")) { LoadingMessage(GuestCopy.LOADING) }
        // A turn's images are read through the guest door: the owner's `attachments/:id` answers a guest 404.
        else -> CompositionLocalProvider(LocalReaderResources provides remember(handle, id) { ReaderResources(app.session, handle, guestSessionId = id) }) {
            GuestConversationView(model)
        }
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
    val tail = rows.size + view.thinkingDrafts.size + view.textDrafts.size
    LaunchedEffect(rows.lastOrNull()?.key, tail, view.textDrafts, view.thinkingDrafts) { if (pinned && tail > 0) list.scrollToItem(tail) }
    val full = remember(model) { FullEvents { model.full(it) } }
    Column(Modifier.fillMaxSize()) {
        GuestHead(view.state)
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
                // The reply as the stream types it out, drawn as the owner's reader draws its live drafts.
                items(view.thinkingDrafts.entries.toList(), key = { "thinking:${it.key}" }) { LiveMessage("Thinking", it.key, it.value) {} }
                items(view.textDrafts.entries.toList(), key = { "assistant:${it.key}" }) { LiveMessage("Assistant", it.key, it.value) {} }
            }
        }
        GuestComposer(model, owner)
    }
}

/** The status pill (web `status-pill`, toned as the public page tones it), the marks and, for a filed session whose state is the
 * facts', Completed (web `SharedSessionStatus`), then the Guest badge. From an older server the pill alone says how it stands. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun GuestHead(state: GuestState) {
    val colors = LocalOrbitColors.current
    val shown = SessionDisplay.state(state.displayFacts)
    val tone = state.tone
    val color = when (tone) {
        GuestTone.RUNNING -> colors.running
        GuestTone.AWAITING -> colors.needsYou
        GuestTone.DONE -> colors.success
        GuestTone.FAILED -> MaterialTheme.colorScheme.error
        GuestTone.QUEUED, GuestTone.IDLE, GuestTone.CANCELLED -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    FlowRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("guest-head"),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp),
        itemVerticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.background(color.copy(alpha = 0.12f), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp)
            .testTag("guest-status"), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (shown != null) SessionStateGlyph(shown)
            else if (tone == GuestTone.RUNNING) CircularProgressIndicator(Modifier.size(10.dp), color = color, strokeWidth = 1.5.dp)
            else Box(Modifier.size(7.dp).background(color, CircleShape))
            Text(state.word, color = color, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        }
        // The chips say nothing themselves (a row's value says them), so the head says them here for a screen reader.
        state.marks?.takeIf { it.isNotEmpty() }?.let { marks ->
            SessionMarkChips(marks, Modifier.semantics { contentDescription = marks.joinToString(", ") { it.word } })
        }
        if (shown != null && state.completed) GuestBadge(GuestCopy.COMPLETED, "guest-completed")
        GuestBadge(GuestCopy.GUEST_BADGE, "guest-badge")
    }
    HorizontalDivider()
}

@Composable
private fun GuestBadge(word: String, tag: String) {
    Text(word, Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(4.dp))
        .padding(horizontal = 6.dp, vertical = 2.dp).testTag(tag),
        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** The staged images, the box with its + (Image, Paste image) and Send, and the line under it — where a message runs, that it waits
 * its turn, or that it restarts the session. The owner's composer's picker, paste and staged rows, uploaded through the guest door. */
@Composable
private fun GuestComposer(model: GuestConversation, owner: String) {
    val view by model.state.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<GuestImage?>(null) }
    var selectionNotice by remember { mutableStateOf<String?>(null) }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(5)) { uris ->
        // The older OpenDocument fallback does not enforce Photo Picker's selection count.
        selectionNotice = if (uris.size > 5) "Only the first five selected photos were added." else null
        uris.take(5).forEach { importGuestImage(context, scope, model, it, "photo") }
    }
    val clipboard = context.getSystemService(ClipboardManager::class.java)
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (view.state.waiting) Row(Modifier.testTag("guest-waiting").semantics { liveRegion = LiveRegionMode.Polite },
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(7.dp).background(LocalOrbitColors.current.needsYou, CircleShape))
            Text(GuestCopy.waiting(owner), style = MaterialTheme.typography.bodySmall, color = LocalOrbitColors.current.needsYou)
        }
        selectionNotice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        view.images.forEach { image ->
            Column(Modifier.testTag("guest-image")) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { preview = image }, modifier = Modifier.weight(1f)) {
                        Text("${image.name} · ${image.size / 1024} KB", maxLines = 2)
                    }
                    TextButton(onClick = { model.removeImage(image.id) }, enabled = !view.sending,
                        modifier = Modifier.testTag("guest-image-remove")) { Text("Remove") }
                }
                if (image.uploading) LinearProgressIndicator(Modifier.fillMaxWidth())
                image.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box {
                TextButton(enabled = !view.sending, onClick = { menu = true }, modifier = Modifier.testTag("guest-attach")) { Text("+") }
                DropdownMenu(menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Image") }, onClick = {
                        menu = false; photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    })
                    val clip = clipboard.primaryClip
                    if (clip != null && clip.itemCount > 0 && clip.description.hasMimeType("image/*")) {
                        DropdownMenuItem(text = { Text("Paste image") }, onClick = {
                            menu = false; clip.getItemAt(0).uri?.let { importGuestImage(context, scope, model, it, "paste") }
                        })
                    }
                }
            }
            OutlinedTextField(view.draft, model::edit, Modifier.weight(1f).testTag("guest-composer-input"), enabled = !view.sending,
                placeholder = { Text(GuestCopy.placeholder(owner), maxLines = 1) }, minLines = 1, maxLines = 4)
            Spacer(Modifier.width(8.dp))
            // With images alone it sends too; pressed while one is still uploading, it waits for it.
            Button(onClick = model::send, enabled = view.canSend, modifier = Modifier.testTag("guest-send")) {
                Text(if (view.sending && view.uploading) "Uploading…" else if (view.sending) "Sending…" else "Send")
            }
        }
        val error = view.sendError
        Text(error ?: view.state.hint(owner), Modifier.testTag("guest-hint"), style = MaterialTheme.typography.bodySmall,
            color = if (error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
    }
    preview?.let { image ->
        val index = view.images.indexOfFirst { it.id == image.id }
        AttachmentActions(image.name, image.mime, { model.imageBytes(image.id) ?: error("This image is no longer attached.") },
            contentKey = image.id,
            previous = if (index > 0) ({ preview = view.images[index - 1] }) else null,
            next = if (index >= 0 && index < view.images.lastIndex) ({ preview = view.images[index + 1] }) else null) { preview = null }
    }
}
