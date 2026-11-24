package io.orbitd.android.documents

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.R
import io.orbitd.android.core.documents.DocumentsLogic
import io.orbitd.android.core.documents.DocumentsSync
import io.orbitd.android.core.documents.DocumentsUploadItem
import io.orbitd.android.core.documents.DocumentsUploadState

/**
 * The uploads sheet (board frame 7): the owner's uploads with their bars and Pause, and each agent's directory sync as one row with
 * Agent sync and no Pause — the same words and states as iPhone frames 16-17. A sync that ended with failures links Details (frame 15).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun UploadsSheet(store: DocumentsStore, openSession: (String) -> Unit, openFolder: (String?, String) -> Unit, onDismiss: () -> Unit) {
    val uploads by store.uploads.items.collectAsState()
    var details by remember { mutableStateOf<DocumentsSync?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = sheetColor(), modifier = Modifier.testTag("documents-uploads-sheet")) {
        Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(DocumentsLogic.UPLOADS, Modifier.weight(1f), fontSize = 16.sp, fontWeight = FontWeight.Medium)
            TextButton(onClick = { store.clearFinished() }, enabled = uploads.any { it.state == DocumentsUploadState.DONE } || store.syncs.any { !it.running }) {
                Text(DocumentsLogic.CLEAR_FINISHED)
            }
        }
        if (uploads.isEmpty() && store.syncs.isEmpty())
            Text("Nothing is uploading.", Modifier.padding(horizontal = 24.dp, vertical = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp)) {
            items(uploads, key = { "u:${it.id}" }) { UploadRow(store, it) }
            items(store.syncs.toList(), key = { "s:${it.id}" }) { SyncRow(store, it, openSession) { details = it } }
        }
        Spacer(Modifier.height(16.dp))
    }
    details?.let { sync -> SyncDetails(sync, openSession, openFolder = { onDismiss(); openFolder(sync.destEntryId, DocumentsLogic.folderLabel(sync.destPath)) }) { details = null } }
}

@Composable
private fun UploadRow(store: DocumentsStore, upload: DocumentsUploadItem) {
    Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 10.dp, bottom = 10.dp).testTag("documents-upload-row:${upload.name}")) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            EntryIcon(DocumentsLogic.icon(upload.name))
            Column(Modifier.weight(1f)) {
                Text(DocumentsLogic.uploadTitle(upload), fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(DocumentsLogic.uploadStatus(upload), fontSize = DocumentsMetrics.line, maxLines = 2,
                    color = if (upload.state == DocumentsUploadState.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            when {
                upload.pausable -> IconButton(onClick = { store.uploads.pause(upload.id) }) {
                    Icon(painterResource(R.drawable.ic_pause), DocumentsLogic.PAUSE, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                upload.resumable -> IconButton(onClick = { store.uploads.resume(upload.id); DocumentsUploads.start(store.app) }) {
                    Icon(painterResource(R.drawable.ic_play), DocumentsLogic.RESUME, tint = MaterialTheme.colorScheme.primary)
                }
                upload.state == DocumentsUploadState.DONE -> Icon(painterResource(R.drawable.ic_check), null, Modifier.padding(12.dp),
                    tint = MaterialTheme.colorScheme.primary)
            }
        }
        if (upload.state != DocumentsUploadState.DONE) ThinBar(upload.percent / 100f, Modifier.padding(start = 46.dp, end = 12.dp, top = 8.dp))
    }
}

@Composable
private fun SyncRow(store: DocumentsStore, sync: DocumentsSync, openSession: (String) -> Unit, details: () -> Unit) {
    val failures = DocumentsLogic.syncHasFailures(sync)
    val link = TextLinkStyles(SpanStyle(color = MaterialTheme.colorScheme.primary))
    Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 10.dp).testTag("documents-sync-row:${sync.sourceName}")) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            EntryIcon(DocumentsLogic.Icon.FOLDER)
            Column(Modifier.weight(1f)) {
                Text(DocumentsLogic.syncTitle(sync), fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val status = DocumentsLogic.syncStatus(sync, store.syncRates[sync.id])
                val error = MaterialTheme.colorScheme.error
                Text(buildAnnotatedString {
                    val failedAt = if (sync.status == "DONE" && sync.failedCount > 0) status.indexOf("${sync.failedCount} failed") else -1
                    if (failedAt >= 0) {
                        append(status.substring(0, failedAt))
                        withStyle(SpanStyle(color = error)) { append("${sync.failedCount} failed") }
                        append(status.substring(failedAt + "${sync.failedCount} failed".length))
                    } else if (sync.status == "FAILED") withStyle(SpanStyle(color = error)) { append(status) } else append(status)
                    if (failures) {
                        append(" · ")
                        withLink(LinkAnnotation.Clickable("details", link) { details() }) { append(DocumentsLogic.DETAILS) }
                    }
                }, fontSize = DocumentsMetrics.line, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (sync.running) AgentSyncChip()
            else if (failures) Icon(painterResource(R.drawable.ic_warning), null, tint = warningColors().first)
        }
        if (sync.running) {
            ThinBar(DocumentsLogic.syncFraction(sync)?.toFloat(), Modifier.padding(start = 46.dp, top = 8.dp))
            val current = sync.currentPath
            val session = sync.session
            if (current != null || session != null) Text(buildAnnotatedString {
                current?.let { append(it) }
                if (current != null && session != null) append(" · ")
                session?.let { s -> withLink(LinkAnnotation.Clickable("session", link) { openSession(s.id) }) { append(s.title) } }
            }, Modifier.padding(start = 46.dp, top = 6.dp), fontSize = DocumentsMetrics.line, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun AgentSyncChip() {
    Row(Modifier.background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(painterResource(R.drawable.ic_cloud), null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer)
        Text(DocumentsLogic.AGENT_SYNC, fontSize = 12.5.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSecondaryContainer)
    }
}

/** Details of a sync with failures (board frame 15): up to 100 failed paths with their reasons, then "and N more". No Retry: only the
 * agent runs a sync again (S1). Never the runner's local path. */
@Composable
internal fun SyncDetails(sync: DocumentsSync, openSession: (String) -> Unit, openFolder: () -> Unit, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize().testTag("documents-sync-details"), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().systemBarsPadding()) {
                Row(Modifier.fillMaxWidth().height(60.dp).padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onDismiss) { Icon(painterResource(R.drawable.ic_close), "Close") }
                    Text(DocumentsLogic.syncDetailsTitle(sync), Modifier.weight(1f).padding(start = 6.dp), fontSize = 21.sp, maxLines = 1,
                        overflow = TextOverflow.Ellipsis)
                }
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                    val summary = DocumentsLogic.syncDetailsSummary(sync)
                    val session = sync.session
                    val link = TextLinkStyles(SpanStyle(color = MaterialTheme.colorScheme.primary))
                    Text(buildAnnotatedString {
                        val at = session?.title?.let { summary.indexOf(it) } ?: -1
                        if (session == null || at < 0) append(summary) else {
                            append(summary.substring(0, at))
                            withLink(LinkAnnotation.Clickable("session", link) { openSession(session.id) }) { append(session.title) }
                            append(summary.substring(at + session.title.length))
                        }
                    }, Modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 8.dp), fontSize = 15.sp, lineHeight = 22.sp)
                    if (sync.failed.isNotEmpty() || sync.error != null) SectionHeading(DocumentsLogic.DIDNT_UPLOAD)
                    sync.error?.takeIf { sync.failed.isEmpty() }?.let {
                        Text(it, Modifier.padding(horizontal = 20.dp, vertical = 8.dp), color = MaterialTheme.colorScheme.error, fontSize = DocumentsMetrics.line)
                    }
                    sync.failed.take(100).forEach { failure ->
                        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp)) {
                            Text(failure.path, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
                            Text(failure.error, fontSize = DocumentsMetrics.line, color = MaterialTheme.colorScheme.error)
                        }
                    }
                    DocumentsLogic.syncMoreFailures(sync)?.let {
                        Text(it, Modifier.padding(horizontal = 20.dp, vertical = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onClick = { onDismiss(); openFolder() }, Modifier.weight(1f)) { Text(DocumentsLogic.openFolder(sync)) }
                    Button(onClick = onDismiss, Modifier.weight(1f)) { Text(DocumentsLogic.DONE) }
                }
            }
        }
    }
}
