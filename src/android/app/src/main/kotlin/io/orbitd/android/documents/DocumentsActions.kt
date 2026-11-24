package io.orbitd.android.documents

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.webkit.MimeTypeMap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.R
import io.orbitd.android.attachments.handOffFile
import io.orbitd.android.core.documents.DocumentsEntry
import io.orbitd.android.core.documents.DocumentsLogic
import io.orbitd.android.core.documents.DocumentsShareAnswer
import io.orbitd.android.core.documents.DocumentsShareCheck
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The writes and hand-offs a file or folder offers (board frame 4), shared by the folder page and the preview: each press reads its
 * answer back and says what happened in the page's snackbar; Move to Trash asks nothing and offers Undo (D6).
 */
internal class DocumentsActions(
    private val context: Context,
    private val store: DocumentsStore,
    private val scope: CoroutineScope,
    private val snackbar: SnackbarHostState,
) {
    private fun say(text: String, action: String? = null, then: (suspend () -> Unit)? = null) {
        scope.launch {
            snackbar.currentSnackbarData?.dismiss()
            val result = snackbar.showSnackbar(text, action, duration = if (action != null) SnackbarDuration.Long else SnackbarDuration.Short)
            if (result == SnackbarResult.ActionPerformed) then?.invoke()
        }
    }

    fun failed(what: String, error: Throwable) = say(store.failure(what, error))

    fun rename(entry: DocumentsEntry, name: String, done: (DocumentsEntry) -> Unit = {}) {
        val trimmed = name.trim()
        if (trimmed == entry.name) return
        DocumentsLogic.nameProblem(trimmed)?.let { return say(it) }
        scope.launch {
            runCatching { store.api.rename(entry.id, trimmed) }.onSuccess { done(it); store.changed(); say(DocumentsLogic.renamed(it.name)) }
                .onFailure { failed("rename ${entry.name}", it) }
        }
    }

    fun move(entry: DocumentsEntry, folderId: String, folderName: String, done: () -> Unit = {}) {
        scope.launch {
            runCatching { store.api.move(entry.id, folderId) }.onSuccess { done(); store.changed(); say(DocumentsLogic.moved(it.name, folderName)) }
                .onFailure { failed("move ${entry.name}", it) }
        }
    }

    fun newFolder(parentId: String?, name: String, done: (DocumentsEntry) -> Unit = {}) {
        val trimmed = name.trim()
        DocumentsLogic.nameProblem(trimmed)?.let { return say(it) }
        scope.launch {
            runCatching { store.api.createFolder(parentId, trimmed) }.onSuccess { done(it); store.changed() }
                .onFailure { failed("make the folder", it) }
        }
    }

    /** Move to Trash, then a snackbar with Undo, which restores the group it went in (board frame 3). */
    fun trash(entry: DocumentsEntry, done: () -> Unit = {}) {
        scope.launch {
            runCatching { store.api.moveToTrash(entry.id) }.onSuccess { trashed ->
                done(); store.changed()
                say(DocumentsLogic.movedToTrash(entry.name), DocumentsLogic.UNDO) {
                    runCatching { store.api.restoreGroup(trashed.trashGroupId) }.onSuccess { store.changed() }.onFailure { failed("restore ${entry.name}", it) }
                }
            }.onFailure { failed("move ${entry.name} to Trash", it) }
        }
    }

    /** Download to the phone's Downloads with the system's download notification, from a short-lived link that needs no login header. */
    fun download(entry: DocumentsEntry, versionId: String? = null) {
        scope.launch {
            runCatching {
                val link = store.api.downloadLink(entry.id, versionId)
                val base = store.handle.account.server.trimEnd('/')
                val url = base + (if (link.path.startsWith("/")) link.path else "/${link.path}")
                val manager = context.getSystemService(DownloadManager::class.java) ?: error("no download manager")
                manager.enqueue(DownloadManager.Request(Uri.parse(url)).setTitle(entry.name)
                    .setMimeType(mime(entry.name))
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, entry.name))
            }.onSuccess { say(DocumentsLogic.downloading(entry.name)) }.onFailure { failed("download ${entry.name}", it) }
        }
    }

    /** Send a copy… (Android's share sheet: the file itself, not a link), or Open with… (another app shows it). */
    fun handOff(entry: DocumentsEntry, action: String) {
        if (entry.sizeBytes > HAND_OFF_LIMIT) return say("${entry.name} is too large to hand to another app from here. Download it instead.")
        scope.launch {
            runCatching { handOffFile(context, entry.name, mime(entry.name), store.api.content(entry.id), action) }
                .onFailure { failed("read ${entry.name}", it) }
        }
    }

    companion object {
        const val HAND_OFF_LIMIT = 60L * 1024 * 1024
        fun mime(name: String): String =
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(DocumentsLogic.ext(name)) ?: when (DocumentsLogic.ext(name)) {
                "md", "markdown" -> "text/markdown"
                else -> "application/octet-stream"
            }
    }
}

/** A row's actions as a modal bottom sheet (board frame 4): the entry, then Rename · Move to… · Download · Send a copy… · Share link…
 * · Move to Trash; a folder has Rename, Move to… and Move to Trash. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RowActionsSheet(store: DocumentsStore, entry: DocumentsEntry, onDismiss: () -> Unit, rename: () -> Unit, move: () -> Unit,
                             download: () -> Unit, sendCopy: () -> Unit, share: () -> Unit, trash: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = sheetColor(), modifier = Modifier.testTag("documents-row-sheet")) {
        val line = writerLine(store, entry.lastWriter, if (entry.isFile) DocumentsLogic.formatSize(entry.sizeBytes) else null) {}
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            EntryIcon(DocumentsLogic.icon(entry))
            Column(Modifier.weight(1f)) {
                Text(entry.name, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(AnnotatedString(line.text), fontSize = DocumentsMetrics.line, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
            }
        }
        HorizontalDivider(Modifier.padding(top = 4.dp, bottom = 6.dp), color = MaterialTheme.colorScheme.outlineVariant)
        SheetItem(R.drawable.ic_edit, DocumentsLogic.RENAME, tag = "documents-action-rename") { onDismiss(); rename() }
        SheetItem(R.drawable.ic_move, DocumentsLogic.MOVE_TO, tag = "documents-action-move") { onDismiss(); move() }
        if (entry.isFile) {
            SheetItem(R.drawable.ic_download, DocumentsLogic.DOWNLOAD, tag = "documents-action-download") { onDismiss(); download() }
            SheetItem(R.drawable.ic_share, DocumentsLogic.SEND_A_COPY, tag = "documents-action-send") { onDismiss(); sendCopy() }
            SheetItem(R.drawable.ic_link, DocumentsLogic.SHARE_LINK, tag = "documents-action-share") { onDismiss(); share() }
        }
        SheetItem(R.drawable.ic_trash, DocumentsLogic.MOVE_TO_TRASH, danger = true, tag = "documents-action-trash") { onDismiss(); trash() }
        Spacer(Modifier.height(12.dp))
    }
}

/** Rename and New folder: a Material dialog with the name selected up to its extension. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun NameDialog(title: String, initial: String, confirm: String, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    val stem = initial.lastIndexOf('.').takeIf { it > 0 } ?: initial.length
    var value by remember { mutableStateOf(TextFieldValue(initial, TextRange(0, stem))) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val problem = DocumentsLogic.nameProblem(value.text).takeIf { value.text.isNotEmpty() }
    BasicAlertDialog(onDismissRequest = onDismiss) {
        Surface(shape = RoundedCornerShape(28.dp), color = dialogColor()) {
            Column(Modifier.padding(24.dp)) {
                Text(title, fontSize = 22.sp, modifier = Modifier.padding(bottom = 16.dp))
                OutlinedTextField(value, { value = TextFieldValue(it.text.replace("\n", ""), it.selection, it.composition) },
                    Modifier.fillMaxWidth().focusRequester(focus).testTag("documents-name-field"), label = { Text("Name") }, isError = problem != null)
                problem?.let { Text(it, Modifier.padding(top = 6.dp), color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
                Row(Modifier.fillMaxWidth().padding(top = 20.dp), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text(DocumentsLogic.CANCEL) }
                    TextButton(enabled = DocumentsLogic.nameProblem(value.text) == null, onClick = { onDone(value.text.trim()) },
                        modifier = Modifier.testTag("documents-name-confirm")) { Text(confirm) }
                }
            }
        }
    }
}

/**
 * Share link… (board frames 10 and 01-ios 9): the secret scan first; with nothing found the link is made straight away, else a
 * Material dialog names what it found, masked, with Share anyway in the warning colour (D18 warns, never blocks). Then the link with
 * Copy and Stop sharing.
 */
@Composable
internal fun ShareDialog(store: DocumentsStore, entry: DocumentsEntry, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var check by remember { mutableStateOf<DocumentsShareCheck?>(null) }
    var answer by remember { mutableStateOf<DocumentsShareAnswer?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var making by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    fun make() {
        making = true
        scope.launch {
            runCatching { store.api.share(entry.id) }.onSuccess { answer = it; store.loadLinks() }
                .onFailure { error = store.failure("make the link", it) }
            making = false
        }
    }
    LaunchedEffect(entry.id) {
        runCatching { store.api.shareCheck(entry.id) }.onSuccess { check = it; if (it.warnings.isEmpty()) make() }
            .onFailure { error = store.failure("check the file", it) }
    }
    val warned = check?.warnings?.isNotEmpty() == true && answer == null
    val (warnText, warnBack) = warningColors()
    AlertDialog(onDismissRequest = onDismiss, containerColor = dialogColor(), modifier = Modifier.testTag("documents-share-dialog"),
        icon = if (warned) ({ Icon(painterResource(R.drawable.ic_warning), null, tint = warnText) }) else null,
        title = { Text(DocumentsLogic.shareTitle(entry.name), textAlign = if (warned) TextAlign.Center else TextAlign.Start) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(DocumentsLogic.SHARE_DESCRIPTION, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.5.sp)
                val shown = check
                when {
                    error != null -> Text(error!!, Modifier.padding(top = 14.dp), color = MaterialTheme.colorScheme.error)
                    shown == null || (making && answer == null && !warned) -> Row(Modifier.padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Text(if (shown == null) DocumentsLogic.CHECKING else DocumentsLogic.MAKING, Modifier.padding(start = 10.dp), fontSize = 14.sp)
                    }
                    warned -> Column(Modifier.padding(top = 14.dp).fillMaxWidth().background(warnBack, RoundedCornerShape(12.dp))
                        .padding(horizontal = 14.dp, vertical = 12.dp).testTag("documents-share-secrets")) {
                        Text(DocumentsLogic.SECRETS_HEADING, color = warnText, fontWeight = FontWeight.Bold, fontSize = 13.5.sp)
                        shown.warnings.forEach { w ->
                            Row(Modifier.padding(top = 4.dp)) {
                                Text(DocumentsLogic.shapeLabel(w.kind), Modifier.weight(1f), color = warnText, fontSize = 13.sp)
                                Text(DocumentsLogic.warningLine(w), color = warnText, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
                            }
                        }
                        Text(DocumentsLogic.SECRETS_FOOT, Modifier.padding(top = 6.dp), color = warnText, fontSize = 13.5.sp)
                        if (shown.partial) Text(DocumentsLogic.partialNote(shown.checkedBytes), Modifier.padding(top = 4.dp), color = warnText, fontSize = 12.sp)
                    }
                    answer != null -> {
                        val url = DocumentsLogic.publicUrl(answer!!.link, store.handle.account.server)
                        Row(Modifier.padding(top = 14.dp).fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp))
                            .padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(painterResource(R.drawable.ic_link), null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                            Text(url, Modifier.weight(1f).padding(horizontal = 8.dp).testTag("documents-share-url"), fontFamily = FontFamily.Monospace,
                                fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            TextButton(onClick = { clipboard.setText(AnnotatedString(url)); copied = true }) {
                                Text(if (copied) DocumentsLogic.LINK_COPIED else DocumentsLogic.COPY_LINK)
                            }
                        }
                        if (answer!!.partial) Text(DocumentsLogic.partialNote(answer!!.checkedBytes), Modifier.padding(top = 6.dp), fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        },
        confirmButton = {
            when {
                warned -> TextButton(enabled = !making, onClick = ::make, modifier = Modifier.testTag("documents-share-anyway")) {
                    Text(DocumentsLogic.SHARE_ANYWAY, color = warnText)
                }
                answer != null -> TextButton(onClick = onDismiss) { Text(DocumentsLogic.DONE) }
                else -> {}
            }
        },
        dismissButton = {
            if (answer != null) TextButton(onClick = {
                val link = answer!!.link
                scope.launch { runCatching { store.api.stopSharing(link.id) }; store.loadLinks(); onDismiss() }
            }) { Text(DocumentsLogic.STOP_SHARING, color = MaterialTheme.colorScheme.error) }
            else TextButton(onClick = onDismiss) { Text(DocumentsLogic.CANCEL) }
        })
}

internal val ShareSend = Intent.ACTION_SEND
internal val ShareView = Intent.ACTION_VIEW
